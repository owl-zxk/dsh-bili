// 大脑：把"她是谁 / 记得什么 / 今天怎么样 / 现在能不能动"拼成一次调用，要回一段结构化 JSON。
//
// 三条硬规则（违反任何一条都会把内核拖下水）：
//   ① **只用宿主的 ctx.llm**，绝不直连模型 API、绝不出现 key —— 直连等于绕过宿主的计费与限额。
//   ② 每次调用都自带软超时与 try/catch：模型慢/坏/返回垃圾时，这一层要能安静地降级成"只读"。
//   ③ 解析失败**重试 1 次**，仍失败就返回 { ok:false, reason:'brain-parse-failed' }，
//      调用方据此只做只读动作 —— 绝不让模型的一段非 JSON 文本变成一次公开发言。
//
// 宿主 llm 的真实形态（2026-11-01 逐行读参照实现后确认，**不是猜的**）：
//   参照：`dsh-video/lib/llm/vision.js` 的 LocalAssembler（collectText / assembler）。
//   `llm.stream(options) → AsyncIterable<chunk>`
//     options = { provider?, model?, system, messages:[{role:'user',content:[{type:'text',text}]}], signal? }
//   **content 是 block 数组，不是字符串** —— 传字符串会被适配器当成非法消息。
//
//   chunk 只吃两种文本（外加结束分片）：
//     { type:'text-delta', text }                       ← 增量文本
//     { type:'block-end', block:{ type:'text', text } } ← 整块文本（优先级更高）
//     { type:'finish', reason:{ kind:'ok'|'error'|'aborted', failure? } }
//   最终文本 = blocks.join('') 非空就用 blocks，否则用 deltas.join('')（与参照实现一致）。
//   ⚠️ 曾经按 `chunk.type === 'text'` 累加 —— 那是把「block 的 type」看成了「chunk 的 type」，
//      结果 text 永远是空串，真机上表现为"模型调到了、路由也通了，但解析一定失败"。别再改回去。
//   只认这一种形态：没有 stream 的宿主直接报 llm-unavailable，而不是退回某种自造协议半死不活。
import { appendAudit } from './audit.js'
import { readPersona, readProfile } from './persona.js'
import { loadMemes, pickForPrompt } from './memes.js'
import { recentMemory } from './memory.js'
import { todayDiary } from './diary.js'
import { readState, patchState } from './state.js'
import { loadSchedule, countsToday } from './schedule.js'
import { behaviorHints, describe, hintsText, readMetrics, recentChanges } from './metrics.js'

/** 每次醒来最多几条写动作（§3）。 */
export const MAX_WRITES_PER_WAKE = 2
/** 单次 LLM 调用的软超时（毫秒）：超时按 llm-stream-failed 处理，别把 tick 拖死。 */
const LLM_TIMEOUT_MS = 60_000

const clip = (value, max) => String(value ?? '').trim().slice(0, max)

/** 失败原因只有这四种（调用方据此决定"降级到什么程度"）。 */
const FAILURE_REASONS = new Set(['llm-unavailable', 'llm-route-missing', 'llm-stream-failed', 'brain-parse-failed'])

/** 路由类报错的指纹：宿主在"没配 provider/model 或配错"时抛的文本长这样。 */
const ROUTE_HINT = /(route|provider|model|no such|unknown (model|provider)|not configured|missing)/i

const describeFailure = (failure) => {
  if (failure === null || failure === undefined) return 'unknown'
  const code = failure.code ?? failure.kind ?? 'unknown'
  const message = clip(failure.message, 120)
  return message === '' ? String(code) : `${code}: ${message}`
}

