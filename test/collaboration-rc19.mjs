import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { latestPrompt, tool, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, archive, playwright, chrome] = process.argv.slice(2)
assert(dsh && archive && Boolean(playwright) === Boolean(chrome))
const main = 'synthetic-refactor-main'
const alpha = 'synthetic-refactor-alpha'
const beta = 'synthetic-refactor-beta'
const unrelated = 'synthetic-refactor-unrelated'
const titles = [[main, '00-main'], [alpha, '02-合成核对'], [beta, '99-合成审核'], [unrelated, '88-合成旁观']]
const questions = [
  { request: '你问一下02窗口今天都做了什么', goal: '今天都做了什么', answer: '甲窗原样返回合成结果 A-867。', worker: alpha },
  { request: '你问一下99窗口今天完成了哪些任务', goal: '今天完成了哪些任务', answer: '乙窗原样返回合成结果 B-341。', worker: beta },
]
const progress = '主控可以补充第二份合成样本。'
const followup = '核对第二份合成样本，请保留原始摘要。'
const final = '已核对第二份合成样本。'
const firstRequest = '请给02-合成核对窗口发消息：' + followup
const wrongRequest = '请给02-合成核对窗口发消息：不能错投的补充。'
const outsider = '请把本轮合成消息发到未参与者。'
const planned = new Map()
const seen = new Set()
const taskWake = /^DSH-WORKFLOW TASK ([a-f0-9-]+)$/
const conversation = /^任务消息 · ([a-zA-Z0-9_-]+) · ([a-zA-Z0-9_-]+) → ([a-zA-Z0-9_-]+)\n\n([\s\S]+)$/u
let releaseWorkers = false

async function decide({ messages }, { signal }) {
  const found = latestPrompt(messages, (text) => planned.has(text) || taskWake.test(text) ||
    conversation.test(text) || questions.some(({ request, goal }) => text === request || text === goal))
  if (!found) return { reply: '合成会话正常结束。' }
  const { text, results } = found
  if (planned.has(text)) return planned.get(text)(results, signal)
  const asked = questions.find((row) => row.goal === text)
  if (asked) {
    if (!results.length) {
      seen.add(asked.worker)
      while (!releaseWorkers) await delay(15, undefined, { signal })
      if (asked.worker === alpha) return tool('send_natural_session_message', { draft: progress })
    }
    return { reply: asked.answer }
  }
  if (text.startsWith('任务消息 · ')) {
    if (conversation.exec(text)?.[4] === followup) return { reply: final }
    return { reply: '合成接收窗已读。' }
  }
  return { reply: '由宿主处理合成问句。' }
}

