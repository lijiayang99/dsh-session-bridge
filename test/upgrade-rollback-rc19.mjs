import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { latestPrompt, tool, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, stable, candidate] = process.argv.slice(2)
assert(dsh && stable && candidate)
const candidateVersion = /0\.5\.0-rc\.\d+(?=\.tgz$)/u.exec(candidate)?.[0]
assert(candidateVersion)
const plugin = '@local/dsh-session-bridge'
const owner = 'synthetic-migrate-main'
const worker = 'synthetic-migrate-worker'
const newWorker = 'synthetic-migrate-new'
const rows = [[owner, '00-main'], [worker, '02-合成资料'], [newWorker, '99-合成未预选']]
const oldValues = { enabled: true, workflowEnabled: true, allowedSessions: [owner, worker] }
const legacyText = '合成升级前消息，仅用于回执核验。'
const legacyId = 'synthetic-before-refactor'
const legacyPrompt = '授权互传 ' + worker + ' ' + legacyId + '\n' + legacyText
const readLegacy = '核对升级前原回执'
const oldTask = '你问一下02窗口今天做了哪些事情'
const oldGoal = '今天做了哪些事情'
const oldAnswer = '升级前已核对合成任务。'
const nextTask = '你问一下99窗口今天做了哪些事情'
const nextAnswer = '无需预选的窗口已核对合成任务。'
const marker = /^DSH-WORKFLOW TASK ([a-f0-9-]+)$/u

const hold = '暂时占用合成工作窗，等到显式释放。'
const queuedTask = 'synthetic-legacy-paused'
const queuedInput = '授权委托\n' + JSON.stringify({
  task: queuedTask, ttlMinutes: 30, goal: '合成暂停任务',
  scopes: [{ name: 'execute', targets: [worker] }],
})
let workerBusy = false
let releaseWorker = false

async function decide({ messages }, { signal }) {
  const p = latestPrompt(messages, (text) =>
    [legacyPrompt, readLegacy, oldTask, nextTask, hold, queuedInput].includes(text) || marker.test(text))
  if (!p) return { reply: '合成会话正常结束。' }
  if (p.text === hold) {
    workerBusy = true
    while (!releaseWorker) await delay(15, undefined, { signal })
    return { reply: '合成工作窗释放。' }
  }
  if (p.text === queuedInput && !p.results.length) return tool('workflow_dispatch', {
    task: queuedTask, item: 'paused', attempt: 1, target: worker, scope: 'execute',
    instructions: '核对合成样本。', acceptance: '回报合成结果。',
  })
  if (p.text === legacyPrompt && !p.results.length) {
    return tool('send_session_message', { to: worker, request_id: legacyId, text: legacyText })
  }
  if (p.text === readLegacy && !p.results.length) {
    return tool('session_message_status', { request_id: legacyId })
  }
  if (marker.test(p.text)) {
    const [, id] = marker.exec(p.text)
    if (!p.results.length) return tool('workflow_claim', { id })
    const [claim] = p.results
    assert.equal(claim.instructions, oldGoal)
    const isNew = p.results[0].scope === 'execute' &&
      messages.some(({ role, content }) => role === 'user' &&
        (Array.isArray(content) && content.some(({ text }) => text?.includes('初始化合成窗口 99-'))))
    if (p.results.length === 1) return tool('workflow_report', {
      id, token: claim.token, attempt: claim.attempt, status: 'completed',
      summary: isNew ? nextAnswer : oldAnswer, evidence: ['synthetic:upgrade'],
    })
    assert(p.results[1].recorded || p.results[1].queued)
  }
  return { reply: '合成会话正常结束。' }
}