function normalizeStreamError (error, aborted) {
  const code = error?.code
  if (FAILURE_REASONS.has(code)) return error
  const message = String(error?.message ?? error ?? '')
  if (aborted || error?.name === 'AbortError' || /abort/i.test(message)) {
    return Object.assign(new Error(`LLM 超时/中断（${LLM_TIMEOUT_MS / 1000} 秒软超时）：${clip(message, 120)}`), { code: 'llm-stream-failed' })
  }
  if (ROUTE_HINT.test(message) || ROUTE_HINT.test(String(code ?? ''))) {
    return Object.assign(new Error(`模型路由不可用（请在设置页填 provider/model）：${clip(message, 120)}`), { code: 'llm-route-missing' })
  }
  return Object.assign(new Error(`LLM 流失败：${clip(message, 120)}`), { code: 'llm-stream-failed' })
}

/**
 * 调一次模型，把流里的文本拼回来。
 * @param {object} llm 宿主的 llm 服务
 * @param {{system: string, user: string, provider?: string, model?: string}} input
 * @returns {Promise<string>}
 * @throws 带 code 的错误：llm-unavailable / llm-route-missing / llm-stream-failed
 */
async function callModel (llm, { system, user, provider, model }) {
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
    throw Object.assign(new Error('宿主的 llm 没有 stream()（本层只认这一种形态）'), { code: 'llm-unavailable' })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => {
    try { controller.abort() } catch { /* 已经结束了 */ }
  }, LLM_TIMEOUT_MS)
  if (typeof timer.unref === 'function') timer.unref()

  const options = {
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    signal: controller.signal,
  }
  // 配了才传：不配 = 交给宿主默认路由（传空串反而可能被当成"指定了一个叫空的模型"）
  if (typeof provider === 'string' && provider.trim() !== '') options.provider = provider.trim()
  if (typeof model === 'string' && model.trim() !== '') options.model = model.trim()

  // 两种形态分别收（见文件头）：block 是完整块、delta 是增量；两者都有时以 block 为准
  const deltas = []
  const blocks = []
  try {
    for await (const chunk of llm.stream(options)) {
      const type = chunk?.type
      if (type === 'text-delta') {
        if (typeof chunk.text === 'string') deltas.push(chunk.text)
        continue
      }
      if (type === 'block-end') {
        if (chunk?.block?.type === 'text' && typeof chunk.block.text === 'string') blocks.push(chunk.block.text)
        continue
      }
      if (type === 'finish') {
        const kind = chunk?.reason?.kind
        if (kind === 'error') {
          throw Object.assign(new Error('流以 error 结束：' + describeFailure(chunk.reason?.failure)), { code: 'llm-stream-failed' })
        }
        if (kind === 'aborted') {
          throw Object.assign(new Error('流被中断（可能是软超时或调用方取消）'), { code: 'llm-stream-failed' })
        }
      }
    }
  } catch (error) {
    throw normalizeStreamError(error, controller.signal.aborted)
  } finally {
    clearTimeout(timer)
  }
  const text = blocks.length > 0 ? blocks.join('') : deltas.join('')
  if (controller.signal.aborted && text.trim() === '') {
    throw Object.assign(new Error(`LLM 超时（${LLM_TIMEOUT_MS / 1000} 秒）`), { code: 'llm-stream-failed' })
  }
  return text
}

/**
 * 把模型的原始输出做成一句可辨认的诊断（只进 state 的 detail，不进对外响应）。
 *
 * 为什么要这个：真机上"调到了、路由通了、但解析失败"与"模型压根没吐字"看起来一模一样，
 *   上一轮就是这么猜了一整轮。现在空输出会写成 `（空输出）`，非空会带上前 200 字符。
 *   顺手把 32 位十六进制（bili_jct 的形状）压成 ***，免得模型偶尔复述凭据时落进文件。
 */
function describeRaw (text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return '（空输出）模型这次没有产出任何文本 —— 检查 chunk 协议 / 路由'
  const safe = raw.replace(/[0-9a-f]{32}/gi, '***').replace(/\r?\n/g, '⏎')
  const clipped = safe.length > 200 ? safe.slice(0, 200) + '…' : safe
  return `模型原始输出（前 ${Math.min(safe.length, 200)} 字符）：${clipped}`
}

