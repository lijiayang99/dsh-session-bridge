import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { latestPrompt, tool, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, archive, mode = 'full', playwright, chrome] = process.argv.slice(2)
assert(dsh && archive && ['full', 'stress'].includes(mode) && Boolean(playwright) === Boolean(chrome),
  'Usage: node test/collaboration.mjs <dsh> <candidate.tgz> [full|stress] [playwright-entry chrome]')

let main = 'synthetic-main'
const other = 'synthetic-other-main'
const developer = 'synthetic-developer'
const verifier = 'synthetic-verifier'
const reviewer = 'synthetic-reviewer'
const titles = {
  [main]: '合成主控一', [other]: '合成主控二', [developer]: '合成开发窗口',
  [verifier]: '合成核查窗口', [reviewer]: '合成审核窗口',
}
const task = 'synthetic-release'
const plans = new Map()
const observed = { tasks: new Map(), results: new Map(), released: false, wrongEvidenceRejected: false }
const artifacts = new Map()
const wake = /^DSH-WORKFLOW (TASK|RESULT) ([a-f0-9-]+)$/
const instructions = {
  producer: 'PRIMARY synthetic candidate',
  verifier: 'PRIMARY independent verification',
  review: 'PRIMARY review the pinned candidate',
  other: 'SECONDARY candidate for the same task name',
  interrupt: 'INTERRUPT after the claim, before reporting',
  sandbox: 'SANDBOX test a synthetic file write inside and outside the delegated workspace',
}
const batchKey = 'initial'
const ref = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const repeated = (results, ...calls) => calls[results.length]
const error = (result) => assert.equal(typeof result?.error, 'string', 'Expected the workflow tool to fail closed')

function assignment(item, target, scope, work, attempt = 1) {
  return { item, target, scope, attempt, instructions: work, acceptance: 'Report the exact synthetic evidence.' }
}

function initialBatch(owner) {
  const primary = owner === main
  return {
    task, batch: batchKey, completion: 'All assigned work has settled. Continue using the structured results.',
    assignments: [
      assignment('produce', developer, 'develop', primary ? instructions.producer : instructions.other),
      assignment('verify', verifier, 'verify', primary ? instructions.verifier : 'SECONDARY independent verification'),
    ],
  }
}

function reviewAssignment(producer, artifact, attempt) {
  return {
    task, ...assignment('review', reviewer, 'review', instructions.review, attempt),
    reviewOf: producer, artifact,
  }
}

function naturalPlan(owner) {
  const primary = owner === main
  return {
    task,
    goal: primary
      ? '让合成开发窗口制作候选、合成核查窗口并行核查，再交合成审核窗口复核和收口。'
      : '让合成开发窗口制作第二个候选，合成核查窗口并行核查，然后汇总。',
    ttlMinutes: 20,
    budget: 10,
    scopes: [
      { name: 'develop', windows: [titles[developer]], purpose: '制作并交付固定合成候选' },
      { name: 'verify', windows: [titles[verifier]], purpose: '独立完成合成核查' },
      ...(primary ? [{ name: 'review', windows: [titles[reviewer]], purpose: '按固定产物引用审核与复审', review: true }] : []),
    ],
  }
}

