import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { read, write } from './receipt-store.js'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { draftPreview, hostContext, matchingTitles, naturalIntent } from './natural-message.js'
import { ID, nativeOwner, validId } from './bridge-input.js'
import { directIntent } from './workflow-authorization.js'
import { createActivity } from './activity.js'
import { applyWorkflow } from './workflow.js'
import { observeNativeResults } from './native-result.js'
import { existingWindow } from './workflow-routing.js'
import { registerStatusLog, receiptLog } from './workflow-view.js'

// Local DSH bundles are linked, so resolve the schema from the running DSH CLI.
const cli = realpathSync(process.argv[1])
const schema = createRequire(cli)('@deepseek-ai/schemastery')
const supportsOwnerPrompt = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8'))
    return pkg.name === '@deepseek-ai/dsh' && pkg.version === '0.2.2-rc.1'
  } catch {
    return false
  }
})()

export const name = 'dsh-session-bridge-settings'
export const Config = schema.object({
  // Host-authored form metadata, outside the writable settings values.
  enabled: schema.boolean().default(false).volatile()
    .extra('dshSessionBridgeHost', supportsOwnerPrompt ? 'supported' : 'unsupported'),
  workflowEnabled: schema.boolean().default(false).volatile(),
  allowedSessions: schema.array(schema.string().pattern(/^[a-zA-Z0-9_-]{1,128}$/))
    .max(32).default([]).volatile(),
})
export const inject = ['agents', 'sessions', 'sessionController', 'tools', 'workspaceRegistry']

const KEY = /^[a-f0-9]{64}$/
const DRAFT_LIFETIME_MS = 120_000
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const now = () => new Date().toISOString()
const validText = (value) => typeof value === 'string' && value.length <= 2000 &&
  value.trim().length > 0 && Buffer.byteLength(value) <= 8000
const authorizationCommand = /^授权互传 ([a-zA-Z0-9_-]{1,128}) ([a-zA-Z0-9_-]{1,128})\r?\n([\s\S]+)$/

// In DSH 0.2.2-rc.1, the Host omits the owner principal and records non-owner
// principals explicitly. rpcId is supplied by the native prompt admission.
function ownerText(message) {
  const { content } = message
  if (!nativeOwner(message) ||
      !Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' ||
      typeof content[0].text !== 'string' || content[0].text.length > 2300) return undefined
  return content[0].text
}

function ownerAuthorization(input, id) {
  const match = authorizationCommand.exec(input)
  if (!match || !validText(match[3])) return undefined
  const [, to, requestId, text] = match
  return { to, requestId, payloadHash: sha([to, text]), userMessageId: id, used: false }
}

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
const stringId = { type: 'string', pattern: ID.source, maxLength: 128 }