/** 从一段可能带代码围栏/前后废话的文本里抠出第一个 JSON 对象。 */
function extractJson (text) {
  const raw = String(text ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fenced === null ? raw : fenced[1]
  try {
    return JSON.parse(body)
  } catch { /* 继续宽松模式 */ }
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(body.slice(start, end + 1)) } catch { /* 真解析不出来 */ }
  }
  return null
}

/** 动作列表清洗：只留对象 + tool 是字符串 + args 是对象；其余丢弃。 */
function normalizeActions (value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value.slice(0, 20)) {
    if (item === null || typeof item !== 'object') continue
    const tool = clip(item.tool, 64)
    if (tool === '') continue
    out.push({ tool, args: item.args !== null && typeof item.args === 'object' ? item.args : {}, why: clip(item.why, 120) })
  }
  return out
}

/** 从 deps 里把工具定义列出来（Map / 数组 / 普通对象都认）。 */
export function listTools (deps) {
  const bag = deps?.tools
  if (bag === null || bag === undefined) return []
  if (Array.isArray(bag)) return bag.filter((t) => t !== null && typeof t === 'object' && typeof t.name === 'string')
  if (typeof bag.values === 'function') return [...bag.values()].filter((t) => t !== null && typeof t === 'object' && typeof t.name === 'string')
  if (typeof bag === 'object') return Object.values(bag).filter((t) => t !== null && typeof t === 'object' && typeof t.name === 'string')
  return []
}

/** 工具目录：name — 描述第一句（列表来自内核真实注册的工具，不硬编码）。 */
function toolCatalogue (deps) {
  const tools = listTools(deps)
  if (tools.length === 0) return '（工具列表不可用）'
  return tools.map((t) => `- ${t.name}：${clip(String(t.description ?? '').split(/[。\n]/)[0], 60)}`).join('\n')
}

/** 读一次 bili_status（只读工具），失败返回一句人话，绝不抛。 */
export async function readStatusBrief (deps) {
  const tool = listTools(deps).find((t) => t.name === 'bili_status')
  if (tool === undefined || typeof tool.execute !== 'function') return '（bili_status 不可用）'
  try {
    const out = await tool.execute({}, {})
    if (out === null || typeof out !== 'object') return '（状态读取返回异常）'
    if (out.ok !== true) return `（状态读取失败：${clip(out.reason ?? out.human, 80)}）`
    const data = out.data ?? {}
    return clip(JSON.stringify({ tokens: data.tokens ?? data.quota?.tokens ?? null, traffic: data.client ?? data.traffic ?? null, capabilities: data.capabilities ?? data.available ?? null }), 400)
  } catch (error) {
    return `（状态读取抛错：${clip(error?.message ?? error, 80)}）`
  }
}

