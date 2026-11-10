window.__ModuleLoader__.load({
  id: '@local/dsh-session-bridge',
  factory(require) {
    const { createElement: h, useEffect, useState } = require('react')
    const id = '@local/dsh-session-bridge'
    const kind = 'session-bridge-settings'
    const section = { display: 'grid', gap: 8 }
    const muted = { color: 'var(--dsw-alias-label-secondary)', margin: 0 }
    const dictionaries = {
      zh: {
        title: '窗口互传', summary: '管理哪些独立会话可以互发消息。',
        features: '功能开关', enabled: '启用窗口互传',
        workflow: '启用跨窗口任务委托', workflowHelp: '在原主控会话发送「授权委托」和任务 JSON 开始。普通互传与任务委托可分别关闭。',
        allowlist: '会话白名单', allowed: '勾选的会话可以相互发送，至少需要两个。',
        authorization: '每条新消息由所有者在发送会话中提交授权。首行写「授权互传 目标会话ID 请求号」，下一行开始写准确正文。',
        empty: '没有可选会话。', unnamed: '未命名会话', unavailable: '会话当前不可用，可从白名单移除。',
        save: '保存设置', saving: '正在保存…', saved: '设置已保存并生效。',
        refresh: '重新读取', loading: '正在读取设置…', readError: '读取设置失败，请重试。',
        saveError: '保存失败，请重新读取后再试。', readOnly: '当前配置为只读。',
        limit: '白名单最多选择 32 个会话。',
      },
      en: {
        title: 'Session bridge', summary: 'Choose which independent sessions may exchange messages.',
        features: 'Features', enabled: 'Enable session messaging',
        workflow: 'Enable cross-session delegation', workflowHelp: 'Start with 授权委托 and the task JSON in the original main session. Messaging and delegation have separate switches.',
        allowlist: 'Session allowlist', allowed: 'Selected sessions can message each other. Select at least two.',
        authorization: 'For each new message, the owner enters “授权互传 <destination ID> <request ID>” in the sending session, then the exact text on the next line.',
        empty: 'No eligible sessions.', unnamed: 'Untitled session', unavailable: 'Unavailable session. You can remove it from the allowlist.',
        save: 'Save settings', saving: 'Saving…', saved: 'Settings saved and applied.',
        refresh: 'Reload', loading: 'Loading settings…', readError: 'Unable to load settings. Try again.',
        saveError: 'Unable to save. Reload before trying again.', readOnly: 'This configuration is read-only.',
        limit: 'Select at most 32 sessions.',
      },
    }
    const values = (entry) => ({
      enabled: entry.value.enabled === true,
      workflowEnabled: entry.value.workflowEnabled === true,
      allowedSessions: entry.value.allowedSessions ?? [],
    })

    function apply(ctx) {
      const t = ctx.locale.bind('sessionBridge')
      function BridgeIcon(props) {
        return h('svg', { ...props, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('path', { d: 'M3 8h17m-5-5 5 5-5 5M21 16H4m5-5-5 5 5 5', stroke: 'currentColor',
            strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }))
      }
      function Panel() {
        const [view, setView] = useState(null)
        const [draft, setDraft] = useState(null)
        const [state, setState] = useState('loading')
        const [generation, reload] = useState(0)

        useEffect(() => {
          let active = true
          setState('loading')
          setView(null)
          Promise.all([ctx.remote.settings.describe(), ctx.remote.session.list({})])
            .then(([settings, sessions]) => {
              if (!active) return
              if (!settings.ok || !sessions.ok) throw new Error('Settings or sessions unavailable')
              const entry = settings.value.namespaces.find((item) => item.ns === kind)
              if (!entry) throw new Error('Settings namespace unavailable')
              const archived = new Set(ctx.workspaces.list.getSnapshot().archivedSessionIds)
              const rows = sessions.value.items
                .filter((row) => !row.blank && !row.parentSessionId && row.origin !== 'subagent' && !archived.has(row.sessionId))
                .map((row) => ({ id: row.sessionId, title: row.projections?.values?.title }))
              setView({ entry, rows, writable: settings.value.writable })
              setDraft(values(entry))
              setState('ready')
            }).catch(() => { if (active) setState('readError') })
          return () => { active = false }
        }, [generation])

        async function save(event) {
          event.preventDefault()
          setState('saving')
          try {
            const result = await ctx.remote.settings.update(kind, draft, view.entry.revision)
            if (!result.ok) throw new Error('Settings write rejected')
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
          !view ? h('p', { role: 'status' }, t(state)) : h('form', { onSubmit: save, style: { ...section, gap: 18, marginTop: 18 } },
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
          state === 'readError' && h('button', { type: 'button', onClick: () => reload(generation + 1) }, t('refresh')))
      }
      ctx.effect(() => ctx.locale.register('sessionBridge', dictionaries), 'session bridge copy')
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id, kind, title: () => t('title'),
        guide: [{ id: 'settings', order: 45, title: () => t('title'), description: () => t('summary'), icon: BridgeIcon }],
      }), 'session bridge tab')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: id,
      }, Panel)), 'session bridge settings panel')
    }
    return { inject: ['slots', 'locale', 'sidebarRightTabs', 'workspaces', 'remote', 'remote.settings', 'remote.session'], apply }
  },
})
