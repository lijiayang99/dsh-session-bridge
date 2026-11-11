import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { latestPrompt, tool, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, archive, playwright, chrome] = process.argv.slice(2)
assert(dsh && archive && Boolean(playwright) === Boolean(chrome),
  'Usage: node test/collaboration-contextual.mjs <dsh> <candidate.tgz> [playwright-core index.mjs Chrome]')
const owner = 'synthetic-context-owner'
const worker = 'synthetic-context-worker'
const alternative = 'synthetic-context-alternative'
const otherProject = 'synthetic-context-other-project'
const title = '02-合成查询'
const topic = '你看一下02窗口今天干了啥。'
const followup = '你问一下他'
const combined = '你看一下02窗口今天干了啥，你问一下他'
const goal = '今天干了啥'
const none = '你想问哪个窗口、问什么？'
const multiple = '当前会话组里有多个窗口使用这个短号。你指哪个？请回完整标题。'
const noGoal = '窗口已找到。你想问什么？'
const naturalReply = '你今天为什么没完成审核？'
const mixedAction = '帮我问问02窗口，插件还有哪些坑？把结果发给03窗口。今天能处理吗？'
const withdrawn = '你给「02-合成查询」窗口问他今天干了啥，算了。'
const changed = '窗口或工作区发生了变化。现在想问哪个窗口？请回完整标题。'
const resultText = '合成查询已回报今天的进展。'
const marker = /^DSH-WORKFLOW TASK ([a-f0-9-]+)$/
const endpoint = '/api/dsh-session-bridge/workflow-view'
const plans = new Map()
let expectedGoal
let holdTopic = false
let topicRunning = false
let claims = 0
let reports = 0

const digest = (text) => createHash('sha256').update(text).digest('hex')
const textOf = (message) => message.content?.[0]?.text

async function decide({ messages }, { signal }) {
  const current = latestPrompt(messages, (text) => plans.has(text) || text === topic || marker.test(text))
  if (!current) return { reply: '合成主控只作普通回复。' }
  if (plans.has(current.text)) return current.results.length ? undefined : plans.get(current.text)
  if (current.text === topic) {
    topicRunning = true
    while (holdTopic) await delay(20, undefined, { signal })
    return { reply: '合成主控只作普通回复。' }
  }
  const [, id] = marker.exec(current.text)
  if (!current.results.length) {
    claims++
    return tool('workflow_claim', { id })
  }
  const [claim, report] = current.results
  if (!report) {
    assert.equal(claim.owner, owner)
    assert.equal(claim.instructions, expectedGoal)
    assert.equal(claim.goal, expectedGoal)
    assert.equal(claim.attempt, 1)
    reports++
    return tool('workflow_report', { id, attempt: claim.attempt, token: claim.token, status: 'completed',
      summary: resultText, evidence: ['synthetic:context'] })
  }
  assert.equal(report.recorded, true)
}

const tasks = async (host) => (await host.post(endpoint, { sessionId: owner })).body.tasks
const taskEvents = (host, id) => host.history(id).then((events) => events.filter(({ type, data }) =>
  type === 'user/message' && data.source?.bridgeWorkflowKind === 'task'))
const priorIds = (records) => records.map(({ input }) => input.data.id)

async function verifyDispatch(host, text, question, earlier = [], expectedSelector = 'alias') {
  expectedGoal = question
  const priorClaims = claims
  const priorReports = reports
  const request = await host.prompt(owner, text)
  assert.deepEqual(request.results, [])
  const task = 'direct-' + digest(JSON.stringify([owner, request.input.data.id]))
  const completed = await host.until(() => {
    const snapshot = host.snapshot(owner, task)
    return snapshot.grant?.state === 'closed' && snapshot
  }, 'one direct grant closes after the native result returns')
  const { grant, jobs } = completed
  assert.equal(grant.goal, question)
  assert.equal(grant.budget, 1)
  assert.equal(grant.authorization.ownerTurnEnd.sequence, request.end.seq)
  assert.equal(grant.authorization.request.sourceDigest, digest(text))
  assert.deepEqual(grant.authorization.targets, [{ id: worker, title }])
  const context = grant.authorization.context
  if (expectedSelector) {
    assert.equal(context.selector.kind, expectedSelector)
    if (expectedSelector === 'alias') assert.equal(context.selector.value, '02')
    assert.deepEqual(context.earlierInputs.map(({ messageId }) => messageId), priorIds(earlier))
    for (const [index, proof] of context.earlierInputs.entries()) {
      assert.equal(proof.sourceDigest, digest(textOf(earlier[index].input.data)))
      assert.equal(proof.endSequence, earlier[index].end.seq)
    }
  } else assert.equal(context, undefined)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].target, worker)
  assert.equal(jobs[0].resume.continuation.presentation, 'native-result')
  assert.equal(grant.outcome.summary, resultText)
  const [job] = jobs
  const wakes = (await taskEvents(host, worker)).filter(({ data }) => data.source.bridgeWorkflowId === job.id)
  assert.deepEqual(wakes.map(({ data }) => data.id), [job.wake.id])
  const history = await host.history(owner)
  const result = history.filter(({ type, data }) =>
    type === 'user/message' && data.source?.bridgeWorkflowKind === 'result' && data.source.bridgeWorkflowId === job.id)
  assert.deepEqual(result.map(({ data }) => data.id), [job.resume.id])
  assert(textOf(result[0].data).includes(resultText))
  const last = history.find(({ seq, type }) => seq > result[0].seq && type === 'turn/end')
  assert(last)
  assert(!history.some(({ seq, type }) => seq > result[0].seq && seq < last.seq && type === 'tool/result'))
  assert.equal(claims, priorClaims + 1)
  assert.equal(reports, priorReports + 1)
  await host.idle(owner)
  await host.idle(worker)
  return { grant, request }
}

