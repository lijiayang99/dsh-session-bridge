import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, guestSource, main, outsider, relaySource, reviewer, worker } from './host-fixture.mjs'

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
  const send = input => host.call(main, 'send_session_message', input)
  for (const source of [guestSource, relaySource, { kind: 'user' }]) {
    host.begin(main, relayCommand(ordinary), source)
    assert.equal((await send(ordinary)).error, 'message_authorization_required')
    host.end(main)
  }
  host.begin(main, relayCommand({ ...ordinary, to: outsider }))
  assert.equal((await send({ ...ordinary, to: outsider })).error, 'route_not_allowed')
  host.end(main)
  host.begin(main, relayCommand(ordinary))
  for (const change of [{ to: reviewer }, { request_id: 'different' }, { text: 'Different.' }]) {
    assert.equal((await send({ ...ordinary, ...change })).error, 'message_authorization_required')
  }
  assert.equal(host.deliveries.length, 0)
  const first = await send(ordinary)
  assert.equal(first.delivery, 'delivered')
  assert.equal(first.duplicate, false)
  const delivered = host.deliveries[0]
  assert.equal(delivered.target, worker)
  assert.equal(delivered.message.id, first.messageId)
  assert.equal(delivered.message.source.senderSessionId, main)
  assert(delivered.message.content[0].text.endsWith('\n' + ordinary.text))
  host.end(main)
  host.begin(main, 'Synthetic retry without a fresh authorization')
  const duplicate = await send(ordinary)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.messageId, first.messageId)
  assert.equal((await send({ ...ordinary, text: 'Different.' })).error, 'request_id_conflict')
  assert.equal(host.deliveries.length, 1)
  assert.equal((await send({ ...ordinary, request_id: 'different' })).error, 'message_authorization_required')
  host.end(main)
  await host.receive(worker)
  host.end(worker)

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

test('an unknown host cannot start a relay or delegate', async t => {
  const host = await fixture(t, { hostVersion: '0.0.0-synthetic-unknown' })
  if (host.tools.has('send_session_message')) {
    host.begin(main, relayCommand(ordinary))
    const denied = await host.call(main, 'send_session_message', ordinary)
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
