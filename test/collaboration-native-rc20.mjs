import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { latestPrompt, tool, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, archive, playwright, chrome] = process.argv.slice(2)
assert(dsh && archive && Boolean(playwright) === Boolean(chrome))
const owner = 'synthetic-native-owner'
const other = 'synthetic-native-unrelated'
const open = '请让子代理核对这次合成样例'
const prompt = '核对合成候选，先回报证据，再等我补充。'
const progress = '合成进展：已找到 synthetic.txt，请确认是否需要核对指纹。'
const followups = ['请子代理核对合成文件指纹。', '请子代理给出合成结论。']
const instructions = ['核对 synthetic.txt 的合成指纹。', '回报 synthetic.txt 的合成结论。']
const replies = ['合成指纹已核对，等下一步。', '合成结论：文件和指纹一致。']
const foreign = '模拟未经同意从旁窗向子代理发消息。'
const foreignBody = '此合成正文不应进入其他窗口的子代理。'
const wrongChildBody = '这条合成正文只点名独立执行窗口。'
const wrongChild = '给合成原生旁窗发消息：' + wrongChildBody
const independent = '你给合成原生旁窗这个窗口问他今天任务怎么样'
const task = /^DSH-WORKFLOW TASK ([a-f0-9-]+)$/
let claimed
let childId

function decide({ messages, tools }) {
  const current = latestPrompt(messages, (text) =>
    task.test(text) || [independent, open, prompt, foreign, wrongChild, ...followups, ...instructions].includes(text))
  if (!current) return { reply: '合成主控已收到。' }
  const { text, results } = current
  if (text === independent) return { reply: '' }
  const assignment = task.exec(text)
  if (assignment) {
    if (!results.length) return tool('workflow_claim', { id: assignment[1] })
    claimed = results[0]
    return { reply: '' }
  }
  if (text === open) {
    assert(tools.some(({ name }) => name === 'subagent'))
    assert(tools.some(({ name }) => name === 'send_message'))
    return results.length ? undefined : tool('subagent', { description: '合成候选核对', prompt })
  }
  if (text === prompt) {
    if (!results.length) return tool('send_message', { agent_id: owner, message: progress })
    return { reply: '已读取 synthetic.txt。' }
  }
  if (text === foreign) return results.length ? undefined :
    tool('workflow_message', { target: childId, text: foreignBody })
  if (text === wrongChild) return results.length ? undefined :
    tool('workflow_message', { target: childId, text: wrongChildBody })
  if (followups.includes(text)) return results.length ? undefined :
    tool('send_message', { agent_id: childId, message: instructions[followups.indexOf(text)] })
  const index = instructions.indexOf(text)
  if (!results.length) return tool('send_message', {
    agent_id: owner, message: index === 0 ? replies[index] : '合成进展：正在汇总两处指纹。',
  })
  return { reply: replies[index] }
}

