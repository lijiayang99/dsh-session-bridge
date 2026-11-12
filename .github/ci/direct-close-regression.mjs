import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixture, main, relaySource, until, worker } from './host-fixture.mjs'

const question = '你给合成查询这个窗口问他今天气温怎么样'
const answer = '合成气温是 21°C。'
const route = [worker, main]

async function lab(t) {
  const host = await fixture(t)
  host.rename(worker, '合成查询')
  const ledger = new DatabaseSync(join(process.env.DSH_HOME, 'profile', 'dsh-session-bridge-workflow', 'workflow-v1.sqlite'))
  t.after(() => ledger.close())
  const body = (table, field, id) =>
    JSON.parse(ledger.prepare('SELECT body FROM ' + table + ' WHERE ' + field + ' = ?').get(id)?.body ?? 'null')
  const active = () => body('ledger', 'id', 1)
  const change = mutate => {
    const state = active()
    mutate(state)
    ledger.prepare('UPDATE ledger SET body = ? WHERE id = 1').run(JSON.stringify(state))
  }
  const history = opened => body('job_history', 'id', opened.id)
  const key = opened => main + ':' + opened.task
  const grant = opened => active().grants[key(opened)] ?? body('grant_history', 'key', key(opened))
  return { host, active, change, history, key, grant }
}

async function open(host) {
  const input = host.begin(main, question)
  host.end(main)
  const { task, grant, job } = await host.directAssignment(main, input)
  return { task, expiresAt: grant.expiresAt, id: job.id }
}

async function result(host, opened, { status = 'completed', afterAdmission, beforeReport } = {}) {
  assert.equal((await host.receive(worker)).source.bridgeWorkflowId, opened.id)
  if (afterAdmission) await afterAdmission()
  const lease = await host.call(worker, 'workflow_claim', { id: opened.id })
  assert.equal(lease.duplicate, false)
  if (beforeReport) await beforeReport()
  const report = await host.call(worker, 'workflow_report', {
    id: lease.id, attempt: lease.attempt, token: lease.token, status,
    summary: answer, evidence: ['synthetic-query'],
  })
  assert.equal(report.duplicate, false, JSON.stringify(report))
  host.end(worker)
  if (!report.late) assert.equal((await host.receive(main)).source.bridgeWorkflowId, opened.id)
  return report
}

async function consume(host, opened) {
  const reply = await host.call(main, 'workflow_consume', { id: opened.id })
  assert.equal(reply.duplicate, false, JSON.stringify(reply))
  assert.equal(reply.report.summary, answer)
}

function fillGrantSlots(change) {
  change(({ grants }) => {
    for (let i = 0; i < 127; i++) {
      const task = 'synthetic-capacity-slot-' + i
      grants[main + ':' + task] = {
        task, owner: main, goal: 'Synthetic live grant', scopes: [{ name: 'execute', targets: [worker] }],
        expiresAt: Date.now() + 60 * 60_000, state: 'active', openedAt: Date.now(),
        ownerMessageId: 'synthetic-message-' + i, ownerTurn: i,
      }
    }
  })
}

test('a verified one-shot reply releases a slot and retains its history at the 128-grant limit', async t => {
  const { host, active, change, grant, history, key } = await lab(t)
  fillGrantSlots(change)
  const opened = await open(host)
  assert.equal(Object.keys(active().grants).length, 128)
  await result(host, opened, { async afterAdmission() {
    host.begin(main, question)
    host.end(main)
    const refused = await host.receive(main)
    assert.equal(refused.source.bridgeWorkflowKind, 'direct-notice')
    assert.match(refused.content[0].text, /无法建立/)
    host.end(main)
    assert.equal(Object.keys(active().grants).length, 128)
  } })
  await consume(host, opened)
  host.reply(main, answer)
  assert.equal(grant(opened).state, 'collaboration_active')
  host.end(main)
  const archived = await until(() => history(opened), 'Expected the completed attempt in history')
  assert.deepEqual(host.deliveries.filter(({ message }) => message.source.bridgeWorkflowKind !== 'direct-notice')
    .map(({ target }) => target), route)
  const next = await open(host)
  assert.notEqual(next.id, opened.id)
  assert.equal(archived.resume.continuation.state, 'verified')
  assert(Number.isSafeInteger(archived.resume.continuation.replyAfterSeq))
  assert.equal(active().grants[key(opened)], undefined)
  const closed = grant(opened)
  assert.equal(closed.state, 'closed')
  assert.equal(closed.closedTurn, archived.resume.continuation.turn)
  assert(closed.closedAt < closed.expiresAt)
  assert.deepEqual(closed.outcome, { status: 'completed', summary: answer, finalArtifacts: [] })
})

