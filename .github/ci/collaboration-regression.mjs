import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, guestSource, main, relaySource, reviewer, secondMain, until, worker } from './host-fixture.mjs'

const task = 'synth-collaboration'
const auditor = 'synth-auditor'
const artifact = 'sha256:' + 'a'.repeat(64)
const wrongArtifact = 'sha256:' + 'b'.repeat(64)
const workerTitle = '合成开发窗口'
const reviewerTitle = '合成核查窗口'
const auditorTitle = '合成审核窗口'
const goal = '核对合成文件摘要'
const direct = '把『' + goal + '』委托给『' + workerTitle + '』'
const proposal = {
  task, goal: 'Verify a synthetic artifact.', budget: 3, ttlMinutes: 5,
  scopes: [
    { name: 'work', windows: [workerTitle, reviewerTitle], purpose: 'Build and check a synthetic candidate.' },
    { name: 'review', windows: [auditorTitle], purpose: 'Review the pinned synthetic candidate.', review: true },
  ],
}
const proposalInput = '请分派任务：让合成开发窗口制作候选，合成核查窗口并行核查，合成审核窗口复审。'

async function collaborationHost(t) {
  const host = await fixture(t, { additionalSessions: [auditor] })
  host.rename(worker, workerTitle)
  host.rename(reviewer, reviewerTitle)
  host.rename(auditor, auditorTitle)
  return host
}

async function prepare(host, plan = proposal, input = proposalInput) {
  host.begin(main, input)
  const result = await host.call(main, 'workflow_propose', plan)
  assert.equal(result.confirmation, 'owner_reply_required', JSON.stringify(result))
  assert(result.preview.includes('任务预算 ' + plan.budget + ' 次派工'))
  for (const { windows } of plan.scopes) {
    for (const title of windows) assert(result.preview.includes(title))
  }
  return result.preview
}

const confirm = (host, id = main) => host.call(id, 'workflow_confirm', {})
const status = (host, name = task) => host.call(main, 'workflow_status', { task: name })
const completed = (host, name = task, refs) => host.call(main, 'workflow_close', {
  task: name, outcome: 'completed', summary: 'Verified the synthetic result.',
  ...(refs ? { finalArtifacts: refs } : {}),
})
const consume = (host, id) => host.call(main, 'workflow_consume', { id })

const closeRequest = (name, duplicate = false) => ({ task: name, state: 'closing', duplicate })
const waitForClosure = (host, state, name = task) => until(async () => {
  const current = await status(host, name)
  return current.closure?.state === state && current
}, 'Expected ' + state + ' closeout')

async function waitClosed(host, name = task) {
  const snapshot = await waitForClosure(host, 'committed', name)
  assert.equal(snapshot.state, 'closed')
  return snapshot
}

async function waitForContinuation(host, name, id, state) {
  return until(async () => {
    const snapshot = await status(host, name)
    const continuation = snapshot.jobs?.find(job => job.id === id)?.continuation?.continuation
    return continuation?.state === state && { snapshot, continuation }
  }, 'Expected ' + state + ' continuation')
}

function assignment(item, target, scope = 'work') {
  return { item, target, scope, attempt: 1, instructions: 'Run synthetic ' + item, acceptance: 'Return synthetic evidence.' }
}

async function claim(host, target, id) {
  assert.equal((await host.receive(target)).source.bridgeWorkflowId, id)
  const lease = await host.call(target, 'workflow_claim', { id })
  assert.equal(lease.duplicate, false, JSON.stringify(lease))
  return lease
}

function report(host, target, lease, fields) {
  return host.call(target, 'workflow_report', {
    id: lease.id, attempt: lease.attempt, token: lease.token, status: 'completed',
    summary: 'Synthetic result for ' + lease.item, evidence: ['synthetic evidence'], ...fields,
  })
}

