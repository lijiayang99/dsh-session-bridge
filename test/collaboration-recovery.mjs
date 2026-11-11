import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { latestPrompt, tool, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, archive] = process.argv.slice(2)
assert(dsh && archive, 'Usage: node test/collaboration-recovery.mjs <dsh> <candidate.tgz>')

const owner = 'synthetic-recovery-owner'
const worker = 'synthetic-recovery-worker'
const child = 'synthetic-recovery-child'
const titles = {
  [owner]: '合成恢复主控窗口',
  [worker]: '合成恢复执行窗口',
  [child]: '合成恢复接续窗口',
}
const wake = /^DSH-WORKFLOW (TASK|RESULT) ([a-f0-9-]+)$/
const ownerPlans = new Map()
const cases = new Map()
const taskWakes = new Map()
const resultWakes = new Map()
const reportResults = new Map()
const assignment = (item, target) => ({
  item, target, scope: 'work', attempt: 1,
  instructions: 'Execute synthetic item ' + item, acceptance: 'Report synthetic evidence for ' + item,
})
const close = (task) => tool('workflow_close', {
  task, outcome: 'completed', summary: 'All synthetic results were recovered.',
})

async function waitUntil(open, signal) {
  while (!open()) await delay(25, undefined, { signal })
}

async function decide(body, { signal }) {
  const input = latestPrompt(body.messages, (text) => ownerPlans.has(text) || wake.test(text))
  if (!input) return
  const { text, results } = input
  const ownerPlan = ownerPlans.get(text)
  if (ownerPlan) return ownerPlan(results, signal)
  const [, kind, id] = wake.exec(text)
  if (!results.length) {
    const observations = kind === 'TASK' ? taskWakes : resultWakes
    observations.set(id, (observations.get(id) ?? 0) + 1)
    return tool(kind === 'TASK' ? 'workflow_claim' : 'workflow_consume', { id })
  }
  const first = results[0]
  assert(!first?.error && !first?.duplicate, 'Unexpected native result for synthetic ' + kind)
  const test = cases.get(first.task)
  assert(test, 'Tool result did not retain the task key')
  if (kind === 'TASK') {
    const report = tool('workflow_report', {
      id, attempt: first.attempt, token: first.token,
      status: 'completed', summary: 'Synthetic report for ' + first.item,
      evidence: ['synthetic:' + first.item],
    })
    if (results.length === 1) {
      if (first.item !== 'downstream') await waitUntil(() => test.releaseReports, signal)
      return report
    }
    reportResults.set(id, results.slice(1))
    if (test.cancel && results.length === 2) return report
    return
  }
  if (first.item === 'downstream') {
    if (results.length === 1) return close(first.task)
    test.automaticClose = results[1]
    return
  }
  assert(first.batch, 'Expected a single native batch wake')
  assert.equal(first.batch.items.length, 2)
  assert(first.batch.items.every(({ report }) => report?.status === 'completed' && !report.late))
  if (test.dispatch && results.length === 1) {
    await waitUntil(() => test.releaseDispatch, signal)
    return tool('workflow_dispatch', { task: first.task, ...assignment('downstream', child) })
  }
  // The next model response stays open so a restart interrupts this exact
  // continuation after its last confirmed ledger write.
  await waitUntil(() => false, signal)
}

async function runPrompt(host, text, plan) {
  ownerPlans.set(text, plan)
  try { return await host.prompt(owner, text) } finally { ownerPlans.delete(text) }
}

async function authorize(host, test) {
  cases.set(test.task, test)
  const text = '请分派任务：让合成恢复执行窗口处理第一项，让合成恢复接续窗口处理第二项。'
  const proposal = {
    task: test.task,
    goal: 'Validate synthetic restart and recovery boundaries.',
    ttlMinutes: 10, budget: 6,
    scopes: [{ name: 'work', windows: [titles[worker], titles[child]], purpose: 'Produce synthetic recovery reports' }],
  }
  const preview = await runPrompt(host, text, (results) => results.length
    ? { reply: results[0].preview } : tool('workflow_propose', proposal))
  assert.equal(preview.results[0]?.confirmation, 'owner_reply_required', JSON.stringify(preview.results))
  const batch = tool('workflow_dispatch_batch', {
    task: test.task, batch: 'initial', completion: 'Wait until both synthetic workers settle.',
    assignments: [assignment('initial-a', worker), assignment('initial-b', test.cancel ? worker : child)],
  })
  const opened = await runPrompt(host, '确认委托', (results) => [tool('workflow_confirm'), batch][results.length])
  assert.equal(opened.results[0]?.task, test.task, JSON.stringify(opened.results))
  assert.equal(opened.results[1]?.duplicate, false, JSON.stringify(opened.results))
  assert.equal(opened.results[1]?.ids.length, 2)
}

async function hold(host, session, text) {
  let entered = false
  ownerPlans.set(text, async (_results, signal) => {
    entered = true
    await waitUntil(() => false, signal)
  })
  await host.submit(session, text)
  await host.until(() => entered, 'held synthetic model request')
  return () => ownerPlans.delete(text)
}

