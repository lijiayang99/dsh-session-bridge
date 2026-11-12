import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { fixture, main, reviewer, secondMain, until, worker } from './host-fixture.mjs'

const task = 'synth-shared-task'
const dispatch = {
  task, item: 'synth-build', attempt: 1, target: worker, scope: 'develop',
  instructions: 'Produce a synthetic candidate.', acceptance: 'Return its synthetic reference.',
}
const nextDispatch = {
  ...dispatch, item: 'synth-review', target: reviewer, scope: 'review',
  instructions: 'Check the synthetic candidate.',
}

function authorize(host, owner = main, name = task, target = worker) {
  host.begin(owner, '授权委托\n' + JSON.stringify({
    task: name, ttlMinutes: 1, goal: 'Verify a synthetic candidate.',
    scopes: [{ name: 'develop', targets: [target] }, { name: 'review', targets: [reviewer] }],
  }))
}

async function queue(host, owner = main, input = dispatch) {
  const result = await host.call(owner, 'workflow_dispatch', input)
  assert.equal(result.duplicate, false, JSON.stringify(result))
  return result.id
}

async function claim(host, id) {
  const result = await host.call(worker, 'workflow_claim', { id })
  assert.equal(result.duplicate, false, JSON.stringify(result))
  return result
}

const itemStatus = (host, id, name = task, owner = main) =>
  host.call(owner, 'workflow_item_status', { task: name, id })

const reportFor = (id, token, owner) => ({
  id, token, attempt: 1, status: 'completed',
  summary: 'Synthetic result for ' + owner,
  evidence: ['synthetic-candidate/' + owner],
})

test('shared worker keeps same-named jobs, report evidence and attempt identities with each owner', async t => {
  const host = await fixture(t)
  const inputs = new Map([
    [main, { ...dispatch, instructions: 'Synthetic candidate from the first owner.' }],
    [secondMain, { ...dispatch, instructions: 'Synthetic candidate from the second owner.' }],
  ])
  for (const owner of inputs.keys()) authorize(host, owner)
  const ids = new Map(await Promise.all([...inputs].map(async ([owner, input]) => [owner, await queue(host, owner, input)])))
  assert.notEqual(ids.get(main), ids.get(secondMain))
  for (const [owner, input] of inputs) {
    assert.deepEqual(await host.call(owner, 'workflow_dispatch', input), { id: ids.get(owner), duplicate: true })
    assert.equal((await host.call(owner, 'workflow_dispatch', { ...input, instructions: 'Changed payload' })).error,
      'attempt_conflict')
    const other = owner === main ? secondMain : main
    assert.equal((await itemStatus(host, ids.get(other), task, owner)).error, 'job_not_found')
    const view = await host.call(owner, 'workflow_status', { task })
    assert.deepEqual(view.jobs.map(({ id }) => id), [ids.get(owner)])
    host.end(owner)
  }

  const serviced = new Set()
  for (let index = 0; index < ids.size; index++) {
    const wake = await host.receive(worker)
    const owner = wake.source.senderSessionId
    const id = ids.get(owner)
    assert(id)
    assert(!serviced.has(owner))
    serviced.add(owner)
    assert.equal(wake.source.bridgeWorkflowId, id)
    assert.equal(host.deliveries.filter(({ target }) => target === worker).length, index + 1)

    const other = owner === main ? secondMain : main
    assert.equal((await host.call(worker, 'workflow_claim', { id: ids.get(other) })).error, 'task_wake_required')
    const lease = await claim(host, id)
    assert.equal(lease.owner, owner)
    assert.equal(lease.instructions, inputs.get(owner).instructions)
    assert.deepEqual(await host.call(worker, 'workflow_claim', { id }), { id, duplicate: true })
    const report = reportFor(id, lease.token, owner)
    assert.equal((await host.call(worker, 'workflow_report', { ...report, token: randomUUID() })).error, 'claim_mismatch')
    assert.equal((await host.call(worker, 'workflow_report', report)).duplicate, false)
    assert.equal((await host.call(worker, 'workflow_report', report)).duplicate, true)
    assert.equal((await host.call(worker, 'workflow_report', { ...report, summary: 'Changed report' })).error, 'report_conflict')
    host.end(worker)

    const returned = await host.receive(owner)
    assert.equal(returned.source.bridgeWorkflowId, id)
    assert.equal((await host.call(owner, 'workflow_consume', { id: ids.get(other) })).error, 'result_wake_required')
    const result = await host.call(owner, 'workflow_consume', { id })
    assert.equal(result.report.reporter, worker)
    assert.equal(result.report.summary, report.summary)
    assert.deepEqual(result.report.evidence, report.evidence)
    assert.deepEqual(await host.call(owner, 'workflow_consume', { id }), { id, duplicate: true })
    host.end(owner)
  }
  assert.deepEqual(serviced, new Set(ids.keys()))
  assert.equal(host.deliveries.length, 4)
})

