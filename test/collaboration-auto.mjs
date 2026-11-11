import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { latestPrompt, parts, tool, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, archive, playwright, chrome, mode] = process.argv.slice(2)
const baseline = mode === 'rc9'
assert(dsh && archive && Boolean(playwright) === Boolean(chrome) && (mode === undefined || baseline && chrome),
  'Usage: node test/collaboration-auto.mjs <dsh> <candidate.tgz> [playwright-core index.mjs Chrome [rc9]]')
if (baseline) {
  assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'),
    'ecea031f2012bb13df17116d1a79913607b79f795ba3a624005f1310c57c9ae3')
}

let owner = 'synthetic-auto-controller'
const worker = 'synthetic-auto-worker'
const alternate = 'synthetic-auto-other'
const unavailable = 'synthetic-auto-unavailable'
const ownerTitle = '00-main'
const workerTitle = '你是谁'
const inputText = '你给你是谁这个窗口问他今天成都天气怎么样'
const goal = '今天成都天气怎么样'
const reportText = '成都合成天气样本为晴，气温 21°C。'
const isReport = (text) => text.startsWith('委托回报 · ')
const taskMarker = /^DSH-WORKFLOW TASK ([a-f0-9-]+)$/
const unrelated = '合成普通对话，请复述这句话。'
const mixed = '你给你是谁这个窗口问他合成同轮问题'
const notice = '委托未发送。请在原窗口重试，使用引号写出一个完整且唯一的窗口名。'
const blocked = '委托未发送。请在右栏的会话白名单确认目标可用，再在原窗口重试。'
const relayRequest = 'synthetic-auto-copy-clarification'
const relayPrompt = () => '授权互传 ' + owner + ' ' + relayRequest + '\n' + notice
let mixedEntered = false
let releaseMixed = false
let claims = 0
let reports = 0
let holdReport = false
let reportStarted = false

async function decide({ messages }, { signal }) {
  const relay = latestPrompt(messages, (text) => text === relayPrompt())
  if (relay && !relay.results.length) {
    return tool('send_session_message', { to: owner, request_id: relayRequest, text: notice })
  }
  const request = latestPrompt(messages, (text) => text === mixed || taskMarker.test(text) || isReport(text))
  if (!request) return { reply: '合成主控模型只作普通答复。' }
  if (isReport(request.text)) {
    reportStarted = true
    while (holdReport) await delay(25, undefined, { signal })
    return { reply: '合成主控模型只作普通答复。' }
  }
  if (request.text === mixed) {
    mixedEntered = true
    while (!releaseMixed) await delay(25, undefined, { signal })
    return { reply: '合成同轮输入已处理。' }
  }
  const [, id] = taskMarker.exec(request.text)
  const [claim, report] = request.results
  if (!claim) {
    claims++
    return tool('workflow_claim', { id })
  }
  if (!report) {
    assert.equal(claim.owner, owner)
    assert.equal(claim.goal, goal)
    assert.equal(claim.instructions, goal)
    assert.equal(claim.attempt, 1)
    reports++
    return tool('workflow_report', {
      id, attempt: claim.attempt, token: claim.token, status: 'completed',
      summary: reportText, evidence: ['synthetic:chengdu-weather'],
    })
  }
  assert.equal(report.recorded, true)
}

const userText = (data) => parts(data.content).map(({ text }) => text).join('')
const resultNotices = (events) => events.filter(({ type, data }) =>
  type === 'user/message' && data.source?.bridgeWorkflowKind === 'result')

async function waitNotice(host, after, expected) {
  const event = await host.until(async () => (await host.history(owner)).find(({ type, data, seq }) =>
    seq > after && type === 'user/message' && data.source?.kind === 'agent-message' &&
    data.source.senderSessionId === owner && userText(data) === expected), 'owner clarification message')
  assert.equal(event.data.source.bridgeWorkflowKind, baseline ? undefined : 'direct-notice')
  assert.equal(event.data.source.bridgeWorkflowOwner, baseline ? undefined : owner)
  assert.equal(event.data.source.bridgeWorkflowId, undefined)
}