async function restart(host, ...clearHolds) {
  await host.stop()
  for (const clear of clearHolds) clear()
  await host.start()
}

function anchorOf({ grant, jobs }) {
  return jobs.find(({ id }) => id === grant?.batches?.[0]?.anchor)
}

async function nativeWakeIds(host, session, kind, jobId) {
  return (await host.history(session)).filter(({ type, data }) =>
    type === 'user/message' && data.source?.kind === 'agent-message' &&
    data.source.bridgeWorkflowKind === kind && data.source.bridgeWorkflowId === jobId)
    .map(({ data }) => data.id)
}

async function recoverBatch(host, task, dispatch) {
  const test = { task, dispatch }
  await authorize(host, test)
  await host.until(() => {
    const { jobs } = host.snapshot(owner, task)
    return jobs.length === 2 && jobs.every(({ claim }) => claim)
  }, 'both parallel synthetic assignments claimed')
  const clearOwner = await hold(host, owner, '合成阻塞主控的普通消息 ' + task)
  test.releaseReports = true
  const queued = await host.until(() => {
    const snapshot = host.snapshot(owner, task)
    const anchor = anchorOf(snapshot)
    return snapshot.jobs.every(({ report }) => report?.status === 'completed') &&
      anchor?.resume?.state === 'queued' && { anchor, jobs: snapshot.jobs }
  }, 'both reports and the queued batch result are durable')
  assert.equal(resultWakes.get(queued.anchor.id) ?? 0, 0)
  await restart(host, clearOwner)

  const consumed = await host.until(() => {
    const anchor = anchorOf(host.snapshot(owner, task))
    return anchor?.resume?.continuation?.state === 'started' && anchor
  }, 'the persisted batch automatically resumes and is consumed')
  assert.equal(consumed.id, queued.anchor.id)
  assert.equal(consumed.resume.id, queued.anchor.resume.id)
  assert.equal(consumed.resume.state, 'consumed')
  assert.equal(resultWakes.get(consumed.id), 1)
  for (const job of queued.jobs) assert.equal(taskWakes.get(job.id), 1)

  let downstream
  if (dispatch) {
    const clearChild = await hold(host, child, '合成阻塞下游窗口的普通消息 ' + task)
    test.releaseDispatch = true
    downstream = await host.until(() => {
      const snapshot = host.snapshot(owner, task)
      const job = snapshot.jobs.find(({ item }) => item === 'downstream')
      return job && anchorOf(snapshot)?.resume?.continuation?.dispatches.includes(job.id) && job
    }, 'controller continuation committed its downstream assignment')
    assert.equal(downstream.after, consumed.id)
    assert.equal(downstream.wake.state, 'queued')
    assert.equal(taskWakes.get(downstream.id) ?? 0, 0)
    await restart(host, clearChild)
  } else {
    await restart(host)
  }

  const interrupted = await host.until(() => {
    const anchor = anchorOf(host.snapshot(owner, task))
    return anchor?.resume?.continuation?.state === 'interrupted' && anchor
  }, 'interrupted controller turn is reconciled from durable host evidence')
  assert.equal(interrupted.resume.state, 'consumed')
  assert.equal(interrupted.resume.continuation.phase, dispatch ? 'after_dispatch' : 'before_dispatch')
  assert.deepEqual(interrupted.resume.continuation.dispatches, dispatch ? [downstream.id] : [])
  assert.equal(interrupted.resume.continuation.reconciliation, undefined)

  let blocked
  if (dispatch) {
    blocked = await host.until(() => test.automaticClose,
      'downstream continuation cannot close an unreconciled interrupted batch')
    const recoveredState = host.snapshot(owner, task)
    assert.equal(recoveredState.jobs.length, 3)
    const recovered = recoveredState.jobs.find(({ item }) => item === 'downstream')
    assert.equal(recovered.id, downstream.id)
    assert.equal(recovered.report?.status, 'completed')
    assert.equal(taskWakes.get(downstream.id), 1)
    assert.equal(resultWakes.get(downstream.id), 1)
    assert.deepEqual(await nativeWakeIds(host, child, 'task', downstream.id), [downstream.wake.id])
    assert.deepEqual(await nativeWakeIds(host, owner, 'result', downstream.id), [recovered.resume.id])
  } else {
    const attempted = await runPrompt(host, '继续委托 ' + task, (results) => results.length ? undefined : close(task))
    blocked = attempted.results[0]
  }
  assert.equal(blocked?.error, 'successful_attempts_required', JSON.stringify(blocked))
  const open = host.snapshot(owner, task).grant
  assert.notEqual(open?.state, 'closed')
  assert.equal(open?.outcome, undefined)

  const reason = '合成对账已核对原始报告和已提交下游派工。'
  const reconciliation = await runPrompt(host, '对账委托 ' + task + ' ' + consumed.id + ' result\n' + reason,
    (results) => results.length ? undefined : tool('workflow_status', { task }))
  const reviewed = reconciliation.results[0]?.jobs?.find(({ id }) => id === consumed.id)?.continuation?.continuation
  assert.equal(reviewed?.state, 'interrupted')
  assert.equal(reviewed?.reconciliation?.decision, 'reviewed_without_replay')
  assert.equal(reviewed?.reconciliation?.reason, reason)
  assert.equal(reviewed.reconciliation.previousReason, interrupted.resume.continuation.reason)
  assert.equal(reviewed.reconciliation.owner, owner)
  assert.equal(reviewed.reconciliation.ownerMessageId, reconciliation.input.data.id)
  assert.deepEqual(reviewed.dispatches, dispatch ? [downstream.id] : [])

  if (dispatch) await host.until(() => host.snapshot(owner, task).jobs.find(({ id }) => id === downstream.id)
    ?.resume?.continuation?.state === 'verified', 'the downstream continuation ends normally')
  const finished = await runPrompt(host, '继续委托 ' + task, (results) => results.length ? undefined : close(task))
  assert.equal(finished.results[0]?.state, 'closed', JSON.stringify(finished.results))
  const closed = host.snapshot(owner, task)
  assert.equal(closed.jobs.length, dispatch ? 3 : 2)
  assert.equal(closed.grant.outcome?.status, 'completed')
  const closedAnchor = anchorOf(closed)
  assert.equal(closedAnchor.resume.state, 'consumed')
  const retained = closedAnchor.resume.continuation
  assert.equal(retained.state, 'interrupted')
  assert.equal(retained.reconciliation.decision, 'reviewed_without_replay')
  await host.idle(owner)
  assert.equal(resultWakes.get(consumed.id), 1, 'A consumed batch must never be replayed')
  assert.deepEqual(await nativeWakeIds(host, owner, 'result', consumed.id), [consumed.resume.id])
  console.log('PASS native batch recovery, explicit owner reconciliation before close, and one result across restart ' +
    (dispatch ? 'after a committed downstream dispatch' : 'before downstream dispatch'))
}

