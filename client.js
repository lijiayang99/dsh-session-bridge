window.__ModuleLoader__.load({
  id: '@local/dsh-session-bridge',
  factory(require) {
    const { createElement: h, useEffect, useState } = require('react')
    const id = '@local/dsh-session-bridge'
    const kind = 'dsh-session-bridge-settings'
    const section = { display: 'grid', gap: 8 }
    const muted = { color: 'var(--dsw-alias-label-secondary)', margin: 0 }
    const taskBox = { border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 8, padding: 10, overflowWrap: 'anywhere' }
    const workflowStates = {
      active: ['进行中', 'Active'], paused: ['等待主控决定', 'Waiting for the controller'],
      closed: ['已收口', 'Closed'], cancelled: ['已取消', 'Cancelled'], expired: ['已过期', 'Expired'],
      missing_grant: ['授权记录缺失', 'Grant record missing'], queued: ['排队中', 'Queued'],
      sending: ['等待宿主投递证据', 'Waiting for host delivery evidence'],
      admitted: ['已入队，等待领取', 'Admitted, waiting to be claimed'],
      claimed: ['已领取，等待回报', 'Claimed, waiting for a report'], reported: ['已回报', 'Reported'],
      waiting: ['等待中', 'Waiting'], ready: ['已齐备', 'Ready'], consumed: ['已消费', 'Consumed'],
      collecting: ['等待批次结果', 'Collecting batch results'],
      needs_reconciliation: ['等待批次对账', 'Waiting for batch reconciliation'],
      started: ['主控接续中', 'Controller continuing'], verified: ['接续已核验', 'Continuation verified'],
      interrupted: ['接续已中断', 'Continuation interrupted'],
      reviewed_without_replay: ['所有者已对账', 'Reconciled by the owner'],
      legacy_unverified: ['旧记录，接续未经核验', 'Legacy record, continuation unverified'],
      uncertain: ['待核对', 'Needs reconciliation'], failed: ['失败', 'Failed'], skipped: ['已跳过', 'Skipped'],
      reconciled: ['已对账', 'Reconciled'], quarantined: ['已隔离', 'Quarantined'],
      completed: ['已完成', 'Completed'], approved: ['审核通过', 'Approved'],
      changes_requested: ['退回返修', 'Changes requested'], needs_owner: ['等待所有者决定', 'Needs owner'],
      partial: ['部分完成', 'Partially completed'],
    }
    const workflowReasons = {
      destination_resolution_failed_before_send: ['投递前无法打开执行窗口', 'Could not open the worker window before delivery'],
      destination_unavailable_before_send: ['投递前执行窗口不可用', 'The worker window was unavailable before delivery'],
      route_unavailable_before_send: ['投递前执行窗口已不在可用范围', 'The worker window was outside the available routes before delivery'],
      waiting_for_destination_resolution: ['等待重新打开执行窗口', 'Waiting to reopen the worker window'],
      execution_interrupted_after_claim: ['领取后执行中断，等待对账', 'Execution stopped after the claim and needs reconciliation'],
      host_evidence_unavailable: ['无法读取宿主投递证据', 'Host delivery evidence is unavailable'],
      host_consumed_without_handshake: ['宿主已消费通知，账本缺少确认', 'The host consumed the notice without a ledger confirmation'],
      host_admission_not_proven_pending: ['无法证明通知仍在宿主队列', 'The notice could not be verified in the host queue'],
      recovered_inbox_conflict: ['恢复时宿主队列内容不一致', 'The host queue did not match the recovery record'],
    }
    const dictionaries = {
      zh: {
        title: 'dsh-session-bridge', summary: '管理哪些独立会话可以互发消息。',
        features: '功能开关', enabled: '启用会话消息',
        workflow: '启用跨窗口任务委托', workflowHelp: '在原主控窗口交办任务并核对委托方案。也可发送「授权委托」和任务 JSON。',
        allowlist: '会话白名单', allowed: '勾选的会话可以相互发送，至少需要两个。',
        authorization: '每条新消息由所有者在发送会话中提交授权。首行写「授权互传 目标会话ID 请求号」，下一行开始写准确正文。',
        empty: '没有可选会话。', unnamed: '未命名会话', unavailable: '会话当前不可用，可从白名单移除。',
        save: '保存设置', saving: '正在保存…', saved: '设置已保存并生效。',
        refresh: '重新读取', loading: '正在读取设置…', readError: '无法读取插件配置或宿主兼容状态，请重试。',
        hostSupported: '宿主版本受支持（DSH 0.2.2-rc.1）。',
        hostUnsupported: '当前宿主不受支持。新消息和任务委托需要 DSH 0.2.2-rc.1。',
        messagingOn: '会话消息已开启。', messagingOff: '会话消息已关闭。',
        workflowOn: '任务委托已开启。', workflowOff: '任务委托已关闭。',
        saveError: '保存失败，请重新读取后再试。', readOnly: '当前配置为只读。',
        limit: '白名单最多选择 32 个会话。',
        tasks: '原主控任务', taskBack: '返回任务列表', taskEmpty: '当前窗口没有主控任务。',
        taskReadError: '无法读取当前主控窗口的任务。', taskMissing: '当前窗口中找不到这个任务。',
        taskState: '任务状态', taskGoal: '目标', taskExpires: '授权到期', taskOutcome: '收口结果',
        taskBatches: '批次', taskAttempts: '分派与尝试', taskAttempt: '第 {attempt} 次尝试',
        taskTarget: '执行窗口', taskScope: '用途范围', taskDelivery: '任务投递', taskResult: '结果接续',
        taskReport: '回报', taskLate: '迟到回报', taskReason: '原因', taskTurn: '宿主轮次',
        taskEvidence: '证据', taskArtifacts: '产物引用', taskReviewed: '已核查产物', taskReviewOf: '核查对象',
        taskBoundArtifact: '指定产物', taskRecordId: '记录 ID', taskAcceptance: '验收要求',
        taskCondition: '等待条件', taskArchived: '已归档尝试', taskQuarantined: '待核对记录',
        taskExecutionUnknown: '该尝试已进入宿主投递边界，实际执行状态仍待核对。',
      },
      en: {
        title: 'dsh-session-bridge', summary: 'Choose which independent sessions may exchange messages.',
        features: 'Features', enabled: 'Enable session messaging',
        workflow: 'Enable cross-session delegation', workflowHelp: 'Assign the task and review its delegation plan in the original controller. You can also send 授权委托 with the task JSON.',
        allowlist: 'Session allowlist', allowed: 'Selected sessions can message each other. Select at least two.',
        authorization: 'For each new message, the owner enters “授权互传 <destination ID> <request ID>” in the sending session, then the exact text on the next line.',
        empty: 'No eligible sessions.', unnamed: 'Untitled session', unavailable: 'Unavailable session. You can remove it from the allowlist.',
        save: 'Save settings', saving: 'Saving…', saved: 'Settings saved and applied.',
        refresh: 'Reload', loading: 'Loading settings…', readError: 'Unable to read plugin settings or host compatibility. Try again.',
        hostSupported: 'Host version supported (DSH 0.2.2-rc.1).',
        hostUnsupported: 'This host is unsupported. New messages and delegation require DSH 0.2.2-rc.1.',
        messagingOn: 'Session messaging is on.', messagingOff: 'Session messaging is off.',
        workflowOn: 'Task delegation is on.', workflowOff: 'Task delegation is off.',
        saveError: 'Unable to save. Reload before trying again.', readOnly: 'This configuration is read-only.',
        limit: 'Select at most 32 sessions.',
        tasks: 'Controller tasks', taskBack: 'Back to task list', taskEmpty: 'This window has no controller tasks.',
        taskReadError: 'Unable to read tasks for this controller window.', taskMissing: 'This task was not found in this window.',
        taskState: 'Task state', taskGoal: 'Goal', taskExpires: 'Authorization expires', taskOutcome: 'Closeout',
        taskBatches: 'Batches', taskAttempts: 'Assignments and attempts', taskAttempt: 'Attempt {attempt}',
        taskTarget: 'Worker window', taskScope: 'Scope', taskDelivery: 'Task delivery', taskResult: 'Result continuation',
        taskReport: 'Report', taskLate: 'Late report', taskReason: 'Reason', taskTurn: 'Host turn',
        taskEvidence: 'Evidence', taskArtifacts: 'Artifact references', taskReviewed: 'Reviewed artifact', taskReviewOf: 'Review of',
        taskBoundArtifact: 'Assigned artifact', taskRecordId: 'Record ID', taskAcceptance: 'Acceptance',
        taskCondition: 'Completion condition', taskArchived: 'Archived attempts', taskQuarantined: 'Records to reconcile',
        taskExecutionUnknown: 'This attempt reached the host delivery boundary. Execution still needs verification.',
      },
    }
    for (const [state, [zh, en]] of Object.entries(workflowStates)) {
      dictionaries.zh['wf_' + state] = zh
      dictionaries.en['wf_' + state] = en
    }
    for (const [reason, [zh, en]] of Object.entries(workflowReasons)) {
      dictionaries.zh['wf_reason_' + reason] = zh
      dictionaries.en['wf_reason_' + reason] = en
    }
    const values = (entry) => ({
      enabled: entry.value.enabled === true,
      workflowEnabled: entry.value.workflowEnabled === true,
      allowedSessions: entry.value.allowedSessions ?? [],
    })

    function hostCompatibility(entry) {
      // Schemastery sends a reference graph. Read the server schema, not editable values.
      const schema = entry?.schema
      const enabled = schema?.refs?.[schema.uid]?.dict?.enabled
      return schema?.refs?.[enabled]?.meta?.dshSessionBridgeHost
    }

    function readable(entry) {
      return hostCompatibility(entry) === 'supported' &&
        typeof entry.value?.enabled === 'boolean' &&
        typeof entry.value.workflowEnabled === 'boolean' &&
        Array.isArray(entry.value.allowedSessions) &&
        entry.value.allowedSessions.every((id) => typeof id === 'string')
    }

    function apply(ctx) {
      const t = ctx.locale.bind('dsh-session-bridge')
      const stateLabel = (value) => {
        if (typeof value !== 'string') return
        return Object.hasOwn(workflowStates, value) ? t('wf_' + value) : value
      }
      const dateLabel = (value) => Number.isFinite(value)
        ? new Date(value).toLocaleString()
        : undefined
      const targetName = (job, titles) => titles.get(job.target) || job.targetTitle || job.target
      const reportState = (report) => report?.late ? t('taskLate') : stateLabel(report?.status)

      function facts(entries) {
        const rows = entries.filter(([, value]) => value !== null && value !== undefined && value !== '')
        if (!rows.length) return null
        return h('dl', { style: { ...section, margin: 0, gap: 4 } }, rows.map(([label, value]) =>
          h('div', { key: label, style: { display: 'grid', gridTemplateColumns: 'minmax(88px, 1fr) 2fr', gap: 6 } },
            h('dt', { style: muted }, label), h('dd', { style: { margin: 0 } }, value))))
      }

      function references(values) {
        if (!Array.isArray(values) || !values.length) return null
        return h('ul', { style: { margin: 0, paddingInlineStart: '1.2em' } },
          values.map((entry, index) => h('li', { key: index }, h('code', null, entry))))
      }

      function reasons(values) {
        const codes = [...new Set(values.filter((value) => typeof value === 'string' && value))]
        if (!codes.length) return null
        return h('span', { title: codes.join(' · ') }, codes.map((code) =>
          Object.hasOwn(workflowReasons, code) ? t('wf_reason_' + code) : stateLabel(code)).join(' · '))
      }

      function Attempt({ job, grantState, titles }) {
        const delivery = job.delivery
        const result = job.continuation
        const continuation = result?.continuation
        const report = job.report
        const target = targetName(job, titles)
        const stopped = ['cancelled', 'expired'].includes(grantState)
        return h('details', { style: taskBox },
          h('summary', null, h('strong', null, job.item), ' · ', t('taskAttempt', { attempt: String(job.attempt) }),
            target && ' · ' + target, delivery?.state && ' · ' + stateLabel(delivery.state),
            report?.status && ' · ' + reportState(report)),
          h('div', { style: { ...section, marginTop: 8 } },
            (job.execution === 'host_execution_unconfirmed' || stopped && delivery?.state === 'claimed') &&
              h('p', { role: 'status', style: muted }, t('taskExecutionUnknown')),
            facts([
              [t('taskTarget'), target], [t('taskScope'), job.scope], [t('taskAcceptance'), job.acceptance],
              [t('taskDelivery'), stateLabel(delivery?.state)],
              [t('taskResult'), [stateLabel(result?.state), stateLabel(continuation?.state),
                stateLabel(continuation?.reconciliation?.decision)].filter(Boolean).join(' · ')],
              [t('taskReason'), reasons([delivery?.reason, result?.reason, continuation?.reason, job.quarantine?.reason])],
              [t('taskTurn'), continuation?.turn ?? result?.consumedTurn ?? job.claim?.turn],
              [t('taskRecordId'), h('code', null, job.id)],
              [t('taskReviewOf'), job.reviewOf],
              [t('taskBoundArtifact'), references(job.artifact ? [job.artifact] : [])],
              [t('taskReviewed'), references(report?.reviewedArtifact ? [report.reviewedArtifact] : [])],
              [t('taskArtifacts'), references(report?.artifacts)],
              [t('taskEvidence'), references(report?.evidence)],
            ]),
            report && h('div', null,
              h('strong', null, t(report.late ? 'taskLate' : 'taskReport'), ' · ', stateLabel(report.status)),
              h('p', { style: { margin: '4px 0 0', whiteSpace: 'pre-wrap' } }, report.summary))))
      }

      function TaskDetail({ task, titles }) {
        const batches = task.batches ?? []
        const attempts = task.jobs ?? []
        const outcome = task.outcome
        return h('article', { style: section },
          h('h4', { style: { margin: 0 } }, task.task),
          facts([
            [t('taskState'), stateLabel(task.state)], [t('taskGoal'), task.goal], [t('taskExpires'), dateLabel(task.expiresAt)],
            [t('taskArchived'), task.archivedJobs],
          ]),
          outcome && h('section', { style: taskBox },
            h('strong', null, t('taskOutcome'), ' · ', stateLabel(outcome.status)),
            h('p', { style: { whiteSpace: 'pre-wrap' } }, outcome.summary), references(outcome.finalArtifacts)),
          batches.length > 0 && h('section', { style: section },
            h('h4', { style: { margin: 0 } }, t('taskBatches')),
            batches.map((batch) =>
              h('div', { key: batch.batch, style: taskBox },
                h('strong', null, batch.batch, ' · ', stateLabel(batch.state)),
                facts([
                  [t('taskCondition'), batch.completion],
                  [t('taskResult'), stateLabel(batch.continuation?.state)],
                  [t('taskReason'), reasons([batch.continuation?.reason])],
                ]),
                Array.isArray(batch.items) && batch.items.length > 0 && h('ul', null,
                  batch.items.map((entry) => h('li', { key: entry.id ?? entry.item },
                    entry.item, ' · ', reportState(entry.report) ?? stateLabel(entry.delivery?.state))))))),
          attempts.length > 0 && h('section', { style: section },
            h('h4', { style: { margin: 0 } }, t('taskAttempts')),
            attempts.map((job) => h(Attempt, { key: job.id, job, grantState: task.state, titles }))),
          task.quarantined?.length > 0 && h('section', null, h('strong', null, t('taskQuarantined')),
            h('ul', null, task.quarantined.map(({ id, reason }) => h('li', { key: id }, id, ' · ', reason)))))
      }

      function TaskView({ sessionId, rows }) {
        const [task, selectTask] = useState(undefined)
        const [generation, refresh] = useState(0)
        const [result, setResult] = useState(null)
        const current = result?.task === task && result?.generation === generation ? result : null
        const titles = new Map(rows.map(({ id, title }) => [id, title]))

        useEffect(() => {
          const controller = new AbortController()
          async function load() {
            try {
              const response = await fetch('/api/dsh-session-bridge/workflow-view', {
                method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId, task }), signal: controller.signal,
              })
              if (!response.ok) {
                const body = await response.json().catch(() => undefined)
                if (!controller.signal.aborted) setResult({
                  task, generation, error: body?.error === 'task_not_found' ? 'taskMissing' : 'taskReadError',
                })
                return
              }
              const data = await response.json()
              if (!controller.signal.aborted) setResult({ task, generation, data })
            } catch {
              if (!controller.signal.aborted) setResult({ task, generation, error: 'taskReadError' })
            }
          }
          void load()
          return () => controller.abort()
        }, [sessionId, task, generation])

        return h('div', { style: { ...section, marginTop: 8 } },
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            task && h('button', { type: 'button', onClick: () => selectTask(undefined) }, t('taskBack')),
            h('button', { type: 'button', disabled: !current, onClick: () => refresh(generation + 1) }, t('refresh'))),
          !current ? h('p', { role: 'status', style: muted }, t('loading'))
            : current.error ? h('p', { role: 'status', style: muted }, t(current.error))
              : task ? h(TaskDetail, { task: current.data, titles })
                : current.data.tasks.length === 0 ? h('p', { role: 'status', style: muted }, t('taskEmpty'))
                  : h('ul', { style: { ...section, listStyle: 'none', margin: 0, padding: 0 } },
                    current.data.tasks.map((row) => h('li', { key: row.task, style: taskBox },
                      h('button', { type: 'button', onClick: () => selectTask(row.task) }, row.task),
                      ' · ', stateLabel(row.state),
                      row.outcome?.status && ' · ' + stateLabel(row.outcome.status),
                      row.goal && h('p', { style: { ...muted, marginTop: 4 } }, row.goal)))))
      }

      function BridgeIcon(props) {
        return h('svg', { ...props, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('path', { d: 'M3 8h17m-5-5 5 5-5 5M21 16H4m5-5-5 5 5 5', stroke: 'currentColor',
            strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }))
      }
      function Panel({ sessionId }) {
        const [view, setView] = useState(null)
        const [draft, setDraft] = useState(null)
        const [state, setState] = useState('loading')
        const [generation, reload] = useState(0)
        const [tasksOpen, setTasksOpen] = useState(false)

        useEffect(() => {
          let active = true
          setState('loading')
          setView(null)
          async function load() {
            const settings = await ctx.remote.settings.describe()
            if (!active) return
            if (!settings.ok) throw new Error('Settings unavailable')
            const entry = settings.value.namespaces.find((item) => item.ns === kind)
            if (hostCompatibility(entry) === 'unsupported') {
              setState('hostUnsupported')
              return
            }
            if (!readable(entry)) throw new Error('Bridge settings unavailable')
            const sessions = await ctx.remote.session.list({})
            if (!active) return
            if (!sessions.ok) throw new Error('Sessions unavailable')
            const archived = new Set(ctx.workspaces.list.getSnapshot().archivedSessionIds)
            const rows = sessions.value.items
              .filter((row) => !row.blank && !row.parentSessionId && row.origin !== 'subagent' && !archived.has(row.sessionId))
              .map((row) => ({ id: row.sessionId, title: row.projections?.values?.title }))
            setView({ entry, rows, writable: settings.value.writable })
            setDraft(values(entry))
            setState('ready')
          }
          load().catch(() => { if (active) setState('readError') })
          return () => { active = false }
        }, [generation])

        async function save(event) {
          event.preventDefault()
          setState('saving')
          try {
            const result = await ctx.remote.settings.update(kind, draft, view.entry.revision)
            if (!result.ok) throw new Error('Settings write rejected')
            if (!readable(result.value)) {
              setView(null)
              setState(hostCompatibility(result.value) === 'unsupported' ? 'hostUnsupported' : 'readError')
              return
            }
            setView({ ...view, entry: result.value })
            setDraft(values(result.value))
            setState('saved')
          } catch {
            setState('saveError')
          }
        }

        const rows = view ? [...view.rows, ...draft.allowedSessions
          .filter((key) => !view.rows.some((row) => row.id === key))
          .map((key) => ({ id: key, unavailable: true }))] : []
        const disabled = !view?.writable || state === 'saving' || state === 'saveError'
        const changed = view && JSON.stringify(draft) !== JSON.stringify(values(view.entry))
        function select(key, checked) {
          setDraft((old) => ({ ...old, allowedSessions: checked
            ? [...old.allowedSessions, key] : old.allowedSessions.filter((value) => value !== key) }))
          setState('ready')
        }

        return h('div', { style: { padding: '20px', height: '100%', boxSizing: 'border-box', overflow: 'auto' } },
          h('h2', { style: { margin: '0 0 6px', fontSize: 18 } }, t('title')),
          h('p', { style: muted }, t('summary')),
          view && sessionId && h('details', {
            style: { ...taskBox, marginTop: 12 }, onToggle: (event) => setTasksOpen(event.currentTarget.open),
          }, h('summary', null, t('tasks')), tasksOpen && h(TaskView, { key: sessionId, sessionId, rows: view.rows })),
          !view ? h('p', { role: 'status' }, t(state)) : h('form', { onSubmit: save, style: { ...section, gap: 18, marginTop: 18 } },
            h('div', { role: 'status', style: section },
              h('p', { style: muted }, t('hostSupported')),
              h('p', { style: muted }, t(view.entry.value.enabled ? 'messagingOn' : 'messagingOff')),
              h('p', { style: muted }, t(view.entry.value.workflowEnabled ? 'workflowOn' : 'workflowOff'))),
            h('fieldset', { disabled, style: section },
              h('legend', null, t('features')),
              h('label', null, h('input', { type: 'checkbox', checked: draft.enabled, onChange: (event) => {
                setDraft({ ...draft, enabled: event.target.checked })
                setState('ready')
              } }), ' ', t('enabled')),
              h('label', null, h('input', { type: 'checkbox', checked: draft.workflowEnabled, onChange: (event) => {
                setDraft({ ...draft, workflowEnabled: event.target.checked })
                setState('ready')
              } }), ' ', t('workflow')),
              h('p', { style: muted }, t('workflowHelp'))),
            h('fieldset', { disabled, style: section },
              h('legend', null, t('allowlist')),
              h('p', { style: muted }, t('allowed')),
              h('p', { style: muted }, t('authorization')),
              rows.length === 0 && h('p', { style: muted }, t('empty')),
              rows.map((row) => {
                const checked = draft.allowedSessions.includes(row.id)
                return h('label', { key: row.id, title: row.id,
                  style: { display: 'flex', alignItems: 'flex-start', gap: 8, overflowWrap: 'anywhere' } },
                h('input', { type: 'checkbox', checked,
                  disabled: !checked && draft.allowedSessions.length >= 32,
                  onChange: (event) => select(row.id, event.target.checked) }),
                h('span', null, row.title || (row.unavailable ? t('unavailable') : t('unnamed')),
                  h('small', { style: { ...muted, display: 'block' } }, row.id)))
              }),
              draft.allowedSessions.length >= 32 && h('small', { style: muted }, t('limit'))),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
              h('button', { type: 'submit', disabled: disabled || !changed }, t(state === 'saving' ? 'saving' : 'save')),
              h('button', { type: 'button', disabled: state === 'saving', onClick: () => reload(generation + 1) }, t('refresh'))),
            !view.writable && h('p', { role: 'status' }, t('readOnly')),
            (state === 'saved' || state === 'saveError') && h('p', { role: 'status', style: muted }, t(state))),
          (state === 'readError' || state === 'hostUnsupported') && h('button', { type: 'button', onClick: () => reload(generation + 1) }, t('refresh')))
      }
      ctx.effect(() => ctx.locale.register('dsh-session-bridge', dictionaries), 'dsh-session-bridge copy')
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id, kind, title: () => t('title'),
        guide: [{ id: 'settings', order: 45, title: () => t('title'), description: () => t('summary'), icon: BridgeIcon }],
      }), 'dsh-session-bridge tab')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: id,
      }, Panel)), 'dsh-session-bridge settings panel')
    }
    return { inject: ['slots', 'locale', 'sidebarRightTabs', 'workspaces', 'remote', 'remote.settings', 'remote.session'], apply }
  },
})