async function worker(id, results, { work, signal }) {
  if (!results.length) return tool('workflow_claim', { id })
  const claim = results[0]
  if (claim.error || claim.duplicate) return
  const base = { id, attempt: claim.attempt, token: claim.token }
  if (claim.instructions === instructions.interrupt) {
    await delay(60_000, undefined, { signal })
    return
  }
  if (claim.instructions === instructions.sandbox) {
    const write = (path) => tool('bash', { description: 'Write synthetic permission boundary marker',
      command: "printf 'synthetic sandbox marker\\n' > " + JSON.stringify(path), workdir: work })
    if (results.length === 1) return write(join(work, 'allowed.txt'))
    if (results.length === 2) return write(observed.deniedPath)
    if (results.length === 3) {
      assert.match(JSON.stringify(results[2]), /sandbox|permission denied|read-only/i)
      return tool('workflow_report', { ...base, status: 'completed', summary: 'Host checked synthetic file writes.',
        evidence: ['synthetic:host-sandbox'] })
    }
    return
  }
  if (claim.scope === 'review') {
    const artifact = artifacts.get(main + ':' + claim.attempt)
    assert(artifact, 'Review is missing its producer artifact')
    const status = claim.attempt === 1 ? 'changes_requested' : 'approved'
    if (results.length === 1 && claim.attempt === 2) {
      return tool('workflow_report', { ...base, status, summary: 'Wrong pinned ref', evidence: [artifact.ref],
        reviewedArtifact: 'sha256:' + '0'.repeat(64) })
    }
    if (claim.attempt === 2 && results.length === 2) {
      error(results[1])
      observed.wrongEvidenceRejected = true
    }
    if (results.length === (claim.attempt === 2 ? 2 : 1)) {
      const bytes = await readFile(artifact.path)
      assert.equal(ref(bytes), artifact.ref)
      return tool('workflow_report', { ...base, status, summary: 'Verified exact candidate bytes',
        evidence: [artifact.ref], reviewedArtifact: artifact.ref })
    }
    return
  }
  if (results.length !== 1) return
  if (claim.item === 'produce') {
    if (claim.owner === main && claim.attempt === 1) {
      while (!observed.released) await delay(30, undefined, { signal })
    }
    const bytes = Buffer.from('synthetic fixture ' + claim.owner + ' ' + claim.attempt + '\n')
    const artifact = { ref: ref(bytes), path: join(work, claim.owner + '-' + claim.attempt + '.txt') }
    await writeFile(artifact.path, bytes, { flag: 'wx' })
    artifacts.set(claim.owner + ':' + claim.attempt, artifact)
    return tool('workflow_report', { ...base, status: 'completed', summary: claim.instructions,
      evidence: [artifact.ref], artifacts: [artifact.ref] })
  }
  return tool('workflow_report', { ...base, status: 'completed', summary: claim.instructions,
    evidence: ['synthetic:' + claim.owner] })
}

function controller(id, results) {
  if (!results.length) return tool('workflow_consume', { id })
  const result = results[0]
  if (result.error || result.duplicate) return
  if (result.batch) {
    assert.equal(result.task, task)
    const producer = result.batch.items.find(({ item }) => item === 'produce')
    const verification = result.batch.items.find(({ item }) => item === 'verify')
    assert(producer && verification, 'Batch result must include both children')
    const primary = producer.report.summary === instructions.producer
    const owner = primary ? main : other
    assert.equal(verification.report.evidence[0], 'synthetic:' + owner)
    const artifact = artifacts.get(owner + ':1').ref
    assert.deepEqual(producer.report.artifacts, [artifact])
    if (results.length === 1) return tool('workflow_consume', { id })
    assert.equal(results[1].duplicate, true)
    if (results.length === 2) {
      return primary
        ? tool('workflow_close', { task, outcome: 'completed', summary: 'Synthetic premature close before review.',
            finalArtifacts: [artifact] })
        : tool('workflow_close', { task, outcome: 'completed', summary: 'Second controller completed its independent batch.',
            finalArtifacts: [artifact] })
    }
    if (primary && results.length === 3) {
      assert.equal(results[2].error, 'approved_artifacts_required')
      return tool('workflow_dispatch', reviewAssignment(producer.id, artifact, 1))
    }
    return
  }
  if (results.length !== 1) return
  if (result.item === 'review' && result.attempt === 1) {
    assert.equal(result.report.status, 'changes_requested')
    return tool('workflow_dispatch', { task, ...assignment('produce', developer, 'develop', 'PRIMARY repaired candidate', 2) })
  }
  if (result.item === 'produce' && result.attempt === 2) {
    return tool('workflow_dispatch', reviewAssignment(result.id, result.report.artifacts[0], 2))
  }
  if (result.item === 'review' && result.attempt === 2) {
    assert.equal(result.report.status, 'approved')
    return tool('workflow_close', { task, outcome: 'completed', summary: 'Closed after repair and exact artifact re-review.',
      finalArtifacts: [artifacts.get(main + ':2').ref] })
  }
  return tool('workflow_close', { task: result.task })
}

