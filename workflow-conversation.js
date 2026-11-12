import { randomUUID } from 'node:crypto'
import { validId } from './bridge-input.js'
import { plainText } from './natural-message.js'
import { closeTurnEvidence, hostEvents, isWake } from './workflow-evidence.js'
import { denied, digest, noChange, sent, setDelivery, success, taskKey } from './workflow-state.js'

const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max

export function workflowConversation(ctx, ledger, { turns, claimedHere, current, enabled, signal, bounded,
  jobFor, grantFor, canRoute, participantPair, conversationRoute, ownerTaskMessage, matchConversation, reserveConversation, withdrawalTask }) {
  function pendingWithdrawal(owner, task) {
    const inbox = ctx.agents.get(owner)?.inbox
    const matches = (message) => withdrawalTask(message) === task
    return turns.get(owner)?.withdrawals?.has(task) ||
      inbox?.nextTurn?.some(matches) || inbox?.nextStep?.some(matches)
  }

  function liveConversation(route, transport = true) {
    const { grants, jobs } = ledger.read()
    const job = jobs[route.id]
    const active = conversationRoute(grants[job?.key], job, route.from, route.to, transport)
    return active?.task === route.task && !pendingWithdrawal(job.owner, route.task)
  }

  function waitingForDirectQuestion(exec) {
    const caller = current(exec)
    const context = caller?.context
    if (!enabled() || context?.mode !== 'direct-workflow' ||
        !(context.direct.question || context.contextual && context.direct.action === 'ask')) return
    return { state: 'waiting_for_owner_turn_end' }
  }

  const peer = (job, from) => from === job.owner ? job.target : job.owner

  async function queueMessage({ to, task, text, requestId, allowOrdinary }, exec) {
    if (!enabled()) return
    const caller = current(exec)
    const state = ledger.read()
    const from = exec.agent?.session?.id
    const context = turns.get(from)?.context
    const bound = context?.mode === 'task' || context?.mode === 'conversation' ? jobFor(state.jobs, context.id) : undefined
    let job
    let grant
    let verifyTarget
    let literal = false
    if (bound?.conversation) {
      if (!caller) return denied('workflow_task_context_required')
      grant = grantFor(state.grants, bound.key)
      if (task && task !== bound.id && task !== grant?.task) return denied('workflow_task_mismatch')
      job = state.jobs[bound.id]
      to ??= peer(bound, from)
    } else {
      const selected = await ownerTaskMessage({ to, task, text, allowOrdinary }, from, exec, caller, state)
      if (!selected?.job) return selected
      const live = current(exec)
      if (!enabled() || live?.turn !== caller.turn || live.context !== context) return denied('workflow_task_context_required')
      job = selected.job
      grant = selected.grant
      verifyTarget = selected.verifyTarget
      literal = selected.literal
      to ??= job.target
    }
    if (!job || !participantPair(job, from, to)) return denied('workflow_task_route_inactive')
    if (!validText(text, 2000)) return denied('workflow_message_body_required')
    if (caller.turn.deferred?.length >= 8) return denied('workflow_turn_message_limit')
    if (job.inlineGoal && !job.claim && caller.context.mode === 'task') {
      job = claimConversation(job, caller.turn) ?? job
    }
    const route = conversationRoute(grant, job, from, to)
    if (!route || pendingWithdrawal(job.owner, route.task)) return denied('workflow_task_route_inactive')
    const bodyKey = route.id + ':' + digest(text)
    const previous = caller.turn.forwarded?.get(bodyKey)
    if (previous && (literal || requestId === undefined)) return { ...previous, duplicate: true }
    const key = requestId ?? 'natural-task-' + digest(JSON.stringify([caller.turn.input.messageId, text]))
    const { receipt, send, stop } = reserveConversation(route, key, text)
    if (!receipt.error) {
      caller.turn.forwarded ??= new Map()
      caller.turn.forwarded.set(bodyKey, receipt)
    }
    if (send) defer(caller.turn, route, (deadline) => send(deadline, () => liveConversation(route), verifyTarget), stop)
    return receipt
  }

  function issueClaim(job, turn) {
    job.claim = { token: randomUUID(), turn: turn.number, messageId: turn.context.messageId, at: Date.now() }
    setDelivery(job.wake, 'claimed')
  }

  function claimConversation(job, turn) {
    const { context } = turn
    const claimed = ledger.change(({ grants, jobs }) => {
      const stored = jobs[job.id]
      const grant = grants[stored?.key]
      if (!stored?.inlineGoal || !grant?.conversation || context.mode !== 'task' ||
          context.id !== stored.id || context.messageId !== stored.wake.id ||
          !sent(stored.wake) || !canRoute(grant, stored, 'task') ||
          pendingWithdrawal(stored.owner, grant.task)) return noChange()
      issueClaim(stored, turn)
      return success(stored)
    })
    if (claimed) {
      claimedHere.add(job.id)
      context.implicitClaim = true
    }
    return claimed
  }

  function replyText(event) {
    const { message, interrupted } = event.data
    if (interrupted || message?.role !== 'assistant' || !validId(message.id)) return
    const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n\n')
    if (validText(text, 16_000)) return { id: message.id, seq: event.seq, text }
  }

  function automaticReply(session, turn) {
    const { context, reply } = turn
    if (!reply || turn.pendingReport || turn.forwarded?.has(context.id + ':' + digest(reply.text)) ||
        !['task', 'conversation'].includes(context.mode)) return
    const { grants, jobs } = ledger.read()
    let job = jobs[context.id]
    if (!job?.conversation || job.target !== session.id || job.report) return
    if (!job.claim && job.inlineGoal) job = claimConversation(job, turn) ?? job
    const route = conversationRoute(grants[job.key], job, job.target, job.owner)
    if (!route || pendingWithdrawal(job.owner, route.task)) return
    const key = 'auto-task-' + digest(JSON.stringify([job.id, reply.id]))
    defer(turn, route, async (deadline) => {
      const { send } = reserveConversation(route, key, reply.text)
      if (send) await send(deadline, () => liveConversation(route))
    }, undefined, reply)
  }

  function defer(turn, route, run, stop, reply, transport = true) {
    turn.deferred ??= []
    turn.deferred.push({ route, run, stop, reply, transport })
  }

  function finishConversationTurn(session, turn, event) {
    const completed = !turn.mixed && turn.input && event.data.reason.kind === 'completed'
    if (completed) automaticReply(session, turn)
    if (!turn.deferred?.length) return
    // Read the owner's queues synchronously at the source turn boundary.
    // The driver can claim the next input while the durable proof is read.
    const { context, input } = turn
    const ready = completed ? turn.deferred.filter(({ route, transport }) => liveConversation(route, transport)) : []
    const job = (context.mode === 'task' || context.mode === 'conversation') && ledger.read().jobs[context.id]
    const matchesInput = context.mode === 'conversation' ? (data) => matchConversation(context.route, data)
      : job ? (data) => isWake(job, 'task', data) : undefined
    const sourceDigest = turn.ownerMessage && digest(plainText(turn.ownerMessage) ?? '')
    const proof = { turn: turn.number, startSeq: turn.startSeq, input, requestedAt: 0, sourceDigest }
    void Promise.resolve().then(async () => {
      if (!ready.length) return
      await bounded(() => ctx.sessions.flush(session))
      const events = await bounded((deadline) => hostEvents(ctx, session.id, turn.startSeq, deadline))
      const end = closeTurnEvidence(events, proof, undefined, matchesInput)
      if (end?.reason !== 'completed' || end.sequence !== event.seq) return
      for (const entry of ready) {
        const reply = entry.reply
        if (reply && !events.some((item) => item.seq === reply.seq && item.seq < end.sequence &&
            item.type === 'assistant/message' && item.data.turn === turn.number &&
            replyText(item)?.id === reply.id && replyText(item)?.text === reply.text)) continue
        if (liveConversation(entry.route, entry.transport)) await bounded(entry.run)
      }
    }).catch(() => {
      if (!signal.aborted) ctx.logger.warn('workflow task exchange could not be verified')
    }).finally(() => {
      for (const entry of turn.deferred) {
        if (!entry.stop) continue
        const owner = entry.route.returning ? entry.route.to : entry.route.from
        const key = taskKey(owner, entry.route.task)
        const grant = signal.aborted ? undefined : grantFor(ledger.read().grants, key)
        const cancelled = grant?.state === 'cancelled' || pendingWithdrawal(owner, entry.route.task)
        const reason = cancelled ? 'cancelled' : !enabled() ? 'bridge_disabled' : undefined
        entry.stop(reason)
      }
    })
  }
  return { queueMessage, waitingForDirectQuestion, finishConversationTurn, issueClaim, pendingWithdrawal, defer, replyText }
}
