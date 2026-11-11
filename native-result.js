import { createHash, randomUUID } from 'node:crypto'

const omittedClosingText = 'It sent you a message just before finishing, so its closing message is omitted.'
const textBlocks = (content) => (content ?? []).filter(({ type, text }) =>
  type === 'text' && typeof text === 'string' && text.length).map(({ text }) => text)
const fingerprint = (texts) => createHash('sha256').update(texts.join('\n').trim()).digest('hex')

export function observeNativeResults(ctx, enabled, allowed, activity) {
  const runs = new Map()

  ctx.on('subagent/start', ({ id, runId, provider, local }) => {
    if (!enabled() || !local || provider !== 'spawn') return
    const child = ctx.agents.get(id)
    const parent = ctx.agents.get(child?.session.header.parentSession)
    if (!parent || !allowed(parent.id)) return
    runs.set(id, { runId, parent, forwarded: new Set(), omitted: false })
  })

  function observe(session, message, admitted) {
    const source = message.source
    const child = source?.senderSessionId
    const run = runs.get(child)
    if (!run || run.parent.session !== session || message.role !== 'user') return
    const texts = textBlocks(message.content)
    if (source.kind === 'agent-message' && source.form === 'relay' &&
        texts[0] === `Agent ${child} sent a message: ` && texts.length > 1) {
      if (run.forwarded.size >= 128) run.overflow = true
      else run.forwarded.add(fingerprint(texts.slice(1)))
    }
    if (admitted && source.kind === 'subagent-settled' && source.form === 'notice') {
      run.omitted = texts[1] === omittedClosingText
    }
  }

  ctx.on('session/event', (session, { type, data }) => {
    if (!runs.size) return
    if (type === 'agent/inbox/spliced') for (const message of data.inserted) observe(session, message, true)
    if (type === 'user/message') observe(session, data)
  })

  ctx.on('subagent/end', ({ id, runId, local, provider, stopReason, lastAssistantMessage }) => {
    const run = runs.get(id)
    if (!run || run.runId !== runId) return
    runs.delete(id)
    const { parent } = run
    if (!local || provider !== 'spawn' || stopReason !== 'completed' || !run.omitted || run.overflow ||
        !enabled() || !allowed(parent.id) || ctx.agents.get(parent.id) !== parent) return
    const texts = textBlocks(lastAssistantMessage)
    if (!texts.some((text) => text.trim()) || run.forwarded.has(fingerprint(texts))) return

    const message = {
      id: randomUUID(), role: 'user',
      content: [{ type: 'text', text: '子代理回报 · ' + id + '\n\n' + texts.join('\n') }],
      source: {
        kind: 'agent-message', form: 'relay', senderSessionId: id,
        bridgeWorkflowKind: 'native-result', bridgeWorkflowId: runId, bridgeWorkflowOwner: parent.id,
      },
    }
    const route = { key: message.id, from: id, to: parent.id, kind: 'result', nativeParent: parent.id }
    try {
      parent.followup(message)
      activity.record({ ...route, state: 'sending' }, true)
    } catch {
      activity.record({ ...route, state: 'uncertain' })
      return
    }
    return Promise.resolve(ctx.sessions.flush(parent.session)).then(
      (flushed) => activity.record({ ...route, state: flushed ? 'delivered' : 'uncertain' }),
      () => activity.record({ ...route, state: 'uncertain' }),
    )
  })
}
