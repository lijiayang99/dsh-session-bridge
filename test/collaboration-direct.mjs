import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { latestPrompt, tool, unpack, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, archive] = process.argv.slice(2)
assert(dsh && archive, 'Usage: node test/collaboration-direct.mjs <dsh> <candidate.tgz>')

const owner = 'synthetic-direct-owner'
const worker = 'synthetic-direct-worker'
const other = 'synthetic-direct-other'
const workerTitle = '合成开发窗口'
const otherTitle = '合成备用窗口'
const direct = (goal, title = workerTitle) => '把『' + goal + '』委托给『' + title + '』'
const callDirect = (args) => tool('workflow_delegate_direct', args)
const goal = '合成目标原文，核对原样。\n第二行保留两个空格  '
const wake = /^DSH-WORKFLOW (TASK|RESULT) ([a-f0-9-]+)$/
const plans = new Map()
const observed = { claims: 0, reports: 0, consumes: 0, closes: 0 }
const digest = (value) => createHash('sha256').update(value).digest('hex')

function decide(body, { signal }) {
  const current = latestPrompt(body.messages, (text) => plans.has(text) || wake.test(text))
  if (!current) return
  const { text, results } = current
  const plan = plans.get(text)
  if (plan) return plan(results, signal)
  const [, kind, id] = wake.exec(text)
  if (kind === 'TASK') {
    if (results.length === 0) {
      observed.claims++
      return tool('workflow_claim', { id })
    }
    if (results.length === 1) {
      const claim = results[0]
      assert.equal(claim.instructions, goal)
      assert.equal(claim.goal, goal)
      assert.equal(claim.item, 'execute')
      assert.equal(claim.scope, 'execute')
      assert.equal(claim.attempt, 1)
      assert.equal(claim.owner, owner)
      return tool('workflow_report', {
        id, attempt: claim.attempt, token: claim.token, status: 'completed',
        summary: 'Synthetic original task executed once.', evidence: ['synthetic:direct'],
      })
    }
    assert.equal(results[1]?.recorded, true)
    assert.equal(results[1]?.duplicate, false)
    observed.reports++
  } else {
    if (results.length === 0) {
      observed.consumes++
      return tool('workflow_consume', { id })
    }
    if (results.length === 1) {
      const result = results[0]
      assert.equal(result.goal, goal)
      assert.equal(result.report?.status, 'completed')
      return tool('workflow_close', {
        task: result.task, outcome: 'completed', summary: 'Synthetic direct task closed.',
      })
    }
    assert.equal(results[1]?.state, 'closing')
    observed.closes++
  }
}

async function withPlan(host, session, text, plan) {
  plans.set(text, plan)
  try { return await host.prompt(session, text) } finally { plans.delete(text) }
}

async function list(host) {
  const response = await host.post('/api/dsh-session-bridge/workflow-view', { sessionId: owner })
  assert.equal(response.status, 200)
  return response.body.tasks
}

const once = (call) => (results) => results.length ? undefined : call

async function assertDenied(host, text, expected) {
  const denied = await withPlan(host, owner, text, once(callDirect()))
  assert.equal(typeof denied.results[0]?.error, 'string', JSON.stringify(denied.results))
  if (expected) assert.equal(denied.results[0].error, expected)
  assert.deepEqual(await list(host), [])
}