async function decide(body, context) {
  const current = latestPrompt(body.messages, (text) => plans.has(text) || wake.test(text))
  if (!current) return
  const { text, results } = current
  if (plans.has(text)) return plans.get(text)(results, context)
  const [, kind, id] = wake.exec(text)
  const calls = kind === 'TASK' ? observed.tasks : observed.results
  if (!results.length) calls.set(id, (calls.get(id) ?? 0) + 1)
  return kind === 'TASK' ? worker(id, results, context) : controller(id, results)
}

async function drive(host, owner, text, plan) {
  plans.set(text, plan)
  try {
    return await host.prompt(owner, text)
  } finally {
    plans.delete(text)
  }
}

async function propose(host, owner, input, proposal = naturalPlan(owner)) {
  const requested = await drive(host, owner, input, (results) => {
    if (!results.length) return tool('workflow_propose', proposal)
    assert.equal(results[0].confirmation, 'owner_reply_required', JSON.stringify(results[0]))
    return { reply: results[0].preview }
  })
  assert.equal(requested.end.data.reason.kind, 'completed')
  assert(!host.snapshot(owner, proposal.task).grant, 'A proposal must not open a grant')
  const preview = requested.results[0].preview
  for (const value of [proposal.goal, ...proposal.scopes.flatMap(({ windows }) => windows)]) assert(preview.includes(value))
  return requested
}

async function confirmAndBatch(host, owner) {
  const batch = initialBatch(owner)
  const confirmed = await drive(host, owner, '确认委托', (results) => repeated(results,
    tool('workflow_confirm'), tool('workflow_confirm'),
    tool('workflow_dispatch_batch', batch), tool('workflow_dispatch_batch', batch)))
  assert.equal(confirmed.end.data.reason.kind, 'completed')
  assert(!confirmed.results[0].error, JSON.stringify(confirmed.results[0]))
  const [, repeatConfirmation, dispatch, replay] = confirmed.results
  error(repeatConfirmation)
  assert.equal(dispatch.duplicate, false, JSON.stringify(dispatch))
  assert.equal(dispatch.batch, batchKey)
  assert.equal(dispatch.ids.length, 2)
  assert.equal(replay.duplicate, true)
  assert.deepEqual(replay.ids, dispatch.ids)
  assert.equal(host.snapshot(owner, task).grant.owner, owner)
  return dispatch.ids
}

async function full(host, workspaceId, page) {
  const rows = Object.entries(titles)
  await host.createSessions(page ? rows.filter(([id]) => id !== main) : rows, workspaceId)
  await host.save({ enabled: false, workflowEnabled: true, allowedSessions: rows.map(([id]) => id) })
  await authorizationChecks(host, rows.map(([id]) => id))
  const firstText = '请分派这项任务：让合成开发窗口实现候选、合成核查窗口并行核查，合成审核窗口复审。'
  const otherText = '请分派这项任务：合成开发窗口和合成核查窗口并行完成第二个同名交付。'
  await propose(host, main, firstText)
  await propose(host, other, otherText)
  const mainIds = await confirmAndBatch(host, main)
  await host.until(() => {
    const { jobs } = host.snapshot(main, task)
    const producer = jobs.find(({ item }) => item === 'produce')
    const verification = jobs.find(({ item }) => item === 'verify')
    return producer?.claim && !producer.report && verification?.report
  }, 'independent verification while the producer is still working')
  assert.equal(observed.results.size, 0, 'The controller resumed before every batch member settled')
  const secondIds = await confirmAndBatch(host, other)
  assert(secondIds.every((id) => !mainIds.includes(id)))
  observed.released = true

  const first = await host.until(() => {
    const value = host.snapshot(main, task)
    return value.grant?.state === 'closed' && value
  }, 'main closes after review, repair and re-review', 60_000)
  const second = await host.until(() => {
    const value = host.snapshot(other, task)
    return value.grant?.state === 'closed' && value
  }, 'second controller closes its independent same-name task', 45_000)

  assert.equal(first.jobs.length, 5)
  assert.equal(second.jobs.length, 2)
  const firstReviews = first.jobs.filter(({ item }) => item === 'review')
  assert.deepEqual(firstReviews.map(({ report }) => report.status), ['changes_requested', 'approved'])
  for (const review of firstReviews) {
    const producer = first.jobs.find(({ item, attempt }) => item === 'produce' && attempt === review.attempt)
    assert.equal(review.report.reporter, reviewer)
    assert.equal(review.report.reviewedArtifact, producer.report.artifacts[0])
    assert.equal(ref(await readFile(artifacts.get(main + ':' + review.attempt).path)), review.report.reviewedArtifact)
  }
  assert(observed.wrongEvidenceRejected)
  for (const { owner, jobs } of [first, second].map(({ grant, jobs }) => ({ owner: grant.owner, jobs }))) {
    assert(jobs.every((job) => job.owner === owner))
    assert(jobs.every((job) => observed.tasks.get(job.id) === 1))
    assert.equal(jobs.filter((job) => job.resume && observed.results.has(job.id) && job.item !== 'review' && job.attempt === 1).length, 1)
  }
  assert.equal(observed.results.size, 5)
  assert([...observed.results.values()].every((count) => count === 1))
  assert.notEqual(artifacts.get(main + ':1').ref, artifacts.get(other + ':1').ref)
  console.log('PASS native natural approval, two parallel workers, one batch wake, same-name controller isolation, repair and pinned re-review')
  await view(host, page)
  await recovery(host)
  await permissions(host)
}

