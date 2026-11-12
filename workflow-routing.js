import { matchingTitles, naturalIntent, plainText } from './natural-message.js'
import { planTarget } from './workflow-authorization.js'
import { UUID, batchOf, denied, scopedGrant, stateOf, taskKey } from './workflow-state.js'

export async function existingWindow(persistence, available, id, signal) {
  if (!available(id)) return false
  const stored = await persistence.stat(id, { signal })
  return Boolean(stored?.sizeBytes && stored.header.cwd &&
    stored.header.origin !== 'subagent' && !stored.header.parentSession)
}

export function workflowRouting({ available, enabled, claimedHere, ledger, current, bounded, signal, windows, workspaceRegistry, withdrawn }) {
  const activeGrant = (grant) => scopedGrant(grant) && !grant.admission?.rejected && stateOf(grant) === 'active'
  const batchResult = (grant, job, kind) => kind === 'result' && job.batch &&
    batchOf(grant, job.batch)?.anchor === job.id
  const authorized = (grant, job, kind) => scopedGrant(grant) && grant.owner === job.owner &&
    grant.scopes.some(({ name, targets }) => name === job.scope && targets.includes(job.target)) &&
    available(job.owner) && (available(job.target) || batchResult(grant, job, kind)) &&
    (activeGrant(grant) || (kind === 'result' && stateOf(grant) === 'paused' &&
      (batchResult(grant, job, kind) || job.report?.status === 'needs_owner')))
  const canRoute = (grant, job, kind) => enabled() && !grant?.admission && authorized(grant, job, kind) && !withdrawn(job.owner, grant.task)

  const participantPair = (job, from, to) =>
    from === job.owner && to === job.target || from === job.target && to === job.owner

  function conversationRoute(grant, job, from, to, transport = true) {
    if (!job?.conversation || !grant?.conversation || grant.owner !== job.owner ||
        !grant.scopes.some(({ name, targets }) => name === job.scope && targets.includes(job.target)) ||
        !(transport ? canRoute(grant, job, 'task') : authorized(grant, job, 'task')) || job.report || job.wake.state !== 'claimed' ||
        !claimedHere.has(job.id) || !participantPair(job, from, to)) return
    return { id: job.id, task: grant.task, from, to, returning: from === job.target }
  }

  async function ownerTaskTarget(owner, title, deadline) {
    const { items } = await windows(deadline)
    const target = planTarget(items, workspaceRegistry, owner, title)
    if (target?.to) return target
  }

  async function verifyTarget(grant, job, deadline) {
    const auth = grant?.authorization
    const target = auth?.targets?.find(({ id }) => id === job.target)
    if (!target) return !auth
    const { items } = await windows(deadline)
    const bindings = auth.bindings?.filter(([, expected]) => expected.id === job.target)
    if (bindings?.length) return bindings.every(([query, expected]) => {
      const live = planTarget(items, workspaceRegistry, job.owner, query)
      return live?.to === target.id && live.title === target.title && live.workspace === expected.workspace
    })
    const selector = auth.context?.selector
    if (selector?.kind === 'alias') {
      const live = planTarget(items, workspaceRegistry, job.owner, selector.value + '窗口')
      return live?.to === target.id && live.title === target.title && live.workspace === auth.context.workspace
    }
    const matches = matchingTitles(items, target.title, () => true)
    return matches.length === 1 && matches[0].to === target.id && matches[0].title === target.title
  }

  function taskChoices(grants, jobs) {
    return jobs.map((job) => ({
      task: grants[job.key]?.task, job: job.id, goal: grants[job.key]?.goal, to: job.target,
      title: grants[job.key]?.authorization?.targets?.find(({ id }) => id === job.target)?.title,
    }))
  }

  function taskReferences(owner, input, { grants, jobs }) {
    const references = new Set(input.match(/[a-zA-Z0-9_-]+/g))
    const joined = Object.values(jobs).filter((job) => job.conversation && job.owner === owner)
    const named = joined.filter((job) => references.has(job.id) || references.has(grants[job.key]?.task))
    const stale = !named.length && [...references].some((ref) => {
      if (/^direct-[a-f0-9]{64}$/u.test(ref)) return true
      if (ledger.history.grant(taskKey(owner, ref))?.conversation) return true
      const prior = UUID.test(ref) && ledger.history.job(ref)
      return prior?.conversation && prior.owner === owner
    })
    return { joined, named, stale }
  }

  function permitsNativeRoute(owner, turn) {
    const mode = turn?.context?.mode
    if (turn?.mixed || (mode && mode !== 'owner' && mode !== 'other')) return false
    if (!turn?.ownerMessage) return true
    const input = plainText(turn.ownerMessage)
    if (!input || naturalIntent(input)) return false
    const { named, stale } = taskReferences(owner, input, ledger.read())
    return !named.length && !stale
  }

  async function ownerTaskMessage({ to, task, text, allowOrdinary }, from, exec, caller, state) {
    const { context, turn } = caller ?? {}
    const input = turn?.ownerMessage && plainText(turn.ownerMessage)
    const owned = (state) => Object.values(state.jobs).filter((job) => job.conversation && job.owner === from)
    if (!owned(state).length && !task) return
    if (!input || !['owner', 'main'].includes(context.mode) ||
        /^(?:DSH-WORKFLOW (?:TASK|RESULT)\b|任务消息 · )/u.test(input)) return denied('workflow_task_context_required')

    const intent = naturalIntent(input)
    let target
    let verifyTarget
    if (intent) {
      const deadline = AbortSignal.any([signal, exec.signal, AbortSignal.timeout(5000)])
      target = await bounded(() => ownerTaskTarget(from, intent.title, deadline), deadline).catch(() => undefined)
      const live = current(exec)
      if (!enabled() || live?.turn !== turn || live.context !== context) return denied('workflow_task_context_required')
      state = ledger.read()
      if (!target) {
        const { grants } = state
        const eligible = owned(state).filter((job) => conversationRoute(grants[job.key], job, from, job.target))
        return { error: 'workflow_task_target_required', title: intent.title, tasks: taskChoices(grants, eligible) }
      }
      if (to !== undefined && to !== target.to) return denied('workflow_task_mismatch')
      if (intent.kind === 'literal' && text !== intent.text) return denied('owner_text_cannot_be_replaced')
      verifyTarget = async (deadline) => {
        const live = await ownerTaskTarget(from, intent.title, deadline)
        return live?.to === target.to && live.title === target.title && live.workspace === target.workspace
      }
    }

    const { grants } = state
    const { joined, named, stale } = taskReferences(from, input, state)
    if (stale) return denied('workflow_task_route_inactive')

    // Only constraints supplied by the native turn can select a task.
    const candidates = named.length ? named : joined.filter((job) =>
      conversationRoute(grants[job.key], job, from, job.target))
    if (allowOrdinary && target && !named.length && context.mode === 'owner' &&
        !joined.some((job) => job.target === target.to && !job.report &&
          ['active', 'paused', 'authorizing', 'closing'].includes(stateOf(grants[job.key])))) return
    let eligible = candidates.filter((job) =>
      (!target || job.target === target.to) && (context.mode !== 'main' || job.key === context.key))
    // A native task selection can authorize a choice among its own workers.
    const referencedKey = named[0]?.key
    const selectedKey = context.mode === 'main' ? context.key
      : named.every((job) => job.key === referencedKey) ? referencedKey : undefined
    if (eligible.length > 1 && selectedKey && to !== undefined && eligible.every((job) => job.key === selectedKey)) {
      eligible = eligible.filter((job) => job.target === to)
      if (!eligible.length) return denied('workflow_task_mismatch')
    }
    if (eligible.length > 1) return {
      error: 'workflow_task_reference_required',
      tasks: taskChoices(grants, eligible),
    }
    const [job] = eligible
    if (!job) return denied(named.length ? 'workflow_task_mismatch' : 'workflow_task_route_inactive')
    const grant = grants[job.key]
    if (to !== undefined && to !== job.target || task && task !== job.id && task !== grant?.task) {
      return denied('workflow_task_mismatch')
    }
    return { job, grant, verifyTarget, literal: intent?.kind === 'literal' }
  }
  return { activeGrant, authorized, canRoute, verifyTarget, participantPair, conversationRoute, ownerTaskMessage, permitsNativeRoute }
}