async function verifyClarification(page) {
  const trigger = page.locator('[data-turn-trigger]').getByRole('button', { name: /Task message received/ })
  const text = page.getByText(notice, { exact: true })
  await trigger.waitFor()
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
  if (baseline) {
    assert.equal(await text.count(), 0)
    await trigger.click()
    await text.waitFor()
    assert.equal(await text.count(), 1)
    console.log('PASS fixed rc.9 negative control hides the only clarification until the native trigger is expanded')
    return
  }
  await text.waitFor()
  assert.equal(await text.count(), 1)
  assert.equal(await page.locator('[data-dsh-bridge-direct-notice]').getByText(notice, { exact: true }).count(), 1)
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
  console.log('PASS rc.10 shows one clarification in the original chat while the native trigger remains collapsed')
}

async function verifyRelay(host, page) {
  const sent = await host.prompt(worker, relayPrompt())
  assert.equal(sent.results[0]?.delivery, 'delivered')
  const event = await host.until(async () => (await host.history(owner)).find(({ type, data }) =>
    type === 'user/message' && data.id === sent.results[0].messageId), 'ordinary relay with copied clarification text')
  assert.equal(event.data.source.senderSessionId, worker)
  assert.equal(event.data.source.bridgeWorkflowKind, undefined)
  assert.equal(event.data.source.bridgeWorkflowOwner, undefined)
  assert(userText(event.data).endsWith(notice))
  await host.idle(owner)
  const triggers = page.locator('[data-turn-trigger]').getByRole('button', { name: /Task message received/ })
  await triggers.nth(1).waitFor()
  assert.equal(await triggers.nth(1).getAttribute('aria-expanded'), 'false')
  assert.equal(await page.getByText(notice, { exact: true }).count(), 1)
  console.log('PASS ordinary relay delivers copied clarification text without adding a trusted clarification card')
}

function expireStoppedGrant(host, task, at) {
  const ledger = new DatabaseSync(join(host.dshHome, 'profiles/web/dsh-session-bridge-workflow/workflow-v1.sqlite'))
  try {
    const { body } = ledger.prepare('SELECT body FROM ledger WHERE id=1').get()
    const state = JSON.parse(body)
    state.grants[owner + ':' + task].expiresAt = at
    ledger.prepare('UPDATE ledger SET body=? WHERE id=1').run(JSON.stringify(state))
  } finally {
    ledger.close()
  }
}

async function recoverResult(host, late) {
  const name = '@local/dsh-session-bridge'
  holdReport = true
  reportStarted = false
  const accepted = await host.prompt(owner, inputText)
  const task = 'direct-' + createHash('sha256').update(JSON.stringify([owner, accepted.input.data.id])).digest('hex')
  await host.until(() => reportStarted, 'native report reached the controller model before restart')
  const before = host.snapshot(owner, task)
  const [job] = before.jobs
  assert.equal(before.grant.state, 'collaboration_active')
  assert(['sending', 'admitted'].includes(job.resume.state))
  assert.equal(job.resume.continuation, undefined)
  assert.equal((await host.rpc('pluginManager/setBundleEnabled', { name, enabled: false })).application, 'applied')
  if (late) expireStoppedGrant(host, task, Date.now() - 1)
  holdReport = false
  await host.idle(owner)
  const events = await host.history(owner)
  const displayed = resultNotices(events).find(({ data }) => data.id === job.resume.id)
  const ended = events.find(({ type, seq }) => type === 'turn/end' && seq > displayed.seq)
  assert.equal(ended.data.reason.kind, 'completed')
  if (!late) expireStoppedGrant(host, task, ended.time + 1)
  const deadline = host.snapshot(owner, task).grant.expiresAt
  assert.equal(ended.time > deadline, late)
  await host.until(() => Date.now() > deadline, 'synthetic deadline passes before restart')
  await host.stop()
  await host.start()
  assert.equal((await host.rpc('pluginManager/setBundleEnabled', { name, enabled: true })).application, 'applied')
  const recovered = await host.until(() => {
    const state = host.snapshot(owner, task)
    return state.grant?.state === (late ? 'expired' : 'closed') && state
  }, 'restart settles the persisted native report against the authorization deadline')
  assert.equal(recovered.jobs.length, 1)
  assert.equal(recovered.jobs[0].resume.id, job.resume.id)
  assert.equal(recovered.jobs[0].resume.state, late ? 'uncertain' : 'consumed')
  assert.equal(recovered.grant.outcome?.summary, late ? undefined : reportText)
  assert.equal(resultNotices(await host.history(owner)).filter(({ data }) => data.id === job.resume.id).length, 1)
}