test('a native task-bound owner turn can choose one of two approved workers for a follow-up', async t => {
  const host = await collaborationHost(t)
  const plan = { ...proposal, budget: 2, scopes: [proposal.scopes[0]], conversation: true }
  const input = '请把合成样本分别交给「' + workerTitle + '」和「' + reviewerTitle + '」核对。'
  host.reply(main, await prepare(host, plan, input))
  host.end(main)

  host.begin(main, '确认委托')
  assert.equal((await confirm(host)).task, task)
  const jobs = new Map()
  for (const [target, item] of [[worker, 'first'], [reviewer, 'second']]) {
    const job = await host.call(main, 'workflow_dispatch', { task, ...assignment(item, target) })
    assert.equal(job.duplicate, false)
    jobs.set(target, job.id)
  }
  host.end(main)
  for (const [target, id] of jobs) {
    await claim(host, target, id)
    host.end(target)
  }

  const text = '请核查窗口补核合成文件的时间。'
  host.begin(main, '继续委托 ' + task)
  const receipt = await host.call(main, 'send_session_message', {
    to: reviewer, request_id: 'synthetic-multi-worker-follow-up', text,
  })
  assert.equal(receipt.delivery, 'queued')
  assert.equal(receipt.task, task)
  assert.equal(receipt.job, jobs.get(reviewer))
  host.end(main)
  const message = await host.receive(reviewer)
  assert.equal(message.source.bridgeWorkflowKind, 'conversation')
  assert.equal(message.source.bridgeWorkflowId, jobs.get(reviewer))
  assert(message.content[0].text.endsWith(text))
  host.end(reviewer)
  assert.deepEqual(host.deliveries.map(({ target }) => target), [worker, reviewer, reviewer])
})

test('direct collaboration uses only exact owner input and admits the bound assignment once', async t => {
  const host = await collaborationHost(t)
  for (const source of [guestSource, relaySource, { kind: 'user' }]) {
    host.begin(main, direct, source)
    assert.equal((await host.call(main, 'workflow_delegate_direct', {})).error, 'workflow_direct_owner_request_required')
    host.end(main)
  }
  host.rename(secondMain, workerTitle)
  host.begin(main, direct)
  assert.equal((await host.call(main, 'workflow_delegate_direct', {})).error, 'workflow_target_clarification_required')
  host.end(main)
  host.rename(secondMain, secondMain)
  assert.equal(host.deliveries.length, 0)

  host.begin(main, direct)
  assert.equal((await host.call(main, 'workflow_delegate_direct', { goal: 'Changed goal' })).error,
    'workflow_direct_arguments_not_allowed')
  const opened = await host.call(main, 'workflow_delegate_direct', {})
  assert.equal(opened.duplicate, false)
  assert.equal(opened.goal, goal)
  assert.equal(opened.budget, 1)
  assert.deepEqual(opened.scopes[0].targets, [worker])
  assert.deepEqual(await host.call(main, 'workflow_delegate_direct', {}), { ...opened, duplicate: true })
  host.end(main)
  const lease = await claim(host, worker, opened.id)
  assert.equal(lease.instructions, goal)
  assert.equal(lease.owner, main)
  assert.deepEqual(host.deliveries.map(({ target }) => target), [worker])
  host.end(worker)
})

