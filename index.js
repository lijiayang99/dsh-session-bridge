import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { read, write } from './receipt-store.js'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { hostContext } from './natural-message.js'
import { ID, validId } from './bridge-input.js'
import { createActivity } from './activity.js'
import { applyWorkflow } from './workflow.js'
import { observeNativeResults } from './native-result.js'
import { existingWindow } from './workflow-routing.js'
import { registerStatusLog, receiptLog } from './workflow-view.js'

// Local DSH bundles are linked, so resolve the schema from the running DSH CLI.
const cli = realpathSync(process.argv[1])
const schema = createRequire(cli)('@deepseek-ai/schemastery')
const supportsOwnerPrompt = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8'))
    return pkg.name === '@deepseek-ai/dsh' && pkg.version === '0.2.2-rc.1'
  } catch {
    return false
  }
})()

export const name = 'dsh-session-bridge-settings'
export const Config = schema.object({
  // Host-authored form metadata, outside the writable settings values.
  enabled: schema.boolean().default(false).volatile()
    .extra('dshSessionBridgeHost', supportsOwnerPrompt ? 'supported' : 'unsupported'),
  workflowEnabled: schema.boolean().default(false).volatile(),
  allowedSessions: schema.array(schema.string().pattern(/^[a-zA-Z0-9_-]{1,128}$/))
    .max(32).default([]).volatile(),
})
export const inject = ['agents', 'sessions', 'sessionController', 'tools', 'workspaceRegistry']

const KEY = /^[a-f0-9]{64}$/
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const now = () => new Date().toISOString()

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
const stringId = { type: 'string', pattern: ID.source, maxLength: 128 }

