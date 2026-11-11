const lead = '(?:(?:请帮我|帮我|请|麻烦你)[ \\t]*)?'
const target = '([^：:\\r\\n]{1,160}?)'
const toTarget = `(?:给${target}(?:发(?:送)?(?:一条)?消息|说)|发(?:送)?(?:一条)?消息给${target}|告诉${target})`
const inline = new RegExp(`^${lead}${toTarget}[ \\t]*[：:]([\\s\\S]*)$`, 'u')
const noBody = new RegExp(`^${lead}${toTarget}[ \\t]*$`, 'u')
const quoted = new RegExp(
  `^${lead}把(?:「([^」]*)」|『([^』]*)』|“([^”]*)”)[ \\t]*(?:发(?:送)?|转发)给${target}$`, 'u',
)
const derived = new RegExp(
  `^${lead}(?:把([^\\r\\n]{1,500}?)(?:发(?:送)?|转发)给|(?:拟写?|写|起草|改写)(?:一)?(?:条|封)?消息(?:发(?:送)?给|给))${target}$`, 'u',
)
const draftInstruction = /^(?:(?:请帮我|请你|请|帮我|你来)[ \t]*)?(?:(?:拟写?|写|起草|润色|改写).{0,30}(?:这条消息|消息正文|一条消息|一段话)|(?:转发|引用|概括)(?:刚才|上[一条面轮]|这[条段])|把(?:刚才|上[一条面轮]|这[条段]).{0,80}(?:发|转述|概括|总结))/u
const pairedTitle = /^(?:「([^」]+)」|『([^』]+)』|“([^”]+)”)$/u
const relativeTarget = /^(?:我|你|他|她|它|对方|那边|这个?窗口|那个?窗口)$/u

function titleQuery(value) {
  const title = value.trim()
  const wrapped = pairedTitle.exec(title)
  if (wrapped) return wrapped[1] ?? wrapped[2] ?? wrapped[3]
  if (relativeTarget.test(title) || /[「」『』“”、,，;；]|窗口(?:和|与|及|或|以及).+窗口/u.test(title)) return ''
  return title
}

export function naturalIntent(input) {
  const explicit = inline.exec(input)
  if (explicit) {
    const text = explicit[4]
    const title = titleQuery(explicit[1] ?? explicit[2] ?? explicit[3])
    if (!text.trim()) return { title, kind: 'missing_body' }
    if (draftInstruction.test(text.trimStart())) return { title, kind: 'draft' }
    return { title, kind: 'literal', text }
  }
  const literal = quoted.exec(input)
  if (literal) {
    const text = literal[1] ?? literal[2] ?? literal[3]
    return { title: titleQuery(literal[4]), kind: text.trim() ? 'literal' : 'missing_body', text }
  }
  const draft = derived.exec(input)
  if (draft) return { title: titleQuery(draft[2]), kind: 'draft' }
  const missing = noBody.exec(input)
  if (missing) return { title: titleQuery(missing[1] ?? missing[2] ?? missing[3]), kind: 'missing_body' }
}

export function matchingTitles(items, query, eligible) {
  if (!query) return []
  return items.flatMap((row) => {
    const title = row.projections?.values?.title
    return !row.blank && !row.parentSessionId && row.origin !== 'subagent' &&
      eligible(row.sessionId) && typeof title === 'string' &&
      (title === query || (!title.endsWith('窗口') && title + '窗口' === query))
      ? [{ to: row.sessionId, title }] : []
  })
}

function quotedPreview(value) {
  return JSON.stringify(value).replace(/[\p{C}\p{Zl}\p{Zp}]/gu, (character) =>
    character.split('').map((unit) => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join(''))
}

export function draftPreview(title, text) {
  return '请确认这条会话消息。\n\n' +
    `    收件窗口 ${quotedPreview(title)}\n    正文 ${quotedPreview(text)}\n\n` +
    '请在本窗口回复「确认发送」或「取消发送」。'
}
