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
const queryTitle = '合成查询'
const direct = (goal, title = workerTitle) => '把『' + goal + '』委托给『' + title + '』'
const question = (body, title = queryTitle) => '你给' + title + '这个窗口问他' + body
const callDirect = (args) => tool('workflow_delegate_direct', args)
const goal = '合成目标原文，核对原样。\n第二行保留两个空格  '
const questionBody = '今天气温怎么样'
let expectedGoal = goal
let completionMode = 'explicit'
let heldResult
let releaseResult
const replyText = '合成回答，样本气温 21°C。'
const wake = /^DSH-WORKFLOW (TASK|RESULT) ([a-f0-9-]+)$/
const plans = new Map()
const observed = { claims: 0, reports: 0, consumes: 0, closes: 0 }
const digest = (value) => createHash('sha256').update(value).digest('hex')

async function decide(body, { signal }) {
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
      assert.equal(claim.instructions, expectedGoal)
      assert.equal(claim.goal, expectedGoal)
      assert.equal(claim.item, 'execute')
      assert.equal(claim.scope, 'execute')
      assert.equal(claim.attempt, 1)
      assert.equal(claim.owner, owner)
      return tool('workflow_report', {
        id, attempt: claim.attempt, token: claim.token, status: 'completed',
        summary: replyText, evidence: ['synthetic:direct'],
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
      assert.equal(result.goal, expectedGoal)
      assert.equal(result.report?.status, 'completed')
      assert.equal(result.report?.summary, replyText)
      if (completionMode === 'silent') return { reply: '   ' }
      if (completionMode === 'recovery') {
        heldResult = id
        while (!releaseResult) await delay(25, undefined, { signal })
      }
      if (completionMode !== 'explicit') return { reply: replyText }
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

async function rejectForeignSources(host, requestText = direct, tag = 'quoted') {
  const relayText = requestText('中继合成目标')
  const wrapped = '[DSH 会话消息｜发送方 ' + other + ']\n' + relayText
  const request = 'synthetic-direct-relay-' + tag
  plans.set(wrapped, once(callDirect()))
  try {
    const relayed = await withPlan(host, other, '授权互传 ' + owner + ' ' + request + '\n' + relayText,
      once(tool('send_session_message', { to: owner, request_id: request, text: relayText })))
    assert.equal(relayed.results[0]?.delivery, 'delivered')
    const result = await resultAfterInput(host, (message) => message.source?.kind === 'agent-message' &&
      message.source.senderSessionId === other && message.content[0]?.text === wrapped)
    assert.equal(typeof result.result?.error, 'string')
  } finally { plans.delete(wrapped) }

  const text = requestText('非所有者合成目标')
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

async function rejectMixedTurn(host, first = direct('第一条合成同轮输入')) {
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

async function verifyDirect(host, request, body, {
  targetTitle = workerTitle, checkOrdinary = false, renameTo, mode = 'explicit',
} = {}) {
  expectedGoal = body
  completionMode = mode
  heldResult = undefined
  releaseResult = false
  const started = await withPlan(host, owner, request, async (results) => {
    if (checkOrdinary && results.length === 0) return tool('send_natural_session_message')
    const directResults = checkOrdinary ? results.slice(1) : results
    if (renameTo && directResults.length === 1) await host.rename(worker, renameTo)
    if (directResults.length < 2) return callDirect()
    if (directResults.length === 2) return tool('workflow_dispatch', {
      task: directResults[0].task, item: 'extra', target: worker, scope: 'execute', attempt: 1,
      instructions: 'Unauthorized synthetic followup.', acceptance: 'Synthetic negative control.',
    })
    return { reply: '已派给「' + directResults[0].targetTitle + '」，等待结果。' }
  })
  if (checkOrdinary) assert.deepEqual(started.results[0], { error: 'message_authorization_required' })
  const [result, repeated, expanded] = checkOrdinary ? started.results.slice(1) : started.results
  assert.equal(result?.task, 'direct-' + digest(JSON.stringify([owner, started.input.data.id])), JSON.stringify(started.results))
  assert.equal(result.goal, body)
  assert.equal(result.budget, 1)
  assert.equal(result.state, 'queued')
  assert.equal(result.targetTitle, targetTitle)
  assert.equal(result.duplicate, false)
  assert.equal(result.scopes.length, 1)
  assert.equal(result.scopes[0].name, 'execute')
  assert.deepEqual(result.scopes[0].targets, [worker])
  assert.deepEqual(repeated, { ...result, duplicate: true })
  assert.equal(typeof expanded?.error, 'string')
  assert(started.records.some(({ type, data }) => type === 'assistant/message' &&
    data.message.content.some(({ type, text }) => type === 'text' && text === '已派给「' + targetTitle + '」，等待结果。')))

  if (mode === 'recovery') {
    await host.until(() => heldResult === result.id, 'native result has been consumed before restart')
    const snapshot = host.snapshot(owner, result.task)
    assert.equal(snapshot.grant.state, 'collaboration_active')
    assert.equal(snapshot.jobs[0].resume.continuation.state, 'started')
    const name = '@local/dsh-session-bridge'
    assert.equal((await host.rpc('pluginManager/setBundleEnabled', { name, enabled: false })).application, 'applied')
    releaseResult = true
    await host.idle(owner)
    assert.deepEqual(host.snapshot(owner, result.task), snapshot)
    await host.stop()
    await host.start()
    assert.equal((await host.rpc('pluginManager/setBundleEnabled', { name, enabled: true })).application, 'applied')
  }

  const persisted = await host.until(() => {
    const state = host.snapshot(owner, result.task)
    const expectedState = mode === 'silent' ? 'collaboration_active' : 'closed'
    return state.grant?.state === expectedState && state.jobs[0]?.resume?.continuation?.state === 'verified' && state
  }, 'direct delegation claims, reports, consumes and closes')
  await host.idle(owner)
  assert.equal(persisted.grant.goal, body)
  assert.equal(persisted.grant.authorization.kind, 'native-owner-workflow-direct')
  assert.equal(persisted.grant.authorization.request.messageId, started.input.data.id)
  assert.equal(persisted.grant.authorization.request.sourceDigest, digest(request))
  assert.deepEqual(persisted.grant.authorization.targets, [{ id: worker, title: targetTitle }])
  assert.equal(persisted.grant.expiresAt - persisted.grant.openedAt, 30 * 60_000)
  if (mode === 'silent') assert.equal(persisted.grant.outcome, undefined)
  else {
    assert.equal(persisted.grant.outcome?.status, 'completed')
    assert.equal(persisted.grant.outcome.summary, mode === 'explicit' ? 'Synthetic direct task closed.' : replyText)
  }
  assert.equal(persisted.jobs.length, 1)
  const [job] = persisted.jobs
  assert.equal(job.id, result.id)
  assert.equal(job.instructions, body)
  assert.equal(job.target, worker)
  assert.equal(job.wake.state, 'reported')
  assert.equal(job.resume.state, 'consumed')
  if (mode === 'reply' || mode === 'recovery') {
    assert.equal(persisted.grant.closure, undefined)
    const events = await host.history(owner)
    const reply = events.find(({ type, data }) => type === 'assistant/message' &&
      data.turn === persisted.grant.closedTurn && data.message.content.some(({ type, text }) =>
        type === 'text' && text === replyText))
    assert(reply && reply.seq > job.resume.continuation.replyAfterSeq)
  }
  for (const [session, kind, id] of [[worker, 'task', job.wake.id], [owner, 'result', job.resume.id]]) {
    const notifications = (await host.history(session)).filter(({ type, data }) =>
      type === 'user/message' && data.source?.bridgeWorkflowId === job.id && data.source.bridgeWorkflowKind === kind)
    assert.deepEqual(notifications.map(({ data }) => data.id), [id])
  }
  return result.task
}

async function verifyQuotedOrdinary(host) {
  const body = '  合成正文第一行\n第二行保留两个空格  '
  const text = '把『' + body + '』发给『' + queryTitle + '』窗口'
  const send = tool('send_natural_session_message')
  await host.rename(other, queryTitle)
  assert.deepEqual((await withPlan(host, owner, text, once(send))).results,
    [{ error: 'ambiguous_session_title', title: queryTitle }])
  await host.rename(other, otherTitle)
  await host.save({ allowedSessions: [owner, other] })
  assert.deepEqual((await withPlan(host, owner, text, once(send))).results,
    [{ error: 'session_title_required', title: queryTitle }])
  await host.save({ allowedSessions: [owner, worker, other] })
  const result = await withPlan(host, owner, text, (results) => {
    if (!results.length) return callDirect()
    if (results.length < 3) return send
  })
  const [delegation, sent, repeated] = result.results
  assert.equal(delegation?.error, 'workflow_direct_owner_request_required')
  assert.equal(sent?.delivery, 'delivered', JSON.stringify(result.results))
  assert.equal(sent.to, worker)
  assert.equal(repeated?.duplicate, true)
  assert.equal(repeated.messageId, sent.messageId)
  await host.idle(worker)
  const messages = (await host.history(worker)).filter(({ type, data }) =>
    type === 'user/message' && data.source?.bridgeReceiptKey && data.source.senderSessionId === owner)
  assert.deepEqual(messages.map(({ data }) => [data.id, data.content[0].text]), [
    [sent.messageId, '[DSH 会话消息｜发送方 ' + owner + ']\n' + body],
  ])
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
  await host.rename(worker, queryTitle)
  await host.rename(other, queryTitle)
  await host.save({ allowedSessions: [owner, worker] })
  await assertDenied(host, question(questionBody), 'workflow_target_clarification_required')
  await host.rename(other, otherTitle)
  await host.save({ allowedSessions: [owner, other] })
  await assertDenied(host, question(questionBody), 'workflow_target_not_available')
  await host.save({ allowedSessions: [owner, worker, other] })
  const ambiguous = queryTitle + '和' + otherTitle
  await host.rename(other, ambiguous)
  await assertDenied(host, question(questionBody, ambiguous))
  await host.rename(other, otherTitle)
  for (const text of [question('', queryTitle), question('。'), question(questionBody, '不存在的合成查询'),
    '这是合成示例：' + question(questionBody), '你给这个窗口问他' + questionBody,
    '你给合成查询这个窗口问他们' + questionBody,
    '你给合成查询这个窗口和合成备用这个窗口问他们' + questionBody]) {
    await assertDenied(host, text)
  }
  await rejectForeignSources(host, question, 'colloquial')
  await rejectMixedTurn(host, question('第一条合成同轮问题'))
  const renamedBeforeCall = await withPlan(host, owner, question(questionBody), async (results) => {
    if (results.length) return
    await host.rename(worker, '合成派工前改名')
    return callDirect()
  })
  assert.deepEqual(renamedBeforeCall.results, [{ error: 'workflow_target_clarification_required' }])
  assert.deepEqual(await list(host), [])
  assert.deepEqual(observed, { claims: 0, reports: 0, consumes: 0, closes: 0 })
  console.log('PASS direct delegation rejects quoted examples, unresolved titles, model arguments, relay, non-owner and mixed native input')

  await host.rename(worker, workerTitle)
  const quoted = await verifyDirect(host, direct(goal), goal)
  assert.deepEqual(observed, { claims: 1, reports: 1, consumes: 1, closes: 1 })
  console.log('PASS one native exact owner prompt opens, dispatches and closes the immutable direct task exactly once')

  await host.rename(worker, '你是谁')
  const originalQuestion = '今天成都天气怎么样'
  const asked = await verifyDirect(host, question(originalQuestion, '你是谁'), originalQuestion, {
    targetTitle: '你是谁', checkOrdinary: true, renameTo: '合成派工后改名', mode: 'reply',
  })
  assert.deepEqual(observed, { claims: 2, reports: 2, consumes: 2, closes: 1 })
  console.log('PASS original wording uses the exact bound title and closes on the visible reply without an explicit close tool')

  await host.rename(worker, queryTitle)
  const quotedQuestionBody = '样本怎么样？  \n请保留问题原文  '
  const askedWithTitle = await verifyDirect(host, '请你给『合成查询』窗口问它' + quotedQuestionBody, quotedQuestionBody,
    { targetTitle: queryTitle, checkOrdinary: true })
  const silentGoal = '合成无可见答复的结果轮'
  const silent = await verifyDirect(host, question(silentGoal), silentGoal, { targetTitle: queryTitle, mode: 'silent' })
  console.log('PASS a completed result turn without non-empty visible text leaves its grant open')
  const recoveryGoal = '合成插件停用后正常答复与恢复'
  const recovered = await verifyDirect(host, question(recoveryGoal), recoveryGoal, { targetTitle: queryTitle, mode: 'recovery' })
  console.log('PASS restart recovers the verified native reply and closes without replay')

  await verifyQuotedOrdinary(host)
  assert.deepEqual((await list(host)).map(({ task }) => task).sort(), [asked, askedWithTitle, quoted, silent, recovered].sort())
  assert.deepEqual(observed, { claims: 5, reports: 5, consumes: 5, closes: 2 })
  console.log('PASS quoted outside window suffix relays the exact text once without creating a workflow')
})
