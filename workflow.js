import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { openLedger } from './workflow-ledger.js'

const ID = /^[a-zA-Z0-9_-]{1,128}$/
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const validId = (value) => typeof value === 'string' && ID.test(value)
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const maxGrants = 128
const maxJobs = 512
const maxPerGrant = 32
const statuses = ['completed', 'approved', 'changes_requested', 'failed', 'needs_owner']
const control = /^授权委托\r?\n([\s\S]+)$/
const review = /^对账委托 ([a-zA-Z0-9_-]{1,128}) ([a-f0-9-]{36}) (task|result)\r?\n([\s\S]+)$/
const action = /^(取消委托|继续委托) ([a-zA-Z0-9_-]{1,128})$/
const taskKey = (owner, task) => owner + ':' + task
const success = (value) => ({ changed: true, value })
const noChange = (value) => ({ changed: false, value })
const denied = (error) => ({ error })
const idSchema = { type: 'string', pattern: ID.source, maxLength: 128 }
const uuidSchema = { type: 'string', pattern: UUID.source }
const textSchema = (maxLength) => ({ type: 'string', minLength: 1, maxLength })
const attemptSchema = { type: 'integer', minimum: 1, maximum: 8 }
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

function plainText(message) {
  return message.content?.length === 1 && message.content[0]?.type === 'text'
    ? message.content[0].text : undefined
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

function isWake(job, kind, message) {
  const source = message.source
  return message.id === deliveryOf(job, kind)?.id && message.role === 'user' &&
    source?.kind === 'agent-message' && source.form === 'relay' &&
    source.senderSessionId === senderOf(job, kind) &&
    source.bridgeWorkflowKind === kind && source.bridgeWorkflowId === job.id
}

function stateOf(grant, now = Date.now()) {
  if (!grant) return 'missing_grant'
  if (grant.state !== 'active' && grant.state !== 'paused') return grant.state
  return now >= grant.expiresAt ? 'expired' : grant.state
}

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

function jobView(job) {
  const { id, item, attempt, scope, target, after, instructions, acceptance, wake, claim, report, resume } = job
  return {
    id, item, attempt, scope, target, after, instructions, acceptance,
    delivery: wake,
    ...(job.quarantine ? { quarantine: job.quarantine } : {}),
    ...(claim ? { claim: { turn: claim.turn, messageId: claim.messageId, at: claim.at } } : {}),
    ...(report ? { report } : {}),
    ...(resume ? { continuation: resume } : {}),
  }
}

// Exact durable host evidence. A matching ID in arbitrary text is irrelevant.
async function hostEvidence(ctx, job, kind, signal) {
  const handle = await ctx.sessionPersistence.open(receiverOf(job, kind), 'read', { signal })
  try {
    const limit = 20_000
    const { events } = await handle.read(deliveryOf(job, kind).startSeq, limit, { signal })
    if (events.length === limit) throw new Error('Recovery evidence exceeds the scan bound')
    const queues = { 'next-turn': [], 'next-step': [] }
    let admissions = 0
    let consumptions = 0
    let turn
    let matchedTurn
    let endReason
    for (const { type, data } of events) {
      if (type === 'turn/start') turn = data.turn
      if (type === 'agent/inbox/spliced') {
        queues[data.target].splice(data.start, data.removedCount ?? 0, ...data.inserted)
        admissions += data.inserted.filter((message) => isWake(job, kind, message)).length
      }
      if (type === 'user/message' && isWake(job, kind, data)) {
        consumptions++
        if (consumptions === 1) matchedTurn = turn
      }
      if (type === 'turn/end' && data.turn === matchedTurn && endReason === undefined) endReason = data.reason.kind
    }
    return {
      pending: Object.values(queues).flat().some((message) => isWake(job, kind, message)),
      admissions,
      consumptions,
      ...(matchedTurn !== undefined ? { turn: matchedTurn } : {}),
      ...(endReason !== undefined ? { endReason } : {}),
    }
  } finally {
    await handle.close()
  }
}

export function applyWorkflow(ctx, config, allowed) {
  if (lstatSync(join(ctx.profileContext.dir, 'session-bridge-workflow'), { throwIfNoEntry: false })) {
    throw new Error('dsh-session-bridge: migrate the legacy workflow directory with DSH stopped before enabling delegation')
  }
  const ledger = openLedger(join(ctx.profileContext.dir, 'dsh-session-bridge-workflow'))
  const lifetime = new AbortController()
  const signal = lifetime.signal
  const turns = new Map()
  const waking = new Set()
  const claimedHere = new Set()
  let driver
  let readyToDrive = false

  const enabled = () => !signal.aborted && config.workflowEnabled.get()
  const available = (id) => allowed(id)
  const activeGrant = (grant) => stateOf(grant) === 'active'
  const grantFor = (grants, key) => grants[key] ?? ledger.history.grant(key)
  const jobFor = (jobs, id) => jobs[id] ?? ledger.history.job(id)
  const canRoute = (grant, job, kind) => enabled() && available(job.owner) && available(job.target) &&
    (activeGrant(grant) || (kind === 'result' && stateOf(grant) === 'paused' && job.report?.status === 'needs_owner'))

  async function existing(id, requestSignal) {
    if (!available(id)) return false
    const stored = await ctx.sessionPersistence.stat(id, { signal: requestSignal })
    return Boolean(stored?.sizeBytes && stored.header.cwd &&
      stored.header.origin !== 'subagent' && !stored.header.parentSession)
  }

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
          if (!grant || !['active', 'paused'].includes(stateOf(grant))) return noChange()
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
        if (grant.state === 'paused') grant.state = 'active'
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
      return ledger.change(({ grants, jobs }) => {
        const known = grantFor(grants, key) || ledger.history.jobCount(key) || ledger.history.hasQuarantined(key) ||
          Object.values(jobs).some((job) => job.key === key)
        if (known || Object.keys(grants).length >= maxGrants) return noChange(false)
        grants[key] = {
          task: input.task, owner, goal: input.goal, scopes: input.scopes,
          expiresAt: now + input.ttlMinutes * 60_000, state: 'active',
          openedAt: now, ownerMessageId: messageId, ownerTurn: turn.number,
        }
        return success(true)
      })
    } catch {
      if (!signal.aborted) ctx.logger.warn('workflow grant could not be validated')
      return false
    }
  }

  function workflowInput(session, message) {
    const { bridgeWorkflowId: id, bridgeWorkflowKind: kind } = message.source ?? {}
    if (!UUID.test(id ?? '') || (kind !== 'task' && kind !== 'result')) return
    const job = jobFor(ledger.read().jobs, id)
    if (!job || receiverOf(job, kind) !== session.id || !isWake(job, kind, message)) return
    return { mode: kind, id, messageId: message.id }
  }

  ctx.on('session/event', (session, event) => {
    if (signal.aborted) return
    try {
      if (!available(session.id)) {
        turns.delete(session.id)
        return
      }
      if (event.type === 'turn/start') {
        turns.set(session.id, { number: event.data.turn, context: null, mixed: false, wakes: [] })
        return
      }
      const turn = turns.get(session.id)
      if (!turn) return
      if (event.type === 'user/message') {
        const source = event.data.source
        if (source?.kind === 'runtime-context') return
        const wake = source?.kind === 'agent-message' ? workflowInput(session, event.data) : undefined
        if (wake) {
          turn.wakes.push(wake)
          if (wake.mode === 'result') ledger.change(({ jobs }) => {
            const resume = jobs[wake.id]?.resume
            if (!sent(resume) || resume.hostTurn) return noChange()
            resume.hostTurn = { turn: turn.number, messageId: event.data.id, at: Date.now() }
            return success()
          })
        }
        // Mixed native or relay inputs never share workflow authority.
        if (turn.context) turn.mixed = true
        if (!turn.mixed) turn.context = wake ?? controlInput(session, turn, event.data)
        // A native owner cancellation still applies even in a mixed turn.
        else if (nativeOwner(event.data) && /^取消委托 /.test(plainText(event.data) ?? '')) {
          controlInput(session, turn, event.data)
        }
        return
      }
      if (event.type !== 'turn/end' || event.data.turn !== turn.number) return
      turns.delete(session.id)
      ledger.change(({ jobs }) => {
        let changed = false
        for (const wake of turn.wakes) {
          const job = jobs[wake.id]
          if (!job) continue
          const delivery = deliveryOf(job, wake.mode)
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

  function register(name, description, properties, execute) {
    ctx.tools.register({
      name: 'workflow_' + name,
      description,
      parameters: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties },
      output,
      execute(args, exec) {
        const caller = current(exec)
        if (!caller) return denied('workflow_context_required')
        return execute(args, exec, caller)
      },
    })
  }

  register('dispatch',
    'Delegate to an existing session under this turn’s authorized workflow task. Use item and attempt for idempotency. A retry attempt requires the earlier result to have been consumed. Use the exact owner-approved scope and target.',
    { task: idSchema, item: idSchema, attempt: attemptSchema, target: idSchema, scope: idSchema, instructions: textSchema(4000), acceptance: textSchema(1500) },
    async (args, exec, caller) => {
      const { id, turn, context } = caller
      const { task, item, attempt, target, scope, instructions, acceptance } = args
      const key = taskKey(id, task)
      if (!enabled()) return denied('workflow_disabled')
      if ((context.mode !== 'authorize' && context.mode !== 'main') || context.key !== key) return denied('main_task_context_required')
      if (!validId(task) || !validId(item) || !validId(scope) || !validId(target) ||
          !Number.isInteger(attempt) || attempt < 1 || attempt > 8 ||
          !validText(instructions, 4000) || !validText(acceptance, 1500)) return denied('invalid_dispatch')
      if (context.pending && !await context.pending) return denied('grant_not_opened')
      const grant = ledger.read().grants[key]
      if (!grant || !activeGrant(grant)) return denied('grant_inactive')
      if (target === id || !grant.scopes.find(({ name }) => name === scope)?.targets.includes(target)) return denied('scope_or_target_denied')
      if (!await existing(target, exec.signal)) return denied('existing_target_required')
      if (current(exec)?.turn !== turn || turn.context !== context || !enabled()) return denied('main_task_context_required')
      compact()
      const result = ledger.change(({ grants, jobs }) => {
        if (!activeGrant(grants[key]) || !available(target)) return noChange(denied('grant_inactive'))
        const sameGrant = Object.values(jobs).filter((job) => job.key === key)
        const findAttempt = (number) => sameGrant.find((job) => job.item === item && job.attempt === number) ??
          ledger.history.attempt(key, item, number)
        if (ledger.history.quarantinedAttempt(key, item, attempt)) return noChange(denied('attempt_quarantined'))
        const same = findAttempt(attempt)
        if (same) {
          const exact = same.target === target && same.scope === scope && same.instructions === instructions && same.acceptance === acceptance
          return noChange(exact ? { id: same.id, duplicate: true } : denied('attempt_conflict'))
        }
        const previous = attempt > 1 ? findAttempt(attempt - 1) : undefined
        if (attempt > 1 && (previous?.target !== target || previous.scope !== scope || previous.resume?.state !== 'consumed')) {
          return noChange(denied('previous_attempt_not_consumed'))
        }
        if (sameGrant.length >= maxPerGrant || Object.keys(jobs).length >= maxJobs) return noChange(denied('ledger_limit'))
        const jobId = randomUUID()
        if (context.after) {
          const continuation = jobs[context.after]?.resume?.continuation
          if (continuation?.state !== 'started' || continuation.turn !== turn.number) return noChange(denied('continuation_not_active'))
          continuation.dispatches.push(jobId)
        }
        jobs[jobId] = {
          id: jobId, key, owner: id, target, item, attempt, scope, instructions, acceptance,
          after: context.after ?? null, dispatchedTurn: turn.number, createdAt: Date.now(),
          wake: { id: randomUUID(), state: 'queued', updatedAt: Date.now() },
        }
        return success({ id: jobId, state: 'queued', duplicate: false })
      })
      schedule()
      return result
    })

  register('claim',
    'When this turn receives DSH-WORKFLOW TASK <id>, call once to claim the task and get its instructions, attempt number and claim token. Do not execute on a duplicate or rejected claim.',
    { id: uuidSchema },
    ({ id }, _exec, caller) => {
      const { context, turn } = caller
      if (context.mode !== 'task' || context.id !== id) return denied('task_wake_required')
      const result = ledger.change(({ grants, jobs }) => {
        const job = jobFor(jobs, id)
        if (!job) return noChange(denied('task_wake_required'))
        if (job.claim) return noChange({ id, duplicate: true })
        const grant = grants[job.key]
        if (!canRoute(grant, job, 'task') || !jobs[id]) return noChange(denied('grant_inactive'))
        if (!sent(job.wake)) return noChange(denied('delivery_not_claimable'))
        const token = randomUUID()
        job.claim = { token, turn: turn.number, messageId: context.messageId, at: Date.now() }
        setDelivery(job.wake, 'claimed')
        return success({
          id, task: grant.task, goal: grant.goal, item: job.item, attempt: job.attempt,
          owner: job.owner, scope: job.scope, instructions: job.instructions, acceptance: job.acceptance,
          expiresAt: grant.expiresAt, token, duplicate: false,
        })
      })
      if (result.duplicate === false) claimedHere.add(id)
      return result
    })

  register('report',
    'Submit the structured result in the exact turn that claimed the task. Use its id, attempt and claim token. Include concrete evidence references for an approved or returned review. Closing a turn without this tool does not report completion.',
    {
      id: uuidSchema, attempt: attemptSchema, token: uuidSchema,
      status: { type: 'string', enum: statuses },
      summary: textSchema(2400),
      evidence: { type: 'array', maxItems: 8, items: textSchema(300) },
    },
    ({ id, attempt, token, status, summary, evidence }, _exec, caller) => {
      const { context, turn } = caller
      if (context.mode !== 'task' || context.id !== id) return denied('task_wake_required')
      if (!statuses.includes(status) || !validText(summary, 2400) || !Array.isArray(evidence) ||
          evidence.length > 8 || !evidence.every((entry) => validText(entry, 300)) ||
          (['approved', 'changes_requested'].includes(status) && evidence.length === 0)) return denied('invalid_report')
      const result = ledger.change(({ grants, jobs }) => {
        const job = jobFor(jobs, id)
        const claim = job?.claim
        if (!claim || job.attempt !== attempt || claim.token !== token ||
            claim.turn !== turn.number || claim.messageId !== context.messageId) return noChange(denied('claim_mismatch'))
        if (job.report) {
          const exact = job.report.status === status && job.report.summary === summary &&
            JSON.stringify(job.report.evidence) === JSON.stringify(evidence)
          return noChange(exact ? { id, recorded: true, duplicate: true, late: job.report.late } : denied('report_conflict'))
        }
        if (!jobs[id] || job.wake.state !== 'claimed') return noChange(denied('claim_not_active'))
        const grant = grants[job.key]
        const late = !enabled() || !available(job.owner) || !available(job.target) ||
          !['active', 'paused'].includes(stateOf(grant))
        job.report = { status, summary, evidence, reporter: caller.id, turn: turn.number, at: Date.now(), late }
        setDelivery(job.wake, 'reported')
        if (!late) {
          job.resume = { id: randomUUID(), state: 'queued', updatedAt: Date.now() }
          if (status === 'needs_owner') grant.state = 'paused'
        }
        return success({ id, recorded: true, duplicate: false, late })
      })
      schedule()
      return result
    })

  register('consume',
    'When this turn receives DSH-WORKFLOW RESULT <id>, read the structured result once. Only a successful consume opens the original task in this turn for further dispatch or close.',
    { id: uuidSchema },
    ({ id }, _exec, caller) => {
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
        const issue = continuationIssue(job.resume)
        if (issue) {
          quarantineContinuation(job, issue, jobs, archive)
          return success(denied('result_not_consumable'))
        }
        setDelivery(job.resume, 'consumed')
        job.resume.consumedTurn = turn.number
        job.resume.handoffAt = Date.now()
        job.resume.continuation = { state: 'started', turn: turn.number, at: Date.now(), dispatches: [] }
        return success({ ...jobView(job), task: grant.task, goal: grant.goal, duplicate: false })
      })
      if (result.duplicate === false) turn.context = { mode: 'main', key: taskKey(caller.id, result.task), after: id }
      schedule()
      return result
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
      const { grants, jobs } = ledger.read()
      const grant = grantFor(grants, key)
      const rows = [...Object.values(jobs).filter((job) => job?.key === key), ...ledger.history.jobsFor(key)]
      const quarantined = ledger.history.quarantined(key).map(({ id, reason }) => ({ id, reason }))
      if (!grant && !rows.length && !quarantined.length) return denied('grant_not_found')
      rows.sort((a, b) => a.createdAt - b.createdAt)
      return {
        ...(grant ?? { task, owner: caller.id }), state: stateOf(grant), workflowEnabled: enabled(),
        jobs: rows.map(jobView), archivedJobs: ledger.history.jobCount(key), quarantined,
      }
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
      return { task, grantState: stateOf(grantFor(grants, key)), ...jobView(job) }
    })

  register('close',
    'Close a finished workflow task in its bound main turn, after all work and reports are settled. The native owner can cancel with 取消委托 <task>.',
    { task: idSchema },
    async ({ task }, exec, caller) => {
      const { id, turn, context } = caller
      const key = taskKey(id, task)
      if (!enabled() || (context.mode !== 'main' && context.mode !== 'authorize') || context.key !== key) return denied('main_task_context_required')
      if (context.pending && !await context.pending) return denied('grant_not_opened')
      if (current(exec)?.turn !== turn || turn.context !== context) return denied('main_task_context_required')
      return ledger.change(({ grants, jobs }) => {
        const grant = grants[key]
        if (!activeGrant(grant)) return noChange(denied('grant_inactive'))
        const unsettled = Object.values(jobs).some((job) => job.key === key &&
          (!['reported', 'failed', 'skipped', 'reconciled'].includes(job.wake.state) ||
            job.resume && !['consumed', 'failed', 'skipped', 'reconciled'].includes(job.resume.state)))
        if (unsettled) return noChange(denied('work_unsettled'))
        grant.state = 'closed'
        grant.closedAt = Date.now()
        grant.closedTurn = turn.number
        return success({ task, state: 'closed' })
      })
    })

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
          (unresolved(other.wake) || other.wake.state === 'claimed')) return true
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
      if (!signal.aborted) checkpoint(job, kind, 'queued', 'failed', 'destination_resolution_failed_before_send')
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
      setDelivery(delivery, 'sending')
      return success(true)
    })
    if (!ready) return
    const { id } = deliveryOf(job, kind)
    try {
      waking.add(id)
      agent.followup({
        id, role: 'user',
        content: [{ type: 'text', text: 'DSH-WORKFLOW ' + kind.toUpperCase() + ' ' + job.id }],
        source: {
          kind: 'agent-message', form: 'relay', senderSessionId: senderOf(job, kind),
          bridgeWorkflowKind: kind, bridgeWorkflowId: job.id,
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
      if (!claimedHere.has(job.id)) checkpoint(job, kind, state, 'uncertain', 'execution_interrupted_after_claim')
      return
    }
    const to = receiverOf(job, kind)
    const live = ctx.agents.get(to)
    if (waking.has(id) && (live?.status === 'running' || Date.now() - updatedAt < 2000)) return
    let expected = state
    let failure = 'host_evidence_unavailable'
    try {
      const evidence = await bounded((deadline) => hostEvidence(ctx, job, kind, deadline))
      if (signal.aborted) return
      if (evidence.admissions !== 1 || evidence.consumptions !== 0 || !evidence.pending) {
        checkpoint(job, kind, expected, 'uncertain', evidence.consumptions
          ? 'host_consumed_without_handshake' : 'host_admission_not_proven_pending')
        return
      }
      if (state === 'sending') {
        if (!checkpoint(job, kind, expected, 'admitted', 'recovered_native_pending')) return
        expected = 'admitted'
      }
      if (!canRoute(ledger.read().grants[job.key], job, kind)) return
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

  async function ownerReconcile(owner, turn, message, task, id, kind, reason) {
    const key = taskKey(owner, task)
    try {
      const job = jobFor(ledger.read().jobs, id)
      const delivery = job && deliveryOf(job, kind)
      if (job?.key !== key || job.owner !== owner || delivery?.state !== 'uncertain') return false
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
      const result = ledger.change(({ jobs }, archive) => {
        const stored = jobFor(jobs, id)
        const item = stored && deliveryOf(stored, kind)
        if (stored?.key !== key || stored.owner !== owner || item?.state !== 'uncertain') return noChange(false)
        item.reconciliation = {
          decision: 'release_without_replay', previousReason: item.reason ?? null, reason,
          owner, ownerMessageId: message.id, ownerRpcId: message.source.rpcId, ownerTurn: turn.number,
          at: Date.now(), evidence,
        }
        setDelivery(item, 'reconciled')
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
    ledger.change(({ jobs }, archive) => {
      const stored = jobs[job.id]
      if (!stored) return noChange()
      const issue = continuationIssue(stored.resume)
      if (issue) {
        quarantineContinuation(stored, issue, jobs, archive)
        return success()
      }
      const continuation = stored.resume?.continuation
      if (continuation?.state !== 'started' || continuation.turn !== started.turn) return noChange()
      const exactTurn = evidence?.turn === continuation.turn
      if (exactTurn && evidence.endReason === 'completed') {
        continuation.state = 'verified'
      } else {
        continuation.state = 'interrupted'
        continuation.phase = continuation.dispatches.length ? 'after_dispatch' : 'before_dispatch'
        continuation.reason = exactTurn ? evidence.endReason ?? 'turn_end_not_proven' : 'turn_evidence_unavailable'
      }
      continuation.settledAt = Date.now()
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

  function compact() {
    const now = Date.now()
    return ledger.change((state, archive) => {
      const { grants, jobs } = state
      let changed = false
      for (const [key, grant] of Object.entries(grants)) {
        const status = stateOf(grant, now)
        if (!terminal(status)) continue
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
        if (terminal(status)) {
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
        const orphanReleased = status === 'missing_grant' &&
          (!job.quarantine.taskHadHostRisk || job.wake.state !== 'uncertain') &&
          (!job.quarantine.resultHadHostRisk || job.resume?.state !== 'uncertain')
        if (!liveClaim && !liveContinuation && (terminal(status) || (taskDone && resultDone) || orphanReleased)) {
          archiveJob(job, jobs, archive)
          changed = true
        }
      }
      return { changed, value: state }
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
      if (job.resume?.continuation?.state === 'started') {
        const observed = turns.get(job.owner)
        if (observed?.number !== job.resume.continuation.turn) add(job, 'result', finishContinuation, 2)
      }
      for (const kind of ['task', 'result']) {
        const delivery = deliveryOf(job, kind)
        if (delivery?.state === 'claimed' || (sent(delivery) && enabled())) {
          add(job, kind, reconcile, 1)
        } else if (delivery?.state === 'queued' && canRoute(grants[job.key], job, kind) &&
            !retainedSlot(activeJobs, job, kind, grants)) {
          add(job, kind, send, 0)
        }
      }
    }
    await Promise.all([...lanes.values()].map(async ({ job, kind, work }) => {
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
}
