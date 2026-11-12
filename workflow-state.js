import { createHash } from 'node:crypto'

export const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
export const scopedGrant = (grant) => grant?.routePolicy === 'native-owner-v1'

export const taskKey = (owner, task) => owner + ':' + task
export const success = (value) => ({ changed: true, value })
export const noChange = (value) => ({ changed: false, value })
export const denied = (error) => ({ error })
export const digest = (text) => createHash('sha256').update(text).digest('hex')
export function stateOf(grant, now = Date.now()) {
  if (!grant) return 'missing_grant'
  const state = grant.state === 'collaboration_active' ? 'active'
    : grant.state === 'collaboration_paused' ? 'paused'
      : grant.state === 'collaboration_closing' ? 'closing' : grant.state
  if (state === 'collaboration_authorizing') return now >= grant.expiresAt ? 'expired' : 'authorizing'
  if (state !== 'active' && state !== 'paused' && state !== 'closing') return state
  return now >= grant.expiresAt ? 'expired' : state
}

// Older versions will read these grants but cannot open their dispatch gate.
export function setGrantState(grant, state) {
  grant.state = grant.collaboration ? 'collaboration_' + state : state
}

export const batchOf = (grant, id) => grant?.batches?.find(({ batch }) => batch === id)
export const isDirectGrant = (grant) => grant?.authorization?.kind === 'native-owner-workflow-direct' ||
  grant?.conversation && grant.authorization?.kind === 'native-owner-workflow-confirmation' && grant.budget === 1

export function sent(delivery) {
  return delivery?.state === 'sending' || delivery?.state === 'admitted'
}

export function unresolved(delivery) {
  return sent(delivery) || delivery?.state === 'uncertain'
}

export function terminal(state) {
  return state === 'cancelled' || state === 'expired' || state === 'closed'
}

export function setDelivery(delivery, state, reason) {
  delivery.state = state
  if (reason === undefined) delete delivery.reason
  else delivery.reason = reason
  delivery.updatedAt = Date.now()
  delivery.milestones ??= {}
  delivery.milestones[state] ??= delivery.updatedAt
}

export function continuationIssue(resume) {
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

export function pendingDirectCompletion(grant, job) {
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

export function jobView(job, grant) {
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

