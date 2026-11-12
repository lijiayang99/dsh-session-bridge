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
    const dictionaries = {
      zh: {
        title: 'dsh-session-bridge', summary: '会话互传开关与当前窗口的状态日志。',
        master: '启用会话互传和任务委托', saving: '正在保存…',
        loading: '正在读取…', readError: '无法读取插件设置。', saveError: '保存失败，已重新读取设置。',
        hostUnsupported: '当前宿主不受支持。新消息和任务委托需要 DSH 0.2.2-rc.1。',
        readOnly: '当前配置为只读。', statusLog: '当前窗口状态日志', empty: '当前窗口没有传输记录。',
        logError: '无法读取状态日志。', unnamed: '未命名窗口',
        log_queued: '排队中', log_admitted: '已入队', log_executing: '执行中', log_returned: '已回传',
        log_failed: '失败', log_cancelled: '已取消', log_uncertain: '待核对',
      },
      en: {
        title: 'dsh-session-bridge', summary: 'Messaging control and status for the current window.',
        master: 'Enable messaging and delegation', saving: 'Saving…',
        loading: 'Loading…', readError: 'Unable to read plugin settings.', saveError: 'Unable to save. Settings were reloaded.',
        hostUnsupported: 'This host is unsupported. New messages and delegation require DSH 0.2.2-rc.1.',
        readOnly: 'This configuration is read-only.', statusLog: 'Current window status log', empty: 'This window has no transfer records.',
        logError: 'Unable to read the status log.', unnamed: 'Untitled window',
        log_queued: 'Queued', log_admitted: 'Admitted', log_executing: 'Executing', log_returned: 'Returned',
        log_failed: 'Failed', log_cancelled: 'Cancelled', log_uncertain: 'Needs reconciliation',
      },
    }
    const reasonLabels = {
      cancelled: ['所有者撤回', 'Withdrawn by the owner'],
      expired: ['授权到期', 'Authorization expired'],
      bridge_disabled: ['总开关已关闭', 'Bridge disabled'],
      target_binding_changed: ['目标绑定已变更', 'Target binding changed'],
      owner_turn_not_verified: ['所有者输入未经核实', 'Owner input could not be verified'],
      mixed_turn: ['宿主轮包含其他输入', 'Host turn contained other input'],
      destination_resolution_failed_before_send: ['无法打开目标窗口', 'Could not open the destination'],
      destination_unavailable_before_send: ['目标窗口不可用', 'Destination unavailable'],
      route_unavailable_before_send: ['投递前路由失效', 'Route became unavailable before delivery'],
      waiting_for_destination_resolution: ['等待目标窗口', 'Waiting for the destination'],
      aborted: ['宿主轮已取消', 'Host turn cancelled'],
      blocked: ['宿主轮被阻断', 'Host turn blocked'],
      interrupted: ['宿主轮中断', 'Host turn interrupted'],
      error: ['宿主轮运行失败', 'Host turn failed'],
      'max-tokens': ['宿主轮达到输出上限', 'Host turn reached its output limit'],
      unverified: ['状态证据待核对', 'Status evidence needs verification'],
    }
    for (const [key, [zh, en]] of Object.entries(reasonLabels)) {
      dictionaries.zh['reason_' + key] = zh
      dictionaries.en['reason_' + key] = en
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

    function hostCompatibility(entry) {
      const schema = entry?.schema
      const enabled = schema?.refs?.[schema.uid]?.dict?.enabled
      return schema?.refs?.[enabled]?.meta?.dshSessionBridgeHost
    }

    function apply(ctx) {
      const t = ctx.locale.bind('dsh-session-bridge')

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
      function StatusLog({ sessionId }) {
        const [result, setResult] = useState(null)
        useEffect(() => {
          if (!sessionId) return
          const controller = new AbortController()
          let timer
          async function load() {
            try {
              const response = await fetch('/api/dsh-session-bridge/status-log', {
                method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId }), signal: controller.signal,
              })
              if (!response.ok) throw new Error('Status unavailable')
              const { events } = await response.json()
              if (!controller.signal.aborted) setResult({ events })
            } catch {
              if (!controller.signal.aborted) setResult((current) => current?.events ? current : { error: true })
            } finally {
              if (!controller.signal.aborted) timer = setTimeout(load, 2500)
            }
          }
          void load()
          return () => {
            controller.abort()
            clearTimeout(timer)
          }
        }, [sessionId])
        return h('section', { 'data-dsh-bridge-status-log': '', style: section },
          h('h3', { style: { margin: 0, fontSize: 15 } }, t('statusLog')),
          !sessionId || result?.events?.length === 0 ? h('p', { style: muted }, t('empty'))
            : !result || result.error ? h('p', { role: 'status', style: muted }, t(result ? 'logError' : 'loading'))
              : h('ol', { style: { ...section, listStyle: 'none', padding: 0, margin: 0 } },
                result.events.map(({ at, kind, state, from, to, reason }, index) => {
                  const date = new Date(at)
                  const reasonLabel = reason && t('reason_' + (Object.hasOwn(reasonLabels, reason) ? reason : 'unverified'))
                  return h('li', { key: at + ':' + index, 'data-dsh-bridge-status-event': state, style: taskBox },
                    h('div', null, h('span', null, from || t('unnamed')), ' → ', h('span', null, to || t('unnamed'))),
                    h('p', { style: muted }, h('time', { dateTime: date.toISOString() }, date.toLocaleString()),
                      ' · ', t('transfer_' + kind), ' · ', t('log_' + state), reasonLabel && ' · ' + reasonLabel))
                })))
      }

      function Panel({ sessionId }) {
        const [view, setView] = useState(null)
        const [pending, setPending] = useState(undefined)
        const [state, setState] = useState('loading')
        const [generation, reload] = useState(0)

        useEffect(() => {
          let active = true
          async function load() {
            const settings = await ctx.remote.settings.describe()
            if (!active) return
            if (!settings.ok) throw new Error('Settings unavailable')
            const entry = settings.value.namespaces.find((item) => item.ns === kind)
            if (hostCompatibility(entry) === 'unsupported') {
              setState('hostUnsupported')
              return
            }
            if (hostCompatibility(entry) !== 'supported' || typeof entry.value?.enabled !== 'boolean') {
              throw new Error('Bridge settings unavailable')
            }
            setView({ entry, writable: settings.value.writable })
            setState(generation ? 'saveError' : 'ready')
          }
          load().catch(() => { if (active) setState('readError') })
          return () => { active = false }
        }, [generation])

        async function toggle(enabled) {
          setPending(enabled)
          setState('saving')
          try {
            const result = await ctx.remote.settings.update(kind, { enabled }, view.entry.revision)
            if (!result.ok || typeof result.value?.value?.enabled !== 'boolean') throw new Error('Settings write rejected')
            setView({ ...view, entry: result.value })
            setState('ready')
          } catch {
            setView(null)
            reload((value) => value + 1)
          } finally {
            setPending(undefined)
          }
        }

        return h('div', { style: { ...section, alignContent: 'start', gap: 16, padding: 20,
          height: '100%', boxSizing: 'border-box', overflow: 'auto' } },
          view && h('label', null, h('input', { type: 'checkbox', 'data-dsh-bridge-master': '',
            checked: pending ?? view.entry.value.enabled, disabled: !view.writable || state === 'saving',
            onChange: (event) => void toggle(event.target.checked),
          }), ' ', t('master')),
          state !== 'ready' && h('p', { role: 'status', style: muted }, t(state)),
          view && !view.writable && h('p', { role: 'status', style: muted }, t('readOnly')),
          h(StatusLog, { key: sessionId, sessionId }))
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
    return { inject: ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.settings'], apply }
  },
})