test('only a new owner confirmation after the complete exact preview opens the grant', async t => {
  const host = await collaborationHost(t)
  host.begin(main, proposalInput, guestSource)
  assert.equal((await host.call(main, 'workflow_propose', proposal)).error, 'workflow_proposal_owner_request_required')
  host.end(main)

  const earlyPreview = await prepare(host)
  host.enqueueInput(main, '确认委托')
  host.reply(main, earlyPreview)
  host.end(main)
  await host.receive(main)
  assert.equal((await confirm(host)).error, 'workflow_confirmation_required')
  host.end(main)

  host.reply(main, (await prepare(host)) + '\nChanged preview.')
  host.end(main)
  host.begin(main, '确认委托')
  assert.equal((await confirm(host)).error, 'workflow_confirmation_required')
  host.end(main)

  host.reply(main, await prepare(host))
  host.end(main)
  host.begin(secondMain, '确认委托')
  assert.equal((await confirm(host, secondMain)).error, 'workflow_confirmation_required')
  host.end(secondMain)
  host.rename(worker, '改名后的合成开发窗口')
  host.begin(main, '确认委托')
  assert.equal((await confirm(host)).error, 'workflow_target_changed')
  host.end(main)
  host.rename(worker, workerTitle)

  host.reply(main, await prepare(host))
  host.end(main)
  host.begin(main, '确认委托', guestSource)
  assert.equal((await confirm(host)).error, 'workflow_confirmation_required')
  host.end(main)
  host.begin(main, '确认委托')
  assert.equal((await confirm(host)).error, 'workflow_confirmation_required')
  host.end(main)

  host.reply(main, await prepare(host))
  host.end(main)
  host.begin(main, '确认委托')
  const grant = await confirm(host)
  assert.equal(grant.duplicate, false)
  assert.equal(grant.task, task)
  assert.equal(grant.budget, proposal.budget)
  assert.equal((await confirm(host)).error, 'workflow_confirmation_required')
  const saved = await status(host)
  assert.equal(saved.authorization.kind, 'native-owner-workflow-confirmation')
  assert.match(saved.authorization.planDigest, /^[0-9a-f]{64}$/)
  assert.notEqual(saved.authorization.preview.messageId, saved.authorization.confirmation.messageId)
  assert(saved.authorization.preview.turn < saved.authorization.confirmation.turn)
  assert.deepEqual(host.deliveries, [])
  host.end(main)
})

test('batch waits once, preserves membership and budget, and closes only with its exact audited artifact', async t => {
  const host = await collaborationHost(t)
  host.reply(main, await prepare(host))
  host.end(main)
  host.begin(main, '确认委托')
  assert.equal((await confirm(host)).duplicate, false)
  const batch = {
    task, batch: 'initial', completion: 'Both synthetic workers must report.',
    assignments: [assignment('produce', worker), assignment('check', reviewer)],
  }
  const dispatchBatch = input => host.call(main, 'workflow_dispatch_batch', input)
  const dispatch = input => host.call(main, 'workflow_dispatch', { task, ...input })
  const denied = await dispatchBatch({ ...batch, assignments: [
    batch.assignments[0], { ...batch.assignments[1], target: secondMain },
  ] })
  assert.equal(denied.error, 'scope_or_target_denied')
  assert.deepEqual((await status(host)).jobs, [])
  const opened = await dispatchBatch(batch)
  assert.equal(opened.duplicate, false)
  assert.deepEqual(await dispatchBatch(batch), { ...opened, duplicate: true })
  assert.equal((await dispatchBatch({ ...batch, completion: 'Different condition.' })).error, 'batch_conflict')
  host.end(main)

  const [producer, verifier] = await Promise.all([
    claim(host, worker, opened.ids[0]), claim(host, reviewer, opened.ids[1]),
  ])
  assert.equal((await report(host, reviewer, verifier)).recorded, true)
  host.end(reviewer)
  host.begin(main, 'Inspect synthetic batch while one worker is busy.')
  const collecting = await status(host)
  assert.equal(collecting.batches[0].state, 'collecting')
  assert.equal(collecting.batches[0].items.find(item => item.id === producer.id).delivery.state, 'claimed')
  assert.equal(host.deliveries.filter(({ target }) => target === main).length, 0)
  host.end(main)
  assert.equal((await report(host, worker, producer, { artifacts: [artifact] })).recorded, true)
  host.end(worker)

  const resultId = (await host.receive(main)).source.bridgeWorkflowId
  const result = await consume(host, resultId)
  assert.deepEqual(result.batch.items.map(({ id }) => id), opened.ids)
  assert.deepEqual(result.batch.items[0].report.artifacts, [artifact])
  assert.deepEqual(await consume(host, resultId), { id: resultId, duplicate: true })
  host.end(main)

  host.begin(main, '继续委托 ' + task)
  await waitForContinuation(host, task, resultId, 'verified')
  assert.equal((await completed(host, task, [artifact])).error, 'approved_artifacts_required')
  const review = { ...assignment('review', auditor, 'review'), reviewOf: producer.id, artifact }
  assert.equal((await dispatch({ ...review, artifact: wrongArtifact })).error, 'artifact_binding_required')
  const reviewJob = await dispatch(review)
  assert.equal(reviewJob.duplicate, false)
  assert.equal((await dispatch(assignment('over-budget', worker))).error, 'assignment_budget_exhausted')
  host.end(main)
  const lease = await claim(host, auditor, reviewJob.id)
  assert.equal(lease.reviewOf, producer.id)
  assert.equal(lease.artifact, artifact)
  assert.equal((await report(host, auditor, lease, { status: 'approved', reviewedArtifact: wrongArtifact })).error,
    'artifact_binding_required')
  assert.equal((await report(host, auditor, lease, { status: 'approved', reviewedArtifact: artifact })).recorded, true)
  host.end(auditor)

  assert.equal((await host.receive(main)).source.bridgeWorkflowId, reviewJob.id)
  assert.equal((await consume(host, reviewJob.id)).report.reviewedArtifact, artifact)
  host.end(main)
  host.begin(main, '继续委托 ' + task)
  await waitForContinuation(host, task, reviewJob.id, 'verified')
  assert.equal((await completed(host, task, [wrongArtifact])).error, 'artifact_binding_required')
  assert.deepEqual(await completed(host, task, [artifact]), closeRequest(task))
  assert.equal((await status(host)).outcome, undefined)
  host.end(main)
  host.begin(main, 'Read the audited synthetic closeout.')
  assert.deepEqual((await waitClosed(host)).outcome.finalArtifacts, [artifact])
  assert.equal(host.deliveries.filter(({ target }) => target === main).length, 2)
  host.end(main)
})

