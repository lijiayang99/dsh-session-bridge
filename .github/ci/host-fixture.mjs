import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const main = 'synth-main'
export const worker = 'synth-worker'
export const outsider = 'synth-outsider'
export const child = 'synth-native-child'
export const name = 'workflow_message'
export const owner = { kind: 'user', rpcId: 'synth-rpc' }

export function assertIsolated() {
  assert.deepEqual(Object.keys(networkInterfaces()), ['lo'], 'Run via the isolated CI launcher')
  assert(networkInterfaces().lo.every(({ internal }) => internal))
}

export async function fixture(t, {
  hostVersion = '0.2.2-rc.1', enabled = true, selected = [main, worker], legacySettings = {},
} = {}) {
  assertIsolated()
  const root = await mkdtemp(join(tmpdir(), 'bridge-fixture-'))
  const schemaDir = join(root, 'node_modules', '@deepseek-ai', 'schemastery')
  const cli = join(root, 'bin', 'dsh.js')
  const profile = join(root, 'profile')
  const receipts = join(root, 'dsh-session-bridge', 'receipts')
  const cleanup = []
  t.after(async () => {
    try {
      await stop()
    } finally {
      delete process.env.DSH_HOME
      await rm(root, { recursive: true, force: true })
    }
  })
  await mkdir(schemaDir, { recursive: true })
  await mkdir(join(root, 'bin'))
  await writeFile(cli, '')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: hostVersion }))
  await writeFile(join(schemaDir, 'package.json'), '{"main":"index.cjs"}')
  await writeFile(join(schemaDir, 'index.cjs'), `
    const chain = { default: () => chain, volatile: () => chain, pattern: () => chain, max: () => chain, extra: () => chain }
    module.exports = { object: () => chain, boolean: () => chain, string: () => chain, array: () => chain }
  `)

  const agents = new Map()
  const tools = new Map()
  const listeners = new Map()
  const warnings = []
  const pending = new Map()
  const rows = new Map()
  const deliveries = []
  const faults = {}
  const archived = new Set()
  const turnStarts = new Map()
  const emit = (agent, type, data) => {
    const event = { type, data, seq: ++agent.session.seq, time: Date.now() }
    for (const listen of listeners.get('session/event') ?? []) listen(agent.session, event)
    return event
  }
  for (const id of [main, worker, outsider, child]) {
    const queue = []
    pending.set(id, queue)
    rows.set(id, { sessionId: id, projections: { values: { title: id } } })
    const agent = {
      session: { id, seq: 0 },
      followup(message) {
        deliveries.push({ target: id, message })
        queue.push(message)
        emit(agent, 'agent/inbox/spliced', { inserted: [message] })
        faults.afterFollowup?.(id, message)
      },
    }
    agents.set(id, agent)
  }
  Object.assign(rows.get(child), { parentSessionId: main, origin: 'subagent' })
  agents.turnBoundaryOf = ({ id }) => ({ openTurnStartSeq: turnStarts.get(id) })

  const ctx = {
    profileContext: { name: 'web', dir: profile },
    workspaceRegistry: { get archivedSessionIds() { return [...archived] } },
    agents,
    tools: { register: ({ name: registered, execute }) => tools.set(registered, execute) },
    sessions: { flush: async session => faults.flush ? faults.flush(session.id) : true },
    sessionController: {
      async resolveAgent(id) {
        await faults.resolve?.(id)
        return { agent: agents.get(id) }
      },
      async list() {
        await faults.list?.()
        return { items: [...rows.values()] }
      },
    },
    sessionPersistence: {
      stat: async id => faults.stat
        ? faults.stat(id)
        : { sizeBytes: 1, header: { cwd: root, ...(id === child && { origin: 'subagent', parentSession: main }) } },
    },
    inject: (_services, apply) => apply(ctx),
    on: (event, listen) => listeners.set(event, [...(listeners.get(event) ?? []), listen]),
    effect: apply => cleanup.push(apply()),
    logger: { warn: message => warnings.push(message) },
  }
  const entry = new URL('../../index.js', import.meta.url)
  entry.searchParams.set('fixture', root)

  async function start() {
    process.env.DSH_HOME = root
    const argvEntry = process.argv[1]
    try {
      process.argv[1] = cli
      const { apply } = await import(entry.href)
      apply(ctx, {
        messagingEnabled: { get: () => enabled },
        messagingSessions: { get: () => selected },
        ...Object.fromEntries(Object.entries(legacySettings).map(([key, value]) => [key, { get: () => value }])),
      })
    } finally {
      process.argv[1] = argvEntry
    }
  }

  async function stop() {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
    tools.clear()
    listeners.clear()
  }

  await start()

  function begin(id, message) {
    const agent = agents.get(id)
    const turn = agent.session.seq + 1
    assert(!turnStarts.has(id))
    turnStarts.set(id, emit(agent, 'turn/start', { turn }).seq)
    emit(agent, 'user/message', message)
  }

  return {
    tools, deliveries, warnings, faults, receipts,
    async restart() {
      await stop()
      turnStarts.clear()
      await start()
    },
    stop,
    begin(id, text) {
      begin(id, { source: owner, content: [{ type: 'text', text }] })
    },
    receive(id) {
      const message = pending.get(id).shift()
      assert(message)
      begin(id, message)
      return message
    },
    end(id, reason = 'completed', replied = true) {
      const agent = agents.get(id)
      const turn = turnStarts.get(id)
      assert(turn)
      if (replied) emit(agent, 'assistant/message', { turn, interrupted: false })
      emit(agent, 'turn/end', { turn, reason: { kind: reason } })
      turnStarts.delete(id)
    },
    archive(id) { archived.add(id) },
    setEnabled(value) { enabled = value },
    setSelected(value) { selected = value },
    rename(id, title) { rows.get(id).projections.values.title = title },
    removeAgent(id) { agents.delete(id) },
    call(id, args = {}, exec = {}) {
      const execute = tools.get(name)
      assert(execute, 'Missing tool ' + name)
      return execute(args, { agent: agents.get(id), signal: new AbortController().signal, ...exec })
    },
  }
}

export async function until(check, message) {
  const deadline = performance.now() + 5_000
  do {
    const result = await check()
    if (result) return result
    await delay(10)
  } while (performance.now() < deadline)
  assert.fail(message)
}
