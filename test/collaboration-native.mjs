import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { latestPrompt, tool, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, archive, playwright, chrome] = process.argv.slice(2)
assert(dsh && archive && Boolean(playwright) === Boolean(chrome))
const owner = 'synthetic-native-owner'
const open = '请派一个本地子代理核对合成候选，先回报证据，再等我补充。'
const prompt = '核对合成候选，先回报证据，再等我补充。'
const progress = '合成进展：已找到 synthetic.txt，请确认是否需要核对指纹。'
const followups = ['请子代理核对合成文件指纹。', '请子代理给出合成结论。']
const instructions = ['核对 synthetic.txt 的合成指纹。', '回报 synthetic.txt 的合成结论。']
const replies = ['合成指纹已核对，等下一步。', '合成结论：文件和指纹一致。']
let childId

function decide({ messages, tools }) {
  const current = latestPrompt(messages, (text) =>
    [open, prompt, ...followups, ...instructions].includes(text))
  if (!current) return { reply: '合成主控已收到。' }
  const { text, results } = current
  if (text === open) {
    assert(tools.some(({ name }) => name === 'subagent'))
    assert(tools.some(({ name }) => name === 'send_message'))
    return results.length ? undefined : tool('subagent', { description: '合成候选核对', prompt })
  }
  if (text === prompt) {
    const relay = tool('send_session_message', { to: owner, request_id: 'native-progress', text: progress })
    if (results.length < 2) return relay
    assert.equal(results[0].delivery, 'delivered')
    assert(results[0].nativeMessageId)
    assert.equal(results[1].duplicate, true)
    assert.equal(results[1].nativeMessageId, results[0].nativeMessageId)
    return { reply: '已读取 synthetic.txt。' }
  }
  if (followups.includes(text)) return results.length ? undefined :
    tool('send_message', { agent_id: childId, message: instructions[followups.indexOf(text)] })
  const index = instructions.indexOf(text)
  if (!results.length) return tool('send_message', {
    agent_id: owner, message: index === 0 ? replies[index] : '合成进展：正在汇总两处指纹。',
  })
  return { reply: replies[index] }
}

await withCollaborationHost({ dsh, archive, decide }, async (host) => {
  await host.createSessions([[owner, '00-合成原生主控']])
  await host.save({ allowedSessions: [owner], workflowEnabled: true })
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
  assert.equal((await events(owner)).filter(({ type, data }) => type === 'user/message' &&
    data.content?.some((part) => part.text === progress)).length, 1)
  const childEvents = await events(childId)
  assert(childEvents.some(({ type, data }) => type === 'approval/policy' && data.policy === 'never'))
  assert(childEvents.some(({ type, data }) => type === 'sandbox/mode' && data.source === 'delegation'))
  assert(childEvents.some(({ type, data }) => type === 'user/message' &&
    data.content?.some(({ text }) => text?.includes(prompt))), JSON.stringify(childEvents.map(({ type, data }) =>
    type === 'user/message' ? [type, data.content] : type)))
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
  console.log('PASS native spawn, direct child progress, two native follow-ups and automatic results')
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
