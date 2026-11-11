import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { latestPrompt, tool, withCollaborationHost } from './collaboration-host.mjs'

const args = process.argv.slice(2)
assert.equal(args.length, 3, 'Usage: node test/collaboration-rollback.mjs <dsh> <0.4.5-rc.2.tgz> <0.5.0 candidate.tgz>')
const [dsh, stable, archive] = args.map((path) => resolve(path))
const stableHash = 'fb5de752634093c23be783fdf507b86e23ca362250ea787756de09f1e6ff6a91'
assert.equal(createHash('sha256').update(await readFile(stable)).digest('hex'), stableHash)
const packageVersion = (path) => JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'],
  { encoding: 'utf8' })).version
assert.equal(packageVersion(stable), '0.4.5-rc.2')
const candidateVersion = packageVersion(archive)
assert.match(candidateVersion, /^0\.5\.0-rc\.[1-9]\d*$/)

const name = '@local/dsh-session-bridge'
const namespace = 'dsh-session-bridge-settings'
const main = 'synth-rollback-main'
const closeOwner = 'synth-rollback-close-owner'
const worker = 'synth-rollback-worker'
const pausedWorker = 'synth-rollback-wait-worker'
const titles = {
  [main]: '合成回退主控窗口',
  [closeOwner]: '合成回退收口主控窗口',
  [worker]: '合成回退执行窗口',
  [pausedWorker]: '合成回退待决窗口',
}
const allowlist = Object.keys(titles)
const oldTask = 'legacy-history'
const restoredTask = 'legacy-after-rollback'
const closedTask = 'closed-collaboration'
const activeTask = 'active-collaboration'
const pausedTask = 'paused-collaboration'
const closingTask = 'closing-collaboration'
const off = { enabled: false, workflowEnabled: false }
const on = { enabled: true, workflowEnabled: true }
const plans = new Map()
const wake = /^DSH-WORKFLOW (TASK|RESULT) ([a-f0-9-]{36})$/
const artifact = 'sha256:' + createHash('sha256').update('synthetic rollback artifact\n').digest('hex')

async function decide(body, context) {
  const current = latestPrompt(body.messages, (text) => plans.has(text) || wake.test(text))
  if (!current) return
  const { text, results } = current
  if (plans.has(text)) return plans.get(text)(results, context)
  const [, kind, id] = wake.exec(text)
  if (kind === 'TASK') {
    if (!results.length) return tool('workflow_claim', { id })
    if (results.length !== 1 || results[0].error) return
    const { attempt, token, task } = results[0]
    const status = task === pausedTask ? 'needs_owner' : 'completed'
    const evidence = task === closedTask ? [artifact] : ['synthetic:' + task]
    return tool('workflow_report', {
      id, attempt, token, status, summary: 'Synthetic report for ' + task, evidence,
      ...(task === closedTask ? { artifacts: [artifact] } : {}),
    })
  }
  if (!results.length) return tool('workflow_consume', { id })
  if (results[0]?.task === closingTask && results[1]?.state === 'closing') {
    await delay(80_000, undefined, { signal: context.signal })
  }
  if (results.length !== 1 || results[0].error || results[0].duplicate) return
  const { task } = results[0]
  if (task === oldTask || task === restoredTask) return tool('workflow_close', { task })
  if (task === closedTask) return tool('workflow_close', {
    task, outcome: 'completed', summary: 'Synthetic completion before rollback', finalArtifacts: [artifact],
  })
  if (task === closingTask) return tool('workflow_close', {
    task, outcome: 'completed', summary: 'Synthetic close request held before rollback',
  })
}

async function drive(host, session, text, plan) {
  assert(!plans.has(text))
  plans.set(text, plan)
  try {
    return await host.prompt(session, text)
  } finally {
    plans.delete(text)
  }
}

async function call(host, text, name, args, controller = main) {
  const result = await drive(host, controller, text, (results) => results.length === 0 ? tool(name, args) : undefined)
  assert.equal(result.end.data.reason.kind, 'completed')
  assert.equal(result.results.length, 1)
  return result.results[0]
}

