import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { latestPrompt, parts, tool, withCollaborationHost } from './collaboration-host.mjs'

const [dsh, archive, modelName = 'gpt-6.1-sol'] = process.argv.slice(2)
assert(dsh && archive && /^[a-z0-9.-]+$/.test(modelName),
  'Usage: node test/collaboration-pilot.mjs <dsh> <candidate.tgz> [codex-model]')

const windows = [
  ['pilot-main', '试验主控窗口'], ['pilot-developer', '试验开发窗口'],
  ['pilot-verifier', '试验核查窗口'], ['pilot-reviewer', '试验审核窗口'],
]
const [main, developer, verifier, reviewer] = windows.map(([id]) => id)
const task = 'synthetic-pilot'
const requestIds = new Set()
const toolCounts = {}
const timings = []
let initialized = 0

function digest(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex')
}

function diagnostic(code, signal, stderr) {
  if (/429|rate.limit|capacity|overloaded/i.test(stderr)) return 'provider rate limit or capacity'
  if (/401|403|unauthorized|authentication required|login required/i.test(stderr)) return 'provider authentication or access'
  if (/timed out|connection refused|failed to connect|network|could not resolve/i.test(stderr)) return 'provider connectivity'
  return signal ? 'signal ' + signal : 'exit ' + code
}

async function decide(body, { lab, signal }) {
  const init = latestPrompt(body.messages, (text) => text.startsWith('初始化合成窗口 '))
  if (init) {
    initialized++
    return { reply: '合成窗口就绪。' }
  }
  assert(timings.length + requestIds.size < 65, 'Pilot exceeded its inference request limit')
  const allowed = body.tools.filter(({ name }) => name.startsWith('workflow_'))
  const modelWork = join(lab, 'empty-model-workspace')
  await mkdir(modelWork, { recursive: true, mode: 0o700 })
  const sequence = requestIds.size + timings.length + 1
  const schema = join(lab, 'schema-' + sequence + '.json')
  const output = join(lab, 'decision-' + sequence + '.json')
  requestIds.add(sequence)
  await writeFile(schema, JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['name', 'inputJson', 'text'],
    properties: {
      name: { type: 'string', enum: ['answer', ...allowed.map(({ name }) => name)] },
      inputJson: { type: 'string' },
      text: { type: 'string' },
    },
  }))

  const prompt = [
    'You are choosing exactly one next step for an isolated DSH synthetic test conversation.',
    'Use only a DSH tool shown below. Do not invoke Codex tools. Do not invent tool responses.',
    'For a tool, choose its exact name, put a JSON argument object encoded as a string in inputJson, and leave text empty.',
    'Otherwise choose answer, put {} in inputJson, and put the exact response in text.',
    'If workflow_propose returns preview, copy its complete exact preview string as the entire response, preserving all whitespace.',
    'An ordinary turn may issue tool calls one after another. For a task or result wake, claim or consume before acting.',
    'A proposal has user-facing exact window titles. Confirmation returns host-resolved IDs, which are used when dispatching.',
    'Use the supplied conversation, actual tool results, and definitions.',
    JSON.stringify({ system: body.system, messages: body.messages, tools: allowed }),
  ].join('\n')
  const environmentKeys = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'CODEX_HOME', 'LANG', 'LC_ALL', 'TERM',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ]
  const env = Object.fromEntries(environmentKeys
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]))
  const args = [
    'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only',
    '--skip-git-repo-check', '--cd', modelWork, '--model', modelName,
    '-c', 'project_doc_max_bytes=0', '-c', 'model_reasoning_effort="low"',
    ...['shell_tool', 'apps', 'plugins', 'memories', 'multi_agent', 'multi_agent_v2', 'hooks']
      .flatMap((name) => ['--disable', name]),
    '--output-schema', schema, '--output-last-message', output, '-',
  ]
  const started = performance.now()
  let stderr = ''
  try {
    const child = spawn('codex', args, { env, cwd: modelWork, stdio: ['pipe', 'ignore', 'pipe'], signal })
    const completed = new Promise((done, reject) => {
      child.once('error', (error) => reject(new Error('Codex inference could not start or was interrupted: ' + error.code)))
      child.once('close', (code, signum) => code === 0
        ? done() : reject(new Error('Codex inference unavailable: ' + diagnostic(code, signum, stderr))))
    })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192) })
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
    await completed
    const decision = JSON.parse(await readFile(output, 'utf8'))
    if (decision.name === 'answer') return { reply: decision.text }
    assert(allowed.some(({ name }) => name === decision.name))
    const input = JSON.parse(decision.inputJson)
    assert(input && typeof input === 'object' && !Array.isArray(input))
    toolCounts[decision.name] = (toolCounts[decision.name] ?? 0) + 1
    return tool(decision.name, input)
  } finally {
    requestIds.delete(sequence)
    timings.push(Math.round(performance.now() - started))
    await Promise.all([rm(output, { force: true }), rm(schema, { force: true })])
  }
}

