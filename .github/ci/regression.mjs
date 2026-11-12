import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fixture, guestSource, main, outsider, relaySource, reviewer, until, worker } from './host-fixture.mjs'

const ordinary = { to: worker, request_id: 'synth-request', text: 'Exact synthetic text.' }
const relayCommand = ({ to, request_id, text }) => '授权互传 ' + to + ' ' + request_id + '\n' + text
const task = 'synth-workflow'
const grant = '授权委托\n' + JSON.stringify({
  task, ttlMinutes: 2, goal: 'Synthetic workflow',
  scopes: [{ name: 'develop', targets: [worker] }, { name: 'review', targets: [reviewer] }],
})
const dispatch = {
  task, item: 'initial', attempt: 1, target: worker, scope: 'develop',
  instructions: 'Prepare a synthetic result.', acceptance: 'Return synthetic evidence.',
}

test('supported owner contract and delegation round trip', async t => {
  const host = await fixture(t)
  const send = input => host.call(main, 'workflow_message', input)
  const read = () => host.call(main, 'session_message_status', { request_id: ordinary.request_id })
  for (const source of [guestSource, relaySource, { kind: 'user' }]) {
    host.begin(main, relayCommand(ordinary), source)
    assert.equal(typeof (await send({ text: ordinary.text })).error, 'string')
    host.end(main)
  }
  host.archive(outsider)
  host.begin(main, relayCommand({ ...ordinary, to: outsider }))
  host.end(main)
  await delay(25)
  assert.equal(host.deliveries.length, 0)
  host.begin(main, relayCommand(ordinary))
  for (const change of [{ to: reviewer }, { request_id: 'different' }]) {
    assert.equal((await send(change)).error, 'workflow_message_invalid_arguments')
  }
  assert.deepEqual(await send({ text: 'Different.' }), { state: 'waiting_for_owner_turn_end' })
  assert.equal(host.deliveries.length, 0)
  host.end(main)
  const delivered = await host.receive(worker)
  assert.equal(delivered.source.senderSessionId, main)
  assert(delivered.content[0].text.endsWith('\n' + ordinary.text))
  host.end(worker)
  const first = await until(async () => {
    const receipt = await read()
    return receipt.delivery === 'delivered' && receipt
  }, 'Expected one durable owner-authorized delivery receipt')
  assert.equal(first.messageId, delivered.id)

  host.begin(main, 'Synthetic retry without a fresh authorization')
  assert.equal((await send({ text: ordinary.text })).error, 'workflow_task_context_required')
  host.end(main)
  host.begin(main, relayCommand(ordinary))
  host.end(main)
  await delay(25)
  host.begin(main, relayCommand({ ...ordinary, text: 'Different.' }))
  host.end(main)
  await delay(25)
  assert.equal((await read()).messageId, first.messageId)
  assert.equal(host.deliveries.length, 1)

  for (const source of [guestSource, relaySource]) {
    host.begin(main, grant, source)
    assert.equal((await host.call(main, 'workflow_dispatch', dispatch)).error, 'main_task_context_required')
    host.end(main)
  }
  host.begin(main, grant)
  const delegated = await host.call(main, 'workflow_dispatch', dispatch)
  assert.equal(delegated.duplicate, false)
  host.end(main)
  const taskWake = await host.receive(worker)
  assert.equal(taskWake.source.senderSessionId, main)
  const claim = await host.call(worker, 'workflow_claim', { id: delegated.id })
  assert.equal(claim.instructions, dispatch.instructions)
  const report = { id: delegated.id, attempt: 1, token: claim.token, status: 'completed', summary: 'Synthetic result', evidence: ['fixture'] }
  assert.equal((await host.call(worker, 'workflow_report', report)).recorded, true)
  host.end(worker)

  const resultWake = await host.receive(main)
  assert.equal(resultWake.source.senderSessionId, worker)
  const result = await host.call(main, 'workflow_consume', { id: delegated.id })
  assert.equal(result.report.summary, report.summary)
  assert.equal(result.report.reporter, worker)
  assert.equal((await host.call(main, 'workflow_consume', { id: delegated.id })).duplicate, true)
  const next = { ...dispatch, item: 'review', target: reviewer, scope: 'review' }
  const continuation = await host.call(main, 'workflow_dispatch', next)
  assert.equal(continuation.duplicate, false)
  assert.deepEqual(await host.call(main, 'workflow_dispatch', next), { id: continuation.id, duplicate: true })
  host.end(main)
  const nextWake = await host.receive(reviewer)
  assert.equal(nextWake.source.bridgeWorkflowId, continuation.id)
  assert.equal(host.deliveries.filter(({ target }) => target === reviewer).length, 1)
  host.end(reviewer)
  assert.deepEqual(host.warnings, [])
})