const status = (host, task, controller) => call(host, '读取合成任务 ' + task, 'workflow_status', { task }, controller)
const readReceipt = (host, requestId) => call(host, '读取合成回执 ' + requestId,
  'session_message_status', { request_id: requestId })
const assignment = (task, target = worker, attempt = 1) => ({
  task, item: 'synthetic-item', attempt, target, scope: 'review',
  instructions: 'Produce the synthetic rollback evidence.', acceptance: 'Report the synthetic result.',
})
const legacyGrant = (task) => '授权委托\n' + JSON.stringify({
  task, ttlMinutes: 20, goal: 'Synthetic legacy rollback workflow',
  scopes: [{ name: 'review', targets: [worker] }],
})

async function receipt(host, label) {
  const requestId = label + '-receipt'
  const text = 'Synthetic ordinary delivery for ' + label
  const input = { to: worker, request_id: requestId, text }
  const command = '授权互传 ' + worker + ' ' + requestId + '\n' + text
  const sent = await call(host, command, 'send_session_message', input)
  assert.equal(sent.delivery, 'delivered')
  return host.until(async () => {
    const current = await readReceipt(host, requestId)
    return current.processing === 'processed' && current
  }, 'durable synthetic ordinary receipt')
}

async function waitArchived(host, task) {
  const path = join(host.dshHome, 'profiles/web/dsh-session-bridge-workflow/workflow-v1.sqlite')
  return host.until(() => {
    const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 })
    try {
      const key = main + ':' + task
      const grant = db.prepare('SELECT body FROM grant_history WHERE key=?').get(key)
      const job = db.prepare('SELECT body FROM job_history WHERE task_key=?').get(key)
      if (!grant || !job || JSON.parse(job.body).resume?.continuation?.state !== 'verified') return
      return host.snapshot(main, task)
    } finally {
      db.close()
    }
  }, 'native archived grant and verified continuation')
}

async function requireOff(host, version) {
  const { namespaces } = await host.rpc('settings/describe')
  const entry = namespaces.find(({ ns }) => ns === namespace)
  assert.deepEqual(entry?.value, { ...off, allowedSessions: allowlist })
  const bundles = await host.rpc('pluginManager/listBundles')
  const row = bundles.find((bundle) => bundle.name === name)
  assert.equal(row?.version, version)
  assert.equal(row?.enabled, true)
}

async function replaceStopped(host, bundle, version, label) {
  assert.equal((await host.rpc('pluginManager/setBundleEnabled', { name, enabled: false })).application, 'applied')
  await host.stop()
  const profile = join(host.dshHome, 'profiles/web')
  const backup = join(host.lab, 'synthetic-backup-' + label)
  await mkdir(backup, { mode: 0o700 })
  for (const [source, target] of [
    [join(profile, 'cordis.patch.yml'), 'cordis.patch.yml'],
    [join(host.dshHome, 'dsh-session-bridge/receipts'), 'receipts'],
    [join(profile, 'dsh-session-bridge-workflow'), 'workflow'],
  ]) await cp(source, join(backup, target), { recursive: true, errorOnExist: true })

  await host.start()
  assert.equal((await host.rpc('pluginManager/removeBundle', { name })).application, 'applied')
  assert.equal((await host.install(bundle, name)).version, version)
  await host.stop()
  await host.start()
  await requireOff(host, version)
}

async function propose(host, task, target, controller = main) {
  const text = '请分派这项任务：核对合成换包证据和原有回执。'
  const result = await drive(host, controller, text, (results) => {
    if (!results.length) return tool('workflow_propose', {
      task, goal: 'Verify synthetic replacement evidence', ttlMinutes: 20, budget: 2,
      scopes: [{ name: 'review', windows: [titles[target]], purpose: 'Collect synthetic rollback evidence' }],
    })
    assert.equal(results[0].confirmation, 'owner_reply_required', JSON.stringify(results[0]))
    return { reply: results[0].preview }
  })
  assert.equal(result.end.data.reason.kind, 'completed')
  assert(!host.snapshot(controller, task).grant, 'Preview must not create a grant')
}

