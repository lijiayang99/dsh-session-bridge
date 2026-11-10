import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const args = process.argv.slice(2)
assert.equal(args.length, 3, 'Usage: node test/migration.mjs <dsh> <0.4.2.tgz> <0.4.3-rc.3.tgz>')
assert(Object.values(networkInterfaces()).flat().every(({ internal }) => internal), 'Use a loopback-only network namespace')
const [dsh, stable, candidate] = args.map((path) => resolve(path))
const cli = await realpath(dsh)
const installDir = dirname(dirname(cli))
const installedHost = JSON.parse(await readFile(join(installDir, 'package.json'), 'utf8'))
assert.equal(installedHost.name, '@deepseek-ai/dsh')
assert.equal(installedHost.version, '0.2.2-rc.1')
const bundle = '@local/dsh-session-bridge'
for (const [file, version] of [[stable, '0.4.2'], [candidate, '0.4.3-rc.3']]) {
  const pkg = JSON.parse(execFileSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8' }))
  assert.equal(pkg.name, bundle)
  assert.equal(pkg.version, version)
  assert.deepEqual(pkg.engines, { dsh: '0.2.2-rc.1', node: '>=24.9.0' })
}

const lab = await mkdtemp(join(tmpdir(), 'bridge-migration-smoke-'))
const home = join(lab, 'dsh')
const work = join(lab, 'work')
const profile = join(home, 'profiles', 'web')
const patchFile = join(profile, 'cordis.patch.yml')
const old = {
  ns: 'session-bridge-settings',
  receipts: join(home, 'session-bridge', 'receipts'),
  ledger: join(profile, 'session-bridge-workflow'),
}
const renamed = {
  ns: 'dsh-session-bridge-settings',
  receipts: join(home, 'dsh-session-bridge', 'receipts'),
  ledger: join(profile, 'dsh-session-bridge-workflow'),
}
const from = 'synth-sender'
const to = 'synth-receiver'
const plans = new Map()
let host
let rpc
let output = ''
let modelFailure

const tool = (name, input) => ({ name, input })
const parts = (content) => typeof content === 'string' ? [{ type: 'text', text: content }] : content
const resultOf = ({ content }) => JSON.parse(parts(content).filter(({ type }) => type === 'text').map(({ text }) => text).join(''))

function decide(body) {
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const msg = body.messages[i]
    if (msg.role !== 'user') continue
    const content = parts(msg.content)
    const index = content.findLastIndex(({ type, text }) => type === 'text' &&
      (plans.has(text) || /^DSH-WORKFLOW (TASK|RESULT) /.test(text)))
    if (index < 0) {
      if (content.some(({ type, text }) => type === 'text' && !text.startsWith('Current runtime context') &&
          !text.startsWith('<'))) return
      continue
    }
    const text = content[index].text
    const results = [...content.slice(index + 1), ...body.messages.slice(i + 1).flatMap(({ content }) => parts(content))]
      .filter(({ type }) => type === 'tool_result').map(resultOf)
    if (plans.has(text)) return plans.get(text)(results, body.tools)
    const [, kind, id] = text.split(' ')
    if (kind === 'RESULT') {
      if (!results.length) return tool('workflow_consume', { id })
      const result = results[0]
      if (results.length === 1 && !result.error && !result.duplicate) return tool('workflow_close', { task: result.task })
      return
    }
    if (results.length === 0) return tool('workflow_claim', { id })
    if (results.length !== 1) return
    const claim = results[0]
    assert.equal(claim.instructions, 'Synthetic migration work')
    return tool('workflow_report', { id, attempt: claim.attempt, token: claim.token,
      status: 'completed', summary: 'Synthetic report for ' + claim.task, evidence: ['synthetic:' + claim.task] })
  }
}

const model = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/messages')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    const call = decide(body)
    if (call) assert(body.tools.some(({ name }) => name === call.name), 'Native tool missing: ' + call.name)
    const block = call
      ? { type: 'tool_use', id: 'toolu_' + randomUUID().replaceAll('-', ''), ...call }
      : { type: 'text', text: 'Synthetic acknowledgement.' }
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: block },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''))
  } catch (error) {
    modelFailure = error
    res.writeHead(500).end()
  }
})

async function until(read, description) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (modelFailure) throw modelFailure
    if (host?.exitCode !== null || host?.signalCode !== null) throw new Error('Isolated host exited: ' + description)
    const result = await read()
    if (result) return result
    await delay(80)
  }
  throw new Error('Timed out: ' + description)
}