for (const interrupted of [false, true]) {
  const testName = interrupted
    ? 'interrupted result turn cannot leave collaboration successfully closed without reconciliation'
    : 'completed result turn settles one requested close after restart without another owner confirmation'
  test(testName, async t => {
    const host = await collaborationHost(t)
    host.begin(main, direct)
    const opened = await host.call(main, 'workflow_delegate_direct', {})
    assert.equal(opened.duplicate, false)
    host.end(main)
    const lease = await claim(host, worker, opened.id)
    assert.equal((await report(host, worker, lease)).recorded, true)
    host.end(worker)
    assert.equal((await host.receive(main)).source.bridgeWorkflowId, opened.id)
    assert.equal((await consume(host, opened.id)).duplicate, false)

    const requested = await completed(host, opened.task)
    // Interrupt before the controller can finish its result turn.
    host.end(main, interrupted ? 'aborted' : 'completed')
    await host.restart()
    host.begin(main, 'Read the synthetic result.')
    const { snapshot, continuation } = await waitForContinuation(host, opened.task, opened.id,
      interrupted ? 'interrupted' : 'verified')
    assert.equal(continuation.reconciliation, undefined)
    assert.equal(host.deliveries.filter(({ target }) => target === main).length, 1)
    if (interrupted) {
      assert.notEqual(snapshot.state, 'closed', 'An interrupted and unreconciled result was marked closed')
      assert.notEqual(snapshot.outcome?.status, 'completed')
    } else {
      assert.equal((await waitClosed(host, opened.task)).outcome?.status, 'completed')
    }
    assert.deepEqual(requested, closeRequest(opened.task))
    host.end(main)
  })
}

const firstAssignment = assignment('initial', worker)
const downstreamAssignment = assignment('downstream', reviewer)
const dispatchForClose = (host, input) => host.call(main, 'workflow_dispatch', { task, ...input })

async function openCloseout(host, ttlMinutes = 5) {
  const plan = { ...proposal, ttlMinutes, scopes: [proposal.scopes[0]] }
  const input = '请分派任务：让合成开发窗口制作候选，再让合成核查窗口核查。'
  host.reply(main, await prepare(host, plan, input))
  host.end(main)
  assert.deepEqual(host.deliveries, [])
  host.begin(main, '确认委托')
  assert.equal((await confirm(host)).duplicate, false)
  const first = await dispatchForClose(host, firstAssignment)
  assert.equal(first.duplicate, false, JSON.stringify(first))
  host.end(main)
  await reportAndConsume(host, worker, first.id)
  return first.id
}

