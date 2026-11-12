import { matchingTitles } from './natural-message.js'
import { closeTurnEvidence, deliveryOf, hostEvents, hostEvidence } from './workflow-evidence.js'
import { continuationIssue, isDirectGrant, noChange, pendingDirectCompletion, scopedGrant, setDelivery, setGrantState, stateOf, success, taskKey } from './workflow-state.js'

export function workflowCloseout(ctx, ledger, { signal, enabled, available, turns, bounded, updateDelivery,
  existing, cleanInbox, jobFor, grantFor, quarantineContinuation, schedule }) {
  function settleNativeResult(job, expected, evidence) {
    if (evidence.admissions !== 1 || evidence.consumptions !== 1 || evidence.mixedTurn ||
        evidence.endReason !== 'completed' || !Number.isFinite(evidence.endTime) ||
        !Number.isSafeInteger(evidence.turn)) return false
    return updateDelivery(job, 'result', expected, (resume, grant, stored) => {
      const status = stateOf(grant, evidence.endTime)
      if (!isDirectGrant(grant) || !scopedGrant(grant) || !stored.report || stored.report.late ||
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
    if (!enabled()) return
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

  async function finishGrantAdmission(key, grant) {
    const proof = grant.admission
    const live = ctx.agents.get(grant.owner)
    let end
    try {
      if (live) await bounded(() => ctx.sessions.flush(live.session))
      end = closeTurnEvidence(await bounded((deadline) => hostEvents(ctx, grant.owner, proof.startSeq, deadline)), proof)
    } catch {
      // A missing durable owner input never opens the append gate.
    }
    if (!enabled()) return
    ledger.change(({ grants, jobs }) => {
      const stored = grants[key]
      if (stored?.admission?.startSeq !== proof.startSeq || stateOf(stored) !== 'active') return noChange()
      if (end?.reason === 'completed' && end.sequence === proof.endSeq) {
        delete stored.admission
      } else {
        stored.admission = { rejected: true }
        for (const job of Object.values(jobs)) {
          if (job.key === key && job.wake.state === 'queued') setDelivery(job.wake, 'skipped', 'owner_turn_not_verified')
        }
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
            scopedGrant(grant) && available(stored.owner) && endTime < grant.expiresAt) {
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
      const permitted = scopedGrant(stored) && available(stored.owner)
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
  return { settleNativeResult, finishOwnerAdmission, finishGrantAdmission, ownerReconcile, finishContinuation, finishClosure }
}