async function installGuestFixture(host) {
  const root = join(host.lab, 'workflow-guest-fixture')
  const name = '@local/dsh-workflow-smoke-guest'
  await mkdir(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name, version: '0.0.0', private: true, type: 'module', exports: { '.': './index.js' },
    engines: { dsh: '0.2.2-rc.1' }, dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(root, 'cordis.patch.yml'), '- insert:\n    - id: dsh-workflow-smoke-guest\n      name: ' + JSON.stringify(name) + '\n')
  await writeFile(join(root, 'index.js'), `
    import { randomUUID } from 'node:crypto'
    export const inject = ['connection', 'remoteAccess', 'typertGateway', 'tools']
    export function apply(ctx) {
      const kind = 'workflow-smoke-guest'
      const role = { name: 'workflow-smoke-prompt', resource: 'session', actions: ['session/prompt'] }
      ctx.remoteAccess.registerPolicy(kind, {
        bindings: ({ sessionId }) => sessionId ? [{ role, resource: { kind: 'session', id: sessionId } }] : [],
      })
      ctx.tools.register({
        name: 'workflow_smoke_guest',
        description: 'Submit a synthetic guest message through the native gateway.',
        parameters: { type: 'object', required: ['to', 'text'],
          properties: { to: { type: 'string' }, text: { type: 'string' } } },
        output: { schema: { type: 'object' },
          render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
        async execute({ to, text }) {
          const peer = ctx.connection.createPeer({ principal: { kind, sessionId: to } })
          const requestId = randomUUID()
          try {
            const result = await ctx.typertGateway.invoke({ namespace: 'session', method: 'prompt', peer,
              args: { request: { requestId, sessionId: to, mode: 'queue', content: [{ type: 'text', text }] } } })
            return { accepted: result.accepted, requestId }
          } finally {
            await peer.dispose()
          }
        },
      })
    }
  `)
  await host.install(root, name)
}