test('self-authorization and mixed owner turns cannot open a workflow, and an expired queued job cannot wake', async t => {
  const host = await fixture(t)
  const now = Date.now
  let elapsed = 0
  t.mock.method(Date, 'now', () => now() + elapsed)

  authorize(host, main, task, main)
  assert.equal((await host.call(main, 'workflow_dispatch', { ...dispatch, target: main })).error, 'main_task_context_required')
  host.end(main)
  authorize(host)
  host.appendInput(main, 'Unrelated input in the same synthetic turn.')
  assert.equal((await host.call(main, 'workflow_dispatch', dispatch)).error, 'workflow_context_required')
  host.end(main)

  host.begin(worker, 'Keep the synthetic worker occupied.')
  authorize(host)
  const id = await queue(host)
  elapsed = 61_000
  host.end(worker)
  const state = await until(async () => {
    const state = await itemStatus(host, id)
    return state.delivery?.state === 'skipped' && state
  }, 'Expected expiration before delivery')
  assert.equal(state.grantState, 'expired')
  assert.equal(state.delivery.reason, 'expired')
  assert.equal(host.deliveries.length, 0)
  host.end(main)
})

test('a destination failure before admission leaves the independent destination usable', async t => {
  const host = await fixture(t)
  let failed = 0
  host.faults.resolve = id => {
    if (id === worker) {
      failed++
      throw new Error('Synthetic destination resolution failure')
    }
  }
  authorize(host)
  const missing = await queue(host)
  const unaffected = await queue(host, main, nextDispatch)
  host.end(main)
  assert.equal((await host.receive(reviewer)).source.bridgeWorkflowId, unaffected)
  host.begin(main, 'Read the synthetic destination failure receipt.')
  const state = await until(async () => {
    const { delivery } = await itemStatus(host, missing)
    return delivery?.state === 'failed' && delivery
  }, 'Expected recorded destination failure')
  assert.equal(state.reason, 'destination_resolution_failed_before_send')
  assert.equal(failed, 1)
  assert.deepEqual(host.deliveries.map(({ target }) => target), [reviewer])
  host.end(reviewer)
  host.end(main)
})

test('a reserved structured dispatch still needs the original owner turn to complete cleanly', async t => {
  const host = await fixture(t)
  authorize(host)
  const id = await queue(host)
  host.appendInput(main, 'This synthetic turn now contains a second owner input.')
  host.end(main)

  host.begin(main, 'Read the synthetic structured dispatch receipt.')
  const failed = await until(async () => {
    const { delivery } = await itemStatus(host, id)
    return delivery?.state === 'skipped' && delivery
  }, 'Expected the queued attempt to be rejected after the mixed owner turn')
  assert.equal(failed.reason, 'owner_turn_not_verified')
  assert.deepEqual(host.deliveries, [])
  host.end(main)
})

test('restart recovers task and result already appended to the durable inbox without appending again', async t => {
  const host = await fixture(t)
  const appended = []
  host.faults.afterFollowup = (target, message) => {
    appended.push({ target, id: message.id })
    if (target === worker) throw new Error('Synthetic failure after task inbox append')
  }

  let failedResultFlush = false
  host.faults.flush = id => {
    if (id === main && !failedResultFlush) {
      failedResultFlush = true
      return false
    }
    return true
  }

  authorize(host)
  const id = await queue(host)
  host.end(main)
  await until(() => appended.length === 1, 'Expected task appended before failure')
  await host.restart()
  await until(() => host.wakes.includes(worker), 'Expected recovered native worker wake')
  assert.equal((await host.receive(worker)).id, appended[0].id)
  const lease = await claim(host, id)
  const report = reportFor(id, lease.token, main)
  assert.equal((await host.call(worker, 'workflow_report', report)).recorded, true)
  host.end(worker)

  await until(() => failedResultFlush, 'Expected the injected result flush failure')
  await host.restart()
  await until(() => host.wakes.includes(main), 'Expected recovered native owner wake')
  assert.equal((await host.receive(main)).id, appended[1].id)
  const result = await host.call(main, 'workflow_consume', { id })
  assert.equal(result.duplicate, false)
  assert.deepEqual(result.report.evidence, report.evidence)
  host.end(main)

  host.begin(main, 'Inspect the synthetic task.')
  await until(async () => (await itemStatus(host, id)).continuation?.continuation?.state === 'verified',
    'Expected the original result turn to settle')
  assert.deepEqual(host.deliveries.map(({ target, message }) => ({ target, id: message.id })), appended)
  assert.deepEqual(appended.map(({ target }) => target), [worker, main])
  host.end(main)
})

