import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
assert.equal(args.length, 4, 'Usage: node test/diagnostics.mjs <dsh> <tgz> <playwright-core index.mjs> <Chrome>')
assert(Object.values(networkInterfaces()).flat().every(({ internal }) => internal), 'Use a loopback-only network namespace')
const [dsh, archive, playwrightEntry, chrome] = args.map((path) => resolve(path))
const cli = await realpath(dsh)
const installDir = dirname(dirname(cli))
const installedHost = JSON.parse(await readFile(join(installDir, 'package.json'), 'utf8'))
assert.equal(installedHost.name, '@deepseek-ai/dsh')
assert.equal(installedHost.version, '0.2.2-rc.1')
const pkg = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }))
assert.equal(pkg.name, '@local/dsh-session-bridge')
assert.equal(pkg.version, '0.4.4-rc.3')
assert.deepEqual(pkg.engines, { dsh: '0.2.2-rc.1', node: '>=24.9.0' })

const lab = await mkdtemp(join(tmpdir(), 'bridge-diagnostics-smoke-'))
const namespace = 'dsh-session-bridge-settings'
const from = 'synth-sender'
const to = 'synth-receiver'
const plans = new Map()
const unknownVersion = '0.2.2-rc.999'
let host
let rpc
let browserEnv
let launch
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
    if (kind === 'RESULT') return results.length === 0 ? tool('workflow_consume', { id }) : undefined
    if (results.length === 0) return tool('workflow_claim', { id })
    if (results.length !== 1) return
    const claim = results[0]
    assert.equal(claim.instructions, 'Synthetic diagnostic smoke')
    return tool('workflow_report', { id, attempt: claim.attempt, token: claim.token,
      status: 'completed', summary: 'Synthetic diagnostic report', evidence: [] })
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

async function start(entry, isolated, work) {
  const env = {
    PATH: [dirname(process.execPath), dirname(dsh), '/usr/bin', '/bin'].join(':'),
    HOME: join(isolated, 'home'),
    XDG_CONFIG_HOME: join(isolated, 'config'),
    XDG_DATA_HOME: join(isolated, 'data'),
    XDG_CACHE_HOME: join(isolated, 'cache'),
    XDG_STATE_HOME: join(isolated, 'state'),
    XDG_RUNTIME_DIR: join(isolated, 'run'),
    TMPDIR: join(isolated, 'tmp'),
    DSH_HOME: join(isolated, 'dsh'),
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: 'synthetic-diagnostics-only',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + model.address().port,
  }
  for (const [name, path] of Object.entries(env)) {
    if (name === 'HOME' || name.startsWith('XDG_') || name === 'TMPDIR' || name === 'DSH_HOME') {
      await mkdir(path, { recursive: true, mode: 0o700 })
    }
  }
  await writeFile(join(env.DSH_HOME, 'cordis.patch.yml'), '- id: session-title-llm\n  disabled: true\n')
  host = spawn(process.execPath, [entry, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
    { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [host.stdout, host.stderr]) stream.on('data', (chunk) => { output += chunk })
  launch = new URL(await until(() => output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)?.[0], 'host launch'))
  browserEnv = env
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

async function enable() {
  const result = await install(archive)
  assert.equal(result.application, 'applied')
  assert.equal(result.version, pkg.version)
  assert.equal((await rpc('pluginManager/setBundleEnabled', { name: pkg.name, enabled: true })).application, 'applied')
}

async function settings() {
  const { namespaces } = await rpc('settings/describe')
  return namespaces.find(({ ns }) => ns === namespace)
}

function hostMarker(entry) {
  const { refs, uid } = entry.schema
  return refs[refs[uid].dict.enabled].meta.dshSessionBridgeHost
}

async function save(patch) {
  const entry = await settings()
  const saved = await rpc('settings/update', { ns: namespace, expectedRevision: entry.revision, patch })
  assert.equal(hostMarker(saved), hostMarker(entry))
  for (const [key, value] of Object.entries(patch)) assert.deepEqual(saved.value[key], value)
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

async function sessions(work) {
  const { workspace } = await rpc('workspace/create', { request: { path: work } })
  for (const sessionId of [from, to]) {
    assert.equal((await rpc('session/create', { request: { sessionId, workspaceId: workspace.workspaceId } })).sessionId, sessionId)
    await prompt(sessionId, 'Initialize ' + sessionId)
  }
}

const supportedText = 'Host version supported (DSH 0.2.2-rc.1).'
const unsupportedText = 'This host is unsupported. New messages and delegation require DSH 0.2.2-rc.1.'
const failedText = 'Unable to read plugin settings or host compatibility. Try again.'

async function browserCheck(supported) {
  const { chromium } = await import(pathToFileURL(playwrightEntry))
  const browser = await chromium.launch({ executablePath: chrome, env: browserEnv, args: ['--disable-background-networking'] })
  try {
    const page = await browser.newPage({ locale: 'en-US' })
    page.setDefaultTimeout(8000)
    let fault
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== launch.origin) return route.abort()
      if (url.pathname !== '/api/settings/describe' || !fault) return route.continue()
      if (fault === 'transport') return route.abort('failed')
      const response = await route.fetch()
      const body = await response.json()
      const entry = body.result.value.namespaces.find(({ ns }) => ns === namespace)
      const { uid, refs } = entry.schema
      delete refs[refs[uid].dict.enabled].meta.dshSessionBridgeHost
      return route.fulfill({ response, json: body })
    })
    await page.goto(launch.href)
    const notice = page.getByRole('button', { name: 'Continue', exact: true })
    if (await notice.waitFor({ timeout: 3000 }).then(() => true, () => false)) await notice.click()
    const newSession = page.getByRole('button', { name: 'New session in work', exact: true })
    if (!await newSession.isVisible()) await page.getByText('work', { exact: true }).click()
    await newSession.click()
    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
    await page.getByRole('button', { name: /dsh-session-bridge/ }).click()
    const ordinary = page.getByRole('checkbox', { name: 'Enable session messaging' })
    const workflow = page.getByRole('checkbox', { name: 'Enable cross-session delegation' })
    const reload = page.getByRole('button', { name: 'Reload', exact: true })
    const text = (value) => page.getByText(value, { exact: true })
    if (!supported) {
      await text(unsupportedText).waitFor()
      assert.equal(await ordinary.count(), 0)
      assert.equal(await text(failedText).count(), 0)
      return
    }
    await text(supportedText).waitFor()
    await text('Session messaging is off.').waitFor()
    await text('Task delegation is off.').waitFor()
    await ordinary.check()
    await text('Session messaging is off.').waitFor()
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    await text('Session messaging is on.').waitFor()
    assert.equal((await settings()).value.enabled, true)
    assert.equal(await workflow.isChecked(), false)
    for (const mode of ['transport', 'missing-marker']) {
      fault = mode
      await reload.click()
      await text(failedText).waitFor()
      assert.equal(await text(unsupportedText).count(), 0)
      assert.equal(await ordinary.count(), 0)
      fault = undefined
      await reload.click()
      await text(supportedText).waitFor()
      await text('Session messaging is on.').waitFor()
    }
  } finally {
    await browser.close()
  }
}

