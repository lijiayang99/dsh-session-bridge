import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { validId } from './bridge-input.js'
import { read } from './receipt-store.js'
import { stateOf } from './workflow-state.js'

const route = '/api/dsh-session-bridge/status-log'
const limit = 160
const deliveryStates = {
  queued: 'queued', sending: 'queued', admitted: 'admitted', claimed: 'executing',
  reported: 'executing', consumed: 'returned', skipped: 'cancelled',
  failed: 'failed', uncertain: 'uncertain', reconciled: 'uncertain',
}
const reasons = new Set([
  'cancelled', 'expired', 'owner_turn_not_verified', 'mixed_turn',
  'destination_resolution_failed_before_send', 'destination_unavailable_before_send',
  'route_unavailable_before_send', 'waiting_for_destination_resolution',
  'host_admission_not_proven_pending', 'host_evidence_unavailable',
  'host_consumed_without_handshake', 'execution_interrupted_after_claim',
  'destination_resolution_failed_after_admission', 'native_pending_wake_failed',
  'host_delivery_unconfirmed', 'recovered_inbox_conflict',
  'target_binding_changed', 'bridge_disabled', 'aborted', 'error', 'blocked', 'interrupted', 'max-tokens',
])
const asTime = (value) => typeof value === 'string' ? Date.parse(value) : value
const reply = (value, status = 200) => Response.json(value, {
  status, headers: { 'cache-control': 'no-store' },
})

function event(rows, at, kind, state, from, to, reason, targetTitle) {
  at = asTime(at)
  if (!Number.isFinite(at) || at < 0 || at > 8.64e15 || !state || !validId(from) || !validId(to)) return
  rows.push({ at, kind, state, from, to, targetTitle,
    ...(typeof reason === 'string' && reason ? { reason: reasons.has(reason) ? reason : 'unverified' } : {}),
  })
}

function titleOf(value, id) {
  if (typeof value !== 'string' || value === id || id.length >= 16 && value.includes(id)) return ''
  return value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').trim().slice(0, 160)
}

export function registerStatusLog(ctx, { enabled, windows, read }) {
  // Connection Fetch admits the owner's peer before calling this route.
  return ctx.connection.fetch.register({
    path: route,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') {
        return reply({ error: 'invalid_request' }, 415)
      }
      const input = await request.json().catch(() => undefined)
      if (!input || Object.keys(input).join(',') !== 'sessionId' || !validId(input.sessionId)) {
        return reply({ error: 'invalid_request' }, 400)
      }
      try {
        const { sessionId } = input
        const { items } = await windows(request.signal)
        const titles = new Map(items.map((row) => [row.sessionId, titleOf(row.projections?.values?.title, row.sessionId)]))
        const rows = read(sessionId).sort((a, b) => a.at - b.at)
        const events = rows.slice(-limit).map(({ at, kind, state, from, to, reason, targetTitle }) => ({
          at, kind, state, from: titles.get(from) || titleOf(targetTitle?.[from], from),
          to: titles.get(to) || titleOf(targetTitle?.[to], to), ...(reason ? { reason } : {}),
        }))
        return reply({ enabled: enabled(), events })
      } catch {
        return reply({ error: 'status_log_unavailable' }, 503)
      }
    },
  })
}

export function taskLog(ledger, id) {
  const { grants, jobs } = ledger.read()
  const rows = []
  for (const job of [...Object.values(jobs), ...ledger.history.participatingJobs(id)]) {
    const { owner, target, wake, resume } = job
    if (!wake || (owner !== id && target !== id)) continue
    const grant = grants[job.key] ?? ledger.history.grant(job.key)
    const title = grant?.authorization?.targets?.find((entry) => entry.id === target)?.title
    const targetTitle = { [target]: title }
    const add = (at, kind, state, reason) => {
      const [from, to] = kind === 'task' ? [owner, target] : [target, owner]
      event(rows, at, kind, state, from, to, reason, targetTitle)
    }
    add(job.createdAt, 'task', 'queued')
    for (const [kind, delivery] of [['task', wake], ['result', resume]]) {
      if (!delivery) continue
      for (const [state, at] of Object.entries(delivery.milestones ?? {})) {
        if (state === 'queued' && kind === 'task' || state === delivery.state) continue
        if (Object.hasOwn(deliveryStates, state)) add(at, kind, deliveryStates[state])
      }
      if (kind === 'task' && job.claim?.at && !delivery.milestones?.claimed && delivery.state !== 'claimed') {
        add(job.claim.at, kind, 'executing')
      }
      const state = delivery.state === 'reported' && job.report?.status === 'failed'
        ? 'failed' : Object.hasOwn(deliveryStates, delivery.state) ? deliveryStates[delivery.state] : undefined
      if (state !== 'queued' || kind !== 'task' || delivery.reason) add(delivery.updatedAt, kind, state, delivery.reason)
    }
    const grantState = stateOf(grant)
    if (grantState === 'cancelled' && wake.reason !== 'cancelled') {
      add(grant.closedAt, 'task', 'cancelled', 'cancelled')
    }
    if (grantState === 'expired' && !['reported', 'failed', 'skipped'].includes(wake.state)) {
      add(grant.expiresAt, 'task', 'cancelled', 'expired')
    }
  }
  return rows
}

export function receiptLog(dir, id, inFlight) {
  const rows = []
  for (const file of readdirSync(dir, { withFileTypes: true })) {
    if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue
    const path = join(dir, file.name)
    try {
      const record = read(path)
      if (!record || record.from !== id && record.to !== id) continue
      const { from, to, at, settledAt, messageId, delivery } = record
      const kind = record.authorization?.returning === true ? 'result' : 'message'
      event(rows, at, kind, 'queued', from, to)
      if (delivery === 'reserved' && inFlight.has(file.name.slice(0, -5))) continue
      const state = delivery === 'delivered' ? (kind === 'result' ? 'returned' : 'admitted')
        : delivery === 'not_delivered' ? (record.reason === 'cancelled' ? 'cancelled' : 'failed') : 'uncertain'
      event(rows, settledAt ?? at, kind, state, from, to,
        state === 'uncertain' ? 'host_delivery_unconfirmed' : record.reason)
      const processing = read(path.replace(/\.json$/, '.turn.json'))
      if (processing?.messageId === messageId) {
        const processed = processing.processing === 'processed'
        event(rows, processing.at, kind, processed ? (kind === 'result' ? 'returned' : 'executing') : 'failed',
          from, to, processed ? undefined : processing.endReason)
      }
    } catch {
      // The status view stays available when an individual legacy receipt is unreadable.
    }
  }
  return rows
}
