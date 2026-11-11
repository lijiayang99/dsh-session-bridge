import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { installSteerRelayFixture, latestPrompt, tool, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, archive, mode = 'all'] = process.argv.slice(2)
assert(dsh && archive && ['all', 'draft', 'confirmation'].includes(mode),
  'Usage: node test/natural-send-time-context.mjs <dsh> <candidate.tgz> [all|draft|confirmation]')
const sender = 'synthetic-clock-sender'
const receiver = 'synthetic-clock-receiver'
const relayer = 'synthetic-clock-relayer'
const titles = [[sender, '合成互传主控窗口'], [receiver, '合成互传审核窗口'], [relayer, '合成互传中继窗口']]
const refreshInterval = 2500
const draftRequest = '请拟一条消息发给合成互传审核窗口'
const confirm = '确认发送'
const body = '合成消息第一行\n  第二行保留两个空格。'
const required = { error: 'message_authorization_required' }
const natural = (input = {}) => tool('send_natural_session_message', input)
const once = (call) => (results) => results.length ? undefined : call
const isSnapshot = ({ type, data }) => type === 'user/message' &&
  data.source?.kind === 'time-context' && data.source.form === 'snapshot'
const plans = new Map()

function decide({ messages }, context) {
  const entry = latestPrompt(messages, (text) => plans.has(text))
  if (entry) return plans.get(entry.text)(entry.results, context)
}

async function prompt(host, session, text, plan) {
  assert(!plans.has(text))
  plans.set(text, plan)
  try { return await host.prompt(session, text) } finally { plans.delete(text) }
}

async function waitForClockRefresh(host) {
  const previous = (await host.history(sender)).findLast(isSnapshot)
  assert(previous, 'The fixed host must have recorded a native time snapshot')
  const wait = previous.time + refreshInterval + 50 - Date.now()
  if (wait > 0) await delay(wait)
}

async function resetClock(host) {
  await waitForClockRefresh(host)
  const reset = await host.prompt(sender, '读取合成宿主时间。')
  const snapshot = reset.records.find(isSnapshot)
  assert(snapshot, 'Expected a fresh native time snapshot before the directed test')
  return snapshot
}

async function showDraft(host, refreshAfterTool) {
  await resetClock(host)
  const result = await prompt(host, sender, draftRequest, async (results, { signal }) => {
    if (results.length) return { reply: results[0].preview ?? '草稿未获准。' }
    if (refreshAfterTool) await delay(refreshInterval + 60, undefined, { signal })
    return natural({ draft: body })
  })
  const prepared = result.results[0]
  assert.equal(prepared?.confirmation, 'owner_reply_required', JSON.stringify(result.results))
  const toolResult = result.records.find(({ type }) => type === 'tool/result')
  const preview = result.records.find(({ type, data }) => type === 'assistant/message' &&
    data.message.content.some(({ type, text }) => type === 'text' && text === prepared.preview))
  assert(preview && preview.seq < result.end.seq, 'The exact preview must be visible before the owner can confirm')
  const clocks = result.records.filter(isSnapshot)
  assert.equal(clocks.length, refreshAfterTool ? 1 : 0)
  if (refreshAfterTool) assert(toolResult.seq < clocks[0].seq && clocks[0].seq < preview.seq)
  return result
}

async function received(host) {
  await host.idle(receiver)
  return (await host.history(receiver)).filter(({ type, data }) => type === 'user/message' &&
    data.source?.kind === 'agent-message' && data.source.senderSessionId === sender)
}

