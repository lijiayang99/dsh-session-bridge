import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { latestPrompt, tool, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, archive, playwright, chrome, mode] = process.argv.slice(2)
const existingOwner = 'synthetic-flight-owner'
const baseline = mode === 'rc11'
assert(dsh && archive && playwright && chrome && (mode === undefined || mode === 'new' || baseline),
  'Usage: node test/sidebar-transfers.mjs <dsh> <candidate.tgz> <playwright-core index.mjs> <Chrome> [new|rc11]')
if (baseline) {
  assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'),
    'eeb9023482de8493a6ac9851d682255764ffc4a486455ea26386c0d01a4baec5')
}
const { chromium } = await import(pathToFileURL(resolve(playwright)).href)
const worker = 'synthetic-flight-worker'
const second = 'synthetic-flight-second'
const hidden = 'synthetic-flight-hidden'
const workerTitle = '合成接收窗口'
const secondTitle = '合成并发窗口'
const hiddenTitle = '合成折叠窗口'
const queuePrompt = '保持合成执行窗占用'
const goal = '报告合成投递状态'
const brokenGoal = '保持合成执行等待取消'
const resultGoal = '提交合成回报并中断原主控接续'
const resultSummary = '合成回报，用于核对中断接续'
const isInterruptedResult = (text) => text.startsWith('委托回报 · ') && text.includes(resultSummary)
const direct = (text) => '你给' + workerTitle + '这个窗口问他' + text
const privateBody = 'SYNTHETIC-BODY-NOT-IN-ACTIVITY'
const reportBody = 'SYNTHETIC-REPORT-NOT-IN-ACTIVITY'
const marker = /^DSH-WORKFLOW TASK ([a-f0-9-]+)$/
const ordinaryPlans = new Map()
let queueEntered = false
let releaseQueue = false
let claimSeen = false
let releaseReport = false
let resultJobId
let releaseResultReport = false
let resultConsumed = false

async function decide({ messages }, { signal }) {
  const current = latestPrompt(messages, (text) =>
    ordinaryPlans.has(text) || text === queuePrompt || marker.test(text) || isInterruptedResult(text))
  if (!current) return { reply: '合成会话正常结束。' }
  const { text, results } = current
  if (ordinaryPlans.has(text)) return results.length ? undefined : tool('send_session_message', ordinaryPlans.get(text))
  if (isInterruptedResult(text)) {
    if (!results.length) return tool('workflow_consume', { id: resultJobId })
    assert.equal(results[0]?.report?.summary, resultSummary)
    resultConsumed = true
    await delay(60_000, undefined, { signal })
    return
  }
  if (text === queuePrompt) {
    queueEntered = true
    while (!releaseQueue) await delay(20, undefined, { signal })
    return
  }
  const [, id] = marker.exec(text)
  if (results.length === 0) return tool('workflow_claim', { id })
  if (results.length !== 1) return
  const claim = results[0]
  claimSeen = true
  if (claim.goal === resultGoal) resultJobId = id
  while (!releaseReport || claim.goal === brokenGoal || (claim.goal === resultGoal && !releaseResultReport)) {
    await delay(20, undefined, { signal })
  }
  return tool('workflow_report', {
    id, attempt: claim.attempt, token: claim.token, status: 'completed',
    summary: claim.goal === resultGoal ? resultSummary : reportBody, evidence: ['synthetic:sidebar'],
  })
}

function send(host, from, to, request) {
  const request_id = 'synthetic-flight-' + request
  const command = '授权互传 ' + to + ' ' + request_id + '\n' + privateBody
  ordinaryPlans.set(command, { to, request_id, text: privateBody })
  return host.prompt(from, command)
}

