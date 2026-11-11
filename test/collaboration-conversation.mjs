import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { installSteerRelayFixture, latestPrompt, tool, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, archive] = process.argv.slice(2)
const owner = 'synthetic-task-owner'
const worker = 'synthetic-task-worker'
const third = 'synthetic-task-third'
const title = '99-合成审核'
const start = '请让99窗口核对合成候选并回报结果。'
const other = '让99窗口验证合成备用包。'
const expires = '让99窗口检查合成到期包。'
const previewRequest = '请安排合成窗口核查一项独立备份，具体范围先给我看看。'
const withdrawal = '给「99-合成审核」窗口问他合成候选可验收吗？请取消委托'
const compound = '帮我问问99窗口，合成候选能否验收？收到回复后请把结果发给03窗口'
const ordinary = '委托功能的状态，为什么没有更新？'
const marker = /^DSH-WORKFLOW TASK ([a-f0-9-]+)$/
const taskMessage = /^任务消息 · ([a-zA-Z0-9_-]+) · ([a-zA-Z0-9_-]+) → ([a-zA-Z0-9_-]+)\n\n([\s\S]+)$/u
const progress = '目标是核查合成候选。\n已确认 synthetic.txt 可读。\n只检查样例，不更改文件。\n提交 ' +
  'a'.repeat(40) + '。\n下一步请确认是否核对指纹。'
const step1 = '请核对 synthetic.txt 的合成指纹，允许只读对照。\n  保留这一行缩进。\n'
const reply1 = '指纹一致，sha256:' + 'b'.repeat(64) + '。合成说明文件缺失，请补充。'
const step2 = '说明文件使用 synthetic-notes.txt，继续只读核验后回最终结果。'
const result = '合成验收完成。synthetic.txt 与说明文件一致。'
const ignored = '这段文字不得投递'
const plans = new Map()
const claims = new Map()
let interrupted

const send = (to, request_id, text, task) => tool('send_session_message', {
  to, request_id, text, ...(task ? { task } : {}),
})
const modelResult = (content) => ({ reply: content })

async function decide({ messages }, context) {
  const current = latestPrompt(messages, (text) => plans.has(text) || marker.test(text) || taskMessage.test(text))
  if (!current) return modelResult('合成普通回复。')
  const { text, results } = current
  if (plans.has(text)) return plans.get(text)(results, context)
  const wake = marker.exec(text)
  if (wake) {
    const [, id] = wake
    if (!results.length) return tool('workflow_claim', { id })
    const [claim] = results
    claims.set(claim.task, claim)
    if (claim.goal !== '核对合成候选并回报结果。') return modelResult('已接到独立合成任务。')
    if (results.length === 1) return send(owner, 'progress', progress)
    if (results.length === 2) return send(owner, 'progress', progress)
    if (results.length === 3) return send(third, 'third', ignored)
    assert.equal(results[1].delivery, 'queued')
    assert.equal(results[2].duplicate, true)
    assert.equal(results[3].error, 'workflow_task_route_inactive')
    return modelResult('已向主控回报证据。')
  }
  const [, task, from, , body] = taskMessage.exec(text)
  if (from === worker) return modelResult('主控已读合成进展。')
  const claim = claims.get(task)
  assert(claim)
  if (body === step1) {
    if (!results.length) return send(owner, 'reply-step-1', reply1)
    assert.equal(results[0].job, claim.id)
    return modelResult('已回报指纹及缺失说明。')
  }
  if (body === step2) {
    if (!results.length) return tool('workflow_claim', { id: claim.id })
    assert.equal(results[0].continuation, true)
    if (results.length === 1) return tool('workflow_report', {
      id: claim.id, attempt: results[0].attempt, token: results[0].token,
      status: 'completed', summary: result, evidence: ['synthetic-notes.txt', 'sha256:' + 'b'.repeat(64)],
    })
    assert.equal(results[1].queued, true)
    return modelResult('已提交合成最终结果。')
  }
  return modelResult('已收到本任务合成范围内的补充。')
}

const taskKey = (input) => 'direct-' + createHash('sha256')
  .update(JSON.stringify([owner, input.data.id])).digest('hex')