export function apply(ctx, config) {
  const home = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
  const dir = join(home, 'dsh-session-bridge', 'receipts')
  if (lstatSync(join(home, 'session-bridge', 'receipts'), { throwIfNoEntry: false })) {
    throw new Error('dsh-session-bridge: migrate the legacy receipts directory with DSH stopped before enabling the bundle')
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Legacy configuration keys remain readable by the old package on rollback.
  const available = (id) => validId(id) && !ctx.workspaceRegistry.archivedSessionIds.includes(id)
  const enabled = () => config.enabled.get()
  let web = false
  let activity
  let workflow
  let subagents
  let persistence
  const inFlight = new Set()
  if (supportsOwnerPrompt) {
    ctx.inject(['profileContext', 'sessionPersistence'], (workflowCtx) => {
      if (workflowCtx.profileContext.name !== 'web') return
      web = true
      persistence = workflowCtx.sessionPersistence
      const projection = createActivity(available)
      activity = projection
      workflowCtx.inject(['connection'], (scope) => {
        if (!scope.connection) return
        projection.register(scope)
        registerStatusLog(scope, {
          enabled,
          windows: (signal) => ctx.sessionController.list({}, signal),
          read: (id) => [...(workflow?.statusEvents(id) ?? []), ...receiptLog(dir, id, inFlight)],
        })
      })
      workflow = applyWorkflow(workflowCtx, enabled, available, projection, matchConversation, reserveConversation)
      workflowCtx.inject(['subagents'], (scope) => {
        subagents = scope.subagents
        observeNativeResults(scope, enabled, available, projection, reserveNativeResult)
      })
    })
  }
  const receiptPath = (key) => join(dir, key + '.json')
  const processingPath = (key) => join(dir, key + '.turn.json')
  function reserveNativeResult(message, from, to) {
    const key = sha(['native-result', from, to, message.source.bridgeWorkflowId])
    const path = receiptPath(key)
    const record = { from, to, messageId: message.id, delivery: 'reserved', at: now(),
      authorization: { kind: 'native-subagent-result', returning: true } }
    if (!write(dir, path, record, true)) return
    inFlight.add(key)
    return (delivery) => {
      inFlight.delete(key)
      record.delivery = delivery
      record.settledAt = now()
      write(dir, path, record, false)
    }
  }

  function messageActivity(record, state, attempt) {
    try {
      activity?.record({ key: record.messageId, from: record.from, to: record.to, kind: 'message', state,
        nativeParent: record.authorization?.nativeParent }, attempt)
    } catch {
      ctx.logger.warn('message activity could not be projected')
    }
  }

  function hasEmptyInbox(session) {
    try {
      const agent = ctx.agents.get(session.id)
      if (agent?.session !== session) return false
      const { nextTurn, nextStep } = agent.inbox ?? {}
      return Array.isArray(nextTurn) && nextTurn.length === 0 &&
        Array.isArray(nextStep) && nextStep.length === 0
    } catch {
      return false
    }
  }

  // Only native turn events tied to our exact message ID can settle processing.
  const turns = new Map()
  const drafts = new Map()
  const clearNatural = (active) => {
    if (!active?.natural) return
    active.natural.controller.abort()
    active.natural = undefined
  }
  ctx.on('session/event', (session, event) => {
    const active = turns.get(session.id)
    if (!available(session.id)) {
      clearNatural(active)
      turns.delete(session.id)
      drafts.delete(session.id)
      return
    }
    if (event.type === 'turn/start') {
      clearNatural(active)
      turns.set(session.id, { turn: event.data.turn, message: null, replied: false, hasRelay: false })
      return
    }
    if (!active) return
    if (event.type === 'user/message') {
      if (web && hostContext(event.data)) return
      clearNatural(active)
      const draft = drafts.get(session.id)
      drafts.delete(session.id)
      const source = event.data.source
      if (source?.kind === 'user') {
        const ordinary = enabled()
        const input = !active.hasRelay ? ownerText(event.data) : undefined
        active.authorization = ordinary && input !== undefined ? ownerAuthorization(input, event.data.id) : undefined
        if (web && input !== undefined && !directIntent(input)) {
          const confirmed = ordinary && input.trim() === '确认发送' && draft?.expiresAt > performance.now() ? draft : undefined
          const intent = confirmed ? { kind: 'confirmed' } : naturalIntent(input)
          if (intent && (ordinary || intent.kind === 'literal')) {
            active.natural = { intent, confirmed, userMessageId: event.data.id, controller: new AbortController() }
          }
        }
        return
      }
      if (source?.kind === 'agent-message') {
        active.hasRelay = true
        active.authorization = undefined
      }
      const key = source?.bridgeReceiptKey
      if (source?.kind !== 'agent-message' || typeof key !== 'string' || !KEY.test(key)) return
      const record = read(receiptPath(key))
      if (record?.messageId === event.data.id && record.to === session.id &&
          record.from === source.senderSessionId && available(record.from)) {
        active.message = { key, id: event.data.id, record }
        messageActivity(record, 'executing')
      }
      return
    }
    if (event.type === 'assistant/message' && event.data.turn === active.turn) {
      if (active.message && !event.data.interrupted) active.replied = true
      const input = active.natural
      if (input?.draft) {
        const content = event.data.message.content.filter(({ type }) => type !== 'reasoning')
        input.previewShown = !event.data.interrupted && content.length === 1 &&
          content[0].type === 'text' && content[0].text === input.draft.preview
      }
      return
    }
    if (event.type !== 'turn/end' || event.data.turn !== active.turn) return
    const reason = event.data.reason.kind
    const draft = active.natural?.draft
    // The host publishes turn/end synchronously before claiming the next turn.
    // A queued reply can otherwise appear after the preview despite earlier admission.
    if (reason === 'completed' && active.natural?.previewShown && draft.expiresAt > performance.now() &&
        config.enabled.get() && available(draft.payload.to) && hasEmptyInbox(session)) {
      drafts.set(session.id, draft)
      setTimeout(() => {
        if (drafts.get(session.id) === draft) drafts.delete(session.id)
      }, draft.expiresAt - performance.now()).unref()
    }
    clearNatural(active)
    turns.delete(session.id)
    if (!active.message) return
    const { key, id, record } = active.message
    const processing = reason === 'completed' && active.replied ? 'processed' : 'not_completed'
    void Promise.resolve().then(async () => {
      if (await ctx.sessions.flush(session)) {
        write(dir, processingPath(key), {
          messageId: id, processing, turn: active.turn, endReason: reason, at: now(),
        }, true)
        messageActivity(record, processing === 'processed' ? 'processed' : 'uncertain')
      } else messageActivity(record, 'uncertain')
    }).catch(() => {
      messageActivity(record, 'uncertain')
      ctx.logger.warn('dsh-session-bridge could not persist turn evidence')
    })
  })

  const liveSenderId = (exec) => {
    const caller = exec?.agent
    const id = caller?.session?.id
    return validId(id) && ctx.agents.get(id) === caller ? id : undefined
  }
  const senderId = (exec) => {
    const id = liveSenderId(exec)
    if (available(id)) return id
  }
  const result = (key, record, duplicate = false) => {
    const turn = read(processingPath(key))
    const observed = turn?.messageId === record.messageId ? turn : undefined
    const live = turns.get(record.to)?.message?.id === record.messageId
    return {
      requestId: record.requestId, messageId: record.messageId, from: record.from, to: record.to,
      delivery: observed ? 'delivered' : record.delivery === 'reserved' ? 'unknown' : record.delivery,
      processing: observed?.processing ?? (live ? 'running' : 'unconfirmed'),
      ...(observed ? { turn: observed.turn, endReason: observed.endReason } : {}),
      ...(record.authorization?.job ? { task: record.authorization.task, job: record.authorization.job } : {}),
      ...(record.nativeMessageId ? { nativeMessageId: record.nativeMessageId } : {}),
      duplicate,
    }
  }
  const existingResult = (key, record, from, payloadHash) =>
    record?.from === from && record.payloadHash === payloadHash
      ? result(key, record, true) : { error: 'request_id_conflict' }

  const destinations = async (from, query, signal) => {
    const { items } = await ctx.sessionController.list({}, signal)
    return matchingTitles(items, query, (id) => id !== from && available(id))
  }

  async function deliver({ to, requestId, text }, exec, natural) {
    const from = senderId(exec)
    if (!from || from === to || !available(to)) return { error: 'route_not_allowed' }
    if (!config.enabled.get()) return { error: 'bridge_disabled' }
    if (!validId(requestId) || !validText(text)) {
      return { error: 'invalid_message' }
    }
    exec.signal.throwIfAborted()
    const key = sha([from, requestId])
    const path = receiptPath(key)
    const payloadHash = sha([to, text])
    const existing = read(path)
    if (existing) return existingResult(key, existing, from, payloadHash)
    if (!supportsOwnerPrompt) return { error: 'unsupported_dsh_authorization_source' }
    if (natural?.expiresAt <= performance.now()) return { error: 'message_authorization_required' }

    const active = turns.get(from)
    const approval = active?.authorization
    if (!approval || approval.used || approval.natural !== natural ||
        approval.to !== to || approval.requestId !== requestId ||
        approval.payloadHash !== payloadHash) return { error: 'message_authorization_required' }
    approval.used = true
    const record = {
      from, to, requestId, payloadHash, messageId: randomUUID(), delivery: 'reserved', at: now(),
      authorization: {
        kind: natural?.kind ?? 'native-owner-command', userMessageId: approval.userMessageId, turn: active.turn,
        ...(natural?.draftMessageId ? { draftMessageId: natural.draftMessageId } : {}),
      },
    }
    if (!write(dir, path, record, true)) {
      return existingResult(key, read(path), from, payloadHash)
    }

    inFlight.add(key)
    messageActivity(record, 'queued')
    let attempted = false
    try {
      if (web && !await existingWindow(persistence, available, to, exec.signal)) throw new Error('destination unavailable')
      const resolved = await ctx.sessionController.resolveAgent(to)
      if (natural) {
        const matches = await destinations(from, natural.query, exec.signal)
        if (matches.length !== 1 || matches[0].to !== to || matches[0].title !== natural.title ||
            turns.get(from)?.natural !== natural.input ||
            (natural.expiresAt !== undefined && natural.expiresAt <= performance.now())) {
          throw new Error('message authorization changed')
        }
      }
      exec.signal.throwIfAborted()
      const target = resolved.agent
      if (!target || target.session.id !== to || ctx.agents.get(to) !== target || !enabled() || senderId(exec) !== from ||
          !available(to) || turns.get(from)?.authorization !== approval) {
        throw new Error('destination unavailable')
      }
      attempted = true
      messageActivity(record, 'sending', true)
      target.followup({
        id: record.messageId, role: 'user',
        content: [{
          type: 'text',
          text: `[DSH 会话消息｜发送方 ${from}]\n${text}`,
        }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: from, bridgeReceiptKey: key },
      })
      record.delivery = await ctx.sessions.flush(target.session) ? 'delivered' : 'unknown'
    } catch {
      record.delivery = attempted ? 'unknown' : 'not_delivered'
    }
    inFlight.delete(key)
    record.settledAt = now()
    write(dir, path, record, false)
    const receipt = result(key, record)
    messageActivity(record, receipt.processing === 'processed' ? 'processed'
      : receipt.processing === 'running' ? 'executing'
        : receipt.processing === 'not_completed' || receipt.delivery === 'unknown' ? 'uncertain'
          : receipt.delivery === 'delivered' ? 'delivered' : 'failed')
    return receipt
  }

  const conversationHeading = (route) => `任务消息 · ${route.task} · ${route.from} → ${route.to}\n\n`

  function matchConversation(route, message) {
    const key = message.source?.bridgeReceiptKey
    if (!KEY.test(key ?? '') || message.role !== 'user' || message.source.kind !== 'agent-message' ||
        message.source.form !== 'relay' || message.source.bridgeWorkflowKind !== 'conversation' ||
        message.source.bridgeWorkflowTask !== route.task || message.source.bridgeWorkflowId !== route.id ||
        message.source.senderSessionId !== route.from ||
        message.content?.length !== 1 || message.content[0]?.type !== 'text') return false
    const record = read(receiptPath(key))
    const text = message.content[0].text
    const heading = conversationHeading(route)
    return record?.messageId === message.id && record.from === route.from && record.to === route.to &&
      record.authorization?.kind === 'native-workflow-conversation' &&
      record.authorization.job === route.id && record.authorization.task === route.task &&
      ['reserved', 'delivered', 'unknown'].includes(record.delivery) && text?.startsWith(heading) &&
      record.payloadHash === sha([route.to, text.slice(heading.length)])
  }

  function reserveConversation(route, requestId, text) {
    const { id, task, from, to } = route
    const key = sha([from, id, requestId])
    const path = receiptPath(key)
    const payloadHash = sha([to, text])
    const record = {
      from, to, requestId, payloadHash, messageId: randomUUID(), delivery: 'reserved', at: now(),
      authorization: { kind: 'native-workflow-conversation', job: id, task, ...(route.returning ? { returning: true } : {}) },
    }
    if (!write(dir, path, record, true)) {
      return { receipt: existingResult(key, read(path), from, payloadHash) }
    }
    inFlight.add(key)
    messageActivity(record, 'queued')
    let attempted = false
    function settle(delivery, reason) {
      if (record.delivery !== 'reserved') return
      record.delivery = delivery
      if (reason) record.reason = reason
      inFlight.delete(key)
      record.settledAt = now()
      write(dir, path, record, false)
      const receipt = result(key, record)
      messageActivity(record, receipt.processing === 'processed' ? 'processed'
        : receipt.processing === 'running' ? 'executing'
        : receipt.processing === 'not_completed' || delivery === 'unknown' ? 'uncertain'
          : delivery === 'delivered' ? 'delivered' : 'failed')
    }
    return {
      receipt: { ...result(key, record), task, job: id, delivery: 'queued' },
      async send(deadline, live, verifyTarget) {
        try {
          if (!live()) return
          const { agent } = await ctx.sessionController.resolveAgent(to)
          if (!agent || (verifyTarget && !await verifyTarget(deadline))) return
          deadline.throwIfAborted()
          if (ctx.agents.get(to) !== agent || !live()) return
          attempted = true
          messageActivity(record, 'sending', true)
          agent.followup({
            id: record.messageId, role: 'user',
            content: [{ type: 'text', text: conversationHeading(route) + text }],
            source: {
              kind: 'agent-message', form: 'relay', senderSessionId: from, bridgeReceiptKey: key,
              bridgeWorkflowKind: 'conversation', bridgeWorkflowId: id, bridgeWorkflowTask: task,
            },
          })
          settle(await ctx.sessions.flush(agent.session) ? 'delivered' : 'unknown')
        } finally {
          settle(attempted ? 'unknown' : 'not_delivered')
        }
      },
      stop: (reason) => settle(attempted ? 'unknown' : 'not_delivered', attempted ? undefined : reason),
    }
  }

  function sendNatural(active, input, frozen, exec) {
    const { payload, title, query, expiresAt, draftMessageId } = frozen
    const { to, requestId, text } = payload
    if (!input.authorization) {
      input.authorization = Object.freeze({
        input, title, query, expiresAt, draftMessageId,
        kind: draftMessageId ? 'native-owner-confirmation' : 'native-owner-text',
      })
      active.authorization = {
        to, requestId, payloadHash: sha([to, text]), userMessageId: input.userMessageId, used: false,
        natural: input.authorization,
      }
    }
    return deliver(payload, exec, input.authorization)
  }

  const nativeReceiptKey = (from, requestId) => sha([from, 'native-subagent', requestId])

  async function sendNativeMessage({ to, requestId, text }, exec, routeIsCurrent) {
    if (!subagents || !enabled() || exec.signal.aborted || !validId(to)) return
    const agent = exec.agent
    const from = liveSenderId(exec)
    if (!from || from === to) return
    const parent = agent.session.header?.parentSession
    if (parent && parent !== to) return
    const nativeParent = parent ?? from
    if (!available(nativeParent)) return
    const child = parent ? from : to
    const children = await subagents.listChildren(nativeParent, exec.signal).catch(() => [])
    if (!children.some(({ id, mode }) => id === child && mode === 'continuable') ||
        liveSenderId(exec) !== from || !available(nativeParent) || !available(child) || !enabled() || exec.signal.aborted || !routeIsCurrent()) return

    const key = nativeReceiptKey(from, requestId)
    const path = receiptPath(key)
    const payloadHash = sha([to, text])
    const record = {
      from, to, requestId, payloadHash, messageId: randomUUID(), delivery: 'reserved', at: now(),
      authorization: { kind: 'native-subagent', nativeParent },
    }
    if (!write(dir, path, record, true)) return existingResult(key, read(path), from, payloadHash)
    inFlight.add(key)
    messageActivity(record, 'sending', true)
    try {
      record.nativeMessageId = await subagents.sendMessage(agent, to, [{ type: 'text', text }], { signal: exec.signal })
      record.delivery = 'delivered'
    } catch {
      // Admission may precede an error. Preserve the receipt and never retry.
      record.delivery = 'unknown'
    }
    inFlight.delete(key)
    record.settledAt = now()
    write(dir, path, record, false)
    messageActivity(record, record.delivery === 'delivered' ? 'received' : 'uncertain')
    return result(key, record)
  }

  ctx.tools.register({
    name: 'send_session_message',
    description: 'For a bound ongoing workflow task, send substantive progress, a question or additional instructions to the exact controller or assigned worker. No additional approval is needed. Keep task content in text and use a stable request_id. With multiple active controller tasks, the native owner prompt must identify the window or task uniquely. If the host returns task choices, ask the owner to choose one. For native parent-child messaging, use the host send_message tool. For a one-way message outside a workflow, send the exact payload approved by the DSH owner command "授权互传 <to> <request_id>" followed by a newline and the message text. Relayed and ordinary messages do not grant approval. Reuse request_id to read an existing matching receipt.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['to', 'request_id', 'text'],
      properties: {
        to: { ...stringId, description: 'Exact destination Session ID' },
        request_id: { ...stringId, description: 'Stable request ID for this one send' },
        task: { ...stringId, description: 'Optional job ID or task ID for a bound workflow message' },
        text: { type: 'string', minLength: 1, maxLength: 2000 },
      },
    },
    output,
    async execute({ to, request_id: requestId, text, task }, exec) {
      if (!validId(requestId) || !validText(text) || task !== undefined && !validId(task)) return { error: 'invalid_message' }
      const from = senderId(exec)
      if (!from || from === to || !available(to)) return { error: 'route_not_allowed' }
      const legacy = turns.get(from)?.authorization
      if (!task && legacy && !legacy.natural && legacy.to === to && legacy.requestId === requestId &&
          legacy.payloadHash === sha([to, text])) return deliver({ to, requestId, text }, exec)
      const direct = workflow?.waitingForDirectQuestion(exec)
      if (direct) return direct
      const queued = await workflow?.queueMessage({ to, task, text, requestId }, exec)
      if (task || (queued && !queued.error)) return queued ?? { error: 'workflow_task_context_required' }
      // A background bridge task cannot decide the route of a native parent or
      // child. A task-bound turn or an explicit owner selection can.
      const nativeTurn = turns.get(from)
      const nativeRoute = () => turns.get(from) === nativeTurn && !nativeTurn?.authorization &&
        workflow?.permitsNativeRoute(from)
      if (nativeRoute()) {
        const receipt = await sendNativeMessage({ to, requestId, text }, exec, nativeRoute)
        if (receipt) return receipt
      }
      return queued ?? await deliver({ to, requestId, text }, exec)
    },
  })

  ctx.tools.register({
    name: 'send_natural_session_message',
    description: 'For an ongoing task, pass draft as the substantive message to its bound participant. The host chooses the unique task route. For an explicit one-way send in the current DSH owner prompt, e.g. “给审核窗口发消息：候选已就绪” or “把『候选已就绪』发给『合成查询』窗口”. Call with no arguments for exact owner text or the owner reply “确认发送”. Supply draft only when the owner asked to compose, edit or forward contextual text. When the result contains preview, copy its exact text as your entire final reply, preserving spaces and newlines, and wait for the owner. Ask the owner to restate any ambiguous request with a unique session title and the desired content.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { draft: { type: 'string', minLength: 1, maxLength: 2000 } },
    },
    output,
    async execute({ draft }, exec) {
      const from = senderId(exec)
      if (!from) return { error: 'route_not_allowed' }
      if (!web) return config.enabled.get()
        ? { error: 'unsupported_dsh_authorization_source' } : { error: 'bridge_disabled' }
      const active = turns.get(from)
      const input = active?.natural
      const direct = workflow?.waitingForDirectQuestion(exec)
      if (direct) return direct
      if (!input) {
        const queued = await workflow?.queueMessage({ text: draft }, exec)
        if (queued) return queued
      } else if (input.intent.kind === 'literal') {
        if (draft !== undefined) return { error: 'owner_text_cannot_be_replaced' }
        const queued = await workflow?.queueMessage({ text: input.intent.text, allowOrdinary: true }, exec)
        if (queued) return queued
      }
      if (!config.enabled.get()) return { error: 'bridge_disabled' }
      if (!input) return { error: 'message_authorization_required' }
      const { intent } = input
      const signal = AbortSignal.any([exec.signal, input.controller.signal])
      const current = () => !signal.aborted && config.enabled.get() &&
        senderId(exec) === from && turns.get(from)?.natural === input
      if (!current()) return { error: 'message_authorization_required' }
      if (intent.kind === 'confirmed') {
        if (draft !== undefined) return { error: 'owner_text_cannot_be_replaced' }
        return sendNatural(active, input, input.confirmed, exec)
      }
      if (intent.kind === 'missing_body') return { error: 'message_body_required' }
      const literal = intent.kind === 'literal'
      if (literal && draft !== undefined) return { error: 'owner_text_cannot_be_replaced' }
      const text = literal ? intent.text : draft
      if (!validText(text)) return { error: literal ? 'invalid_message' : 'message_draft_required' }
      const existing = input.frozen
      if (existing) {
        if (existing.payload.text !== text) return { error: 'request_id_conflict' }
        if (input.draft) return { confirmation: 'owner_reply_required', preview: input.draft.preview }
        return sendNatural(active, input, existing, exec)
      }

      const matches = await destinations(from, intent.title, signal).catch(() => undefined)
      if (!current()) return { error: 'message_authorization_required' }
      if (!matches) return { error: 'session_titles_unavailable' }
      if (matches.length !== 1) {
        return { error: matches.length ? 'ambiguous_session_title' : 'session_title_required', title: intent.title }
      }
      if (input.frozen) return { error: 'message_request_in_progress' }
      const [{ to, title }] = matches
      if (!available(to)) return { error: 'route_not_allowed' }
      const requestId = 'natural-' + sha([from, input.userMessageId])
      const payload = Object.freeze({ to, requestId, text })
      const destination = { payload, title, query: intent.title }
      input.frozen = Object.freeze(destination)
      if (literal) return sendNatural(active, input, input.frozen, exec)
      input.draft = Object.freeze({
        ...destination, preview: draftPreview(title, text),
        expiresAt: performance.now() + DRAFT_LIFETIME_MS, draftMessageId: input.userMessageId,
      })
      return { confirmation: 'owner_reply_required', preview: input.draft.preview }
    },
  })

  ctx.tools.register({
    name: 'session_message_status',
    description: 'Read this session’s delivery receipt. Include job for an independent workflow message. Native child messages include the host’s nativeMessageId when accepted.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['request_id'],
      properties: { request_id: stringId, job: stringId },
    },
    output,
    async execute({ request_id: requestId, job }, exec) {
      const from = liveSenderId(exec)
      if (!from) return { error: 'route_not_allowed' }
      if (!validId(requestId)) return { error: 'invalid_request_id' }
      if (job !== undefined && !validId(job)) return { error: 'invalid_job_id' }
      const key = sha(job === undefined ? [from, requestId] : [from, job, requestId])
      const record = read(receiptPath(key))
      if (record?.from === from && validId(record.to)) return result(key, record)
      if (job === undefined) {
        const nativeKey = nativeReceiptKey(from, requestId)
        const native = read(receiptPath(nativeKey))
        if (native?.from === from && native.authorization?.kind === 'native-subagent' &&
            validId(native.authorization.nativeParent)) return result(nativeKey, native)
      }
      return { error: available(from) ? 'receipt_not_found' : 'route_not_allowed' }
    },
  })
}