for (const [name, action, state, continuation, status, legacyResult] of [
  ['a reply emitted before consumption', (host, opened) => {
    host.reply(main, answer)
    return consume(host, opened)
  }, 'collaboration_active', 'verified', undefined, true],
  ['a whitespace-only reply', async (host, opened) => {
    await consume(host, opened)
    host.reply(main, ' \n ')
  }, 'collaboration_active', 'verified', undefined, true],
  ['an interrupted assistant message', async (host, opened) => {
    await consume(host, opened)
    host.reply(main, answer, true)
  }, 'collaboration_active', 'verified', undefined, true],
  ['a mixed result turn', async (host, opened) => {
    await consume(host, opened)
    host.reply(main, answer)
    host.appendInput(main, '合成中继插入。', relaySource)
  }, 'collaboration_active', 'interrupted'],
  ['a failed report', async (host, opened) => {
    await consume(host, opened)
    host.reply(main, answer)
  }, 'collaboration_active', 'verified', 'failed'],
  ['a report requiring owner action', async (host, opened) => {
    await consume(host, opened)
    host.reply(main, answer)
  }, 'collaboration_paused', 'verified', 'needs_owner'],
  ['an owner cancellation after consumption', async (host, opened) => {
    await consume(host, opened)
    host.reply(main, answer)
    host.appendInput(main, '取消委托 ' + opened.task)
  }, 'cancelled', 'interrupted'],
]) {
  const label = legacyResult ? 'a historical direct result' : 'a direct result'
  test(label + ' does not implicitly close with ' + name, async t => {
    const { host, grant, history, change } = await lab(t)
    const opened = await open(host)
    await result(host, opened, { status, beforeReport() {
      if (legacyResult) change(({ jobs }) => { delete jobs[opened.id].nativeResult })
    } })
    await action(host, opened)
    host.end(main)
    const archived = await until(() => history(opened), 'Expected result settlement for ' + name)
    assert.equal(archived.resume.continuation.state, continuation)
    assert.equal(grant(opened).state, state)
    assert.equal(grant(opened).outcome, undefined)
    assert.deepEqual(host.deliveries.map(({ target }) => target), route)
  })
}

test('direct result restart uses durable evidence and never replays either wake', async t => {
  const { host, grant, history } = await lab(t)
  const opened = await open(host)
  await result(host, opened)
  await consume(host, opened)
  await host.restart(() => {
    host.reply(main, answer)
    host.end(main)
  })
  const archived = await until(() => history(opened), 'Expected result settlement after restart')
  assert.equal(archived.resume.continuation.state, 'verified')
  assert.equal(grant(opened).state, 'closed')
  assert.deepEqual(host.deliveries.map(({ target }) => target), route)
})

test('a durable reply lacking the consumption sequence from newer builds stays open on restart', async t => {
  const { host, grant, history, change } = await lab(t)
  const opened = await open(host)
  await result(host, opened)
  await consume(host, opened)
  await host.restart(() => {
    change(({ jobs }) => {
      delete jobs[opened.id].resume.continuation.replyAfterSeq
    })
    host.reply(main, answer)
    host.end(main)
  })
  const archived = await until(() => history(opened), 'Expected older result evidence to remain readable')
  assert.equal(archived.resume.continuation.state, 'verified')
  assert.equal(archived.resume.continuation.replyAfterSeq, undefined)
  assert.equal(grant(opened).state, 'collaboration_active')
  assert.equal(grant(opened).outcome, undefined)
  assert.deepEqual(host.deliveries.map(({ target }) => target), route)
})

