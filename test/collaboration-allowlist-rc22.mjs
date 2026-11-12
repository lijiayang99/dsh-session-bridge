import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { latestPrompt, tool, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, old, archive, playwright, chrome] = process.argv.slice(2)
assert(dsh && old && archive && Boolean(playwright) === Boolean(chrome))
const name = '@local/dsh-session-bridge'
const ns = 'dsh-session-bridge-settings'
const main = 'synthetic-messaging-main'
const worker = 'synthetic-messaging-worker'
const other = 'synthetic-messaging-other'
const mainTitle = '01-合成主控'
const workerTitle = '99-运维'
const otherTitle = '88-合成旁观'
const exact = '你让99-运维检查目前电脑状态，不要做任何修改'
const instruction = '检查目前电脑状态，不要做任何修改'
const append = '请补查合成日志，仍然只读。'
const appendBody = '补查合成日志，仍然只读。'
const progress = '合成进度：只读检查已经开始。'
const answer = '合成结果：只读检查完成。'
const followAnswer = '合成结果：补查完成。'
const legacyBody = '升级前已有的合成消息。'
const legacyId = 'synthetic-legacy-receipt'
const legacyInput = '授权互传 ' + worker + ' ' + legacyId + '\n' + legacyBody
const probe = '检查当前可达的合成窗口。'
const denied = '尝试向合成执行窗发送。'
const oldHold = '保持旧合成执行窗口忙碌。'
const receiptPrompt = '读取之前的合成回执。'
const relay = /^\[DSH 会话消息｜发送方 ([a-zA-Z0-9_-]+)\]\n([\s\S]+)$/u
const planned = new Map()
let oldBusy = false
let release = false
let currentVersion = 'old'
let legacyRequest = legacyId
let workerCatalog

function send(to, text, request_id) {
  return tool('workflow_message', { to, text, ...(request_id ? { request_id } : {}) })
}

async function decide({ messages, tools }, { signal }) {
  const matched = latestPrompt(messages, (text) => [exact, append, oldHold, probe, denied, receiptPrompt].includes(text) ||
    planned.has(text) || relay.test(text))
  if (!matched) return { reply: '合成会话结束。' }
  const { text, results } = matched
  if (planned.has(text)) return results.length ? { reply: '合成操作已完成。' } : planned.get(text)
  if (text === oldHold) {
    oldBusy = true
    while (!release) await delay(15, undefined, { signal })
    return { reply: '旧合成窗口已空闲。' }
  }
  if (text === receiptPrompt) {
    if (results.length) return { reply: '合成回执已查。' }
    return currentVersion === 'new' ? tool('workflow_message', { action: 'status', request_id: legacyRequest })
      : tool('session_message_status', { request_id: legacyRequest })
  }
  if (currentVersion !== 'new') return { reply: '旧合成会话已回复。' }
  if (text === probe) return results.length ? { reply: '合成列表已查。' } : tool('workflow_message')
  if (text === denied) return results.length ? { reply: '合成权限已检查。' } : send(workerTitle, '不得送达的合成正文。')
  if (text === exact) {
    const names = tools.map(({ name }) => name)
    assert(names.includes('workflow_message'))
    for (const old of ['send_session_message', 'send_natural_session_message', 'workflow_delegate_direct',
      'workflow_propose', 'workflow_dispatch', 'workflow_report', 'session_message_status']) assert(!names.includes(old), old)
    if (!results.length) return tool('workflow_message')
    if (results.length === 1) {
      assert.deepEqual(results[0].sessions, [{ id: worker, title: workerTitle }])
      return send(workerTitle, instruction)
    }
    if (results.length === 2) return send(worker, instruction)
    return { reply: '合成主控已交办。' }
  }
  if (text === append) return results.length ? { reply: '合成补查已发。' } : send(worker, appendBody)
  const [_, origin, body] = relay.exec(text) ?? []
  if (body === instruction) {
    workerCatalog = tools.map(({ name }) => name)
    assert(workerCatalog.includes('workflow_message'))
    if (!results.length) return send(origin, progress)
    if (results.length === 1) return send(origin, answer)
  }
  if (body === appendBody && !results.length) return send(origin, followAnswer)
  return { reply: '合成结果已读取。' }
}

