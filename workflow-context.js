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
const replyTitle = new RegExp('^(?:(?:是|就是|窗口是)[ \\t]*[：:]?[ \\t]*)?(' + title + ')' + ending, 'u')
const replyQuestion = new RegExp('^(?:' + askPerson + '[ \\t]*[：:]?[ \\t]*)?(' + status + ')' + ending, 'u')
const statedQuestion = /^(?:问题是[ \t]*[：:]?[ \t]*|问(?:他|她|它|对方)[ \t]*[：:][ \t]*)([^\r\n]{1,2000})$/u
const quotedTitle = /^(?:「([^」]+)」|『([^』]+)』|“([^”]+)”)$/u
const numeric = /^([0-9]{1,3})(?:号)?(?:窗口)?$/u
const unsafeTitle = /[和与及或跟]|^(?:我|你|他|她|它|对方|那边|另一个|其他|取消|算了|不用问了|先别问了?|取消委托)$/u
const withdrawal = /(?:^|[，,。；;？！!?])[ \t]*(?:算了|取消(?:委托)?|(?:先)?(?:别|不用|不要|不)问(?:他|她|它|对方)?(?:了)?)[ \t]*[。？！!?]*$/u

export const withdrawsQuestion = (text) => withdrawal.test(text)

function clearQuestion(value) {
  return typeof value === 'string' && value.length <= 2000 && /[\p{L}\p{N}]/u.test(value) &&
    !/[「」『』“”`\r\n]/u.test(value) && !/^(?:['"]|例如|比如|示例|引用|转述|转发|他[说问]|她[说问]|对方说)/u.test(value) && !withdrawsQuestion(value) &&
    !/(?:^|[，,。；;？！!?])[ \t]*(?:再|然后|顺便|另外|同时)(?:发|转|问|派|委托|让|给|告诉)/u.test(value)
}

function selector(value) {
  if (!value) return
  const explicit = quotedTitle.exec(value)?.slice(1).find(Boolean)
  if (explicit) return { kind: 'title', value: explicit }
  if (unsafeTitle.test(value)) return
  const alias = numeric.exec(value)
  return alias ? { kind: 'alias', value: alias[1] } : { kind: 'title', value }
}

export function contextualRequest(text, prior) {
  const request = text.trim().replace(lead, '')
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
    const target = selector(named[1])
    const reuse = !named[2] && target && prior?.missing === 'target' ? prior : undefined
    return { action: 'ask', selector: target, goal: named[2] ?? reuse?.goal, prior: reuse }
  }
  if (prior?.missing === 'goal' || prior?.missing === 'both') {
    const question = replyQuestion.exec(request)?.[1] ?? statedQuestion.exec(request)?.[1] ??
      (/[？?]$/u.test(request) ? request : undefined)
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