test('restart without durable admission evidence records uncertainty and avoids resend', async t => {
  const host = await fixture(t)
  host.faults.afterFollowup = () => { throw new Error('Synthetic interruption after append') }
  authorize(host)
  const id = await queue(host)
  host.end(main)
  await until(() => host.deliveries.length === 1, 'Expected initial native append')
  host.faults.read = destination => {
    assert.equal(destination, worker)
    throw new Error('Synthetic persistence read failure')
  }
  await host.restart()
  host.begin(main, 'Inspect the synthetic task.')
  const delivery = await until(async () => {
    const { delivery } = await itemStatus(host, id)
    return delivery?.state === 'uncertain' && delivery
  }, 'Expected uncertainty when admission cannot be proved')
  assert.equal(delivery.reason, 'host_evidence_unavailable')
  host.end(main)

  // Restoring reads cannot replay the unresolved operation.
  delete host.faults.read
  await host.restart()
  host.begin(main, '继续委托 ' + task)
  assert.deepEqual(await host.call(main, 'workflow_dispatch', dispatch), { id, duplicate: true })
  assert.equal((await itemStatus(host, id)).delivery.state, 'uncertain')
  assert.equal(host.deliveries.length, 1)
  assert.deepEqual(host.wakes, [])
  host.end(main)
})

test('owner cancellation stops a queued job and keeps a late report without waking the owner', async t => {
  const host = await fixture(t)
  const queuedTask = 'synth-queued-cancel'
  host.begin(worker, 'Keep the synthetic worker occupied.')
  authorize(host, main, queuedTask)
  const waiting = await queue(host, main, { ...dispatch, task: queuedTask })
  host.end(main)
  host.begin(main, '取消委托 ' + queuedTask)
  host.end(worker)
  const stopped = await until(async () => {
    const state = await itemStatus(host, waiting, queuedTask)
    return state.delivery?.state === 'skipped' && state
  }, 'Expected cancellation before delivery')
  assert.equal(stopped.grantState, 'cancelled')
  assert.equal(host.deliveries.length, 0)
  host.end(main)

  authorize(host)
  const id = await queue(host)
  host.end(main)
  assert.equal((await host.receive(worker)).source.bridgeWorkflowId, id)
  const lease = await claim(host, id)
  host.begin(main, '取消委托 ' + task)
  assert.equal((await itemStatus(host, id)).grantState, 'cancelled')
  host.end(main)
  const late = await host.call(worker, 'workflow_report', reportFor(id, lease.token, main))
  assert.equal(late.recorded, true)
  assert.equal(late.late, true)
  host.end(worker)
  await host.restart()
  host.begin(main, 'Inspect the synthetic task.')
  const final = await itemStatus(host, id)
  assert.equal(final.report.late, true)
  assert.equal(final.continuation, undefined)
  assert.deepEqual(host.deliveries.map(({ target }) => target), [worker])
  host.end(main)
})

for (const phase of ['before_dispatch', 'after_dispatch']) {
  test('restart settles the interrupted continuation ' + phase + ' without replaying its result', async t => {
    const host = await fixture(t)
    authorize(host)
    const id = await queue(host)
    host.end(main)
    await host.receive(worker)
    const lease = await claim(host, id)
    assert.equal((await host.call(worker, 'workflow_report', reportFor(id, lease.token, main))).recorded, true)
    host.end(worker)

    await host.receive(main)
    assert.equal((await host.call(main, 'workflow_consume', { id })).duplicate, false)
    let downstream
    if (phase === 'after_dispatch') {
      host.begin(reviewer, 'Hold the downstream job until restart.')
      downstream = await queue(host, main, nextDispatch)
    }
    await host.restart()
    host.begin(main, '继续委托 ' + task)
    const continuation = await until(async () => {
      const record = (await itemStatus(host, id)).continuation?.continuation
      return record?.state === 'interrupted' && record
    }, 'Expected interrupted result turn after restart')
    assert.equal(continuation.phase, phase)
    assert.deepEqual(continuation.dispatches, downstream ? [downstream] : [])
    assert.equal(host.deliveries.filter(({ target }) => target === main).length, 1)
    if (downstream) {
      assert.deepEqual(await host.call(main, 'workflow_dispatch', nextDispatch), { id: downstream, duplicate: true })
      assert.equal((await host.receive(reviewer)).source.bridgeWorkflowId, downstream)
      assert.equal(host.deliveries.filter(({ target }) => target === reviewer).length, 1)
      host.end(reviewer)
    }
    host.end(main)
  })
}

