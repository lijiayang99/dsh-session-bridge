import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { hostContext, plainText } from './natural-message.js'
import { createWorkflowAuthorization, matchesContextNotice, workflowProposalProperties } from './workflow-authorization.js'
import { openLedger } from './workflow-ledger.js'
import { taskLog } from './workflow-view.js'
import { ID, nativeOwner, validId } from './bridge-input.js'
import { UUID, batchOf, denied, digest, jobView, noChange, sent, scopedGrant,
  setDelivery, setGrantState, stateOf, success, taskKey, terminal } from './workflow-state.js'
import { closeTurnEvidence, deliveryOf, hostEvents, isWake, receiverOf, senderOf } from './workflow-evidence.js'
import { workflowTools } from './workflow-tools.js'
import { existingWindow, workflowRouting } from './workflow-routing.js'
import { workflowCloseout } from './workflow-closeout.js'
import { workflowMaintenance } from './workflow-maintenance.js'
import { deliveryDeadline, workflowDispatcher } from './workflow-dispatcher.js'
import { workflowConversation } from './workflow-conversation.js'
import { artifactSchema, artifactList, validArtifact, validArtifacts, registerWorkerTools } from './workflow-worker-tools.js'

const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const maxGrants = 128
const maxJobs = 512
const maxPerGrant = 32
const control = /^授权委托\r?\n([\s\S]+)$/
const review = /^对账委托 ([a-zA-Z0-9_-]{1,128}) ([a-f0-9-]{36}) (task|result)\r?\n([\s\S]+)$/
const action = /^(取消委托|继续委托) ([a-zA-Z0-9_-]{1,128})$/
const directNotices = {
  workflow_target_clarification_required: '委托未发送。请在原窗口重试，使用引号写出一个完整且唯一的窗口名。',
  workflow_target_not_available: '委托未发送。请在原窗口重新指定一个可用的目标窗口。',
  workflow_target_changed: '委托未发送。目标窗口在核对时发生变化，请确认窗口名后重试。',
  workflow_targets_unavailable: '委托未发送。暂时无法核对目标窗口，请稍后重试。',
  grant_not_opened: '无法建立新的委托任务。请在原主控核对任务状态后重试。',
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
  workflow_target_not_available: '这个窗口当前不可用。请确认窗口可用，或告诉我另一个窗口的完整标题。',
}
const idSchema = { type: 'string', pattern: ID.source, maxLength: 128 }
const uuidSchema = { type: 'string', pattern: UUID.source }
const textSchema = (maxLength) => ({ type: 'string', minLength: 1, maxLength })
const attemptSchema = { type: 'integer', minimum: 1, maximum: 8 }
const assignmentProperties = {
  item: idSchema, attempt: attemptSchema, target: idSchema, scope: idSchema,
  instructions: textSchema(4000), acceptance: textSchema(1500),
  reviewOf: uuidSchema, artifact: artifactSchema,
}
const assignmentRequired = ['item', 'attempt', 'target', 'scope', 'instructions', 'acceptance']
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

function withdrawalTask(message) {
  if (!nativeOwner(message)) return
  const match = action.exec(plainText(message) ?? '')
  if (match?.[1] === '取消委托') return match[2]
}

const activityStates = {
  queued: 'queued', sending: 'sending', admitted: 'delivered', claimed: 'executing',
  reported: 'reported', consumed: 'delivered', failed: 'failed', uncertain: 'uncertain',
  skipped: 'stopped', reconciled: 'reconciled',
}