async function reportAndConsume(host, target, id) {
  const lease = await claim(host, target, id)
  assert.equal((await report(host, target, lease)).recorded, true)
  host.end(target)
  assert.equal((await host.receive(main)).source.bridgeWorkflowId, id)
  assert.equal((await consume(host, id)).duplicate, false)
}

const wakeIds = host => host.deliveries.map(({ message }) => message.id)

function assertUnclosed(snapshot) {
  assert.equal(snapshot.error, undefined, JSON.stringify(snapshot))
  assert.notEqual(snapshot.state, 'closed', 'Closeout must wait for the required result evidence')
  assert.notEqual(snapshot.outcome?.status, 'completed')
}

test('a pending closeout freezes new work and duplicate requests, then settles once on completed turn evidence', async t => {
  const host = await collaborationHost(t)
  const id = await openCloseout(host)
  const originalWakes = wakeIds(host)

  const accepted = await completed(host)
  const pending = await status(host)
  assertUnclosed(pending)
  assert.deepEqual(accepted, closeRequest(task))
  assert.equal(pending.state, 'closing')
  assert.equal(pending.closure.state, 'pending')
  assert.deepEqual(await completed(host), closeRequest(task, true))
  assert.deepEqual(await host.call(main, 'workflow_close', {
    task, outcome: 'failed', summary: 'Conflicting synthetic closeout.',
  }), { error: 'close_conflict' })
  const single = await dispatchForClose(host, downstreamAssignment)
  assert.equal(typeof single.error, 'string', 'A closeout in progress must fence single dispatch')
  const batch = await host.call(main, 'workflow_dispatch_batch', {
    task, batch: 'while-closing', completion: 'A synthetic assignment while closing.',
    assignments: [downstreamAssignment],
  })
  assert.equal(typeof batch.error, 'string', 'A closeout in progress must fence batch dispatch')
  const unchanged = await status(host)
  assertUnclosed(unchanged)
  assert.deepEqual(unchanged.closure, pending.closure)
  assert.deepEqual(wakeIds(host), originalWakes)

  host.end(main)
  await host.restart()
  host.begin(main, 'Read the successful closeout.')
  const closed = await waitClosed(host)
  assert.equal(closed.closure.state, 'committed')
  assert.equal(closed.closure.turnEnd.reason, 'completed')
  assert.equal(closed.closedAt, closed.closure.turnEnd.time)
  assert.equal(closed.outcome?.status, 'completed')
  assert.equal(closed.outcome?.summary, 'Verified the synthetic result.')
  assert.deepEqual(closed.jobs.map(job => job.id), [id])
  const closedAt = closed.closedAt
  assert(Number.isFinite(closedAt))
  host.end(main)

  await host.restart()
  host.begin(main, '继续委托 ' + task)
  await completed(host)
  const readback = await status(host)
  assert.equal(readback.state, 'closed')
  assert.equal(readback.closedAt, closedAt)
  assert.deepEqual(readback.outcome, closed.outcome)
  assert.deepEqual(wakeIds(host), originalWakes)
  host.end(main)
})

for (const terminalState of ['cancelled', 'expired']) {
  test('pending closeout cannot report success after ' + terminalState + ' even if the result turn completes', async t => {
    const host = await collaborationHost(t)
    const now = Date.now
    let elapsed = 0
    t.mock.method(Date, 'now', () => now() + elapsed)
    const id = await openCloseout(host, 1)
    const originalWakes = wakeIds(host)

    const accepted = await completed(host)
    if (terminalState === 'cancelled') host.appendInput(main, '取消委托 ' + task)
    else elapsed = 61_000
    host.end(main)

    await host.restart()
    host.begin(main, 'Inspect the stopped synthetic closeout.')
    await waitForContinuation(host, task, id, terminalState === 'cancelled' ? 'interrupted' : 'verified')
    const snapshot = await waitForClosure(host, terminalState)
    assert.equal(snapshot.state, terminalState)
    assertUnclosed(snapshot)
    assert.deepEqual(accepted, closeRequest(task))
    assert.equal(snapshot.closure.state, terminalState)
    assert.deepEqual(wakeIds(host), originalWakes)
    host.end(main)
  })
}

