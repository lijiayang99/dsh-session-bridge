import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { hostContext, matchingTitles, plainText } from './natural-message.js'
import { createWorkflowAuthorization, matchesContextNotice, workflowProposalProperties } from './workflow-authorization.js'
import { openLedger } from './workflow-ledger.js'
import { registerWorkflowView } from './workflow-view.js'

const ID = /^[a-zA-Z0-9_-]{1,128}$/
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const ARTIFACT = /^(?:git:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/
const validId = (value) => typeof value === 'string' && ID.test(value)
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const maxGrants = 128
const maxJobs = 512
const maxPerGrant = 32
const statuses = ['completed', 'approved', 'changes_requested', 'failed', 'needs_owner']
const reportLabels = { completed: '已完成', failed: '失败', needs_owner: '待主控处理',
  approved: '审核通过', changes_requested: '要求返修' }
const control = /^授权委托\r?\n([\s\S]+)$/
const review = /^对账委托 ([a-zA-Z0-9_-]{1,128}) ([a-f0-9-]{36}) (task|result)\r?\n([\s\S]+)$/
const action = /^(取消委托|继续委托) ([a-zA-Z0-9_-]{1,128})$/
const taskKey = (owner, task) => owner + ':' + task
const success = (value) => ({ changed: true, value })
const noChange = (value) => ({ changed: false, value })
const denied = (error) => ({ error })
const directNotices = {
  workflow_target_clarification_required: '委托未发送。请在原窗口重试，使用引号写出一个完整且唯一的窗口名。',
  workflow_target_not_available: '委托未发送。请在右栏的会话白名单确认目标可用，再在原窗口重试。',
  workflow_target_changed: '委托未发送。目标窗口在核对时发生变化，请确认窗口名后重试。',
  workflow_targets_unavailable: '委托未发送。暂时无法核对目标窗口，请稍后重试。',
  grant_not_opened: '无法建立新的委托任务。请检查右栏的原主控任务后重试。',
}
const contextualNotices = {
  workflow_context_target_required: '这句话还没指明窗口。你想问哪个窗口？请回窗口名。',
  workflow_context_goal_required: '窗口已找到。你想问什么？',
  workflow_context_both_required: '你想问哪个窗口、问什么？',
  workflow_context_alias_conflict: '当前会话组里有多个窗口使用这个短号。你指哪个？请回完整标题。',
  workflow_context_alias_unknown: '当前会话组里没找到这个短号。你指哪个窗口？请回完整标题。',
  workflow_context_target_ambiguous: '还不能唯一确定窗口。请回一个完整且唯一的窗口名。',
  workflow_context_expired: '刚才的上下文已过期。请再说一次窗口和要问的问题。',
  workflow_target_changed: '窗口或工作区发生了变化。现在想问哪个窗口？请回完整标题。',
  workflow_target_not_available: '这个窗口当前不可用。请核对白名单，或告诉我另一个窗口的完整标题。',
}
const digest = (text) => createHash('sha256').update(text).digest('hex')
const idSchema = { type: 'string', pattern: ID.source, maxLength: 128 }
const uuidSchema = { type: 'string', pattern: UUID.source }
const textSchema = (maxLength) => ({ type: 'string', minLength: 1, maxLength })
const attemptSchema = { type: 'integer', minimum: 1, maximum: 8 }
const artifactSchema = { type: 'string', pattern: ARTIFACT.source }
const artifactList = { type: 'array', maxItems: 8, uniqueItems: true, items: artifactSchema }
const validArtifact = (value) => typeof value === 'string' && ARTIFACT.test(value)
const validArtifacts = (value) => Array.isArray(value) && value.length <= 8 &&
  value.every(validArtifact) && new Set(value).size === value.length
const assignmentProperties = {
  item: idSchema, attempt: attemptSchema, target: idSchema, scope: idSchema,
  instructions: textSchema(4000), acceptance: textSchema(1500),
  reviewOf: uuidSchema, artifact: artifactSchema,
}
const assignmentRequired = ['item', 'attempt', 'target', 'scope', 'instructions', 'acceptance']
const batchSettled = new Set(['reported', 'failed', 'uncertain', 'skipped', 'reconciled'])
const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

function parseGrant(text) {
  const match = control.exec(text)
  if (!match || match[1].length > 6000) return
  let input
  try { input = JSON.parse(match[1]) } catch { return }
  if (!input || Object.keys(input).sort().join(',') !== 'goal,scopes,task,ttlMinutes' ||
      !validId(input.task) || !validText(input.goal, 2000) ||
      !Number.isInteger(input.ttlMinutes) || input.ttlMinutes < 1 || input.ttlMinutes > 1440 ||
      !Array.isArray(input.scopes) || input.scopes.length < 1 || input.scopes.length > 16) return
  const seen = new Set()
  for (const scope of input.scopes) {
    if (!scope || Object.keys(scope).sort().join(',') !== 'name,targets' || !validId(scope.name) ||
        seen.has(scope.name) || !Array.isArray(scope.targets) || scope.targets.length < 1 ||
        scope.targets.length > 16 || !scope.targets.every(validId) ||
        new Set(scope.targets).size !== scope.targets.length) return
    seen.add(scope.name)
  }
  return input
}

function nativeOwner(message) {
  return message.role === 'user' && message.source?.kind === 'user' &&
    message.source.principal === undefined && validId(message.source.rpcId) && validId(message.id)
}

function withdrawalTask(message) {
  if (!nativeOwner(message)) return
  const match = action.exec(plainText(message) ?? '')
  if (match?.[1] === '取消委托') return match[2]
}

function deliveryOf(job, kind) {
  return kind === 'task' ? job.wake : job.resume
}

function receiverOf(job, kind) {
  return kind === 'task' ? job.target : job.owner
}

function senderOf(job, kind) {
  return kind === 'task' ? job.owner : job.target
}

function wakeText(job, kind) {
  const header = 'DSH-WORKFLOW ' + kind.toUpperCase() + ' ' + job.id
  if (kind !== 'result' || !job.nativeResult || !job.report || job.report.late) return header
  const { status, summary, evidence } = job.report
  const route = job.conversation ? ' · ' + job.key.slice(job.owner.length + 1) + ' · ' +
    job.target + ' → ' + job.owner : ''
  return '委托回报 · ' + reportLabels[status] + route + '\n\n' + summary +
    (evidence.length ? '\n\n证据\n' + evidence.join('\n') : '')
}

function isWake(job, kind, message) {
  const source = message.source
  return message.id === deliveryOf(job, kind)?.id && message.role === 'user' &&
    source?.kind === 'agent-message' && source.form === 'relay' &&
    source.senderSessionId === senderOf(job, kind) &&
    source.bridgeWorkflowKind === kind && source.bridgeWorkflowId === job.id &&
    (kind !== 'result' || !job.nativeResult ||
      source.bridgeWorkflowOwner === job.owner && plainText(message) === wakeText(job, kind))
}

function stateOf(grant, now = Date.now()) {
  if (!grant) return 'missing_grant'
  const state = grant.state === 'collaboration_active' ? 'active'
    : grant.state === 'collaboration_paused' ? 'paused'
      : grant.state === 'collaboration_closing' ? 'closing' : grant.state
  if (state === 'collaboration_authorizing') return now >= grant.expiresAt ? 'expired' : 'authorizing'
  if (state !== 'active' && state !== 'paused' && state !== 'closing') return state
  return now >= grant.expiresAt ? 'expired' : state
}

// Older versions will read these grants but cannot open their dispatch gate.
function setGrantState(grant, state) {
  grant.state = grant.collaboration ? 'collaboration_' + state : state
}

const batchOf = (grant, id) => grant?.batches?.find(({ batch }) => batch === id)
const isDirectGrant = (grant) => grant?.authorization?.kind === 'native-owner-workflow-direct' ||
  grant?.conversation && grant.authorization?.kind === 'native-owner-workflow-confirmation' && grant.budget === 1

function sent(delivery) {
  return delivery?.state === 'sending' || delivery?.state === 'admitted'
}

function unresolved(delivery) {
  return sent(delivery) || delivery?.state === 'uncertain'
}

function terminal(state) {
  return state === 'cancelled' || state === 'expired' || state === 'closed'
}

function setDelivery(delivery, state, reason) {
  delivery.state = state
  if (reason === undefined) delete delivery.reason
  else delivery.reason = reason
  delivery.updatedAt = Date.now()
}

function continuationIssue(resume) {
  const continuation = resume?.continuation
  if (continuation === undefined) {
    // Version 1 consumed results predate the handoff and host-turn fields.
    if (resume?.state === 'consumed' && (resume.handoffAt !== undefined || resume.hostTurn !== undefined)) {
      return 'missing_continuation_record'
    }
    return
  }
  const invalid = 'invalid_continuation_record'
  if (resume.state !== 'consumed' || !Number.isSafeInteger(resume.consumedTurn) ||
      resume.consumedTurn < 0 || continuation?.turn !== resume.consumedTurn) return invalid
  if (continuation.state === 'legacy_unverified') return
  if (!['started', 'verified', 'interrupted'].includes(continuation.state) || !Number.isFinite(continuation.at) ||
      !Array.isArray(continuation.dispatches) ||
      !continuation.dispatches.every((id) => typeof id === 'string' && UUID.test(id))) return invalid
  if (continuation.state !== 'started' && !Number.isFinite(continuation.settledAt)) return invalid
  if (continuation.state === 'interrupted' &&
      (!['before_dispatch', 'after_dispatch'].includes(continuation.phase) ||
        typeof continuation.reason !== 'string')) return invalid
}

function pendingDirectCompletion(grant, job) {
  const { resume } = job
  const continuation = resume?.continuation
  return isDirectGrant(grant) && grant.state === 'collaboration_active' && !grant.closure &&
    grant.budget === 1 && grant.dispatched === 1 && grant.owner === job.owner &&
    job.key === taskKey(grant.owner, grant.task) && !job.batch && !job.quarantine &&
    job.wake?.state === 'reported' && job.report?.status === 'completed' && !job.report.late &&
    continuation?.state === 'started' && !continuationIssue(resume) && !continuation.dispatches.length &&
    Number.isSafeInteger(resume.startSeq) && Number.isSafeInteger(continuation.replyAfterSeq) &&
    continuation.replyAfterSeq >= resume.startSeq
}

function jobView(job, grant) {
  const { id, item, attempt, scope, target, after, instructions, acceptance, wake, claim, report, resume } = job
  const title = grant?.authorization?.targets?.find(({ id }) => id === target)?.title
  const stopped = terminal(stateOf(grant))
  const execution = stopped && (wake.state === 'claimed' || wake.state === 'uncertain' || sent(wake) ||
    wake.stoppedFrom === 'sending' || wake.stoppedFrom === 'admitted')
    ? 'host_execution_unconfirmed' : undefined
  return {
    id, item, attempt, scope, target, after, instructions, acceptance,
    ...(title ? { targetTitle: title } : {}),
    ...(job.batch ? { batch: job.batch } : {}),
    ...(job.reviewOf ? { reviewOf: job.reviewOf, artifact: job.artifact } : {}),
    ...(execution ? { execution } : {}),
    delivery: wake,
    ...(job.quarantine ? { quarantine: job.quarantine } : {}),
    ...(claim ? { claim: { turn: claim.turn, messageId: claim.messageId, at: claim.at } } : {}),
    ...(report ? { report } : {}),
    ...(resume ? { continuation: resume } : {}),
  }
}

async function hostEvents(ctx, sessionId, startSeq, signal) {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read', { signal })
  try {
    const limit = 20_000
    const { events } = await handle.read(startSeq, limit, { signal })
    if (events.length === limit) throw new Error('Recovery evidence exceeds the scan bound')
    return events
  } finally {
    await handle.close()
  }
}

// Exact durable host evidence. A matching ID in arbitrary text is irrelevant.
async function hostEvidence(ctx, job, kind, signal) {
  const events = await hostEvents(ctx, receiverOf(job, kind), deliveryOf(job, kind).startSeq, signal)
  const queues = { 'next-turn': [], 'next-step': [] }
  let admissions = 0
  let consumptions = 0
  let turn
  let matchedTurn
  let inMatchedTurn = false
  let inputs = 0
  let mixedTurn = false
  let endReason
  const replyAfterSeq = kind === 'result' ? job.resume.continuation?.replyAfterSeq : undefined
  let replySeen = false
  let replyEndTime
  let endTime
  for (const { type, data, seq, time } of events) {
    if (type === 'turn/start') {
      turn = data.turn
      inMatchedTurn = false
      inputs = 0
    }
    if (type === 'agent/inbox/spliced') {
      queues[data.target].splice(data.start, data.removedCount ?? 0, ...data.inserted)
      admissions += data.inserted.filter((message) => isWake(job, kind, message)).length
    }
    if (type === 'user/message' && !hostContext(data)) {
      inputs++
      if (isWake(job, kind, data)) {
        consumptions++
        if (consumptions === 1) {
          matchedTurn = turn
          inMatchedTurn = turn !== undefined
        }
      }
    }
    if (inMatchedTurn && type === 'assistant/message' && data.turn === matchedTurn &&
        Number.isSafeInteger(replyAfterSeq) && seq > replyAfterSeq && !data.interrupted &&
        data.message?.role === 'assistant' && data.message.content?.some(({ type, text }) =>
          type === 'text' && typeof text === 'string' && text.trim())) {
      replySeen = true
    }
    if (type === 'turn/end') {
      if (inMatchedTurn && data.turn === matchedTurn) {
        endReason = data.reason.kind
        mixedTurn = inputs !== 1
        if (Number.isFinite(time)) endTime = time
        if (replySeen && Number.isFinite(time)) replyEndTime = time
      }
      inMatchedTurn = false
      turn = undefined
    }
  }
  return {
    pending: Object.values(queues).flat().some((message) => isWake(job, kind, message)),
    admissions,
    consumptions,
    ...(matchedTurn !== undefined ? { turn: matchedTurn } : {}),
    ...(endReason !== undefined ? { endReason } : {}),
    ...(replyEndTime !== undefined ? { replyEndTime } : {}),
    ...(endTime !== undefined ? { endTime } : {}),
    ...(mixedTurn ? { mixedTurn } : {}),
  }
}

function closeTurnEvidence(events, closure, anchor, matchesInput) {
  const [start] = events
  if (!closure.input || start?.type !== 'turn/start' || start.seq !== closure.startSeq || start.data.turn !== closure.turn) return
  let inputSeen = false
  for (let index = 1; index < events.length; index++) {
    const event = events[index]
    if (event.type === 'turn/start') return
    if (event.type === 'user/message' && !hostContext(event.data)) {
      const { data, seq } = event
      const matchesSource = matchesInput ? matchesInput(data) : anchor ? isWake(anchor, 'result', data)
        : closure.notice ? matchesContextNotice(data, closure.notice)
          : nativeOwner(data) && data.source.rpcId === closure.input.rpcId
      if (inputSeen || seq !== closure.input.sequence || data.id !== closure.input.messageId || !matchesSource ||
          (closure.sourceDigest && digest(plainText(data) ?? '') !== closure.sourceDigest)) return
      inputSeen = true
    }
    if (event.type === 'turn/end') {
      if (inputSeen && event.data.turn === closure.turn && Number.isFinite(event.time) &&
          event.time >= closure.requestedAt) {
        return { sequence: event.seq, time: event.time, reason: event.data.reason?.kind }
      }
      return
    }
  }
}

const activityStates = {
  queued: 'queued', sending: 'sending', admitted: 'delivered', claimed: 'executing',
  reported: 'reported', consumed: 'delivered', failed: 'failed', uncertain: 'uncertain',
  skipped: 'stopped', reconciled: 'reconciled',
}

export function applyWorkflow(ctx, config, allowed, activity, matchConversation) {
  if (lstatSync(join(ctx.profileContext.dir, 'session-bridge-workflow'), { throwIfNoEntry: false })) {
    throw new Error('dsh-session-bridge: migrate the legacy workflow directory with DSH stopped before enabling delegation')
  }
  const ledger = openLedger(join(ctx.profileContext.dir, 'dsh-session-bridge-workflow'),
    activity ? ({ jobs, grants }, archived) => {
      for (const job of [...Object.values(jobs), ...archived]) {
        if (!job?.wake) continue
        const expiresAt = grants[job.key]?.expiresAt
        publishDelivery(job, 'task', expiresAt)
        if (job.resume) publishDelivery(job, 'result', expiresAt)
      }
    } : undefined)

  function publishDelivery(job, kind, keepUntil, attempt = false) {
    if (!activity) return
    try {
      const delivery = deliveryOf(job, kind)
      const continuation = delivery.continuation
      const reviewedAt = continuation?.state === 'interrupted' &&
        continuation.reconciliation?.decision === 'reviewed_without_replay' &&
        Number.isFinite(continuation.reconciliation.at) ? continuation.reconciliation.at : undefined
      let state = activityStates[delivery.state]
      if (attempt) state = 'sending'
      else if (reviewedAt !== undefined) state = 'reconciled'
      else if ((delivery.state === 'sending' && delivery.reason) || continuation?.state === 'interrupted') state = 'uncertain'
      else if (delivery.state === 'reported' && job.report?.status === 'failed') state = 'failed'
      else if (continuation?.state === 'verified') state = 'received'
      if (state) activity.record({
        key: delivery.id, from: senderOf(job, kind), to: receiverOf(job, kind), kind, state, keepUntil,
        at: attempt ? Date.now() : reviewedAt ?? continuation?.settledAt ?? delivery.updatedAt,
      }, attempt)
    } catch {
      ctx.logger.warn('workflow activity could not be projected')
    }
  }
  const lifetime = new AbortController()
  const signal = lifetime.signal
  const turns = new Map()
  const completedOwners = new Map()
  const waking = new Set()
  const claimedHere = new Set()
  let driver
  let readyToDrive = false

  const enabled = () => !signal.aborted && config.workflowEnabled.get()
  const available = (id) => allowed(id)
  const activeGrant = (grant) => stateOf(grant) === 'active'
  const grantFor = (grants, key) => grants[key] ?? ledger.history.grant(key)
  const jobFor = (jobs, id) => jobs[id] ?? ledger.history.job(id)
  const batchResult = (grant, job, kind) => kind === 'result' && job.batch &&
    batchOf(grant, job.batch)?.anchor === job.id
  const canRoute = (grant, job, kind) => enabled() && available(job.owner) &&
    (available(job.target) || batchResult(grant, job, kind)) &&
    (activeGrant(grant) || (kind === 'result' && stateOf(grant) === 'paused' &&
      (batchResult(grant, job, kind) || job.report?.status === 'needs_owner')))

  async function existing(id, requestSignal) {
    if (!available(id)) return false
    const stored = await ctx.sessionPersistence.stat(id, { signal: requestSignal })
    return Boolean(stored?.sizeBytes && stored.header.cwd &&
      stored.header.origin !== 'subagent' && !stored.header.parentSession)
  }
  const authorization = createWorkflowAuthorization(ctx, { enabled, available, existing, signal })

  function controlInput(session, turn, message) {
    if (!nativeOwner(message)) return { mode: 'other' }
    const text = plainText(message)
    const reconciliation = text && review.exec(text)
    if (reconciliation && !turn.mixed && UUID.test(reconciliation[2]) && validText(reconciliation[4], 1000)) {
      const [, task, id, kind, reason] = reconciliation
      const pending = ownerReconcile(session.id, turn, message, task, id, kind, reason)
      return { mode: 'owner', pending }
    }
    const operation = text && action.exec(text)
    if (operation) {
      const [, command, task] = operation
      const key = taskKey(session.id, task)
      if (command === '取消委托') {
        ledger.change(({ grants }) => {
          const grant = grants[key]
          if (!grant || !['active', 'paused', 'closing', 'authorizing'].includes(stateOf(grant))) return noChange()
          if (grant.closure?.state === 'pending') {
            Object.assign(grant.closure, { state: 'cancelled', settledAt: Date.now() })
          }
          grant.state = 'cancelled'
          grant.closedAt = Date.now()
          grant.closedBy = message.id
          return success()
        })
        schedule()
        return { mode: 'owner' }
      }
      if (!enabled() || turn.mixed) return { mode: 'owner' }
      const resumed = ledger.change(({ grants }) => {
        const grant = grants[key]
        if (!grant || !['active', 'paused'].includes(stateOf(grant))) return noChange(false)
        if (stateOf(grant) === 'paused') setGrantState(grant, 'active')
        grant.lastOwnerResume = message.id
        grant.lastOwnerResumeAt = Date.now()
        grant.lastOwnerResumeTurn = turn.number
        return success(true)
      })
      return resumed ? { mode: 'main', key } : { mode: 'owner' }
    }
    const input = enabled() && !turn.mixed && text && parseGrant(text)
    if (!input || input.scopes.some(({ targets }) => targets.some((id) => id === session.id || !available(id)))) {
      return { mode: 'owner' }
    }
    // Existence is checked before dispatch against the host's durable headers.
    // Validation is also started now so an invalid target never opens a grant.
    const key = taskKey(session.id, input.task)
    const pending = validateGrant(input, key, session.id, message.id, turn)
    return { mode: 'authorize', key, pending }
  }

  async function validateGrant(input, key, owner, messageId, turn) {
    try {
      const targets = [...new Set(input.scopes.flatMap(({ targets }) => targets))]
      if (!(await Promise.all(targets.map((target) => existing(target, signal)))).every(Boolean) ||
          !enabled() || !available(owner) || turns.get(owner) !== turn || turn.mixed) return false
      const now = Date.now()
      compact()
      return Boolean(openGrant(input, key, owner, messageId, turn.number, now))
    } catch {
      if (!signal.aborted) ctx.logger.warn('workflow grant could not be validated')
      return false
    }
  }

  function openGrant(input, key, owner, messageId, turn, now, evidence, directJob) {
    return ledger.change(({ grants, jobs }) => {
      const known = grantFor(grants, key) || ledger.history.jobCount(key) || ledger.history.hasQuarantined(key) ||
        Object.values(jobs).some((job) => job.key === key)
      if (known || Object.keys(grants).length >= maxGrants || directJob && Object.keys(jobs).length >= maxJobs) {
        return noChange()
      }
      const grant = {
        task: input.task, owner, goal: input.goal, scopes: input.scopes,
        expiresAt: now + input.ttlMinutes * 60_000, state: 'active',
        openedAt: now, ownerMessageId: messageId, ownerTurn: turn,
      }
      if (evidence) Object.assign(grant, {
        collaboration: true, state: directJob?.ownerAdmission ? 'collaboration_authorizing' : 'collaboration_active',
        ...(input.conversation ? { conversation: true } : {}),
        budget: input.budget, dispatched: directJob ? 1 : 0,
        authorization: evidence, batches: [],
      })
      grants[key] = grant
      if (directJob) jobs[directJob.id] = directJob
      return success(grant)
    })
  }

  function workflowInput(session, message) {
    const { bridgeWorkflowId: id, bridgeWorkflowKind: kind } = message.source ?? {}
    if (!UUID.test(id ?? '')) return
    const { grants, jobs } = ledger.read()
    if (kind === 'conversation') {
      const job = jobFor(jobs, id)
      const grant = job && grantFor(grants, job.key)
      const from = message.source.senderSessionId
      const to = session.id
      if (!job?.conversation || !grant?.conversation || !participantPair(job, from, to)) return
      const route = { id, task: grant.task, from, to }
      if (!matchConversation(route, message)) return
      return { mode: 'conversation', id, messageId: message.id, route }
    }
    if (kind !== 'task' && kind !== 'result') return
    const job = jobFor(jobs, id)
    if (!job || receiverOf(job, kind) !== session.id || !isWake(job, kind, message)) return
    return { mode: kind, id, messageId: message.id }
  }

  // Claiming removes an inbox entry before the host appends its user/message.
  // Retain that withdrawal fence until the same native turn ends.
  ctx.on('agent/inbox/claimed', ({ agent, message, turn: number }) => {
    const owner = agent?.session?.id
    const turn = turns.get(owner)
    if (!message || !turn || turn.number !== number || ctx.agents.get(owner) !== agent) return
    const task = withdrawalTask(message)
    if (!task) return
    turn.withdrawals ??= new Set()
    turn.withdrawals.add(task)
  })

  ctx.on('session/event', (session, event) => {
    if (signal.aborted) return
    try {
      if (!available(session.id)) {
        authorization.clear(session.id)
        turns.delete(session.id)
        return
      }
      if (event.type === 'turn/start') {
        completedOwners.delete(session.id)
        turns.set(session.id, { number: event.data.turn, startSeq: event.seq, context: null, mixed: false, wakes: [] })
        return
      }
      const turn = turns.get(session.id)
      if (!turn) return
      if (event.type === 'user/message') {
        const source = event.data.source
        if (hostContext(event.data)) return
        const wake = source?.kind === 'agent-message' ? workflowInput(session, event.data) : undefined
        if (wake) {
          if (wake.mode !== 'conversation') turn.wakes.push(wake)
          if (wake.mode === 'result') ledger.change(({ jobs }) => {
            const resume = jobs[wake.id]?.resume
            if (!sent(resume) || resume.hostTurn) return noChange()
            resume.hostTurn = { turn: turn.number, messageId: event.data.id, at: Date.now() }
            return success()
          })
        }
        // Mixed native or relay inputs never share workflow authority.
        if (turn.context) turn.mixed = true
        const natural = authorization.input(session, turn, event.data)
        if (!turn.mixed) {
          turn.context = wake ?? natural ?? controlInput(session, turn, event.data)
          if (nativeOwner(event.data)) turn.ownerMessage = event.data
          if (wake || natural?.mode === 'direct-context-notice' || nativeOwner(event.data)) turn.input = {
            sequence: event.seq, messageId: event.data.id,
            ...(source?.kind === 'user' ? { rpcId: source.rpcId } : {}),
          }
        }
        // A native owner cancellation still applies even in a mixed turn.
        else if (withdrawalTask(event.data)) {
          controlInput(session, turn, event.data)
        }
        return
      }
      if (event.type === 'assistant/message') authorization.reply(session, turn, event)
      if (event.type !== 'turn/end' || event.data.turn !== turn.number) return
      authorization.end(session, turn, event)
      finishConversationTurn(session, turn, event)
      turns.delete(session.id)
      finishOwnerInput(session, turn, event)
      ledger.change(({ jobs }) => {
        let changed = false
        for (const wake of turn.wakes) {
          const job = jobs[wake.id]
          if (!job) continue
          const delivery = deliveryOf(job, wake.mode)
          if (wake.mode === 'result' && job.nativeResult && sent(delivery)) continue
          if (wake.mode === 'task' && job.conversation && delivery.state === 'claimed' &&
              !turn.mixed && event.data.reason.kind === 'completed') continue
          if (sent(delivery) || (wake.mode === 'task' && delivery.state === 'claimed')) {
            setDelivery(delivery, 'uncertain', wake.mode === 'task' && job.claim
              ? 'execution_ended_without_report' : 'host_turn_ended_without_handshake')
            changed = true
          }
        }
        return { changed }
      })
      schedule()
    } catch {
      ctx.logger.warn('workflow session event could not be recorded')
    }
  })

  function current(exec) {
    const agent = exec?.agent
    const id = agent?.session?.id
    if (signal.aborted || !available(id) || ctx.agents.get(id) !== agent || exec.signal.aborted) return
    const turn = turns.get(id)
    if (!turn || turn.mixed || !turn.context) return
    return { id, turn, context: turn.context }
  }

  function register(name, description, properties, execute, required = Object.keys(properties)) {
    ctx.tools.register({
      name: 'workflow_' + name,
      description,
      parameters: { type: 'object', additionalProperties: false, required, properties },
      output,
      execute(args, exec) {
        const caller = current(exec)
        if (!caller) return denied('workflow_context_required')
        return execute(args, exec, caller)
      },
    })
  }

  function openDirect(caller, input, evidence, ownerAdmission) {
    const key = taskKey(caller.id, input.task)
    const now = Date.now()
    const target = input.scopes[0].targets[0]
    const job = {
      id: randomUUID(), key, owner: caller.id, target, item: 'execute', attempt: 1, scope: input.scopes[0].name,
      instructions: input.goal, acceptance: '按所有者原文完成目标并回报实际结果及证据。',
      after: null, dispatchedTurn: caller.turn.number, createdAt: now, nativeResult: true,
      ...(input.conversation ? { conversation: true } : {}),
      ...(ownerAdmission ? { ownerAdmission } : {}),
      wake: { id: randomUUID(), state: 'queued', updatedAt: now },
    }
    compact()
    const grant = openGrant(input, key, caller.id, (evidence.request ?? evidence.confirmation).messageId,
      caller.turn.number, now, evidence, job)
    if (!grant) return denied('grant_not_opened')
    schedule()
    const { task, goal, scopes, budget, expiresAt } = grant
    return {
      task, goal, scopes, budget, expiresAt, id: job.id,
      targetTitle: evidence.targets[0].title, state: 'queued', duplicate: false,
    }
  }

  const cleanInbox = (agent) => Array.isArray(agent?.inbox?.nextTurn) && Array.isArray(agent?.inbox.nextStep) &&
    !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length

  function finishOwnerInput(session, turn, event) {
    const context = turn.context
    const isNotice = context?.mode === 'direct-context-notice'
    const automaticConfirmation = context?.mode === 'confirm-workflow' && isSingleConversation(context.draft?.grant)
    if (context?.mode !== 'direct-workflow' && !isNotice && !automaticConfirmation) return
    const agent = ctx.agents.get(session.id)
    const clean = enabled() && !turn.mixed && event.data.reason.kind === 'completed' &&
      agent?.session === session && cleanInbox(agent) && turn.input &&
      Number.isSafeInteger(event.seq) && Number.isFinite(event.time)
    const proof = {
      startSeq: turn.startSeq, turn: turn.number, input: turn.input, requestedAt: 0, endSeq: event.seq,
      ...(context.contextual || isNotice ? { sourceDigest: digest(isNotice ? context.saved.notice.text : context.text) } : {}),
      ...(isNotice ? { notice: context.saved.notice } : {}),
    }
    if (isNotice) {
      if (clean) authorization.rememberAfterNotice(session.id, context.saved, proof)
      return
    }
    if (context.contextual && context.direct?.action === 'topic') {
      if (clean) authorization.rememberTopic(session.id, context.direct, proof)
      return
    }
    const previous = context.directResult
    if (previous) {
      if (clean) ledger.change(({ jobs }) => {
        const admission = jobs[previous.id]?.ownerAdmission
        if (!admission) return noChange()
        admission.endSeq = event.seq
        return success()
      })
      return
    }
    if (!clean) return
    const caller = { id: session.id, turn, context: turn.context }
    completedOwners.set(session.id, caller)
    const stillCurrent = () => enabled() && available(session.id) && completedOwners.get(session.id) === caller &&
      ctx.agents.get(session.id) === agent && cleanInbox(agent) ? caller : undefined
    void Promise.resolve().then(async () => {
      await bounded(() => ctx.sessions.flush(session))
      const proofs = [...(context.direct?.prior?.proofs ?? []), proof]
      const events = await bounded((deadline) => hostEvents(ctx, session.id, proofs[0].startSeq, deadline))
      let end
      let offset = 0
      for (const [index, step] of proofs.entries()) {
        if (index && step.turn !== proofs[index - 1].turn + 1) return
        while (events[offset]?.seq < step.startSeq) {
          if (index && events[offset].type === 'turn/start') return
          offset++
        }
        end = closeTurnEvidence(events.slice(offset), step)
        if (end?.reason !== 'completed' || end.sequence !== step.endSeq) return
        offset = events.findIndex(({ seq }) => seq === end.sequence) + 1
      }
      if (!stillCurrent()) return
      if (automaticConfirmation) {
        const { previewProof, preview } = context.draft
        const [shown, ...afterPreview] = await bounded((deadline) =>
          hostEvents(ctx, session.id, previewProof.sequence, deadline))
        const shownText = shown?.data.message?.content?.filter(({ type }) => type !== 'reasoning')
        if (previewProof.turn + 1 !== turn.number || shown?.seq !== previewProof.sequence ||
            shown.type !== 'assistant/message' || shown.data.turn !== previewProof.turn || shown.data.interrupted ||
            shown.data.message.id !== previewProof.messageId || shownText?.length !== 1 ||
            shownText[0].type !== 'text' || shownText[0].text !== preview ||
            !afterPreview.some(({ type, data }) => type === 'turn/end' &&
              data.turn === previewProof.turn && data.reason.kind === 'completed')) return
        await bounded((deadline) => authorization.confirm({ agent, signal: deadline }, caller, stillCurrent,
          (input, evidence) => openDirect(caller, input, { ...evidence, ownerTurnEnd: end })))
        return
      }
      const result = await bounded((deadline) => authorization.delegateDirect({ agent, signal: deadline }, caller, stillCurrent,
        (input, evidence) => openDirect(caller, input, { ...evidence, ownerTurnEnd: end })))
      const notice = (context.contextual ? contextualNotices[result?.error] : undefined) ?? directNotices[result?.error]
      if (notice && stillCurrent()) {
        const id = randomUUID()
        if (result.clarification) authorization.rememberClarification(session.id, context.direct, proof,
          result.clarification, { id, owner: session.id, text: notice })
        agent.followup({
          id, role: 'user', content: [{ type: 'text', text: notice }],
          source: {
            kind: 'agent-message', form: 'relay', senderSessionId: session.id,
            bridgeWorkflowKind: 'direct-notice', bridgeWorkflowOwner: session.id,
          },
        })
      }
    }).catch(() => {
      if (!signal.aborted) ctx.logger.warn('workflow automatic owner input could not be verified')
    }).finally(() => {
      if (completedOwners.get(session.id) === caller) completedOwners.delete(session.id)
    })
  }

  register('delegate_direct',
    'A precise one-window owner request is handled by the host at the end of its native turn. If you call this tool, call once without arguments. A queued receipt names the matched targetTitle. A contextual request may return waiting_for_owner_turn_end or waiting_for_owner_request without opening an assignment. The host releases work only after verifying the owner turn. Use workflow_propose for broader requests.',
    {}, (args, exec, caller) => {
      if (!args || Object.keys(args).length !== 0) return denied('workflow_direct_arguments_not_allowed')
      if (caller.context.mode === 'direct-workflow' && caller.context.contextual) {
        return { state: caller.context.direct.action === 'topic' ? 'waiting_for_owner_request' : 'waiting_for_owner_turn_end' }
      }
      return authorization.delegateDirect(exec, caller, current, (input, evidence) =>
        openDirect(caller, input, evidence, {
          startSeq: caller.turn.startSeq, turn: caller.turn.number, input: caller.turn.input, requestedAt: Date.now(),
        }))
    })

  register('propose',
    'For a delegation requested by the owner in this turn, draft a concrete plan with the goal, window titles, purposes, expiry and assignment budget. Use conversation:true when the owner wants ongoing exchanges with assigned workers. Mark each formal review scope with review:true when the owner requests review. Clarify uncertain titles or scope first. If preview is returned, copy its exact text as your entire final reply and wait for the owner.',
    workflowProposalProperties, (args, exec, caller) => {
      if (caller.context.mode === 'owner') {
        const context = authorization.proposalInput(caller.turn.ownerMessage, caller.turn)
        if (context) caller.context = caller.turn.context = context
      }
      return authorization.propose(args, exec, caller, current)
    }, Object.keys(workflowProposalProperties).filter((key) => key !== 'conversation'))

  const isSingleConversation = (input) => input?.conversation && input.budget === 1 &&
    input.scopes.length === 1 && input.scopes[0].targets.length === 1 && !input.scopes[0].review

  register('confirm',
    'Open the frozen workflow plan after the owner affirms the visible preview in the original controller. Call with no arguments. A successful response allows dispatch in this turn.',
    {}, async (_args, exec, caller) => {
      if (caller.context.draft && isSingleConversation(caller.context.draft.grant)) {
        return { state: 'waiting_for_owner_turn_end' }
      }
      const result = await authorization.confirm(exec, caller, current, (input, evidence) => {
        const key = taskKey(caller.id, input.task)
        compact()
        const grant = openGrant(input, key, caller.id, evidence.confirmation.messageId,
          caller.turn.number, Date.now(), evidence)
        if (!grant) return denied('grant_not_opened')
        const { task, goal, scopes, budget, expiresAt } = grant
        return { task, goal, scopes, budget, expiresAt, duplicate: false }
      })
      if (result?.duplicate === false && current(exec)?.context === caller.context) {
        caller.turn.context = { mode: 'main', key: taskKey(caller.id, result.task) }
      }
      return result
    })

  const validAssignment = (entry) => entry && Object.keys(entry).every((key) => Object.hasOwn(assignmentProperties, key)) &&
    validId(entry.item) && validId(entry.scope) && validId(entry.target) &&
    Number.isInteger(entry.attempt) && entry.attempt >= 1 && entry.attempt <= 8 &&
    validText(entry.instructions, 4000) && validText(entry.acceptance, 1500) &&
    (entry.reviewOf === undefined && entry.artifact === undefined ||
      typeof entry.reviewOf === 'string' && UUID.test(entry.reviewOf) && validArtifact(entry.artifact))

  function sameAssignment(job, entry, batch) {
    return job?.batch === batch && Object.keys(assignmentProperties).every((key) => job?.[key] === entry[key])
  }

  function resultJob(grant, job, jobs) {
    const anchor = job?.batch && batchOf(grant, job.batch)?.anchor
    return job?.batch ? (anchor ? jobFor(jobs, anchor) : undefined) : job
  }

  async function dispatch(task, assignments, exec, caller, group) {
    const { id, turn, context } = caller
    const key = taskKey(id, task)
    if (!enabled()) return denied('workflow_disabled')
    if ((context.mode !== 'authorize' && context.mode !== 'main') || context.key !== key) return denied('main_task_context_required')
    if (!validId(task) || !assignments.every(validAssignment)) return denied('invalid_dispatch')
    if (context.pending && !await context.pending) return denied('grant_not_opened')
    const grant = ledger.read().grants[key]
    if (!activeGrant(grant)) return denied('grant_inactive')
    if (!grant.collaboration && (group || assignments.some(({ reviewOf }) => reviewOf))) {
      return denied('collaboration_grant_required')
    }
    const formalReview = grant.collaboration && grant.scopes.some(({ review }) => review)
    const inScope = ({ scope, target, reviewOf }) => {
      const route = grant.scopes.find(({ name }) => name === scope)
      return target !== id && available(target) && route?.targets.includes(target) &&
        (!formalReview || Boolean(route.review) === Boolean(reviewOf))
    }
    if (!assignments.every(inScope)) return denied('scope_or_target_denied')
    const targets = [...new Set(assignments.map(({ target }) => target))]
    if (!(await Promise.all(targets.map((target) => existing(target, exec.signal)))).every(Boolean)) {
      return denied('existing_target_required')
    }
    if (current(exec)?.turn !== turn || turn.context !== context || !enabled()) return denied('main_task_context_required')
    compact()
    const result = ledger.change(({ grants, jobs }) => {
      const grant = grants[key]
      if (!activeGrant(grant) || !targets.every(available)) return noChange(denied('grant_inactive'))
      const knownBatch = group && batchOf(grant, group.batch)
      if (knownBatch) {
        const exact = knownBatch.completion === group.completion && knownBatch.members.length === assignments.length &&
          knownBatch.members.every((jobId, index) => sameAssignment(jobFor(jobs, jobId), assignments[index], group.batch))
        return noChange(exact
          ? { batch: group.batch, ids: knownBatch.members, duplicate: true }
          : denied('batch_conflict'))
      }
      const sameGrant = Object.values(jobs).filter((job) => job.key === key)
      for (const entry of assignments) {
        const { item, attempt, target, scope, reviewOf, artifact } = entry
        const findAttempt = (number) => sameGrant.find((job) => job.item === item && job.attempt === number) ??
          ledger.history.attempt(key, item, number)
        if (ledger.history.quarantinedAttempt(key, item, attempt)) return noChange(denied('attempt_quarantined'))
        const same = findAttempt(attempt)
        if (same) return noChange(!group && sameAssignment(same, entry)
          ? { id: same.id, duplicate: true } : denied('attempt_conflict'))
        if (attempt > 1) {
          const previous = findAttempt(attempt - 1)
          if (previous?.target !== target || previous.scope !== scope ||
              resultJob(grant, previous, jobs)?.resume?.state !== 'consumed') {
            return noChange(denied('previous_attempt_not_consumed'))
          }
        }
        if (reviewOf) {
          const producer = jobFor(jobs, reviewOf)
          if (producer?.key !== key || producer.owner !== id || producer.target === target ||
              producer.report?.status !== 'completed' || producer.report.late ||
              !producer.report.artifacts?.includes(artifact)) return noChange(denied('artifact_binding_required'))
        }
      }
      if (sameGrant.length + assignments.length > maxPerGrant || Object.keys(jobs).length + assignments.length > maxJobs) {
        return noChange(denied('ledger_limit'))
      }
      if (grant.collaboration && grant.dispatched + assignments.length > grant.budget) {
        return noChange(denied('assignment_budget_exhausted'))
      }
      const continuation = context.after && jobs[context.after]?.resume?.continuation
      if (context.after && (continuation?.state !== 'started' || continuation.turn !== turn.number)) {
        return noChange(denied('continuation_not_active'))
      }
      const now = Date.now()
      const ids = assignments.map(({ item, attempt, target, scope, instructions, acceptance, reviewOf, artifact }) => {
        const jobId = randomUUID()
        jobs[jobId] = {
          id: jobId, key, owner: id, target, item, attempt, scope, instructions, acceptance,
          ...(grant.conversation ? { conversation: true } : {}),
          ...(group ? { batch: group.batch } : {}),
          ...(reviewOf ? { reviewOf, artifact } : {}),
          after: context.after ?? null, dispatchedTurn: turn.number, createdAt: now,
          wake: { id: randomUUID(), state: 'queued', updatedAt: now },
        }
        return jobId
      })
      if (continuation) continuation.dispatches.push(...ids)
      if (grant.collaboration) grant.dispatched += ids.length
      if (group) {
        grant.batches.push({ ...group, members: ids })
        return success({ batch: group.batch, ids, duplicate: false })
      }
      return success({ id: ids[0], state: 'queued', duplicate: false })
    })
    schedule()
    return result
  }

  register('dispatch',
    'Delegate to an existing session under this turn’s authorized workflow task. Use item and attempt for idempotency. A retry requires the earlier result to have been consumed. For a review, bind reviewOf to the producer job id and artifact to its exact reported digest.',
    { task: idSchema, ...assignmentProperties },
    ({ task, ...entry }, exec, caller) => dispatch(task, [entry], exec, caller),
    ['task', ...assignmentRequired])

  register('dispatch_batch',
    'Atomically dispatch a named group under a confirmed collaboration grant. Each assignment uses the same fields as workflow_dispatch except task. The controller receives one result when all assignments have reported, failed or need reconciliation. completion describes the batch acceptance condition.',
    {
      task: idSchema, batch: idSchema, completion: textSchema(1000),
      assignments: { type: 'array', minItems: 1, maxItems: 16, items: {
        type: 'object', additionalProperties: false, required: assignmentRequired, properties: assignmentProperties,
      } },
    },
    ({ task, batch, completion, assignments }, exec, caller) => {
      if (!validId(batch) || !validText(completion, 1000) || !Array.isArray(assignments) ||
          assignments.length < 1 || assignments.length > 16 ||
          new Set(assignments.map((entry) => entry?.item)).size !== assignments.length) return denied('invalid_batch')
      return dispatch(task, assignments, exec, caller, { batch, completion })
    })

  const participantPair = (job, from, to) =>
    from === job.owner && to === job.target || from === job.target && to === job.owner

  function conversationRoute(grant, job, from, to) {
    if (!job?.conversation || !grant?.conversation || grant.owner !== job.owner ||
        !grant.scopes.some(({ name, targets }) => name === job.scope && targets.includes(job.target)) ||
        !canRoute(grant, job, 'task') || job.report || job.wake.state !== 'claimed' ||
        !claimedHere.has(job.id) || !participantPair(job, from, to)) return
    return { id: job.id, task: grant.task, from, to }
  }

  function pendingWithdrawal(owner, task) {
    const inbox = ctx.agents.get(owner)?.inbox
    const matches = (message) => withdrawalTask(message) === task
    return turns.get(owner)?.withdrawals?.has(task) ||
      inbox?.nextTurn?.some(matches) || inbox?.nextStep?.some(matches)
  }

  function liveConversation(route) {
    const { grants, jobs } = ledger.read()
    const job = jobs[route.id]
    const active = conversationRoute(grants[job?.key], job, route.from, route.to)
    return active?.task === route.task && !pendingWithdrawal(job.owner, route.task)
  }

  function queueMessage({ to, task }, exec, reserve) {
    const caller = current(exec)
    const { grants, jobs } = ledger.read()
    const from = exec.agent?.session?.id
    const context = turns.get(from)?.context
    const bound = context?.mode === 'task' || context?.mode === 'conversation' ? jobFor(jobs, context.id) : undefined
    let job
    if (bound?.conversation) {
      if (!caller) return denied('workflow_task_context_required')
      if (task && task !== bound.id && task !== grantFor(grants, bound.key)?.task) return denied('workflow_task_mismatch')
      job = jobs[bound.id]
    } else {
      const ownerInput = caller?.turn.ownerMessage
      const text = ownerInput && plainText(ownerInput)
      const references = new Set(text?.match(/[a-zA-Z0-9_-]+/g))
      const owned = Object.values(jobs).filter((entry) => entry.conversation && entry.owner === from)
      const candidates = owned.filter((entry) => entry.target === to)
      if (!candidates.length && !task) {
        if (owned.some((entry) => references.has(entry.id) || references.has(grants[entry.key]?.task))) {
          return denied('workflow_task_route_inactive')
        }
        return
      }
      if (!text || !['owner', 'main'].includes(context.mode)) return denied('workflow_task_context_required')
      const named = candidates.filter((entry) => references.has(entry.id) ||
        references.has(grants[entry.key]?.task))
      const eligible = named.length ? named : candidates.filter((entry) =>
        conversationRoute(grants[entry.key], entry, from, to))
      if (task && !named.length && (eligible.length !== 1 ||
          task !== eligible[0].id && task !== grants[eligible[0].key]?.task)) {
        return denied('workflow_task_reference_required')
      }
      if (eligible.length > 1) return {
        error: 'workflow_task_reference_required',
        tasks: eligible.map((entry) => ({ task: grants[entry.key]?.task, job: entry.id, goal: grants[entry.key]?.goal })),
      }
      job = eligible[0]
      if (job && task && task !== job.id && task !== grants[job.key]?.task) return denied('workflow_task_mismatch')
    }
    const route = conversationRoute(grants[job?.key], job, from, to)
    if (!route || pendingWithdrawal(job.owner, route.task)) return denied('workflow_task_route_inactive')
    if (caller.turn.deferred?.length >= 8) return denied('workflow_turn_message_limit')
    const { receipt, send, stop } = reserve(route)
    if (send) defer(caller.turn, route, (deadline) => send(deadline, () => liveConversation(route)), stop)
    return receipt
  }

  function defer(turn, route, run, stop) {
    turn.deferred ??= []
    turn.deferred.push({ route, run, stop })
  }

  function finishConversationTurn(session, turn, event) {
    if (!turn.deferred?.length) return
    // Read the owner's queues synchronously at the source turn boundary.
    // The driver can claim the next input while the durable proof is read.
    const { context, input } = turn
    const ready = !turn.mixed && input && event.data.reason.kind === 'completed'
      ? turn.deferred.filter(({ route }) => liveConversation(route)) : []
    const job = (context.mode === 'task' || context.mode === 'conversation') && ledger.read().jobs[context.id]
    const matchesInput = context.mode === 'conversation' ? (data) => matchConversation(context.route, data)
      : job ? (data) => isWake(job, 'task', data) : undefined
    const sourceDigest = turn.ownerMessage && digest(plainText(turn.ownerMessage) ?? '')
    const proof = { turn: turn.number, startSeq: turn.startSeq, input, requestedAt: 0, sourceDigest }
    void Promise.resolve().then(async () => {
      if (!ready.length) return
      await bounded(() => ctx.sessions.flush(session))
      const end = await bounded(async (deadline) =>
        closeTurnEvidence(await hostEvents(ctx, session.id, turn.startSeq, deadline), proof, undefined, matchesInput))
      if (end?.reason !== 'completed' || end.sequence !== event.seq) return
      for (const entry of ready) {
        if (liveConversation(entry.route)) await bounded(entry.run)
      }
    }).catch(() => {
      if (!signal.aborted) ctx.logger.warn('workflow task exchange could not be verified')
    }).finally(() => {
      for (const entry of turn.deferred) entry.stop?.()
    })
  }

  register('claim',
    'When this turn receives DSH-WORKFLOW TASK <id>, call once to claim the task and get its instructions, approved purpose, attempt number and claim token. Execute only under that purpose and the host’s permissions. For a verified ongoing task message, the same job id retrieves its existing claim. Do not execute on a duplicate or rejected claim.',
    { id: uuidSchema },
    ({ id }, _exec, caller) => {
      const { context, turn } = caller
      if (!['task', 'conversation'].includes(context.mode) || context.id !== id) return denied('task_wake_required')
      const result = ledger.change(({ grants, jobs }) => {
        const job = jobFor(jobs, id)
        if (!job) return noChange(denied('task_wake_required'))
        const grant = grants[job.key]
        if (context.mode === 'conversation') {
          if (caller.id !== job.target || !conversationRoute(grant, job, context.route.from, context.route.to)) return noChange(denied('grant_inactive'))
          return noChange({ id, task: grant.task, owner: job.owner, attempt: job.attempt, token: job.claim.token,
            instructions: job.instructions, acceptance: job.acceptance, expiresAt: grant.expiresAt, continuation: true })
        }
        if (job.claim) return noChange({ id, duplicate: true })
        if (!canRoute(grant, job, 'task') || !jobs[id]) return noChange(denied('grant_inactive'))
        if (!sent(job.wake)) return noChange(denied('delivery_not_claimable'))
        const token = randomUUID()
        job.claim = { token, turn: turn.number, messageId: context.messageId, at: Date.now() }
        setDelivery(job.wake, 'claimed')
        return success({
          id, task: grant.task, goal: grant.goal, item: job.item, attempt: job.attempt,
          owner: job.owner, scope: job.scope, instructions: job.instructions, acceptance: job.acceptance,
          ...(grant.collaboration ? { purpose: grant.scopes.find(({ name }) => name === job.scope)?.purpose } : {}),
          ...(job.reviewOf ? { reviewOf: job.reviewOf, artifact: job.artifact } : {}),
          expiresAt: grant.expiresAt, token, duplicate: false,
        })
      })
      if (result.duplicate === false) claimedHere.add(id)
      return result
    })

  register('report',
    'Submit the final structured result in the claiming turn or a verified ongoing task turn. Use send_session_message for interim progress or questions. Include concrete evidence. A completed producer may report immutable artifacts. An approval or change request for a bound review must give reviewedArtifact exactly as claimed.',
    {
      id: uuidSchema, attempt: attemptSchema, token: uuidSchema,
      status: { type: 'string', enum: statuses },
      summary: textSchema(2400),
      evidence: { type: 'array', maxItems: 8, items: textSchema(300) },
      artifacts: artifactList, reviewedArtifact: artifactSchema,
    },
    ({ id, attempt, token, status, summary, evidence, artifacts, reviewedArtifact }, _exec, caller) => {
      const { context, turn } = caller
      if (!['task', 'conversation'].includes(context.mode) || context.id !== id) return denied('task_wake_required')
      if (!statuses.includes(status) || !validText(summary, 2400) || !Array.isArray(evidence) ||
          evidence.length > 8 || !evidence.every((entry) => validText(entry, 300)) ||
          (artifacts !== undefined && (!validArtifacts(artifacts) || status !== 'completed')) ||
          (reviewedArtifact !== undefined && !validArtifact(reviewedArtifact)) ||
          (['approved', 'changes_requested'].includes(status) && evidence.length === 0)) return denied('invalid_report')
      const recordReport = () => ledger.change(({ grants, jobs }) => {
        const job = jobFor(jobs, id)
        const claim = job?.claim
        const continuation = context.mode === 'conversation' && job?.conversation
        if (!claim || job.target !== caller.id || job.attempt !== attempt || claim.token !== token ||
            (!continuation && (claim.turn !== turn.number || claim.messageId !== context.messageId))) {
          return noChange(denied('claim_mismatch'))
        }
        if (job.report) {
          const exact = job.report.status === status && job.report.summary === summary &&
            JSON.stringify(job.report.evidence) === JSON.stringify(evidence) &&
            JSON.stringify(job.report.artifacts) === JSON.stringify(artifacts) &&
            job.report.reviewedArtifact === reviewedArtifact
          return noChange(exact ? { id, recorded: true, duplicate: true, late: job.report.late } : denied('report_conflict'))
        }
        if (!jobs[id] || job.wake.state !== 'claimed') return noChange(denied('claim_not_active'))
        const grant = grants[job.key]
        const collaborative = grantFor(grants, job.key)?.collaboration
        const reviewVerdict = status === 'approved' || status === 'changes_requested'
        if (!collaborative && (artifacts !== undefined || reviewedArtifact !== undefined)) {
          return noChange(denied('collaboration_grant_required'))
        }
        if ((collaborative && reviewVerdict && (!job.reviewOf || reviewedArtifact !== job.artifact)) ||
            (reviewedArtifact !== undefined && (!job.reviewOf || reviewedArtifact !== job.artifact)) ||
            (job.reviewOf && (status === 'completed' || artifacts !== undefined))) {
          return noChange(denied('artifact_binding_required'))
        }
        const late = !enabled() || !available(job.owner) || !available(job.target) ||
          !['active', 'paused'].includes(stateOf(grant))
        if (job.conversation && (late || !activeGrant(grant))) return noChange(denied('grant_inactive'))
        job.report = {
          status, summary, evidence, reporter: caller.id, turn: turn.number, at: Date.now(), late,
          ...(artifacts !== undefined ? { artifacts } : {}),
          ...(reviewedArtifact !== undefined ? { reviewedArtifact } : {}),
        }
        setDelivery(job.wake, 'reported')
        if (!late && !job.batch) {
          job.resume = { id: randomUUID(), state: 'queued', updatedAt: Date.now() }
          if (status === 'needs_owner') setGrantState(grant, 'paused')
        }
        return success({ id, recorded: true, duplicate: false, late })
      })
      const { grants, jobs } = ledger.read()
      const job = jobs[id]
      if (job?.conversation) {
        if (job.target !== caller.id || job.attempt !== attempt || job.claim?.token !== token) return denied('claim_mismatch')
        const route = conversationRoute(grants[job.key], job, caller.id, job.owner)
        if (!route || pendingWithdrawal(job.owner, route.task)) return denied('grant_inactive')
        const reportDigest = digest(JSON.stringify([status, summary, evidence, artifacts, reviewedArtifact]))
        if (turn.pendingReport) return turn.pendingReport === reportDigest
          ? { id, queued: true, duplicate: true } : denied('report_conflict')
        // Validate formal review evidence before promising to record the result.
        if ((['approved', 'changes_requested'].includes(status) || reviewedArtifact !== undefined) &&
            (!job.reviewOf || reviewedArtifact !== job.artifact) ||
            job.reviewOf && (status === 'completed' || artifacts !== undefined)) return denied('artifact_binding_required')
        turn.pendingReport = reportDigest
        defer(turn, route, () => { recordReport(); schedule() })
        return { id, queued: true, duplicate: false }
      }
      const result = recordReport()
      schedule()
      return result
    }, ['id', 'attempt', 'token', 'status', 'summary', 'evidence'])

  register('consume',
    'When this turn receives DSH-WORKFLOW RESULT <id>, read the result once. A batch result contains all members, including failures and uncertain work. A direct delegation report is already in the native notification. If you need its structured record, use the assignment id from the direct delegation receipt. Other workflows can continue with further dispatch or explicit close.',
    { id: uuidSchema },
    ({ id }, exec, caller) => {
      const { context, turn } = caller
      if (context.mode === 'main' && context.after === id) return { id, duplicate: true }
      if (context.mode !== 'result' || context.id !== id) return denied('result_wake_required')
      const result = ledger.change(({ grants, jobs }, archive) => {
        const job = jobFor(jobs, id)
        if (!job) return noChange(denied('result_wake_required'))
        if (job.resume?.state === 'consumed') return noChange({ id, duplicate: true })
        const grant = grants[job.key]
        if (!canRoute(grant, job, 'result') || !jobs[id]) return noChange(denied('grant_inactive'))
        if (!sent(job.resume)) return noChange(denied('result_not_consumable'))
        const batch = batchOf(grant, job.batch)
        if (job.batch && (batch?.anchor !== id || !batchMembers(grant, batch, jobs))) {
          return noChange(denied('batch_evidence_unavailable'))
        }
        const issue = continuationIssue(job.resume)
        if (issue) {
          quarantineContinuation(job, issue, jobs, archive)
          return success(denied('result_not_consumable'))
        }
        setDelivery(job.resume, 'consumed')
        job.resume.consumedTurn = turn.number
        job.resume.handoffAt = Date.now()
        job.resume.continuation = { state: 'started', turn: turn.number, at: Date.now(), dispatches: [] }
        const replyAfterSeq = exec.agent.session.seq
        if (isDirectGrant(grant) && Number.isSafeInteger(replyAfterSeq) && replyAfterSeq >= turn.input?.sequence) {
          job.resume.continuation.replyAfterSeq = replyAfterSeq
        }
        return success({
          ...(batch ? { batch: batchView(grant, batch, jobs) } : jobView(job, grant)),
          task: grant.task, goal: grant.goal, duplicate: false,
        })
      })
      if (result.duplicate === false) turn.context = { mode: 'main', key: taskKey(caller.id, result.task), after: id }
      schedule()
      return result
    })

  function taskJobs(jobs, owner, key) {
    return [...Object.values(jobs).filter((job) => job?.key === key), ...ledger.history.jobsFor(key)]
      .filter((job) => job?.key === key && job.owner === owner)
  }

  function batchMembers(grant, batch, jobs) {
    const key = taskKey(grant.owner, grant.task)
    const members = batch.members.map((id) => jobFor(jobs, id))
    return members.every((job) => job?.key === key && job.owner === grant.owner && job.batch === batch.batch)
      ? members : undefined
  }

  function batchView(grant, batch, jobs) {
    const members = batchMembers(grant, batch, jobs)
    const anchor = members?.find(({ id }) => id === batch.anchor)
    return {
      batch: batch.batch, completion: batch.completion,
      state: members ? anchor?.resume?.state ?? (terminal(stateOf(grant)) ? stateOf(grant) : 'collecting') : 'needs_reconciliation',
      items: members?.map((job) => jobView(job, grant)) ?? [],
      ...(anchor?.resume?.continuation ? { continuation: anchor.resume.continuation } : {}),
    }
  }

  function taskStatus(owner, task) {
    const key = taskKey(owner, task)
    const { grants, jobs } = ledger.read()
    const recorded = grantFor(grants, key)
    const grant = recorded?.owner === owner && recorded.task === task ? recorded : undefined
    const rows = taskJobs(jobs, owner, key)
    const quarantined = ledger.history.quarantined(key).map(({ id, reason }) => ({ id, reason }))
    if (!grant && !rows.length && !quarantined.length) return denied('grant_not_found')
    rows.sort((a, b) => a.createdAt - b.createdAt)
    return {
      ...(grant ?? { task, owner }), state: stateOf(grant), workflowEnabled: enabled(),
      jobs: rows.map((job) => jobView(job, grant)), archivedJobs: ledger.history.jobCount(key), quarantined,
      ...(grant?.batches ? { batches: grant.batches.map((batch) => batchView(grant, batch, jobs)) } : {}),
    }
  }

  ctx.inject(['connection'], (scope) => {
    if (!scope.connection) return
    registerWorkflowView(scope, (owner, task) => {
      if (signal.aborted || !available(owner)) return denied('route_not_allowed')
      if (task !== undefined) return taskStatus(owner, task)
      const grants = [...Object.values(ledger.read().grants), ...ledger.history.grantsFor(owner)]
        .filter((grant) => grant?.owner === owner && validId(grant.task))
        .sort((a, b) => b.openedAt - a.openedAt)
        .map((grant) => ({
          task: grant.task, owner: grant.owner, goal: grant.goal, expiresAt: grant.expiresAt,
          openedAt: grant.openedAt, outcome: grant.outcome, state: stateOf(grant),
        }))
      return { tasks: grants, workflowEnabled: enabled() }
    })
  })

  register('status',
    'Read the local ledger for a task in its original main session. Use an owner prompt or that task’s workflow continuation. Uncertain items require review and are never automatically resent.',
    { task: idSchema },
    async ({ task }, exec, caller) => {
      const key = taskKey(caller.id, task)
      const { turn, context } = caller
      if (context.mode !== 'owner' && context.key !== key) return denied('main_task_context_required')
      if (context.pending) await context.pending
      if (current(exec)?.turn !== turn || turn.context !== context) return denied('main_task_context_required')
      return taskStatus(caller.id, task)
    })

  register('item_status',
    'Read one active or historical attempt by id from its original main session. Use an owner prompt or the same workflow task context.',
    { task: idSchema, id: uuidSchema },
    async ({ task, id }, exec, caller) => {
      const key = taskKey(caller.id, task)
      const { turn, context } = caller
      if (context.mode !== 'owner' && context.key !== key) return denied('main_task_context_required')
      if (context.pending) await context.pending
      if (current(exec)?.turn !== turn || turn.context !== context) return denied('main_task_context_required')
      const { grants, jobs } = ledger.read()
      const job = jobFor(jobs, id)
      if (job?.key !== key || job.owner !== caller.id) return denied('job_not_found')
      const grant = grantFor(grants, key)
      return { task, grantState: stateOf(grant), ...jobView(job, grant) }
    })

  register('close',
    'Request closeout of a finished workflow in its bound main turn. A collaboration task returns closing until this exact native turn ends normally and its completion is durable. Finish the turn after requesting closeout. Include outcome and summary. completed requires successful latest attempts and exact finalArtifacts backed by the latest approved review whenever review was requested. Use partial or failed for settled failures. The owner can cancel with 取消委托 <task>.',
    {
      task: idSchema, outcome: { type: 'string', enum: ['completed', 'partial', 'failed'] },
      summary: textSchema(2400), finalArtifacts: artifactList,
    },
    async ({ task, outcome, summary, finalArtifacts }, exec, caller) => {
      const { id, turn, context } = caller
      const key = taskKey(id, task)
      if (!enabled() || (context.mode !== 'main' && context.mode !== 'authorize') || context.key !== key) return denied('main_task_context_required')
      if (context.pending && !await context.pending) return denied('grant_not_opened')
      if (!enabled() || current(exec)?.turn !== turn || turn.context !== context) return denied('main_task_context_required')
      const result = ledger.change(({ grants, jobs }) => {
        const grant = grants[key]
        if (grant?.collaboration && stateOf(grant) === 'closing') {
          const closure = grant.closure
          if (closure?.state !== 'pending' || closure.turn !== turn.number || closure.startSeq !== turn.startSeq) {
            return noChange(denied('close_pending'))
          }
          const requested = closure.requestedOutcome
          const exact = requested.status === outcome && requested.summary === summary &&
            JSON.stringify(requested.finalArtifacts) === JSON.stringify(finalArtifacts ?? [])
          return noChange(exact ? { task, state: 'closing', duplicate: true } : denied('close_conflict'))
        }
        if (!activeGrant(grant)) return noChange(denied('grant_inactive'))
        const unsettled = Object.values(jobs).some((job) => job.key === key &&
          (!['reported', 'failed', 'skipped', 'reconciled'].includes(job.wake.state) ||
            job.resume && !['consumed', 'failed', 'skipped', 'reconciled'].includes(job.resume.state)))
        if (unsettled) return noChange(denied('work_unsettled'))
        if (grant.collaboration) {
          if (!['completed', 'partial', 'failed'].includes(outcome) || !validText(summary, 2400) ||
              finalArtifacts !== undefined && !validArtifacts(finalArtifacts)) return noChange(denied('invalid_outcome'))
          if (!Number.isSafeInteger(turn.startSeq) || !Number.isSafeInteger(turn.input?.sequence)) {
            return noChange(denied('close_turn_identity_unavailable'))
          }
          if (grant.batches.some((batch) => !batch.anchor || !batchMembers(grant, batch, jobs) ||
              jobFor(jobs, batch.anchor)?.resume?.state !== 'consumed')) return noChange(denied('batch_not_consumed'))
          const all = taskJobs(jobs, id, key)
          const latest = new Map()
          for (const job of all) if ((latest.get(job.item)?.attempt ?? 0) < job.attempt) latest.set(job.item, job)
          const jobsAtClose = [...latest.values()]
          const producers = jobsAtClose.filter((job) => !job.reviewOf && job.report?.status === 'completed' && !job.report.late)
          const reviews = jobsAtClose.filter((job) => job.reviewOf)
          const refs = finalArtifacts ?? []
          const produced = (artifact) => producers.some((job) => job.report.artifacts?.includes(artifact))
          if (!refs.every(produced)) return noChange(denied('artifact_binding_required'))
          if (outcome === 'completed') {
            const verified = (job) => {
              const result = resultJob(grant, job, jobs)
              const continuation = result?.resume?.continuation
              return result?.resume?.state === 'consumed' && (continuation?.state === 'verified' ||
                (continuation?.state === 'interrupted' &&
                  continuation.reconciliation?.decision === 'reviewed_without_replay' &&
                  continuation.reconciliation.owner === id) ||
                (continuation?.state === 'started' && result.id === context.after && continuation.turn === turn.number))
            }
            if (!jobsAtClose.length || ledger.history.hasQuarantined(key) || jobsAtClose.some((job) =>
              job.wake.state !== 'reported' || job.report?.late ||
              !['completed', 'approved'].includes(job.report?.status) || !verified(job))) {
              return noChange(denied('successful_attempts_required'))
            }
            const approved = (artifact) => producers.some((producer) => producer.report.artifacts?.includes(artifact) &&
              reviews.some((job) => job.reviewOf === producer.id && job.report.status === 'approved' &&
                job.artifact === artifact && job.report.reviewedArtifact === artifact))
            const reviewRequired = grant.scopes.some(({ review }) => review)
            if ((reviewRequired || reviews.length) && (!refs.length || !refs.every(approved) || reviews.some((job) =>
              !producers.some(({ id }) => id === job.reviewOf)))) return noChange(denied('approved_artifacts_required'))
          }
          if (grant.closure?.state === 'interrupted') grant.previousClosure = grant.closure
          grant.closure = {
            state: 'pending', turn: turn.number, startSeq: turn.startSeq, input: turn.input,
            after: context.after ?? null, requestedAt: Date.now(),
            requestedOutcome: { status: outcome, summary, finalArtifacts: refs },
          }
          setGrantState(grant, 'closing')
          return success({ task, state: 'closing', duplicate: false })
        } else if (outcome !== undefined || summary !== undefined || finalArtifacts !== undefined) {
          return noChange(denied('collaboration_grant_required'))
        }
        grant.state = 'closed'
        grant.closedAt = Date.now()
        grant.closedTurn = turn.number
        return success({ task, state: 'closed' })
      })
      schedule()
      return result
    }, ['task'])

  const isIdle = (agent) => agent.status === 'idle' && !agent.inbox.hasPending && !turns.has(agent.session.id)

  function updateDelivery(job, kind, expected, update) {
    return ledger.change((state) => {
      const stored = state.jobs[job.id]
      const delivery = stored && deliveryOf(stored, kind)
      if (delivery?.state !== expected) return noChange(false)
      return update(delivery, state.grants[stored.key], stored, state)
    })
  }

  function checkpoint(job, kind, expected, next, reason) {
    return updateDelivery(job, kind, expected, (delivery) => {
      setDelivery(delivery, next, reason)
      return success(true)
    })
  }

  function retainedSlot(jobs, job, kind, grants) {
    const recipient = receiverOf(job, kind)
    return jobs.some((other) => {
      const state = stateOf(grants[other.key])
      const active = state === 'active' || state === 'paused' ||
        (state === 'missing_grant' && other.quarantine)
      if (recipient === other.target && (other !== job || kind !== 'task') &&
          active && (!other.quarantine || other.quarantine.taskHadHostRisk) &&
          (unresolved(other.wake) || other.wake.state === 'claimed' && !other.conversation)) return true
      return recipient === other.owner && (other !== job || kind !== 'result') &&
        active && (!other.quarantine || other.quarantine.resultHadHostRisk) && unresolved(other.resume)
    })
  }

  // Resolve and flush have no host abort parameter. Race them with a local
  // deadline so a hung destination cannot hold the dispatcher, and never
  // use a result that arrives after the fence.
  async function bounded(work, deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)])) {
    deadline.throwIfAborted()
    const abort = Promise.withResolvers()
    const onAbort = () => abort.reject(deadline.reason)
    deadline.addEventListener('abort', onAbort, { once: true })
    try {
      return await Promise.race([work(deadline), abort.promise])
    } finally {
      deadline.removeEventListener('abort', onAbort)
    }
  }

  async function send(job, kind) {
    const to = receiverOf(job, kind)
    const live = ctx.agents.get(to)
    if (live && !isIdle(live)) return
    let agent
    try {
      const resolved = await bounded(() => ctx.sessionController.resolveAgent(to))
      agent = resolved.agent
    } catch {
      if (!signal.aborted) updateDelivery(job, kind, 'queued', (delivery, grant) => {
        if (!grant?.collaboration) {
          setDelivery(delivery, 'failed', 'destination_resolution_failed_before_send')
          return success(true)
        }
        delivery.lookupFailures = (delivery.lookupFailures ?? 0) + 1
        const failed = delivery.lookupFailures >= 3
        setDelivery(delivery, failed ? 'failed' : 'queued',
          failed ? 'destination_resolution_failed_before_send' : 'waiting_for_destination_resolution')
        if (!failed) delivery.retryAt = Date.now() + delivery.lookupFailures * 1500
        return success(true)
      })
      return
    }
    if (signal.aborted) return
    if (!agent || agent.session.id !== to) {
      checkpoint(job, kind, 'queued', 'failed', 'destination_unavailable_before_send')
      return
    }
    if (!isIdle(agent) || ctx.agents.get(to) !== agent) return
    const ready = updateDelivery(job, kind, 'queued', (delivery, grant, stored, { grants, jobs }) => {
      if (!canRoute(grant, stored, kind) || retainedSlot(Object.values(jobs), stored, kind, grants)) return noChange(false)
      delivery.startSeq = agent.session.seq
      delete delivery.retryAt
      setDelivery(delivery, 'sending')
      return success(true)
    })
    if (!ready) return
    const { id } = deliveryOf(job, kind)
    try {
      waking.add(id)
      publishDelivery(job, kind, undefined, true)
      agent.followup({
        id, role: 'user',
        content: [{ type: 'text', text: wakeText(job, kind) }],
        source: {
          kind: 'agent-message', form: 'relay', senderSessionId: senderOf(job, kind),
          bridgeWorkflowKind: kind, bridgeWorkflowId: job.id,
          ...(kind === 'result' && job.nativeResult ? { bridgeWorkflowOwner: job.owner } : {}),
          ...(job.conversation ? { bridgeWorkflowTask: job.key.slice(job.owner.length + 1) } : {}),
        },
      })
      if (await bounded(() => ctx.sessions.flush(agent.session)) && !signal.aborted) {
        checkpoint(job, kind, 'sending', 'admitted')
        return
      }
    } catch {
      // A throw can follow host admission. Reconcile by ID without resending.
    }
    if (!signal.aborted) checkpoint(job, kind, 'sending', 'sending', 'host_delivery_unconfirmed')
  }

  async function reconcile(job, kind) {
    const { id, state, updatedAt } = deliveryOf(job, kind)
    if (state === 'claimed') {
      if (claimedHere.has(job.id)) return
      if (job.conversation) {
        const proof = await bounded((deadline) => hostEvidence(ctx, job, kind, deadline)).catch(() => undefined)
        if (proof?.admissions === 1 && proof.consumptions === 1 && !proof.mixedTurn &&
            proof.turn === job.claim.turn && proof.endReason === 'completed') {
          claimedHere.add(job.id)
          return
        }
      }
      checkpoint(job, kind, state, 'uncertain', 'execution_interrupted_after_claim')
      return
    }
    const to = receiverOf(job, kind)
    const live = ctx.agents.get(to)
    if (waking.has(id) && (live?.status === 'running' || Date.now() - updatedAt < 2000)) return
    let expected = state
    let failure = 'host_evidence_unavailable'
    try {
      if (live && kind === 'result' && job.nativeResult) {
        if (live.status === 'running') return
        await bounded(() => ctx.sessions.flush(live.session))
      }
      const evidence = await bounded((deadline) => hostEvidence(ctx, job, kind, deadline))
      if (signal.aborted) return
      if (kind === 'result' && job.nativeResult && evidence.consumptions) {
        if (settleNativeResult(job, expected, evidence)) return
        const reason = evidence.mixedTurn ? 'mixed_turn'
          : evidence.endReason && evidence.endReason !== 'completed' ? evidence.endReason : 'host_consumed_without_handshake'
        checkpoint(job, kind, expected, 'uncertain', reason)
        return
      }
      if (evidence.admissions !== 1 || evidence.consumptions !== 0 || !evidence.pending) {
        checkpoint(job, kind, expected, 'uncertain', evidence.consumptions
          ? 'host_consumed_without_handshake' : 'host_admission_not_proven_pending')
        return
      }
      if (state === 'sending') {
        if (!checkpoint(job, kind, expected, 'admitted', 'recovered_native_pending')) return
        expected = 'admitted'
      }
      const grant = ledger.read().grants[job.key]
      if (!canRoute(grant, job, kind)) {
        if (kind === 'result' && job.nativeResult && stateOf(grant) === 'expired') {
          checkpoint(job, kind, expected, 'skipped', 'expired')
        }
        return
      }
      failure = 'destination_resolution_failed_after_admission'
      const { agent } = await bounded(() => ctx.sessionController.resolveAgent(to))
      if (signal.aborted) return
      if (!agent || ctx.agents.get(to) !== agent) {
        checkpoint(job, kind, expected, 'uncertain', failure)
        return
      }
      if (agent.status !== 'idle') return
      const after = ledger.read()
      if (after.jobs[job.id] && deliveryOf(after.jobs[job.id], kind)?.state === 'admitted' &&
          canRoute(after.grants[job.key], job, kind)) {
        const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
        if (pending.length !== 1 || !isWake(job, kind, pending[0]) || turns.has(to)) {
          checkpoint(job, kind, expected, 'uncertain', 'recovered_inbox_conflict')
          return
        }
        failure = 'native_pending_wake_failed'
        // Wake the durable inbox entry without issuing followup() again.
        agent.wakeDriver()
        waking.add(id)
      }
    } catch {
      if (!signal.aborted) checkpoint(job, kind, expected, 'uncertain', failure)
    }
  }

  function settleNativeResult(job, expected, evidence) {
    if (evidence.admissions !== 1 || evidence.consumptions !== 1 || evidence.mixedTurn ||
        evidence.endReason !== 'completed' || !Number.isFinite(evidence.endTime) ||
        !Number.isSafeInteger(evidence.turn)) return false
    return updateDelivery(job, 'result', expected, (resume, grant, stored) => {
      const status = stateOf(grant, evidence.endTime)
      if (!isDirectGrant(grant) || !stored.report || stored.report.late || !enabled() ||
          !available(stored.owner) || !available(stored.target) ||
          (status !== 'active' && !(status === 'paused' && stored.report.status === 'needs_owner'))) return noChange(false)
      setDelivery(resume, 'consumed')
      resume.consumedTurn = evidence.turn
      resume.handoffAt = evidence.endTime
      resume.continuation = { state: 'verified', turn: evidence.turn, at: evidence.endTime,
        settledAt: Date.now(), dispatches: [], presentation: 'native-result' }
      if (stored.report.status === 'completed' && status === 'active') closeDirect(grant, stored, evidence.endTime, evidence.turn)
      return success(true)
    })
  }

  function closeDirect(grant, job, time, turn) {
    grant.state = 'closed'
    grant.closedAt = time
    grant.closedTurn = turn
    grant.outcome = { status: 'completed', summary: job.report.summary, finalArtifacts: [] }
  }

  async function finishOwnerAdmission(job) {
    const proof = job.ownerAdmission
    if (turns.get(job.owner)?.startSeq === proof.startSeq) return
    const live = ctx.agents.get(job.owner)
    let end
    let targetMatches = false
    try {
      if (Number.isSafeInteger(proof.endSeq)) {
        if (live) await bounded(() => ctx.sessions.flush(live.session))
        end = closeTurnEvidence(await bounded((deadline) => hostEvents(ctx, job.owner, proof.startSeq, deadline)), proof)
        if (end?.reason === 'completed' && end.sequence === proof.endSeq) {
          const grant = ledger.read().grants[job.key]
          const title = grant?.authorization?.targets?.[0]?.title
          const { items } = await bounded((deadline) => ctx.sessionController.list({}, deadline))
          const matches = matchingTitles(items, title, () => true)
          targetMatches = matches.length === 1 && matches[0].to === job.target && matches[0].title === title &&
            await bounded((deadline) => existing(job.target, deadline))
        }
      }
    } catch {
      // Unverified owner or target evidence fails closed before host admission.
    }
    if (signal.aborted) return
    updateDelivery(job, 'task', 'queued', (wake, grant, stored) => {
      if (stateOf(grant) !== 'authorizing') return noChange()
      delete stored.ownerAdmission
      const currentOwner = ctx.agents.get(job.owner)
      if (targetMatches && enabled() && available(job.owner) && available(job.target) &&
          !turns.has(job.owner) && (!currentOwner || cleanInbox(currentOwner))) {
        grant.authorization.ownerTurnEnd = end
        setGrantState(grant, 'active')
      } else {
        setDelivery(wake, 'skipped', 'owner_turn_not_verified')
        setGrantState(grant, 'paused')
      }
      return success()
    })
  }

  async function ownerReconcile(owner, turn, message, task, id, kind, reason) {
    const key = taskKey(owner, task)
    const canReviewContinuation = (grant, item) => grant?.collaboration && kind === 'result' &&
      item?.state === 'consumed' && item.continuation?.state === 'interrupted' && !item.continuation.reconciliation
    try {
      const state = ledger.read()
      const job = jobFor(state.jobs, id)
      const delivery = job && deliveryOf(job, kind)
      const continuation = canReviewContinuation(grantFor(state.grants, key), delivery)
      if (job?.key !== key || job.owner !== owner || delivery?.state !== 'uncertain' && !continuation) return false
      let evidence = { state: 'host_call_not_started' }
      if (Number.isSafeInteger(delivery.startSeq)) {
        try {
          const observed = await bounded((deadline) => hostEvidence(ctx, job, kind, deadline))
          evidence = { state: 'observed', ...observed }
        } catch {
          evidence = { state: 'unavailable' }
        }
      }
      if (signal.aborted || !available(owner) || turns.get(owner) !== turn || turn.mixed) return false
      const result = ledger.change(({ jobs, grants }, archive) => {
        const stored = jobFor(jobs, id)
        const item = stored && deliveryOf(stored, kind)
        if (stored?.key !== key || stored.owner !== owner) return noChange(false)
        if (continuation ? !canReviewContinuation(grantFor(grants, key), item) : item?.state !== 'uncertain') {
          return noChange(false)
        }
        const record = {
          decision: continuation ? 'reviewed_without_replay' : 'release_without_replay',
          previousReason: (continuation ? item.continuation.reason : item.reason) ?? null, reason,
          owner, ownerMessageId: message.id, ownerRpcId: message.source.rpcId, ownerTurn: turn.number,
          at: Date.now(), evidence,
        }
        if (continuation) item.continuation.reconciliation = record
        else {
          item.reconciliation = record
          setDelivery(item, 'reconciled')
        }
        if (jobs[id]) return success(true)
        archive.job(stored)
        return noChange(true)
      })
      schedule()
      return result
    } catch {
      if (!signal.aborted) ctx.logger.warn('workflow reconciliation could not be recorded')
      return false
    }
  }

  async function finishContinuation(job) {
    const started = job.resume.continuation
    const live = ctx.agents.get(job.owner)
    if (turns.get(job.owner)?.number === started.turn ||
        (live?.status === 'running' && !turns.has(job.owner))) return
    let evidence
    try {
      if (live) await bounded(() => ctx.sessions.flush(live.session))
      evidence = await bounded((deadline) => hostEvidence(ctx, job, 'result', deadline))
    } catch {
      // Missing evidence is recorded conservatively after the host boundary.
    }
    if (signal.aborted) return
    ledger.change(({ grants, jobs }, archive) => {
      const stored = jobs[job.id]
      if (!stored) return noChange()
      const issue = continuationIssue(stored.resume)
      if (issue) {
        quarantineContinuation(stored, issue, jobs, archive)
        return success()
      }
      const continuation = stored.resume?.continuation
      if (continuation?.state !== 'started' || continuation.turn !== started.turn) return noChange()
      const exactTurn = evidence?.turn === continuation.turn && evidence.consumptions === 1
      if (exactTurn && evidence.endReason === 'completed' && !evidence.mixedTurn) {
        const grant = grants[stored.key]
        const endTime = stored.nativeResult ? evidence.endTime : evidence.replyEndTime
        if (pendingDirectCompletion(grant, stored) &&
            enabled() && available(stored.owner) && endTime < grant.expiresAt) {
          // Verify the native reply and close the one-shot grant in the same
          // transaction. Explicit close and historical proofs remain separate.
          closeDirect(grant, stored, endTime, continuation.turn)
        }
        continuation.state = 'verified'
      } else {
        continuation.state = 'interrupted'
        continuation.phase = continuation.dispatches.length ? 'after_dispatch' : 'before_dispatch'
        continuation.reason = !exactTurn ? 'turn_evidence_unavailable'
          : evidence.endReason === 'completed' && evidence.mixedTurn ? 'mixed_turn'
            : evidence.endReason ?? 'turn_end_not_proven'
      }
      continuation.settledAt = Date.now()
      return success()
    })
  }

  async function finishClosure(key, grant) {
    const requested = grant.closure
    const observed = turns.get(grant.owner)
    const live = ctx.agents.get(grant.owner)
    if (observed?.startSeq === requested.startSeq || live?.status === 'running' && !observed) return
    let evidence
    try {
      if (live) await bounded(() => ctx.sessions.flush(live.session))
      const anchor = requested.after && jobFor(ledger.read().jobs, requested.after)
      if (!requested.after || anchor?.key === key && anchor.owner === grant.owner) {
        const events = await bounded((deadline) => hostEvents(ctx, grant.owner, requested.startSeq, deadline))
        evidence = closeTurnEvidence(events, requested, anchor)
      }
    } catch {
      // Missing durable evidence leaves the request uncommitted.
    }
    if (signal.aborted) return
    ledger.change(({ grants, jobs }) => {
      const stored = grants[key]
      const closure = stored?.closure
      if (stored?.state !== 'collaboration_closing' || closure?.state !== 'pending' ||
          closure.startSeq !== requested.startSeq) return noChange()
      const continuation = closure.after && jobFor(jobs, closure.after)?.resume?.continuation
      if (continuation?.state === 'started') return noChange()
      const permitted = enabled() && available(stored.owner)
      const verified = !closure.after || continuation?.state === 'verified' && continuation.turn === closure.turn
      const completed = evidence?.reason === 'completed' && evidence.time < stored.expiresAt && permitted && verified
      closure.settledAt = Date.now()
      if (evidence) closure.turnEnd = evidence
      if (completed) {
        closure.state = 'committed'
        stored.state = 'closed'
        stored.outcome = closure.requestedOutcome
        stored.closedAt = evidence.time
        stored.closedTurn = closure.turn
      } else if (stateOf(stored) === 'expired') {
        closure.state = 'expired'
        stored.state = 'expired'
      } else {
        closure.state = 'interrupted'
        closure.reason = !permitted ? 'close_authority_unavailable' : !evidence ? 'close_turn_evidence_unavailable'
          : evidence.reason !== 'completed' ? evidence.reason : 'close_continuation_unverified'
        setGrantState(stored, 'paused')
      }
      return success()
    })
  }

  const deliveryStates = new Set(['queued', 'sending', 'admitted', 'claimed', 'reported', 'consumed',
    'uncertain', 'failed', 'skipped', 'reconciled'])
  const validDelivery = (value) => value && UUID.test(value.id ?? '') && deliveryStates.has(value.state)

  function archiveJob(job, jobs, archive) {
    const { id, key, item, attempt } = job
    const duplicate = ledger.history.attempt(key, item, attempt)
    if (duplicate && duplicate.id !== id) {
      archive.badJob(id, key, { id, reason: 'duplicate_attempt_binding', record: job })
    } else {
      archive.job(job)
    }
    delete jobs[id]
    waking.delete(job.wake.id)
    if (job.resume) waking.delete(job.resume.id)
    claimedHere.delete(id)
  }

  function quarantineContinuation(job, reason, jobs, archive) {
    const record = job.resume.continuation
    // Keep delivery/consumption identity and exact attempt binding in history.
    // The original nested value remains evidence, with no completion inferred.
    job.resume.continuation = {
      state: 'quarantined', reason, at: Date.now(),
      ...(record !== undefined ? { record } : {}),
    }
    archiveJob(job, jobs, archive)
  }

  function prepareBatchResults(grants, jobs) {
    let changed = false
    for (const grant of Object.values(grants)) {
      if (!grant.collaboration || !['active', 'paused'].includes(stateOf(grant))) continue
      for (const batch of grant.batches) {
        if (batch.anchor) continue
        const members = batchMembers(grant, batch, jobs)
        if (!members?.length || !members.every((job) => batchSettled.has(job.wake.state))) continue
        // Keep one native result handshake for the immutable membership. All
        // members still have their own delivery, claim, and report evidence.
        const anchor = members.find((job) => jobs[job.id])
        if (!anchor) continue
        batch.anchor = anchor.id
        anchor.resume = { id: randomUUID(), state: 'queued', updatedAt: Date.now() }
        if (members.some((job) => job.wake.state === 'uncertain' || job.report?.late || job.report?.status === 'needs_owner')) {
          setGrantState(grant, 'paused')
        }
        changed = true
      }
    }
    return changed
  }

  function compact() {
    const now = Date.now()
    return ledger.change((state, archive) => {
      const { grants, jobs } = state
      const pendingDirect = new Set()
      for (const job of Object.values(jobs)) {
        const grant = grants[job?.key]
        if (stateOf(grant, now) !== 'expired') continue
        if (pendingDirectCompletion(grant, job) && turns.get(job.owner)?.number !== job.resume.continuation.turn ||
            job.nativeResult && sent(job.resume) && Number.isSafeInteger(job.resume.startSeq) && enabled()) {
          pendingDirect.add(job.key)
        }
      }
      let changed = false
      for (const [key, grant] of Object.entries(grants)) {
        const status = stateOf(grant, now)
        if (grant.state === 'collaboration_closing' && grant.closure?.state === 'pending') {
          // Recovery can still commit a turn that ended before expiry. A
          // currently open closing turn has no earlier end to recover.
          if (status !== 'expired' || turns.get(grant.owner)?.startSeq !== grant.closure.startSeq) continue
          Object.assign(grant.closure, { state: 'expired', settledAt: now })
        }
        if (!terminal(status)) continue
        // Keep the expired grant only until the scanner can check whether the
        // consumed result already ended before expiry. Routing still sees expired.
        if (pendingDirect.has(key)) continue
        grant.state = status
        archive.grant(key, grant)
        delete grants[key]
        changed = true
      }
      for (const [id, job] of Object.entries(jobs)) {
        const ownerKey = validId(job?.owner) && typeof job.key === 'string' &&
          job.key.startsWith(job.owner + ':') && validId(job.key.slice(job.owner.length + 1))
        if (!ownerKey || job.id !== id || !UUID.test(id) || !validId(job.target) || !validId(job.item) ||
            !Number.isInteger(job.attempt) || job.attempt < 1 || job.attempt > 8 ||
            !validDelivery(job.wake) || (job.resume && !validDelivery(job.resume))) {
          archive.badJob(id, ownerKey ? job.key : null, { id, reason: 'invalid_job_record', record: job })
          delete jobs[id]
          changed = true
          continue
        }
        const issue = continuationIssue(job.resume)
        if (issue) {
          quarantineContinuation(job, issue, jobs, archive)
          changed = true
          continue
        }
        const grant = grantFor(grants, job.key)
        const status = stateOf(grant, now)
        if (grant?.collaboration && status === 'active' && enabled() &&
            job.wake.state === 'queued' && available(job.owner) && !available(job.target)) {
          setDelivery(job.wake, 'failed', 'route_unavailable_before_send')
          changed = true
        }
        if (job.resume?.state === 'consumed' && job.resume.continuation === undefined) {
          job.resume.continuation = { state: 'legacy_unverified', turn: job.resume.consumedTurn }
          changed = true
        }
        if (status === 'missing_grant' && !job.quarantine) {
          job.quarantine = {
            reason: status, at: now,
            taskHadHostRisk: unresolved(job.wake) || job.wake.state === 'claimed',
            resultHadHostRisk: unresolved(job.resume),
          }
          for (const delivery of [job.wake, job.resume]) {
            if (delivery && (delivery.state === 'queued' || sent(delivery) || delivery.state === 'claimed')) {
              setDelivery(delivery, 'uncertain', status)
            }
          }
          changed = true
        }
        const terminalJob = terminal(status) &&
          !(status === 'expired' && pendingDirect.has(job.key) && job.nativeResult && sent(job.resume))
        if (terminalJob) {
          for (const delivery of [job.wake, job.resume]) {
            if (delivery && (delivery.state === 'queued' || sent(delivery))) {
              delivery.stoppedFrom = delivery.state
              setDelivery(delivery, 'skipped', status)
              changed = true
            }
          }
        }
        const liveClaim = job.wake.state === 'claimed'
        const liveContinuation = job.resume?.continuation?.state === 'started'
        const taskDone = ['reported', 'failed', 'skipped', 'reconciled'].includes(job.wake.state)
        const resultDone = !job.resume || ['consumed', 'failed', 'skipped', 'reconciled'].includes(job.resume.state)
        const batchWaiting = job.batch && !terminal(status) && !batchOf(grant, job.batch)?.anchor
        const orphanReleased = status === 'missing_grant' &&
          (!job.quarantine.taskHadHostRisk || job.wake.state !== 'uncertain') &&
          (!job.quarantine.resultHadHostRisk || job.resume?.state !== 'uncertain')
        if (!liveClaim && !liveContinuation && (terminalJob || (!batchWaiting && taskDone && resultDone) || orphanReleased)) {
          archiveJob(job, jobs, archive)
          changed = true
        }
      }
      return { changed: prepareBatchResults(grants, jobs) || changed, value: state }
    })
  }

  async function tick() {
    if (signal.aborted) return
    const { grants, jobs } = compact()
    const activeJobs = Object.values(jobs)
    const lanes = new Map()
    const add = (job, kind, work, priority) => {
      const recipient = receiverOf(job, kind)
      if ((lanes.get(recipient)?.priority ?? -1) >= priority) return
      lanes.set(recipient, { priority, job, kind, work })
    }
    for (const job of activeJobs) {
      if (job.ownerAdmission && stateOf(grants[job.key]) === 'authorizing' &&
          turns.get(job.owner)?.startSeq !== job.ownerAdmission.startSeq) add(job, 'task', finishOwnerAdmission, 4)
      if (job.resume?.continuation?.state === 'started') {
        const observed = turns.get(job.owner)
        if (observed?.number !== job.resume.continuation.turn) add(job, 'result', finishContinuation, 3)
      }
      for (const kind of ['task', 'result']) {
        const delivery = deliveryOf(job, kind)
        if (delivery?.state === 'claimed' && (!job.conversation || !claimedHere.has(job.id)) ||
            sent(delivery) && enabled()) {
          add(job, kind, reconcile, 1)
        } else if (delivery?.state === 'queued' && (delivery.retryAt ?? 0) <= Date.now() &&
            canRoute(grants[job.key], job, kind) &&
            !retainedSlot(activeJobs, job, kind, grants)) {
          add(job, kind, send, 0)
        }
      }
    }
    for (const [key, grant] of Object.entries(grants)) {
      const closure = grant.closure
      if (grant.state !== 'collaboration_closing' || closure?.state !== 'pending' ||
          turns.get(grant.owner)?.startSeq === closure.startSeq ||
          (lanes.get(grant.owner)?.priority ?? -1) >= 2) continue
      lanes.set(grant.owner, { priority: 2, close: { key, grant } })
    }
    await Promise.all([...lanes.values()].map(async ({ job, kind, work, close }) => {
      if (close) {
        try { await finishClosure(close.key, close.grant) } catch {
          if (!signal.aborted) ctx.logger.warn('workflow close evidence could not be recorded')
        }
        return
      }
      try {
        await work(job, kind)
      } catch {
        if (signal.aborted) return
        try {
          if (work === send && checkpoint(job, kind, 'queued', 'failed', 'destination_inspection_failed_before_send')) return
          for (const state of ['sending', 'admitted']) {
            if (checkpoint(job, kind, state, 'uncertain', 'host_operation_failed')) return
          }
        } catch {
          // Storage-level faults are reported without logging task contents.
        }
        ctx.logger.warn('workflow lane failed for ' + job.id + '/' + kind)
      }
    }))
  }

  function schedule() {
    if (!readyToDrive || driver || signal.aborted) return
    driver = Promise.resolve().then(tick).catch(() => {
      if (!signal.aborted) ctx.logger.warn('workflow ledger or dispatcher failed')
    }).finally(() => { driver = undefined })
  }

  ctx.effect(() => {
    let timer
    const start = () => {
      readyToDrive = true
      timer = setInterval(schedule, 750)
      timer.unref()
      schedule()
    }
    const ready = ctx.get('appReady')
    const cancel = ready?.onReady(start)
    if (!ready) start()
    return async () => {
      lifetime.abort()
      cancel?.()
      clearInterval(timer)
      await driver
      ledger.close()
    }
  }, 'dsh-session-bridge workflow ledger and dispatcher')
  return { queueMessage }
}