async function installPrincipalFixture(host) {
  const fixture = join(host.lab, 'synthetic-principal')
  const name = '@local/dsh-bridge-direct-principal-fixture'
  await mkdir(fixture)
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    name, version: '0.0.0', private: true, type: 'module', exports: { '.': './index.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } }, engines: { dsh: '0.2.2-rc.1' },
  }))
  await writeFile(join(fixture, 'cordis.patch.yml'),
    '- insert:\n    - id: bridge-direct-principal-fixture\n      name: ' + JSON.stringify(name) + '\n')
  await writeFile(join(fixture, 'index.js'), `
    import { randomUUID } from 'node:crypto'
    export const inject = ['connection', 'remoteAccess', 'typertGateway', 'tools']
    export function apply(ctx) {
      const kind = 'bridge-direct-synthetic-viewer'
      const role = { name: 'direct-smoke-prompt', resource: 'session', actions: ['session/prompt'] }
      ctx.remoteAccess.registerPolicy(kind, {
        bindings: (caller) => caller.sessionId ? [{ role, resource: { kind: 'session', id: caller.sessionId } }] : [],
      })
      ctx.tools.register({
        name: 'collaboration_direct_fixture_non_owner',
        description: 'Synthetic non-owner prompt fixture',
        parameters: { type: 'object', required: ['to', 'text'],
          properties: { to: { type: 'string' }, text: { type: 'string' } } },
        output: { schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute({ to, text }) {
          const peer = ctx.connection.createPeer({ principal: { kind, sessionId: to } })
          try {
            return await ctx.typertGateway.invoke({
              namespace: 'session', method: 'prompt', peer,
              args: { request: { requestId: randomUUID(), sessionId: to, mode: 'queue',
                content: [{ type: 'text', text }] } },
            })
          } finally { await peer.dispose() }
        },
      })
    }
  `)
  await host.install(fixture, name)
}

async function resultAfterInput(host, matches) {
  return host.until(async () => {
    const events = await host.history(owner)
    const input = events.find(({ type, data }) => type === 'user/message' && matches(data))
    if (!input) return
    const end = events.find(({ type, seq }) => type === 'turn/end' && seq > input.seq)
    if (!end) return
    const result = events.find(({ type, seq }) => type === 'tool/result' && seq > input.seq && seq < end.seq)
    return result && { input, result: unpack(result.data.message.content), isError: result.data.message.isError }
  }, 'synthetic native input and its tool result')
}

async function rejectForeignSources(host) {
  const relayText = direct('中继合成目标')
  const wrapped = '[DSH 会话消息｜发送方 ' + other + ']\n' + relayText
  const request = 'synthetic-direct-relay'
  plans.set(wrapped, once(callDirect()))
  try {
    const relayed = await withPlan(host, other, '授权互传 ' + owner + ' ' + request + '\n' + relayText,
      once(tool('send_session_message', { to: owner, request_id: request, text: relayText })))
    assert.equal(relayed.results[0]?.delivery, 'delivered')
    const result = await resultAfterInput(host, (message) => message.source?.kind === 'agent-message' &&
      message.source.senderSessionId === other && message.content[0]?.text === wrapped)
    assert.equal(typeof result.result?.error, 'string')
  } finally { plans.delete(wrapped) }

  const text = direct('非所有者合成目标')
  plans.set(text, once(callDirect()))
  try {
    const launched = await withPlan(host, other, '发送合成非所有者消息',
      once(tool('collaboration_direct_fixture_non_owner', { to: owner, text })))
    assert.equal(launched.results[0]?.accepted, true)
    const result = await resultAfterInput(host, (message) =>
      message.source?.principal?.kind === 'bridge-direct-synthetic-viewer' && message.content[0]?.text === text)
    assert.equal(typeof result.result?.error, 'string')
  } finally { plans.delete(text) }
  assert.deepEqual(await list(host), [])
}

async function rejectMixedTurn(host) {
  const first = direct('第一条合成同轮输入')
  const second = direct('第二条合成同轮输入')
  let modelEntered = false
  let release = false
  plans.set(first, async (results, signal) => {
    if (results.length) return
    modelEntered = true
    while (!release) await delay(25, undefined, { signal })
    return callDirect()
  })
  plans.set(second, once(callDirect()))
  try {
    const firstId = await host.submit(owner, first)
    await host.until(() => modelEntered, 'the native first owner prompt has reached the model')
    const secondId = await host.submit(owner, second, 'steer')
    release = true
    const [initial, steered] = await Promise.all([host.turn(owner, firstId), host.turn(owner, secondId)])
    assert.equal(initial.end.seq, steered.end.seq)
    const admitted = initial.records.find(({ type, data }) => type === 'agent/inbox/spliced' &&
      data.target === 'next-step' && data.inserted.some(({ id }) => id === steered.input.data.id))
    assert(admitted && admitted.seq < steered.input.seq)
    assert(initial.results.length > 0)
    assert(initial.results.every((result) => typeof result?.error === 'string'), JSON.stringify(initial.results))
    assert.deepEqual(await list(host), [])
  } finally {
    release = true
    plans.delete(first)
    plans.delete(second)
  }
}