test('restart without turn end preserves closeout uncertainty and the exact committed downstream attempt', async t => {
  const host = await collaborationHost(t)
  const first = await openCloseout(host)
  const downstream = await dispatchForClose(host, downstreamAssignment)
  assert.equal(downstream.duplicate, false, JSON.stringify(downstream))
  host.end(main)
  await reportAndConsume(host, reviewer, downstream.id)
  await waitForContinuation(host, task, first, 'verified')
  const accepted = await completed(host)
  const originalWakes = wakeIds(host)

  // The durable result was consumed, but the host did not record turn/end.
  await host.restart()
  host.begin(main, '继续委托 ' + task)
  const { snapshot, continuation } = await waitForContinuation(host, task, downstream.id, 'interrupted')
  assert.equal(continuation.reconciliation, undefined)
  assertUnclosed(snapshot)
  assert.deepEqual(accepted, closeRequest(task))
  const interrupted = await waitForClosure(host, 'interrupted')
  assert.equal(interrupted.closure.turnEnd, undefined)
  const original = snapshot.jobs.find(job => job.id === first)
  assert.deepEqual(original.continuation.continuation.dispatches, [downstream.id])
  host.end(main)
  host.begin(main, '继续委托 ' + task)
  assert.deepEqual(await dispatchForClose(host, downstreamAssignment), { id: downstream.id, duplicate: true })
  assert.deepEqual(await completed(host), { error: 'successful_attempts_required' })
  host.end(main)

  host.begin(main, '对账委托 ' + task + ' ' + downstream.id + ' result\n已核对合成结果和派工记录。')
  const reconciled = await status(host)
  const record = reconciled.jobs.find(job => job.id === downstream.id).continuation.continuation
  assert.equal(record.reconciliation?.decision, 'reviewed_without_replay')
  assert.equal(record.reconciliation?.owner, main)
  host.end(main)

  host.begin(main, '继续委托 ' + task)
  assert.deepEqual(await completed(host), closeRequest(task))
  host.end(main)
  host.begin(main, 'Read the reconciled synthetic closeout.')
  const closed = await waitClosed(host)
  assert.equal(closed.outcome.status, 'completed')
  assert.deepEqual(closed.previousClosure, interrupted.closure)
  assert.deepEqual(wakeIds(host), originalWakes)
  host.end(main)
})

test('restart can recover a durably completed closeout whose exact turn ended before expiry', async t => {
  const host = await collaborationHost(t)
  const now = Date.now
  let elapsed = 0
  t.mock.method(Date, 'now', () => now() + elapsed)
  await openCloseout(host, 1)
  assert.deepEqual(await completed(host), closeRequest(task))
  const pending = await status(host)
  host.end(main)
  elapsed = 61_000
  await host.restart()

  host.begin(main, 'Read the timely completed synthetic closeout.')
  const closed = await waitClosed(host)
  assert(Date.now() > pending.expiresAt)
  assert(closed.closure.turnEnd.time < pending.expiresAt)
  assert.deepEqual(closed.outcome, pending.closure.requestedOutcome)
  assert.equal(host.deliveries.length, 2)
  host.end(main)
})

test('a different input in the pending closeout turn prevents automatic success', async t => {
  const host = await collaborationHost(t)
  const id = await openCloseout(host)
  assert.deepEqual(await completed(host), closeRequest(task))
  host.appendInput(main, 'Handle a different synthetic request in this turn.')
  host.end(main)
  await host.restart()
  host.begin(main, 'Read the synthetic mixed closeout.')
  const { continuation } = await waitForContinuation(host, task, id, 'interrupted')
  assert.equal(continuation.reason, 'mixed_turn')
  const snapshot = await waitForClosure(host, 'interrupted')
  assertUnclosed(snapshot)
  assert.equal(snapshot.state, 'paused')
  assert.equal(snapshot.closure.reason, 'close_turn_evidence_unavailable')
  assert.equal(host.deliveries.length, 2)
  host.end(main)
})