function browserProbe() {
  // Chromium reports offline when the namespace has only loopback. The DSH
  // socket must still connect to the real loopback host in this fixture.
  Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => true })
  const events = { streams: 0, frames: [], flights: [] }
  window.bridgeProbe = events
  const NativeSource = window.EventSource
  window.EventSource = class extends NativeSource {
    constructor(url, options) {
      super(url, options)
      if (String(url) !== '/api/dsh-session-bridge/activity') return
      events.streams++
      for (const type of ['baseline', 'message']) {
        this.addEventListener(type, (event) => events.frames.push({ type, ...JSON.parse(event.data) }))
      }
    }
  }
  const seen = new WeakSet()
  const observe = (node) => {
    if (seen.has(node)) return
    seen.add(node)
    const sample = () => {
      if (!node.isConnected) return
      const [animation] = node.getAnimations()
      if (!animation) {
        requestAnimationFrame(sample)
        return
      }
      events.flights.push({
        kind: node.dataset.dshBridgeFlight,
        frames: animation.effect.getKeyframes().map(({ transform }) => transform),
        concurrent: document.querySelectorAll('[data-dsh-bridge-flight]').length,
      })
    }
    requestAnimationFrame(sample)
  }
  new MutationObserver((records) => {
    for (const { addedNodes } of records) {
      for (const node of addedNodes) {
        if (!(node instanceof Element)) continue
        if (node.matches('[data-dsh-bridge-flight]')) observe(node)
        node.querySelectorAll('[data-dsh-bridge-flight]').forEach(observe)
      }
    }
  }).observe(document, { childList: true, subtree: true })
}

const row = (page, sessionId) => page.locator('[data-row-key="session:' + sessionId + '"]')
const state = (page, sessionId, value) => row(page, sessionId).locator('[data-dsh-bridge-status="' + value + '"]')
const flights = (page) => page.evaluate(() => window.bridgeProbe.flights)
const frameList = (page) => page.evaluate(() => window.bridgeProbe.frames)
const waitFlights = (page, count) => page.waitForFunction((n) => window.bridgeProbe.flights.length >= n, count)
const numberOf = (page) => page.evaluate(() => window.bridgeProbe.streams)
const point = (box) => ({ x: box.x + box.width - 18, y: box.y + box.height / 2 })

async function direction(page, flight, from, to, kind) {
  assert.equal(flight.kind, kind)
  for (const [transform, id] of [[flight.frames[0], from], [flight.frames.at(-1), to]]) {
    const bounds = await row(page, id).boundingBox()
    const expected = point(bounds)
    const [, x, y] = /^translate\(([-.\d]+)px, ([-.\d]+)px\)/.exec(transform)
    assert([expected.x, bounds.x + bounds.width / 2, bounds.x + 16].some((anchor) => Math.abs(Number(x) - anchor) < 3),
      'flight horizontal anchor matches the actual row')
    assert(Math.abs(Number(y) - expected.y) < 3, 'flight vertical anchor matches the actual row')
  }
}

async function welcome(page, launchUrl) {
  await page.goto(launchUrl)
  const next = page.getByRole('button', { name: 'Continue', exact: true })
  if (await next.waitFor({ timeout: 2600 }).then(() => true, () => false)) await next.click()
  await page.waitForFunction(() => window.bridgeProbe.frames.some(({ type }) => type === 'baseline'))
}

async function openOwner(host, page) {
  const project = page.getByText('synthetic-workspace', { exact: true })
  const button = page.getByRole('button', { name: 'New session in synthetic-workspace', exact: true })
  await project.waitFor()
  if (mode !== 'new') {
    if (!await row(page, existingOwner).isVisible() && !await button.isVisible()) await project.click()
    await row(page, existingOwner).click()
    return existingOwner
  }
  if (!await button.isVisible()) await project.click()
  const [response] = await Promise.all([
    page.waitForResponse((result) => new URL(result.url()).pathname === '/api/session/create'),
    button.click(),
  ])
  const { result } = await response.json()
  assert(result?.ok)
  const id = result.value.sessionId
  await host.prompt(id, '初始化合成主控')
  await host.rename(id, '00-main')
  return id
}

