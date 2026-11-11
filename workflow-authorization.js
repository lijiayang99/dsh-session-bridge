import { createHash } from 'node:crypto'
import { matchingTitles } from './natural-message.js'

const ID = /^[a-zA-Z0-9_-]{1,128}$/
const confirmationText = '确认委托'
const draftLifetime = 120_000
const directLifetimeMinutes = 30
const directRequest = /^(?:请[ \t]*)?把(?:『([^』]*)』|「([^」]*)」|“([^”]*)”)[ \t]*委托给[ \t]*(?:『([^』\r\n]*)』|「([^」\r\n]*)」|“([^”\r\n]*)”)[。]?$/u
const digest = (text) => createHash('sha256').update(text).digest('hex')
const denied = (error) => ({ error })
const isId = (value) => typeof value === 'string' && ID.test(value)
const boundedText = (value, limit) => typeof value === 'string' &&
  value.length <= limit && value.trim().length > 0
const textSchema = (maxLength) => ({ type: 'string', minLength: 1, maxLength })
const idSchema = { type: 'string', pattern: ID.source, maxLength: 128 }
const integerSchema = (maximum) => ({ type: 'integer', minimum: 1, maximum })

export const workflowProposalProperties = {
  task: idSchema,
  goal: textSchema(2000),
  ttlMinutes: integerSchema(1440),
  budget: integerSchema(32),
  scopes: {
    type: 'array', minItems: 1, maxItems: 16,
    items: {
      type: 'object', additionalProperties: false, required: ['name', 'windows', 'purpose'],
      properties: {
        name: idSchema,
        windows: { type: 'array', minItems: 1, maxItems: 16, items: textSchema(160) },
        purpose: textSchema(300),
        review: { type: 'boolean' },
      },
    },
  },
}

// Explicit delegation requests can prepare a proposal. Opening a grant always
// requires a second native owner message after the complete preview.
const requestLead = /^(?:请你帮我|请(?:你|帮我)?|帮我|麻烦(?:你|帮我)?|你|我想让你)[ \t]*/u
const directQuestion = /^给[ \t]*(?:(?:『([^』\r\n]{1,160})』|「([^」\r\n]{1,160})」|“([^”\r\n]{1,160})”)[ \t]*(?:这个)?窗口|([\p{L}\p{N}_.·-]{1,160})[ \t]*这个窗口)[ \t]*问(?:他|她|它)(?!们)([\s\S]+)$/u
const ambiguousQuestionTitle = /[和与及或跟]|(?:这个|那个)窗口|^(?:我|你|他|她|它|对方|那边|另一个|其他)$/u
const delegationVerb = /^(?:委托|分派|派发|分发|交办|拆派)\s*[：:，,]?\s*\S/u
const delegationObject = /^(?:把|将)[\s\S]{1,220}?(?:交给|交由|委托给|派给|指派给|分配给|分发给|分发到|派发给|拆派|分派)/u
const delegationRecipient = /^(?:让|安排)[^\r\n]{1,160}?(?:窗口|会话|agent)/iu
const englishDelegation = /^(?:please\s+)?(?:delegate|assign|dispatch)\s+\S/i
const missingDescription = /^(?:委托|分派|派发|分发|交办|拆派)[\s:：,，]*(?:一下|(?:这个|这项|这件|该)?(?:任务|工作|事项))?[\s。.!！?？]*$/u
const placeholder = /^(?:待定|待明确|未知|随便|任意|tbd|todo|n\/a)$/iu
const titleAfterDirective = /(?:交给|交由|委托给|派给|指派给|分派给|分配给|分发给|分发到|派发给|安排给|让|由|给)[ \t]*(?:「([^」\r\n]{1,160})」|『([^』\r\n]{1,160})』|“([^”\r\n]{1,160})”|([\p{L}\p{N}_·-]{1,36}?窗口))/gu

function delegationIntent(text) {
  const request = text.replace(requestLead, '')
  return !missingDescription.test(request) && (
    delegationVerb.test(request) || delegationObject.test(request) ||
    delegationRecipient.test(request) || englishDelegation.test(text)
  )
}

function directIntent(text) {
  const match = directRequest.exec(text)
  const question = match ? undefined : directQuestion.exec(text.replace(requestLead, ''))
  if (!match && !question) return
  const unquotedTitle = question?.[4]
  if (unquotedTitle && ambiguousQuestionTitle.test(unquotedTitle)) return
  if (question && !/[\p{L}\p{N}]/u.test(question[5])) return
  const goal = match ? match[1] ?? match[2] ?? match[3] : question[5]
  const title = match ? match[4] ?? match[5] ?? match[6] : question[1] ?? question[2] ?? question[3] ?? question[4]
  if (boundedText(goal, 2000) && !placeholder.test(goal.trim()) && boundedText(title, 160) && title === title.trim()) {
    return { goal, title }
  }
}