await withCollaborationHost({ dsh, archive, bootstrap: old, decide, modelDeadlineMs: 55_000 }, async (host) => {
  await host.createSessions([[main, mainTitle], [other, otherTitle]])
  const secondWorkspace = await host.createWorkspace(join(host.lab, 'synthetic-second-workspace'))
  await host.createSessions([[worker, workerTitle]], secondWorkspace)
  const legacy = { enabled: true, workflowEnabled: true, allowedSessions: [main, worker] }
  await host.save(legacy)
  const values = async () => (await host.rpc('settings/describe')).namespaces.find((entry) => entry.ns === ns).value
  const history = async (id) => {
    try { return await host.history(id) }
    catch (error) { if (!String(error.message).includes('session/agent-busy')) throw error; return [] }
  }
  const messages = async (id, sender, body) => (await history(id)).filter(({ type, data }) =>
    type === 'user/message' && data.source?.senderSessionId === sender &&
    data.content?.some(({ text }) => text?.endsWith('\n' + body)))
  const receive = (id, sender, body) => host.until(async () => (await messages(id, sender, body))[0], 'native message arrives')
  const checkReceipt = async () => (await host.prompt(main, receiptPrompt)).results[0]
  async function swap(packagePath, version) {
    assert.equal((await host.rpc('pluginManager/setBundleEnabled', { name, enabled: false })).application, 'applied')
    assert.equal((await host.rpc('pluginManager/removeBundle', { name })).application, 'applied')
    assert.equal((await host.install(packagePath, name)).version, version)
  }

  await host.prompt(main, legacyInput)
  await receive(worker, main, legacyBody)
  await host.idle(worker)
  const oldReceipt = await checkReceipt()
  assert.equal(oldReceipt.delivery, 'delivered')

  const busy = await host.submit(worker, oldHold)
  await host.until(() => oldBusy, 'fixed rc.20 target is busy')
  const oldTurn = await host.prompt(main, exact)
  const oldTask = 'direct-' + createHash('sha256').update(JSON.stringify([main, oldTurn.input.data.id])).digest('hex')
  const queued = await host.until(() => host.snapshot(main, oldTask).jobs[0], 'old job exists in the queue')
  assert.equal(queued.wake.state, 'queued')
  const ledgerFile = join(host.dshHome, 'profiles/web/dsh-session-bridge-workflow/workflow-v1.sqlite')
  try {
    await swap(archive, '0.5.0-rc.22')
  } finally {
    release = true
  }
  await host.turn(worker, busy)
  currentVersion = 'new'
  const dormantLedger = await readFile(ledgerFile)
  assert.deepEqual(await values(), { ...legacy, messagingEnabled: false, messagingSessions: [] })
  assert.deepEqual(await checkReceipt(), oldReceipt)
  assert.equal((await host.prompt(main, probe)).results[0].error, 'bridge_disabled')
  assert.equal((await host.prompt(main, denied)).results[0].error, 'bridge_disabled')
  console.log('PASS hot swap keeps an existing window, old true and old selections grant no new access, old receipt remains readable')

  let browser
  try {
    if (playwright) {
      const { chromium } = await import(pathToFileURL(resolve(playwright)).href)
      const { launchUrl, env } = host.browserOptions()
      browser = await chromium.launch({ executablePath: resolve(chrome), env, args: ['--disable-background-networking'] })
      const page = await browser.newPage({ locale: 'en-US' })
      await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => true }))
      await page.goto(launchUrl)
      const welcome = page.getByRole('button', { name: 'Continue', exact: true })
      if (await welcome.waitFor({ timeout: 2500 }).then(() => true, () => false)) await welcome.click()
      const workspace = page.getByText('synthetic-workspace', { exact: true }).first()
      const mainRow = page.getByText(mainTitle, { exact: true }).first()
      await workspace.waitFor()
      if (!await mainRow.isVisible()) await workspace.click()
      await mainRow.click()
      const sidebar = page.getByRole('button', { name: 'Open right sidebar', exact: true })
      if (await sidebar.isVisible()) await sidebar.click()
      await page.getByRole('button', { name: /dsh-session-bridge/ }).click()
      const master = page.locator('[data-dsh-bridge-master]')
      const allowlist = page.locator('[data-dsh-bridge-allowlist]')
      const mainBox = allowlist.getByRole('checkbox', { name: mainTitle })
      const workerBox = allowlist.getByRole('checkbox', { name: workerTitle })
      await master.waitFor({ timeout: 12000 })
      assert.equal(await master.isChecked(), false)
      assert.equal(await mainBox.isChecked(), false)
      assert.equal(await workerBox.isChecked(), false)
      assert.equal(await allowlist.getByRole('checkbox').count(), 3)
      assert.equal(await page.locator('[data-dsh-bridge-status-log], [data-dsh-bridge-source-status]').count(), 0)
      await master.click()
      await host.until(async () => (await values()).messagingEnabled, 'master setting persisted by the browser')
      assert.equal((await host.prompt(main, probe)).results[0].error, 'source_not_allowed')
      await mainBox.click()
      await host.until(async () => (await values()).messagingSessions.length === 1, 'first selection persisted')
      assert.deepEqual((await host.prompt(main, probe)).results[0], { sessions: [] })
      assert.equal((await host.prompt(main, denied)).results[0].error, 'destination_not_allowed')
      await workerBox.click()
      await host.until(async () => (await values()).messagingSessions.length === 2, 'second selection persisted')
      console.log('PASS Chrome exposes only the master toggle and session checklist, saves each, and denies either unchecked endpoint')
    } else {
      await host.save({ messagingEnabled: true })
      assert.equal((await host.prompt(main, probe)).results[0].error, 'source_not_allowed')
      await host.save({ messagingSessions: [main] })
      assert.deepEqual((await host.prompt(main, probe)).results[0], { sessions: [] })
      assert.equal((await host.prompt(main, denied)).results[0].error, 'destination_not_allowed')
      await host.save({ messagingSessions: [main, worker] })
    }

    assert.equal((await host.prompt(other, probe)).results[0].error, 'source_not_allowed')
    const result = await host.prompt(main, exact)
    assert.equal(result.results[1].delivery, 'delivered')
    assert.equal(result.results[2].duplicate, true)
    assert.equal(result.results[1].messageId, result.results[2].messageId)
    assert.equal((await receive(worker, main, instruction)).data.id, result.results[1].messageId)
    await receive(main, worker, progress)
    await receive(main, worker, answer)
    await host.idle(main)
    const more = await host.prompt(main, append)
    assert.equal(more.results[0].delivery, 'delivered')
    await receive(main, worker, followAnswer)
    await host.idle(main)
    assert.equal((await messages(worker, main, instruction)).length, 1)
    assert(workerCatalog.includes('workflow_message'))
    console.log('PASS two selected existing agents across workspaces discover, send, follow up, and return progress and results across multiple turns with receipt deduplication')

    await host.rename(other, workerTitle)
    assert.equal((await host.prompt(main, denied)).results[0].error, 'ambiguous_session_title')
    await host.rename(other, otherTitle)
    assert.equal((await messages(other, main, instruction)).length, 0)

    await host.save({ messagingSessions: [main] })
    assert.equal((await host.prompt(main, denied)).results[0].error, 'destination_not_allowed')
    assert.equal((await host.prompt(worker, probe)).results[0].error, 'source_not_allowed')
    await host.save({ messagingEnabled: false, messagingSessions: [main, worker] })
    await host.stop()
    await host.start()
    assert.deepEqual(await values(), { ...legacy, messagingEnabled: false, messagingSessions: [main, worker] })
    assert.equal((await host.prompt(main, denied)).results[0].error, 'bridge_disabled')
    assert.equal((await messages(worker, main, instruction)).length, 1)
    assert.equal(host.snapshot(main, oldTask).jobs[0].wake.state, 'queued')
    assert.deepEqual(await readFile(ledgerFile), dormantLedger)
    legacyRequest = result.results[1].requestId
    const newReceipt = await checkReceipt()
    assert.equal(newReceipt.messageId, result.results[1].messageId)
    await host.save({ enabled: false })
    await swap(old, '0.5.0-rc.20')
    currentVersion = 'rollback'
    assert.deepEqual(await checkReceipt(), newReceipt)
    legacyRequest = legacyId
    assert.deepEqual(await checkReceipt(), oldReceipt)
    assert.equal(host.snapshot(main, oldTask).jobs[0].wake.state, 'queued')
    assert.equal((await messages(worker, main, instruction)).length, 1)
    console.log('PASS selection and disabled state persist, rc.22 never touches the old queue, rollback reads both generations of receipts without replay')
  } finally {
    await browser?.close()
  }
})