async function withBrowser(host, run) {
  if (!playwright) return run()
  const { chromium } = await import(pathToFileURL(resolve(playwright)).href)
  const { launchUrl, env } = host.browserOptions()
  const browser = await chromium.launch({ executablePath: resolve(chrome), env, args: ['--disable-background-networking'] })
  try {
    const page = await browser.newPage({ locale: 'en-US' })
    page.setDefaultTimeout(8000)
    await page.goto(launchUrl)
    const welcome = page.getByRole('button', { name: 'Continue', exact: true })
    if (await welcome.waitFor({ timeout: 3000 }).then(() => true, () => false)) await welcome.click()
    await run(page)
  } finally {
    await browser.close()
  }
}

async function createController(host, workspace, page) {
  if (!page) return host.createSessions([[owner, ownerTitle]], workspace)
  const workspaceRow = page.getByText('synthetic-workspace', { exact: true })
  await workspaceRow.waitFor()
  const newSession = page.getByRole('button', { name: 'New session in synthetic-workspace', exact: true })
  if (!await newSession.isVisible()) await workspaceRow.click()
  const [created] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/session/create'),
    newSession.click(),
  ])
  const { result } = await created.json()
  assert(result?.ok)
  owner = result.value.sessionId
  await host.prompt(owner, '初始化合成窗口 ' + ownerTitle)
  assert.equal((await host.rename(owner, ownerTitle)).title, ownerTitle)
}

async function verifyBrowser(host, task, page) {
  const trigger = page.locator('[data-turn-trigger]').getByRole('button', { name: /Task message received/ }).last()
  const result = page.locator('[data-dsh-bridge-direct-result]')
  await result.getByText(reportText, { exact: false }).waitFor()
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
  assert.equal(await result.count(), 1)
  assert.equal(await page.getByText(reportText, { exact: false }).count(), 1)
  assert.equal(await result.getByText('委托回报 · 已完成', { exact: true }).count(), 1)
  const sidebar = page.getByRole('button', { name: 'Open right sidebar', exact: true })
  if (await sidebar.isVisible()) await sidebar.click()
  await page.getByRole('button', { name: /dsh-session-bridge/ }).click()
  const panel = page.locator('form').filter({ has: page.getByText('Session allowlist', { exact: true }) })
  const parent = panel.locator('summary').filter({ hasText: /^synthetic-workspace$/ })
  const child = panel.locator('summary').filter({ hasText: /^nested$/ })
  const prefix = panel.locator('summary').filter({ hasText: /^synthetic-workspace-other$/ })
  await parent.focus()
  await parent.press('Enter')
  await child.focus()
  await child.press('Enter')
  const selectedWorker = panel.getByRole('checkbox', { name: workerTitle, exact: true })
  assert.equal(await selectedWorker.isChecked(), true)
  await prefix.click()
  assert.equal(await selectedWorker.isVisible(), true)
  await prefix.click()
  assert.equal(await selectedWorker.isVisible(), true)
  await prefix.click()
  const other = panel.getByRole('checkbox', { name: '合成备用', exact: true })
  assert.equal(await other.isVisible(), true)
  assert.equal(await panel.getByText(alternate, { exact: true }).count(), 0)
  await panel.getByText('Unavailable selected sessions', { exact: true }).click()
  assert.equal(await panel.getByRole('checkbox', { name: /Unavailable session/ }).isChecked(), true)
  const master = panel.getByRole('checkbox', { name: 'Enable messaging and delegation' })
  const flags = async () => (await host.rpc('settings/describe')).namespaces
    .find(({ ns }) => ns === 'dsh-session-bridge-settings').value
  assert.equal(await master.evaluate((node) => node.indeterminate), true)
  await other.check()
  const save = panel.getByRole('button', { name: 'Save settings', exact: true })
  await save.click()
  await page.getByText('Settings saved and applied.', { exact: true }).waitFor()
  assert.deepEqual(await flags(), {
    enabled: true, workflowEnabled: false, allowedSessions: [owner, worker, unavailable, alternate],
  })
  await master.click()
  await save.click()
  await page.getByText('Settings saved and applied.', { exact: true }).waitFor()
  assert.deepEqual(await flags(), {
    enabled: true, workflowEnabled: true, allowedSessions: [owner, worker, unavailable, alternate],
  })
  await master.click()
  await save.click()
  await page.getByText('Settings saved and applied.', { exact: true }).waitFor()
  assert.deepEqual(await flags(), {
    enabled: false, workflowEnabled: false, allowedSessions: [owner, worker, unavailable, alternate],
  })
  await page.getByText('Controller tasks', { exact: true }).click()
  await page.getByRole('button', { name: task, exact: true }).click()
  await page.getByText('Verified owner turn', { exact: true }).waitFor()
  console.log('PASS Chrome shows one native report and a controller receipt, workspace hierarchy and independent folding, and preserves partial settings')
}

