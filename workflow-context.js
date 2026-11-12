const lead = /^(?:请你帮我|请(?:你|帮我)?|帮我|麻烦(?:你|帮我)?|你|我想让你)[ \t]*/u
const ask = '(?:问一下|问问|问下|问一问|问)'
const person = '(?:他|她|它|对方)'
const askPerson = ask + person + '(?:一下)?'
const title = '(?:「[^」\\r\\n]{1,160}」|『[^』\\r\\n]{1,160}』|“[^”\\r\\n]{1,160}”|[\\p{L}\\p{N}_.·｜|—–-]{1,160}?)'
const status = '(?:(?:今天(?:上午|下午|晚上)?|今日|昨天|昨日|本周|这周|最近|目前|现在|这两天)[ \\t]*)?' +
  '(?:都|已经|一共|刚才)?(?:做了(?:什么|些什么|哪些事(?:情)?|哪些工作|啥)|干了(?:啥|什么|哪些事)|完成了(?:什么|哪些(?:事|工作|任务))|' +
  '(?:有|取得了)(?:什么|哪些|什么样的)进展|进展(?:如何|怎么样)|在做什么|做得怎么样)[？?]?'
const ending = '[ \\t]*[。？?！!]*$'
const topic = new RegExp('^(?:看一下|看一看|看下|看看|查一下|查下|了解一下)[ \\t]*(' + title + ')[ \\t]*(' + status +
  ')(?:[ \\t]*(?:[，,；;。][ \\t]*(?:\\r?\\n[ \\t]*)?|\\r?\\n[ \\t]*)(?:你[ \\t]*)?(' + askPerson + '))?' + ending, 'u')