async function confirm(host, task, target, afterDispatch, controller = main) {
  const result = await drive(host, controller, '确认委托', async (results, context) => {
    if (!results.length) return tool('workflow_confirm')
    if (results.length === 1) {
      assert.equal(results[0].task, task, JSON.stringify(results[0]))
      return tool('workflow_dispatch', assignment(task, target))
    }
    assert.equal(results[1].duplicate, false, JSON.stringify(results[1]))
    if (afterDispatch) await afterDispatch(context)
  })
  assert.equal(result.end.data.reason.kind, 'completed')
  assert.equal(result.results.length, 2)
  return result.results[1].id
}

async function run(host) {
  await host.createSessions(Object.entries(titles))
  await host.save({ ...on, allowedSessions: allowlist })
  const oldReceipt = await receipt(host, 'baseline')
  const oldJob = await call(host, legacyGrant(oldTask), 'workflow_dispatch', assignment(oldTask))
  assert.equal(oldJob.duplicate, false)
  const oldHistory = await waitArchived(host, oldTask)
  assert.equal(oldHistory.grant.state, 'closed')
  assert.equal(oldHistory.jobs[0].id, oldJob.id)
  assert.equal(oldHistory.jobs[0].report.reporter, worker)

  await host.save(off)
  await requireOff(host, '0.4.5-rc.2')
  await replaceStopped(host, archive, candidateVersion, 'upgrade')
  assert.deepEqual(await readReceipt(host, oldReceipt.requestId), oldReceipt)
  assert.deepEqual(host.snapshot(main, oldTask), oldHistory)
  assert.equal((await status(host, oldTask)).jobs[0].report.reporter, worker)
  console.log('PASS exact 0.4.5-rc.2 upgrade with stopped backup preserves legacy grant, workflow attempt, ordinary receipt and allowlist')

  await host.save(on)
  const newReceipt = await receipt(host, 'candidate')
  await propose(host, closedTask, worker)
  const closedId = await confirm(host, closedTask, worker)
  const newHistory = await waitArchived(host, closedTask)
  assert.equal(newHistory.grant.authorization.kind, 'native-owner-workflow-confirmation')
  assert.deepEqual(newHistory.grant.outcome.finalArtifacts, [artifact])
  assert.equal(newHistory.jobs[0].id, closedId)

  await propose(host, closingTask, worker, closeOwner)
  const closingId = await confirm(host, closingTask, worker, undefined, closeOwner)
  const closingGrant = await host.until(() => {
    const { grant } = host.snapshot(closeOwner, closingTask)
    return grant?.closure?.state === 'pending' && grant
  }, 'a controller has requested close but has not ended its result turn')
  assert.equal(closingGrant.state, 'collaboration_closing')
  assert.equal(closingGrant.outcome, undefined)

  let workerHolding = false
  let releaseWorker = false
  let releaseOwner = false
  const heldWorker = drive(host, worker, '保持合成执行窗口占用。', async (_results, { signal }) => {
    workerHolding = true
    while (!releaseWorker) await delay(30, undefined, { signal })
  })
  heldWorker.catch(() => {})
  let heldOwner
  let activeId
  let pausedId
  try {
    await host.until(() => workerHolding, 'synthetic worker held before dispatch')
    await propose(host, activeTask, worker)
    activeId = await confirm(host, activeTask, worker)
    await propose(host, pausedTask, pausedWorker)
    heldOwner = confirm(host, pausedTask, pausedWorker, async ({ signal }) => {
      while (!releaseOwner) await delay(30, undefined, { signal })
    })
    heldOwner.catch(() => {})
    pausedId = await host.until(() => {
      const { grant, jobs } = host.snapshot(main, pausedTask)
      return grant?.state === 'collaboration_paused' && jobs[0]?.resume?.state === 'queued' && jobs[0].id
    }, 'paused collaboration has queued result while the controller is held')
    assert.equal(host.snapshot(main, activeTask).jobs[0].wake.state, 'queued')
    await host.save(off)
  } finally {
    releaseWorker = true
    releaseOwner = true
    await Promise.all([heldWorker, heldOwner])
  }
  await host.idle(main)
  await host.idle(worker)
  await host.idle(pausedWorker)
  const activeHistory = host.snapshot(main, activeTask)
  const pausedHistory = host.snapshot(main, pausedTask)
  assert.equal(activeHistory.grant.state, 'collaboration_active')
  assert.equal(activeHistory.jobs[0].wake.state, 'queued')
  assert.equal(pausedHistory.grant.state, 'collaboration_paused')
  assert.equal(pausedHistory.jobs[0].resume.state, 'queued')

  await requireOff(host, candidateVersion)
  await replaceStopped(host, stable, '0.4.5-rc.2', 'rollback')
  assert.deepEqual(await readReceipt(host, oldReceipt.requestId), oldReceipt)
  assert.deepEqual(await readReceipt(host, newReceipt.requestId), newReceipt)
  assert.deepEqual(host.snapshot(main, oldTask), oldHistory)
  assert.deepEqual(host.snapshot(main, closedTask), newHistory)
  const closed = await status(host, closedTask)
  assert.equal(closed.state, 'closed')
  assert.deepEqual(closed.outcome.finalArtifacts, [artifact])
  assert.deepEqual(closed.jobs[0].report.artifacts, [artifact])
  assert.deepEqual(host.snapshot(closeOwner, closingTask).grant, closingGrant)
  console.log('PASS exact rollback preserves archived collaboration approval, artifact, attempt and both ordinary receipts')

  // Disposable negative control. Even after the old operator reopens switches,
  // the old runner cannot dispatch or wake these newer grant states.
  await host.save(on)
  for (const [task, expected] of [[activeTask, activeHistory], [pausedTask, pausedHistory]]) {
    const target = expected.jobs[0].target
    assert.equal((await status(host, task)).state, expected.grant.state)
    const dispatch = await call(host, '继续委托 ' + task, 'workflow_dispatch', assignment(task, target, 2))
    assert.deepEqual(dispatch, { error: 'main_task_context_required' })
  }
  const closing = await status(host, closingTask, closeOwner)
  assert.equal(closing.state, 'collaboration_closing')
  assert.equal(closing.outcome, undefined)
  assert.deepEqual(await call(host, '继续委托 ' + closingTask, 'workflow_dispatch',
    assignment(closingTask, worker, 2), closeOwner), { error: 'main_task_context_required' })
  assert.deepEqual(await call(host, legacyGrant(closedTask), 'workflow_dispatch', assignment(closedTask)),
    { error: 'grant_not_opened' })
  const resumedLegacy = await call(host, legacyGrant(restoredTask), 'workflow_dispatch', assignment(restoredTask))
  assert.equal(resumedLegacy.duplicate, false)
  const restored = await waitArchived(host, restoredTask)
  assert.equal(restored.grant.state, 'closed')
  assert.equal(restored.jobs[0].report.reporter, worker)
  await delay(1700)
  const workerWakes = await host.history(worker)
  const mainWakes = await host.history(main)
  assert(!workerWakes.some(({ data }) => data?.source?.bridgeWorkflowId === activeId))
  assert(!mainWakes.some(({ data }) => data?.source?.bridgeWorkflowId === pausedId))
  assert.deepEqual(host.snapshot(main, activeTask), activeHistory)
  assert.deepEqual(host.snapshot(main, pausedTask), pausedHistory)
  assert.deepEqual(host.snapshot(closeOwner, closingTask).grant, closingGrant)
  const closeWakes = (await host.history(closeOwner)).filter(({ data }) =>
    data?.source?.bridgeWorkflowKind === 'result' && data.source.bridgeWorkflowId === closingId)
  assert.equal(closeWakes.length, 1)
  await host.save(off)
  await requireOff(host, '0.4.5-rc.2')
  console.log('PASS old runner rejects active, paused and closing collaboration and leaves queued task/result untouched')
}

await withCollaborationHost({ dsh, archive, bootstrap: stable, decide }, run)
