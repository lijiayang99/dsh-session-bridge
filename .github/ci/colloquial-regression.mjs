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
  const receiptTitle = '你是谁'
  const receiptQuestion = '今天成都天气怎么样'
  host.rename(worker, receiptTitle)
  host.begin(main, '你给' + receiptTitle + '这个窗口问他' + receiptQuestion)
  const opened = await ownerDispatch(host)
  assert.equal(opened.duplicate, false, JSON.stringify(opened))
  assert.deepEqual(opened.scopes[0].targets, [worker])
  assert.equal(opened.goal, receiptQuestion)
  assert.equal(opened.state, 'queued')
  assert.equal(opened.targetTitle, receiptTitle)
  assert.equal(opened.budget, 1)
  host.rename(worker, '合成派工后改名')
  assert.deepEqual(await ownerDispatch(host), { ...opened, duplicate: true })
  host.rename(worker, receiptTitle)
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
  assert.deepEqual(verified.authorization.targets, [{ id: worker, title: receiptTitle }])
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

test('a changed title or allowlist before dispatch cannot issue a direct receipt', async t => {
  const host = await queryHost(t)
  let reads = 0
  host.faults.list = () => {
    if (++reads === 2) host.rename(worker, '合成派工前改名')
  }
  host.begin(main, colloquial)
  assert.deepEqual(await ownerDispatch(host), { error: 'workflow_target_changed' })
  assert.equal(reads, 2)
  host.end(main)
  host.rename(worker, queryTitle)

  reads = 0
  host.faults.list = () => {
    if (++reads === 2) host.setAllowedSessions([main, secondMain, reviewer])
  }
  host.begin(main, colloquial)
  assert.deepEqual(await ownerDispatch(host), { error: 'workflow_target_changed' })
  assert.equal(reads, 2)
  host.end(main)

  delete host.faults.list
  host.begin(main, colloquial)
  assert.deepEqual(await ownerDispatch(host), { error: 'workflow_target_not_available' })
  host.end(main)
  assert.deepEqual(host.deliveries, [])
})

test('an interrupted direct attempt keeps the queued receipt and produces no answer or replay', async t => {
  const host = await queryHost(t)
  host.begin(main, colloquial)
  const opened = await ownerDispatch(host)
  assert.equal(opened.targetTitle, queryTitle)
  assert.equal(opened.state, 'queued')
  host.end(main)
  assert.equal((await host.receive(worker)).source.bridgeWorkflowId, opened.id)
  assert.equal((await host.call(worker, 'workflow_claim', { id: opened.id })).duplicate, false)
  await host.restart()

  host.begin(main, '核对合成中断尝试。')
  const interrupted = await until(async () => {
    const current = await status(host, opened.task)
    return current.jobs?.[0]?.delivery.state === 'uncertain' && current
  }, 'Expected the claimed attempt to remain unverified after restart')
  const [job] = interrupted.jobs
  assert.equal(job.id, opened.id)
  assert.equal(job.delivery.reason, 'execution_interrupted_after_claim')
  assert.equal(job.report, undefined)
  assert.equal(interrupted.outcome, undefined)
  assert.deepEqual(interrupted.authorization.targets, [{ id: worker, title: queryTitle }])
  assert.deepEqual(host.deliveries.map(({ target }) => target), [worker])
  host.end(main)
})

test('a completed ambiguous owner request emits one bound clarification and no assignment', async t => {
  const host = await queryHost(t)
  host.rename(secondMain, queryTitle)
  host.setAllowedSessions([main, worker])
  host.begin(main, colloquial)
  assert.deepEqual(host.deliveries, [])
  host.end(main)

  const notice = await host.receive(main)
  assert.equal(notice.role, 'user')
  assert.deepEqual(notice.source, {
    kind: 'agent-message', form: 'relay', senderSessionId: main,
    bridgeWorkflowKind: 'direct-notice', bridgeWorkflowOwner: main,
  })
  assert.deepEqual(notice.content, [{ type: 'text',
    text: '委托未发送。请在原窗口重试，使用引号写出一个完整且唯一的窗口名。' }])
  assert.deepEqual(await ownerDispatch(host), { error: 'workflow_direct_owner_request_required' })
  host.end(main)
  assert.deepEqual(host.deliveries.map(({ target }) => target), [main])
})