async function waitNotice(host, turn, expected) {
  await host.until(async () => (await host.history(owner)).find(({ seq, type, data }) =>
    seq > turn.end.seq && type === 'user/message' && data.source?.kind === 'agent-message' &&
    data.source.bridgeWorkflowKind === 'direct-notice' && data.source.bridgeWorkflowOwner === owner &&
    data.source.senderSessionId === owner && textOf(data) === expected), 'native scoped clarification')
  await host.idle(owner)
}

async function withPlan(host, session, message, name, args) {
  plans.set(message, tool(name, args))
  try { return await host.prompt(session, message) } finally { plans.delete(message) }
}

async function withBrowser(host, run) {
  if (!playwright) return run()
  const { chromium } = await import(pathToFileURL(resolve(playwright)).href)
  const { launchUrl, env } = host.browserOptions()
  const browser = await chromium.launch({ executablePath: resolve(chrome), env, args: ['--disable-background-networking'] })
  try {
    const page = await browser.newPage({ locale: 'en-US' })
    await page.addInitScript(() => {
      // Keep DSH's real loopback socket active in the isolated namespace.
      Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => true })
    })
    page.setDefaultTimeout(9000)
    await page.goto(launchUrl)
    const welcome = page.getByRole('button', { name: 'Continue', exact: true })
    if (await welcome.waitFor({ timeout: 2500 }).then(() => true, () => false)) await welcome.click()
    const ownerRow = page.getByText('00｜合成主控', { exact: true }).first()
    const workspace = page.getByText('synthetic-workspace', { exact: true }).first()
    await workspace.waitFor()
    if (!await ownerRow.isVisible()) await workspace.click()
    await ownerRow.click()
    await run(page)
  } finally {
    await browser.close()
  }
}

