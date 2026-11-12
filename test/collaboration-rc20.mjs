import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { latestPrompt, parts, tool, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, archive, playwright, chrome] = process.argv.slice(2)
assert(dsh && archive && Boolean(playwright) === Boolean(chrome))
const messaging = 'workflow_message'
const main = 'synthetic-unified-controller'
const ops = 'synthetic-unified-ops'
const observer = 'synthetic-unified-observer'
const exact = '你让99-运维检查目前电脑状态，不要做任何修改'
const goal = '检查目前电脑状态，不要做任何修改'
const answer = '合成状态只读核对完成 A-993。'
const later = '请让99-运维核对合成日志，只读查看'
const laterGoal = '核对合成日志，只读查看'
const laterAnswer = '合成日志只读核对完成 B-221。'
const followPrompt = '继续这一项，补查一条合成记录。'
const followup = '补查合成记录，仍然只读。'
const followAnswer = '同任务合成补查结果 C-550。'
const unrelated = '模拟旁观窗尝试无授权发起任务消息。'
const deniedBody = '旁观窗正文不得投递。'
const unboundOwner = '说明这段合成文本的字数。'
const unboundBody = '现有任务不得接收无关所有者输入。'
const titleFollow = '你再问99窗口：合成补查的状态怎么样？'
const titleBody = '合成补查的状态怎么样？'
const titleAnswer = '按短号追加的原话已回传。'
const qualified = '你让99-运维检查组窗口检查目前电脑状态，不要做任何修改'
const otherGoal = '检查当前窗口的合成状态，只读查看'
const otherAnswer = '正文中提及窗口的合成检查完成。'
const aliasGoal = '查看合成工作区状态，不要做任何修改'
const aliasAnswer = '短号目标已按原样只读检查。'
const renameRace = '你让99-运维诊断合成网络，只读查看'
const draftPrompt = '请拟一条消息发给88-旁观'
const draftBody = '仅在完整预览后发送的合成正文。'
const secondDraftPrompt = '请拟一条消息发给「88-旁观」窗口'
const secondDraftBody = '第二份合成草稿按可见提示发送。'
const marker = /^DSH-WORKFLOW TASK ([a-f0-9-]+)$/
const exchange = /^任务消息 · ([a-zA-Z0-9_-]+) · ([a-zA-Z0-9_-]+) → ([a-zA-Z0-9_-]+)\n\n([\s\S]+)$/u
let modelCatalog
let laterCalls = 0
let raceStarted = false
let releaseRace = false

async function decide({ messages, tools }, { signal }) {
  modelCatalog = tools.map(({ name }) => name)
  const p = latestPrompt(messages, (text) =>
    [exact, later, goal, laterGoal, followPrompt, unrelated, unboundOwner, otherGoal, aliasGoal, renameRace, draftPrompt, secondDraftPrompt].includes(text) || marker.test(text) || exchange.test(text))
  if (!p) return { reply: '合成会话正常结束。' }
  if (p.text === exact) return { reply: '合成主控等宿主自行派工。' }
  if (p.text === later) {
    if (!p.results.length) { laterCalls++; return tool(messaging) }
    return { reply: '合成主控读到宿主状态。' }
  }
  if (p.text === renameRace) {
    raceStarted = true
    while (!releaseRace) await delay(10, undefined, { signal })
    return { reply: '合成改名源轮结束。' }
  }
  if (p.text === draftPrompt || p.text === secondDraftPrompt) {
    const text = p.text === draftPrompt ? draftBody : secondDraftBody
    return p.results.length ? { reply: p.results[0].preview } : tool(messaging, { text })
  }
  if (p.text === goal) return { reply: answer }
  if (p.text === otherGoal) return { reply: otherAnswer }
  if (p.text === aliasGoal) return { reply: aliasAnswer }
  if (p.text === laterGoal) return { reply: laterAnswer }
  if (p.text === followPrompt && !p.results.length) return tool(messaging, { text: followup })
  if (p.text === unrelated && !p.results.length) return tool(messaging, { text: deniedBody })
  if (p.text === unboundOwner && !p.results.length) return tool(messaging, { text: unboundBody })
  const incoming = exchange.exec(p.text)
  if (incoming?.[4] === followup) return { reply: followAnswer }
  if (incoming?.[4] === titleBody) return { reply: titleAnswer }
  return { reply: '合成会话正常结束。' }
}

