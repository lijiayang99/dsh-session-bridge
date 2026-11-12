import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ID, validId } from './bridge-input.js'
import { read, write } from './receipt-store.js'

// A linked local bundle resolves the schema from the running DSH CLI.
const cli = realpathSync(process.argv[1])
const schema = createRequire(cli)('@deepseek-ai/schemastery')
const supported = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8'))
    return pkg.name === '@deepseek-ai/dsh' && pkg.version === '0.2.2-rc.1'
  } catch {
    return false
  }
})()

export const name = 'dsh-session-bridge-settings'
const sessionList = () => schema.array(schema.string().pattern(ID)).max(32).default([]).volatile()
export const Config = schema.object({
  messagingEnabled: schema.boolean().default(false).volatile()
    .extra('dshSessionBridgeHost', supported ? 'supported' : 'unsupported'),
  messagingSessions: sessionList(),
  // Previous packages read these keys on rollback.
  enabled: schema.boolean().default(false).volatile(),
  workflowEnabled: schema.boolean().default(false).volatile(),
  allowedSessions: sessionList(),
})

export const inject = ['agents', 'sessions', 'sessionController', 'tools', 'workspaceRegistry']

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const now = () => new Date().toISOString()
const receiptKey = /^[a-f0-9]{64}$/
const textLimit = 2000
const stringId = { type: 'string', pattern: ID.source, maxLength: 128 }
const failure = (error) => ({ error })

function independentRow(row) {
  return validId(row.sessionId) && !row.blank && !row.parentSessionId && row.origin !== 'subagent'
}

function selectTarget(items, to) {
  const exactId = items.find((row) => row.sessionId === to)
  if (exactId) return { id: exactId.sessionId }
  const matches = items.filter((row) => row.projections?.values?.title === to)
  if (matches.length > 1) return failure('ambiguous_session_title')
  if (matches.length === 1) return { id: matches[0].sessionId, title: to }
  return failure('destination_not_found')
}

export function apply(ctx, config) {
  if (!supported) return
  ctx.inject(['profileContext', 'sessionPersistence'], (scope) => {
    if (scope.profileContext.name === 'web') applyWeb(scope, config)
  })
}