const timeText = 'Time sampled while preparing turn 8, step 2: 2026-01-01T00:00:00+00:00[UTC]\n' +
  'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.\n' +
  'Elapsed since the preceding step context: 1s.'
const timeSnapshot = {
  kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text: timeText }],
}

function emitTimeSnapshot(host, session) {
  host.appendInput(session, timeText, timeSnapshot)
}

test('host time context does not consume or create the original owner confirmation', async t => {
  const host = await collaborationHost(t)
  host.begin(main, proposalInput)
  emitTimeSnapshot(host, main)
  const draft = await host.call(main, 'workflow_propose', proposal)
  assert.equal(draft.confirmation, 'owner_reply_required')
  host.reply(main, draft.preview)
  emitTimeSnapshot(host, main)
  host.end(main)
  assert.deepEqual(host.deliveries, [])

  host.begin(main, '确认委托')
  emitTimeSnapshot(host, main)
  assert.equal((await confirm(host)).duplicate, false)
  const saved = await status(host)
  assert.equal(saved.authorization.kind, 'native-owner-workflow-confirmation')
  assert(saved.authorization.preview.turn < saved.authorization.confirmation.turn)
  assert.deepEqual(host.deliveries, [])
  host.end(main)
})

test('a fixed host time snapshot preserves result authority and verified closeout across restart', async t => {
  const host = await collaborationHost(t)
  const first = await openCloseout(host)
  emitTimeSnapshot(host, main)
  const downstream = await dispatchForClose(host, downstreamAssignment)
  assert.equal(downstream.duplicate, false, JSON.stringify(downstream))
  host.end(main)

  const lease = await claim(host, reviewer, downstream.id)
  emitTimeSnapshot(host, reviewer)
  assert.equal((await report(host, reviewer, lease)).recorded, true)
  host.end(reviewer)
  assert.equal((await host.receive(main)).source.bridgeWorkflowId, downstream.id)
  emitTimeSnapshot(host, main)
  assert.equal((await consume(host, downstream.id)).duplicate, false)
  await waitForContinuation(host, task, first, 'verified')

  assert.deepEqual(await completed(host), closeRequest(task))
  emitTimeSnapshot(host, main)
  const pending = await status(host)
  assertUnclosed(pending)
  assert.equal(pending.closure.state, 'pending')
  const expectedWakes = wakeIds(host)
  host.end(main)
  await host.restart()

  host.begin(main, 'Read the synthetic time-context closeout.')
  const closed = await waitClosed(host)
  assert.equal(closed.closure.turnEnd.reason, 'completed')
  assert.equal(closed.outcome.status, 'completed')
  assert.deepEqual(closed.jobs.map(job => job.id), [first, downstream.id])
  assert.deepEqual(wakeIds(host), expectedWakes)
  host.end(main)
})

