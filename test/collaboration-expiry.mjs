import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { latestPrompt, tool, withCollaborationHost } from './collaboration-host.mjs'

const args = process.argv.slice(2)
assert.equal(args.length, 2, 'Usage: node test/collaboration-expiry.mjs <dsh> <0.5.0 candidate.tgz>')
const [dsh, archive] = args.map((path) => resolve(path))
const controller = 'synth-expiry-controller'
const draftOwner = 'synth-expiry-draft-owner'
const busyWorker = 'synth-expiry-busy-worker'
const reportWorker = 'synth-expiry-report-worker'
const sessions = {
  [controller]: '合成到期主控窗口',
  [draftOwner]: '合成草稿主控窗口',
  [busyWorker]: '合成占用执行窗口',
  [reportWorker]: '合成回报执行窗口',
}
const plans = new Map()
const wake = /^DSH-WORKFLOW (TASK|RESULT) ([a-f0-9-]{36})$/
const draftTask = 'synthetic-expired-draft'
const ttlTask = 'synthetic-short-grant'
const modelWait = 80_000

async function decide(body, context) {
  const prompt = latestPrompt(body.messages, (text) => plans.has(text) || wake.test(text))
  if (!prompt) return
  const { text, results } = prompt
  if (plans.has(text)) return plans.get(text)(results, context)
  const [, kind, id] = wake.exec(text)
  if (kind === 'RESULT') {
    if (!results.length) return tool('workflow_consume', { id })
    return
  }
  if (!results.length) return tool('workflow_claim', { id })
  if (results.length !== 1 || results[0].error) return
  const { attempt, token } = results[0]
  return tool('workflow_report', {
    id, attempt, token, status: 'completed', summary: 'Synthetic expiry report', evidence: ['synthetic:expiry'],
  })
}

async function drive(host, id, text, plan, limit) {
  assert(!plans.has(text))
  plans.set(text, plan)
  try {
    return await host.turn(id, await host.submit(id, text), limit)
  } finally {
    plans.delete(text)
  }
}

async function propose(host, owner, task, targets) {
  const text = '请分派这项任务：完成合成到期测试。'
  const result = await drive(host, owner, text, (results) => {
    if (!results.length) return tool('workflow_propose', {
      task, goal: 'Produce evidence for synthetic expiry', ttlMinutes: 1, budget: 2,
      scopes: [{ name: 'verify', windows: targets.map((id) => sessions[id]), purpose: 'Verify expiry evidence' }],
    })
    assert.equal(results[0].confirmation, 'owner_reply_required', JSON.stringify(results[0]))
    return { reply: results[0].preview }
  })
  const preview = result.results[0].preview
  assert.equal(result.end.data.reason.kind, 'completed')
  assert(result.records.some(({ type, data }) => type === 'assistant/message' &&
    data.message.content.some(({ type, text }) => type === 'text' && text === preview)))
  assert.equal(host.snapshot(owner, task).grant, undefined)
  return performance.now()
}

const assignment = (item, target) => ({
  task: ttlTask, item, attempt: 1, target, scope: 'verify',
  instructions: 'Prepare synthetic expiry evidence.', acceptance: 'Return the synthetic report.',
})

await withCollaborationHost({ dsh, archive, decide, modelDeadlineMs: modelWait + 5000 }, async (host) => {
  await host.createSessions(Object.entries(sessions))
  await host.save({ enabled: false, workflowEnabled: true, allowedSessions: Object.keys(sessions) })
  const draftDisplayedAt = await propose(host, draftOwner, draftTask, [reportWorker])

  let workerHolding = false
  let release = false
  const waitUntilReleased = async ({ signal }) => {
    while (!release) await delay(50, undefined, { signal })
  }
  const heldWorker = drive(host, busyWorker, '保持合成窗口占用。', async (_results, context) => {
    workerHolding = true
    await waitUntilReleased(context)
  }, modelWait)
  heldWorker.catch(() => {})
  let heldController
  let queuedJob
  let reportedJob
  try {
    await host.until(() => workerHolding, 'native worker busy before dispatch')
    await propose(host, controller, ttlTask, [busyWorker, reportWorker])
    heldController = drive(host, controller, '确认委托', async (results, context) => {
      if (!results.length) return tool('workflow_confirm')
      assert.equal(results[0].task, ttlTask)
      if (results.length === 1) return tool('workflow_dispatch', assignment('queued', busyWorker))
      assert.equal(results[1].duplicate, false)
      if (results.length === 2) return tool('workflow_dispatch', assignment('reported', reportWorker))
      assert.equal(results[2].duplicate, false)
      await waitUntilReleased(context)
    }, modelWait)
    heldController.catch(() => {})

    const before = await host.until(() => {
      const value = host.snapshot(controller, ttlTask)
      const queued = value.jobs.find(({ item }) => item === 'queued')
      const reported = value.jobs.find(({ item }) => item === 'reported')
      return queued?.wake.state === 'queued' && reported?.resume?.state === 'queued' && value
    }, 'native queued work and result held on two busy lanes')
    assert.equal(before.grant.expiresAt - before.grant.openedAt, 60_000)
    assert.equal(before.grant.state, 'collaboration_active')
    const after = await host.until(() => {
      const value = host.snapshot(controller, ttlTask)
      return value.grant?.state === 'expired' && value
    }, 'native one-minute grant expiry', 70_000)
    assert(Date.now() >= before.grant.expiresAt)
    queuedJob = after.jobs.find(({ item }) => item === 'queued')
    reportedJob = after.jobs.find(({ item }) => item === 'reported')
    for (const delivery of [queuedJob.wake, reportedJob.resume]) {
      assert.equal(delivery.state, 'skipped')
      assert.equal(delivery.reason, 'expired')
      assert.equal(delivery.stoppedFrom, 'queued')
    }
    assert.equal(queuedJob.claim, undefined)
    assert.equal(reportedJob.resume.continuation, undefined)
  } finally {
    release = true
    const [worker, owner] = await Promise.all([heldWorker, heldController])
    assert.equal(worker.end.data.reason.kind, 'completed')
    if (owner) assert.equal(owner.end.data.reason.kind, 'completed')
  }

  await host.idle(busyWorker)
  await host.idle(controller)
  await delay(1700)
  assert(!(await host.history(busyWorker)).some(({ data }) => data?.source?.bridgeWorkflowId === queuedJob.id))
  assert(!(await host.history(controller)).some(({ data }) => data?.source?.bridgeWorkflowId === reportedJob.id))
  assert.equal(host.snapshot(controller, ttlTask).grant.state, 'expired')
  console.log('PASS real one-minute native grant expiry prevents queued assignment and result continuation while delegation stays enabled')

  const remaining = 120_100 - (performance.now() - draftDisplayedAt)
  if (remaining > 0) await delay(remaining)
  const expired = await drive(host, draftOwner, '确认委托', (results) => results.length === 0 ? tool('workflow_confirm') : undefined)
  assert.deepEqual(expired.results, [{ error: 'workflow_confirmation_required' }])
  assert.equal(host.snapshot(draftOwner, draftTask).grant, undefined)
  assert.deepEqual(host.snapshot(draftOwner, draftTask).jobs, [])
  console.log('PASS real two-minute native preview expiry rejects owner confirmation without creating a grant')
})