async function start() {
  const env = {
    PATH: [dirname(process.execPath), dirname(dsh), '/usr/bin', '/bin'].join(':'),
    HOME: join(lab, 'home'),
    XDG_CONFIG_HOME: join(lab, 'config'),
    XDG_DATA_HOME: join(lab, 'data'),
    XDG_CACHE_HOME: join(lab, 'cache'),
    XDG_STATE_HOME: join(lab, 'state'),
    XDG_RUNTIME_DIR: join(lab, 'run'),
    TMPDIR: join(lab, 'tmp'),
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: 'synthetic-migration-only',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + model.address().port,
  }
  for (const [name, path] of Object.entries(env)) {
    if (name === 'HOME' || name.startsWith('XDG_') || name === 'TMPDIR' || name === 'DSH_HOME') {
      await mkdir(path, { recursive: true, mode: 0o700 })
    }
  }
  host = spawn(process.execPath, [cli, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
    { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
  output = ''
  for (const stream of [host.stdout, host.stderr]) stream.on('data', (chunk) => { output += chunk })
  const launch = new URL(await until(() => output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)?.[0], 'host launch'))
  const exchange = await fetch(launch, { redirect: 'manual' })
  assert.equal(exchange.status, 303)
  const cookie = exchange.headers.getSetCookie()[0].split(';')[0]
  rpc = async (method, args = {}) => {
    const response = await fetch(new URL('/api/' + method, launch.origin), {
      method: 'POST', headers: { 'content-type': 'application/json', origin: launch.origin, cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
      signal: AbortSignal.timeout(30_000),
    })
    const { result } = await response.json()
    assert(result?.ok, method + ' rejected: ' + (result?.error?.code ?? response.status))
    return result.value
  }
  return env.DSH_HOME
}

async function stop() {
  if (!host || host.exitCode !== null || host.signalCode !== null) return
  const closed = new Promise((done) => host.once('close', done))
  const watchdog = setTimeout(() => host.kill('SIGKILL'), 5000)
  host.kill('SIGTERM')
  await closed
  clearTimeout(watchdog)
}

async function install(spec) {
  const inspection = await rpc('pluginManager/inspect', { spec, options: {} })
  assert.equal(inspection.status, 'accepted')
  return rpc('pluginManager/installBundle', {
    spec, options: { enabled: false, requestId: randomUUID(), registry: inspection.registry },
  })
}

async function setBundle(enabled) {
  return rpc('pluginManager/setBundleEnabled', { name: bundle, enabled })
}

async function add(spec, version) {
  const result = await install(spec)
  assert.equal(result.application, 'applied')
  assert.equal(result.version, version)
  await setBundle(true)
}

async function remove() {
  assert.equal((await rpc('pluginManager/removeBundle', { name: bundle })).application, 'applied')
}

async function settings(ns) {
  const { namespaces } = await rpc('settings/describe')
  return namespaces.find((entry) => entry.ns === ns)
}

async function save(ns, patch) {
  const entry = await settings(ns)
  assert(entry, 'Settings namespace unavailable')
  const saved = await rpc('settings/update', { ns, expectedRevision: entry.revision, patch })
  for (const [key, value] of Object.entries(patch)) {
    assert.deepEqual(saved.value[key], value)
    assert.deepEqual((await settings(ns)).value[key], value)
  }
}

async function history(id) {
  const result = await rpc('session/events', { request: { address: { kind: 'session', sessionId: id }, maxMessages: 50 } })
  return result.records.map((record) => record.event).filter(Boolean)
}

async function prompt(id, text, plan) {
  const requestId = randomUUID()
  if (plan) plans.set(text, plan)
  try {
    const admitted = await rpc('session/prompt', {
      request: { requestId, sessionId: id, mode: 'queue', content: [{ type: 'text', text }] },
    })
    assert.equal(admitted.accepted, true)
    const waited = await rpc('session/wait', { request: { sessionId: id, timeoutMs: 15_000 } })
    if (modelFailure) throw modelFailure
    assert.equal(waited.reason, 'idle')
    const events = await history(id)
    const input = events.find(({ type, data }) => type === 'user/message' && data.source?.rpcId === requestId)
    assert(input, 'Native prompt missing')
    const end = events.find(({ type, seq }) => type === 'turn/end' && seq > input.seq)
    const result = events.find(({ type, seq }) => type === 'tool/result' && seq > input.seq && (!end || seq < end.seq))
    if (result) {
      assert.equal(result.data.message.isError, false)
      return JSON.parse(result.data.message.content[0].text)
    }
  } finally {
    if (plan) plans.delete(text)
  }
}

async function sessions() {
  const { workspace } = await rpc('workspace/create', { request: { path: work } })
  for (const sessionId of [from, to]) {
    assert.equal((await rpc('session/create', { request: { sessionId, workspaceId: workspace.workspaceId } })).sessionId, sessionId)
    await prompt(sessionId, 'Initialize ' + sessionId)
  }
}

const enabled = { enabled: true, workflowEnabled: true }
const disabled = { enabled: false, workflowEnabled: false }
const allowlist = [from, to]
const once = (call) => (results) => results.length === 0 ? call : undefined
const call = (text, name, input) => prompt(from, text, once(tool(name, input)))
const status = (task) => call('Read synthetic task ' + task, 'workflow_status', { task })
const readReceipt = (requestId) => call('Read synthetic receipt ' + requestId, 'session_message_status', { request_id: requestId })
const digest = (data) => createHash('sha256').update(data).digest('hex')
const ledgerFile = (layout) => join(layout.ledger, 'workflow-v1.sqlite')

const grant = (task) => '授权委托\n' + JSON.stringify({
  task, ttlMinutes: 10, goal: 'Synthetic migration test', scopes: [{ name: 'review', targets: [to] }],
})
const assignment = (task) => ({ task, item: 'one', attempt: 1, target: to, scope: 'review',
  instructions: 'Synthetic migration work', acceptance: 'Return a synthetic report.' })

async function makeReceipt(task) {
  const requestId = task + '-receipt'
  const text = 'Synthetic receipt for ' + task
  const sent = await call('授权互传 ' + to + ' ' + requestId + '\n' + text,
    'send_session_message', { to, request_id: requestId, text })
  assert.equal(sent.delivery, 'delivered')
  return until(async () => {
    const result = await readReceipt(requestId)
    return result?.processing === 'processed' ? result : undefined
  }, 'durable ordinary receipt')
}

async function makeHistory(task) {
  const receipt = await makeReceipt(task)
  const job = await call(grant(task), 'workflow_dispatch', assignment(task))
  assert.equal(job.duplicate, false)
  await until(async () => (await history(from)).some(({ type, data }) => {
    if (type !== 'tool/result') return false
    const output = data.message.content[0]?.text
    return output?.includes(JSON.stringify(task)) && output?.includes('"state":"closed"')
  }), 'native task closed')
  assert.equal((await rpc('session/wait', { request: { sessionId: from, timeoutMs: 15000 } })).reason, 'idle')
  const item = await until(async () => {
    const value = await call('Read synthetic attempt ' + task, 'workflow_item_status', { task, id: job.id })
    return value?.continuation?.continuation?.state === 'verified' ? value : undefined
  }, 'durable verified continuation')
  assert.equal(item.grantState, 'closed')
  assert.equal(item.report.reporter, to)
  assert.deepEqual(item.report.evidence, ['synthetic:' + task])
  return { task, receipt, item }
}

async function checkHistory(record) {
  assert.deepEqual(await readReceipt(record.receipt.requestId), record.receipt)
  assert.deepEqual(await call('Verify synthetic attempt ' + record.task, 'workflow_item_status', {
    task: record.task, id: record.item.id,
  }), record.item)
}

async function requireOff(layout) {
  assert.deepEqual((await settings(layout.ns)).value, { ...disabled, allowedSessions: allowlist })
}

async function moveSettings(fromLayout, toLayout) {
  const before = await readFile(patchFile, 'utf8')
  const marker = new RegExp('^(\\s*- id: )' + fromLayout.ns + '(\\s*)$', 'm')
  assert(marker.test(before))
  assert(!new RegExp('^\\s*- id: ' + toLayout.ns + '\\s*$', 'm').test(before))
  await writeFile(patchFile, before.replace(marker, '$1' + toLayout.ns + '$2'))
}

async function moveDir(source, dest) {
  await assert.rejects(stat(dest), { code: 'ENOENT' })
  await mkdir(dirname(dest), { recursive: true })
  await rename(source, dest)
}

async function replaceStopped(fromLayout, toLayout, spec, version) {
  await moveSettings(fromLayout, toLayout)
  await moveDir(fromLayout.receipts, toLayout.receipts)
  await moveDir(fromLayout.ledger, toLayout.ledger)
  await start()
  await remove()
  await add(spec, version)
  await stop()
  await start()
  await requireOff(toLayout)
  await assert.rejects(stat(fromLayout.ledger), { code: 'ENOENT' })
}

function requireEmptyLedger(layout) {
  const db = new DatabaseSync(ledgerFile(layout), { readOnly: true, timeout: 1000 })
  try {
    const active = db.prepare('SELECT body FROM ledger WHERE id = 1').get()
    assert.deepEqual(JSON.parse(active.body), { grants: {}, jobs: {} })
    for (const table of ['grant_history', 'job_history', 'job_quarantine']) {
      assert.equal(db.prepare('SELECT count(*) AS count FROM ' + table).get().count, 0)
    }
  } finally {
    db.close()
  }
}

async function absentTool(name, text) {
  let observed = false
  await prompt(from, text, (_results, tools) => {
    assert(!tools.some((tool) => tool.name === name))
    observed = true
  })
  assert(observed)
}

try {
  await mkdir(work)
  await mkdir(home)
  await writeFile(join(home, 'cordis.patch.yml'), '- id: session-title-llm\n  disabled: true\n')
  await new Promise((done) => model.listen(0, '127.0.0.1', done))
  await start()
  await add(stable, '0.4.2')
  await sessions()
  await save(old.ns, { ...disabled, enabled: true, allowedSessions: allowlist })
  const ordinary = await makeReceipt('ordinary-only')
  await save(old.ns, disabled)
  requireEmptyLedger(old)
  const emptyFile = await stat(ledgerFile(old))
  await setBundle(false)
  await stop()
  await replaceStopped(old, renamed, candidate, '0.4.3-rc.3')
  assert.deepEqual(await readReceipt(ordinary.requestId), ordinary)
  requireEmptyLedger(renamed)

  // Candidate activation fails before its settings and tools are available.
  // Retain the confirmed off settings and restore the old package anyway.
  await stop()
  await mkdir(old.receipts, { recursive: true })
  await writeFile(join(old.receipts, 'synthetic-marker'), 'Conflicting directory during candidate startup\n')
  await start()
  await absentTool('session_message_status', 'Candidate startup is blocked by the conflicting path')
  assert.equal(await settings(renamed.ns), undefined)
  await setBundle(false)
  await stop()
  await moveDir(old.receipts, join(lab, 'held-startup-conflict'))
  await replaceStopped(renamed, old, stable, '0.4.2')
  requireEmptyLedger(old)
  const restoredEmptyFile = await stat(ledgerFile(old))
  assert.deepEqual([restoredEmptyFile.dev, restoredEmptyFile.ino], [emptyFile.dev, emptyFile.ino])
  assert.deepEqual(await readReceipt(ordinary.requestId), ordinary)
  console.log('PASS ordinary-only empty ledger returns intact after candidate activation fails, with both switches off and no new delegation')

  await save(old.ns, enabled)
  const original = await makeHistory('original-task')
  await save(old.ns, disabled)
  await requireOff(old)
  await checkHistory(original)
  await setBundle(false)
  await stop()

  const oldLedgerHash = digest(await readFile(ledgerFile(old)))
  await moveSettings(old, renamed)
  await moveDir(old.receipts, renamed.receipts)
  await start()
  await remove()
  await add(candidate, '0.4.3-rc.3')
  await requireOff(renamed)
  await absentTool('workflow_status', 'Half-upgrade must refuse an unmoved ledger')
  await assert.rejects(stat(renamed.ledger), { code: 'ENOENT' })
  assert.equal(digest(await readFile(ledgerFile(old))), oldLedgerHash)
  await stop()
  console.log('PASS native partial upgrade detects the unmoved workflow ledger without creating an empty replacement')

  await mkdir(renamed.ledger)
  await writeFile(join(renamed.ledger, 'synthetic-marker'), 'Separate workflow directory\n')
  await start()
  await requireOff(renamed)
  await absentTool('workflow_status', 'Coexisting workflow directories must not be opened')
  await stop()
  assert.equal(digest(await readFile(ledgerFile(old))), oldLedgerHash)
  assert.equal(await readFile(join(renamed.ledger, 'synthetic-marker'), 'utf8'), 'Separate workflow directory\n')
  await assert.rejects(stat(ledgerFile(renamed)), { code: 'ENOENT' })
  await moveDir(renamed.ledger, join(lab, 'held-collision-ledger'))

  await mkdir(old.receipts, { recursive: true })
  await writeFile(join(old.receipts, 'synthetic-marker'), 'Separate receipt directory\n')
  await start()
  await absentTool('session_message_status', 'Coexisting receipt directories must refuse activation')
  await stop()
  assert.equal(await readFile(join(old.receipts, 'synthetic-marker'), 'utf8'), 'Separate receipt directory\n')
  await moveDir(old.receipts, join(lab, 'held-collision-receipts'))
  await moveDir(old.ledger, renamed.ledger)
  await start()
  await requireOff(renamed)
  await checkHistory(original)
  console.log('PASS conflicting workflow and receipt paths preserve both sides and recover after stopped-host reconciliation')

  // This rollback has one original delegation and no candidate delegation.
  // Reuse the current ledger and verify original evidence while still off.
  await setBundle(false)
  await stop()
  await replaceStopped(renamed, old, stable, '0.4.2')
  await checkHistory(original)
  assert.deepEqual(await status('candidate-task'), { error: 'grant_not_found' })
  await setBundle(false)
  await stop()
  await replaceStopped(old, renamed, candidate, '0.4.3-rc.3')
  await checkHistory(original)
  assert.deepEqual(await status('candidate-task'), { error: 'grant_not_found' })
  console.log('PASS rollback preserves the original attempt without manufacturing a candidate attempt')

  await save(renamed.ns, enabled)
  const added = await makeHistory('candidate-task')
  await save(renamed.ns, disabled)
  await requireOff(renamed)
  await checkHistory(original)
  await checkHistory(added)
  await setBundle(false)
  await stop()
  console.log('PASS upgrade preserves original history and the candidate adds durable workflow and ordinary receipts')

  // First reproduce the rejected runbook's incomplete rollback while off.
  await moveSettings(renamed, old)
  await moveDir(renamed.receipts, old.receipts)
  await start()
  await remove()
  await add(stable, '0.4.2')
  await stop()
  await start()
  await requireOff(old)
  assert.deepEqual(await readReceipt(original.receipt.requestId), original.receipt)
  assert.deepEqual(await readReceipt(added.receipt.requestId), added.receipt)
  assert.deepEqual(await status(original.task), { error: 'grant_not_found' })
  assert.deepEqual(await status(added.task), { error: 'grant_not_found' })
  assert((await stat(ledgerFile(old))).isFile())
  assert((await stat(ledgerFile(renamed))).isFile())

  // Deliberate negative control in this disposable profile only. Open an
  // authorization without dispatch to show what would happen if a user
  // ignored the history gate and turned delegation back on.
  await save(old.ns, { workflowEnabled: true })
  const mistaken = await call(grant(original.task), 'workflow_status', { task: original.task })
  assert.equal(mistaken.state, 'active')
  assert.deepEqual(mistaken.jobs, [])
  await save(old.ns, disabled)
  await requireOff(old)
  await setBundle(false)
  await stop()
  console.log('PASS incomplete rollback exposes the history gap and the disposable bypass demonstrates task-key reuse on an empty ledger')

  await moveDir(old.ledger, join(lab, 'held-wrong-rollback-ledger'))
  await moveDir(renamed.ledger, old.ledger)
  await start()
  await setBundle(true)
  await stop()
  await start()
  await requireOff(old)
  await checkHistory(original)
  await checkHistory(added)
  await save(old.ns, enabled)
  for (const record of [original, added]) {
    assert.deepEqual(await call(grant(record.task), 'workflow_dispatch', assignment(record.task)),
      { error: 'grant_not_opened' })
  }
  await save(old.ns, disabled)
  await requireOff(old)
  console.log('PASS complete native rollback restores both historical workflow attempts and receipts before reopening either switch')
} catch (error) {
  const sanitize = (text) => text.replaceAll(lab, '<isolated-migration>').replace(/token=[\w-]+/g, 'token=<ephemeral>')
  console.error(sanitize(String(error.stack ?? error)))
  console.error(sanitize(output).slice(-2400))
  process.exitCode = 1
} finally {
  await stop()
  model.closeAllConnections()
  await new Promise((done) => model.close(done))
  await rm(lab, { recursive: true, force: true })
}