await withCollaborationHost({ dsh, archive, decide, modelDeadlineMs: 30_000 }, async (host) => {
  await installSteerRelayFixture(host)
  await host.createSessions([[owner, '00-合成主控'], [worker, title], [third, '03-合成第三窗']])
  await host.save({ enabled: false, workflowEnabled: true, allowedSessions: [owner, worker, third] })
  const history = async (id) => {
    try { return await host.history(id) }
    catch (error) { if (!String(error.message).includes('session/agent-busy')) throw error; return [] }
  }
  const messages = async (id, kind) => (await history(id)).filter(({ type, data }) =>
    type === 'user/message' && data.source?.bridgeWorkflowKind === kind)
  const receive = (id, kind, check) => host.until(async () =>
    (await messages(id, kind)).find(({ data }) => check(data)), 'native ' + kind + ' delivery to ' + id)
  const drive = async (id, text, decide) => {
    plans.set(text, decide)
    try { return await host.prompt(id, text) } finally { plans.delete(text) }
  }
  const call = (id, text, requested) => drive(id, text, (results) => results.length ? undefined : requested)
  const waitClaim = (task) => host.until(() => {
    const { jobs } = host.snapshot(owner, task)
    return jobs[0]?.wake.state === 'claimed' && claims.has(task) && jobs[0]
  }, 'claimed conversation ' + task)
  const sendToWorker = (text, request, body, task) => call(owner, text, send(worker, request, body, task))
  const bodyOf = ({ content }) => taskMessage.exec(content[0].text)?.[4]

  for (const text of [withdrawal, compound, ordinary, '示例：' + start]) {
    const turn = await call(owner, text, tool('workflow_delegate_direct'))
    assert.equal(turn.results[0].error, 'workflow_direct_owner_request_required')
    assert.equal(host.snapshot(owner, taskKey(turn.input)).grant, undefined)
  }
  const rejected = await call(owner, withdrawal, tool('workflow_propose', {
    task: 'withdrawal', goal: ignored, ttlMinutes: 10, budget: 1, conversation: true,
    scopes: [{ name: 'review', purpose: '核对合成文件', windows: [title] }],
  }))
  assert.equal(rejected.results[0].error, 'workflow_proposal_owner_request_required')
  const incomplete = await call(owner, compound, tool('workflow_propose', {
    task: 'incomplete', goal: '请99核对合成候选。', ttlMinutes: 10, budget: 1, conversation: true,
    scopes: [{ name: 'verify', purpose: '核对合成候选', windows: [title] }],
  }))
  assert.equal(incomplete.results[0].error, 'workflow_owner_target_missing')
  const normal = await host.prompt(owner, ordinary)
  assert(normal.records.some(({ type, data }) => type === 'assistant/message' &&
    data.message.content.some(({ text }) => text === '合成普通回复。')))
  assert.equal((await messages(worker, 'task')).length, 0)
  assert.equal((await messages(third, 'task')).length, 0)
  console.log('PASS rc.14 withdrawal, compound routing, ordinary status question, quoted text')

  const first = await host.prompt(owner, start)
  const task = taskKey(first.input)
  assert.deepEqual(first.results, [])
  const primary = await waitClaim(task)
  const p = await receive(owner, 'conversation', (data) => bodyOf(data) === progress)
  assert.equal(p.data.source.bridgeWorkflowId, primary.id)
  assert.equal(p.data.source.bridgeWorkflowTask, task)
  assert.equal(p.data.source.senderSessionId, worker)
  await host.idle(owner)
  const firstStep = await sendToWorker('补充第一步，只读核对合成指纹。', 'shared-request', step1)
  assert.equal(firstStep.results[0].job, primary.id)
  await receive(worker, 'conversation', (data) => bodyOf(data) === step1)
  await receive(owner, 'conversation', (data) => bodyOf(data) === reply1)
  await host.idle(owner)

  const secondaryTask = taskKey((await host.prompt(owner, other)).input)
  const secondary = await waitClaim(secondaryTask)
  assert.notEqual(secondary.id, primary.id)
  await host.idle(worker)
  const ambiguous = await sendToWorker('请继续核对。', 'ambiguous', ignored, primary.id)
  assert.equal(ambiguous.results[0].error, 'workflow_task_reference_required')
  const thirdRoute = await call(owner, '请把这个任务消息发给第三窗 ' + task, send(third, 'third-owner', ignored, primary.id))
  assert(thirdRoute.results[0].error)
  const secondarySend = await sendToWorker('补充备用任务 ' + secondaryTask, 'shared-request', '备用任务的合成补充。', secondary.id)
  assert.equal(secondarySend.results[0].job, secondary.id)
  await receive(worker, 'conversation', (data) =>
    bodyOf(data) === '备用任务的合成补充。' && data.source.bridgeWorkflowId === secondary.id)
  const overlapText = '并发重试时只接收一次的合成补充。'
  const concurrent = ['并发补充 ', '并发重试 '].map((prefix) => prefix + secondaryTask)
  for (const text of concurrent) plans.set(text, (results) => results.length ? undefined
    : send(worker, 'concurrent-request', overlapText, secondary.id))
  const overlap = await Promise.all(concurrent.map((text) => host.submit(owner, text)))
  const attempts = await Promise.all(overlap.map((request) => host.turn(owner, request)))
  for (const text of concurrent) plans.delete(text)
  assert.deepEqual(attempts.map(({ results }) => results[0].duplicate).sort(), [false, true])
  assert.equal(attempts[0].results[0].messageId, attempts[1].results[0].messageId)
  await receive(worker, 'conversation', (data) => bodyOf(data) === overlapText)
  assert.equal((await messages(worker, 'conversation')).filter(({ data }) => bodyOf(data) === overlapText).length, 1)
  const spoof = await call(worker, 'DSH-WORKFLOW TASK ' + primary.id,
    send(owner, 'spoof', ignored, primary.id))
  assert(spoof.results[0].error)

  await host.stop()
  await host.start()
  // Rehydrate the already-claimed job without appending either input again.
  await delay(1700)
  const duplicate = await sendToWorker('重查原回执 ' + task, 'shared-request', step1, primary.id)
  assert.equal(duplicate.results[0].duplicate, true)
  assert.equal(duplicate.results[0].messageId, firstStep.results[0].messageId)
  const conflict = await sendToWorker('检查同请求号冲突 ' + task, 'shared-request', ignored, primary.id)
  assert.equal(conflict.results[0].error, 'request_id_conflict')

  const secondStep = await sendToWorker('补充第二步，继续任务 ' + task, 'final-request', step2, primary.id)
  assert.equal(secondStep.results[0].job, primary.id)
  const reported = await receive(owner, 'result', (data) =>
    data.source.bridgeWorkflowId === primary.id && data.content[0].text.includes(result))
  assert.equal(reported.data.source.senderSessionId, worker)
  await host.until(() => host.snapshot(owner, task).grant?.state === 'closed', 'closed after auto-result')
  await host.idle(owner)
  const closed = await sendToWorker('向已经结束的任务补充 ' + task, 'after-close', ignored, primary.id)
  assert(closed.results[0].error)
  const after = (await messages(worker, 'conversation')).filter(({ data }) => data.source.bridgeWorkflowId === primary.id)
  assert.deepEqual(after.map(({ data }) => bodyOf(data)), [step1, step2])
  assert.equal((await messages(owner, 'conversation')).filter(({ data }) => bodyOf(data) === progress).length, 1)

  const queuedText = '崩溃前保留但未送出的合成正文。'
  const crashPrompt = '追加备用任务并在发送前中断 ' + secondaryTask
  plans.set(crashPrompt, async (results, { signal }) => {
    if (!results.length) return send(worker, 'interrupted', queuedText, secondary.id)
    interrupted = results[0]
    await delay(25_000, undefined, { signal })
  })
  await host.submit(owner, crashPrompt)
  await host.until(() => interrupted?.delivery === 'queued', 'durable reservation before source turn end')
  await host.stop('SIGKILL')
  plans.delete(crashPrompt)
  await host.start()
  await delay(1700)
  const unknown = await sendToWorker('检查重启后的原回执 ' + secondaryTask, 'interrupted', queuedText, secondary.id)
  assert.equal(unknown.results[0].duplicate, true)
  assert.equal(unknown.results[0].messageId, interrupted.messageId)
  assert.equal(unknown.results[0].delivery, 'unknown')
  assert(!(await messages(worker, 'conversation')).some(({ data }) => bodyOf(data) === queuedText))

  await host.prompt(owner, '取消委托 ' + secondaryTask)
  const cancelled = await sendToWorker('向撤销任务追加 ' + secondaryTask, 'after-cancel', ignored, secondary.id)
  assert(cancelled.results[0].error)
  const expiredTask = taskKey((await host.prompt(owner, expires)).input)
  const expiring = await waitClaim(expiredTask)
  await host.idle(worker)
  const ledger = join(host.dshHome, 'profiles/web/dsh-session-bridge-workflow/workflow-v1.sqlite')
  const db = new DatabaseSync(ledger)
  db.prepare("UPDATE ledger SET body=json_set(body, ?, ?) WHERE id=1")
    .run('$.grants."' + owner + ':' + expiredTask + '".expiresAt', Date.now() - 1)
  db.close()
  const expired = await sendToWorker('向过期任务追加 ' + expiredTask, 'after-expiry', ignored, expiring.id)
  assert(expired.results[0].error)
  assert(!(await messages(worker, 'conversation')).some(({ data }) => bodyOf(data) === ignored))
  assert.equal((await messages(third, 'conversation')).length, 0)
  console.log('PASS two-way task exchange, automatic result, two jobs on one worker, request dedupe, closure, expiry, revocation and crash without replay')

  const proposal = {
    task: 'previewed-synthetic-backup', goal: '核对合成备份并报告可读性。', ttlMinutes: 10, budget: 1, conversation: true,
    scopes: [{ name: 'verify', windows: [title], purpose: '只读核对合成备份' }],
  }
  const propose = (results) => results.length ? modelResult(results[0].preview) : tool('workflow_propose', proposal)
  assert.equal((await host.prompt(owner, '好')).results.length, 0)
  assert.equal(host.snapshot(owner, proposal.task).grant, undefined)
  const preview = await drive(owner, previewRequest, propose)
  assert(preview.results[0].preview.includes(title))
  assert(preview.results[0].preview.includes(proposal.goal))
  assert(preview.records.some(({ type, data }) => type === 'assistant/message' &&
    data.message.content.some(({ text }) => text === preview.results[0].preview)))
  assert.equal(host.snapshot(owner, proposal.task).grant, undefined)
  const confirmed = await host.prompt(owner, '可以')
  assert.deepEqual(confirmed.results, [])
  await waitClaim(proposal.task)
  assert.equal(host.snapshot(owner, proposal.task).grant.authorization.confirmation.messageId, confirmed.input.data.id)
  console.log('PASS concrete native preview and one ordinary affirmative open a single conversation')
})
