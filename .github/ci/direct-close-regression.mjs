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
  host.begin(main, question)
  const opened = await host.call(main, 'workflow_delegate_direct', {})
  host.end(main)
  return opened
}

async function result(host, opened, { status = 'completed', beforeReport } = {}) {
  assert.equal(opened.state, 'queued', JSON.stringify(opened))
  assert.equal((await host.receive(worker)).source.bridgeWorkflowId, opened.id)
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

test('a verified one-shot reply releases a slot and retains its history at the 128-grant limit', async t => {
  const { host, active, change, grant, history, key } = await lab(t)
  change(({ grants }) => {
    for (let i = 0; i < 127; i++) {
      const task = 'synthetic-capacity-slot-' + i
      grants[main + ':' + task] = {
        task, owner: main, goal: 'Synthetic live grant', scopes: [{ name: 'execute', targets: [worker] }],
        expiresAt: Date.now() + 30 * 60_000, state: 'active', openedAt: Date.now(),
        ownerMessageId: 'synthetic-message-' + i, ownerTurn: i,
      }
    }
  })
  const opened = await open(host)
  assert.equal(Object.keys(active().grants).length, 128)
  assert.deepEqual(await open(host), { error: 'grant_not_opened' })
  await result(host, opened)
  await consume(host, opened)
  host.reply(main, answer)
  assert.equal(grant(opened).state, 'collaboration_active')
  host.end(main)
  const archived = await until(() => history(opened), 'Expected the completed attempt in history')
  assert.deepEqual(host.deliveries.map(({ target }) => target), route)
  const next = await open(host)
  assert.equal(next.state, 'queued', JSON.stringify(next))
  assert.equal(archived.resume.continuation.state, 'verified')
  assert(Number.isSafeInteger(archived.resume.continuation.replyAfterSeq))
  assert.equal(active().grants[key(opened)], undefined)
  const closed = grant(opened)
  assert.equal(closed.state, 'closed')
  assert.equal(closed.closedTurn, archived.resume.continuation.turn)
  assert(closed.closedAt < closed.expiresAt)
  assert.deepEqual(closed.outcome, { status: 'completed', summary: answer, finalArtifacts: [] })
})

for (const [name, action, state, continuation, status] of [
  ['a reply emitted before consumption', (host, opened) => {
    host.reply(main, answer)
    return consume(host, opened)
  }, 'collaboration_active', 'verified'],
  ['a whitespace-only reply', async (host, opened) => {
    await consume(host, opened)
    host.reply(main, ' \n ')
  }, 'collaboration_active', 'verified'],
  ['an interrupted assistant message', async (host, opened) => {
    await consume(host, opened)
    host.reply(main, answer, true)
  }, 'collaboration_active', 'verified'],
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
  test('direct result does not implicitly close with ' + name, async t => {
    const { host, grant, history } = await lab(t)
    const opened = await open(host)
    await result(host, opened, { status })
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
