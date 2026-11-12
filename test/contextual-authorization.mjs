import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkflowAuthorization } from '../workflow-authorization.js'
import { hostContext } from '../natural-message.js'
import { contextualRequest, directQuestionInScope, namedQuestionGoal, namedQuestionText } from '../workflow-context.js'

const topic = '你看一下02窗口今天干了啥。'
const followup = '你问一下他'
const combined = '你看一下02窗口今天干了啥，你问一下他'
const alias = { kind: 'alias', value: '02' }

test('contextual requests preserve exact questions and reject quoted or conflicting actions', () => {
  const expected = { action: 'ask', selector: alias, goal: '今天干了啥' }
  assert.deepEqual(contextualRequest(combined), expected)
  assert.deepEqual(contextualRequest(topic + '\n' + followup), expected)
  assert.deepEqual(contextualRequest('问一下02今天干了啥？'),
    { action: 'ask', selector: alias, goal: '今天干了啥？', prior: undefined })
  assert.deepEqual(contextualRequest('帮我问问02窗口，插件还有哪些坑？'),
    { action: 'ask', selector: alias, goal: '插件还有哪些坑？' })
  for (const example of ['「' + combined + '」', '他说：' + combined, '别' + combined,
    combined + '，再告诉03', '帮我问问02窗口，例如你问一下他？',
    '帮我问问02窗口，不用问他了？', '帮我问问02窗口，插件还有哪些坑？然后发给03？',
    ...['先别问了？', '算了。', '不用问了？', '先不问了？'].map((ending) =>
      '帮我问问02窗口，插件还有哪些坑，' + ending)]) {
    assert.equal(contextualRequest(example), undefined, example)
  }
  assert.deepEqual(contextualRequest('帮我问问02窗口，什么时候说先别问了更合适？'),
    { action: 'ask', selector: alias, goal: '什么时候说先别问了更合适？' })
})

test('independent withdrawal and routing clauses stay out of automatic questions', () => {
  for (const text of [
    '今天干了啥，算了。',
    '插件还有哪些坑？把结果发给03窗口。今天能处理吗？',
    '插件还有哪些坑？然后请你再把报告交给03窗口。今天能处理吗？',
    '插件还有哪些坑？让03窗口审核。今天能处理吗？',
    '插件还有哪些坑？发给03窗口；先别问了。',
    '把结果发给03窗口。你今天能处理吗？',
  ]) assert.equal(directQuestionInScope(text), false, text)

  for (const text of ['插件为什么会把结果发给03窗口？',
    '为什么有人会说算了？', '你对“合成示例，算了”这个说法怎么看？',
    '算了.txt 里面是什么？', '这里的版本 v0.5.0 是什么意思？']) {
    assert.equal(directQuestionInScope(text), true, text)
  }

  const topical = '委托功能的状态，为什么没有更新？'
  assert.deepEqual(contextualRequest('帮我问问02窗口，' + topical),
    { action: 'ask', selector: alias, goal: topical })
  for (const ending of ['请取消委托。', '收到回复后请把结果发给03窗口。今天能处理吗？']) {
    assert.equal(contextualRequest('帮我问问02窗口，' + topical + ending), undefined)
  }

  const blocked = '帮我问问02窗口，插件还有哪些坑？把结果发给03窗口。今天能处理吗？'
  assert.equal(contextualRequest(blocked), undefined)
  assert.equal(contextualRequest('帮我问问02窗口，插件还有哪些坑？先别问了。你给我看看日志行吗？'), undefined)
  assert.deepEqual(contextualRequest('帮我问问02窗口，插件为什么会把结果发给03窗口？'),
    { action: 'ask', selector: alias, goal: '插件为什么会把结果发给03窗口？' })

  const prior = { missing: 'goal', selector: alias }
  for (const text of ['你今天为什么没完成审核？', '你今天干了啥？', '你今天干了啥', '  你今天为什么没完成审核？  ']) {
    assert.equal(contextualRequest(text, prior).goal, text)
  }
  assert.equal(contextualRequest('问他：你今天为什么没完成审核？', prior).goal, '你今天为什么没完成审核？')
})