async function authorizationChecks(host, sessions) {
  const candidate = (suffix) => ({ ...naturalPlan(main), task: 'auth-' + suffix })
  const input = (suffix) => '请分派这项任务：让合成开发窗口执行合成授权边界 ' + suffix + '。'
  const confirm = (session) => drive(host, session, '确认委托', (results) => repeated(results, tool('workflow_confirm')))
  const rejected = async (session, task) => {
    error((await confirm(session)).results[0])
    assert(!host.snapshot(session, task).grant)
  }
  error((await drive(host, main, '描述合成任务，不执行。', (results) =>
    repeated(results, tool('workflow_propose', candidate('self'))))).results[0])

  await installGuestFixture(host)
  const guestInput = input('guest')
  plans.set(guestInput, (results) => repeated(results, tool('workflow_propose', candidate('guest'))))
  try {
    const { results } = await drive(host, verifier, '运行合成访客测试', (received) =>
      repeated(received, tool('workflow_smoke_guest', { to: main, text: guestInput })))
    assert.equal(results[0].accepted, true)
    const guest = await host.turn(main, results[0].requestId)
    assert.equal(guest.input.data.source.principal.kind, 'workflow-smoke-guest')
    error(guest.results[0])
    assert(!host.snapshot(main, candidate('guest').task).grant)
  } finally {
    plans.delete(guestInput)
  }

  const relayInput = input('relay')
  const relayed = '[DSH 会话消息｜发送方 ' + verifier + ']\n' + relayInput
  plans.set(relayed, (results) => repeated(results, tool('workflow_propose', candidate('relay'))))
  await host.save({ enabled: true })
  try {
    const receipt = await drive(host, verifier, '授权互传 ' + main + ' auth-relay\n' + relayInput,
      (results) => repeated(results, tool('send_session_message', { to: main, request_id: 'auth-relay', text: relayInput })))
    assert.equal(receipt.results[0].delivery, 'delivered')
    await host.idle(main)
    assert(!host.snapshot(main, candidate('relay').task).grant)
    const events = await host.history(main)
    const wake = events.find(({ type, data }) => type === 'user/message' && data.id === receipt.results[0].messageId)
    assert(wake)
    const attempted = events.find(({ type, seq }) => type === 'tool/result' && seq > wake.seq)
    error(JSON.parse(attempted.data.message.content[0].text))
  } finally {
    plans.delete(relayed)
    await host.save({ enabled: false })
  }

  const frozen = candidate('frozen')
  const altered = await drive(host, main, input('frozen'), (results) => {
    if (results.length === 0) return tool('workflow_propose', frozen)
    if (results.length === 1) return tool('workflow_propose', { ...frozen, budget: frozen.budget + 1 })
    return { reply: results[0].preview }
  })
  assert.equal(altered.results[0].confirmation, 'owner_reply_required')
  assert.equal(altered.results[1].error, 'workflow_proposal_frozen')
  await rejected(verifier, frozen.task)
  await host.prompt(main, '取消委托')
  await rejected(main, frozen.task)

  const drift = candidate('title')
  await propose(host, main, input('title'), drift)
  assert.equal((await host.rename(developer, '合成开发已改名')).title, '合成开发已改名')
  await rejected(main, drift.task)
  await host.rename(developer, titles[developer])

  const allow = candidate('allowlist')
  await propose(host, main, input('allowlist'), allow)
  await host.save({ allowedSessions: sessions.filter((id) => id !== developer) })
  await rejected(main, allow.task)
  await host.save({ allowedSessions: sessions })

  for (const mode of ['queue', 'steer']) {
    const plan = candidate(mode)
    const source = input(mode)
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    plans.set(source, async (results, { signal }) => {
      if (!results.length) return tool('workflow_propose', plan)
      entered.resolve(results[0])
      await Promise.race([release.promise, delay(10_000, undefined, { signal })])
      return { reply: results[0].preview }
    })
    plans.set('确认委托', (results) => repeated(results, tool('workflow_confirm')))
    try {
      const requestId = await host.submit(main, source)
      const proposed = await Promise.race([entered.promise, delay(10_000)])
      assert.equal(proposed?.confirmation, 'owner_reply_required')
      const early = await host.submit(main, '确认委托', mode)
      release.resolve()
      const [proposal, confirmation] = await Promise.all([host.turn(main, requestId), host.turn(main, early)])
      error(confirmation.results.at(-1))
      const inserted = proposal.records.find(({ type, data }) => type === 'agent/inbox/spliced' &&
        data.inserted.some((message) => message.id === confirmation.input.data.id))
      assert(inserted)
      assert.equal(inserted.data.target, mode === 'queue' ? 'next-turn' : 'next-step')
      assert(!host.snapshot(main, plan.task).grant)
    } finally {
      release.resolve()
      plans.delete(source)
      plans.delete('确认委托')
    }
  }
  console.log('PASS native owner workflow fences reject guest, relay, self-authorization, edits, other windows, cancellation, route drift and early queue or steer')
}