async function reconcileArchived(host, page, owner, initiated, kind) {
  const task = 'direct-' + createHash('sha256').update(JSON.stringify([owner, initiated.input.data.id])).digest('hex')
  const getJob = () => host.snapshot(owner, task).jobs[0]
  const statusOf = (entry) => kind === 'task' ? entry.wake : entry.resume.continuation
  const job = getJob()
  const initialState = kind === 'task' ? 'uncertain' : 'interrupted'
  assert.equal(statusOf(job).state, initialState)
  await host.prompt(owner, '取消委托 ' + task)
  await host.until(async () => {
    const { body } = await host.post('/api/dsh-session-bridge/workflow-view', { sessionId: owner, task })
    return body.archivedJobs === 1 && body.jobs.some(({ id }) => id === job.id)
  }, 'cancelled attempt has entered history before owner reconciliation')
  const sequence = (await frameList(page)).at(-1).sequence
  const count = (await flights(page)).length
  const wakeIds = async (id) => (await host.history(id)).filter(({ type, data }) =>
    type === 'user/message' && data.source?.bridgeWorkflowId === job.id).map(({ data }) => data.id)
  const before = await Promise.all([wakeIds(worker), wakeIds(owner)])
  assert.deepEqual(before, [[job.wake.id], kind === 'task' ? [] : [job.resume.id]])

  const turn = await host.prompt(owner, '对账委托 ' + task + ' ' + job.id + ' ' + kind + '\n已在隔离试验核对。')
  assert.equal(turn.end.data.reason.kind, 'completed')
  await host.until(() => statusOf(getJob()).reconciliation, 'native owner reconciliation updates the archived attempt')
  const updated = statusOf(getJob())
  assert.equal(updated.state, kind === 'task' ? 'reconciled' : 'interrupted')
  assert.equal(updated.reconciliation.owner, owner)
  assert.equal(updated.reconciliation.decision, kind === 'task' ? 'release_without_replay' : 'reviewed_without_replay')
  if (baseline) {
    await page.waitForTimeout(1600)
    assert.equal(await state(page, owner, 'uncertain').count(), 1)
    assert.equal(await state(page, worker, 'uncertain').count(), 1)
  } else {
    for (const sessionId of [owner, worker]) {
      const indicator = state(page, sessionId, 'reconciled')
      await indicator.waitFor()
      assert.match(await indicator.getAttribute('aria-label'), /Reconciled/)
    }
  }
  assert.equal((await frameList(page)).at(-1).sequence, sequence)
  assert.equal((await flights(page)).length, count)
  assert.deepEqual(await Promise.all([wakeIds(worker), wakeIds(owner)]), before)
  console.log(baseline
    ? 'PASS fixed rc.11 reproduces stale sidebar after archived ' + kind + ' reconciliation without replay'
    : 'PASS archived ' + kind + ' reconciliation updates both sidebar rows without dispatch or flight')
}