async function cancelWithLateReport(host) {
  const task = 'synthetic-late-cancellation'
  const test = { task, cancel: true }
  await authorize(host, test)
  const running = await host.until(() => {
    const { jobs } = host.snapshot(owner, task)
    const first = jobs.find(({ item }) => item === 'initial-a')
    const second = jobs.find(({ item }) => item === 'initial-b')
    return first?.claim && second?.wake.state === 'queued' && { first, second }
  }, 'one shared-window attempt claimed while its sibling remains queued')
  await host.prompt(owner, '取消委托 ' + task)
  const stopped = await host.until(() => {
    const snapshot = host.snapshot(owner, task)
    return snapshot.grant?.state === 'cancelled' && snapshot.jobs.some(({ wake }) => wake.state === 'skipped') && snapshot
  }, 'native owner cancellation stops queued work')
  assert.equal(stopped.jobs.find(({ id }) => id === running.first.id)?.wake.state, 'claimed')
  test.releaseReports = true
  const late = await host.until(() => {
    const results = reportResults.get(running.first.id)
    return results?.length === 2 && results
  }, 'already claimed worker records its late result and exact retry')
  assert.deepEqual(late.map(({ recorded, duplicate, late }) => [recorded, duplicate, late]), [
    [true, false, true], [true, true, true],
  ])
  await host.idle(worker)
  await restart(host)
  const read = await runPrompt(host, '继续委托 ' + task, (results) => results.length ? undefined
    : tool('workflow_dispatch', { task, ...assignment('forbidden-after-cancel', child) }))
  assert.equal(typeof read.results[0]?.error, 'string')
  const persisted = host.snapshot(owner, task)
  assert.equal(persisted.grant.state, 'cancelled')
  assert.equal(persisted.jobs.length, 2)
  assert.equal(persisted.jobs.find(({ id }) => id === running.first.id)?.report?.late, true)
  assert.equal(persisted.jobs.find(({ id }) => id === running.second.id)?.wake.state, 'skipped')
  assert.equal(taskWakes.get(running.first.id), 1)
  assert.equal(taskWakes.get(running.second.id) ?? 0, 0)
  assert(persisted.jobs.every(({ id, resume }) => !resume && !resultWakes.has(id)))
  assert.deepEqual(await nativeWakeIds(host, worker, 'task', running.second.id), [])
  assert.deepEqual(await nativeWakeIds(host, owner, 'result', running.first.id), [])
  console.log('PASS native cancellation skips queued sibling, records late report once and blocks restart or redispatch')
}

await withCollaborationHost({ dsh, archive, decide }, async (host) => {
  await host.createSessions(Object.entries(titles))
  await host.save({ enabled: false, workflowEnabled: true, allowedSessions: [owner, worker, child] })
  await recoverBatch(host, 'synthetic-consume-recovery', false)
  await recoverBatch(host, 'synthetic-dispatch-recovery', true)
  await cancelWithLateReport(host)
})