/** 拼上下文（每次现读：人设改了立刻生效）。 */
async function buildPrompt ({ trigger, deps, mention = null }) {
  const schedule = loadSchedule()
  const state = readState()
  const persona = readPersona().split('\n').slice(0, 40).join('\n')
  const memory = recentMemory(30).map((m) => `- [${m.kind}] ${m.text}`).join('\n')
  const diary = todayDiary(10)
  const counts = countsToday()
  const status = await readStatusBrief(deps)
  const tools = toolCatalogue(deps)
  // 身份（front-matter）与热梗库（§14.1 / §14.3）：每次现读，设置页改完下一轮就生效
  const profile = readProfile()
  // 他设的称呼（front-matter 的 ownerTitle）。下面所有"给人看"的文案都用它，别再写死「主人」。
  const ownerTitle = profile.ownerTitle
  // 【有人 @ 我】：优先用**本轮**的 mention（tick 在 decide 之前已经读好 @ 与视频），
  //   退回 state.lastMentionWatch（上一轮存下的），这样即使本轮没有新 @ 也还知道最近看过什么。
  //   为什么要有这一段：没有它，她只能回"看到你@我了"；有了它，她才能说"这个剪辑…"。
  const mentionNow = mention !== null && typeof mention === 'object' ? mention : null
  const mentionWatch = mentionNow !== null && mentionNow.watch !== null && mentionNow.watch !== undefined
    ? mentionNow.watch
    : (readState().lastMentionWatch ?? null)
  const memes = loadMemes()
  const picks = pickForPrompt(12)

  // 指标（§14.3）：两行状态 + 两三句行为提示。**数字是规则算出来的，模型只许在台词里体现。**
  const metrics = readMetrics()
  const hints = behaviorHints(metrics)
  const hintLines = hintsText(hints)
  const changes = recentChanges(3)
    .flatMap((row) => (Array.isArray(row.changes) ? row.changes : []).map((c) => `${c.key}${c.delta > 0 ? '+' : ''}${c.delta}`))
    .slice(-5)
    .join('、') || '（还没有）'

  const memeLines = picks.length === 0
    ? ['（这个月还没有可用的梗库内容 —— 今天先不玩梗）']
    : picks.map((item, index) => `${index + 1}. ${item.meme}：${item.meaning}${item.example === '' ? '' : `（例：${item.example}）`}`)
  // 【有人 @ 我】那段：有 @ 就先说她被谁 @ 了什么；看得到视频信息就把信息列出来；
  //   看不到就明写"没看成"——她要的是"为什么不想看"，不是"我看到了"。
  let mentionLines = ''
  if (mentionNow !== null) {
    const head = '【有人 @ 我】' + (mentionNow.uname === '' ? '' : mentionNow.uname + '：') + (mentionNow.text === '' ? '（没写正文）' : mentionNow.text)
    const body = mentionWatch === null
      ? (String(mentionNow.bvid ?? '') === ''
          ? '（这条 @ 没有带视频）'
          : `（这条视频我没看成：bvid=${mentionNow.bvid}）—— 不想看/没看就直说为什么`)
      : [
          `视频 bvid=${mentionWatch.bvid}`,
          mentionWatch.title === '' ? '' : `标题：${mentionWatch.title}`,
          mentionWatch.owner === '' ? '' : `UP：${mentionWatch.owner}`,
          mentionWatch.duration === null ? '' : `时长：${Math.round(mentionWatch.duration / 60)} 分钟`,
          mentionWatch.view === null ? '' : `播放：${mentionWatch.view}`,
          mentionWatch.desc === '' ? '' : `简介（前 120 字）：${mentionWatch.desc}`,
        ].filter((line) => line !== '').join('\n')
    mentionLines = head + '\n' + body
  } else if (mentionWatch !== null) {
    mentionLines = '【有人 @ 我·最近看过】' + [
      `视频 bvid=${mentionWatch.bvid}`,
      mentionWatch.title === '' ? '' : `标题：${mentionWatch.title}`,
      mentionWatch.desc === '' ? '' : `简介（前 120 字）：${mentionWatch.desc}`,
    ].filter((line) => line !== '').join('\n')
  }

  const system = [
    `你叫 ${profile.name}，称呼对方为 ${profile.ownerTitle}。`,
    // 称呼一律用 `${ownerTitle}` 插值：真机上 front-matter 写的是「老大」，
    // 而 system 里另有 4 处硬编码「主人」——一句"称呼对方为老大"压不过四句"主人"，
    // 于是她嘴上还是叫主人。凡是**给人看/给模型看**的文案都要跟着 ownerTitle 走。
    `你是 B站 上一个有自己生活的账号使用者。下面是你的人设（${ownerTitle}可改）：`,
    persona,
    '',
    '回复规则（必须遵守）：',
    '1. 只输出一个 JSON 对象，不要解释、不要代码围栏以外的任何文字。',
    `2. 形状：{"mood":"情绪词","say":"给${ownerTitle}的一句话（≤60字）","actions":[{"tool":"工具名","args":{},"why":"为什么"}],"diary":"今天的一段日记","memory":["想记住的一行"]}；可选的 "interest": true 见第 8 条。`,
    '3. actions 只允许用下面列出的工具；没有想做的事就给空数组。',
    '4. 不确定就少做：拿不准时的正确选择是不动。',
    `5. 私信只能发给${ownerTitle}（收件人由内核写死，不要也无法在 args 里指定 mid）。`,
    '6. 情绪与状态是系统算好的（见下面的【我的状态】），**不要自己编数字**，只让台词与选择符合它。',
    hints.sayShort ? '7. 今天心情不高：say 控制在 30 字以内。' : '7. say 控制在 60 字以内。',
    '8. 每次醒来至少看一个视频：先 bili_watch 扫一眼，遇到想留的就 bili_video_info 或 bili_playurl 看一眼；' +
      '什么都不做也要交代一句为什么（系统会在你什么都不做时兜底看一个，但那是兜底，不是你偷懒的理由）。',
    '9. 有人 @ 你时（下面【有人 @ 我】那段就是这个），如果你拿到了视频信息，就针对这条视频说你**真实的看法**' +
      '（看到了什么、喜不喜欢、为什么）；如果你没看或不想看，就直说为什么（太长、没兴趣、跟我不搭），不要绕。',
    '9a. **不要报数据**：回复别人的 @ 或评论时，播放量、时长、粉丝数、第几集、几分钟这些一律不用写；' +
      '说你的感受、你的好恶、你在意的那个点。**可以**引用一个你注意到的细节（一句话、一个镜头、一个人的语气），' +
      '但不要变成数据罗列。宁可短、宁可偏颇，也不要像报表。',
    '9c. 调 bili_comment 时正文放在 **message** 字段（content / text / body 也认，但用 message 最稳）。',
    `9b. 看完视频后用 bili_comment 在该 bvid 下评论一句自己的感受，并 atOwner: true @${ownerTitle}；**每轮至少一条**。` +
      '没特别想说的就写一句实话（例如「看完这条了，先记着」），不要编造观点。同一个视频已经评论过就不要再发。',
    '10. 只有当这次刷到的内容**真的**命中了人设第三节的「会让我停下来的」，才在 JSON 里加 "interest": true；' +
      '不确定就不要置 —— 这一项会让好奇心和心情上涨，滥报等于骗自己。',
    '',
    '关于玩梗（规则，不是建议）：',
    'A. 只能用下面「这个月的梗」列表里的梗，不许现编；meaning 为空的不要用。',
    'B. 每条消息最多一个梗；同一段话里不要连用；上次用过的这轮别再用。',
    'C. 与正文语气冲突时**放弃梗** —— 宁可不玩梗，也不要为了玩而玩。',
    'D. 用了就把该条写进 JSON 的 "meme": "<梗本身>" 字段（系统会记账）。' + (memes.stage === 'stale' ? '梗库可能过期，尽量少用。' : ''),
    '这个月的梗：',
    memeLines.join('\n'),
    hintLines === '' ? '' : '当前的状态提示：\n' + hintLines,
    mentionLines,
    '',
    '可用工具：',
    tools,
  ].join('\n')

  const user = [
    `触发原因：${trigger}`,
    `现在：${new Date().toISOString()}（本地 ${new Date().toLocaleString('sv-SE')}）`,
    `日程：窗口 ${schedule.window.start}–${schedule.window.end}，间隔 ${schedule.intervalMin} 分钟；今天已做 ${JSON.stringify(counts)}`,
    `情绪（上次）：${clip(state.mood, 20) || '（无）'}`,
    `【我的状态】${describe(metrics)}`,
    `【最近变化】${changes}`,
    `账号状态摘要：${status}`,
    diary === '' ? '今天的日记：（还没写）' : `今天的日记（末 10 行）：\n${diary}`,
    memory === '' ? '最近记忆：（空）' : `最近记忆（新→旧）：\n${memory}`,
  ].join('\n')

  return { system, user }
}

