import { createHash } from 'node:crypto'
import { ID, nativeOwner, validId as isId } from './bridge-input.js'
import { matchingTitles, naturalIntent, plainText } from './natural-message.js'
import { continuationGoal, continuationRequest, contextualRequest, conversationRequest, directQuestionInScope, explicitInstruction, instructionGoal, instructionText, instructionWindow, namedQuestionGoal, namedQuestionText } from './workflow-context.js'

const confirmationText = '确认委托'
const shortConfirmation = /^(?:好|好的|可以|同意)[。！!]?$/u
const draftLifetime = 120_000
const contextTurnLimit = 5
const directLifetimeMinutes = 30
const directRequest = /^(?:请[ \t]*)?把(?:『([^』]*)』|「([^」]*)」|“([^”]*)”)[ \t]*委托给[ \t]*(?:『([^』\r\n]*)』|「([^」\r\n]*)」|“([^”\r\n]*)”)[。]?$/u
const digest = (text) => createHash('sha256').update(text).digest('hex')
const denied = (error) => ({ error })
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
  conversation: { type: 'boolean', description: 'Allow ongoing exchanges with the workers assigned under this visible plan' },
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

export function directIntent(text) {
  const match = directRequest.exec(text)
  const question = match ? undefined : directQuestion.exec(text.replace(requestLead, ''))
  if (!match && !question) return
  const unquotedTitle = question?.[4]
  if (question && !/[\p{L}\p{N}]/u.test(question[5])) return
  const goal = match ? match[1] ?? match[2] ?? match[3] : question[5]
  const title = match ? match[4] ?? match[5] ?? match[6] : question[1] ?? question[2] ?? question[3] ?? question[4]
  if (boundedText(goal, 2000) && !placeholder.test(goal.trim()) && boundedText(title, 160) && title === title.trim()) {
    return { goal, title, question: Boolean(question), ...(unquotedTitle && ambiguousQuestionTitle.test(unquotedTitle)
      ? { error: 'workflow_target_clarification_required' } : {}),
      ...(/^[0-9]{1,3}$/u.test(unquotedTitle ?? '') ? { alias: unquotedTitle } : {}) }
  }
}