const punctuated = new RegExp('^' + ask + '[ \\t]*(' + title + ')[ \\t]*[，,：:][ \\t]*(.+[？?])$', 'u')
const referenceQuestion = new RegExp('^' + askPerson + '[ \\t]*(' + status + ')' + ending, 'u')
const directed = new RegExp('^' + ask + '[ \\t]*(' + title + ')(?:[ \\t]*[：:]?[ \\t]*(' + status + '))?' + ending, 'u')
const reference = new RegExp('^' + askPerson + ending, 'u')
const namedQuestion = new RegExp('^' + ask + '[ \t]*(.+)$', 'u')
const replyTitle = new RegExp('^(?:(?:是|就是|窗口是)[ \\t]*[：:]?[ \\t]*)?(' + title + ')' + ending, 'u')
const replyQuestion = new RegExp('^' + askPerson + '[ \\t]*[：:]?[ \\t]*(' + status + ')' + ending, 'u')
const bareQuestion = new RegExp('^(?:你(?:们)?[ \\t]*)?' + status + ending, 'u')
const statedQuestion = /^(?:问题是[ \t]*[：:]?[ \t]*|问(?:他|她|它|对方)[ \t]*[：:][ \t]*)([^\r\n]{1,2000})$/u
const quotedTitle = /^(?:「([^」]+)」|『([^』]+)』|“([^”]+)”)$/u
const numeric = /^([0-9]{1,3})(?:号)?(?:窗口)?$/u
const unsafeTitle = /[和与及或跟]|^(?:我|你|他|她|它|对方|那边|另一个|其他|取消|算了|不用问了|先别问了?|取消委托)$/u
const withdrawal = /^(?:算了|(?:请[ \t]*)?取消(?:委托)?|(?:先)?(?:别|不用|不要|不)问(?:他|她|它|对方)?(?:了)?)$/u
const quotedEnd = new Map([['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['"', '"'], ['`', '`']])
const separators = new Set('，,。；;？！!?\r\n')

function independentClauses(text) {
  const clauses = []
  const quotes = []
  let start = 0
  const add = (end) => {
    const clause = text.slice(start, end).trim()
    if (clause) clauses.push(clause)
  }
  for (let i = 0; i < text.length; i++) {
    const character = text[i]
    const closing = quotes.at(-1)
    if (closing === '"' || closing === '`') {
      if (character === '\\') i++
      else if (character === closing) quotes.pop()
    } else if (character === closing) {
      quotes.pop()
    } else if (quotedEnd.has(character)) {
      quotes.push(quotedEnd.get(character))
    } else if (!closing && (separators.has(character) || character === '.' &&
        (i === text.length - 1 || /\s/u.test(text[i + 1])))) {
      add(i)
      start = i + 1
    }
  }
  if (quotes.length) return
  add(text.length)
  return clauses
}

function withdrawsQuestion(text) {
  return independentClauses(text)?.some((clause) => withdrawal.test(clause))
}

// A nominal topic before a comma can belong to the same question.
const topicalQuestion = /^[\p{L}\p{N}_.· -]{1,160}的(?:状态|进度|配置|设置|结果|记录|版本)[ \t]*[，,][ \t]*(?:为什么|为何|怎么|如何|何时|什么时候|是否)[^，,。；;？！!?\r\n]+[？?]$/u

// A direct query stays within one question. Separate actions require a plan.
export function directQuestionInScope(text) {
  // The previous direct-query entry accepts a trailing verbatim-copy note.
  // Strip it for scope checking only; the delivery still preserves the input.
  const question = text.replace(/\r?\n[ \t]*请保留问题原文[ \t]*$/u, '')
  const clauses = independentClauses(question)
  if (clauses?.length === 1) return !withdrawal.test(clauses[0])
  return clauses?.length === 2 && topicalQuestion.test(question.trim())
}

function clearQuestion(value) {
  if (typeof value !== 'string' || value.length > 2000 || !/[\p{L}\p{N}]/u.test(value)) return false
  const question = value.trim()
  return !/[「」『』“”`\r\n]/u.test(question) &&
    !/^(?:['"]|例如|比如|示例|引用|转述|转发|他[说问]|她[说问]|对方说)/u.test(question) &&
    directQuestionInScope(question)
}

function selector(value) {
  if (!value) return
  const explicit = quotedTitle.exec(value)?.slice(1).find(Boolean)
  if (explicit) return { kind: 'title', value: explicit }
  if (unsafeTitle.test(value)) return
  const alias = numeric.exec(value)
  return alias ? { kind: 'alias', value: alias[1] } : { kind: 'title', value }
}

// A small, host-checkable subset. All other phrasing can use the visible
// workflow proposal, where a model may draft the goal and scopes.
const namedTask = new RegExp('^让[ \t]*(「[^」]{1,160}」|『[^』]{1,160}』|“[^”]{1,160}”|[0-9]{1,3}(?![0-9]))' +
  '[ \t]*(?:号)?(?:窗口|会话)?[ \t]*[：:]?[ \t]*(.+)$', 'u')
const extraWindow = /[0-9]{1,3}(?:号)?(?:窗口|会话)|(?:窗口|会话)[0-9]{1,3}|[「」『』“”]/u

export function conversationRequest(text) {
  const match = namedTask.exec(text.trim().replace(lead, ''))
  if (!match) return
  const [, target, goal] = match
  if (!clearQuestion(goal) || /[？?]$/u.test(goal) || extraWindow.test(goal) ||
      !/^(?:核对|检查|验证|复核|审查|审核|确认|看一下|看看|排查|分析|测试|整理|完成|实现|修复)\S/u.test(goal)) return
  return { action: 'ask', selector: selector(target), goal, conversation: true }
}

// A catalog title can mark the boundary without a space or question mark.
const additionalDelivery = /(?:发(?:送)?(?:给|到)|转发|转给|转交|交给|通知|回(?:传|报|复)给)|(?:并|再|顺便|然后|随后)[ \t]*(?:请[ \t]*)?(?:让|请|问|告诉)/u

export function namedQuestionText(text) {
  const request = text.trimStart().replace(lead, '')
  if (withdrawsQuestion(request) || reference.test(request)) return
  const candidate = namedQuestion.exec(request)?.[1]
  if (!candidate || additionalDelivery.test(candidate)) return
  if (clearQuestion(candidate)) return candidate
  const afterComma = /^[\p{L}\p{N}_.·｜|—– -]{1,160}[，,][ \t]*(.+)$/u.exec(candidate)?.[1]
  if (clearQuestion(afterComma)) return candidate
}

export function namedQuestionGoal(text, title) {
  if (!title || title.length > 160 || !text.startsWith(title)) return
  const after = text.slice(title.length)
  // A separator or an ASCII-to-Han transition makes the split explicit.
  // In particular, a partial Chinese title before a window suffix is not a target.
  const separated = /^(?:[ \t，,：:]|(?:这个)?窗口)/u.test(after)
  const adjacent = /[a-zA-Z0-9]$/u.test(title) && /^\p{Script=Han}/u.test(after) &&
    !/(?:窗口|会话)/u.test(after)
  if (!separated && !adjacent) return
  const goal = after.replace(/^(?:[ \t]*(?:这个)?窗口)?[ \t]*[，,：:]?[ \t]*/u, '')
  if (!additionalDelivery.test(goal) && clearQuestion(goal)) return goal
}

export function contextualRequest(text, prior) {
  const original = text.trim()
  const request = original.replace(lead, '')
  if (withdrawsQuestion(request)) return
  const discussed = topic.exec(request)
  if (discussed) return {
    action: discussed[3] ? 'ask' : 'topic', selector: selector(discussed[1]), goal: discussed[2],
  }
  const referred = referenceQuestion.exec(request)
  if (reference.test(request) || referred) return {
    action: 'ask', selector: prior?.selector, goal: referred?.[1] ?? prior?.goal, prior,
    inheritedTarget: Boolean(prior?.selector),
  }
  const explicitQuestion = punctuated.exec(request)
  if (explicitQuestion) {
    if (!clearQuestion(explicitQuestion[2])) return
    return { action: 'ask', selector: selector(explicitQuestion[1]), goal: explicitQuestion[2] }
  }
  const named = directed.exec(request)
  if (named) {
    if (!named[2] && !quotedTitle.test(named[1]) && additionalDelivery.test(named[1])) return
    const target = selector(named[1])
    const reuse = !named[2] && target && prior?.missing === 'target' ? prior : undefined
    return { action: 'ask', selector: target, goal: named[2] ?? reuse?.goal, prior: reuse }
  }
  if (prior?.missing === 'goal' || prior?.missing === 'both') {
    const question = replyQuestion.exec(request)?.[1] ?? statedQuestion.exec(request)?.[1] ??
      (/[？?]$/u.test(original) || bareQuestion.test(original) ? text : undefined)
    if (clearQuestion(question)) {
      return { action: 'ask', selector: prior.selector, goal: question, prior, inheritedTarget: Boolean(prior.selector) }
    }
  }
  if (prior?.missing === 'target' || prior?.missing === 'both') {
    const answer = replyTitle.exec(request)?.[1]
    if (answer && (quotedTitle.test(answer) || numeric.test(answer) || /^(?:是|就是|窗口是|[0-9]{1,3}[｜|—–-])/u.test(request))) {
      const target = selector(answer)
      if (target) return { action: 'ask', selector: target, goal: prior.goal, prior }
    }
  }
}
