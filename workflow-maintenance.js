import { randomUUID } from 'node:crypto'
import { validId } from './bridge-input.js'
import { UUID, batchOf, continuationIssue, pendingDirectCompletion, scopedGrant, sent, setDelivery, setGrantState, stateOf, terminal, unresolved } from './workflow-state.js'

const batchSettled = new Set(['reported', 'failed', 'uncertain', 'skipped', 'reconciled'])
export function workflowMaintenance(ledger, { turns, available, enabled, grantFor, batchMembers, forgetDelivery }) {
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
    forgetDelivery(job)
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
      if (!scopedGrant(grant) || grant.admission || !grant.collaboration || !['active', 'paused'].includes(stateOf(grant))) continue
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
        if (!scopedGrant(grant) || stateOf(grant, now) !== 'expired') continue
        if (pendingDirectCompletion(grant, job) && turns.get(job.owner)?.number !== job.resume.continuation.turn ||
            job.nativeResult && sent(job.resume) && Number.isSafeInteger(job.resume.startSeq)) {
          pendingDirect.add(job.key)
        }
      }
      let changed = false
      for (const [key, grant] of Object.entries(grants)) {
        const status = stateOf(grant, now)
        if (scopedGrant(grant) && grant.state === 'collaboration_closing' && grant.closure?.state === 'pending') {
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
        if (scopedGrant(grant) && grant.collaboration && status === 'active' && enabled() &&
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
  return { compact, quarantineContinuation }
}
