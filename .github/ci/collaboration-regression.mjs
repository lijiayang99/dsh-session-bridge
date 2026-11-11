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

async function prepare(host) {
  host.begin(main, proposalInput)
  const result = await host.call(main, 'workflow_propose', proposal)
  assert.equal(result.confirmation, 'owner_reply_required', JSON.stringify(result))
  assert(result.preview.includes('任务预算 3 次派工'))
  for (const title of [workerTitle, reviewerTitle, auditorTitle]) assert(result.preview.includes(title))
  return result.preview
}

const confirm = (host, id = main) => host.call(id, 'workflow_confirm', {})
const status = (host, name = task) => host.call(main, 'workflow_status', { task: name })
const completed = (host, name = task, refs) => host.call(main, 'workflow_close', {
  task: name, outcome: 'completed', summary: 'Verified the synthetic result.',
  ...(refs ? { finalArtifacts: refs } : {}),
})
const consume = (host, id) => host.call(main, 'workflow_consume', { id })

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
  const closed = await completed(host, task, [artifact])
  assert.equal(closed.state, 'closed')
  assert.deepEqual(closed.outcome.finalArtifacts, [artifact])
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

    await completed(host, opened.task)
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
      const closed = await until(async () => {
        const current = await status(host, opened.task)
        return current.state === 'closed' && current
      }, 'Expected closeout after the original result turn completed')
      assert.equal(closed.outcome?.status, 'completed')
    }
    host.end(main)
  })
}
