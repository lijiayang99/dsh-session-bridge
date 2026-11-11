import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const packageName = '@local/dsh-session-bridge'
const namespace = 'dsh-session-bridge-settings'

export const tool = (name, input = {}) => ({ name, input })
export const parts = (content) => typeof content === 'string' ? [{ type: 'text', text: content }] : content
export const unpack = (content) => {
  const text = parts(content).filter((part) => part.type === 'text').map((part) => part.text).join('')
  try { return JSON.parse(text) } catch { return text }
}

export function latestPrompt(messages, matches) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const content = parts(message.content)
    const index = content.findLastIndex(({ type, text }) => type === 'text' && matches(text))
    if (index >= 0) {
      const following = [...content.slice(index + 1), ...messages.slice(i + 1).flatMap((entry) => parts(entry.content))]
      return {
        text: content[index].text,
        results: following.filter(({ type }) => type === 'tool_result').map(({ content }) => unpack(content)),
      }
    }
    if (content.some(({ type, text }) => type === 'text' && !text.startsWith('Current runtime context') &&
      !text.startsWith('Time sampled while preparing turn ') && !text.startsWith('<'))) return
  }
}

export async function withCollaborationHost({
  dsh, archive, bootstrap = archive, decide, modelDeadlineMs = 15_000, allowNetwork = false, timeRefreshIntervalMs,
}, run) {
  if (!allowNetwork) {
    assert(Object.values(networkInterfaces()).flat().every(({ internal }) => internal),
      'Synthetic collaboration smoke requires a loopback-only network namespace')
  }
  const cli = await realpath(resolve(dsh))
  const pkg = JSON.parse(execFileSync('tar', ['-xOf', resolve(archive), 'package/package.json'], { encoding: 'utf8' }))
  const runtime = JSON.parse(await readFile(join(dirname(cli), '..', 'package.json'), 'utf8'))
  assert.equal(runtime.name, '@deepseek-ai/dsh')
  assert.equal(runtime.version, '0.2.2-rc.1')
  assert.equal(pkg.name, packageName)
  assert.match(pkg.version, /^0\.5\.0-rc\.[1-9]\d*$/)
  assert.deepEqual(pkg.engines, { dsh: '0.2.2-rc.1', node: '>=24.9.0' })
  const initial = bootstrap === archive ? pkg : JSON.parse(execFileSync('tar',
    ['-xOf', resolve(bootstrap), 'package/package.json'], { encoding: 'utf8' }))
  assert.equal(initial.name, packageName)
  assert.deepEqual(initial.engines, pkg.engines)
  const lab = await mkdtemp(join(tmpdir(), 'bridge-collaboration-'))
  const dshHome = join(lab, 'dsh')
  const work = join(lab, 'synthetic-workspace')
  const ledgerFile = join(dshHome, 'profiles/web/dsh-session-bridge-workflow/workflow-v1.sqlite')
  let host
  let origin
  let cookie
  let launchUrl
  let browserEnvironment
  let modelError
  let requests = 0
  const activeRequests = new Set()

  const model = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/messages')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks))
      const number = ++requests
      const controller = new AbortController()
      activeRequests.add(controller)
      response.on('close', () => controller.abort())
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10 } } }) + '\n\n')
      let decision
      try {
        decision = await decide(body, {
          number, lab, work, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(modelDeadlineMs)]),
        })
      } finally {
        activeRequests.delete(controller)
      }
      const call = decision?.name ? decision : undefined
      if (call) assert(body.tools.some(({ name }) => name === call.name), 'Native tool unavailable: ' + call.name)
      const block = call
        ? { type: 'tool_use', id: 'toolu_' + randomUUID().replaceAll('-', ''), ...call }
        : { type: 'text', text: decision?.reply ?? '合成会话已处理。' }
      const events = [
        { type: 'content_block_start', index: 0, content_block: block },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ]
      response.end(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''))
    } catch (error) {
      if (!response.destroyed) {
        modelError = error
        if (!response.headersSent) response.writeHead(500)
        response.end()
      }
    }
  })

  async function until(read, description, limit = 25_000) {
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
      if (modelError) throw modelError
      if (host && (host.exitCode !== null || host.signalCode !== null)) throw new Error('Isolated DSH stopped: ' + description)
      let result
      try {
        result = await read()
      } catch (error) {
        // After a crash, a read-only probe can race recovery of the SQLite journal.
        if (error.code !== 'ERR_SQLITE_ERROR' || ![5, 6].includes(error.errcode)) throw error
      }
      if (result) return result
      await delay(100)
    }
    throw new Error('Timed out: ' + description)
  }

  async function start() {
    const env = {
      PATH: [dirname(process.execPath), dirname(resolve(dsh)), '/usr/bin', '/bin'].join(':'),
      HOME: join(lab, 'home'), DSH_HOME: dshHome, TMPDIR: join(lab, 'tmp'),
      XDG_CONFIG_HOME: join(lab, 'config'), XDG_DATA_HOME: join(lab, 'data'),
      XDG_CACHE_HOME: join(lab, 'cache'), XDG_STATE_HOME: join(lab, 'state'),
      XDG_RUNTIME_DIR: join(lab, 'run'), DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'synthetic-loopback-only',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + model.address().port,
    }
    for (const [key, path] of Object.entries(env)) {
      if (key.endsWith('HOME') || key === 'XDG_RUNTIME_DIR' || key === 'TMPDIR') {
        await mkdir(path, { recursive: true, mode: 0o700 })
      }
    }
    await mkdir(work, { recursive: true, mode: 0o700 })
    const patch = ['- id: session-title-llm', '  disabled: true']
    if (timeRefreshIntervalMs !== undefined) patch.push(
      '- insert:',
      '    - id: preset-synthetic-frequent-time',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: synthetic-frequent-time',
      '        order: 99',
      '        plugins:',
      '          - id: time-context',
      "            name: '@deepseek-ai/dsh-time-context'",
      '            config:',
      '              refreshIntervalMs: ' + timeRefreshIntervalMs,
    )
    await writeFile(join(dshHome, 'cordis.patch.yml'), patch.join('\n') + '\n')
    host = spawn(process.execPath, [cli, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
      { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunk) => { output += chunk }
    for (const stream of [host.stdout, host.stderr]) stream.on('data', collect)
    const launch = new URL(await until(() => output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)?.[0], 'host launch'))
    for (const stream of [host.stdout, host.stderr]) {
      stream.off('data', collect)
      stream.resume()
    }
    origin = launch.origin
    launchUrl = launch.href
    browserEnvironment = env
    const exchange = await fetch(launch, { redirect: 'manual' })
    assert.equal(exchange.status, 303)
    cookie = exchange.headers.getSetCookie()[0].split(';')[0]
  }

  async function stop(signal = 'SIGTERM') {
    if (!host || host.exitCode !== null || host.signalCode !== null) return
    const closed = new Promise((done) => host.once('close', done))
    const timer = setTimeout(() => host.kill('SIGKILL'), 5000)
    host.kill(signal)
    await closed
    clearTimeout(timer)
  }

  async function rpc(method, args = {}) {
    const response = await fetch(new URL('/api/' + method, origin), {
      method: 'POST', headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
      signal: AbortSignal.timeout(30_000),
    })
    const { result } = await response.json()
    assert(result?.ok, method + ' rejected: ' + (result?.error?.code ?? response.status))
    return result.value
  }

  async function post(path, body) {
    assert(path.startsWith('/api/'))
    const response = await fetch(new URL(path, origin), {
      method: 'POST', headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    })
    return { status: response.status, body: await response.json() }
  }

  async function install(spec, name) {
    const inspection = await rpc('pluginManager/inspect', { spec, options: {} })
    assert.equal(inspection.status, 'accepted')
    const installed = await rpc('pluginManager/installBundle', {
      spec, options: { enabled: false, requestId: randomUUID(), registry: inspection.registry },
    })
    assert.equal(installed.application, 'applied', JSON.stringify(installed.error))
    const enabled = await rpc('pluginManager/setBundleEnabled', { name, enabled: true })
    assert.equal(enabled.application, 'applied', JSON.stringify(enabled.error))
    return installed
  }

  async function save(patch) {
    const { namespaces } = await rpc('settings/describe')
    const entry = namespaces.find(({ ns }) => ns === namespace)
    assert(entry)
    const saved = await rpc('settings/update', { ns: namespace, expectedRevision: entry.revision, patch })
    for (const [key, value] of Object.entries(patch)) assert.deepEqual(saved.value[key], value)
  }

  async function submit(sessionId, text, mode = 'queue') {
    const requestId = randomUUID()
    const result = await rpc('session/prompt', {
      request: { requestId, sessionId, mode, content: [{ type: 'text', text }] },
    })
    assert.equal(result.accepted, true)
    return requestId
  }

  async function history(sessionId) {
    const { records } = await rpc('session/events', { request: { address: { kind: 'session', sessionId }, maxMessages: 100 } })
    return records.map(({ event }) => event).filter(Boolean)
  }

  async function idle(sessionId) {
    const result = await rpc('session/wait', { request: { sessionId, timeoutMs: 15_000 } })
    if (modelError) throw modelError
    assert.equal(result.reason, 'idle')
  }

  async function turn(sessionId, requestId, limit = 25_000) {
    return until(async () => {
      const events = await history(sessionId)
      const input = events.find(({ type, data }) => type === 'user/message' && data.source?.rpcId === requestId)
      if (!input) return
      const end = events.find(({ type, seq }) => type === 'turn/end' && seq > input.seq)
      if (!end) return
      const records = events.filter(({ seq }) => seq > input.seq && seq <= end.seq)
      return {
        input, end, records,
        results: records.filter(({ type }) => type === 'tool/result')
          .map(({ data }) => {
            assert.equal(data.message.isError, false)
            return unpack(data.message.content)
          }),
      }
    }, 'turn end for synthetic request', limit)
  }

  async function prompt(sessionId, text) {
    return turn(sessionId, await submit(sessionId, text))
  }

  async function createWorkspace() {
    const { workspace } = await rpc('workspace/create', { request: { path: work } })
    return workspace.workspaceId
  }

  const rename = (sessionId, title) => rpc('session/rename', { request: { sessionId, title } })

  async function createSessions(rows, workspaceId) {
    const workspace = workspaceId ?? await createWorkspace()
    for (const [sessionId, title] of rows) {
      const created = await rpc('session/create', { request: { sessionId, workspaceId: workspace } })
      assert.equal(created.sessionId, sessionId)
      if (timeRefreshIntervalMs !== undefined) {
        const agentPreset = 'synthetic-frequent-time'
        assert.equal(await rpc('agentPresets/select', { agentId: sessionId, agentPreset }), agentPreset)
      }
      await prompt(sessionId, '初始化合成窗口 ' + title)
      const renamed = await rename(sessionId, title)
      assert.equal(renamed.title, title)
    }
  }

  function snapshot(owner, task) {
    const db = new DatabaseSync(ledgerFile, { readOnly: true, timeout: 1000 })
    try {
      const key = owner + ':' + task
      const active = JSON.parse(db.prepare('SELECT body FROM ledger WHERE id=1').get().body)
      const archived = db.prepare('SELECT body FROM grant_history WHERE key=?').get(key)
      const grant = active.grants[key] ?? (archived && JSON.parse(archived.body))
      const jobs = [
        ...Object.values(active.jobs).filter((job) => job.key === key),
        ...db.prepare('SELECT body FROM job_history WHERE task_key=?').all(key).map(({ body }) => JSON.parse(body)),
      ].sort((a, b) => a.createdAt - b.createdAt)
      return { grant, jobs }
    } finally {
      db.close()
    }
  }

  try {
    await new Promise((done) => model.listen(0, '127.0.0.1', done))
    await start()
    assert.equal((await install(resolve(bootstrap), packageName)).version, initial.version)
    await run({ lab, work, dshHome, rpc, post, prompt, submit, turn, history, idle, createWorkspace, createSessions, rename, install,
      save, snapshot, start, stop, until, requests: () => requests,
      browserOptions: () => ({ launchUrl, env: browserEnvironment }) })
  } finally {
    for (const controller of activeRequests) controller.abort()
    await stop()
    await new Promise((done) => model.close(done))
    await rm(lab, { recursive: true, force: true })
  }
}
