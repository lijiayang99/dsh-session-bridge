import { matchingTitles, plainText } from './natural-message.js'
import { planTarget } from './workflow-authorization.js'
import { taskContinuation } from './workflow-context.js'
import { UUID, batchOf, denied, scopedGrant, stateOf, taskKey } from './workflow-state.js'

export async function existingWindow(persistence, available, id, signal) {
  if (!available(id)) return false
  const stored = await persistence.stat(id, { signal })
  return Boolean(stored?.sizeBytes && stored.header.cwd &&
    stored.header.origin !== 'subagent' && !stored.header.parentSession)
}

export function workflowRouting({ available, enabled, claimedHere, ledger, windows, workspaceRegistry, withdrawn }) {
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
    if (auth.context?.queries) {
      const matches = new Map(auth.context.queries.flatMap((query) =>
        matchingTitles(items, query, () => true)).map((match) => [match.to, match.title]))
      return matches.size === 1 && matches.get(target.id) === target.title
    }
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

  function ownerTaskMessage(from, caller, state, target) {
    const { context, turn } = caller ?? {}
    const input = turn?.ownerMessage && plainText(turn.ownerMessage)
    if (!input || !['owner', 'main'].includes(context.mode) ||
        /^(?:DSH-WORKFLOW (?:TASK|RESULT)\b|任务消息 · )/u.test(input)) return denied('workflow_task_context_required')
    const { grants } = state
    const { joined, named, stale } = taskReferences(from, input, state)
    if (stale) return denied('workflow_task_route_inactive')
    if (context.mode === 'owner' && !named.length && !taskContinuation(input)) return denied('workflow_task_context_required')
    const candidates = named.length ? named : joined
    let eligible = candidates.filter((job) => (context.mode !== 'main' || job.key === context.key) &&
      conversationRoute(grants[job.key], job, from, job.target))
    if (target !== undefined && eligible.length && (eligible.length === 1 ||
        (context.mode === 'main' || named.length) && eligible.every((job) => job.key === eligible[0].key))) {
      eligible = eligible.filter((job) => job.target === target ||
        grants[job.key]?.authorization?.targets?.some(({ id, title }) => id === job.target && title === target))
      if (!eligible.length) return denied('workflow_task_mismatch')
    }
    if (eligible.length > 1) return { error: 'workflow_task_reference_required', tasks: taskChoices(grants, eligible) }
    const [job] = eligible
    if (!job) return denied('workflow_task_context_required')
    return { job, grant: grants[job.key] }
  }
  return { activeGrant, authorized, canRoute, verifyTarget, participantPair, conversationRoute, ownerTaskMessage }
}
