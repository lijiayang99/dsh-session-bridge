import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { applyWorkflow } from './workflow.js'

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
  enabled: schema.boolean().default(false).volatile(),
  workflowEnabled: schema.boolean().default(false).volatile(),
  allowedSessions: schema.array(schema.string().pattern(/^[a-zA-Z0-9_-]{1,128}$/))
    .max(32).default([]).volatile(),
})
export const inject = ['agents', 'sessions', 'sessionController', 'tools', 'workspaceRegistry']

const ID = /^[a-zA-Z0-9_-]{1,128}$/
const KEY = /^[a-f0-9]{64}$/
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const now = () => new Date().toISOString()
const validId = (value) => typeof value === 'string' && ID.test(value)
const validText = (value) => typeof value === 'string' && value.length <= 2000 &&
  value.trim().length > 0 && Buffer.byteLength(value) <= 8000
const authorizationCommand = /^授权互传 ([a-zA-Z0-9_-]{1,128}) ([a-zA-Z0-9_-]{1,128})\r?\n([\s\S]+)$/

// In DSH 0.2.2-rc.1, the Host omits the owner principal and records non-owner
// principals explicitly. rpcId is supplied by the native prompt admission.
function ownerAuthorization(message) {
  const { source, content, id } = message
  if (message.role !== 'user' || source?.kind !== 'user' ||
      source.principal !== undefined || !validId(source.rpcId) || !validId(id) ||
      !Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' ||
      typeof content[0].text !== 'string' || content[0].text.length > 2300) return undefined
  const match = authorizationCommand.exec(content[0].text)
  if (!match || !validText(match[3])) return undefined
  const [, to, requestId, text] = match
  return { to, requestId, payloadHash: sha([to, text]), userMessageId: id, used: false }
}

function read(path) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally {
    closeSync(fd)
  }
}

function write(dir, path, record, exclusive) {
  const tmp = join(dir, `.${randomUUID()}.tmp`)
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, JSON.stringify(record) + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (exclusive) {
      try {
        linkSync(tmp, path)
      } catch (error) {
        if (error.code === 'EEXIST') return false
        throw error
      }
    } else {
      renameSync(tmp, path)
    }
    const directory = openSync(dir, 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
    return true
  } finally {
    try { unlinkSync(tmp) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
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
  const allowed = (id) => typeof id === 'string' && config.allowedSessions.get().includes(id)
    && !ctx.workspaceRegistry.archivedSessionIds.includes(id)
  if (supportsOwnerPrompt) {
    ctx.inject(['profileContext', 'sessionPersistence'], (workflowCtx) => {
      if (workflowCtx.profileContext.name === 'web') applyWorkflow(workflowCtx, config, allowed)
    })
  }
  const receiptPath = (key) => join(dir, key + '.json')
  const processingPath = (key) => join(dir, key + '.turn.json')

  // Only native turn events tied to our exact message ID can settle processing.
  const turns = new Map()
  ctx.on('session/event', (session, event) => {
    if (!allowed(session.id)) {
      turns.delete(session.id)
      return
    }
    if (event.type === 'turn/start') {
      turns.set(session.id, { turn: event.data.turn, message: null, replied: false, hasRelay: false })
      return
    }
    const active = turns.get(session.id)
    if (!active) return
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source?.kind === 'user') {
        active.authorization = !active.hasRelay && config.enabled.get()
          ? ownerAuthorization(event.data) : undefined
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
          record.from === source.senderSessionId && allowed(record.from)) {
        active.message = { key, id: event.data.id }
      }
      return
    }
    if (event.type === 'assistant/message' && active.message &&
        event.data.turn === active.turn && !event.data.interrupted) {
      active.replied = true
      return
    }
    if (event.type !== 'turn/end' || event.data.turn !== active.turn) return
    turns.delete(session.id)
    if (!active.message) return
    const { key, id } = active.message
    const reason = event.data.reason.kind
    const processing = reason === 'completed' && active.replied ? 'processed' : 'not_completed'
    void Promise.resolve().then(async () => {
      if (await ctx.sessions.flush(session)) {
        write(dir, processingPath(key), {
          messageId: id, processing, turn: active.turn, endReason: reason, at: now(),
        }, true)
      }
    }).catch(() => ctx.logger.warn('dsh-session-bridge could not persist turn evidence'))
  })

  const senderId = (exec) => {
    const caller = exec?.agent
    const id = caller?.session?.id
    return allowed(id) && ctx.agents.get(id) === caller ? id : undefined
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
      duplicate,
    }
  }
  const existingResult = (key, record, from, payloadHash) =>
    record?.from === from && record.payloadHash === payloadHash
      ? result(key, record, true) : { error: 'request_id_conflict' }

  ctx.tools.register({
    name: 'send_session_message',
    description: 'Send the exact payload approved in this turn by the DSH owner command "授权互传 <to> <request_id>" followed by a newline and the message text. Relayed and ordinary messages do not grant approval. Reuse request_id to read an existing matching receipt.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['to', 'request_id', 'text'],
      properties: {
        to: { ...stringId, description: 'Exact destination Session ID' },
        request_id: { ...stringId, description: 'Stable request ID for this one send' },
        text: { type: 'string', minLength: 1, maxLength: 2000 },
      },
    },
    output,
    async execute({ to, request_id: requestId, text }, exec) {
      const from = senderId(exec)
      if (!from || from === to || !allowed(to)) return { error: 'route_not_allowed' }
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

      const active = turns.get(from)
      const approval = active?.authorization
      if (!approval || approval.used || approval.to !== to || approval.requestId !== requestId ||
          approval.payloadHash !== payloadHash) return { error: 'message_authorization_required' }
      approval.used = true
      const record = {
        from, to, requestId, payloadHash, messageId: randomUUID(), delivery: 'reserved', at: now(),
        authorization: { kind: 'native-owner-command', userMessageId: approval.userMessageId, turn: active.turn },
      }
      if (!write(dir, path, record, true)) {
        return existingResult(key, read(path), from, payloadHash)
      }

      let attempted = false
      try {
        const resolved = await ctx.sessionController.resolveAgent(to)
        exec.signal.throwIfAborted()
        const target = resolved.agent
        if (!target || target.session.id !== to || !config.enabled.get() || senderId(exec) !== from ||
            !allowed(to) || turns.get(from)?.authorization !== approval) {
          throw new Error('destination unavailable')
        }
        attempted = true
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
      write(dir, path, record, false)
      return result(key, record)
    },
  })

  ctx.tools.register({
    name: 'session_message_status',
    description: 'Read the inbox delivery and turn-processing receipts for a message this Session sent. Does not open the destination conversation.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['request_id'],
      properties: { request_id: stringId },
    },
    output,
    async execute({ request_id: requestId }, exec) {
      const from = senderId(exec)
      if (!from) return { error: 'route_not_allowed' }
      if (typeof requestId !== 'string' || !ID.test(requestId)) return { error: 'invalid_request_id' }
      const key = sha([from, requestId])
      const record = read(receiptPath(key))
      return record?.from === from && allowed(record.to)
        ? result(key, record)
        : { error: 'receipt_not_found' }
    },
  })
}