async function view(host, page) {
  const endpoint = '/api/dsh-session-bridge/workflow-view'
  const primary = await host.post(endpoint, { sessionId: main, task })
  const secondary = await host.post(endpoint, { sessionId: other, task })
  const wrong = await host.post(endpoint, { sessionId: verifier, task })
  assert.equal(primary.status, 200)
  assert.equal(secondary.status, 200)
  assert.equal(wrong.status, 404)
  const primaryRef = artifacts.get(main + ':2').ref
  const secondaryRef = artifacts.get(other + ':1').ref
  assert(JSON.stringify(primary.body).includes(primaryRef))
  assert(!JSON.stringify(primary.body).includes(secondaryRef))
  assert(JSON.stringify(secondary.body).includes(secondaryRef))
  assert(!JSON.stringify(secondary.body).includes(primaryRef))
  const listing = await host.post(endpoint, { sessionId: main })
  assert.equal(listing.status, 200)
  assert(listing.body.tasks.some((row) => row.task === task && row.owner === main))
  console.log('PASS native owner workflow view isolates same-name controller data')

  if (!page) return
  const sidebar = page.getByRole('button', { name: 'Open right sidebar', exact: true })
  try {
    if (await sidebar.isVisible()) await sidebar.click()
    await page.getByRole('button', { name: /dsh-session-bridge/ }).click()
    await page.getByText('Controller tasks', { exact: true }).click()
    await page.getByRole('button', { name: task, exact: true }).click()
    await page.getByText(primaryRef, { exact: true }).first().waitFor({ timeout: 10_000 })
    assert.equal(await page.getByText(secondaryRef, { exact: true }).count(), 0)
  } catch (error) {
    console.error((await page.locator('body').ariaSnapshot()).slice(-8000))
    throw error
  }
  console.log('PASS Chrome controller sidebar shows its own exact artifact reference')
}

async function browserFull(host) {
  if (!playwright) return full(host)
  const workspaceId = await host.createWorkspace()
  const { chromium } = await import(pathToFileURL(resolve(playwright)).href)
  const { launchUrl, env } = host.browserOptions()
  const browser = await chromium.launch({ executablePath: resolve(chrome), env, args: ['--disable-background-networking'] })
  try {
    const page = await browser.newPage({ locale: 'en-US' })
    page.setDefaultTimeout(8000)
    await page.goto(launchUrl)
    const welcome = page.getByRole('button', { name: 'Continue', exact: true })
    if (await welcome.waitFor({ timeout: 3000 }).then(() => true, () => false)) await welcome.click()
    const workspace = page.getByRole('treeitem', { name: /^synthetic-workspace(?: |$)/ })
    await workspace.waitFor()
    const newSession = page.getByRole('button', { name: 'New session in synthetic-workspace', exact: true })
    if (!await newSession.isVisible()) await page.getByText('synthetic-workspace', { exact: true }).click()
    const [created] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === '/api/session/create'),
      newSession.click(),
    ])
    const { result } = await created.json()
    assert(result?.ok)
    const title = titles[main]
    delete titles[main]
    main = result.value.sessionId
    titles[main] = title
    await host.prompt(main, '初始化合成窗口 ' + title)
    assert.equal((await host.rename(main, title)).title, title)
    await full(host, workspaceId, page)
  } finally {
    await browser.close()
  }
}

async function recovery(host) {
  const interrupted = 'synthetic-interruption'
  const grant = '授权委托\n' + JSON.stringify({
    task: interrupted, ttlMinutes: 10, goal: 'Verify that an interrupted execution is never replayed.',
    scopes: [{ name: 'develop', targets: [developer] }],
  })
  const sent = await drive(host, main, grant, (results) => repeated(results,
    tool('workflow_dispatch', { task: interrupted, ...assignment('break', developer, 'develop', instructions.interrupt) })))
  const id = sent.results[0]?.id
  assert(id, JSON.stringify(sent.results))
  await host.until(() => host.snapshot(main, interrupted).jobs.find((job) => job.id === id)?.claim,
    'worker claims the interrupted attempt')
  await host.rpc('session/cancel', { request: { sessionId: developer } })
  await host.idle(developer)
  const uncertain = await host.until(() => host.snapshot(main, interrupted).jobs.find((job) =>
    job.id === id && job.wake.state === 'uncertain'), 'interrupted claim is explicitly uncertain')
  assert(!uncertain.report)
  await host.stop()
  await host.start()
  assert.equal(host.snapshot(main, interrupted).jobs[0].wake.state, 'uncertain')
  const read = await drive(host, main, '读取中断合成任务', (results) => repeated(results,
    tool('workflow_item_status', { task: interrupted, id })))
  assert.equal(read.results[0].delivery.state, 'uncertain')
  assert.equal(observed.tasks.get(id), 1)
  await host.prompt(main, '对账委托 ' + interrupted + ' ' + id + ' task\n合成中断证据仅证明已领取，释放并保留记录。')
  await host.until(() => host.snapshot(main, interrupted).jobs.find((job) =>
    job.id === id && job.wake.state === 'reconciled'), 'owner reconciliation releases without replay')
  assert.equal(observed.tasks.get(id), 1)
  console.log('PASS native claimed-turn interruption, restart uncertainty and owner reconciliation without replay')
}