async function run(host, page, launchUrl) {
  const owner = await openOwner(host, page)
  await host.save({ enabled: true, workflowEnabled: true, allowedSessions: [owner, worker, second, hidden] })
  await row(page, owner).waitFor()
  await row(page, worker).waitFor()
  await row(page, second).waitFor()
  await page.mouse.move(650, 200)
  assert.equal(await page.locator('[data-dsh-bridge-overlay]').evaluate((element) => getComputedStyle(element).pointerEvents), 'none')

  const ordinary = await send(host, owner, worker, 'first')
  assert.equal(ordinary.results[0]?.delivery, 'delivered')
  await waitFlights(page, 1)
  await direction(page, (await flights(page))[0], owner, worker, 'message')
  await state(page, worker, 'processed').waitFor()
  assert.match(await state(page, owner, 'processed').getAttribute('aria-label'), /Outgoing.*Processed/)
  const repeated = await send(host, owner, worker, 'first')
  assert.equal(repeated.results[0]?.duplicate, true)
  await host.idle(worker)
  assert.equal((await flights(page)).length, 1)
  console.log('PASS ordinary transfer flies from the real sending row to the receiving row and exact duplicate does not fly')

  const blocked = await host.submit(worker, queuePrompt)
  await host.until(() => queueEntered, 'busy worker turn entered')
  const queued = await host.prompt(owner, direct(goal))
  assert.equal(queued.results.length, 0)
  await state(page, owner, 'queued').waitFor()
  assert.equal((await flights(page)).length, 1)
  assert.equal(await state(page, owner, 'delivered').count(), 0)
  releaseQueue = true
  await host.turn(worker, blocked)
  await host.until(() => claimSeen, 'worker has claimed the native assignment')
  await state(page, worker, 'executing').waitFor()
  await waitFlights(page, 2)
  await direction(page, (await flights(page))[1], owner, worker, 'task')
  releaseReport = true
  await waitFlights(page, 3)
  await direction(page, (await flights(page))[2], worker, owner, 'result')
  await state(page, owner, 'received').waitFor()
  assert.match(await state(page, owner, 'received').getAttribute('aria-label'), /Returned result.*Received/)
  console.log('PASS queued assignment has no flight or success flag, claim shows execution, result flies in reverse')

  claimSeen = false
  const interruptedTask = await host.prompt(owner, direct(brokenGoal))
  await host.until(() => claimSeen, 'second worker claim awaits cancellation')
  await waitFlights(page, 4)
  await host.rpc('session/cancel', { request: { sessionId: worker } })
  await state(page, worker, 'uncertain').waitFor()
  assert.equal((await flights(page)).length, 4)
  assert.match(await state(page, owner, 'uncertain').getAttribute('aria-label'), /Needs reconciliation/)
  console.log('PASS interrupted claimed work shows needs reconciliation with no result flight')
  await reconcileArchived(host, page, owner, interruptedTask, 'task')

  const hiddenProject = page.getByText('synthetic-hidden', { exact: true })
  if (await row(page, hidden).isVisible()) await hiddenProject.click()
  await row(page, hidden).waitFor({ state: 'hidden' })
  assert.equal((await send(host, owner, hidden, 'collapsed')).results[0]?.delivery, 'delivered')
  await state(page, owner, 'processed').waitFor()
  await hiddenProject.click()
  await row(page, hidden).waitFor()
  await state(page, hidden, 'processed').waitFor()
  assert.equal((await flights(page)).length, 4)
  console.log('PASS collapsed receiver keeps sender status and expanding later does not replay a flight')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal((await send(host, second, worker, 'reduced')).results[0]?.delivery, 'delivered')
  await state(page, second, 'processed').waitFor()
  assert.equal((await flights(page)).length, 4)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForFunction(() => !document.querySelector('[data-dsh-bridge-flight]'))
  console.log('PASS reduced motion keeps text and accessible state without a flight')

  const visibleAnchor = (sessionId) => row(page, sessionId).evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(bounds.right - 18, bounds.top + bounds.height / 2))
  })
  const [top, lower] = (await row(page, owner).boundingBox()).y < (await row(page, second).boundingBox()).y
    ? [owner, second] : [second, owner]
  const tree = page.getByRole('tree', { name: 'Sessions' })
  const previousStyle = await tree.evaluate((element, sessionId) => {
    const previous = element.getAttribute('style')
    const bottom = element.querySelector('[data-row-key="session:' + sessionId + '"]').getBoundingClientRect().bottom
    element.style.maxHeight = Math.ceil(bottom - element.getBoundingClientRect().top) + 'px'
    element.style.overflowY = 'auto'
    return previous
  }, top)
  assert(await visibleAnchor(top))
  assert(!await visibleAnchor(lower))
  assert.equal((await send(host, top, lower, 'clipped')).results[0]?.delivery, 'delivered')
  await page.waitForFunction(() => window.bridgeProbe.frames.at(-1)?.sequence === 7)
  await state(page, top, 'processed').waitFor()
  await tree.evaluate((element, previous) => {
    if (previous === null) element.removeAttribute('style')
    else element.setAttribute('style', previous)
  }, previousStyle)
  assert.equal((await flights(page)).length, 4)
  console.log('PASS a clipped receiver never produces an offscreen flight and the visible sender retains status')

  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await row(page, owner).waitFor({ state: 'hidden' })
  assert.equal((await send(host, second, owner, 'hidden-sidebar')).results[0]?.delivery, 'delivered')
  await page.waitForFunction(() => window.bridgeProbe.frames.at(-1)?.sequence === 8)
  await page.locator('[data-sidebar-toggle]').click()
  await row(page, owner).waitFor()
  await state(page, owner, 'processed').waitFor()
  assert.equal((await flights(page)).length, 4)
  console.log('PASS hiding the sidebar keeps recent state for reopening without replay')

  const parallel = await Promise.all([
    send(host, owner, second, 'parallel-a'),
    send(host, worker, second, 'parallel-b'),
  ])
  assert(parallel.every(({ results }) => results[0]?.delivery === 'delivered'))
  await waitFlights(page, 6)
  const recent = (await flights(page)).slice(4)
  assert.equal(recent.length, 2)
  assert(recent.every(({ kind, concurrent }) => kind === 'message' && concurrent <= 4))
  const startingRows = recent.map(({ frames }) => Number(/^translate\([-.\d]+px, ([-.\d]+)px\)/.exec(frames[0])[1]))
  const expected = await Promise.all([owner, worker].map(async (id) => point(await row(page, id).boundingBox()).y))
  assert(expected.every((y) => startingRows.some((actual) => Math.abs(actual - y) < 3)))
  assert.equal(await numberOf(page), 1)
  const frames = await frameList(page)
  const last = frames.at(-1)
  assert.equal(last.sequence, 10)
  assert(frames.every(({ rows }) => rows.every((route) => Object.keys(route).every((key) =>
    ['id', 'from', 'to', 'kind', 'state', 'flight'].includes(key)))))
  assert(!JSON.stringify(frames).includes(privateBody))
  assert(!JSON.stringify(frames).includes(reportBody))

  const fresh = await page.context().newPage()
  try {
    await welcome(fresh, launchUrl)
    const baseline = (await frameList(fresh)).find(({ type }) => type === 'baseline')
    assert.equal(baseline.sequence, last.sequence)
    assert(baseline.rows.some(({ kind, state }) => kind === 'message' && state === 'processed'))
    assert(baseline.rows.some(({ flight }) => flight >= last.sequence - 1))
    assert.equal((await flights(fresh)).length, 0)
    assert.equal(await numberOf(fresh), 1)
  } finally {
    await fresh.close()
  }
  console.log('PASS concurrent transfers use one subscription, expose only route state and do not replay on first open')

  await row(page, owner).evaluate((element) => {
    const box = element.getBoundingClientRect()
    const cover = document.createElement('div')
    cover.id = 'synthetic-anchor-cover'
    Object.assign(cover.style, { position: 'fixed', left: (box.right - 24) + 'px',
      top: 0, width: '12px', height: '100vh', zIndex: 9999 })
    document.body.append(cover)
  })
  assert(!await visibleAnchor(owner))
  assert.equal((await send(host, owner, worker, 'fallback-anchor')).results[0]?.delivery, 'delivered')
  await waitFlights(page, 7)
  const fallback = (await flights(page)).at(-1)
  const [, x] = /^translate\(([-.\d]+)px, /.exec(fallback.frames[0])
  const sender = await row(page, owner).boundingBox()
  assert(Math.abs(Number(x) - (sender.x + sender.width / 2)) < 3)
  await page.locator('#synthetic-anchor-cover').evaluate((element) => element.remove())
  console.log('PASS a blocked edge uses a visible point on the same native row')

  await host.save({ allowedSessions: [owner, worker, second] })
  await page.waitForFunction((id) => window.bridgeProbe.frames.at(-1)?.rows.every(({ from, to }) =>
    from !== id && to !== id), hidden)
  const unauthenticated = await fetch(new URL('/api/dsh-session-bridge/activity', launchUrl),
    { signal: AbortSignal.timeout(3000) })
  assert([401, 403].includes(unauthenticated.status))
  console.log('PASS the open stream drops revoked routes and unauthenticated peers cannot read activity')

  const interruptedResult = await host.prompt(owner, direct(resultGoal))
  await waitFlights(page, 8)
  releaseResultReport = true
  await host.until(() => resultConsumed, 'the original controller has consumed the result')
  await waitFlights(page, 9)
  await host.rpc('session/cancel', { request: { sessionId: owner } })
  await state(page, owner, 'uncertain').waitFor()
  const activity = await state(page, owner, 'uncertain').getAttribute('aria-label')
  assert.match(activity, /Returned result.*Needs reconciliation/)
  await reconcileArchived(host, page, owner, interruptedResult, 'result')
}

await withCollaborationHost({ dsh, archive, decide }, async (host) => {
  const project = await host.createWorkspace()
  const hiddenProject = await host.createWorkspace(join(host.lab, 'synthetic-hidden'))
  await host.createSessions([[worker, workerTitle], [second, secondTitle]], project)
  if (mode !== 'new') await host.createSessions([[existingOwner, '00-main']], project)
  await host.createSessions([[hidden, hiddenTitle]], hiddenProject)
  const { launchUrl, env } = host.browserOptions()
  const browser = await chromium.launch({ executablePath: resolve(chrome), env, args: ['--disable-background-networking'] })
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } })
    await context.addInitScript(browserProbe)
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    try {
      await welcome(page, launchUrl)
      await run(host, page, launchUrl)
    } catch (error) {
      console.error(await page.evaluate(() => ({ streams: window.bridgeProbe.streams,
        frames: window.bridgeProbe.frames.slice(-3), flights: window.bridgeProbe.flights })))
      console.error((await page.locator('body').ariaSnapshot()).slice(-9000))
      throw error
    }
  } finally {
    await browser.close()
  }
})