test('only a fresh adjacent native owner input can reuse the exact previous topic', async (t) => {
  let now = 1000
  t.mock.method(performance, 'now', () => now)
  const session = { id: 'owner' }
  const agent = { session, inbox: { nextTurn: [], nextStep: [] } }
  const signal = new AbortController().signal
  const auth = createWorkflowAuthorization({
    agents: { get: () => agent },
    workspaceRegistry: { list: () => [{ id: 'workspace', sessionIds: ['owner', 'worker'] }] },
    sessionController: { list: async () => ({ items: [
      { sessionId: 'worker', projections: { values: { title: '02-合成查询' } } },
    ] }) },
  }, { enabled: () => true, available: () => true, existing: async () => true, signal })

  const input = (number, text, source = { kind: 'user', rpcId: 'rpc-' + number }) =>
    auth.input(session, { number, mixed: false }, { id: 'message-' + number, role: 'user', source,
      content: [{ type: 'text', text }] })
  const store = (number) => {
    const context = input(number, topic)
    assert.equal(context.direct.action, 'topic')
    auth.rememberTopic(session.id, context.direct, { turn: number })
    return context
  }
  assert.equal(input(0, '你给「02-合成查询」窗口问他今天干了啥，算了。'), undefined)
  const literal = '逐字检查「取消」这个用词，算了。'
  assert.equal(input(0, '把『' + literal + '』委托给『02-合成查询』').direct.goal, literal)
  const prepared = store(1)
  const caller = { id: session.id, turn: { number: 1 }, context: prepared }
  const denied = await auth.delegateDirect({ agent, signal }, caller, () => caller, () => assert.fail('topic opened a grant'))
  assert.deepEqual(denied, { error: 'workflow_direct_owner_request_required' })
  assert.equal(input(2, followup).direct.goal, '今天干了啥')
  assert.equal(input(3, followup).direct.goal, undefined)

  store(4)
  assert.equal(input(6, followup).direct.selector, undefined)
  store(7)
  now += 120_001
  assert.equal(input(8, followup).direct.selector, undefined)

  store(9)
  assert.equal(input(10, followup, { kind: 'user', rpcId: 'guest-rpc', principal: { kind: 'guest' } }), undefined)
  assert.equal(input(11, followup).direct.goal, undefined)
  store(12)
  assert.equal(input(13, followup, { kind: 'agent-message', form: 'relay', senderSessionId: 'worker' }), undefined)
  assert.equal(input(14, followup).direct.goal, undefined)
})

test('an adjacent catalog question needs an actual title boundary and one authorized action', () => {
  const body = namedQuestionText('你问一下00-main做了那些事情')
  assert.equal(namedQuestionGoal(body, '00-main'), '做了那些事情')
  assert.equal(namedQuestionGoal(namedQuestionText('你问一下00-main，今早检查了什么  '), '00-main'),
    '今早检查了什么  ')
  assert.equal(namedQuestionGoal(body, '00'), undefined)
  assert.equal(namedQuestionText('你问一下00-main做了那些事情并把结果发给03窗口'), undefined)
  assert.equal(namedQuestionGoal('合成审核备用窗口多大内存够用', '合成审核'), undefined)
  assert.equal(namedQuestionGoal('合成审核窗口多大内存够用', '合成审核'), '多大内存够用')
})

test('the fixed host model switch is context only with its exact source and summary', () => {
  const text = '[model changed: assistant turns above this point were generated by synthetic-a; the session continues with synthetic-b]'
  const message = {
    role: 'user', source: { kind: 'model-selection', form: 'notice', summary: 'synthetic-a → synthetic-b' },
    content: [{ type: 'text', text }],
  }
  assert.equal(hostContext(message), true)
  for (const source of [
    { kind: 'user', rpcId: 'synthetic-user' },
    { kind: 'agent-message', form: 'relay', senderSessionId: 'synthetic-worker' },
    { ...message.source, summary: 'synthetic-a → unknown' },
    { ...message.source, principal: { kind: 'guest' } },
  ]) assert.equal(hostContext({ ...message, source }), false)
})