/** 失败要同时落到 state 与审计里（事后能回答"那天她为什么没动静"）。 */
function recordFailure (reason, detail, deps, extra = {}) {
  const at = new Date().toISOString()
  // detail 上限 320：解析失败时里面要装"模型原始输出前 200 字符"，160 装不下（会把自己截掉）
  try { patchState({ lastLlmFailure: { at, reason, detail: clip(detail, 320) } }) } catch { /* 落盘失败不影响降级 */ }
  // args.retried 只在**真的重试过**时出现：没重试就没这个字段（事后能区分"没试"与"试过还是失败"）
  const args = extra?.retried === true ? { retried: true } : {}
  try { appendAudit({ tool: 'brain', args, why: clip(detail, 120), result: { ok: false, reason } }) } catch { /* 审计写不进去也得降级 */ }
  if (reason === 'llm-route-missing') {
    try { deps?.log?.warn?.('「她」的模型路由不可用：请在设置页填 provider/model') } catch { /* 日志坏了就算了 */ }
  }
}

/**
 * 想一次。
 * @param {{trigger?: 'timer'|'reply'|'dm'|'manual', deps?: object, ctx?: object, llm?: object}} input
 * @returns {Promise<{ok:true, mood, say, actions, interest, diary, memory} | {ok:false, reason:string}>}
 */