for (const [kind, source] of [
  ['owner', { kind: 'user', rpcId: 'synth-extra-owner-input' }],
  ['relay', relaySource],
  ['malformed snapshot', { ...timeSnapshot, sections: [{ name: 'time-context', text: 'Mismatched snapshot text.' }] }],
]) {
  test(kind + ' input with time-context text still blocks dispatch and pending closeout', async t => {
    const host = await collaborationHost(t)
    const id = await openCloseout(host)
    // Match the clock text without changing the input's native source.
    host.appendInput(main, timeText, source)
    assert.deepEqual(await dispatchForClose(host, downstreamAssignment), { error: 'workflow_context_required' })
    host.end(main)

    host.begin(main, 'Inspect the synthetic mixed result.')
    const { continuation } = await waitForContinuation(host, task, id, 'interrupted')
    assert.equal(continuation.reason, 'mixed_turn')
    host.end(main)
    host.begin(main, '对账委托 ' + task + ' ' + id + ' result\n已核对合成结果。')
    const reconciled = await status(host)
    assert.equal(reconciled.jobs[0].continuation.continuation.reconciliation.decision, 'reviewed_without_replay')
    host.end(main)

    host.begin(main, '继续委托 ' + task)
    assert.deepEqual(await completed(host), closeRequest(task))
    host.appendInput(main, timeText, source)
    host.end(main)
    await host.restart()

    host.begin(main, 'Read the synthetic mixed closeout.')
    const snapshot = await waitForClosure(host, 'interrupted')
    assertUnclosed(snapshot)
    assert.equal(snapshot.state, 'paused')
    assert.deepEqual(snapshot.jobs.map(job => job.id), [id])
    assert.equal(host.deliveries.length, 2)
    host.end(main)
  })
}

const ordinaryBody = '保持原样的合成消息。'
const ordinaryDraft = '请拟一条消息发给' + workerTitle
const sendNatural = (host, args = {}) => host.call(main, 'send_natural_session_message', args)

async function prepareOrdinaryDraft(host) {
  host.begin(main, ordinaryDraft)
  const prepared = await sendNatural(host, { draft: ordinaryBody })
  assert.equal(prepared.confirmation, 'owner_reply_required', JSON.stringify(prepared))
  assert(prepared.preview.includes(ordinaryBody))
  return prepared.preview
}

for (const phase of ['preview', 'confirmation']) {
  test('ordinary send preserves the confirmed draft across a host time snapshot during ' + phase, async t => {
    const host = await collaborationHost(t)
    const preview = await prepareOrdinaryDraft(host)
    if (phase === 'preview') emitTimeSnapshot(host, main)
    host.reply(main, preview)
    host.end(main)
    assert.deepEqual(host.deliveries, [])

    host.begin(main, '确认发送')
    if (phase === 'confirmation') emitTimeSnapshot(host, main)
    const sent = await sendNatural(host)
    assert.equal(sent.delivery, 'delivered', JSON.stringify(sent))
    assert.equal(sent.duplicate, false)
    const replay = await sendNatural(host)
    assert.equal(replay.duplicate, true)
    assert.equal(replay.messageId, sent.messageId)
    host.end(main)
    const received = await host.receive(worker)
    assert.equal(received.id, sent.messageId)
    assert.equal(received.source.senderSessionId, main)
    assert(received.content[0].text.endsWith('\n' + ordinaryBody))
    assert.equal(host.deliveries.length, 1)
    host.end(worker)
  })
}

for (const [kind, source] of [
  ['owner', { kind: 'user', rpcId: 'synth-extra-owner-input' }],
  ['relay', relaySource],
]) {
  test('ordinary send still rejects confirmation followed by ' + kind + ' input with time-context text', async t => {
    const host = await collaborationHost(t)
    host.reply(main, await prepareOrdinaryDraft(host))
    host.end(main)

    host.begin(main, '确认发送')
    host.appendInput(main, timeText, source)
    assert.deepEqual(await sendNatural(host), { error: 'message_authorization_required' })
    assert.deepEqual(host.deliveries, [])
    host.end(main)
  })
}

test('ordinary exact owner text still delivers once when the host inserts time context', async t => {
  const host = await collaborationHost(t)
  host.begin(main, '给' + workerTitle + '发消息：' + ordinaryBody)
  emitTimeSnapshot(host, main)
  const sent = await sendNatural(host)
  assert.equal(sent.delivery, 'delivered', JSON.stringify(sent))
  assert.equal(sent.duplicate, false)
  const replay = await sendNatural(host)
  assert.equal(replay.duplicate, true)
  assert.equal(replay.messageId, sent.messageId)
  host.end(main)
  const received = await host.receive(worker)
  assert.equal(received.id, sent.messageId)
  assert(received.content[0].text.endsWith('\n' + ordinaryBody))
  assert.equal(host.deliveries.length, 1)
  host.end(worker)
})