export function apply(ctx, config) {
  const home = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
  const dir = join(home, 'dsh-session-bridge', 'receipts')
  if (lstatSync(join(home, 'session-bridge', 'receipts'), { throwIfNoEntry: false })) {
    throw new Error('dsh-session-bridge: migrate the legacy receipts directory with DSH stopped before enabling the bundle')
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Legacy configuration keys remain readable by the old package on rollback.
  const available = (id) => validId(id) && !ctx.workspaceRegistry.archivedSessionIds.includes(id)
  const enabled = () => config.enabled.get()
  let web = false
  let activity
  let workflow
  let persistence
  const inFlight = new Set()
  if (supportsOwnerPrompt) {
    ctx.inject(['profileContext', 'sessionPersistence'], (workflowCtx) => {
      if (workflowCtx.profileContext.name !== 'web') return
      web = true
      persistence = workflowCtx.sessionPersistence
      const projection = createActivity(available)
      activity = projection
      workflowCtx.inject(['connection'], (scope) => {
        if (!scope.connection) return
        projection.register(scope)
        registerStatusLog(scope, {
          enabled,
          windows: (signal) => ctx.sessionController.list({}, signal),
          read: (id) => [...(workflow?.statusEvents(id) ?? []), ...receiptLog(dir, id, inFlight)],
        })
      })
      workflow = applyWorkflow(workflowCtx, enabled, available, projection, matchConversation, reserveConversation, deliverOwner)
      workflowCtx.inject(['subagents'], (scope) => {
        observeNativeResults(scope, enabled, available, projection, reserveNativeResult)
      })
    })
  }
  const receiptPath = (key) => join(dir, key + '.json')
  const processingPath = (key) => join(dir, key + '.turn.json')
  function reserveNativeResult(message, from, to) {
    const key = sha(['native-result', from, to, message.source.bridgeWorkflowId])
    const path = receiptPath(key)
    const record = { from, to, messageId: message.id, delivery: 'reserved', at: now(),
      authorization: { kind: 'native-subagent-result', returning: true } }
    if (!write(dir, path, record, true)) return
    inFlight.add(key)
    return (delivery) => {
      inFlight.delete(key)
      record.delivery = delivery
      record.settledAt = now()
      write(dir, path, record, false)
    }
  }

  function messageActivity(record, state, attempt) {
    try {
      activity?.record({ key: record.messageId, from: record.from, to: record.to, kind: 'message', state,
        nativeParent: record.authorization?.nativeParent }, attempt)
    } catch {
      ctx.logger.warn('message activity could not be projected')
    }
  }

  // Only native turn events tied to our exact message ID can settle processing.
  const turns = new Map()
  ctx.on('session/event', (session, event) => {
    const active = turns.get(session.id)
    if (event.type === 'turn/start') {
      turns.set(session.id, { turn: event.data.turn, message: null, replied: false })
      return
    }
    if (!active) return
    if (event.type === 'user/message') {
      if (web && hostContext(event.data)) return
      const source = event.data.source
      const key = source?.bridgeReceiptKey
      if (source?.kind !== 'agent-message' || typeof key !== 'string' || !KEY.test(key)) return
      const record = read(receiptPath(key))
      if (record?.messageId === event.data.id && record.to === session.id &&
          record.from === source.senderSessionId && available(record.from)) {
        active.message = { key, id: event.data.id, record }
        messageActivity(record, 'executing')
      }
      return
    }
    if (event.type === 'assistant/message' && event.data.turn === active.turn) {
      if (active.message && !event.data.interrupted) active.replied = true
      return
    }
    if (event.type !== 'turn/end' || event.data.turn !== active.turn) return
    const reason = event.data.reason.kind
    turns.delete(session.id)
    if (!active.message) return
    const { key, id, record } = active.message
    const processing = reason === 'completed' && active.replied ? 'processed' : 'not_completed'
    void Promise.resolve().then(async () => {
      if (await ctx.sessions.flush(session)) {
        write(dir, processingPath(key), {
          messageId: id, processing, turn: active.turn, endReason: reason, at: now(),
        }, true)
        messageActivity(record, processing === 'processed' ? 'processed' : 'uncertain')
      } else messageActivity(record, 'uncertain')
    }).catch(() => {
      messageActivity(record, 'uncertain')
      ctx.logger.warn('dsh-session-bridge could not persist turn evidence')
    })
  })

  const liveSenderId = (exec) => {
    const caller = exec?.agent
    const id = caller?.session?.id
    return validId(id) && ctx.agents.get(id) === caller ? id : undefined
  }
  const result = (key, record, duplicate = false) => {
    const turn = read(processingPath(key))
    const observed = turn?.messageId === record.messageId ? turn : undefined
    const live = turns.get(record.to)?.message?.id === record.messageId
    return {
      requestId: record.requestId, messageId: record.messageId, from: record.from, to: record.to,
      delivery: observed ? 'delivered' : record.delivery === 'reserved' ? 'unknown' : record.delivery,
      processing: observed?.processing ?? (live ? 'running' : 'unconfirmed'),
      ...(observed ? { turn: observed.turn, endReason: observed.endReason } : {}),
      ...(record.authorization?.job ? { task: record.authorization.task, job: record.authorization.job } : {}),
      ...(record.nativeMessageId ? { nativeMessageId: record.nativeMessageId } : {}),
      duplicate,
    }
  }
  const existingResult = (key, record, from, payloadHash) =>
    record?.from === from && record.payloadHash === payloadHash
      ? result(key, record, true) : { error: 'request_id_conflict' }

  async function deliverOwner({ from, to, requestId, text, messageId, turn, kind, draftMessageId,
    verifyTarget, expiresAt }, signal, current) {
    if (!current() || !available(to) || from === to) return { error: 'route_not_allowed' }
    signal.throwIfAborted()
    const key = sha([from, requestId])
    const path = receiptPath(key)
    const payloadHash = sha([to, text])
    const existing = read(path)
    if (existing) return existingResult(key, existing, from, payloadHash)
    const record = {
      from, to, requestId, payloadHash, messageId: randomUUID(), delivery: 'reserved', at: now(),
      authorization: {
        kind, userMessageId: messageId, turn, ...(draftMessageId ? { draftMessageId } : {}),
      },
    }
    if (!write(dir, path, record, true)) {
      return existingResult(key, read(path), from, payloadHash)
    }

    inFlight.add(key)
    messageActivity(record, 'queued')
    let attempted = false
    try {
      if (!await existingWindow(persistence, available, to, signal)) throw new Error('destination unavailable')
      const { agent: target } = await ctx.sessionController.resolveAgent(to)
      if (verifyTarget && !await verifyTarget(signal)) throw new Error('target binding changed')
      signal.throwIfAborted()
      if (!target || target.session.id !== to || ctx.agents.get(to) !== target || !current() ||
          !available(to) || (expiresAt !== undefined && expiresAt <= performance.now())) {
        throw new Error('destination unavailable')
      }
      attempted = true
      messageActivity(record, 'sending', true)
      target.followup({
        id: record.messageId, role: 'user',
        content: [{
          type: 'text',
          text: `[DSH 会话消息｜发送方 ${from}]\n${text}`,
        }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: from, bridgeReceiptKey: key },
      })
      record.delivery = await ctx.sessions.flush(target.session) ? 'delivered' : 'unknown'
    } catch {
      record.delivery = attempted ? 'unknown' : 'not_delivered'
    }
    inFlight.delete(key)
    record.settledAt = now()
    write(dir, path, record, false)
    const receipt = result(key, record)
    messageActivity(record, receipt.processing === 'processed' ? 'processed'
      : receipt.processing === 'running' ? 'executing'
        : receipt.processing === 'not_completed' || receipt.delivery === 'unknown' ? 'uncertain'
          : receipt.delivery === 'delivered' ? 'delivered' : 'failed')
    return receipt
  }

  const conversationHeading = (route) => `任务消息 · ${route.task} · ${route.from} → ${route.to}\n\n`

  function matchConversation(route, message) {
    const key = message.source?.bridgeReceiptKey
    if (!KEY.test(key ?? '') || message.role !== 'user' || message.source.kind !== 'agent-message' ||
        message.source.form !== 'relay' || message.source.bridgeWorkflowKind !== 'conversation' ||
        message.source.bridgeWorkflowTask !== route.task || message.source.bridgeWorkflowId !== route.id ||
        message.source.senderSessionId !== route.from ||
        message.content?.length !== 1 || message.content[0]?.type !== 'text') return false
    const record = read(receiptPath(key))
    const text = message.content[0].text
    const heading = conversationHeading(route)
    return record?.messageId === message.id && record.from === route.from && record.to === route.to &&
      record.authorization?.kind === 'native-workflow-conversation' &&
      record.authorization.job === route.id && record.authorization.task === route.task &&
      ['reserved', 'delivered', 'unknown'].includes(record.delivery) && text?.startsWith(heading) &&
      record.payloadHash === sha([route.to, text.slice(heading.length)])
  }

  function reserveConversation(route, requestId, text) {
    const { id, task, from, to } = route
    const key = sha([from, id, requestId])
    const path = receiptPath(key)
    const payloadHash = sha([to, text])
    const record = {
      from, to, requestId, payloadHash, messageId: randomUUID(), delivery: 'reserved', at: now(),
      authorization: { kind: 'native-workflow-conversation', job: id, task, ...(route.returning ? { returning: true } : {}) },
    }
    if (!write(dir, path, record, true)) {
      return { receipt: existingResult(key, read(path), from, payloadHash) }
    }
    inFlight.add(key)
    messageActivity(record, 'queued')
    let attempted = false
    function settle(delivery, reason) {
      if (record.delivery !== 'reserved') return
      record.delivery = delivery
      if (reason) record.reason = reason
      inFlight.delete(key)
      record.settledAt = now()
      write(dir, path, record, false)
      const receipt = result(key, record)
      messageActivity(record, receipt.processing === 'processed' ? 'processed'
        : receipt.processing === 'running' ? 'executing'
        : receipt.processing === 'not_completed' || delivery === 'unknown' ? 'uncertain'
          : delivery === 'delivered' ? 'delivered' : 'failed')
    }
    return {
      receipt: { ...result(key, record), task, job: id, delivery: 'queued' },
      async send(deadline, live, verifyTarget) {
        try {
          if (!live()) return
          const { agent } = await ctx.sessionController.resolveAgent(to)
          if (!agent || (verifyTarget && !await verifyTarget(deadline))) return
          deadline.throwIfAborted()
          if (ctx.agents.get(to) !== agent || !live()) return
          attempted = true
          messageActivity(record, 'sending', true)
          agent.followup({
            id: record.messageId, role: 'user',
            content: [{ type: 'text', text: conversationHeading(route) + text }],
            source: {
              kind: 'agent-message', form: 'relay', senderSessionId: from, bridgeReceiptKey: key,
              bridgeWorkflowKind: 'conversation', bridgeWorkflowId: id, bridgeWorkflowTask: task,
            },
          })
          settle(await ctx.sessions.flush(agent.session) ? 'delivered' : 'unknown')
        } finally {
          settle(attempted ? 'unknown' : 'not_delivered')
        }
      },
      stop: (reason) => settle(attempted ? 'unknown' : 'not_delivered', attempted ? undefined : reason),
    }
  }

  const nativeReceiptKey = (from, requestId) => sha([from, 'native-subagent', requestId])

  ctx.tools.register({
    name: 'session_message_status',
    description: 'Read this session’s delivery receipt. Include job for an independent workflow message. Earlier native child receipts may include the host’s nativeMessageId.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['request_id'],
      properties: { request_id: stringId, job: stringId },
    },
    output,
    async execute({ request_id: requestId, job }, exec) {
      const from = liveSenderId(exec)
      if (!from) return { error: 'route_not_allowed' }
      if (!validId(requestId)) return { error: 'invalid_request_id' }
      if (job !== undefined && !validId(job)) return { error: 'invalid_job_id' }
      const key = sha(job === undefined ? [from, requestId] : [from, job, requestId])
      const record = read(receiptPath(key))
      if (record?.from === from && validId(record.to)) return result(key, record)
      if (job === undefined) {
        const nativeKey = nativeReceiptKey(from, requestId)
        const native = read(receiptPath(nativeKey))
        if (native?.from === from && native.authorization?.kind === 'native-subagent' &&
            validId(native.authorization.nativeParent)) return result(nativeKey, native)
      }
      return { error: available(from) ? 'receipt_not_found' : 'route_not_allowed' }
    },
  })
}