async function permissions(host) {
  // Fixed DSH workspace-write permits its temporary directories, including
  // /tmp. Choose an empty, disposable directory outside those roots.
  const outside = await mkdtemp('/var/tmp/bridge-sandbox-probe-')
  observed.deniedPath = join(outside, 'outside.txt')
  try {
    const key = 'synthetic-permission-boundary'
    const grant = '授权委托\n' + JSON.stringify({
      task: key, ttlMinutes: 10, goal: 'Check the isolated host file permission boundary.',
      scopes: [{ name: 'develop', targets: [developer] }],
    })
    const admitted = await drive(host, main, grant, (results) => repeated(results,
      tool('workflow_dispatch', { task: key, ...assignment('check-sandbox', developer, 'develop', instructions.sandbox) })))
    const id = admitted.results[0]?.id
    assert(id, JSON.stringify(admitted.results))
    await host.until(() => host.snapshot(main, key).jobs.find((job) =>
      job.id === id && job.report?.status === 'completed'), 'synthetic host permission test report')
    assert.equal(await readFile(join(host.work, 'allowed.txt'), 'utf8'), 'synthetic sandbox marker\n')
    await assert.rejects(readFile(observed.deniedPath), { code: 'ENOENT' })
    console.log('PASS delegated worker uses native workspace-write and cannot write outside its sandbox')
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
}

async function stress(host) {
  const ids = Array.from({ length: 30 }, (_, index) => 'synthetic-load-' + (index + 1))
  await host.createSessions(ids.map((id) => [id, id]))
  await host.save({ enabled: false, workflowEnabled: true, allowedSessions: ids })
  const started = Date.now()
  const tasks = ids.slice(0, 10).map((owner, index) => ({ owner, target: ids[10 + index],
    second: ids[20 + index], key: 'stress-' + (index + 1) }))
  const admitted = await Promise.all(tasks.map(({ owner, target, second, key }) => {
    const grant = '授权委托\n' + JSON.stringify({
      task: key, goal: 'Run two bounded synthetic checks.', ttlMinutes: 10,
      scopes: [{ name: 'verify', targets: [target, second] }],
    })
    const job = (id, item) => tool('workflow_dispatch', { task: key, ...assignment(item, id, 'verify', 'Synthetic load') })
    return drive(host, owner, grant, (results) => repeated(results, job(target, 'left'), job(second, 'right')))
  }))
  assert(admitted.every(({ results }) => results.length === 2 && results.every(({ duplicate }) => duplicate === false)))
  const settled = await host.until(() => {
    const snapshots = tasks.map(({ owner, key }) => host.snapshot(owner, key))
    return snapshots.every(({ jobs }) => jobs.length === 2 &&
      jobs.every(({ report, resume }) => report?.status === 'completed' && resume?.state === 'consumed')) && snapshots
  }, 'twenty work deliveries across thirty sessions', 90_000)
  const jobs = settled.flatMap(({ jobs }) => jobs)
  assert(jobs.every((job) => observed.tasks.get(job.id) === 1 && observed.results.get(job.id) === 1))
  const times = (values) => {
    values.sort((a, b) => a - b)
    return { min: values[0], p50: values[Math.ceil(values.length * .5) - 1], max: values.at(-1) }
  }
  console.log('PASS thirty native sessions and twenty distinct executions and continuations', JSON.stringify({
    durationMs: Date.now() - started,
    queueMs: times(jobs.map((job) => job.claim.at - job.createdAt)),
    executionMs: times(jobs.map((job) => job.report.at - job.claim.at)),
    continuationMs: times(jobs.map((job) => job.resume.handoffAt - job.report.at)),
  }))
}

await withCollaborationHost({ dsh, archive, decide }, mode === 'stress' ? stress : browserFull)