function proposalSource(message) {
  if (message.role !== 'user' || message.source?.kind !== 'user' ||
      message.source.principal !== undefined || !isId(message.source.rpcId) ||
      !isId(message.id) || !Array.isArray(message.content) || message.content.length !== 1 ||
      message.content[0]?.type !== 'text') return
  const text = message.content[0].text
  if (!boundedText(text, 2300)) return
  return text
}

function hasKeys(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))
}

function validateProposal(value) {
  if (!hasKeys(value, ['task', 'goal', 'ttlMinutes', 'budget', 'scopes']) ||
      !isId(value.task) || !boundedText(value.goal, 2000) || placeholder.test(value.goal.trim()) ||
      !Number.isInteger(value.ttlMinutes) || value.ttlMinutes < 1 || value.ttlMinutes > 1440 ||
      !Number.isInteger(value.budget) || value.budget < 1 || value.budget > 32 ||
      !Array.isArray(value.scopes) || value.scopes.length < 1 || value.scopes.length > 16) return
  const scopes = []
  const names = new Set()
  for (const scope of value.scopes) {
    if (!(hasKeys(scope, ['name', 'windows', 'purpose']) ||
        hasKeys(scope, ['name', 'windows', 'purpose', 'review']) && typeof scope.review === 'boolean') ||
        !isId(scope.name) || names.has(scope.name) ||
        !boundedText(scope.purpose, 300) || placeholder.test(scope.purpose.trim()) || !Array.isArray(scope.windows) ||
        scope.windows.length < 1 || scope.windows.length > 16 ||
        !scope.windows.every((title) => boundedText(title, 160) && title === title.trim()) ||
        new Set(scope.windows).size !== scope.windows.length) return
    names.add(scope.name)
    scopes.push({ name: scope.name, purpose: scope.purpose, windows: [...scope.windows],
      ...(scope.review ? { review: true } : {}),
    })
  }
  const { task, goal, ttlMinutes, budget } = value
  const proposal = { task, goal, ttlMinutes, budget, scopes }
  if (Buffer.byteLength(JSON.stringify(proposal)) <= 6000) return proposal
}

function uniqueTitle(items, title) {
  const matches = matchingTitles(items, title, () => true)
  if (matches.length === 1 && isId(matches[0].to)) return matches[0]
}

function resolvePlan(items, proposal, source, owner, available) {
  const bindings = new Map()
  const bind = (query) => {
    if (bindings.has(query)) return bindings.get(query)
    const match = uniqueTitle(items, query)
    if (!match) return denied('workflow_target_clarification_required')
    if (match.to === owner || !available(match.to)) return denied('workflow_target_not_allowed')
    const value = { id: match.to, title: match.title }
    bindings.set(query, value)
    return value
  }

  const { task, goal, ttlMinutes, budget } = proposal
  const targets = new Map()
  const scopes = []
  for (const { name, purpose, windows, review } of proposal.scopes) {
    const ids = []
    for (const query of windows) {
      const binding = bind(query)
      if (binding.error) return { ...binding, title: query }
      if (ids.includes(binding.id)) return denied('workflow_duplicate_target')
      ids.push(binding.id)
      targets.set(binding.id, binding)
    }
    scopes.push({ name, purpose, targets: ids, ...(review ? { review: true } : {}) })
  }
  for (const match of source.matchAll(titleAfterDirective)) {
    const query = match.slice(1).find((part) => part !== undefined)
    const binding = bind(query)
    if (binding.error) return { ...binding, title: query }
    if (!targets.has(binding.id)) return { ...denied('workflow_owner_target_missing'), title: query }
  }
  return { grant: { task, goal, ttlMinutes, budget, scopes }, targets: [...targets.values()], bindings }
}

