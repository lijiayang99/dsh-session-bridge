window.__ModuleLoader__.load({
  id: '@local/dsh-session-bridge',
  factory(require) {
    const { createElement: h, useCallback, useEffect, useRef, useState, useSyncExternalStore } = require('react')
    const { IconPaperPlaneOutlineRegular: PaperPlane } = require('@deepseek-ai/dsh-client-ui-primitives')
    const id = '@local/dsh-session-bridge'
    const kind = 'dsh-session-bridge-settings'
    const section = { display: 'grid', gap: 8 }
    const muted = { color: 'var(--dsw-alias-label-secondary)', margin: 0 }
    const workflowId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
    const taskBox = { border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 8, padding: 10, overflowWrap: 'anywhere' }
    const workflowStates = {
      active: ['进行中', 'Active'], authorizing: ['正在核对所有者输入', 'Verifying owner input'], paused: ['等待主控决定', 'Waiting for the controller'],
      closing: ['收口待核验', 'Closeout awaiting verification'],
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
      close_authority_unavailable: ['收口授权不可用', 'Closeout authority was unavailable'],
      close_turn_evidence_unavailable: ['无法核实收口轮正常结束', 'Normal completion of the closeout turn could not be verified'],
      close_continuation_unverified: ['收口轮的结果接续未经核验', 'The closeout turn’s continuation was not verified'],
      aborted: ['宿主轮已取消', 'Host turn was cancelled'],
      error: ['宿主轮运行出错', 'Host turn ended with an error'],
      blocked: ['宿主轮被阻断', 'Host turn was blocked'],
      interrupted: ['宿主重启后补记中断', 'Host recorded an interruption after restart'],
      'max-tokens': ['宿主轮达到输出上限', 'Host turn reached its output limit'],
      owner_turn_not_verified: ['所有者轮或目标未通过核对', 'Owner turn or destination could not be verified'],
      mixed_turn: ['宿主轮收到其他用户或中继输入', 'The host turn received another user or relay input'],
    }
    const dictionaries = {
      zh: {
        title: 'dsh-session-bridge', summary: '管理哪些会话可以互发消息和委托任务。',
        master: '启用会话互传和任务委托', mixedSettings: '当前沿用旧配置，部分功能已启用。', ungrouped: '未分组', workspace: '工作区', unavailableGroup: '不可用的已选会话',
        allowlist: '会话白名单',
        empty: '没有可选会话。', unnamed: '未命名会话', unavailable: '会话当前不可用，可从白名单移除。',
        save: '保存设置', saving: '正在保存…', saved: '设置已保存并生效。',
        refresh: '重新读取', loading: '正在读取设置…', readError: '无法读取插件配置或宿主兼容状态，请重试。',
        hostUnsupported: '当前宿主不受支持。新消息和任务委托需要 DSH 0.2.2-rc.1。',
        saveError: '保存失败，请重新读取后再试。', readOnly: '当前配置为只读。',
        limit: '白名单最多选择 32 个会话。',
        tasks: '原主控任务', taskBack: '返回任务列表', taskEmpty: '当前窗口没有主控任务。',
        taskReadError: '无法读取当前主控窗口的任务。', taskMissing: '当前窗口中找不到这个任务。',
        taskState: '任务状态', taskAuthorization: '直派授权', taskOwnerVerified: '所有者轮已核验', taskOwnerPending: '等待核验所有者轮', taskGoal: '目标', taskExpires: '授权到期', taskOutcome: '收口结果',
        taskBatches: '批次', taskAttempts: '分派与尝试', taskAttempt: '第 {attempt} 次尝试',
        taskTarget: '执行窗口', taskScope: '用途范围', taskDelivery: '任务投递', taskResult: '结果接续',
        taskReport: '回报', taskLate: '迟到回报', taskReason: '原因', taskTurn: '宿主轮次',
        taskEvidence: '证据', taskArtifacts: '产物引用', taskReviewed: '已核查产物', taskReviewOf: '核查对象',
        taskBoundArtifact: '指定产物', taskRecordId: '记录 ID', taskAcceptance: '验收要求',
        taskCondition: '等待条件', taskArchived: '已归档尝试', taskQuarantined: '待核对记录',
        taskExecutionUnknown: '该尝试已进入宿主投递边界，实际执行状态仍待核对。',
      },
      en: {
        title: 'dsh-session-bridge', summary: 'Choose which sessions can exchange messages and delegate tasks.',
        master: 'Enable messaging and delegation', mixedSettings: 'Some features are enabled by the saved settings.', ungrouped: 'Ungrouped', workspace: 'Workspace', unavailableGroup: 'Unavailable selected sessions',
        allowlist: 'Session allowlist',
        empty: 'No eligible sessions.', unnamed: 'Untitled session', unavailable: 'Unavailable session. You can remove it from the allowlist.',
        save: 'Save settings', saving: 'Saving…', saved: 'Settings saved and applied.',
        refresh: 'Reload', loading: 'Loading settings…', readError: 'Unable to read plugin settings or host compatibility. Try again.',
        hostUnsupported: 'This host is unsupported. New messages and delegation require DSH 0.2.2-rc.1.',
        saveError: 'Unable to save. Reload before trying again.', readOnly: 'This configuration is read-only.',
        limit: 'Select at most 32 sessions.',
        tasks: 'Controller tasks', taskBack: 'Back to task list', taskEmpty: 'This window has no controller tasks.',
        taskReadError: 'Unable to read tasks for this controller window.', taskMissing: 'This task was not found in this window.',
        taskState: 'Task state', taskAuthorization: 'Direct authorization', taskOwnerVerified: 'Verified owner turn', taskOwnerPending: 'Waiting for owner turn verification', taskGoal: 'Goal', taskExpires: 'Authorization expires', taskOutcome: 'Closeout',
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
    const transferLabels = {
      message: ['会话消息', 'Session message'],
      task: ['委托派工', 'Delegated assignment'],
      result: ['结果回传', 'Returned result'],
      outgoing: ['发出', 'Outgoing'], incoming: ['接收', 'Incoming'],
      queued: ['排队中', 'Queued'], sending: ['传递中', 'Sending'],
      delivered: ['已投递', 'Delivered'], executing: ['处理中', 'Processing'],
      working: ['执行中', 'Executing'],
      processed: ['已处理', 'Processed'], reported: ['已回报', 'Reported'],
      received: ['已接续', 'Received'], failed: ['失败', 'Failed'],
      uncertain: ['待核对', 'Needs reconciliation'], stopped: ['已停止', 'Stopped'],
      reconciled: ['已对账', 'Reconciled'],
    }
    for (const [key, [zh, en]] of Object.entries(transferLabels)) {
      dictionaries.zh['transfer_' + key] = zh
      dictionaries.en['transfer_' + key] = en
    }

    const rowsReordering = Symbol()
    const reorderWaitMs = 350

    function rowPoint(row) {
      if (!row?.isConnected || document.hidden) return
      const { left, right, top, width, height } = row.getBoundingClientRect()
      if (width < 30 || height < 12) return
      const y = top + height / 2
      let overlap = false
      for (const x of [right - 18, left + width / 2, left + 16]) {
        const hit = document.elementFromPoint(x, y)
        if (hit && row.contains(hit)) return { x, y }
        if (!overlap && hit) {
          // The native workspace reorders rows with overlapping wrappers. Wait
          // briefly only while a sibling row covers an otherwise visible row.
          const other = hit.closest('[role="treeitem"]') ?? hit.querySelector(':scope > [role="treeitem"]')
          if (other && other !== row && other.closest('[role="tree"]') === row.closest('[role="tree"]') &&
              document.elementsFromPoint(x, y).some((element) => row.contains(element))) overlap = true
        }
      }
      if (overlap) return rowsReordering
    }

    function transferColors(state) {
      if (state === 'failed' || state === 'uncertain') return 'var(--dsw-alias-state-error, currentColor)'
      if (['queued', 'stopped', 'reconciled'].includes(state)) return 'var(--dsw-alias-label-secondary)'
      return 'var(--dsw-alias-state-business-primary, currentColor)'
    }

    function createTransferView(t) {
      const anchors = new Map()
      const listeners = new Set()
      let rowStates = new Map()
      const subscribe = (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }

      function updateRows(rows) {
        const next = new Map()
        for (const row of rows) {
          for (const id of [row.from, row.to]) {
            if (next.has(id)) continue
            const last = rowStates.get(id)
            next.set(id, last?.id === row.id && last.state === row.state ? last : row)
          }
        }
        rowStates = next
        for (const listener of listeners) listener()
      }

      function findAnchor(id) {
        let overlap
        for (const anchor of anchors.get(id) ?? []) {
          const point = rowPoint(anchor.closest('[role="treeitem"]'))
          if (point === rowsReordering) overlap = point
          else if (point) return point
        }
        return overlap
      }

      const visibleState = (row) => row.kind === 'task' && row.state === 'executing' ? 'working' : row.state

      function label(row, sessionId) {
        return [row.kind, row.from === sessionId ? 'outgoing' : 'incoming', visibleState(row)]
          .map((key) => t('transfer_' + key)).join(' · ')
      }

      function RowStatus({ sessionId }) {
        const row = useSyncExternalStore(subscribe, () => rowStates.get(sessionId))
        const current = useRef()
        const bind = useCallback((node) => {
          if (current.current) {
            const members = anchors.get(sessionId)
            members?.delete(current.current)
            if (members?.size === 0) anchors.delete(sessionId)
          }
          current.current = node
          if (!current.current) return
          if (!anchors.has(sessionId)) anchors.set(sessionId, new Set())
          anchors.get(sessionId).add(current.current)
        }, [sessionId])
        return h('span', { ref: bind, style: row ? {
          display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap',
          fontSize: 10, color: transferColors(row.state),
        } : { display: 'none' },
        ...(row ? { role: 'img', 'aria-label': label(row, sessionId), title: label(row, sessionId),
          'data-dsh-bridge-status': row.state } : {}),
        }, row && h(PaperPlane, { size: 12, 'aria-hidden': true }),
        row && h('span', { 'aria-hidden': true }, t('transfer_' + visibleState(row))))
      }

      function HoverStatus({ sessionId }) {
        const row = useSyncExternalStore(subscribe, () => rowStates.get(sessionId))
        return row ? h('span', { style: { color: transferColors(row.state) } }, label(row, sessionId)) : null
      }

      function PlaneFlight({ route, finish }) {
        const node = useRef()
        useEffect(() => {
          const { from, to, motion, id } = route
          const angle = (dx, dy) => Math.atan2(dy, dx) * 180 / Math.PI + 45
          const move = (x, y, rotate, opacity) => ({
            transform: 'translate(' + x + 'px, ' + y + 'px) translate(-50%, -50%) rotate(' + rotate + 'deg)',
            opacity,
          })
          const path = ({ x: x1, y: y1 }, { x: x2, y: y2 }) => {
            const midX = (x1 + x2) / 2 - Math.min(28, 9 + Math.abs(y2 - y1) / 4)
            const midY = (y1 + y2) / 2
            return [
              move(x1, y1, angle(midX - x1, midY - y1), 0.9),
              move(midX, midY, angle(x2 - x1, y2 - y1), 1),
              move(x2, y2, angle(x2 - midX, y2 - midY), 0.45),
            ]
          }
          const moved = (a, b) => Math.abs(a.x - b.x) >= 3 || Math.abs(a.y - b.y) >= 3
          let frame
          let animation
          let start
          let end
          const check = () => {
            const nextStart = findAnchor(from)
            const nextEnd = findAnchor(to)
            if (motion.matches || !nextStart || !nextEnd) {
              finish(id)
              return
            }
            if (nextStart === rowsReordering || nextEnd === rowsReordering) {
              if (!animation && performance.now() < route.deadline) frame = requestAnimationFrame(check)
              else finish(id)
              return
            }
            if (!animation) {
              start = nextStart
              end = nextEnd
              animation = node.current.animate(path(start, end), { duration: 820, easing: 'ease-in-out', fill: 'both' })
              animation.onfinish = () => finish(id)
            } else if (moved(start, nextStart) || moved(end, nextEnd)) {
              start = nextStart
              end = nextEnd
              animation.effect.setKeyframes(path(start, end))
            }
            frame = requestAnimationFrame(check)
          }
          frame = requestAnimationFrame(check)
          return () => {
            cancelAnimationFrame(frame)
            animation?.cancel()
          }
        }, [route, finish])
        return h('span', {
          ref: node, 'data-dsh-bridge-flight': route.kind,
          style: { position: 'absolute', top: 0, left: 0, opacity: 0, display: 'inline-flex', color: transferColors('sending') },
        }, h(PaperPlane, { size: 19, 'aria-hidden': true }))
      }

      function Overlay() {
        const [flights, setFlights] = useState([])
        const finish = useCallback((id) => setFlights((current) => current.filter((route) => route.id !== id)), [])
        useEffect(() => {
          const source = new EventSource('/api/dsh-session-bridge/activity')
          const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
          let cursor
          let frame
          const pending = []
          const launch = () => {
            frame = undefined
            if (motion.matches || document.hidden) {
              pending.length = 0
              return
            }
            const started = []
            for (const route of pending.splice(0)) {
              const from = findAnchor(route.from)
              const to = findAnchor(route.to)
              if (!from || !to) continue
              if (from === rowsReordering || to === rowsReordering) {
                if (performance.now() < route.deadline) pending.push(route)
              } else started.push(route)
            }
            if (pending.length) frame = requestAnimationFrame(launch)
            if (started.length) {
              setFlights((current) => [...current, ...started.slice(0, Math.max(0, 4 - current.length))])
            }
          }
          const cancelPending = () => {
            cancelAnimationFrame(frame)
            frame = undefined
            pending.length = 0
          }
          const receive = (event) => {
            const { sequence, rows } = JSON.parse(event.data)
            updateRows(rows)
            if (event.type === 'baseline') {
              cancelPending()
              cursor = sequence
              return
            }
            const after = cursor
            cursor = sequence
            if (after === undefined || motion.matches || document.hidden) return
            for (const row of rows) {
              if (pending.length >= 8) break
              if (row.flight > after) pending.push({
                id: row.flight, kind: row.kind, from: row.from, to: row.to, motion,
                deadline: performance.now() + reorderWaitMs,
              })
            }
            if (pending.length && frame === undefined) frame = requestAnimationFrame(launch)
          }
          const clear = () => {
            cancelPending()
            cursor = undefined
            updateRows([])
            setFlights([])
          }
          const onVisibility = () => {
            if (!document.hidden) return
            cancelPending()
            setFlights([])
          }
          document.addEventListener('visibilitychange', onVisibility)
          source.addEventListener('baseline', receive)
          source.onmessage = receive
          source.onerror = clear
          return () => {
            document.removeEventListener('visibilitychange', onVisibility)
            cancelPending()
            source.close()
            updateRows([])
          }
        }, [])
        return h('div', { 'aria-hidden': true, 'data-dsh-bridge-overlay': '',
          style: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 100 },
        }, flights.map((route) => h(PlaneFlight, { key: route.id, route, finish })))
      }

      return { RowStatus, HoverStatus, Overlay }
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

    function projectGroups(workspaces, rows) {
      const remaining = new Map(rows.filter((row) => !row.unavailable).map((row) => [row.id, row]))
      const groups = workspaces.map(({ workspaceId, title, path, sessionIds }) => ({
        id: workspaceId, title, path: typeof path === 'string'
          ? (/^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\') ? path.replaceAll('\\', '/') : path).replace(/\/+$/, '')
          : undefined,
        rows: sessionIds.flatMap((id) => {
          const row = remaining.get(id)
          remaining.delete(id)
          return row ? [row] : []
        }), children: [],
      }))
      const roots = []
      for (const group of groups) {
        const parent = groups.reduce((nearest, candidate) => group.path !== undefined && candidate.path !== undefined &&
          group.path !== candidate.path && group.path.startsWith(candidate.path + '/') &&
          (!nearest || candidate.path.length > nearest.path.length) ? candidate : nearest, undefined)
        if (parent) parent.children.push(group)
        else roots.push(group)
      }
      const hasRows = (group) => group.rows.length || group.children.some(hasRows)
      return [...roots.filter(hasRows),
        { id: 'ungrouped', label: 'ungrouped', rows: [...remaining.values()], children: [] },
        { id: 'unavailable', label: 'unavailableGroup', rows: rows.filter((row) => row.unavailable), children: [] },
      ].filter(hasRows)
    }

    function apply(ctx) {
      const t = ctx.locale.bind('dsh-session-bridge')
      const workspaceStore = ctx.workspaces.list
      const subscribeWorkspaces = (listener) => workspaceStore.subscribe(listener)
      const readWorkspaces = () => workspaceStore.getSnapshot()
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
        const { outcome, closure, authorization } = task
        return h('article', { style: section },
          h('h4', { style: { margin: 0 } }, task.task),
          facts([
            [t('taskState'), stateLabel(task.state)], [t('taskGoal'), task.goal], [t('taskExpires'), dateLabel(task.expiresAt)],
            [t('taskArchived'), task.archivedJobs],
            [t('taskAuthorization'), authorization?.ownerTurnEnd ? t('taskOwnerVerified')
              : task.state === 'authorizing' ? t('taskOwnerPending') : undefined],
            [t('taskReason'), reasons([closure?.reason])],
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

      function DirectWorkflowTail({ turn, sessionId, useChat }) {
        const message = useChat((snapshot) => {
          for (const key of snapshot.locations.getTurn(turn.turn)) {
            const node = snapshot.nodes.get(key)
            if (node?.kind !== 'turn-trigger') continue
            const { source, content } = node.data
            if (source?.kind !== 'agent-message' || source.form !== 'relay' ||
                content.length !== 1 || content[0]?.type !== 'text') continue
            if (source.bridgeWorkflowKind === 'conversation' && workflowId.test(source.bridgeWorkflowId ?? '') &&
                typeof source.bridgeWorkflowTask === 'string') return node.data
            if (source.bridgeWorkflowOwner !== sessionId) continue
            if (source.bridgeWorkflowKind === 'direct-notice' && source.senderSessionId === sessionId ||
                ['result', 'native-result'].includes(source.bridgeWorkflowKind) &&
                typeof source.bridgeWorkflowId === 'string' && workflowId.test(source.bridgeWorkflowId)) return node.data
          }
        })
        if (!message) return null
        const [{ text }] = message.content
        const bodyStyle = { margin: 0, whiteSpace: 'pre-wrap' }
        if (message.source.bridgeWorkflowKind === 'direct-notice') {
          return h('p', { 'data-dsh-bridge-direct-notice': '', style: { ...taskBox, ...bodyStyle } }, text)
        }
        const split = text.indexOf('\n\n')
        if (split < 0) return null
        const conversation = message.source.bridgeWorkflowKind === 'conversation'
        return h('section', { [conversation ? 'data-dsh-bridge-task-message' : 'data-dsh-bridge-direct-result']: '',
          style: { ...taskBox, ...section } },
          h('strong', null, text.slice(0, split)),
          h('p', { style: bodyStyle }, text.slice(split + 2)))
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
        const workspaces = useSyncExternalStore(subscribeWorkspaces, readWorkspaces)

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
            const rows = sessions.value.items
              .filter((row) => !row.blank && !row.parentSessionId && row.origin !== 'subagent')
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
            const patch = { allowedSessions: draft.allowedSessions }
            if (draft.enabled !== view.entry.value.enabled || draft.workflowEnabled !== view.entry.value.workflowEnabled) {
              Object.assign(patch, { enabled: draft.enabled, workflowEnabled: draft.workflowEnabled })
            }
            const result = await ctx.remote.settings.update(kind, patch, view.entry.revision)
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

        const archived = new Set(workspaces.archivedSessionIds)
        const liveRows = view?.rows.filter((row) => !archived.has(row.id)) ?? []
        const rows = view ? [...liveRows, ...draft.allowedSessions
          .filter((key) => !liveRows.some((row) => row.id === key))
          .map((key) => ({ id: key, unavailable: true }))] : []
        const groups = projectGroups(workspaces.items ?? [], rows)
        const settingsSection = { ...section, margin: 0, padding: 0, border: 0, minWidth: 0 }
        const disabled = !view?.writable || state === 'saving' || state === 'saveError'
        const changed = view && JSON.stringify(draft) !== JSON.stringify(values(view.entry))
        function select(key, checked) {
          setDraft((old) => ({ ...old, allowedSessions: checked
            ? [...old.allowedSessions, key] : old.allowedSessions.filter((value) => value !== key) }))
          setState('ready')
        }

        function renderGroup(group) {
          if (!group.rows.length && !group.children.length) return null
          return h('details', { key: group.id, style: { marginBlock: 4 } },
            h('summary', { style: { cursor: 'pointer', padding: '4px 0', overflowWrap: 'anywhere' } },
              group.title || t(group.label ?? 'workspace')),
            h('div', { style: { ...section, paddingInlineStart: 16 } },
              group.rows.map((row) => {
                const checked = draft.allowedSessions.includes(row.id)
                return h('label', { key: row.id, ...(row.unavailable ? { title: row.id } : {}),
                  style: { display: 'flex', alignItems: 'flex-start', gap: 8, overflowWrap: 'anywhere' } },
                h('input', { type: 'checkbox', checked, disabled: !checked && draft.allowedSessions.length >= 32,
                  onChange: (event) => select(row.id, event.target.checked) }),
                h('span', null, row.title || t(row.unavailable ? 'unavailable' : 'unnamed')))
              }), group.children.map(renderGroup)))
        }

        return h('div', { style: { padding: '20px', height: '100%', boxSizing: 'border-box', overflow: 'auto' } },
          h('h2', { style: { margin: '0 0 6px', fontSize: 18 } }, t('title')),
          view && sessionId && h('details', {
            style: { ...taskBox, marginTop: 12 }, onToggle: (event) => setTasksOpen(event.currentTarget.open),
          }, h('summary', null, t('tasks')), tasksOpen && h(TaskView, { key: sessionId, sessionId, rows: liveRows })),
          !view ? h('p', { role: 'status' }, t(state)) : h('form', { onSubmit: save, style: { ...section, gap: 18, marginTop: 18 } },
            h('fieldset', { disabled, style: settingsSection },
              h('label', null, h('input', { type: 'checkbox', checked: draft.enabled && draft.workflowEnabled,
                ref: (node) => { if (node) node.indeterminate = draft.enabled !== draft.workflowEnabled },
                onChange: (event) => {
                  setDraft({ ...draft, enabled: event.target.checked, workflowEnabled: event.target.checked })
                  setState('ready')
                },
              }), ' ', t('master')),
              draft.enabled !== draft.workflowEnabled && h('p', { style: muted }, t('mixedSettings'))),
            h('fieldset', { disabled, style: settingsSection },
              h('legend', null, t('allowlist')),
              rows.length === 0 && h('p', { style: muted }, t('empty')),
              groups.map(renderGroup),
              draft.allowedSessions.length >= 32 && h('small', { style: muted }, t('limit'))),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
              h('button', { type: 'submit', disabled: disabled || !changed }, t(state === 'saving' ? 'saving' : 'save')),
              h('button', { type: 'button', disabled: state === 'saving', onClick: () => reload(generation + 1) }, t('refresh'))),
            !view.writable && h('p', { role: 'status' }, t('readOnly')),
            (state === 'saved' || state === 'saveError') && h('p', { role: 'status', style: muted }, t(state))),
          (state === 'readError' || state === 'hostUnsupported') && h('button', { type: 'button', onClick: () => reload(generation + 1) }, t('refresh')))
      }
      const transfers = createTransferView(t)
      for (const [name, component] of [
        ['sidebar.session.row.trailing', transfers.RowStatus],
        ['sidebar.session.row.hover', transfers.HoverStatus],
        ['shell.overlay', transfers.Overlay],
      ]) {
        ctx.effect(() => ctx.slots.inject(name, () => ctx.slots.register({ name, id: id + '/activity' }, component)),
          'dsh-session-bridge activity ' + name)
      }
      ctx.effect(() => ctx.locale.register('dsh-session-bridge', dictionaries), 'dsh-session-bridge copy')
      ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail', id: id + '/direct-result',
        inject: (sessionId) => ({ sessionId }),
      }, DirectWorkflowTail)), 'dsh-session-bridge direct turn messages')
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