await withCollaborationHost({ dsh, archive, decide }, async (host) => {
  await host.createSessions([[owner, '00-合成原生主控'], [other, '合成原生旁窗']])
  await host.save({ enabled: true })
  await host.prompt(owner, independent)
  await host.until(() => claimed?.id, 'an unrelated bridge task is active in the parent')
  assert.equal(claimed.owner, owner)
  await host.idle(other)
  const { results } = await host.prompt(owner, open)
  assert.match(results[0], /^started subagent /)
  childId = results[0].slice('started subagent '.length)
  const events = async (sessionId) => {
    if (sessionId === owner) return host.history(owner)
    const { records } = await host.rpc('session/events', { request: { maxMessages: 100,
      address: { kind: 'subagent', childSessionId: childId, parentSessionId: owner, mode: 'unknown' },
    } })
    return records.map(({ event }) => event).filter(Boolean)
  }
  const untilText = (sessionId, text) => host.until(async () =>
    (await events(sessionId)).find(({ type, data }) =>
      type === 'user/message' && data.content?.some((part) => part.text?.includes(text))),
  'native delivery of ' + text)
  const upward = await untilText(owner, progress)
  assert.equal(upward.data.source.kind, 'agent-message')
  assert.equal(upward.data.source.senderSessionId, childId)
  await untilText(owner, '已读取 synthetic.txt。')
  await host.idle(owner)
  assert(!(await events(owner)).some(({ type, data }) =>
    type === 'user/message' && data.source?.bridgeWorkflowKind === 'direct-notice'))
  assert.equal((await events(owner)).filter(({ type, data }) => type === 'user/message' &&
    data.content?.some((part) => part.text === progress)).length, 1)
  const childEvents = await events(childId)
  assert(childEvents.some(({ type, data }) => type === 'approval/policy' && data.policy === 'never'))
  assert(childEvents.some(({ type, data }) => type === 'sandbox/mode' && data.source === 'delegation'))
  assert(childEvents.some(({ type, data }) => type === 'user/message' &&
    data.content?.some(({ text }) => text?.includes(prompt))), JSON.stringify(childEvents.map(({ type, data }) =>
    type === 'user/message' ? [type, data.content] : type)))
  const refused = await host.prompt(other, foreign)
  assert.equal(typeof refused.results[0]?.error, 'string')
  assert(!(await events(childId)).some(({ type, data }) =>
    type === 'user/message' && data.content?.some((part) => part.text?.includes(foreignBody))))
  const mismatch = await host.prompt(owner, wrongChild)
  assert.deepEqual(mismatch.results[0], { state: 'waiting_for_owner_turn_end' })
  assert(!(await events(childId)).some(({ type, data }) =>
    type === 'agent/inbox/spliced' && data.inserted?.some((message) =>
      message.content?.some((part) => part.text?.includes(wrongChildBody)))))
  for (const [i, text] of followups.entries()) {
    const response = await host.prompt(owner, text)
    assert.equal(response.results[0], 'message delivered to agent ' + childId)
    const downward = await untilText(childId, instructions[i])
    assert.equal(downward.data.source.kind, 'agent-message')
    assert.equal(downward.data.source.senderSessionId, owner)
    const result = await untilText(owner, replies[i])
    assert.equal(result.data.source.senderSessionId, childId)
    if (i === 1) assert.equal(result.data.source.bridgeWorkflowKind, 'native-result')
    await host.idle(owner)
    const matching = (await host.history(owner)).filter(({ type, data }) => type === 'user/message' &&
      data.content?.some((part) => part.text?.includes(replies[i])))
    assert.equal(matching.length, 1)
  }
  const status = await host.post('/api/dsh-session-bridge/status-log', { sessionId: owner })
  assert.equal(status.status, 200)
  assert(status.body.events.some(({ kind, state, to }) =>
    kind === 'result' && state === 'returned' && to === '00-合成原生主控'))
  assert(!JSON.stringify(status.body).includes(replies[1]))
  console.log('PASS native spawn, host send_message works in both native parent-child directions, unrelated sender denied, native follow-ups and automatic results')
  if (playwright) {
    const { chromium } = await import(pathToFileURL(resolve(playwright)).href)
    const { launchUrl, env } = host.browserOptions()
    const browser = await chromium.launch({ executablePath: resolve(chrome), env, args: ['--disable-background-networking'] })
    try {
      const page = await browser.newPage({ locale: 'en-US' })
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => true })
      })
      await page.goto(launchUrl)
      const welcome = page.getByRole('button', { name: 'Continue', exact: true })
      if (await welcome.waitFor({ timeout: 2500 }).then(() => true, () => false)) await welcome.click()
      const workspace = page.getByText('synthetic-workspace', { exact: true }).first()
      const ownerRow = page.getByText('00-合成原生主控', { exact: true }).first()
      await workspace.waitFor()
      if (!await ownerRow.isVisible()) await workspace.click()
      await ownerRow.click()
      const shown = page.locator('[data-dsh-bridge-direct-result]').filter({ hasText: replies[1] })
      await shown.waitFor({ timeout: 12_000 })
      assert.equal(await shown.count(), 1)
      console.log('PASS browser displays the recovered native final once in the parent chat')
    } finally {
      await browser.close()
    }
  }
})
