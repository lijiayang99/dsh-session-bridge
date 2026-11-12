import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

export const main = 'synth-main'
export const secondMain = 'synth-other-main'
export const worker = 'synth-worker'
export const reviewer = 'synth-reviewer'
export const outsider = 'synth-outsider'
export const ownerSource = { kind: 'user', rpcId: 'synth-rpc' }
export const guestSource = { ...ownerSource, principal: { kind: 'guest' } }
export const relaySource = { kind: 'agent-message', form: 'relay', senderSessionId: worker }

export function assertIsolated() {
  assert.deepEqual(Object.keys(networkInterfaces()), ['lo'], 'Run via the isolated CI launcher')
  assert(networkInterfaces().lo.every(({ internal }) => internal))
}

export async function fixture(t, {
  hostVersion = '0.2.2-rc.1', additionalSessions = [], workspaces = [], legacySettings = {},
} = {}) {
  assertIsolated()
  const root = await mkdtemp(join(tmpdir(), 'bridge-fixture-'))
  const schemaDir = join(root, 'node_modules', '@deepseek-ai', 'schemastery')
  const cli = join(root, 'bin', 'dsh.js')
  const profile = join(root, 'profile')
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
  // The product uses the host schema only for configuration declaration.
  await writeFile(join(schemaDir, 'package.json'), '{"main":"index.cjs"}')
  await writeFile(join(schemaDir, 'index.cjs'), `
    const chain = { default: () => chain, volatile: () => chain, pattern: () => chain, max: () => chain, extra: () => chain }
    module.exports = { object: () => chain, boolean: () => chain, string: () => chain, array: () => chain }
  `)

  const agents = new Map()
  const tools = new Map()
  const listeners = []
  const warnings = []
  const pending = new Map()
  const titles = new Map()
  const deliveries = []
  const wakes = []
  const faults = {}
  const records = new Map()
  const turns = new Map()
  const archived = new Set()
  let enabled = true
  const emit = (agent, type, data) => {
    const event = { type, data, seq: ++agent.session.seq, time: Date.now() }
    records.get(agent.session.id).push(event)
    for (const listen of listeners) listen(agent.session, event)
  }
  for (const id of [main, secondMain, worker, reviewer, ...additionalSessions, outsider]) {
    const queue = []
    pending.set(id, queue)
    records.set(id, [])
    titles.set(id, id)
    const agent = {
      session: { id, seq: 0 },
      status: 'idle',
      inbox: { nextTurn: queue, nextStep: [], get hasPending() { return queue.length > 0 } },
      followup(message) {
        deliveries.push({ target: id, message })
        enqueue(id, message)
        faults.afterFollowup?.(id, message)
      },
      wakeDriver() { wakes.push(id) },
    }
    agents.set(id, agent)
  }
  function enqueue(id, message) {
    const queue = pending.get(id)
    const start = queue.length
    queue.push(message)
    emit(agents.get(id), 'agent/inbox/spliced', { target: 'next-turn', start, inserted: [message] })
  }

  const ctx = {
    profileContext: { name: 'web', dir: profile },
    workspaceRegistry: { get archivedSessionIds() { return [...archived] }, list: () => workspaces },
    agents,
    tools: { register: ({ name, execute }) => tools.set(name, execute) },
    sessions: { flush: async session => faults.flush ? faults.flush(session.id) : true },
    sessionController: {
      async resolveAgent(id) {
        await faults.resolve?.(id)
        return { agent: agents.get(id) }
      },
      async list() {
        await faults.list?.()
        return { items: [...titles].map(([sessionId, title]) => ({
          sessionId, projections: { values: { title } },
        })) }
      },
    },
    sessionPersistence: {
      stat: async id => agents.has(id) ? { sizeBytes: 1, header: { cwd: root } } : undefined,
      open: async id => ({
        read: async (from, limit) => {
          await faults.read?.(id)
          return { events: records.get(id).filter(event => event.seq >= from).slice(0, limit) }
        },
        close: async () => {},
      }),
    },
    inject: (_services, apply) => apply(ctx),
    on: (_event, listen) => listeners.push(listen),
    effect: apply => cleanup.push(apply()),
    get: () => undefined,
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
        enabled: { get: () => enabled },
        ...Object.fromEntries(Object.entries(legacySettings).map(([key, value]) => [key, { get: () => value }])),
      })
    } finally {
      process.argv[1] = argvEntry
    }
  }

  async function stop() {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
    tools.clear()
    listeners.length = 0
  }

  await start()

  function begin(id, message) {
    const agent = agents.get(id)
    assert.equal(agent.status, 'idle')
    const turn = (turns.get(id) ?? 0) + 1
    turns.set(id, turn)
    agent.status = 'running'
    emit(agent, 'turn/start', { turn })
    emit(agent, 'user/message', message)
  }
  function ownerMessage(text, source) {
    return { id: randomUUID(), role: 'user', source, content: [{ type: 'text', text }] }
  }

  return {
    tools, deliveries, warnings, wakes, faults,
    async restart(whileStopped) {
      // Keep synthetic durable events and inbox entries while discarding live turns.
      await stop()
      await whileStopped?.()
      for (const agent of agents.values()) agent.status = 'idle'
      await start()
    },
    begin(id, text, source = ownerSource) {
      const message = ownerMessage(text, source)
      begin(id, message)
      return message.id
    },
    async directAssignment(owner, messageId) {
      const task = 'direct-' + createHash('sha256').update(JSON.stringify([owner, messageId])).digest('hex')
      const key = owner + ':' + task
      const ledger = new DatabaseSync(join(profile, 'dsh-session-bridge-workflow', 'workflow-v1.sqlite'), { readOnly: true })
      try {
        const select = ledger.prepare('SELECT body FROM ledger WHERE id=1')
        return await until(() => {
          const { grants, jobs } = JSON.parse(select.get().body)
          const grant = grants[key]
          const job = Object.values(jobs).find((item) => item.key === key)
          return grant && job && { task, grant, job }
        }, 'Expected one durable assignment from the native owner turn')
      } finally {
        ledger.close()
      }
    },
    archive(id, value = true) {
      assert(agents.has(id))
      if (value) archived.add(id)
      else archived.delete(id)
    },
    setEnabled(value) {
      enabled = value
    },
    rename(id, title) {
      assert(titles.has(id))
      titles.set(id, title)
    },
    enqueueInput(id, text, source = ownerSource) {
      enqueue(id, ownerMessage(text, source))
    },
    reply(id, text, interrupted = false) {
      const agent = agents.get(id)
      assert.equal(agent.status, 'running')
      emit(agent, 'assistant/message', {
        turn: turns.get(id), interrupted,
        message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }] },
      })
    },
    appendInput(id, text, source = ownerSource) {
      const agent = agents.get(id)
      assert.equal(agent.status, 'running')
      emit(agent, 'user/message', ownerMessage(text, source))
    },
    end(id, reason = 'completed') {
      const agent = agents.get(id)
      agent.status = 'idle'
      emit(agent, 'turn/end', { turn: turns.get(id), reason: { kind: reason } })
    },
    async receive(id) {
      const queue = pending.get(id)
      await until(() => queue.length, 'Expected a queued synthetic notification for ' + id)
      const message = queue.shift()
      emit(agents.get(id), 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
      begin(id, message)
      return message
    },
    call(id, name, args) {
      const execute = tools.get(name)
      assert(execute, 'Missing tool ' + name)
      return execute(args, { agent: agents.get(id), signal: new AbortController().signal })
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