const body = ({ data }) => parts(data.content).filter(({ type }) => type === 'text').map(({ text }) => text).join('\n')

await withCollaborationHost({ dsh, archive, decide }, async (host) => {
  await host.createSessions([[main, '01-session-bridge'], [ops, '99-运维'], [observer, '88-旁观']])
  await host.save({ enabled: true })
  assert(modelCatalog.includes(messaging))
  for (const old of ['send_session_message', 'send_natural_session_message', 'workflow_delegate_direct']) {
    assert(!modelCatalog.includes(old), old)
  }
  for (const formal of ['workflow_propose', 'workflow_confirm', 'workflow_dispatch_batch', 'workflow_report']) {
    assert(modelCatalog.includes(formal), formal)
  }
  const get = async (id) => {
    try { return await host.history(id) }
    catch (error) { if (!String(error.message).includes('session/agent-busy')) throw error; return [] }
  }
  const fromBridge = async (id, kinds) => (await get(id)).filter(({ type, data }) =>
    type === 'user/message' && kinds.includes(data.source?.bridgeWorkflowKind))
  const tasks = () => fromBridge(ops, ['task'])
  const answers = async (text) => (await fromBridge(main, ['conversation', 'result'])).filter((event) => body(event).includes(text))
  const receive = (text) => host.until(async () => (await answers(text))[0], 'one exact answer returns to the original window')
  await host.rpc('session/selectModel', { request: { sessionId: main, provider: 'deepseek-official', model: 'deepseek-v4-pro' } })
  const source = await host.prompt(main, exact)
  assert.deepEqual(source.results, [])
  assert(source.records.some(({ type, data }) => type === 'user/message' && data.source?.kind === 'model-selection'))
  const first = await receive(answer)
  const firstTasks = await tasks()
  assert.equal(firstTasks.length, 1)
  assert(firstTasks[0].data.content.some(({ text }) => text === goal))
  const id = first.data.source.bridgeWorkflowId
  assert.equal(firstTasks[0].data.source.bridgeWorkflowId, id)
  await host.idle(main)
  console.log('PASS the original owner phrase dispatches once without a model call and preserves the read-only restriction after a native model switch')

  const extra = await host.prompt(main, followPrompt)
  assert.equal(extra.results[0].job, id, JSON.stringify(extra.results[0]))
  const followed = await receive(followAnswer)
  assert.equal(followed.data.source.bridgeWorkflowId, id)
  await host.idle(main)
  assert.equal((await tasks()).length, 1)
  console.log('PASS one approved task supports a follow-up and automatic answer via the same message entry')
  const shortFollow = await host.prompt(main, titleFollow)
  assert.deepEqual(shortFollow.results, [])
  const byTitle = await receive(titleAnswer)
  assert.equal(byTitle.data.source.bridgeWorkflowId, id)
  await host.idle(main)
  assert.equal((await tasks()).length, 1)
  console.log('PASS native owner can append by an unambiguous workspace short number without a tool call')

  const unbound = await host.prompt(main, unboundOwner)
  assert.equal(unbound.results[0]?.error, 'workflow_task_context_required')
  assert(!(await fromBridge(ops, ['conversation'])).some((event) => body(event).includes(unboundBody)))
  const second = await host.prompt(main, later)
  assert.equal(laterCalls, 1)
  assert.equal(second.results.length, 1)
  assert(!second.results[0].error, JSON.stringify(second.results[0]))
  await receive(laterAnswer)
  await host.idle(main)
  assert.equal((await tasks()).length, 2)
  console.log('PASS a model call to the unified entry observes the host-owned route without a second dispatch')

  const refused = await host.prompt(observer, unrelated)
  assert(refused.results[0]?.error)
  assert(!(await fromBridge(ops, ['conversation'])).some((event) => body(event).includes(deniedBody)))
  const standaloneBody = '合成通知，不需要回复。'
  const standalone = await host.prompt(main, '给「88-旁观」窗口发消息：' + standaloneBody)
  assert.deepEqual(standalone.results, [])
  const ordinary = async () => (await get(observer)).filter(({ type, data }) =>
    type === 'user/message' && data.source?.kind === 'agent-message' &&
    !data.source.bridgeWorkflowKind && data.content.some(({ text }) => text.endsWith(standaloneBody)))
  await host.until(async () => (await ordinary())[0], 'standalone owner message arrives without a tool or confirmation')
  await host.idle(observer)
  assert.equal((await ordinary()).length, 1)
  console.log('PASS the host sends an explicitly addressed standalone message once without the old tool')

  for (const invalid of [
    '不要让99-运维检查目前电脑状态',
    '示例：' + exact,
    '你让99-运维检查目前电脑状态，算了。',
    '你让99-运维检查目前电脑状态，顺便把结果发给88-旁观。',
    '你让99-运维检查组窗口检查目前电脑状态，不要做任何修改',
  ]) await host.prompt(main, invalid)
  const relayed = await host.prompt(observer, '把『' + exact + '』发给『01-session-bridge』窗口')
  assert.deepEqual(relayed.results, [])
  await host.until(async () => (await get(main)).some(({ type, data }) =>
    type === 'user/message' && data.source?.kind === 'agent-message' &&
    !data.source.bridgeWorkflowKind && data.content.some(({ text }) => text.endsWith(exact))), 'relay is durably received')
  await host.idle(main)

  const draftMessages = async (body) => (await get(observer)).filter(({ type, data }) =>
    type === 'user/message' && data.source?.kind === 'agent-message' &&
    data.content.some(({ text }) => text.endsWith(body)))
  for (const [prompt, confirmation, body] of [
    [draftPrompt, '可以', draftBody], [secondDraftPrompt, '确认', secondDraftBody],
  ]) {
    const draft = await host.prompt(main, prompt)
    assert(draft.results[0].preview.includes(body))
    assert.equal((await draftMessages(body)).length, 0)
    await host.prompt(main, confirmation)
    await host.until(async () => (await draftMessages(body))[0], 'native confirmation delivers the exact visible draft')
    await host.prompt(main, confirmation)
    assert.equal((await draftMessages(body)).length, 1)
  }
  console.log('PASS both visible confirmation wording and a short owner affirmation send the exact draft once')

  const racing = await host.submit(main, renameRace)
  await host.until(() => raceStarted, 'owner turns starts before target renames')
  try {
    await host.rename(ops, '99-合成已改名')
    await host.rename(observer, '99-运维')
  } finally {
    releaseRace = true
  }
  await host.turn(main, racing)
  await host.idle(main)
  await host.rename(ops, '99-运维')
  await host.prompt(main, exact)
  await delay(600)
  await host.idle(main)
  assert.equal((await tasks()).length, 2)
  assert.equal((await fromBridge(observer, ['task', 'conversation'])).length, 0)
  await host.rename(observer, '99-运维检查组')
  await host.prompt(main, qualified)
  const long = await host.until(async () => (await fromBridge(observer, ['task']))[0], 'actual longer catalog title is selected')
  assert(long.data.content.some(({ text }) => text === goal))
  await host.idle(observer)
  await host.idle(main)
  assert.equal((await tasks()).length, 2)

  await host.prompt(main, '请让99-运维' + otherGoal)
  await receive(otherAnswer)
  await host.idle(main)
  assert.equal((await tasks()).length, 3)

  await host.rename(observer, '88-旁观')
  await host.prompt(main, '请安排99号窗口' + aliasGoal)
  await receive(aliasAnswer)
  await host.idle(main)
  assert.equal((await tasks()).length, 4)
  await host.prompt(main, '取消委托 ' + first.data.source.bridgeWorkflowTask)
  assert.equal(host.snapshot(main, first.data.source.bridgeWorkflowTask).grant.state, 'cancelled')

  await host.save({ enabled: false })
  await host.stop()
  await host.start()
  await delay(1250)
  assert.equal((await tasks()).length, 4)
  for (const text of [answer, followAnswer, titleAnswer, laterAnswer, otherAnswer, aliasAnswer]) {
    assert.equal((await answers(text)).filter(({ data }) => data.source.senderSessionId === ops).length, 1)
  }
  assert.equal((await answers(answer)).filter(({ data }) => data.source.senderSessionId === observer).length, 1)
  if (playwright) {
    const { verifyStatusBrowser } = await import('./status-browser-rc19.mjs')
    await verifyStatusBrowser(host, playwright, chrome, {
      main: '01-session-bridge', windows: ['99-运维', '88-旁观'], ids: [main, ops, observer],
      bodies: [exact, goal, answer, followup, titleBody, draftBody],
    })
  }
  console.log('PASS visible approval, native relay, unknown and duplicate titles, rename races, scoped withdrawal and restart')
})