await withCollaborationHost({ dsh, archive, decide, timeRefreshIntervalMs: playwright ? undefined : 0 }, async (host) => {
  const parent = await host.createWorkspace()
  const child = await host.createWorkspace(join(host.work, 'nested'))
  const prefix = await host.createWorkspace(host.work + '-other')
  await withBrowser(host, (page) => run(host, { parent, child, prefix }, page))
})

async function run(host, { parent, child, prefix }, page) {
  await createController(host, parent, page)
  await host.createSessions([[worker, workerTitle]], child)
  await host.createSessions([[alternate, workerTitle]], prefix)
  const settings = { enabled: true, workflowEnabled: true, allowedSessions: [owner, worker, unavailable] }
  await host.save(settings)

  const sameName = await host.prompt(owner, inputText)
  assert.equal(sameName.results.length, 0)
  await waitNotice(host, sameName.end.seq, notice)
  await host.idle(owner)
  const endpoint = '/api/dsh-session-bridge/workflow-view'
  assert.deepEqual((await host.post(endpoint, { sessionId: owner })).body.tasks, [])
  assert.equal(claims, 0)
  assert.equal(reports, 0)
  for (const target of [worker, alternate]) {
    assert(!(await host.history(target)).some(({ data }) => data?.source?.bridgeWorkflowKind === 'task'))
  }
  if (page) await verifyClarification(page)
  if (baseline) return
  if (page) await verifyRelay(host, page)
  await host.rename(alternate, '合成备用')

  const uncertain = await host.prompt(owner, '你给你是谁和合成备用这个窗口问他今天成都天气怎么样')
  await waitNotice(host, uncertain.end.seq, notice)
  await host.idle(owner)

  const outside = await host.prompt(owner, '你给合成备用这个窗口问他今天成都天气怎么样')
  await waitNotice(host, outside.end.seq, blocked)
  await host.idle(owner)

  const initial = await host.submit(owner, mixed)
  await host.until(() => mixedEntered, 'owner turn is running before native steer')
  const steer = await host.submit(owner, unrelated, 'steer')
  releaseMixed = true
  const [first, second] = await Promise.all([host.turn(owner, initial), host.turn(owner, steer)])
  assert.equal(first.end.seq, second.end.seq)
  assert.equal(first.results.length, 0)

  mixedEntered = false
  releaseMixed = false
  const awaitingEnd = await host.submit(owner, mixed)
  await host.until(() => mixedEntered, 'owner turn is running before another request queues')
  const queued = await host.submit(owner, unrelated, 'queue')
  releaseMixed = true
  const [beforeQueue, queuedTurn] = await Promise.all([host.turn(owner, awaitingEnd), host.turn(owner, queued)])
  assert(beforeQueue.end.seq < queuedTurn.input.seq)
  assert.equal(beforeQueue.end.data.reason.kind, 'completed')

  mixedEntered = false
  releaseMixed = false
  const interrupted = await host.submit(owner, mixed)
  await host.until(() => mixedEntered, 'owner turn is running before native cancellation')
  await host.rpc('session/cancel', { request: { sessionId: owner } })
  const stopped = await host.turn(owner, interrupted)
  assert.equal(stopped.end.data.reason.kind, 'aborted')
  releaseMixed = true

  await host.save({ workflowEnabled: false })
  await host.prompt(owner, inputText)
  await host.idle(owner)
  await host.save({ workflowEnabled: true })
  assert.deepEqual((await host.post(endpoint, { sessionId: owner })).body.tasks, [])
  assert.equal(claims, 0)
  assert.equal(reports, 0)
  console.log('PASS same title outside the allowlist, ambiguous title, unavailable target, mixed, queued, aborted and disabled owner paths admit no job')

  const accepted = await host.prompt(owner, inputText)
  assert.equal(accepted.results.length, 0)
  assert.equal(accepted.end.data.reason.kind, 'completed')
  const task = 'direct-' + createHash('sha256').update(JSON.stringify([owner, accepted.input.data.id])).digest('hex')
  const snapshot = await host.until(() => {
    const state = host.snapshot(owner, task)
    return state.grant?.state === 'closed' && state
  }, 'structured report reaches the original controller and closes once')
  const [job] = snapshot.jobs
  assert.equal(snapshot.jobs.length, 1)
  assert.equal(snapshot.grant.authorization.ownerTurnEnd.sequence, accepted.end.seq)
  assert.equal(snapshot.grant.outcome.summary, reportText)
  assert.equal(job.resume.continuation.presentation, 'native-result')
  const history = await host.history(owner)
  assert.equal(history.filter(({ type }) => type === 'tool/result').length, 0)
  const received = resultNotices(history)
  assert.equal(received.length, 1)
  assert.equal(received[0].data.source.senderSessionId, worker)
  assert.equal(received[0].data.source.bridgeWorkflowOwner, owner)
  assert.equal(received[0].data.id, job.resume.id)
  assert.equal(userText(received[0].data),
    '委托回报 · 已完成\n\n' + reportText + '\n\n证据\nsynthetic:chengdu-weather')
  assert.equal(history.filter(({ type, data }) => type === 'assistant/message' &&
    data.message.content.some(({ text }) => text?.includes(reportText))).length, 0)
  assert.equal(claims, 1)
  assert.equal(reports, 1)

  if (page) {
    await host.save({ workflowEnabled: false })
    try {
      await verifyBrowser(host, task, page)
    } catch (error) {
      console.error((await page.locator('body').ariaSnapshot()).slice(-12000))
      throw error
    }
  }
  await host.stop()
  await host.start()
  await host.idle(owner)
  await host.idle(worker)
  assert.deepEqual(host.snapshot(owner, task), snapshot)
  assert.equal(resultNotices(await host.history(owner)).length, 1)
  assert.equal((await host.post(endpoint, { sessionId: owner, task })).body.authorization.ownerTurnEnd.sequence, accepted.end.seq)
  assert.equal(claims, 1)
  assert.equal(reports, 1)
  console.log('PASS exact owner utterance dispatches, reports and closes with zero main tools and one native report after restart')
  if (!page) {
    await recoverResult(host, false)
    await recoverResult(host, true)
    assert.equal(claims, 3)
    assert.equal(reports, 3)
    console.log('PASS restart after expiry closes only the timely native result without model tools and never replays either result')
  }
}