test('legacy allowlist membership gives no authority and cannot block a new owner-authorized window', async t => {
  const host = await fixture(t, { legacySettings: { allowedSessions: [main, worker] } })
  host.begin(main, 'The synthetic model wants to send a message.')
  assert.equal((await host.call(main, 'workflow_message', { text: ordinary.text })).error, 'workflow_task_context_required')
  host.end(main)
  assert.deepEqual(host.deliveries, [])

  const request = { ...ordinary, to: outsider }
  host.begin(main, relayCommand(request))
  host.end(main)
  const delivered = await host.receive(outsider)
  assert(delivered.content[0].text.endsWith(ordinary.text))
  host.end(outsider)
  assert.deepEqual(host.deliveries.map(({ target }) => target), [outsider])
})

test('the master switch blocks both an authorized send and native delegation', async t => {
  const host = await fixture(t)
  host.rename(worker, '合成执行')
  const question = '你给合成执行这个窗口问他今天合成样本怎么样'
  host.setEnabled(false)
  host.begin(main, relayCommand(ordinary))
  assert.equal((await host.call(main, 'workflow_message', {})).error, 'workflow_disabled')
  host.end(main)
  host.begin(main, question)
  host.end(main)
  assert.deepEqual(host.deliveries, [])

  host.setEnabled(true)
  host.begin(worker, '保持合成执行窗忙碌。')
  const input = host.begin(main, question)
  host.end(main)
  const { job } = await host.directAssignment(main, input)
  assert.equal(job.wake.state, 'queued')
  host.setEnabled(false)
  host.end(worker)
  await delay(850)
  assert.deepEqual(host.deliveries, [])
  host.setEnabled(true)
  const assignment = await host.receive(worker)
  assert.equal(assignment.source.bridgeWorkflowKind, 'task')
  assert.equal(assignment.source.senderSessionId, main)
  assert.equal(assignment.source.bridgeWorkflowId, job.id)
  assert.equal(host.deliveries.length, 1)
  host.end(worker)
})

test('an unknown host cannot start a relay or delegate', async t => {
  const host = await fixture(t, { hostVersion: '0.0.0-synthetic-unknown' })
  if (host.tools.has('workflow_message')) {
    host.begin(main, relayCommand(ordinary))
    const denied = await host.call(main, 'workflow_message', { text: ordinary.text })
    assert.equal(typeof denied.error, 'string')
    assert.equal(denied.messageId, undefined)
    if (host.tools.has('session_message_status')) {
      const receipt = await host.call(main, 'session_message_status', { request_id: ordinary.request_id })
      assert.equal(typeof receipt.error, 'string')
      assert.equal(receipt.messageId, undefined)
    }
    host.end(main)
  }
  if (host.tools.has('workflow_dispatch')) {
    host.begin(main, grant)
    const deniedDispatch = await host.call(main, 'workflow_dispatch', dispatch)
    assert.equal(typeof deniedDispatch.error, 'string')
    assert.equal(deniedDispatch.id, undefined)
    host.end(main)
  }
  assert.equal(host.deliveries.length, 0)
})
