window.__ModuleLoader__.load({
  id: '@local/dsh-session-bridge',
  factory(require) {
    const { createElement: h, useEffect, useState, useSyncExternalStore } = require('react')
    const id = '@local/dsh-session-bridge'
    const kind = 'dsh-session-bridge-settings'
    const grid = { display: 'grid', gap: 8 }
    const muted = { margin: 0, color: 'var(--dsw-alias-label-secondary)' }
    const dictionaries = {
      zh: {
        title: 'dsh-session-bridge', summary: '管理可由 Agent 互传消息的会话。',
        master: '启用会话互传', allowlist: '会话白名单', workspace: '工作区',
        ungrouped: '未分组', unavailable: '当前不可用', untitled: '未命名会话',
        empty: '没有可选会话。', loading: '正在读取设置…', saving: '正在保存…',
        unsupported: '此宿主版本不支持会话互传。', readOnly: '当前配置为只读。',
        readError: '无法读取会话互传设置。', saveError: '保存失败，已重新读取设置。',
        retry: '重试', limit: '最多可选择 32 个会话。',
      },
      en: {
        title: 'dsh-session-bridge', summary: 'Manage which windows can exchange agent messages.',
        master: 'Enable session messaging', allowlist: 'Session allowlist', workspace: 'Workspace',
        ungrouped: 'Ungrouped', unavailable: 'Currently unavailable', untitled: 'Untitled session',
        empty: 'No eligible sessions.', loading: 'Loading settings…', saving: 'Saving…',
        unsupported: 'This host version does not support session messaging.', readOnly: 'Settings are read-only.',
        readError: 'Could not read session messaging settings.', saveError: 'Save failed. Settings were reloaded.',
        retry: 'Retry', limit: 'Select up to 32 sessions.',
      },
    }

    function compatibility(entry) {
      const schema = entry?.schema
      const enabled = schema?.refs?.[schema.uid]?.dict?.messagingEnabled
      return schema?.refs?.[enabled]?.meta?.dshSessionBridgeHost
    }

    function readable(entry) {
      return compatibility(entry) === 'supported' && typeof entry.value?.messagingEnabled === 'boolean' &&
        Array.isArray(entry.value.messagingSessions) && entry.value.messagingSessions.every((id) => typeof id === 'string')
    }

    function groupsFor(workspaces, rows, selected) {
      const archived = new Set(workspaces.archivedSessionIds)
      const live = new Map(rows.filter(({ id }) => !archived.has(id)).map((row) => [row.id, row]))
      const ungrouped = new Map(live)
      const groups = (workspaces.items ?? []).map(({ workspaceId, title, sessionIds }) => ({
        id: workspaceId, title, label: 'workspace',
        rows: sessionIds.flatMap((id) => {
          const row = ungrouped.get(id)
          ungrouped.delete(id)
          return row ? [row] : []
        }),
      }))
      groups.push({ id: 'ungrouped', label: 'ungrouped', rows: [...ungrouped.values()] })
      groups.push({ id: 'unavailable', label: 'unavailable',
        rows: selected.filter((id) => !live.has(id)).map((id) => ({ id, unavailable: true })) })
      return groups.filter(({ rows }) => rows.length)
    }

    function BridgeIcon(props) {
      return h('svg', { ...props, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M3 8h17m-5-5 5 5-5 5M21 16H4m5-5-5 5 5 5', stroke: 'currentColor',
          strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function apply(ctx) {
      const t = ctx.locale.bind('dsh-session-bridge')
      const store = ctx.workspaces.list
      const subscribe = (callback) => store.subscribe(callback)
      const snapshot = () => store.getSnapshot()

      function Panel() {
        const [view, setView] = useState(null)
        const [state, setState] = useState('loading')
        const [pending, setPending] = useState(null)
        const [generation, reload] = useState(0)
        const workspaces = useSyncExternalStore(subscribe, snapshot)

        useEffect(() => {
          let active = true
          async function load() {
            const [settings, sessions] = await Promise.all([ctx.remote.settings.describe(), ctx.remote.session.list({})])
            if (!active) return
            if (!settings.ok || !sessions.ok) throw new Error('Bridge settings unavailable')
            const entry = settings.value.namespaces.find(({ ns }) => ns === kind)
            if (compatibility(entry) === 'unsupported') {
              setState('unsupported')
              return
            }
            if (!readable(entry)) throw new Error('Bridge settings unavailable')
            const rows = sessions.value.items.filter((row) => !row.blank && !row.parentSessionId && row.origin !== 'subagent')
              .map((row) => ({ id: row.sessionId, title: row.projections?.values?.title }))
            setView({ entry, rows, writable: settings.value.writable })
            setState(generation ? 'saveError' : 'ready')
          }
          load().catch(() => { if (active) setState('readError') })
          return () => { active = false }
        }, [generation])

        async function update(patch) {
          setPending(patch)
          setState('saving')
          try {
            const result = await ctx.remote.settings.update(kind, patch, view.entry.revision)
            if (!result.ok || !readable(result.value)) throw new Error('Bridge settings write rejected')
            setView({ ...view, entry: result.value })
            setState('ready')
          } catch {
            setView(null)
            reload((value) => value + 1)
          } finally {
            setPending(null)
          }
        }

        if (!view) return h('div', { style: { padding: 20 } },
          h('p', { role: 'status', style: muted }, t(state)),
          state === 'readError' && h('button', { type: 'button', onClick: () => {
            setState('loading')
            reload((value) => value + 1)
          } }, t('retry')))

        const settings = { ...view.entry.value, ...pending }
        const selected = new Set(settings.messagingSessions)
        const groups = groupsFor(workspaces, view.rows, settings.messagingSessions)
        const disabled = !view.writable || state === 'saving'
        function toggle(id, checked) {
          if (checked) selected.add(id)
          else selected.delete(id)
          void update({ messagingSessions: [...selected] })
        }

        return h('div', { style: { ...grid, gap: 16, alignContent: 'start', height: '100%', padding: 20,
          boxSizing: 'border-box', overflow: 'auto' } },
          h('label', null, h('input', { type: 'checkbox', 'data-dsh-bridge-master': '',
            checked: settings.messagingEnabled, disabled,
            onChange: (event) => void update({ messagingEnabled: event.target.checked }),
          }), ' ', t('master')),
          h('fieldset', { 'data-dsh-bridge-allowlist': '', disabled, style: { ...grid, padding: 0, margin: 0, border: 0 } },
            h('legend', null, t('allowlist')),
            groups.length === 0 && h('p', { style: muted }, t('empty')),
            groups.map((group) => h('details', { key: group.id, open: true },
              h('summary', { style: { cursor: 'pointer' } }, group.title || t(group.label)),
              h('div', { style: { ...grid, paddingInlineStart: 12 } }, group.rows.map((row) => {
                const checked = selected.has(row.id)
                return h('label', { key: row.id, style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
                  h('input', { type: 'checkbox', 'data-dsh-bridge-session': '', checked,
                    disabled: !checked && selected.size >= 32,
                    onChange: (event) => toggle(row.id, event.target.checked),
                  }), h('span', null, row.title || t(row.unavailable ? 'unavailable' : 'untitled')))
              })))),
            selected.size >= 32 && h('small', { style: muted }, t('limit'))),
          !view.writable && h('p', { role: 'status', style: muted }, t('readOnly')),
          state !== 'ready' && h('p', { role: 'status', style: muted }, t(state)))
      }

      ctx.effect(() => ctx.locale.register('dsh-session-bridge', dictionaries), 'dsh-session-bridge copy')
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id, kind, title: () => t('title'),
        guide: [{ id: 'settings', order: 45, title: () => t('title'), description: () => t('summary'), icon: BridgeIcon }],
      }), 'dsh-session-bridge tab')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: id,
      }, Panel)), 'dsh-session-bridge settings')
    }
    return { inject: ['slots', 'locale', 'sidebarRightTabs', 'workspaces', 'remote', 'remote.settings', 'remote.session'], apply }
  },
})