function proposalSource(message) {
  if (!nativeOwner(message) || !Array.isArray(message.content) || message.content.length !== 1 ||
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
  const required = ['task', 'goal', 'ttlMinutes', 'budget', 'scopes']
  if (!(hasKeys(value, required) || hasKeys(value, [...required, 'conversation']) && typeof value.conversation === 'boolean') ||
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
  const proposal = { task, goal, ttlMinutes, budget, scopes, ...(value.conversation ? { conversation: true } : {}) }
  if (Buffer.byteLength(JSON.stringify(proposal)) <= 6000) return proposal
}

function uniqueTitle(items, title) {
  const matches = matchingTitles(items, title, () => true)
  if (matches.length === 1 && isId(matches[0].to)) return matches[0]
}

function contextTarget(items, registry, owner, selector) {
  if (selector.kind === 'title') {
    const found = uniqueTitle(items, selector.value)
    return found?.title === selector.value ? found : denied('workflow_context_target_ambiguous')
  }
  const groups = registry.list()
  const owningGroups = groups.filter(({ sessionIds }) => sessionIds.includes(owner))
  if (owningGroups.length > 1) return denied('workflow_context_target_ambiguous')
  const [workspace] = owningGroups
  const members = new Set(workspace?.sessionIds ?? groups.flatMap(({ sessionIds }) => sessionIds))
  const inScope = workspace ? (id) => members.has(id) : (id) => !members.has(id)
  const matches = items.flatMap(({ sessionId, blank, parentSessionId, origin, projections }) => {
    const title = projections?.values?.title
    const alias = typeof title === 'string' && /^([0-9]{1,3})(?=$|[ \t｜|·—–-])/u.exec(title)
    return !blank && !parentSessionId && origin !== 'subagent' && isId(sessionId) &&
      inScope(sessionId) && alias?.[1] === selector.value ? [{ to: sessionId, title, workspace: workspace?.id ?? null }] : []
  })
  if (matches.length > 1) return denied('workflow_context_alias_conflict')
  return matches[0] ?? denied('workflow_context_alias_unknown')
}

function catalogTarget(items, text, readGoal) {
  const matches = items.flatMap(({ sessionId, blank, parentSessionId, origin, projections }) => {
    const title = projections?.values?.title
    return !blank && !parentSessionId && origin !== 'subagent' && isId(sessionId) &&
      typeof title === 'string' && title && text.startsWith(title) ? [{ to: sessionId, title }] : []
  })
  const length = matches.reduce((max, { title }) => Math.max(max, title.length), 0)
  return matches.filter(({ title }) => title.length === length)
    .map((target) => ({ ...target, goal: readGoal(text, target.title) }))
}

export function matchesContextNotice(message, notice) {
  const { source } = message
  return message.id === notice.id && message.role === 'user' && source?.kind === 'agent-message' &&
    source.form === 'relay' && source.senderSessionId === notice.owner && source.bridgeWorkflowOwner === notice.owner &&
    source.bridgeWorkflowKind === 'direct-notice' && plainText(message) === notice.text
}

export function planTarget(items, registry, owner, query) {
  const alias = /^([0-9]{1,3})(?:号)?(?:窗口)?$/u.exec(query)
  return alias ? contextTarget(items, registry, owner, { kind: 'alias', value: alias[1] }) : uniqueTitle(items, query)
}

function resolvePlan(items, proposal, source, owner, available, registry) {
  const bindings = new Map()
  const bind = (query) => {
    if (bindings.has(query)) return bindings.get(query)
    const match = planTarget(items, registry, owner, query)
    if (!match?.to) return denied('workflow_target_clarification_required')
    if (match.to === owner || !available(match.to)) return denied('workflow_target_not_allowed')
    const value = { id: match.to, title: match.title }
    bindings.set(query, { ...value, workspace: match.workspace })
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
  return { grant: { task, goal, ttlMinutes, budget, scopes, ...(proposal.conversation ? { conversation: true } : {}) }, targets: [...targets.values()], bindings }
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
  if (grant.conversation) details.push('往返范围 主控与已派工的执行窗口，限下列用途')
  for (const scope of grant.scopes) {
    details.push((scope.review ? '正式审核范围 ' : '范围 ') + quoted(scope.name), '  用途 ' + quoted(scope.purpose))
    for (const id of scope.targets) details.push('  窗口 ' + quoted(titles.get(id)))
  }
  return '请核对以下跨窗口委托方案。\n\n' +
    details.map((line) => '    ' + line).join('\n') +
    (grant.conversation ? '\n\n请等本轮完成后在原窗口回复「好」或「可以」。回复「取消委托」可作废方案。'
      : '\n\n请等本轮完成后在原窗口回复「确认委托」。回复「取消委托」可作废方案。')
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
  const contextual = new Map()
  const inTurn = (exec, caller, current) => {
    const live = current(exec)
    return enabled() && live?.id === caller.id && live.turn === caller.turn && live.context === caller.context
  }
  const readWindows = (requestSignal) => ctx.sessionController.list({}, requestSignal)
  const scopedSignal = (exec) => AbortSignal.any([signal, exec.signal])

  function input(session, turn, message) {
    const draft = pending.get(session.id)
    const saved = contextual.get(session.id)
    pending.delete(session.id)
    contextual.delete(session.id)
    if (turn.mixed || !enabled() || !available(session.id)) return
    const adjacent = saved && saved.afterTurn + 1 === turn.number && saved.expires > performance.now() ? saved : undefined
    const text = proposalSource(message)
    if (text === undefined) {
      if (adjacent?.notice && matchesContextNotice(message, adjacent.notice)) {
        return { mode: 'direct-context-notice', saved: adjacent }
      }
      return
    }
    const identity = { messageId: message.id, rpcId: message.source.rpcId, turn: turn.number }
    if (text.trim() === confirmationText || draft && shortConfirmation.test(text.trim())) {
      return { mode: 'confirm-workflow', identity, draft }
    }
    const continuation = continuationRequest(text)
    const input = continuation ?? text
    const direct = directIntent(input)
    // Explicit quoted delegation keeps its literal body. Automatic questions
    // must keep an independent follow-up action outside the one-window path.
    if (direct?.question && !directQuestionInScope(direct.goal)) return
    if (direct && !direct.alias) {
      if (continuation) direct.followUp = true
      direct.initial = resolveDirectTarget(session.id, direct, AbortSignal.any([signal, AbortSignal.timeout(5000)]))
      return { mode: 'direct-workflow', identity, text, direct }
    }
    const prior = adjacent?.notice ? undefined : adjacent
    const ordinary = naturalIntent(input)
    const instruction = !ordinary && !direct && instructionText(input)
    const explicit = instruction && explicitInstruction(instruction)
    const request = direct?.alias ? {
      action: 'ask', selector: { kind: 'alias', value: direct.alias }, goal: direct.goal,
    } : !ordinary && (conversationRequest(input) || contextualRequest(input, prior))
    // The established forms take precedence when they already provide both
    // parts. The host catalog supplies a missing title/body boundary.
    const named = !ordinary && (!request || request.action === 'ask' && !request.prior && !request.conversation &&
      (!request.goal || request.selector?.kind === 'title')) && namedQuestionText(input)
    if (named) {
      return directContext({ ...request, action: 'ask', named })
    }
    if (instruction && !request?.conversation && (explicit?.goal || !explicit)) {
      // Catalog-only forms do not supersede the contextual prompt for an
      // unbound ordinary instruction such as a native child request.
      if (explicit || /^(?:[0-9]|[「『“]|[^，,：:]{1,160}(?:窗口|会话))/u.test(instruction) ||
          /^(?:让|叫|安排|由)/u.test(text.trimStart().replace(requestLead, ''))) {
        return directContext({ action: 'ask', instruction, ...explicit, conversation: true })
      }
    }
    if (request) {
      if (request.prior?.conversation) request.conversation = true
      if (request.action === 'topic' && request.selector) {
        request.binding = selectTarget(session.id, request.selector, AbortSignal.any([signal, AbortSignal.timeout(5000)]))
      }
      return directContext(request)
    }

    function directContext(request) {
      if (continuation) request.followUp = true
      if (request.action === 'ask') {
        request.initial = resolveDirectTarget(session.id, request, AbortSignal.any([signal, AbortSignal.timeout(5000)]))
      }
      return { mode: 'direct-workflow', identity, text, direct: request, contextual: true }
    }
  }

  function proposalInput(message, turn) {
    const text = message && proposalSource(message)
    if (!text || /^(?:[「『“"'‘`>]|示例|例如|比如|引用|转述|转发|他说|她说|对方说)/u.test(text.trim()) ||
        /^(?:请[ \t]*)?(?:取消委托|算了)[。！!]?$/u.test(text.trim()) ||
        /(?:^|[，,。；;！？!?\n])\s*(?:请\s*)?取消委托[。！!]?\s*$/u.test(text)) return
    return { mode: 'propose-workflow', text,
      identity: { messageId: message.id, rpcId: message.source.rpcId, turn: turn.number } }
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
    if (context.mode !== 'propose-workflow' || !inTurn(exec, caller, current) ||
        value?.conversation !== true && !delegationIntent(context.text)) {
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
      const resolved = resolvePlan(items, proposal, context.text, id, available, ctx.workspaceRegistry)
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
        const live = planTarget(items, ctx.workspaceRegistry, caller.id, query)
        if (live?.to !== expected.id || live.title !== expected.title || live.workspace !== expected.workspace || !available(expected.id)) {
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
      bindings: [...draft.bindings],
      planDigest: draft.planDigest,
    }
    return open(draft.grant, evidence)
  }

  async function selectTarget(owner, selector, requestSignal) {
    try {
      const { items } = await readWindows(requestSignal)
      return contextTarget(items, ctx.workspaceRegistry, owner, selector)
    } catch {
      return denied('workflow_targets_unavailable')
    }
  }

  function keepContext(owner, saved) {
    if (saved.proofs.length >= contextTurnLimit || saved.expires <= performance.now()) return
    contextual.set(owner, saved)
    const expiry = setTimeout(() => {
      if (contextual.get(owner) === saved) contextual.delete(owner)
    }, Math.max(0, saved.expires - performance.now()))
    expiry.unref()
  }

  function rememberTopic(owner, direct, proof) {
    const { selector, goal } = direct
    keepContext(owner, {
      selector, goal, afterTurn: proof.turn, proofs: [proof], expires: performance.now() + draftLifetime,
      binding: direct.binding,
    })
  }

  function rememberClarification(owner, direct, proof, clarification, notice) {
    keepContext(owner, {
      ...clarification, notice, afterTurn: proof.turn,
      proofs: [...(direct.prior?.proofs ?? []), proof], expires: direct.prior?.expires ?? performance.now() + draftLifetime,
    })
  }

  function rememberAfterNotice(owner, saved, proof) {
    keepContext(owner, { ...saved, notice: undefined, afterTurn: proof.turn, proofs: [...saved.proofs, proof] })
  }

  async function contextualTarget(caller, requestSignal) {
    const { id, context: { direct } } = caller
    const { selector, goal, prior, inheritedTarget, conversation } = direct
    const need = (error, clarification) => ({ error, clarification: { ...clarification, ...(conversation ? { conversation } : {}) } })
    if (!selector) return goal ? need('workflow_context_target_required', { missing: 'target', goal })
      : need('workflow_context_both_required', { missing: 'both' })
    const clarifyTarget = (error) => need(error, { missing: goal ? 'target' : 'both', goal })
    const first = inheritedTarget ? await prior.binding : await selectTarget(id, selector, requestSignal)
    if (!first) return clarifyTarget('workflow_context_target_required')
    if (first.error) return clarifyTarget(first.error)
    if (first.to === id || !available(first.to) || !await existing(first.to, requestSignal)) {
      return clarifyTarget('workflow_target_not_available')
    }
    const target = await selectTarget(id, selector, requestSignal)
    if (target.error) return clarifyTarget(target.error)
    if (target.to !== first.to || target.title !== first.title || target.workspace !== first.workspace || !available(target.to)) {
      return clarifyTarget('workflow_target_changed')
    }
    if (!goal) return need('workflow_context_goal_required', { missing: 'goal', selector, binding: target })
    return { target }
  }

  async function resolveDirectTarget(owner, direct, deadline) {
    const { instruction, named, selector, title, goal, prior, inheritedTarget } = direct
    try {
      if ((instruction && !selector) || named) {
        const { items } = await readWindows(deadline)
        const window = instruction && instructionWindow(instruction)
        if (window) {
          const queries = window.title.endsWith('会话') ? [window.title, window.title.slice(0, -2)] : [window.title]
          const matches = matchingTitles(items, queries[0], () => true)
          if (queries.length > 1) {
            for (const match of matchingTitles(items, queries[1], () => true)) {
              if (!matches.some(({ to }) => to === match.to)) matches.push(match)
            }
          }
          if (matches.length !== 1) return denied(matches.length
            ? 'workflow_context_target_ambiguous' : 'workflow_context_target_required')
          return { ...matches[0], goal: window.goal, queries }
        }
        const readGoal = instruction
          ? (text, title) => instructionGoal(text.slice(title.length))
          : namedQuestionGoal
        const matches = catalogTarget(items, instruction || named, readGoal)
        if (matches.length > 1) return denied('workflow_context_target_ambiguous')
        const [match] = matches
        if (match?.goal) return match
        if (match && selector?.value !== match.title) return denied('workflow_context_target_ambiguous')
        if (instruction) return denied('workflow_context_target_required')
      }
      if (selector) {
        const target = await selectTarget(owner, selector, deadline)
        return target?.error ? target : { ...target, goal }
      }
      if (inheritedTarget && prior?.binding) return await prior.binding
      if (title) {
        const target = uniqueTitle((await readWindows(deadline)).items, title)
        if (target?.title === title) return { ...target, goal }
      }
    } catch {
      return denied('workflow_targets_unavailable')
    }
  }

  async function delegateDirect(exec, caller, current, open) {
    const { context, id } = caller
    const { direct } = context
    if (context.mode !== 'direct-workflow' || !inTurn(exec, caller, current) ||
        (context.contextual && direct.action !== 'ask')) return denied('workflow_direct_owner_request_required')
    if (direct.error) return denied(direct.error)
    const requestSignal = scopedSignal(exec)
    let target
    let goal = direct.goal
    if (direct.prior && direct.prior.expires <= performance.now()) return denied('workflow_context_expired')
    try {
      const first = await direct.initial
      if (direct.instruction && first?.error) return denied(first.error)
      if (first?.to && first.goal) {
        if (first.to === id || !available(first.to) || !await existing(first.to, requestSignal)) {
          return denied('workflow_target_not_available')
        }
        target = await resolveDirectTarget(id, direct, requestSignal)
        if (target?.to !== first.to || target.title !== first.title || target.workspace !== first.workspace ||
            target.goal !== first.goal || !available(first.to)) return denied('workflow_target_changed')
        if (direct.inheritedTarget) {
          const prior = await direct.prior.binding
          if (target.to !== prior?.to || target.title !== prior.title || target.workspace !== prior.workspace) {
            return denied('workflow_target_changed')
          }
        }
        goal = first.goal
      } else if (context.contextual) {
        const resolved = await contextualTarget(caller, requestSignal)
        if (resolved.error) return resolved
        // A target missing when a complete request arrived cannot appear later.
        if (direct.goal && !first?.to) return denied(first?.error ?? 'workflow_context_target_required')
        target = resolved.target
      } else {
        return denied(first?.error ?? 'workflow_target_clarification_required')
      }
    } catch {
      return denied('workflow_targets_unavailable')
    }
    if (!inTurn(exec, caller, current) || !emptyNativeInbox(ctx, exec.agent.session)) {
      return denied('workflow_direct_owner_request_required')
    }
    if (direct.prior && direct.prior.expires <= performance.now()) return denied('workflow_context_expired')
    const task = 'direct-' + digest(JSON.stringify([id, context.identity.messageId]))
    const query = Boolean(direct.instruction || !direct.conversation)
    const grant = {
      task, goal, ttlMinutes: directLifetimeMinutes, budget: 1,
      conversation: true,
      ...(query ? { query: true } : {}),
      scopes: [{ name: 'execute', purpose: '执行所有者明确给出的原文目标', targets: [target.to] }],
    }
    const targets = [{ id: target.to, title: target.title }]
    const evidence = {
      kind: 'native-owner-workflow-direct',
      request: { ...context.identity, sourceDigest: digest(context.text) },
      targets, planDigest: digest(JSON.stringify([grant, targets])),
      ...(context.contextual ? { context: {
        selector: direct.selector ?? { kind: 'title', value: target.title },
        ...(target.queries ? { queries: target.queries } : {}),
        ...(target.workspace !== undefined ? { workspace: target.workspace } : {}),
        earlierInputs: (direct.prior?.proofs ?? []).filter((proof) => !proof.notice).map((proof) => ({
          ...proof.input, turn: proof.turn, endSequence: proof.endSeq, sourceDigest: proof.sourceDigest,
        })),
      } } : {}),
    }
    return open(grant, evidence, {
      to: target.to, text: goal, followUp: direct.followUp || Boolean(direct.instruction && continuationGoal(goal)),
      verifyTarget: async (signal) => {
        const live = await resolveDirectTarget(id, direct, signal)
        return live?.to === target.to && live.title === target.title && live.workspace === target.workspace && live.goal === goal
      },
    })
  }

  function clear(id) {
    pending.delete(id)
    contextual.delete(id)
  }
  return { input, proposalInput, reply, end, clear, propose, confirm, delegateDirect,
    rememberTopic, rememberClarification, rememberAfterNotice }
}
