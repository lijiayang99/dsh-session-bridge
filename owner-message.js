import { createHash } from 'node:crypto'
import { nativeOwner } from './bridge-input.js'
import { draftPreview, matchingTitles, naturalIntent, plainText } from './natural-message.js'
import { planTarget } from './workflow-authorization.js'

const legacy = /^授权互传 ([a-zA-Z0-9_-]{1,128}) ([a-zA-Z0-9_-]{1,128})\r?\n([\s\S]+)$/
const draftLifetime = 120_000
const validText = (text) => typeof text === 'string' && text.trim() && text.length <= 2000 && Buffer.byteLength(text) <= 8000
const requestKey = (owner, messageId) => 'natural-' +
  createHash('sha256').update(JSON.stringify([owner, messageId])).digest('hex')

export function ownerMessages(ctx, { enabled, available, signal, existing, cleanInbox }) {
  const drafts = new Map()

  async function resolve(owner, title, deadline) {
    const { items } = await ctx.sessionController.list({}, deadline)
    const target = planTarget(items, ctx.workspaceRegistry, owner, title)
    if (!target?.to) {
      const ambiguous = target?.error === 'workflow_context_alias_conflict' ||
        matchingTitles(items, title, () => true).length > 1
      return { error: ambiguous ? 'ambiguous_session_title' : 'session_title_required' }
    }
    if (target.to === owner || !available(target.to)) return { error: 'route_not_allowed' }
    return target
  }

  function input(session, turn, message) {
    const draft = drafts.get(session.id)
    drafts.delete(session.id)
    if (turn.mixed || !enabled() || !nativeOwner(message)) return
    const text = plainText(message)
    if (typeof text !== 'string' || text.length > 2300) return
    const id = message.id
    const command = legacy.exec(text)
    if (command && validText(command[3])) {
      return { mode: 'owner-message', kind: 'command', messageId: id,
        payload: { to: command[1], requestId: command[2], text: command[3] } }
    }
    if (text.trim() === '确认发送' || draft && /^(?:确认|好|好的|可以|同意)[。！!]?$/u.test(text.trim())) {
      return { mode: 'owner-message', kind: 'confirmed', messageId: id,
        ...(draft?.expiresAt > performance.now() ? { draft } : {}) }
    }
    const intent = naturalIntent(text)
    if (!intent) return
    const { kind, title } = intent
    return { mode: 'owner-message', kind, messageId: id, query: title, text: intent.text,
      initial: resolve(session.id, title, AbortSignal.any([signal, AbortSignal.timeout(5000)]))
        .catch(() => ({ error: 'session_titles_unavailable' })) }
  }

  function reply(turn, event) {
    const { context } = turn
    if (turn.mixed || context?.mode !== 'owner-message' || context.kind !== 'draft' ||
        !context.draft || event.data.turn !== turn.number) return
    const content = event.data.message.content.filter(({ type }) => type !== 'reasoning')
    context.previewShown = !event.data.interrupted && content.length === 1 &&
      content[0].type === 'text' && content[0].text === context.draft.preview
  }

  function end(session, turn, event) {
    const { context } = turn
    if (!enabled() || turn.mixed || context?.mode !== 'owner-message' || context.kind !== 'draft' ||
        event.data.reason.kind !== 'completed' || !context.previewShown ||
        !(context.draft.expiresAt > performance.now()) || !cleanInbox(ctx.agents.get(session.id))) return
    const { draft } = context
    drafts.set(session.id, draft)
    setTimeout(() => {
      if (drafts.get(session.id) === draft) drafts.delete(session.id)
    }, Math.max(0, draft.expiresAt - performance.now())).unref()
  }

  async function freeze(caller, text, deadline, current) {
    const { id, context } = caller
    if (!validText(text)) return { error: 'invalid_message' }
    const first = await context.initial
    if (!current()) return { error: 'message_authorization_required' }
    if (!first?.to) return first ?? { error: 'session_title_required' }
    const verifyTarget = async (signal) => {
      const live = await resolve(id, context.query, signal)
      return live?.to === first.to && live.title === first.title && live.workspace === first.workspace
    }
    if (!await existing(first.to, deadline) || !await verifyTarget(deadline) || !current()) {
      return { error: 'workflow_target_changed' }
    }
    return { target: first, verifyTarget, to: first.to, text, requestId: requestKey(id, context.messageId) }
  }

  async function prepare(caller, text, deadline, current) {
    const { context } = caller
    if (!validText(text)) return { error: 'message_draft_required' }
    if (context.draft) return context.draft.text === text
      ? { confirmation: 'owner_reply_required', preview: context.draft.preview } : { error: 'request_id_conflict' }
    const frozen = await freeze(caller, text, deadline, current).catch(() => ({ error: 'session_titles_unavailable' }))
    if (frozen.error) return frozen
    if (context.draft) return context.draft.text === text
      ? { confirmation: 'owner_reply_required', preview: context.draft.preview } : { error: 'request_id_conflict' }
    const preview = draftPreview(frozen.target.title, text)
    context.draft = { ...frozen, preview, expiresAt: performance.now() + draftLifetime, draftMessageId: context.messageId }
    return { confirmation: 'owner_reply_required', preview }
  }

  async function plan(caller, deadline, current) {
    const { context } = caller
    if (context.kind === 'command') return context.payload
    if (context.kind === 'confirmed') {
      const { draft } = context
      if (!draft || !(draft.expiresAt > performance.now())) return { error: 'message_authorization_required' }
      return draft
    }
    if (context.kind === 'literal') {
      return freeze(caller, context.text, deadline, current).catch(() => ({ error: 'session_titles_unavailable' }))
    }
    return { error: 'message_body_required' }
  }

  return { input, reply, end, prepare, plan }
}