await withCollaborationHost({ dsh, archive, decide, timeRefreshIntervalMs: 0 }, async (host) => {
  const project = await host.createWorkspace()
  const unrelated = await host.createWorkspace(join(host.lab, 'synthetic-other-workspace'))
  await host.createSessions([[owner, '00｜合成主控'], [worker, title], [alternative, '03-合成备用']], project)
  await host.createSessions([[otherProject, '02-合成异项目']], unrelated)
  await host.save({ enabled: true, workflowEnabled: true, allowedSessions: [owner, worker, otherProject] })

  await withBrowser(host, async (page) => {
    const positive = await verifyDispatch(host, combined, goal)
    assert.equal(positive.grant.authorization.context.workspace, project)
    if (page) {
      const shown = page.locator('[data-dsh-bridge-direct-result]').filter({ hasText: resultText })
      await shown.waitFor()
      assert.equal(await shown.count(), 1)
      const trigger = page.locator('[data-turn-trigger]').getByRole('button', { name: /Task message received/ }).last()
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
    }
    await verifyDispatch(host, topic + '\n' + followup, goal)
    const beforeTopic = (await tasks(host)).length
    const first = await host.prompt(owner, topic)
    assert.equal((await tasks(host)).length, beforeTopic)
    await verifyDispatch(host, followup, goal, [first])
    await verifyDispatch(host, '看一下02今天都做了什么，问一下他', '今天都做了什么')
    await verifyDispatch(host, '帮我问问02窗口，插件还有哪些坑？', '插件还有哪些坑？')
    console.log('PASS exact colloquial owner line, period/newline, and adjacent two-turn request dispatch once with zero controller bridge tools')

    await host.rename(alternative, '02-合成备选')
    const beforeConflict = (await tasks(host)).length
    const conflict = await host.prompt(owner, combined)
    await waitNotice(host, conflict, multiple)
    assert.equal((await tasks(host)).length, beforeConflict)
    assert.equal((await taskEvents(host, alternative)).length, 0)
    if (page) {
      const notice = page.locator('[data-dsh-bridge-direct-notice]').filter({ hasText: multiple })
      await notice.waitFor()
      assert.equal(await notice.count(), 1)
      const trigger = page.locator('[data-turn-trigger]').getByRole('button', { name: /Task message received/ }).last()
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
    }
    await verifyDispatch(host, '是「' + title + '」', goal, [conflict], 'title')
    await host.rename(alternative, '03-合成备用')

    const partial = await host.prompt(owner, '问一下02')
    await waitNotice(host, partial, noGoal)
    await verifyDispatch(host, naturalReply, naturalReply, [partial])
    const isolated = await host.prompt(owner, followup)
    await waitNotice(host, isolated, none)
    const named = await host.prompt(owner, '是「' + title + '」')
    await waitNotice(host, named, noGoal)
    await verifyDispatch(host, goal, goal, [isolated, named], 'title')
    console.log('PASS same-scope alias collision, isolated pronoun, and natural answers to missing target and question')
  })

  const before = (await tasks(host)).length
  const withdrawnTool = await withPlan(host, owner, withdrawn, 'workflow_delegate_direct', {})
  assert.deepEqual(withdrawnTool.results, [{ error: 'workflow_direct_owner_request_required' }])
  assert.equal((await tasks(host)).length, before)
  const toolProbe = await withPlan(host, owner, topic, 'workflow_delegate_direct', {})
  assert.deepEqual(toolProbe.results, [{ state: 'waiting_for_owner_request' }])
  assert.equal((await tasks(host)).length, before)
  await host.prompt(owner, '不用问了')
  await host.prompt(owner, topic)
  await host.rename(worker, '04-合成查询')
  await host.rename(alternative, '02-合成换绑')
  const drift = await host.prompt(owner, followup)
  await waitNotice(host, drift, changed)
  await host.rename(worker, title)
  await host.rename(alternative, '03-合成备用')

  for (const unrelated of ['这是一条无关合成对话。', '不用问了']) {
    await host.prompt(owner, topic)
    await host.prompt(owner, unrelated)
    await waitNotice(host, await host.prompt(owner, followup), none)
  }
  for (const example of ['示例：' + combined, '「' + combined + '」', '他说：' + combined,
    '别' + combined, combined + '，再发给03', '帮我问问02窗口，插件还有哪些坑？然后发给03？',
    '帮我问问02窗口，插件还有哪些坑，先别问了？', '你给02这个窗口问他插件还有哪些坑，算了。',
    withdrawn, mixedAction, '帮我问问02窗口，插件还有哪些坑？先别问了。你给我看看日志行吗？',
    '你给「02-合成查询」窗口问他插件还有哪些坑？把结果发给03窗口。']) {
    await host.prompt(owner, example)
  }

  const unrelatedInput = '在本窗口复述一个合成例子。'
  plans.set(unrelatedInput, { reply: combined })
  try { await host.prompt(owner, unrelatedInput) } finally { plans.delete(unrelatedInput) }
  await waitNotice(host, await host.prompt(owner, followup), none)

  await host.prompt(owner, topic)
  const command = '授权互传 ' + owner + ' synthetic-context-relay\n' + combined
  assert.equal((await withPlan(host, otherProject, command, 'send_session_message',
    { to: owner, request_id: 'synthetic-context-relay', text: combined })).results[0]?.delivery, 'delivered')
  await host.idle(owner)
  await waitNotice(host, await host.prompt(owner, followup), none)

  holdTopic = true
  topicRunning = false
  const opening = await host.submit(owner, topic)
  await host.until(() => topicRunning, 'topic turn is still active before a queued followup')
  const queued = await host.submit(owner, followup)
  holdTopic = false
  await host.turn(owner, opening)
  await waitNotice(host, await host.turn(owner, queued), none)
  assert.equal((await tasks(host)).length, before)
  assert.equal((await taskEvents(host, otherProject)).length, 0)
  assert.equal((await taskEvents(host, alternative)).length, 0)
  console.log('PASS target rename and alias rebinding, unrelated turn, cancellation, quotes, negation, relay and pre-queued input do not reuse authority')

  await host.prompt(owner, topic)
  await host.stop()
  await host.start()
  await waitNotice(host, await host.prompt(owner, followup), none)
  assert.equal((await tasks(host)).length, before)

  const send = '给「' + title + '」窗口发消息：' + mixedAction
  const ordinary = await withPlan(host, owner, send, 'send_natural_session_message', {})
  assert.equal(ordinary.results[0]?.delivery, 'delivered')
  await host.idle(worker)
  assert((await host.history(worker)).some(({ type, data }) => type === 'user/message' &&
    data.id === ordinary.results[0].messageId && textOf(data).endsWith(mixedAction)))
  assert.equal((await tasks(host)).length, before)

  await verifyDispatch(host, '你给「' + title + '」窗口问他插件为什么会把结果发给03窗口？',
    '插件为什么会把结果发给03窗口？', [], null)
  const literal = '逐字核对合成示例：今天干了啥，算了。'
  await verifyDispatch(host, '把『' + literal + '』委托给『' + title + '』', literal, [], null)
  console.log('PASS restart discards context and explicit ordinary messaging and old direct delegation keep their native routes')
})
