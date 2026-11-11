import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, guestSource, main, relaySource, reviewer, secondMain, until, worker } from './host-fixture.mjs'

const queryTitle = '合成查询'
const reviewTitle = '合成核查'
const question = '今天合成样本的状态怎么样'
const colloquial = '你给' + queryTitle + '这个窗口问他' + question
const resultText = '合成样本状态为已核验。'
const ownerDispatch = host => host.call(main, 'workflow_delegate_direct', {})
const status = (host, task, owner = main) => host.call(owner, 'workflow_status', { task })

async function queryHost(t) {
  const host = await fixture(t)
  host.rename(worker, queryTitle)
  host.rename(reviewer, reviewTitle)
  return host
}

test('an exact colloquial owner question delegates once and returns the answer to the original controller', async t => {
  const host = await queryHost(t)
  host.begin(main, colloquial)
  const opened = await ownerDispatch(host)
  assert.equal(opened.duplicate, false, JSON.stringify(opened))
  assert.deepEqual(opened.scopes[0].targets, [worker])
  assert(opened.goal.includes(question))
  assert.equal(opened.budget, 1)
  assert.deepEqual(await ownerDispatch(host), { ...opened, duplicate: true })
  host.end(main)

  const job = await host.receive(worker)
  assert.equal(job.source.senderSessionId, main)
  assert.equal(job.source.bridgeWorkflowId, opened.id)
  const lease = await host.call(worker, 'workflow_claim', { id: opened.id })
  assert.equal(lease.owner, main)
  assert.equal(lease.instructions, opened.goal)
  const report = {
    id: opened.id, attempt: lease.attempt, token: lease.token, status: 'completed',
    summary: resultText, evidence: ['synthetic-query'],
  }
  assert.equal((await host.call(worker, 'workflow_report', report)).duplicate, false)
  assert.equal((await host.call(worker, 'workflow_report', report)).duplicate, true)
  host.end(worker)

  host.begin(secondMain, '查看合成任务。')
  assert.equal((await status(host, opened.task, secondMain)).error, 'grant_not_found')
  host.end(secondMain)
  const wake = await host.receive(main)
  assert.equal(wake.source.senderSessionId, worker)
  assert.equal(wake.source.bridgeWorkflowId, opened.id)
  const answer = await host.call(main, 'workflow_consume', { id: opened.id })
  assert.equal(answer.report.summary, resultText)
  assert.equal(answer.report.reporter, worker)
  assert.deepEqual(await host.call(main, 'workflow_consume', { id: opened.id }), { id: opened.id, duplicate: true })
  assert.deepEqual(host.deliveries.map(({ target }) => target), [worker, main])

  const closed = await host.call(main, 'workflow_close', { task: opened.task, outcome: 'completed', summary: resultText })
  assert.deepEqual(closed, { task: opened.task, state: 'closing', duplicate: false })
  host.end(main)
  host.begin(main, '查看已经回报的合成问题。')
  const verified = await until(async () => {
    const state = await status(host, opened.task)
    return state.state === 'closed' && state
  }, 'Expected the original controller answer to close normally')
  assert.equal(verified.outcome.summary, resultText)
  assert.deepEqual(host.deliveries.map(({ target }) => target), [worker, main])
  host.end(main)
})

test('colloquial automatic dispatch rejects same-name, multiple-window and non-owner inputs', async t => {
  const host = await queryHost(t)
  host.rename(secondMain, queryTitle)
  host.begin(main, colloquial)
  assert.equal(typeof (await ownerDispatch(host)).error, 'string')
  host.end(main)
  host.rename(secondMain, secondMain)

  for (const text of [
    '你给' + queryTitle + '这个窗口和' + reviewTitle + '这个窗口问他们' + question,
    '这是用法示例：' + colloquial,
  ]) {
    host.begin(main, text)
    assert.equal(typeof (await ownerDispatch(host)).error, 'string')
    host.end(main)
  }
  for (const source of [guestSource, relaySource, { kind: 'user' }]) {
    host.begin(main, colloquial, source)
    assert.equal(typeof (await ownerDispatch(host)).error, 'string')
    host.end(main)
  }
  assert.deepEqual(host.deliveries, [])
})

test('an explicit quoted message with an outside window suffix stays an exact ordinary send', async t => {
  const host = await queryHost(t)
  const body = '  合成正文第一行\n第二行保留空格  '
  host.begin(main, '把『' + body + '』发给『' + queryTitle + '』窗口')
  assert.equal(typeof (await ownerDispatch(host)).error, 'string')
  const send = () => host.call(main, 'send_natural_session_message', {})
  const sent = await send()
  assert.equal(sent.delivery, 'delivered', JSON.stringify(sent))
  assert.equal(sent.duplicate, false)
  assert.equal(sent.to, worker)
  const duplicate = await send()
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.messageId, sent.messageId)
  host.end(main)

  const message = await host.receive(worker)
  assert.equal(message.id, sent.messageId)
  assert.equal(message.content[0].text, '[DSH 会话消息｜发送方 ' + main + ']\n' + body)
  assert.deepEqual(host.deliveries.map(({ target }) => target), [worker])
  host.end(worker)
})
