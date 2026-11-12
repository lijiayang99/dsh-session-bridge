import assert from 'node:assert/strict'
import { latestPrompt, tool, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, archive] = process.argv.slice(2)
const owner = 'synthetic-shared-task-owner'
const alpha = 'synthetic-shared-task-alpha'
const beta = 'synthetic-shared-task-beta'
const alphaTitle = '合成甲审'
const betaTitle = '合成乙审'
const task = 'synthetic-shared-work'
const goal = '合成样本并行复核'
const proposal = '请把合成样本分别交给「合成甲审」和「合成乙审」核对。'
const confirm = '确认委托'
const resume = '继续委托 ' + task
const supplement = '请乙审补核合成文件的时间。'
const marker = /^DSH-WORKFLOW TASK ([a-f0-9-]+)$/
const claims = new Set()

const scope = 'verify'
const assignment = (target) => ({
  task, item: target, target, scope, attempt: 1,
  instructions: '核对合成样本。', acceptance: '提交合成核对结果。',
})

function decide({ messages }) {
  const p = latestPrompt(messages, (text) => marker.test(text) || [proposal, confirm, resume].includes(text))
  if (!p) return { reply: '' }
  if (marker.test(p.text)) {
    const [, id] = marker.exec(p.text)
    if (!p.results.length) return tool('workflow_claim', { id })
    assert.equal(p.results[0].duplicate, false)
    claims.add(id)
    return { reply: '' }
  }
  if (p.text === proposal) {
    if (!p.results.length) return tool('workflow_propose', {
      task, goal, ttlMinutes: 15, budget: 2, conversation: true,
      scopes: [{ name: scope, purpose: goal, windows: [alphaTitle, betaTitle] }],
    })
    assert(p.results[0].preview)
    return { reply: p.results[0].preview }
  }
  if (p.text === confirm) {
    if (!p.results.length) return tool('workflow_confirm')
    if (p.results.length === 1) return tool('workflow_dispatch', assignment(alpha))
    if (p.results.length === 2) return tool('workflow_dispatch', assignment(beta))
    return { reply: '' }
  }
  if (!p.results.length) return tool('workflow_message', {
    target: beta, text: supplement,
  })
  return { reply: '' }
}

await withCollaborationHost({ dsh, archive, decide }, async (host) => {
  await host.createSessions([[owner, '合成主控'], [alpha, alphaTitle], [beta, betaTitle]])
  await host.save({ enabled: true })
  await host.prompt(owner, proposal)
  await host.prompt(owner, confirm)
  await host.until(() => claims.size === 2, 'both approved workers claimed the same task')
  await host.idle(owner)
  await host.idle(alpha)
  await host.idle(beta)
  const sent = await host.prompt(owner, resume)
  assert.equal(sent.results[0].delivery, 'queued', JSON.stringify(sent.results[0]))
  assert.equal(sent.results[0].task, task)
  const received = async (id) => (await host.history(id)).filter(({ type, data }) =>
    type === 'user/message' && data.source?.bridgeWorkflowKind === 'conversation' &&
    data.content[0].text.endsWith(supplement))
  await host.until(async () => {
    try { return (await received(beta))[0] }
    catch (error) { if (!String(error.message).includes('session/agent-busy')) throw error }
  }, 'host sends the instruction to the chosen approved participant of the same task')
  assert.equal((await received(alpha)).length, 0)
  console.log('PASS already bound main can choose either authorized participant of the same task without another owner selection')
})