await withCollaborationHost({ dsh, archive, decide, modelDeadlineMs: 30_000, timeRefreshIntervalMs: 0 }, async (host) => {
  await host.createSessions(titles)
  await host.save({ enabled: true })
  const { namespaces } = await host.rpc('settings/describe')
  const bridge = namespaces.find(({ ns }) => ns === 'dsh-session-bridge-settings')
  assert.equal(bridge.value.enabled, true)
  const get = async (id) => {
    try { return await host.history(id) }
    catch (error) { if (!String(error.message).includes('session/agent-busy')) throw error; return [] }
  }
  const events = async (id, kind) => (await get(id)).filter(({ type, data }) =>
    type === 'user/message' && data.source?.bridgeWorkflowKind === kind)
  const bodyOf = (data) => conversation.exec(data.content[0].text)?.[4]
  const messages = async (id, text) => (await events(id, 'conversation')).filter(({ data }) => bodyOf(data) === text)
  const receive = (id, text) => host.until(async () => (await messages(id, text))[0], 'receives one exact task message')
  const send = (to, request_id, text, task) => tool('send_session_message', {
    to, request_id, text, ...(task ? { task } : {}),
  })
  const call = async (id, prompt, invocation) => {
    planned.set(prompt, (results) => results.length ? undefined : invocation)
    try { return (await host.prompt(id, prompt)).results[0] }
    finally { planned.delete(prompt) }
  }

  await host.rpc('session/selectModel', {
    request: { sessionId: main, provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  })
  try {
    const turn = await host.prompt(main, questions[0].request)
    assert.deepEqual(turn.results, [], 'controller model calls no dispatch tool')
    assert(turn.records.some(({ type, data }) => type === 'user/message' && data.source?.kind === 'model-selection'))
    await host.until(() => seen.has(alpha), 'alpha started before beta is requested')
    assert.deepEqual((await host.prompt(main, questions[1].request)).results, [])
    await host.until(() => seen.has(beta), 'two workers overlap on independent authorized tasks')
  } finally {
    releaseWorkers = true
  }
  await Promise.all([alpha, beta].map(host.idle))
  const alphaResult = await receive(main, questions[0].answer)
  const betaResult = await receive(main, questions[1].answer)
  await receive(main, progress)
  const jobOf = (entry) => entry.data.source.bridgeWorkflowId
  const taskOf = (entry) => entry.data.source.bridgeWorkflowTask
  assert.notEqual(jobOf(alphaResult), jobOf(betaResult))
  assert.equal(alphaResult.data.source.senderSessionId, alpha)
  assert.equal(betaResult.data.source.senderSessionId, beta)
  assert.equal((await events(alpha, 'task')).length, 1)
  assert.equal((await events(beta, 'task')).length, 1)
  await host.idle(main)
  console.log('PASS a real model-switch notice and two concurrent workers, one dispatch and one automatic answer each')

  const mismatch = await call(main, wrongRequest, send(beta, 'wrong-live-peer', '不能错投的补充。'))
  assert.equal(mismatch.error, 'workflow_task_mismatch')
  const outOfScope = await call(main, outsider + ' ' + taskOf(alphaResult),
    send(unrelated, 'out-of-scope', '不能给旁观窗口。', jobOf(alphaResult)))
  assert(outOfScope.error)
  const relayed = await call(unrelated, '从无任务窗口发起一条工具调用',
    send(beta, 'unbound', '不能从无任务窗口发出。'))
  assert(relayed.error)
  {
    const pausedBody = '在总开关关闭之前预留的合成追加。'
    const pausedPrompt = '追加任务 ' + taskOf(alphaResult)
    let paused
    let finish = false
    planned.set(pausedPrompt, async (results, signal) => {
      if (!results.length) return send(alpha, 'master-pause', pausedBody, jobOf(alphaResult))
      paused = results[0]
      while (!finish) await delay(15, undefined, { signal })
      return { reply: '合成主控轮结束。' }
    })
    try {
      const prompt = await host.submit(main, pausedPrompt)
      await host.until(() => paused?.delivery === 'queued', 'pending message reserved before turning off')
      await host.save({ enabled: false })
      finish = true
      await host.turn(main, prompt)
      await delay(350)
      assert.equal((await messages(alpha, pausedBody)).length, 0)
      assert.equal((await call(main, '关闭期间核对回执', tool('session_message_status', {
        request_id: 'master-pause', job: jobOf(alphaResult),
      }))).messageId, paused.messageId)
      await host.save({ enabled: true })
    } finally {
      finish = true
      planned.delete(pausedPrompt)
    }
    console.log('PASS master switch stops not-yet-admitted traffic while preserving the receipt')
  }
  const exact = await call(main, firstRequest, tool('send_natural_session_message'))
  assert.equal(exact.job, jobOf(alphaResult))
  await receive(alpha, followup)
  assert.equal(jobOf(await receive(main, final)), jobOf(alphaResult))
  await host.idle(main)
  console.log('PASS exact owner title overrides mistaken recipient, third-party route fails, and an authorized follow-up returns')

  async function queueThenCancel(entry, withdrawn, request, text) {
    const prompt = '追加任务 ' + taskOf(entry)
    let receipt
    let release = false
    planned.set(prompt, async (results, signal) => {
      if (!results.length) return send(entry.data.source.senderSessionId, request, text, jobOf(entry))
      receipt = results[0]
      while (!release) await delay(15, undefined, { signal })
      return { reply: '合成主控轮结束。' }
    })
    try {
      const pending = await host.submit(main, prompt)
      await host.until(() => receipt?.delivery === 'queued', 'receipt reserved before cancellation')
      const cancel = await host.submit(main, '取消委托 ' + taskOf(withdrawn), 'queue')
      release = true
      const [source, stopped] = await Promise.all([host.turn(main, pending), host.turn(main, cancel)])
      const admission = (await host.history(main)).find(({ type, data }) =>
        type === 'agent/inbox/spliced' && data.inserted.some(({ id }) => id === stopped.input.data.id))
      assert(admission && admission.seq < source.end.seq && stopped.input.seq > source.end.seq)
      assert.equal(host.snapshot(main, taskOf(withdrawn)).grant.state, 'cancelled')
      return receipt
    } finally {
      release = true
      planned.delete(prompt)
    }
  }
  const intact = '撤回甲任务时乙任务继续。'
  await queueThenCancel(betaResult, alphaResult, 'other-task-cancelled', intact)
  await receive(beta, intact)
  await host.idle(main)
  const suppressed = '撤回同一个任务时不得入队。'
  const reserved = await queueThenCancel(betaResult, betaResult, 'same-task-cancelled', suppressed)
  const status = () => call(main, '只读检查合成回执', tool('session_message_status', {
    request_id: 'same-task-cancelled', job: jobOf(betaResult),
  }))
  const before = await status()
  assert.equal(before.messageId, reserved.messageId)
  assert.equal(before.delivery, 'not_delivered')
  const seenDeliveries = async () => {
    await host.idle(main)
    assert.equal((await messages(main, questions[0].answer)).length, 1)
    assert.equal((await messages(main, questions[1].answer)).length, 1)
    assert.equal((await messages(main, final)).length, 1)
    assert.equal((await messages(alpha, followup)).length, 1)
    assert.equal((await messages(beta, intact)).length, 1)
    assert.equal((await messages(beta, suppressed)).length, 0)
    assert.equal((await events(unrelated, 'conversation')).length, 0)
  }
  await seenDeliveries()
  await host.save({ enabled: false })
  await host.stop()
  await host.start()
  assert.deepEqual(await status(), before)
  await seenDeliveries()
  const { namespaces: restartedSettings } = await host.rpc('settings/describe')
  assert.equal(restartedSettings.find(({ ns }) => ns === 'dsh-session-bridge-settings').value.enabled, false)
  await host.prompt(main, questions[0].request)
  assert.equal((await events(alpha, 'task')).length, 1)
  const endpoint = '/api/dsh-session-bridge/status-log'
  const response = await host.post(endpoint, { sessionId: main })
  assert.equal(response.status, 200)
  assert.equal(response.body.enabled, false)
  const statuses = new Set(response.body.events.map(({ state }) => state))
  for (const state of ['queued', 'admitted', 'executing', 'returned', 'cancelled']) assert(statuses.has(state), state)
  const names = new Set(response.body.events.flatMap(({ from, to }) => [from, to]))
  for (const [, name] of titles.slice(0, 3)) assert(names.has(name))
  const privateContent = [main, alpha, beta, unrelated, ...questions.map(({ answer }) => answer), followup, final, suppressed]
  for (const text of privateContent) assert(!JSON.stringify(response.body).includes(text))
  const spectator = await host.post(endpoint, { sessionId: unrelated })
  assert.equal(spectator.status, 200)
  assert.deepEqual(spectator.body.events, [])
  const unauthenticated = await fetch(new URL(endpoint, host.browserOptions().launchUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: main }),
    signal: AbortSignal.timeout(3000),
  })
  assert([401, 403].includes(unauthenticated.status))
  if (playwright) {
    const { verifyStatusBrowser } = await import('./status-browser-rc19.mjs')
    await verifyStatusBrowser(host, playwright, chrome, {
      main: titles[0][1], windows: titles.slice(1, 3).map(([, name]) => name),
      ids: titles.map(([id]) => id), bodies: [...questions.map(({ answer }) => answer), followup, final],
    })
  }
  console.log('PASS owner-only status history persists while disabled, excludes unrelated windows, IDs and payloads')
  console.log('PASS cancellation fences only its own queued delivery, restart preserves receipt and never replays, paused switch survives')
})
