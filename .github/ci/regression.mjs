import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

const main = 'synth-main'
const worker = 'synth-worker'
const reviewer = 'synth-reviewer'
const outsider = 'synth-outsider'
const ownerSource = { kind: 'user', rpcId: 'synth-rpc' }
const guestSource = { ...ownerSource, principal: { kind: 'guest' } }
const relaySource = { kind: 'agent-message', form: 'relay', senderSessionId: worker }

async function fixture(t, hostVersion) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-fixture-'))
  const schemaDir = join(root, 'node_modules', '@deepseek-ai', 'schemastery')
  const cli = join(root, 'bin', 'dsh.js')
  const profile = join(root, 'profile')
  const cleanup = []
  t.after(async () => {
    try {
      for (const dispose of cleanup.reverse()) await dispose()
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
    const chain = { default: () => chain, volatile: () => chain, pattern: () => chain, max: () => chain }
    module.exports = { object: () => chain, boolean: () => chain, string: () => chain, array: () => chain }
  `)

  const agents = new Map()
  const tools = new Map()
  const listeners = []
  const warnings = []
  const pending = new Map()
  const deliveries = []
  const records = new Map()
  const turns = new Map()
  const emit = (agent, type, data) => {
    const event = { type, data, seq: ++agent.session.seq }
    records.get(agent.session.id).push(event)
    for (const listen of listeners) listen(agent.session, event)
  }
  for (const id of [main, worker, reviewer, outsider]) {
    const queue = []
    pending.set(id, queue)
    records.set(id, [])
    const agent = {
      session: { id, seq: 0 },
      status: 'idle',
      inbox: { nextTurn: queue, nextStep: [], get hasPending() { return queue.length > 0 } },
      followup(message) {
        const start = queue.length
        queue.push(message)
        deliveries.push({ target: id, message })
        emit(agent, 'agent/inbox/spliced', { target: 'next-turn', start, inserted: [message] })
      },
      wakeDriver() {},
    }
    agents.set(id, agent)
  }
  const ctx = {
    profileContext: { name: 'web', dir: profile },
    workspaceRegistry: { archivedSessionIds: [] },
    agents,
    tools: { register: ({ name, execute }) => tools.set(name, execute) },
    sessions: { flush: async () => true },
    sessionController: { resolveAgent: async id => ({ agent: agents.get(id) }) },
    sessionPersistence: {
      stat: async id => agents.has(id) ? { sizeBytes: 1, header: { cwd: root } } : undefined,
      open: async id => ({
        read: async (from, limit) => ({ events: records.get(id).filter(event => event.seq > from).slice(0, limit) }),
        close: async () => {},
      }),
    },
    inject: (_services, apply) => apply(ctx),
    on: (_event, listen) => listeners.push(listen),
    effect: apply => cleanup.push(apply()),
    get: () => undefined,
    logger: { warn: message => warnings.push(message) },
  }
  process.env.DSH_HOME = root
  const entry = new URL('../../index.js', import.meta.url)
  entry.searchParams.set('fixture', hostVersion)
  const argvEntry = process.argv[1]
  try {
    process.argv[1] = cli
    const { apply } = await import(entry.href)
    apply(ctx, {
      enabled: { get: () => true },
      workflowEnabled: { get: () => true },
      allowedSessions: { get: () => [main, worker, reviewer] },
    })
  } finally {
    process.argv[1] = argvEntry
  }

  function begin(id, message) {
    const agent = agents.get(id)
    assert.equal(agent.status, 'idle')
    const turn = (turns.get(id) ?? 0) + 1
    turns.set(id, turn)
    agent.status = 'running'
    emit(agent, 'turn/start', { turn })
    emit(agent, 'user/message', message)
  }
  return {
    tools, deliveries, warnings,
    begin(id, text, source = ownerSource) {
      begin(id, { id: randomUUID(), role: 'user', source, content: [{ type: 'text', text }] })
    },
    end(id) {
      const agent = agents.get(id)
      agent.status = 'idle'
      emit(agent, 'turn/end', { turn: turns.get(id), reason: { kind: 'completed' } })
    },
    async receive(id) {
      const queue = pending.get(id)
      for (let wait = 0; wait < 200 && !queue.length; wait++) await delay(10)
      assert(queue.length, 'Expected a queued synthetic notification for ' + id)
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

const ordinary = { to: worker, request_id: 'synth-request', text: 'Exact synthetic text.' }
const relayCommand = ({ to, request_id, text }) => '授权互传 ' + to + ' ' + request_id + '\n' + text
const task = 'synth-workflow'
const grant = '授权委托\n' + JSON.stringify({
  task, ttlMinutes: 2, goal: 'Synthetic workflow',
  scopes: [{ name: 'develop', targets: [worker] }, { name: 'review', targets: [reviewer] }],
})
const dispatch = {
  task, item: 'initial', attempt: 1, target: worker, scope: 'develop',
  instructions: 'Prepare a synthetic result.', acceptance: 'Return synthetic evidence.',
}

test('supported owner contract and delegation round trip', async t => {
  assert.deepEqual(Object.keys(networkInterfaces()), ['lo'], 'Run via the isolated CI launcher')
  assert(networkInterfaces().lo.every(({ internal }) => internal))
  const host = await fixture(t, '0.2.2-rc.1')
  const send = input => host.call(main, 'send_session_message', input)
  for (const source of [guestSource, relaySource, { kind: 'user' }]) {
    host.begin(main, relayCommand(ordinary), source)
    assert.equal((await send(ordinary)).error, 'message_authorization_required')
    host.end(main)
  }
  host.begin(main, relayCommand({ ...ordinary, to: outsider }))
  assert.equal((await send({ ...ordinary, to: outsider })).error, 'route_not_allowed')
  host.end(main)
  host.begin(main, relayCommand(ordinary))
  for (const change of [{ to: reviewer }, { request_id: 'different' }, { text: 'Different.' }]) {
    assert.equal((await send({ ...ordinary, ...change })).error, 'message_authorization_required')
  }
  assert.equal(host.deliveries.length, 0)
  const first = await send(ordinary)
  assert.equal(first.delivery, 'delivered')
  assert.equal(first.duplicate, false)
  const delivered = host.deliveries[0]
  assert.equal(delivered.target, worker)
  assert.equal(delivered.message.id, first.messageId)
  assert.equal(delivered.message.source.senderSessionId, main)
  assert(delivered.message.content[0].text.endsWith('\n' + ordinary.text))
  host.end(main)
  host.begin(main, 'Synthetic retry without a fresh authorization')
  const duplicate = await send(ordinary)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.messageId, first.messageId)
  assert.equal((await send({ ...ordinary, text: 'Different.' })).error, 'request_id_conflict')
  assert.equal(host.deliveries.length, 1)
  assert.equal((await send({ ...ordinary, request_id: 'different' })).error, 'message_authorization_required')
  host.end(main)
  await host.receive(worker)
  host.end(worker)

  for (const source of [guestSource, relaySource]) {
    host.begin(main, grant, source)
    assert.equal((await host.call(main, 'workflow_dispatch', dispatch)).error, 'main_task_context_required')
    host.end(main)
  }
  host.begin(main, grant)
  const delegated = await host.call(main, 'workflow_dispatch', dispatch)
  assert.equal(delegated.duplicate, false)
  host.end(main)
  const taskWake = await host.receive(worker)
  assert.equal(taskWake.source.senderSessionId, main)
  const claim = await host.call(worker, 'workflow_claim', { id: delegated.id })
  assert.equal(claim.instructions, dispatch.instructions)
  const report = { id: delegated.id, attempt: 1, token: claim.token, status: 'completed', summary: 'Synthetic result', evidence: ['fixture'] }
  assert.equal((await host.call(worker, 'workflow_report', report)).recorded, true)
  host.end(worker)

  const resultWake = await host.receive(main)
  assert.equal(resultWake.source.senderSessionId, worker)
  const result = await host.call(main, 'workflow_consume', { id: delegated.id })
  assert.equal(result.report.summary, report.summary)
  assert.equal(result.report.reporter, worker)
  assert.equal((await host.call(main, 'workflow_consume', { id: delegated.id })).duplicate, true)
  const next = { ...dispatch, item: 'review', target: reviewer, scope: 'review' }
  const continuation = await host.call(main, 'workflow_dispatch', next)
  assert.equal(continuation.duplicate, false)
  assert.deepEqual(await host.call(main, 'workflow_dispatch', next), { id: continuation.id, duplicate: true })
  host.end(main)
  const nextWake = await host.receive(reviewer)
  assert.equal(nextWake.source.bridgeWorkflowId, continuation.id)
  assert.equal(host.deliveries.filter(({ target }) => target === reviewer).length, 1)
  host.end(reviewer)
  assert.deepEqual(host.warnings, [])
})

test('an unknown host cannot start a relay or delegate', async t => {
  const host = await fixture(t, '0.0.0-synthetic-unknown')
  if (host.tools.has('send_session_message')) {
    host.begin(main, relayCommand(ordinary))
    const denied = await host.call(main, 'send_session_message', ordinary)
    assert.equal(typeof denied.error, 'string')
    assert.equal(denied.messageId, undefined)
    if (host.tools.has('session_message_status')) {
      const receipt = await host.call(main, 'session_message_status', { request_id: ordinary.request_id })
      assert.equal(typeof receipt.error, 'string')
      assert.equal(receipt.messageId, undefined)
    }
    host.end(main)
  }
  if (host.tools.has('workflow_dispatch')) {
    host.begin(main, grant)
    const deniedDispatch = await host.call(main, 'workflow_dispatch', dispatch)
    assert.equal(typeof deniedDispatch.error, 'string')
    assert.equal(deniedDispatch.id, undefined)
    host.end(main)
  }
  assert.equal(host.deliveries.length, 0)
})
