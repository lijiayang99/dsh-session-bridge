import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observeNativeResults } from '../../native-result.js'
import { fixture, main, until, worker } from './host-fixture.mjs'

test('a queued native owner cancellation blocks a reserved task continuation', async t => {
  const host = await fixture(t)
  host.rename(worker, '99-合成审核')
  host.begin(main, '让99窗口核对合成样本')
  host.end(main)

  const notice = await host.receive(worker)
  const job = notice.source.bridgeWorkflowId
  const claim = await host.call(worker, 'workflow_claim', { id: job })
  assert.equal(claim.duplicate, false)
  host.end(worker)

  const text = '请继续只读核对合成指纹。'
  host.begin(main, '请追加合成任务。')
  const receipt = await host.call(main, 'workflow_message', { text })
  assert.equal(receipt.delivery, 'queued')
  assert.deepEqual(host.deliveries.map(({ target }) => target), [worker])
  host.enqueueInput(main, '取消委托 ' + claim.task)
  host.end(main)

  const settled = await until(async () => {
    const value = await host.call(main, 'session_message_status', { request_id: receipt.requestId, job })
    return value.delivery !== 'unknown' && value
  }, 'Expected the provisional continuation receipt to settle')
  assert.equal(settled.messageId, receipt.messageId)
  assert.equal(settled.delivery, 'not_delivered')
  assert.deepEqual(host.deliveries.map(({ target }) => target), [worker])
})

test('only the bound native parent receives a distinct omitted final for the current child run', async () => {
  const handlers = new Map()
  const appended = []
  const activity = []
  const parent = { id: 'parent', session: {}, followup: message => appended.push(message) }
  const child = { id: 'child', session: { header: { parentSession: parent.id } } }
  const agents = new Map([[parent.id, parent], [child.id, child]])
  observeNativeResults({
    agents, sessions: { flush: async () => true },
    on: (name, listener) => handlers.set(name, listener),
  }, () => true, id => id === parent.id, { record: (route, attempt) => activity.push([route.state, attempt]) })
  const emit = (name, ...args) => handlers.get(name)(...args)
  const text = value => ({ type: 'text', text: value })
  const local = { id: child.id, local: true, provider: 'spawn' }
  const omitted = { role: 'user', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: child.id },
    content: [text('Native settled'), text('It sent you a message just before finishing, so its closing message is omitted.')] }
  const progress = { role: 'user', source: { kind: 'agent-message', form: 'relay', senderSessionId: child.id },
    content: [text('Agent child sent a message: '), text('Synthetic progress')] }
  const admit = (session, ...inserted) => emit('session/event', session,
    { type: 'agent/inbox/spliced', data: { inserted } })
  const start = runId => emit('subagent/start', { ...local, runId })
  const end = (runId, body) => emit('subagent/end', { ...local, runId, stopReason: 'completed',
    lastAssistantMessage: [text(body)] })

  start('synthetic-foreign-notice')
  admit({}, omitted)
  await end('synthetic-foreign-notice', 'Should not be forwarded')
  start('synthetic-same-text')
  admit(parent.session, progress, omitted)
  await end('synthetic-same-text', 'Synthetic progress')
  assert.deepEqual(appended, [])

  start('synthetic-current-run')
  admit(parent.session, progress, omitted)
  await end('synthetic-old-run', 'Should not be forwarded')
  await end('synthetic-current-run', 'Distinct synthetic final')
  await end('synthetic-current-run', 'Duplicate end event')
  assert.equal(appended.length, 1)
  assert.equal(appended[0].source.bridgeWorkflowOwner, parent.id)
  assert.equal(appended[0].source.bridgeWorkflowId, 'synthetic-current-run')
  assert.equal(appended[0].source.bridgeWorkflowKind, 'native-result')
  assert.equal(appended[0].content[0].text, '子代理回报 · child\n\nDistinct synthetic final')
  assert.deepEqual(activity, [['sending', true], ['delivered', undefined]])
})