test('a report submitted after owner cancellation stays late and does not wake the controller', async t => {
  const { host, grant, history } = await lab(t)
  const opened = await open(host)
  const report = await result(host, opened, { beforeReport() {
    host.begin(main, '取消委托 ' + opened.task)
    host.end(main)
  } })
  assert.equal(report.late, true)
  const archived = await until(() => history(opened), 'Expected the late attempt in history')
  assert.equal(archived.report.late, true)
  assert.equal(archived.resume, undefined)
  assert.equal(grant(opened).state, 'cancelled')
  assert.deepEqual(host.deliveries.map(({ target }) => target), [worker])
})

test('a direct result that ended within its deadline still closes if restart is after expiry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const { host, grant, history } = await lab(t)
  const opened = await open(host)
  await result(host, opened)
  await consume(host, opened)
  await host.restart(() => {
    host.reply(main, answer)
    host.end(main)
    assert(Date.now() < opened.expiresAt)
    t.mock.timers.tick(opened.expiresAt - Date.now() + 1)
  })
  const archived = await until(() => history(opened), 'Expected the within-deadline native result to be recovered')
  assert.equal(archived.resume.continuation.state, 'verified')
  assert.deepEqual(host.deliveries.map(({ target }) => target), route)
  assert.equal(grant(opened).state, 'closed')
  assert(grant(opened).closedAt < opened.expiresAt)
})

test('a direct result whose reply ends after the deadline remains expired after restart', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const { host, grant, history } = await lab(t)
  const opened = await open(host)
  await result(host, opened)
  await consume(host, opened)
  await host.restart(() => {
    host.reply(main, answer)
    t.mock.timers.tick(opened.expiresAt - Date.now() + 1)
    host.end(main)
  })
  const archived = await until(() => history(opened), 'Expected the expired result to be settled')
  assert.equal(archived.resume.continuation.state, 'verified')
  assert.equal(grant(opened).state, 'expired')
  assert.equal(grant(opened).outcome, undefined)
  assert.deepEqual(host.deliveries.map(({ target }) => target), route)
})

test('an expired grant awaiting proof cannot resume work and releases its slot after recovery', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const { host, active, change, grant, history, key } = await lab(t)
  fillGrantSlots(change)
  const opened = await open(host)
  assert.equal(Object.keys(active().grants).length, 128)
  await result(host, opened)
  await consume(host, opened)
  let inspecting = false
  const releaseRead = Promise.withResolvers()
  try {
    await host.restart(() => {
      host.reply(main, answer)
      host.end(main)
      t.mock.timers.tick(opened.expiresAt - Date.now() + 1)
      host.faults.read = id => {
        if (id !== main) return
        inspecting = true
        return releaseRead.promise
      }
    })
    await until(() => inspecting || !active().grants[key(opened)], 'Expected pending evidence inspection')
    assert(active().grants[key(opened)], 'Expected the expired grant to remain available to recovery')
    host.begin(main, '继续委托 ' + opened.task)
    assert.equal((await host.call(main, 'workflow_status', { task: opened.task })).state, 'expired')
    assert.deepEqual(await host.call(main, 'workflow_dispatch', {
      task: opened.task, item: 'execute', attempt: 2, scope: 'execute', target: worker,
      instructions: answer, acceptance: answer,
    }), { error: 'main_task_context_required' })
    assert.deepEqual(await host.call(main, 'workflow_consume', { id: opened.id }), { error: 'result_wake_required' })
    host.end(main)
    assert.deepEqual(host.deliveries.map(({ target }) => target), route)
  } finally {
    releaseRead.resolve()
    delete host.faults.read
  }

  const archived = await until(() => history(opened), 'Expected the checked attempt to reach history')
  assert.equal(archived.resume.continuation.state, 'verified')
  assert.equal(grant(opened).state, 'closed')
  assert.equal(Object.keys(active().grants).length, 127)
  assert.deepEqual(host.deliveries.map(({ target }) => target), route)
  assert((await open(host)).id)
})