export function applyWorkflow(ctx, transportEnabled, available, activity, matchConversation, reserveConversation) {
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
  const claimedHere = new Set()

  const enabled = () => !signal.aborted && transportEnabled()
  const grantFor = (grants, key) => grants[key] ?? ledger.history.grant(key)
  const jobFor = (jobs, id) => jobs[id] ?? ledger.history.job(id)
  const existing = (id, requestSignal) => existingWindow(ctx.sessionPersistence, available, id, requestSignal)
  const authorization = createWorkflowAuthorization(ctx, { enabled, available, existing, signal })

  const register = workflowTools(ctx.tools, current)
  const bounded = deliveryDeadline(signal)
  const { activeGrant, authorized, canRoute, verifyTarget, participantPair, conversationRoute, ownerTaskMessage, permitsNativeRoute } = workflowRouting({
    available, enabled, claimedHere, ledger, current, bounded, signal,
    windows: (deadline) => ctx.sessionController.list({}, deadline), workspaceRegistry: ctx.workspaceRegistry,
    withdrawn: (...args) => pendingWithdrawal(...args),
  })

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
        if (!scopedGrant(grant) || !['active', 'paused'].includes(stateOf(grant))) return noChange(false)
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
      return Boolean(openGrant(input, key, owner, messageId, turn.number, now, undefined, undefined, ownerProof(turn)))
    } catch {
      if (!signal.aborted) ctx.logger.warn('workflow grant could not be validated')
      return false
    }
  }

  function openGrant(input, key, owner, messageId, turn, now, evidence, directJob, admission) {
    return ledger.change(({ grants, jobs }) => {
      const known = grantFor(grants, key) || ledger.history.jobCount(key) || ledger.history.hasQuarantined(key) ||
        Object.values(jobs).some((job) => job.key === key)
      if (known || Object.keys(grants).length >= maxGrants || directJob && Object.keys(jobs).length >= maxJobs) {
        return noChange()
      }
      const grant = {
        routePolicy: 'native-owner-v1',
        task: input.task, owner, goal: input.goal, scopes: input.scopes,
        expiresAt: now + input.ttlMinutes * 60_000, state: 'active',
        openedAt: now, ownerMessageId: messageId, ownerTurn: turn,
        ...(admission ? { admission } : {}),
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
      if (event.type === 'assistant/message') {
        authorization.reply(session, turn, event)
        const { mode, id } = turn.context ?? {}
        if (['task', 'conversation'].includes(mode)) {
          const job = ledger.read().jobs[id]
          if (job?.conversation && job.target === session.id) turn.reply = replyText(event)
        }
      }
      if (event.type !== 'turn/end' || event.data.turn !== turn.number) return
      authorization.end(session, turn, event)
      finishConversationTurn(session, turn, event)
      turns.delete(session.id)
      finishGrantInput(session, turn, event)
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

  function openDirect(caller, input, evidence, ownerAdmission) {
    const key = taskKey(caller.id, input.task)
    const now = Date.now()
    const target = input.scopes[0].targets[0]
    const job = {
      id: randomUUID(), key, owner: caller.id, target, item: 'execute', attempt: 1, scope: input.scopes[0].name,
      instructions: input.goal, acceptance: '按所有者原文完成目标并回报实际结果及证据。',
      after: null, dispatchedTurn: caller.turn.number, createdAt: now, nativeResult: true,
      ...(input.conversation ? { conversation: true, inlineGoal: true } : {}),
      ...(input.query ? { query: true } : {}),
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

  function ownerProof(turn) {
    return { startSeq: turn.startSeq, turn: turn.number, input: turn.input,
      sourceDigest: digest(plainText(turn.ownerMessage) ?? ''), requestedAt: 0 }
  }

  function finishGrantInput(session, turn, event) {
    ledger.change(({ grants, jobs }) => {
      let changed = false
      for (const grant of Object.values(grants)) {
        const proof = grant.admission
        if (grant.owner !== session.id || proof?.startSeq !== turn.startSeq) continue
        changed = true
        if (!turn.mixed && event.data.reason.kind === 'completed' && Number.isSafeInteger(event.seq)) {
          proof.endSeq = event.seq
          continue
        }
        grant.admission = { rejected: true }
        for (const job of Object.values(jobs)) {
          if (job.key === taskKey(grant.owner, grant.task) && job.wake.state === 'queued') {
            setDelivery(job.wake, 'skipped', 'owner_turn_not_verified')
          }
        }
      }
      return { changed }
    })
  }

  function finishOwnerInput(session, turn, event) {
    const context = turn.context
    const isNotice = context?.mode === 'direct-context-notice'
    const automaticConfirmation = context?.mode === 'confirm-workflow' && isSingleConversation(context.draft?.grant)
    if (context?.mode !== 'direct-workflow' && !isNotice && !automaticConfirmation) return
    const agent = ctx.agents.get(session.id)
    const clean = !turn.mixed && event.data.reason.kind === 'completed' &&
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
    if (!clean || !enabled()) return
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
          caller.turn.number, Date.now(), evidence, undefined, ownerProof(caller.turn))
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
      if (!activeGrant(grant) || pendingWithdrawal(id, task) || !targets.every(available)) return noChange(denied('grant_inactive'))
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

  const { queueMessage, waitingForDirectQuestion, finishConversationTurn, issueClaim, pendingWithdrawal, defer, replyText } =
    workflowConversation(ctx, ledger, { turns, claimedHere, current, enabled, signal, bounded, jobFor, grantFor,
      canRoute, participantPair, conversationRoute, ownerTaskMessage, matchConversation, reserveConversation, withdrawalTask })

  registerWorkerTools(register, ledger, { jobFor, grantFor, authorized, available, activeGrant,
    conversationRoute, issueClaim, claimedHere, pendingWithdrawal, defer, schedule, batchMembers,
    batchView, quarantineContinuation: (...args) => quarantineContinuation(...args) })

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

  const { compact, quarantineContinuation } = workflowMaintenance(ledger, {
    turns, available, enabled, grantFor, batchMembers, forgetDelivery: (job) => dispatcher.forgetDelivery(job),
  })
  const closeout = workflowCloseout(ctx, ledger, {
    signal, enabled, available, turns, bounded, updateDelivery: (...args) => dispatcher.updateDelivery(...args),
    existing, cleanInbox, jobFor, grantFor, quarantineContinuation, schedule,
  })
  const dispatcher = workflowDispatcher(ctx, ledger, {
    signal, enabled, canRoute, verifyTarget, turns, claimedHere, bounded, publishDelivery, compact, closeout,
  })
  function schedule() { dispatcher.schedule() }
  function ownerReconcile(...args) { return closeout.ownerReconcile(...args) }
  dispatcher.start(() => lifetime.abort(), () => ledger.close())
  return {
    queueMessage, waitingForDirectQuestion,
    permitsNativeRoute: (id) => permitsNativeRoute(id, turns.get(id)),
    statusEvents: (id) => taskLog(ledger, id),
  }
}