const send = (input) => tool('send_session_message', input)
const once = (call) => (results) => results.length === 0 ? call : undefined
const authorize = (input) => '授权互传 ' + input.to + ' ' + input.request_id + '\n' + input.text
const task = 'synthetic-diagnostics'
const grant = '授权委托\n' + JSON.stringify({
  task, ttlMinutes: 5, goal: 'Synthetic diagnostics', scopes: [{ name: 'review', targets: [to] }],
})
const dispatch = tool('workflow_dispatch', {
  task, item: 'one', attempt: 1, target: to, scope: 'review',
  instructions: 'Synthetic diagnostic smoke', acceptance: 'Return a synthetic report.',
})
const known = { to, request_id: 'known-request', text: 'Synthetic fixed-host message.' }
const old = { to, request_id: 'existing-request', text: 'Synthetic historical message.' }
const hash = (input) => createHash('sha256').update(JSON.stringify(input)).digest('hex')

try {
  await new Promise((done) => model.listen(0, '127.0.0.1', done))
  const work = join(lab, 'work')
  await mkdir(work)
  await start(cli, join(lab, 'known'), work)

  // Use the real installer with a probe manifest incompatible with this runtime.
  const incompatibleDir = join(lab, 'incompatible')
  await mkdir(incompatibleDir)
  execFileSync('tar', ['-xzf', archive, '-C', incompatibleDir])
  const incompatiblePkg = { ...pkg, engines: { ...pkg.engines, dsh: unknownVersion } }
  await writeFile(join(incompatibleDir, 'package/package.json'), JSON.stringify(incompatiblePkg))
  const rejected = await install(join(incompatibleDir, 'package'))
  assert.equal(rejected.application, 'failed')
  assert.equal(rejected.error.code, 'incompatible-version')
  assert.deepEqual(rejected.error.incompatible, [{
    name: pkg.name, version: pkg.version, runtimeVersion: '0.2.2-rc.1', requirements: { 'engines.dsh': unknownVersion },
  }])
  assert.equal(await settings(), undefined)
  assert(!(await rpc('pluginManager/listBundles')).some(({ name }) => name === pkg.name))
  const appBoot = createRequire(cli).resolve('@deepseek-ai/dsh-app-boot')
  const { evaluatePluginCompatibility } = await import(pathToFileURL(appBoot))
  const mismatch = evaluatePluginCompatibility(pkg, {}, unknownVersion)
  assert.equal(mismatch.exempted, false)
  assert.deepEqual(mismatch.requirements, { 'engines.dsh': '0.2.2-rc.1' })
  console.log('PASS native incompatible-version refusal before sidebar and exact shipped engines on an unknown-version probe')

  await enable()
  await sessions(work)
  assert.equal(hostMarker(await settings()), 'supported')
  assert.deepEqual((await settings()).value, { enabled: false, workflowEnabled: false, allowedSessions: [] })
  await browserCheck(true)
  console.log('PASS fixed-host browser distinguishes supported, both switches off, transport error and missing compatibility metadata')
  await save({ allowedSessions: [from, to], workflowEnabled: true })
  assert.deepEqual(await prompt(from, 'Out-of-allowlist attempt', once(send({ ...known, to: 'synth-outside' }))),
    { error: 'route_not_allowed' })
  assert.deepEqual(await prompt(from, 'Ordinary unapproved request', once(send(known))), { error: 'message_authorization_required' })
  const sent = await prompt(from, authorize(known), once(send(known)))
  assert.equal(sent.delivery, 'delivered')
  await until(async () => (await history(to)).some(({ type, data }) => type === 'user/message' && data.id === sent.messageId), 'fixed-host delivery')
  const duplicate = await prompt(from, 'Retry the same exact request', once(send(known)))
  assert.equal(duplicate.messageId, sent.messageId)
  assert.equal(duplicate.duplicate, true)
  assert.equal((await history(to)).filter(({ type, data }) => type === 'user/message' && data.id === sent.messageId).length, 1)
  const status = await until(async () => {
    const receipt = await prompt(from, 'Read the fixed-host receipt',
      once(tool('session_message_status', { request_id: known.request_id })))
    return receipt?.processing === 'processed' ? receipt : undefined
  }, 'fixed-host processing receipt')
  assert.equal(status.messageId, sent.messageId)
  const assigned = await prompt(from, grant, once(dispatch))
  assert.equal(assigned.duplicate, false)
  await until(async () => (await history(from)).some(({ type, data }) =>
    type === 'tool/result' && data.message.content[0]?.text.includes('Synthetic diagnostic report')), 'one delegation returns to the original main')
  console.log('PASS fixed-host allowlist, owner authorization, delivery, deduplication, receipt query and one native delegation')

  await stop()
  // The released Web implementation remains fixed. Only the launcher identity
  // seen by the runtime guard changes in this probe. The manager's own package
  // version is still fixed, so the sidebar can be exercised after admission.
  const probe = join(lab, 'unknown-launcher')
  await mkdir(join(probe, 'lib'), { recursive: true })
  await symlink(join(installDir, 'node_modules'), join(probe, 'node_modules'), 'dir')
  await writeFile(join(probe, 'package.json'), JSON.stringify({ name: installedHost.name, version: unknownVersion }))
  const entry = join(probe, 'lib/launcher.mjs')
  await writeFile(entry, 'const { runCli } = await import(' + JSON.stringify(pathToFileURL(cli).href) + ')\nawait runCli()\n')
  const home = await start(entry, join(lab, 'unknown'), work)
  await enable()
  await sessions(work)
  await save({ enabled: true, workflowEnabled: true, allowedSessions: [from, to] })
  assert.equal(hostMarker(await settings()), 'unsupported')
  await browserCheck(false)
  const receiptFile = join(home, 'dsh-session-bridge', 'receipts', hash([from, old.request_id]) + '.json')
  const legacy = { requestId: old.request_id, messageId: 'synth-existing-message', from, to,
    payloadHash: hash([to, old.text]), delivery: 'delivered', at: '2026-01-01T00:00:00Z' }
  await writeFile(receiptFile, JSON.stringify(legacy) + '\n')
  const denied = await prompt(from, authorize(known), once(send(known)))
  assert.deepEqual(denied, { error: 'unsupported_dsh_authorization_source' })
  await assert.rejects(readFile(join(dirname(receiptFile), hash([from, known.request_id]) + '.json')), { code: 'ENOENT' })
  assert.equal((await history(to)).filter(({ type, data }) => type === 'user/message' && data.source?.kind === 'agent-message').length, 0)
  let noWorkflow = false
  await prompt(from, grant, (_results, tools) => {
    assert(!tools.some(({ name }) => name.startsWith('workflow_')))
    noWorkflow = true
  })
  assert(noWorkflow)
  const historic = await prompt(from, 'Read a historical receipt', once(tool('session_message_status', { request_id: old.request_id })))
  assert.equal(historic.messageId, legacy.messageId)
  const replay = await prompt(from, 'Read an exact historical retry', once(send(old)))
  assert.equal(replay.messageId, legacy.messageId)
  assert.equal(replay.duplicate, true)
  assert.equal(await readFile(receiptFile, 'utf8'), JSON.stringify(legacy) + '\n')
  console.log('PASS unknown launcher shows unsupported, rejects new send and workflow, and preserves historic receipt lookup and exact retry')
} catch (error) {
  console.error(String(error.stack ?? error).replaceAll(lab, '<isolated-diagnostics>'))
  process.exitCode = 1
} finally {
  await stop()
  model.closeAllConnections()
  await new Promise((done) => model.close(done))
  await rm(lab, { recursive: true, force: true })
}