for (const [name, complete, reason] of [
  ['the result turn has no normal end', false, 'turn_end_not_proven'],
  ['the durable event history cannot be read', true, 'turn_evidence_unavailable'],
]) {
  test('restart archives an expired direct grant when ' + name, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    const { host, active, grant, history, key } = await lab(t)
    const opened = await open(host)
    await result(host, opened)
    await consume(host, opened)
    await host.restart(() => {
      host.reply(main, answer)
      if (complete) {
        host.end(main)
        host.faults.read = () => { throw new Error('Synthetic unavailable result history') }
      }
      t.mock.timers.tick(opened.expiresAt - Date.now() + 1)
    })
    const archived = await until(() => history(opened), 'Expected the expired attempt in history')
    assert.equal(archived.resume.continuation.state, 'interrupted')
    assert.equal(archived.resume.continuation.reason, reason)
    assert.equal(active().grants[key(opened)], undefined)
    assert.equal(grant(opened).state, 'expired')
    assert.equal(grant(opened).outcome, undefined)
    assert.deepEqual(host.deliveries.map(({ target }) => target), route)
  })
}

test('a completed exact owner turn delegates and shows the structured native result without controller tools', async t => {
  const { host, active, grant, history } = await lab(t)
  host.begin(main, question)
  assert.deepEqual(active().jobs, {})
  assert.deepEqual(host.deliveries, [])
  host.end(main)
  const notice = await host.receive(worker)
  const id = notice.source.bridgeWorkflowId
  const job = active().jobs[id]
  const task = job.key.slice(main.length + 1)
  const opened = { id, task }
  assert.equal(job.instructions, '今天气温怎么样')
  assert.equal(grant(opened).state, 'collaboration_active')
  assert.equal(grant(opened).authorization.ownerTurnEnd.reason, 'completed')
  assert.deepEqual(grant(opened).authorization.targets, [{ id: worker, title: '合成查询' }])

  const lease = await host.call(worker, 'workflow_claim', { id })
  const report = { id, attempt: lease.attempt, token: lease.token, status: 'completed',
    summary: answer, evidence: ['synthetic-query'] }
  assert.equal((await host.call(worker, 'workflow_report', report)).duplicate, false)
  assert.equal((await host.call(worker, 'workflow_report', report)).duplicate, true)
  host.end(worker)
  const reply = await host.receive(main)
  assert.equal(reply.source.bridgeWorkflowOwner, main)
  assert.equal(reply.source.bridgeWorkflowId, id)
  assert.equal(reply.content[0].text, '委托回报 · 已完成\n\n' + answer + '\n\n证据\nsynthetic-query')

  await host.restart(() => host.end(main))
  const archived = await until(() => history(opened), 'Expected the native report to be archived after restart')
  assert.equal(archived.resume.id, reply.id)
  assert.equal(archived.resume.continuation.presentation, 'native-result')
  assert.equal(archived.resume.continuation.state, 'verified')
  assert.equal(grant(opened).state, 'closed')
  assert.deepEqual(host.deliveries.map(({ target }) => target), route)
})

test('a host-created receipt stays idempotent when the target changes before verified owner admission', async t => {
  const { host, grant, history } = await lab(t)
  host.begin(main, question)
  const opened = await host.call(main, 'workflow_message', {})
  assert.equal(opened.state, 'queued')
  assert.equal(grant(opened).state, 'collaboration_authorizing')
  host.rename(worker, '合成改名')
  assert.deepEqual(await host.call(main, 'workflow_message', {}), { ...opened, duplicate: true })
  assert.deepEqual(host.deliveries, [])
  host.end(main)

  const archived = await until(() => history(opened), 'Expected the mismatched target to be skipped')
  assert.equal(archived.wake.state, 'skipped')
  assert.equal(archived.wake.reason, 'owner_turn_not_verified')
  assert.equal(grant(opened).state, 'collaboration_paused')
  assert.deepEqual(host.deliveries, [])
})