async function verifyConfirmation(host, refreshInConfirmation) {
  const before = (await received(host)).length
  const shown = await showDraft(host, !refreshInConfirmation)
  assert.equal((await received(host)).length, before)
  if (refreshInConfirmation) await waitForClockRefresh(host)
  const result = await prompt(host, sender, confirm, (results) => results.length < 2 ? natural() : undefined)
  const send = result.records.find(({ type }) => type === 'tool/result')
  const clocks = result.records.filter(isSnapshot)
  assert.equal(clocks.length, refreshInConfirmation ? 1 : 0)
  if (refreshInConfirmation) assert(result.input.seq < clocks[0].seq && clocks[0].seq < send.seq)
  const [receipt, duplicate] = result.results
  assert.equal(receipt?.delivery, 'delivered', JSON.stringify(result.results))
  assert.equal(duplicate?.duplicate, true)
  assert.equal(duplicate.messageId, receipt.messageId)
  const messages = await received(host)
  assert.equal(messages.length, before + 1)
  assert.equal(messages.at(-1).data.id, receipt.messageId)
  assert(messages.at(-1).data.content[0].text.endsWith('\n' + body))
  assert(shown.input.seq < result.input.seq)
  console.log('PASS native time snapshot ' + (refreshInConfirmation ? 'before confirmation tool' : 'between draft result and exact preview') +
    ' preserves one exact delivery and its duplicate receipt')
}

async function rejectTimeLookalike(host, relay) {
  const time = await resetClock(host)
  const text = time.data.content[0].text
  const before = (await received(host)).length
  let ready = false
  const release = Promise.withResolvers()
  const draft = prompt(host, sender, draftRequest, async (results) => {
    if (!results.length) return natural({ draft: body })
    assert.equal(results[0]?.confirmation, 'owner_reply_required')
    ready = true
    await release.promise
    return { reply: results[0].preview }
  })
  draft.catch(() => {})
  let inputId
  try {
    await host.until(() => ready, 'draft tool returned before same-text additional input')
    if (relay) {
      const relayed = await prompt(host, relayer, '插入合成中继。', once(tool('collaboration_fixture_steer_relay', { target: sender, text })))
      inputId = relayed.results[0]?.id
      assert(inputId)
    } else {
      inputId = await host.submit(sender, text, 'steer')
    }
  } finally {
    release.resolve()
  }
  const pending = await draft
  const input = pending.records.find(({ type, data }) => type === 'user/message' && data.content[0]?.text === text &&
    (relay ? data.id === inputId && data.source.senderSessionId === relayer : data.source.rpcId === inputId))
  assert.equal(input?.data.source.kind, relay ? 'agent-message' : 'user')
  assert.deepEqual((await prompt(host, sender, confirm, once(natural()))).results, [required])
  assert.equal((await received(host)).length, before)
  console.log('PASS same native time text from ' + (relay ? 'a relay' : 'an owner') + ' clears the draft and delivers nothing')
}

async function verifyDirectOwnerSend(host, structured) {
  await waitForClockRefresh(host)
  const before = (await received(host)).length
  const request = { to: receiver, request_id: 'synthetic-clock-structured', text: body }
  const text = structured ? '授权互传 ' + receiver + ' ' + request.request_id + '\n' + body
    : '给合成互传审核窗口发消息：' + body
  const call = structured ? tool('send_session_message', request) : natural()
  const result = await prompt(host, sender, text, (results) => results.length < 2 ? call : undefined)
  const delivery = result.records.find(({ type }) => type === 'tool/result')
  assert(result.records.some((event) => isSnapshot(event) && event.seq < delivery.seq))
  const [sent, retry] = result.results
  assert.equal(sent?.delivery, 'delivered', JSON.stringify(result.results))
  assert.equal(retry?.duplicate, true)
  assert.equal(retry.messageId, sent.messageId)
  const messages = await received(host)
  assert.equal(messages.length, before + 1)
  assert.equal(messages.at(-1).data.id, sent.messageId)
  assert(messages.at(-1).data.content[0].text.endsWith('\n' + body))
  console.log('PASS ' + (structured ? 'structured' : 'exact-text') + ' direct owner authorization delivers once with a native time snapshot')
}

await withCollaborationHost({ dsh, archive, decide, timeRefreshIntervalMs: refreshInterval }, async (host) => {
  await host.createSessions(titles)
  await host.save({ enabled: true, workflowEnabled: false, allowedSessions: titles.map(([id]) => id) })
  if (mode !== 'confirmation') await verifyConfirmation(host, false)
  if (mode !== 'draft') await verifyConfirmation(host, true)
  if (mode === 'all') {
    await installSteerRelayFixture(host)
    await rejectTimeLookalike(host, false)
    await rejectTimeLookalike(host, true)
    await verifyDirectOwnerSend(host, false)
    await verifyDirectOwnerSend(host, true)
  }
})
