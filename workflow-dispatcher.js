import { deliveryOf, hostEvidence, isWake, receiverOf, senderOf, wakeContent } from './workflow-evidence.js'
import { noChange, scopedGrant, sent, setDelivery, stateOf, success, unresolved } from './workflow-state.js'

export function deliveryDeadline(signal) {
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
  return bounded
}

export function workflowDispatcher(ctx, ledger, { signal, enabled, canRoute, verifyTarget, turns, claimedHere, bounded,
  publishDelivery, compact, closeout }) {
  const waking = new Set()
  let driver
  let readyToDrive = false
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
      const grant = grants[other.key]
      const state = stateOf(grant)
      const active = scopedGrant(grant) && (state === 'active' || state === 'paused') ||
        (state === 'missing_grant' && other.quarantine)
      if (recipient === other.target && (other !== job || kind !== 'task') &&
          active && (!other.quarantine || other.quarantine.taskHadHostRisk) &&
          (unresolved(other.wake) || other.wake.state === 'claimed' && !other.conversation)) return true
      return recipient === other.owner && (other !== job || kind !== 'result') &&
        active && (!other.quarantine || other.quarantine.resultHadHostRisk) && unresolved(other.resume)
    })
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
      if (!signal.aborted) updateDelivery(job, kind, 'queued', (delivery, grant, stored) => {
        if (!canRoute(grant, stored, kind)) return noChange(false)
        if (!grant.collaboration) {
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
      updateDelivery(job, kind, 'queued', (delivery, grant, stored) => {
        if (!canRoute(grant, stored, kind)) return noChange(false)
        setDelivery(delivery, 'failed', 'destination_unavailable_before_send')
        return success(true)
      })
      return
    }
    if (kind === 'task') {
      const grant = ledger.read().grants[job.key]
      if (!canRoute(grant, job, kind)) return
      const matches = await bounded((deadline) => verifyTarget(grant, job, deadline)).catch(() => false)
      if (!matches) {
        updateDelivery(job, kind, 'queued', (delivery, current, stored) => {
          if (!canRoute(current, stored, kind)) return noChange(false)
          setDelivery(delivery, 'skipped', 'target_binding_changed')
          return success(true)
        })
        return
      }
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
        content: wakeContent(job, kind),
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
        if (closeout.settleNativeResult(job, expected, evidence)) return
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
      if (!scopedGrant(grants[job.key] ?? ledger.history.grant(job.key)) && !job.quarantine) continue
      if (enabled() && job.ownerAdmission && stateOf(grants[job.key]) === 'authorizing' &&
          turns.get(job.owner)?.startSeq !== job.ownerAdmission.startSeq) add(job, 'task', closeout.finishOwnerAdmission, 4)
      if (job.resume?.continuation?.state === 'started') {
        const observed = turns.get(job.owner)
        if (observed?.number !== job.resume.continuation.turn) add(job, 'result', closeout.finishContinuation, 3)
      }
      for (const kind of ['task', 'result']) {
        const delivery = deliveryOf(job, kind)
        if (delivery?.state === 'claimed' && (!job.conversation || !claimedHere.has(job.id)) ||
            sent(delivery)) {
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
      if (enabled() && Number.isSafeInteger(grant.admission?.endSeq) &&
          (lanes.get(grant.owner)?.priority ?? -1) < 5) {
        lanes.set(grant.owner, { priority: 5, admission: { key, grant } })
      }
      if (!scopedGrant(grant) || grant.state !== 'collaboration_closing' || closure?.state !== 'pending' ||
          turns.get(grant.owner)?.startSeq === closure.startSeq ||
          (lanes.get(grant.owner)?.priority ?? -1) >= 2) continue
      lanes.set(grant.owner, { priority: 2, close: { key, grant } })
    }
    await Promise.all([...lanes.values()].map(async ({ job, kind, work, close, admission }) => {
      if (admission) {
        await closeout.finishGrantAdmission(admission.key, admission.grant)
        return
      }
      if (close) {
        try { await closeout.finishClosure(close.key, close.grant) } catch {
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


  function forgetDelivery(job) {
    waking.delete(job.wake.id)
    if (job.resume) waking.delete(job.resume.id)
    claimedHere.delete(job.id)
  }

  function start(stop, dispose) {
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
        stop()
        cancel?.()
        clearInterval(timer)
        await driver
        dispose()
      }
    }, 'dsh-session-bridge workflow ledger and dispatcher')
  }

  function schedule() {
    if (!readyToDrive || driver || signal.aborted) return
    driver = Promise.resolve().then(tick).catch(() => {
      if (!signal.aborted) ctx.logger.warn('workflow ledger or dispatcher failed')
    }).finally(() => { driver = undefined })
  }

  return { schedule, updateDelivery, forgetDelivery, start }
}