function applyWeb(ctx, config) {
  const home = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
  const dir = join(home, 'dsh-session-bridge', 'receipts')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'dsh-session-bridge lifetime')

  const enabled = () => !lifetime.signal.aborted && config.messagingEnabled.get()
  const available = (id) => validId(id) && !ctx.workspaceRegistry.archivedSessionIds.includes(id)
  const selected = (id) => available(id) && config.messagingSessions.get().includes(id)
  const receiptPath = (key) => join(dir, key + '.json')
  const processingPath = (key) => join(dir, key + '.turn.json')
  const turns = new Map()

  // Native receipts may be consumed by one turn together. Settle each exact
  // message separately after the host has durably recorded the turn.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      turns.set(session.id, { turn: event.data.turn, received: new Map(), replied: false })
      return
    }
    const turn = turns.get(session.id)
    if (!turn) return
    if (event.type === 'user/message') {
      const { source, id } = event.data
      const key = source?.bridgeReceiptKey
      if (source?.kind !== 'agent-message' || !receiptKey.test(key ?? '')) return
      try {
        const record = read(receiptPath(key))
        if (record?.messageId === id && record.to === session.id && record.from === source.senderSessionId) {
          turn.received.set(key, id)
        }
      } catch {
        ctx.logger.warn('dsh-session-bridge could not read a receipt')
      }
      return
    }
    if (event.data.turn !== turn.turn) return
    if (event.type === 'assistant/message' && !event.data.interrupted) turn.replied = true
    if (event.type !== 'turn/end') return
    turns.delete(session.id)
    if (!turn.received.size) return
    const endReason = event.data.reason.kind
    const processing = endReason === 'completed' && turn.replied ? 'processed' : 'not_completed'
    void Promise.resolve().then(async () => {
      if (!await ctx.sessions.flush(session)) return
      for (const [key, messageId] of turn.received) {
        write(dir, processingPath(key), { messageId, processing, turn: turn.turn, endReason, at: now() }, true)
      }
    }).catch(() => ctx.logger.warn('dsh-session-bridge could not persist receipt processing'))
  })
  ctx.on('session/disposed', (session) => turns.delete(session.id))

  function sender(exec) {
    const agent = exec?.agent
    const id = agent?.session?.id
    if (validId(id) && ctx.agents.get(id) === agent) return id
  }

  async function catalog(signal) {
    const { items } = await ctx.sessionController.list({}, signal)
    return items.filter(independentRow)
  }

  async function existing(id, signal) {
    const entry = await ctx.sessionPersistence.stat(id, { signal })
    return Boolean(entry?.sizeBytes && entry.header.cwd &&
      entry.header.origin !== 'subagent' && !entry.header.parentSession)
  }

  function receipt(key, record, duplicate = false) {
    const turn = read(processingPath(key))
    const observed = turn?.messageId === record.messageId ? turn : undefined
    const running = turns.get(record.to)?.received.get(key) === record.messageId
    return {
      requestId: record.requestId, messageId: record.messageId, from: record.from, to: record.to,
      delivery: observed ? 'delivered' : record.delivery === 'reserved' ? 'unknown' : record.delivery,
      processing: observed?.processing ?? (running ? 'running' : 'unconfirmed'),
      ...(observed ? { turn: observed.turn, endReason: observed.endReason } : {}),
      ...(record.authorization?.job ? { task: record.authorization.task, job: record.authorization.job } : {}),
      ...(record.nativeMessageId ? { nativeMessageId: record.nativeMessageId } : {}),
      duplicate,
    }
  }

  function readStatus(from, requestId, job) {
    const key = hash(job ? [from, job, requestId] : [from, requestId])
    const record = read(receiptPath(key))
    if (record?.from === from && validId(record.to)) return receipt(key, record)
    if (!job) {
      const nativeKey = hash([from, 'native-subagent', requestId])
      const native = read(receiptPath(nativeKey))
      if (native?.from === from && native.authorization?.kind === 'native-subagent' &&
          validId(native.authorization.nativeParent)) return receipt(nativeKey, native)
    }
    return failure('receipt_not_found')
  }

  async function deliver(exec, from, request, signal) {
    const { to, text } = request
    const items = await catalog(signal)
    if (!items.some((item) => item.sessionId === from) || !selected(from)) return failure('source_not_allowed')
    const target = selectTarget(items, to)
    if (target.error) return target
    if (target.id === from || !selected(target.id)) return failure('destination_not_allowed')
    if (!await existing(target.id, signal)) return failure('destination_not_available')
    const { agent } = await ctx.sessionController.resolveAgent(target.id)
    const current = await catalog(signal)
    const live = selectTarget(current, to)
    signal.throwIfAborted()
    if (!enabled()) return failure('bridge_disabled')
    if (sender(exec) !== from || !selected(from) || !current.some((item) => item.sessionId === from)) {
      return failure('source_not_allowed')
    }
    if (!selected(target.id)) return failure('destination_not_allowed')
    if (live.id !== target.id || live.title !== target.title) return failure('destination_changed')
    if (!agent || agent.session.id !== target.id || ctx.agents.get(target.id) !== agent) {
      return failure('destination_not_available')
    }

    const turn = ctx.agents.turnBoundaryOf(exec.agent.session).openTurnStartSeq
    const requestId = request.request_id ?? 'message-' + hash([from, turn ?? exec.callId, target.id, text])
    const key = hash([from, requestId])
    const path = receiptPath(key)
    const payloadHash = hash([target.id, text])
    const duplicate = () => {
      const saved = read(path)
      return saved?.from === from && saved.payloadHash === payloadHash
        ? receipt(key, saved, true) : failure('request_id_conflict')
    }
    const record = { from, to: target.id, requestId, payloadHash, messageId: randomUUID(),
      delivery: 'reserved', at: now(), authorization: { kind: 'manual-allowlist' } }
    if (!write(dir, path, record, true)) return duplicate()
    try {
      agent.followup({
        id: record.messageId, role: 'user',
        content: [{ type: 'text', text: '[DSH 会话消息｜发送方 ' + from + ']\n' + text }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: from, bridgeReceiptKey: key },
      })
      record.delivery = await ctx.sessions.flush(agent.session) ? 'delivered' : 'unknown'
    } catch {
      // The host may already have admitted it. The reservation prevents resend.
      record.delivery = 'unknown'
    }
    record.settledAt = now()
    write(dir, path, record, false)
    return receipt(key, record)
  }

  ctx.tools.register({
    name: 'workflow_message',
    description: 'Communicate with existing DSH windows on the user’s allowlist. Call without arguments or use action=list to discover reachable titles and IDs. To send a message, question, update, or result, provide to (exact title or ID) and text. You may send multiple messages as work progresses and reply to the sender ID in a received message. Send replies when useful and finish the exchange after the result. Use action=status with request_id to read your receipt. Reuse an explicit request_id to retry the same logical message across turns. Use the host send_message for native subagents.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'send', 'status'] },
        to: { type: 'string', minLength: 1, maxLength: 200 },
        text: { type: 'string', minLength: 1, maxLength: textLimit },
        request_id: stringId,
        job: stringId,
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const from = sender(exec)
      if (!from) return failure('source_not_allowed')
      if (!args || Object.keys(args).some((key) => !['action', 'to', 'text', 'request_id', 'job'].includes(key))) {
        return failure('invalid_arguments')
      }
      const { to, text, request_id: requestId, job } = args
      const action = args.action ?? (to !== undefined || text !== undefined ? 'send' : requestId !== undefined ? 'status' : 'list')
      const signal = AbortSignal.any([exec.signal, lifetime.signal])
      try {
        if (action === 'status' && to === undefined && text === undefined && validId(requestId) &&
            (job === undefined || validId(job))) return readStatus(from, requestId, job)
        if (!enabled()) return failure('bridge_disabled')
        if (!selected(from)) return failure('source_not_allowed')
        if (action === 'list' && to === undefined && text === undefined && requestId === undefined && job === undefined) {
          const items = await catalog(signal)
          signal.throwIfAborted()
          if (!enabled()) return failure('bridge_disabled')
          if (sender(exec) !== from || !selected(from) || !items.some((item) => item.sessionId === from)) {
            return failure('source_not_allowed')
          }
          return { sessions: items.filter(({ sessionId }) => sessionId !== from && selected(sessionId))
            .map(({ sessionId, projections }) => ({ id: sessionId, title: projections?.values?.title ?? '' })) }
        }
        if (action === 'send' && typeof to === 'string' && to.trim() && to.length <= 200 &&
            typeof text === 'string' && text.trim() && text.length <= textLimit && Buffer.byteLength(text) <= 8000 &&
            (requestId === undefined || validId(requestId)) && job === undefined) {
          return await deliver(exec, from, args, signal)
        }
        return failure('invalid_arguments')
      } catch {
        return failure(signal.aborted ? 'operation_cancelled' : 'bridge_unavailable')
      }
    },
  })
}
