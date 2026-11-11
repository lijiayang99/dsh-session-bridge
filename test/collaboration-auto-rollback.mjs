import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { latestPrompt, tool, withCollaborationHost } from './collaboration-host.mjs'

const args = process.argv.slice(2)
assert.equal(args.length, 3, 'Usage: node test/collaboration-auto-rollback.mjs <dsh> <fixed rc.8.tgz> <rc.9.tgz>')
const [dsh, stable, candidate] = args.map((path) => resolve(path))
const hash = (data) => createHash('sha256').update(data).digest('hex')
assert.equal(hash(await readFile(stable)), 'c904db1f32cd6c0dc1733abc267f4050d32875ad6e22cbadb5c0dc74ad60c27f')
const owner = 'synthetic-swap-main'
const worker = 'synthetic-swap-worker'
const name = '@local/dsh-session-bridge'
const off = { enabled: false, workflowEnabled: false }
const allowedSessions = [owner, worker]
const plans = new Map()
const taskMarker = /^DSH-WORKFLOW TASK ([a-f0-9-]+)$/
const prompt = '你给你是谁这个窗口问他今天成都天气怎么样'
const summary = '合成回退验收结果'
const receiptRequest = 'synthetic-before-rc9'
let claims = 0

function decide({ messages }) {
  const current = latestPrompt(messages, (text) => plans.has(text) || taskMarker.test(text))
  if (!current) return
  const { text, results } = current
  if (plans.has(text)) return results.length ? undefined : plans.get(text)
  const [, id] = taskMarker.exec(text)
  if (!results.length) {
    claims++
    return tool('workflow_claim', { id })
  }
  if (results.length === 1) {
    const [{ token, attempt }] = results
    return tool('workflow_report', { id, token, attempt, status: 'completed', summary, evidence: ['synthetic:swap'] })
  }
}

async function call(host, text, step) {
  plans.set(text, step)
  try {
    const result = await host.prompt(owner, text)
    assert.equal(result.results.length, 1)
    return result.results[0]
  } finally {
    plans.delete(text)
  }
}

async function swap(host, archive, version) {
  await host.save(off)
  assert.equal((await host.rpc('pluginManager/setBundleEnabled', { name, enabled: false })).application, 'applied')
  await host.stop()
  await cp(join(host.dshHome, 'profiles/web'), join(host.lab, 'backup-to-' + version, 'web'), { recursive: true })
  await cp(join(host.dshHome, 'dsh-session-bridge'), join(host.lab, 'backup-to-' + version, 'receipts'), { recursive: true })
  await host.start()
  assert.equal((await host.rpc('pluginManager/removeBundle', { name })).application, 'applied')
  assert.equal((await host.install(archive, name)).version, version)
  await host.stop()
  await host.start()
  const bundle = (await host.rpc('pluginManager/listBundles')).find((row) => row.name === name)
  assert.equal(bundle?.version, version)
  assert.equal(bundle?.enabled, true)
  const { namespaces } = await host.rpc('settings/describe')
  assert.deepEqual(namespaces.find(({ ns }) => ns === 'dsh-session-bridge-settings')?.value, { ...off, allowedSessions })
}

const workflowWakes = (events, kind) => events.filter(({ type, data }) =>
  type === 'user/message' && data.source?.bridgeWorkflowKind === kind).map(({ data }) => data.id)
const readReceipt = (host) => call(host, '读取合成换包回执', tool('session_message_status', { request_id: receiptRequest }))

await withCollaborationHost({ dsh, archive: candidate, bootstrap: stable, decide }, async (host) => {
  await host.createSessions([[owner, '00-main'], [worker, '你是谁']])
  await host.save({ enabled: true, workflowEnabled: true, allowedSessions })
  const text = '合成普通回执'
  const sent = await call(host, '授权互传 ' + worker + ' ' + receiptRequest + '\n' + text,
    tool('send_session_message', { to: worker, request_id: receiptRequest, text }))
  assert.equal(sent.delivery, 'delivered')
  await host.idle(worker)
  const retained = await host.until(async () => {
    const receipt = await readReceipt(host)
    return receipt.processing === 'processed' && receipt
  }, 'ordinary message has durable receipt')

  await swap(host, candidate, '0.5.0-rc.9')
  assert.deepEqual(await readReceipt(host), retained)
  await host.save({ enabled: true, workflowEnabled: true })
  const input = await host.prompt(owner, prompt)
  assert.deepEqual(input.results, [])
  const task = 'direct-' + hash(JSON.stringify([owner, input.input.data.id]))
  const closed = await host.until(() => {
    const state = host.snapshot(owner, task)
    return state.grant?.state === 'closed' && state
  }, 'native report closed in rc.9')
  assert.equal(closed.grant.outcome.summary, summary)

  await swap(host, stable, '0.5.0-rc.8')
  assert.deepEqual(await readReceipt(host), retained)
  assert.deepEqual(host.snapshot(owner, task), closed)
  const view = await host.post('/api/dsh-session-bridge/workflow-view', { sessionId: owner, task })
  assert.equal(view.body.state, 'closed')
  assert.equal(view.body.outcome.summary, summary)
  await host.save({ enabled: true, workflowEnabled: true })
  await host.prompt(owner, prompt)
  await host.idle(owner)
  assert.deepEqual(workflowWakes(await host.history(owner), 'result'), [closed.jobs[0].resume.id])
  assert.deepEqual(workflowWakes(await host.history(worker), 'task'), [closed.jobs[0].wake.id])
  assert.equal(claims, 1)
  console.log('PASS fixed rc.8 to rc.9 to rc.8 stopped swap preserves flags, allowlist, ordinary receipt and the closed native result without replay')
})
