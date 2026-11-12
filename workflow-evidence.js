import { nativeOwner } from './bridge-input.js'
import { hostContext, plainText } from './natural-message.js'
import { digest } from './workflow-state.js'
import { matchesContextNotice } from './workflow-authorization.js'

const reportLabels = { completed: '已完成', failed: '失败', needs_owner: '待主控处理',
  approved: '审核通过', changes_requested: '要求返修' }
export function deliveryOf(job, kind) {
  return kind === 'task' ? job.wake : job.resume
}

export function receiverOf(job, kind) {
  return kind === 'task' ? job.target : job.owner
}

export function senderOf(job, kind) {
  return kind === 'task' ? job.owner : job.target
}

function wakeText(job, kind) {
  const header = 'DSH-WORKFLOW ' + kind.toUpperCase() + ' ' + job.id
  if (kind !== 'result' || !job.nativeResult || !job.report || job.report.late) return header
  const { status, summary, evidence } = job.report
  const route = job.conversation && !job.query ? ' · ' + job.key.slice(job.owner.length + 1) + ' · ' +
    job.target + ' → ' + job.owner : ''
  return '委托回报 · ' + reportLabels[status] + route + '\n\n' + summary +
    (evidence.length ? '\n\n证据\n' + evidence.join('\n') : '')
}

export function wakeContent(job, kind) {
  const content = [{ type: 'text', text: wakeText(job, kind) }]
  if (kind === 'task' && job.inlineGoal) content.push(
    { type: 'text', text: job.instructions },
    { type: 'text', text: '这是已绑定的任务。可向原主控主动报进展、发问或报告阻塞。普通最终答复会自动回到原主控。' },
  )
  return content
}

export function isWake(job, kind, message) {
  const source = message.source
  return message.id === deliveryOf(job, kind)?.id && message.role === 'user' &&
    source?.kind === 'agent-message' && source.form === 'relay' &&
    source.senderSessionId === senderOf(job, kind) &&
    source.bridgeWorkflowKind === kind && source.bridgeWorkflowId === job.id &&
    (kind !== 'task' || !job.inlineGoal || JSON.stringify(message.content) === JSON.stringify(wakeContent(job, kind))) &&
    (kind !== 'result' || !job.nativeResult ||
      source.bridgeWorkflowOwner === job.owner && plainText(message) === wakeText(job, kind))
}

export async function hostEvents(ctx, sessionId, startSeq, signal) {
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
export async function hostEvidence(ctx, job, kind, signal) {
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

export function closeTurnEvidence(events, closure, anchor, matchesInput) {
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