await withCollaborationHost({ dsh, archive: candidate, bootstrap: stable, decide }, async (host) => {
  await host.createSessions(rows)
  await host.save(oldValues)
  const readReceipt = async () => (await host.prompt(owner, readLegacy)).results[0]
  const settings = async () => {
    const { namespaces } = await host.rpc('settings/describe')
    return namespaces.find(({ ns }) => ns === 'dsh-session-bridge-settings').value
  }
  const messages = async (window, kind) => {
    try {
      return (await host.history(window)).filter(({ type, data }) => type === 'user/message' &&
        data.source?.bridgeWorkflowKind === kind)
    } catch (error) {
      if (!String(error.message).includes('session/agent-busy')) throw error
      return []
    }
  }
  const sent = (await host.prompt(owner, legacyPrompt)).results[0]
  assert.equal(sent.delivery, 'delivered')
  await host.idle(worker)
  const receipt = await host.until(async () => {
    const value = await readReceipt()
    return value.processing === 'processed' && value
  }, 'old ordinary receipt is durably processed')

  const result = async (window) => host.until(async () => (await messages(owner, 'result'))
    .find(({ data }) => data.source.senderSessionId === window), 'automatically returns to the origin')
  await host.prompt(owner, oldTask)
  const before = await result(worker)
  const oldId = before.data.source.bridgeWorkflowId
  await host.idle(owner)
  const oldRoute = (await messages(worker, 'task')).map(({ data }) => data.source.bridgeWorkflowId)
  assert.deepEqual(oldRoute, [oldId])

  const holdTurn = await host.submit(worker, hold)
  await host.until(() => workerBusy, 'synthetic legacy worker is occupied')
  try {
    const [queued] = (await host.prompt(owner, queuedInput)).results
    assert.equal(queued.state, 'queued')
    await host.save({ workflowEnabled: false })
  } finally {
    releaseWorker = true
  }
  await host.turn(worker, holdTurn)
  assert.deepEqual((await messages(worker, 'task')).map(({ data }) => data.source.bridgeWorkflowId), oldRoute)
  assert.equal(host.snapshot(owner, queuedTask).jobs[0].wake.state, 'queued')
  const mixed = { ...oldValues, workflowEnabled: false }
  assert.deepEqual(await settings(), mixed)

  async function swap(archive, version) {
    assert.equal((await host.rpc('pluginManager/setBundleEnabled', { name: plugin, enabled: false })).application, 'applied')
    await host.stop()
    await host.start()
    assert.equal((await host.rpc('pluginManager/removeBundle', { name: plugin })).application, 'applied')
    assert.equal((await host.install(archive, plugin)).version, version)
    await host.stop()
    await host.start()
    const bundles = await host.rpc('pluginManager/listBundles')
    const loaded = (Array.isArray(bundles) ? bundles : bundles.bundles).find(({ name }) => name === plugin)
    assert.equal(loaded.version, version)
    assert.equal(loaded.enabled, true)
  }

  await swap(candidate, candidateVersion)
  assert.deepEqual(await settings(), mixed, 'enabled remains authoritative and legacy values survive')
  assert.deepEqual(await readReceipt(), receipt)
  assert.equal((await messages(owner, 'result')).filter(({ data }) => data.source.bridgeWorkflowId === oldId).length, 1)
  await host.prompt(owner, nextTask)
  const after = await result(newWorker)
  await host.idle(owner)
  assert.notEqual(after.data.source.bridgeWorkflowId, oldId)
  assert.equal((await messages(newWorker, 'task')).length, 1)
  assert.equal(host.snapshot(owner, queuedTask).jobs[0].wake.state, 'queued')
  assert.deepEqual((await messages(worker, 'task')).map(({ data }) => data.source.bridgeWorkflowId), oldRoute)
  console.log('PASS mixed rc.18 flags preserve history and the paused queue while a new explicitly authorized window reports')

  workerBusy = false
  releaseWorker = false
  const holdNew = await host.submit(newWorker, hold)
  await host.until(() => workerBusy, 'synthetic candidate worker is occupied')
  let pausedTask
  let pausedId
  try {
    const { input } = await host.prompt(owner, nextTask)
    pausedTask = 'direct-' + createHash('sha256').update(JSON.stringify([owner, input.data.id])).digest('hex')
    const queued = await host.until(() => host.snapshot(owner, pausedTask).jobs[0], 'candidate job is durably queued')
    pausedId = queued.id
    assert.equal(queued.wake.state, 'queued')
    await host.save({ enabled: false, workflowEnabled: true })
  } finally {
    releaseWorker = true
  }
  await host.turn(newWorker, holdNew)
  await host.stop()
  await host.start()
  assert.deepEqual(await settings(), { ...oldValues, enabled: false })
  assert.equal(host.snapshot(owner, pausedTask).jobs[0].wake.state, 'queued')
  assert.equal((await messages(newWorker, 'task')).length, 1)
  await host.save({ enabled: true })
  const resumed = await host.until(async () => (await messages(owner, 'result'))
    .find(({ data }) => data.source.bridgeWorkflowId === pausedId), 'original queued authorization returns after re-enable')
  await host.idle(owner)
  assert.deepEqual((await messages(newWorker, 'task')).map(({ data }) => data.source.bridgeWorkflowId),
    [after.data.source.bridgeWorkflowId, pausedId])
  console.log('PASS disabled master survives restart even with old workflow flag on and resumes its own queued job once')

  await host.save({ enabled: false, workflowEnabled: false })
  await swap(stable, '0.5.0-rc.18')
  await host.save({ ...oldValues, enabled: false, workflowEnabled: false })
  assert.deepEqual(await readReceipt(), receipt)
  assert.deepEqual((await messages(owner, 'result')).map(({ data }) => data.id), [before.data.id, after.data.id, resumed.data.id])
  await host.save(mixed)
  await host.idle(owner)
  assert.deepEqual((await messages(worker, 'task')).map(({ data }) => data.source.bridgeWorkflowId), oldRoute)
  assert.equal((await messages(newWorker, 'task')).length, 2)
  assert.equal(host.snapshot(owner, queuedTask).jobs[0].wake.state, 'queued')
  console.log('PASS fixed rc.18 rollback reads original receipt and all original result turns without replay')
})
