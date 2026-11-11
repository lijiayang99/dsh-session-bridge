import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createWorkflowAuthorization } from '../../workflow-authorization.js'
import { contextualRequest } from '../../workflow-context.js'
import { fixture, main, ownerSource, secondMain, until, worker } from './host-fixture.mjs'
import '../../test/contextual-authorization.mjs'

const topic = '你看一下02窗口今天干了啥'
const followup = '你问一下他'
const question = '今天干了啥'
const title = '02-合成查询'
const workspace = 'synthetic-context-workspace'

test('adjacent owner turns bind exact input, workspace, and one native return without controller tools', async t => {
  const host = await fixture(t, { workspaces: [
    { id: workspace, sessionIds: [main, worker] },
    { id: 'synthetic-other-workspace', sessionIds: [secondMain] },
  ] })
  host.rename(worker, title)
  host.rename(secondMain, '02-合成异项目')
  host.begin(main, topic)
  host.end(main)
  assert.deepEqual(host.deliveries, [])
  host.begin(main, followup)
  assert.deepEqual(host.deliveries, [])
  host.end(main)

  const assignment = await host.receive(worker)
  assert.equal(assignment.source.senderSessionId, main)
  const id = assignment.source.bridgeWorkflowId
  const claim = await host.call(worker, 'workflow_claim', { id })
  assert.equal(claim.goal, question)
  assert.equal(claim.instructions, question)
  assert.equal(claim.owner, main)
  const summary = '合成执行窗核对了样本。'
  assert.equal((await host.call(worker, 'workflow_report', {
    id, attempt: claim.attempt, token: claim.token, status: 'completed', summary, evidence: ['synthetic-context'],
  })).duplicate, false)
  host.end(worker)
  const reply = await host.receive(main)
  assert.equal(reply.source.bridgeWorkflowId, id)
  assert.equal(reply.source.bridgeWorkflowOwner, main)
  assert(reply.content[0].text.includes(summary))
  host.end(main)

  const state = await until(async () => {
    host.begin(main, '查看已完成的合成任务。')
    const value = await host.call(main, 'workflow_status', { task: claim.task })
    host.end(main)
    return value.state === 'closed' && value
  }, 'Expected the single native result to close the contextual grant')
  const auth = state.authorization
  assert.deepEqual(auth.targets, [{ id: worker, title }])
  assert.equal(auth.context.workspace, workspace)
  assert.equal(auth.context.earlierInputs.length, 1)
  assert.equal(auth.context.earlierInputs[0].sourceDigest, createHash('sha256').update(topic).digest('hex'))
  assert.equal(auth.request.sourceDigest, createHash('sha256').update(followup).digest('hex'))
  assert.deepEqual(host.deliveries.map(({ target }) => target), [worker, main])
})

for (const [name, text] of [
  ['a question to an exact quoted title with a trailing owner withdrawal', '你给「02-合成查询」窗口问他今天干了啥，算了。'],
  ['a contextual question with a separate forwarding instruction', '帮我问问02窗口，插件还有哪些坑？把结果发给03窗口。今天能处理吗？'],
  ['an explicit polite cancellation', '你给「02-合成查询」窗口问他今天干了啥，请取消委托。'],
  ['a separate conditional forwarding instruction', '帮我问问02窗口，插件还有哪些坑？收到回复后请把结果发给03窗口。今天能处理吗？'],
]) {
  test('direct authorization rejects ' + name, () => {
    const auth = createWorkflowAuthorization({}, {
      enabled: () => true, available: () => true,
      signal: new AbortController().signal,
    })
    const context = auth.input({ id: main }, { number: 1, mixed: false }, {
      id: 'synthetic-owner-message', role: 'user', source: ownerSource,
      content: [{ type: 'text', text }],
    })
    assert.notEqual(context?.mode, 'direct-workflow')
  })
}

test('a question about the delegation feature preserves its topic and punctuation', () => {
  const goal = '委托功能的状态，为什么没有更新？'
  assert.deepEqual(contextualRequest('帮我问问02窗口，' + goal), {
    action: 'ask', selector: { kind: 'alias', value: '02' }, goal,
  })
})