await withCollaborationHost({ dsh, archive, decide, modelDeadlineMs: 90_000, allowNetwork: true }, async (host) => {
  const started = Date.now()
  await host.createSessions(windows)
  assert.equal(initialized, windows.length)
  await host.save({ enabled: false, workflowEnabled: true, allowedSessions: windows.map(([id]) => id) })
  const artifacts = await Promise.all(['合成候选初稿\n', '合成候选返修稿\n'].map(async (text, index) => {
    const path = join(host.work, 'candidate-' + (index + 1) + '.txt')
    await writeFile(path, text, { flag: 'wx' })
    return { path, ref: digest(await readFile(path)) }
  }))
  const [initial, repaired] = artifacts
  const request = [
    '请分派这项任务：让试验开发窗口做候选，试验核查窗口并行核查，试验审核窗口复核。任务用 synthetic-pilot，20 分钟，预算 10 次。',
    '这是一项合成演练。请把试验审核窗口列入正式审核范围，再展示冻结的委托方案，我确认一次以后继续推进。',
    '确认后请用一个批次并行派两个任务，条目分别叫 produce 和 verify。合成初稿引用 ' + initial.ref + '。核查只回报独立检查。',
    '批次结果齐全后派 review，必须用产出尝试 ID 及其固定引用绑定审核。首次审核结论指定退回。',
    '收到退回后，让试验开发窗口以 produce 第二次尝试交付合成返修稿 ' + repaired.ref + '，再用新的产出 ID 和引用派 review 第二次尝试。',
    '第二次审核指定通过。工作窗口直接用结构化工具回报对应引用。所有结果经过消费后，以通过复审的固定产物收口。不要在中间重复问用户。',
  ].join('\n')
  const proposal = await host.turn(main, await host.submit(main, request), 180_000)
  const drafted = proposal.results.find(({ confirmation }) => confirmation === 'owner_reply_required')
  assert(drafted?.preview, 'Real model did not prepare a native workflow plan: ' +
    JSON.stringify({ toolCounts, results: proposal.results }))
  const previewShown = proposal.records.some(({ type, data }) => type === 'assistant/message' &&
    parts(data.message.content).filter(({ type }) => type !== 'reasoning').some(({ text }) => text === drafted.preview))
  assert(previewShown, 'Real model did not reproduce the exact native preview')
  assert(!host.snapshot(main, task).grant)
  console.log('PASS real model prepared and rendered the exact owner preview')
  const confirmed = await host.turn(main, await host.submit(main, '确认委托'), 180_000)
  assert(confirmed.results.some(({ task: named, duplicate }) => named === task && duplicate === false))
  console.log('PASS native owner confirmation enabled the real-model controller')
  const final = await host.until(() => {
    const state = host.snapshot(main, task)
    return state.grant?.state === 'closed' && state
  }, 'real model completes batch, review, repair and verified closure', 540_000)
  assert.equal(final.jobs.length, 5)
  assert.deepEqual(final.grant.outcome.finalArtifacts, [repaired.ref])
  assert.equal(final.grant.outcome.status, 'completed')
  assert(final.jobs.some(({ target, report }) => target === verifier && report.status === 'completed'))
  const checks = final.jobs.filter(({ item }) => item === 'review')
  assert.deepEqual(checks.map(({ target, report }) => [target, report.status, report.reviewedArtifact]), [
    [reviewer, 'changes_requested', initial.ref],
    [reviewer, 'approved', repaired.ref],
  ])
  for (const [index, file] of artifacts.entries()) {
    assert.equal(digest(await readFile(file.path)), file.ref)
    assert(final.jobs.some(({ target, item, attempt, report }) => target === developer &&
      item === 'produce' && attempt === index + 1 && report.artifacts.includes(file.ref)))
  }
  console.log('PASS real model isolated DSH natural plan, two-worker batch, review, repair and exact artifact closure',
    JSON.stringify({ model: modelName, durationMs: Date.now() - started, requests: timings.length, toolCounts }))
})