test('30-window synthetic workload drains 40 jobs and 40 results without cross-routing or duplicate appends', async t => {
  const owners = [main, secondMain, ...Array.from({ length: 8 }, (_, index) => 'synth-owner-' + index)]
  const workers = [worker, reviewer, ...Array.from({ length: 18 }, (_, index) => 'synth-worker-' + index)]
  const host = await fixture(t, { additionalSessions: [...owners.slice(2), ...workers.slice(2)] })
  const queued = new Map()
  const reported = new Map()
  const taskWaits = []
  const resultWaits = []
  const startedAt = performance.now()
  const startedItems = new Set()
  const consumedItems = new Set()

  await Promise.all(owners.map(async (owner, index) => {
    const targets = Array.from({ length: 4 }, (_, offset) => workers[(index * 4 + offset) % workers.length])
    host.begin(owner, '授权委托\n' + JSON.stringify({
      task, ttlMinutes: 2, goal: 'Synthetic parallel batch.',
      scopes: [{ name: 'develop', targets }],
    }))
    for (const [offset, target] of targets.entries()) {
      const input = { ...dispatch, item: 'synth-item-' + offset, target, instructions: 'Synthetic ' + owner + ' item ' + offset }
      const queuedAt = performance.now()
      const id = await queue(host, owner, input)
      assert(!queued.has(id))
      queued.set(id, { owner, input, queuedAt })
    }
    host.end(owner)
  }))

  await Promise.all([
    ...workers.map(async target => {
      for (let count = 0; count < 2; count++) {
        const wake = await host.receive(target)
        const id = wake.source.bridgeWorkflowId
        const expected = queued.get(id)
        assert(expected)
        assert(!startedItems.has(id))
        startedItems.add(id)
        assert.equal(target, expected.input.target)
        assert.equal(wake.source.senderSessionId, expected.owner)
        taskWaits.push(performance.now() - expected.queuedAt)
        const lease = await host.call(target, 'workflow_claim', { id })
        assert.equal(lease.duplicate, false)
        assert.equal(lease.instructions, expected.input.instructions)
        assert.equal(lease.owner, expected.owner)
        const report = reportFor(id, lease.token, expected.owner)
        reported.set(id, { report, reportedAt: performance.now() })
        assert.equal((await host.call(target, 'workflow_report', report)).recorded, true)
        host.end(target)
      }
    }),
    ...owners.map(async owner => {
      for (let count = 0; count < 4; count++) {
        const wake = await host.receive(owner)
        const id = wake.source.bridgeWorkflowId
        const expected = queued.get(id)
        assert(expected)
        assert(!consumedItems.has(id))
        consumedItems.add(id)
        assert.equal(expected.owner, owner)
        assert.equal(wake.source.senderSessionId, expected.input.target)
        const { report, reportedAt } = reported.get(id)
        resultWaits.push(performance.now() - reportedAt)
        const result = await host.call(owner, 'workflow_consume', { id })
        assert.equal(result.duplicate, false)
        assert.equal(result.report.summary, report.summary)
        assert.deepEqual(result.report.evidence, report.evidence)
        host.end(owner)
      }
    }),
  ])

  assert.equal(queued.size, 40)
  assert.deepEqual(startedItems, new Set(queued.keys()))
  assert.deepEqual(consumedItems, startedItems)
  assert.equal(host.deliveries.length, 80)
  assert.equal(new Set(host.deliveries.map(({ message }) => message.id)).size, 80)
  assert.deepEqual(host.warnings, [])
  t.diagnostic('30 synthetic windows, 40 task appends and 40 result appends')
  t.diagnostic('Milliseconds from dispatch/report call to wake receipt. ' + JSON.stringify({
    elapsed: Math.round(performance.now() - startedAt),
    maxTaskQueue: Math.round(Math.max(...taskWaits)),
    maxResultQueue: Math.round(Math.max(...resultWaits)),
  }))
})