function quoted(value) {
  return JSON.stringify(value).replace(/[\p{C}\p{Zl}\p{Zp}]/gu, (character) =>
    character.split('').map((unit) => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join(''))
}

function renderPreview(grant, targets) {
  const titles = new Map(targets.map(({ id, title }) => [id, title]))
  const details = [
    '任务 ' + quoted(grant.task),
    '目标 ' + quoted(grant.goal),
    '有效期 ' + grant.ttlMinutes + ' 分钟（确认后起算）',
    '任务预算 ' + grant.budget + ' 次派工（含返修）',
  ]
  for (const scope of grant.scopes) {
    details.push((scope.review ? '正式审核范围 ' : '范围 ') + quoted(scope.name), '  用途 ' + quoted(scope.purpose))
    for (const id of scope.targets) details.push('  窗口 ' + quoted(titles.get(id)))
  }
  return '请核对以下跨窗口委托方案。\n\n' +
    details.map((line) => '    ' + line).join('\n') +
    '\n\n请等本轮完成后在原窗口回复「确认委托」。回复「取消委托」可作废方案。'
}

function emptyNativeInbox(ctx, session) {
  try {
    const agent = ctx.agents.get(session.id)
    if (agent?.session !== session) return false
    const { nextTurn, nextStep } = agent.inbox ?? {}
    return Array.isArray(nextTurn) && !nextTurn.length && Array.isArray(nextStep) && !nextStep.length
  } catch {
    return false
  }
}

export function createWorkflowAuthorization(ctx, { enabled, available, existing, signal }) {
  const pending = new Map()
  const inTurn = (exec, caller, current) => {
    const live = current(exec)
    return enabled() && live?.id === caller.id && live.turn === caller.turn && live.context === caller.context
  }
  const readWindows = (requestSignal) => ctx.sessionController.list({}, requestSignal)
  const scopedSignal = (exec) => AbortSignal.any([signal, exec.signal])

  function input(session, turn, message) {
    const draft = pending.get(session.id)
    pending.delete(session.id)
    if (turn.mixed || !enabled() || !available(session.id)) return
    const text = proposalSource(message)
    if (text === undefined) return
    const identity = { messageId: message.id, rpcId: message.source.rpcId, turn: turn.number }
    if (text.trim() === confirmationText) {
      return { mode: 'confirm-workflow', identity, draft }
    }
    const direct = directIntent(text)
    if (direct) return { mode: 'direct-workflow', identity, text, direct }
    if (delegationIntent(text)) {
      return { mode: 'propose-workflow', identity, text }
    }
  }

  function reply(_session, turn, event) {
    const context = turn.context
    if (event.data.turn !== turn.number || turn.mixed || context?.mode !== 'propose-workflow' ||
        !context.draft) return
    const content = event.data.message?.content?.filter(({ type }) => type !== 'reasoning')
    const messageId = event.data.message?.id
    context.previewProof = !event.data.interrupted && content?.length === 1 &&
      content[0].type === 'text' && content[0].text === context.draft.preview &&
      isId(messageId) && Number.isSafeInteger(event.seq)
      ? { messageId, sequence: event.seq, turn: turn.number, digest: digest(context.draft.preview) }
      : undefined
  }

  function end(session, turn, event) {
    const context = turn.context
    const draft = context?.draft
    if (turn.mixed || context?.mode !== 'propose-workflow' || !draft || !context.previewProof ||
        event.data.turn !== turn.number || event.data.reason.kind !== 'completed' ||
        draft.expires <= performance.now() || !enabled() || !available(session.id) ||
        draft.targets.some(({ id }) => !available(id)) || !emptyNativeInbox(ctx, session)) return
    // A future turn cannot inherit an approval that was already queued when
    // this preview completed. The fixed host exposes both native inbox lanes.
    const eligible = { ...draft, previewProof: context.previewProof }
    pending.set(session.id, eligible)
    const expiry = setTimeout(() => {
      if (pending.get(session.id) === eligible) pending.delete(session.id)
    }, Math.max(0, eligible.expires - performance.now()))
    expiry.unref()
  }

  async function propose(value, exec, caller, current) {
    const { id, context } = caller
    if (context.mode !== 'propose-workflow' || !inTurn(exec, caller, current)) {
      return denied('workflow_proposal_owner_request_required')
    }
    const proposal = validateProposal(value)
    if (!proposal) return denied('workflow_proposal_invalid')
    const requestDigest = digest(JSON.stringify(proposal))
    const response = (draft) => ({ confirmation: 'owner_reply_required', preview: draft.preview })
    if (context.draft) return context.draft.requestDigest === requestDigest
      ? response(context.draft) : denied('workflow_proposal_frozen')
    if (context.proposing) return denied('workflow_proposal_in_progress')
    context.proposing = true
    const requestSignal = scopedSignal(exec)
    try {
      const { items } = await readWindows(requestSignal)
      if (!inTurn(exec, caller, current)) return denied('workflow_proposal_owner_request_required')
      const resolved = resolvePlan(items, proposal, context.text, id, available)
      if (resolved.error) return resolved
      const { grant, targets, bindings } = resolved
      if (!(await Promise.all(targets.map(({ id }) => existing(id, requestSignal)))).every(Boolean)) {
        return denied('workflow_target_not_available')
      }
      if (!inTurn(exec, caller, current) || targets.some(({ id }) => !available(id))) {
        return denied('workflow_proposal_owner_request_required')
      }
      const preview = renderPreview(grant, targets)
      if (Buffer.byteLength(preview) > 10_000) return denied('workflow_proposal_too_large')
      context.draft = {
        grant, targets, bindings, preview, requestDigest, expires: performance.now() + draftLifetime,
        proposal: { ...context.identity, sourceDigest: digest(context.text) },
        planDigest: digest(JSON.stringify([grant, targets])),
      }
      return response(context.draft)
    } catch {
      return denied('workflow_targets_unavailable')
    } finally {
      context.proposing = false
    }
  }

  async function confirm(exec, caller, current, open) {
    const { context } = caller
    if (context.mode !== 'confirm-workflow' || !inTurn(exec, caller, current)) {
      return denied('workflow_confirmation_required')
    }
    if (context.used) return denied('workflow_confirmation_consumed')
    context.used = true
    const { draft } = context
    if (!draft || draft.expires <= performance.now()) return denied('workflow_confirmation_required')
    const requestSignal = scopedSignal(exec)
    try {
      if (!(await Promise.all(draft.targets.map(({ id }) => existing(id, requestSignal)))).every(Boolean)) {
        return denied('workflow_target_not_available')
      }
      const { items } = await readWindows(requestSignal)
      for (const [query, expected] of draft.bindings) {
        const live = uniqueTitle(items, query)
        if (live?.to !== expected.id || live.title !== expected.title || !available(expected.id)) {
          return denied('workflow_target_changed')
        }
      }
    } catch {
      return denied('workflow_targets_unavailable')
    }
    if (!inTurn(exec, caller, current) || draft.expires <= performance.now() ||
        !emptyNativeInbox(ctx, exec.agent.session)) return denied('workflow_confirmation_required')
    const evidence = {
      kind: 'native-owner-workflow-confirmation',
      proposal: draft.proposal,
      preview: draft.previewProof,
      confirmation: context.identity,
      targets: draft.targets,
      planDigest: draft.planDigest,
    }
    return open(draft.grant, evidence)
  }

  async function delegateDirect(exec, caller, current, open) {
    const { context, id } = caller
    if (context.mode !== 'direct-workflow' || !inTurn(exec, caller, current)) {
      return denied('workflow_direct_owner_request_required')
    }
    if (context.directResult) return { ...context.directResult, duplicate: true }
    if (context.delegating) return denied('workflow_direct_in_progress')
    const { goal, title } = context.direct
    const requestSignal = scopedSignal(exec)
    context.delegating = true
    let target
    try {
      const first = uniqueTitle((await readWindows(requestSignal)).items, title)
      if (first?.title !== title) return denied('workflow_target_clarification_required')
      if (first.to === id || !available(first.to) || !await existing(first.to, requestSignal)) {
        return denied('workflow_target_not_available')
      }
      target = uniqueTitle((await readWindows(requestSignal)).items, title)
      if (target?.to !== first.to || target.title !== title || !available(first.to)) {
        return denied('workflow_target_changed')
      }
    } catch {
      return denied('workflow_targets_unavailable')
    } finally {
      context.delegating = false
    }
    if (!inTurn(exec, caller, current) || !emptyNativeInbox(ctx, exec.agent.session)) {
      return denied('workflow_direct_owner_request_required')
    }
    const task = 'direct-' + digest(JSON.stringify([id, context.identity.messageId]))
    const grant = {
      task, goal, ttlMinutes: directLifetimeMinutes, budget: 1,
      scopes: [{ name: 'execute', purpose: '执行所有者明确给出的原文目标', targets: [target.to] }],
    }
    const targets = [{ id: target.to, title }]
    const result = open(grant, {
      kind: 'native-owner-workflow-direct',
      request: { ...context.identity, sourceDigest: digest(context.text) },
      targets, planDigest: digest(JSON.stringify([grant, targets])),
    })
    if (result?.duplicate === false) context.directResult = result
    return result
  }

  return { input, reply, end, clear: (id) => pending.delete(id), propose, confirm, delegateDirect }
}
