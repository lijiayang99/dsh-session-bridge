import { randomUUID } from 'node:crypto'
import { UUID, batchOf, continuationIssue, denied, digest, isDirectGrant, jobView, noChange, scopedGrant, sent,
  setDelivery, setGrantState, stateOf, success, taskKey } from './workflow-state.js'

const ARTIFACT = /^(?:git:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/
export const artifactSchema = { type: 'string', pattern: ARTIFACT.source }
export const artifactList = { type: 'array', maxItems: 8, uniqueItems: true, items: artifactSchema }
export const validArtifact = (value) => typeof value === 'string' && ARTIFACT.test(value)
export const validArtifacts = (value) => Array.isArray(value) && value.length <= 8 &&
  value.every(validArtifact) && new Set(value).size === value.length
const uuidSchema = { type: 'string', pattern: UUID.source }
const textSchema = (maxLength) => ({ type: 'string', minLength: 1, maxLength })
const attemptSchema = { type: 'integer', minimum: 1, maximum: 8 }
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const statuses = ['completed', 'approved', 'changes_requested', 'failed', 'needs_owner']

export function registerWorkerTools(register, ledger, { jobFor, grantFor, authorized, available, activeGrant,
  conversationRoute, issueClaim, claimedHere, pendingWithdrawal, defer, schedule, batchMembers,
  batchView, quarantineContinuation }) {
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
        const implicit = context.implicitClaim && job.claim?.turn === turn.number &&
          job.claim.messageId === context.messageId
        if (job.claim && !implicit) return noChange({ id, duplicate: true })
        if (!authorized(grant, job, 'task') || !jobs[id]) return noChange(denied('grant_inactive'))
        if (!implicit && !sent(job.wake)) return noChange(denied('delivery_not_claimable'))
        if (!implicit) issueClaim(job, turn)
        context.implicitClaim = false
        return (implicit ? noChange : success)({
          id, task: grant.task, goal: grant.goal, item: job.item, attempt: job.attempt,
          owner: job.owner, scope: job.scope, instructions: job.instructions, acceptance: job.acceptance,
          ...(grant.collaboration ? { purpose: grant.scopes.find(({ name }) => name === job.scope)?.purpose } : {}),
          ...(job.reviewOf ? { reviewOf: job.reviewOf, artifact: job.artifact } : {}),
          expiresAt: grant.expiresAt, token: job.claim.token, duplicate: false,
        })
      })
      if (result.duplicate === false) claimedHere.add(id)
      return result
    })

  // Keep the initial query's existing synchronous report and audit receipt.
  const initialQueryReport = (job, turn) => job.query && turn.context.mode === 'task' && !turn.forwarded?.size

  register('report',
    'Submit the final structured result in the claiming turn or a verified ongoing task turn. Use workflow_message for interim progress or questions. Include concrete evidence. A completed producer may report immutable artifacts. An approval or change request for a bound review must give reviewedArtifact exactly as claimed.',
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
        const withdrawn = job.conversation && pendingWithdrawal(job.owner, job.key.slice(job.owner.length + 1))
        const late = !scopedGrant(grant) || !available(job.owner) || !available(job.target) ||
          !['active', 'paused'].includes(stateOf(grant)) || Boolean(withdrawn)
        if (job.conversation && !initialQueryReport(job, turn) && (late || !activeGrant(grant))) {
          return noChange(denied('grant_inactive'))
        }
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
      if (job?.conversation && !initialQueryReport(job, turn)) {
        if (job.target !== caller.id || job.attempt !== attempt || job.claim?.token !== token) return denied('claim_mismatch')
        const route = conversationRoute(grants[job.key], job, caller.id, job.owner, false)
        if (!route || pendingWithdrawal(job.owner, route.task)) return denied('grant_inactive')
        const reportDigest = digest(JSON.stringify([status, summary, evidence, artifacts, reviewedArtifact]))
        if (turn.pendingReport) return turn.pendingReport === reportDigest
          ? { id, queued: true, duplicate: true } : denied('report_conflict')
        // Validate formal review evidence before promising to record the result.
        if ((['approved', 'changes_requested'].includes(status) || reviewedArtifact !== undefined) &&
            (!job.reviewOf || reviewedArtifact !== job.artifact) ||
            job.reviewOf && (status === 'completed' || artifacts !== undefined)) return denied('artifact_binding_required')
        turn.pendingReport = reportDigest
        defer(turn, route, () => { recordReport(); schedule() }, undefined, undefined, false)
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
        if (!authorized(grant, job, 'result') || !jobs[id]) return noChange(denied('grant_inactive'))
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
}