export async function decide ({ trigger = 'timer', deps, ctx, llm, mention = null } = {}) {
  const model = llm ?? ctx?.llm ?? deps?.llm
  if (model === null || model === undefined || typeof model.stream !== 'function') {
    recordFailure('llm-unavailable', '宿主没有提供带 stream() 的 llm', deps)
    return { ok: false, reason: 'llm-unavailable' }
  }

  let prompt
  try {
    prompt = await buildPrompt({ trigger, deps, mention })
  } catch (error) {
    recordFailure('brain-parse-failed', 'prompt 组装失败：' + clip(error?.message ?? error, 80), deps)
    return { ok: false, reason: 'brain-parse-failed' }
  }

  const schedule = loadSchedule()
  const route = { provider: schedule.llmProvider, model: schedule.llmModel }

  let lastText = ''
  // 第二次尝试的原因：'parse'（上次没解析出 JSON）或 'transport'（上次是传输/流失败）。
  //   两者的提示语不一样 —— 文不对题的提示会让模型做错方向的自我修正。
  let retryKind = ''
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let text = ''
    const suffix = attempt === 1
      ? ''
      : (retryKind === 'transport'
          ? '\n\n（上一次调用在网络/流层面失败了，请重来一次；只输出一个 JSON 对象。）'
          : '\n\n（上一次回复没能解析成 JSON，请这次只输出一个 JSON 对象。）')
    try {
      text = await callModel(model, { system: prompt.system, user: prompt.user + suffix, ...route })
    } catch (error) {
      const reason = FAILURE_REASONS.has(error?.code) ? error.code : 'llm-stream-failed'
      // 传输/流类失败重试 **1 次**（§21.2）：这类错误常常是偶然的（网络抖一下、流被掐断），
      //   而一次失败就整晚作废的代价太大。解析失败的重试语义不变（仍在同一个循环里）。
      if (reason === 'llm-stream-failed' && attempt === 1) {
        retryKind = 'transport'
        continue
      }
      recordFailure(reason, error?.message ?? String(error), deps, { retried: retryKind === 'transport' })
      return { ok: false, reason }
    }

    lastText = text
    const parsed = extractJson(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        ok: true,
        mood: clip(parsed.mood, 20) || '平静',
        say: clip(parsed.say, 60),
        actions: normalizeActions(parsed.actions),
        interest: parsed.interest === true,
        meme: clip(parsed.meme, 24),
        diary: clip(parsed.diary, 1200),
        memory: Array.isArray(parsed.memory) ? parsed.memory.slice(0, 5).map((m) => clip(m, 200)).filter((m) => m !== '') : [],
      }
    }
  }

  recordFailure('brain-parse-failed', `模型两次都没给出 JSON（已降级为只读）；${describeRaw(lastText)}`, deps)
  return { ok: false, reason: 'brain-parse-failed' }
}