await withCollaborationHost({ dsh, archive, decide }, async (host) => {
  await host.createSessions([[owner, '合成直派主控'], [worker, workerTitle], [other, otherTitle]])
  await host.save({ enabled: true, workflowEnabled: true, allowedSessions: [owner, worker, other] })
  await installPrincipalFixture(host)

  await assertDenied(host, '这是合成示例：' + direct('引用内容'))
  await assertDenied(host, direct('无目标授权', '不存在的合成窗口'))
  await host.rename(other, workerTitle)
  await assertDenied(host, direct('同名窗口的合成目标'), 'workflow_target_clarification_required')
  await host.rename(other, otherTitle)
  const forged = direct('禁止模型修改的合成目标')
  plans.set(forged, once(callDirect({ goal: '模型替换目标', target: other })))
  try {
    await host.submit(owner, forged)
    const { result, isError } = await resultAfterInput(host, (message) =>
      message.source?.kind === 'user' && message.content[0]?.text === forged)
    assert(isError || typeof result?.error === 'string')
  } finally { plans.delete(forged) }
  await rejectForeignSources(host)
  await rejectMixedTurn(host)
  assert.deepEqual(observed, { claims: 0, reports: 0, consumes: 0, closes: 0 })
  console.log('PASS direct delegation rejects quoted examples, unresolved titles, model arguments, relay, non-owner and mixed native input')

  const started = await withPlan(host, owner, direct(goal), (results) => {
    if (results.length < 2) return callDirect()
    if (results.length === 2) return tool('workflow_dispatch', {
      task: results[0].task, item: 'extra', target: worker, scope: 'execute', attempt: 1,
      instructions: 'Unauthorized synthetic followup.', acceptance: 'Synthetic negative control.',
    })
  })
  const [result, repeated, expanded] = started.results
  assert.equal(result?.task, 'direct-' + digest(JSON.stringify([owner, started.input.data.id])))
  assert.equal(result.goal, goal)
  assert.equal(result.budget, 1)
  assert.equal(result.duplicate, false)
  assert.equal(result.scopes.length, 1)
  assert.equal(result.scopes[0].name, 'execute')
  assert.deepEqual(result.scopes[0].targets, [worker])
  assert.deepEqual(repeated, { ...result, duplicate: true })
  assert.equal(typeof expanded?.error, 'string')

  const persisted = await host.until(() => {
    const state = host.snapshot(owner, result.task)
    return state.grant?.state === 'closed' && state
  }, 'direct delegation claims, reports, consumes and closes')
  await host.idle(owner)
  assert.equal(persisted.grant.goal, goal)
  assert.equal(persisted.grant.authorization.kind, 'native-owner-workflow-direct')
  assert.equal(persisted.grant.authorization.request.messageId, started.input.data.id)
  assert.equal(persisted.grant.authorization.request.sourceDigest, digest(direct(goal)))
  assert.equal(persisted.grant.expiresAt - persisted.grant.openedAt, 30 * 60_000)
  assert.equal(persisted.grant.outcome?.status, 'completed')
  assert.equal(persisted.jobs.length, 1)
  const [job] = persisted.jobs
  assert.equal(job.id, result.id)
  assert.equal(job.instructions, goal)
  assert.equal(job.target, worker)
  assert.equal(job.wake.state, 'reported')
  assert.equal(job.resume.state, 'consumed')
  for (const [session, kind, id] of [[worker, 'task', job.wake.id], [owner, 'result', job.resume.id]]) {
    const notifications = (await host.history(session)).filter(({ type, data }) =>
      type === 'user/message' && data.source?.bridgeWorkflowId === job.id && data.source.bridgeWorkflowKind === kind)
    assert.deepEqual(notifications.map(({ data }) => data.id), [id])
  }
  assert.deepEqual(observed, { claims: 1, reports: 1, consumes: 1, closes: 1 })
  assert.deepEqual((await list(host)).map(({ task }) => task), [result.task])
  console.log('PASS one native exact owner prompt opens, dispatches and closes the immutable direct task exactly once')
})
