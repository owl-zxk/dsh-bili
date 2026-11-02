// 自主层外壳：定时器、单飞锁、总超时、把"想 → 做 → 记"串起来。
//
// 这一层对内核对内核只有一个接触面：**通过 deps.tools 里已注册的工具**（不直接调 api/*、
//   不拼 B站 请求）。所以内核的风控、token 预算、私信硬限制对它自动生效 —— 它是"另一个调用者"，
//   不是"特权用户"。
//
// 三条生命线（对应 AUTONOMY-PROMPT §1）：
//   ① start() 里任何一步失败都只记日志、不抛（宿主 apply 期绝不能被这一层炸掉）；
//   ② 每个 tick 都有 90 秒总超时 + 单飞锁：重叠的醒来直接跳过，卡住的醒来不会拖死第二个；
//   ③ 所有定时器都挂在 ctx.effect 上，卸载 / 热重载时自动清理（stop() 也幂等）。
//
// 为什么醒来要分"先看状态，再想，再做"：模型很愿意在预算耗尽时继续给你编计划。
//   先读 bili_status 能在花掉一次 LLM 调用之前就判断"今天别动了"。
import { appendAudit } from './audit.js'
import { decide } from './brain.js'
import { runActions } from './actions.js'
import { appendDiary, todayDiary } from './diary.js'
import { appendMemory, recentMemory } from './memory.js'
import { readPersona, readProfile } from './persona.js'
import {
  canRunNow, clearSilence, countsToday, loadSchedule, markFailure, markSuccess,
  bumpCount, inWindow, nextWakeAt, silenceFor, tryLock, unlock,
} from './schedule.js'
import { readState, patchState } from './state.js'
import { applyEvent, behaviorHints, decayTo, effectiveAllows, readMetrics, regenEnergy } from './metrics.js'
import { bumpSeen, refreshMemes, shouldRefresh } from './memes.js'

/** 单个 tick 的总超时（§4）。 */
export const TICK_TIMEOUT_MS = 90_000
/** 事件轮询间隔（§4：每 5 分钟查一次私信）。 */
export const EVENT_POLL_MS = 5 * 60_000
/** 计划器心跳：每分钟看一眼"是不是该醒了"。 */
const PLANNER_MS = 60_000

const MOOD_EMOTION = {
  happy: 'happy', 开心: 'happy', 高兴: 'happy',
  curious: 'curious', 好奇: 'curious', 疑惑: 'curious',
  sleepy: 'sleepy', 困: 'sleepy', 累: 'sleepy', 平静: 'idle',
  annoyed: 'annoyed', 烦: 'annoyed', 生气: 'annoyed',
  excited: 'excited', 兴奋: 'excited', 激动: 'excited',
}

export function moodToEmotion (mood) {
  const key = String(mood ?? '').trim()
  return MOOD_EMOTION[key] ?? MOOD_EMOTION[key.toLowerCase?.()] ?? 'idle'
}

let runtime = null

/**
 * 「醒了但什么也没说」时的兜底台词。
 *
 * 为什么需要它：醒来是**大概率什么都不发生**的（窗口外、能量低、没兴趣、模型这条没给 say）。
 *   但"什么都没发生"不等于"不存在" —— 日记会整天空白、设置页的"上一句"空着像坏了、
 *   事后也查不出"她到底醒没醒"。所以每一轮都必须留下**一句人话**。
 *
 * 为什么是 3–5 句而不是一句模板：同一句话每天重复几十遍就成了机器人。
 *   这里按"窗口外 / 太累 / 腻了 / 其它"分四组，组内用 metrics 的数值算索引选一句 ——
 *   同一档位下不同状态会落到不同句子上，看起来不像复读。
 */
function fallbackLine ({ outsideWindow, energy, boredom, mood }) {
  const pool = outsideWindow
    ? ['还没到我活跃的时候，先躺着', '外面还静，我眯一会儿', '窗口还没开，等会儿再来']
    : energy < 20
      ? ['有点累，今天不太想动', '没什么力气，就看两眼', '今天先歇着']
      : boredom > 70
        ? ['有点腻了，换个口味再说', '今天看什么都提不起劲', '刷得有点烦，停一会儿']
        : ['醒了一下，没什么想说的', '看了一眼，没什么要做的', '这轮没什么想做的，下次再说']
  const seed = Math.abs(Math.round(Number(energy) || 0) + Math.round(Number(boredom) || 0) * 7 + Math.round(Number(mood) || 0) * 13)
  return pool[seed % pool.length]
}

const clip = (value, max) => String(value ?? '').slice(0, max)

/** 在 ctx.effect 上注册一个周期任务；拿不到 effect 就退回普通定时器（stop() 仍然能清）。 */
function every (ctx, ms, fn, cleanups) {
  let timer = null
  const start = () => {
    timer = setInterval(() => {
      try { fn() } catch { /* 定时器回调里绝不让异常冒到 cordis */ }
    }, ms)
    if (timer !== null && typeof timer.unref === 'function') timer.unref()
  }
  const stop = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
  start()
  cleanups.push(stop)
  try {
    if (typeof ctx?.effect === 'function') ctx.effect(() => stop)
  } catch { /* effect 不可用 → 由 stop() 兜底 */ }
  return stop
}

function withTimeout (promise, ms) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), Math.max(1, ms))
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([Promise.resolve(promise).finally(() => { if (timer !== null) clearTimeout(timer) }), timeout])
}

function avatarOf (ctx) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get('avatar') ?? null
    return ctx?.avatar ?? null
  } catch {
    return null
  }
}

/**
 * 作息的"指纹"：只要这几项没变，下一次醒来时间就不该被重算。
 *
 * 为什么必须有它：`nextWakeAt` 带 ±jitter，**每次算出来的值都不一样**。
 *   如果计划器每分钟都"采纳新算的值"，nextAt 就会被无限往后推 —— 她永远也不会到点。
 *   所以规则是：**只有指纹变了（用户改了作息）才采纳新值**，否则沿用缓存的那一个。
 */
/** 写通道（会被 B站 判营销/风控的那几个）。用来分级风险：写失败 ≠ 账号被风控。 */
const WRITE_TOOLS = new Set(['bili_comment', 'bili_reply', 'bili_dm', 'bili_dynamic', 'bili_dynamic_edit', 'bili_favorite', 'bili_like', 'bili_follow', 'bili_comment_del', 'bili_comment_top', 'bili_dynamic_top'])
/** 写通道被拒后的冷却时长（10 分钟）：只停写，不停读、不停 tick。 */
const WRITE_COOLDOWN_MS = 10 * 60_000
/** reply 遇到 risk-control 的一次性重试间隔（-412 有时是瞬时的）。 */
const REPLY_RETRY_DELAY_MS = 20_000

/** 「看视频」类动作：任一执行成功就算这一轮看过视频了（§18.1）。 */
const WATCH_TOOLS = new Set(['bili_watch', 'bili_video_info', 'bili_playurl'])
/** 兜底最多看几条（§18.1 写死 5）。 */
const FALLBACK_WATCH_LIMIT = 5

const resultBrief = (result) => (result !== null && typeof result === 'object'
  ? { ok: result.ok === true, reason: result.reason ?? null }
  : { ok: false, reason: 'no-result' })

/**
 * 「每次醒来至少看一个视频」的兜底（§18）。
 *
 * 为什么需要它：大脑很愿意回一个空 actions（"今天没什么想做的"），而"看一眼"是这个角色的
 *   基本存在方式 —— 一整天什么都没看，她就成了纯定时器。所以做一层**不绕过任何闸**的兜底。
 *
 * 三条纪律：
 *   ① 读通道被关 / 精力 < 10 → 不兜底，只记审计（她真睡着了，别硬开机）；
 *   ② 只换一次源（popular → ranking），失败就结束，绝不重试、绝不刷；
 *   ③ 每一轮最多一次（调用点在 tick 末尾，只跑一遍）。
 */
async function ensureMinWatch ({ deps, schedule, metrics, trigger }) {
  const allows = effectiveAllows(schedule.allows, metrics)
  const skip = (reason) => {
    appendAudit({ tool: 'watch-fallback', args: { fallback: true, skipped: reason }, why: '至少看一个视频（跳过：' + reason + '）', result: { ok: false, reason } })
    return null
  }
  // 判断顺序有意义（2026-11-01 修正文案）：**先判精力**，再判读通道。
  //   因为 effectiveAllows 在 energy < 10 时会把 read 一起关掉（"只剩活着"），
  //   若先判 allows.read，精力低的时候审计会写成"读通道被关" —— 那是**结果**不是**原因**，
  //   会把人指向错误的方向（去查 allows 配置，其实她只是累了）。
  //   两条文案要能一眼分清：一个是累，一个是被规则禁。行为不变（都是不兜底）。
  if (metrics.energy < 10) return skip('精力太低（energy=' + metrics.energy + ' < 10），不兜底看视频')
  if (allows.read !== true) return skip('读通道被关（allows.read=false），不兜底看视频')

  const first = await runTool(deps, 'bili_watch', { source: 'popular', limit: FALLBACK_WATCH_LIMIT })
  appendAudit({ tool: 'bili_watch', args: { source: 'popular', limit: FALLBACK_WATCH_LIMIT, fallback: true }, why: '至少看一个视频（兜底）', result: resultBrief(first) })
  let watch = first
  if (watch === null || watch.ok !== true) {
    // 只换一次源（§18.1）
    watch = await runTool(deps, 'bili_watch', { source: 'ranking', limit: FALLBACK_WATCH_LIMIT })
    appendAudit({ tool: 'bili_watch', args: { source: 'ranking', limit: FALLBACK_WATCH_LIMIT, fallback: true }, why: '至少看一个视频（兜底·换源一次）', result: resultBrief(watch) })
  }

  // reason 必须带上：tick 末尾的风险分级靠它判断"读通道是不是被 risk-control 拒了"
  const executed = [{ tool: 'bili_watch', ok: watch !== null && watch.ok === true, reason: watch?.reason ?? undefined, fallback: true }]
  // 拿到列表就挑第一条看一眼详情（失败只记审计，不换条、不重试）
  const items = Array.isArray(watch?.data?.items) ? watch.data.items : (Array.isArray(watch?.data?.list) ? watch.data.list : [])
  const firstBvid = items.length > 0 ? String(items[0]?.bvid ?? '') : ''
  if (firstBvid !== '') {
    const info = await runTool(deps, 'bili_video_info', { bvid: firstBvid })
    appendAudit({ tool: 'bili_video_info', args: { bvid: firstBvid, fallback: true }, why: '至少看一个视频（兜底·看详情）', result: resultBrief(info) })
    executed.push({ tool: 'bili_video_info', ok: info !== null && info.ok === true, reason: info?.reason ?? undefined, fallback: true })
  }

  // 指标与今日计数照常记（观测与限制是两件事）
  try {
    applyEvent('read-action')
    bumpCount('read')
  } catch { /* 指标/计数写不进去不影响这一轮 */ }
  void trigger
  return executed
}

/** 本窗口"这一次会话"的起点（粗略到小时级即可，只用来做"每个窗口最多一条"的去重）。 */
function currentWindowStart (schedule, now) {
  let cursor = now
  let last = now
  for (let i = 0; i < 26; i += 1) {
    const step = cursor - 3600_000
    if (inWindow(schedule, step) !== true) break
    last = step
    cursor = step
  }
  return last
}

/** 睡前汇报的正文：**确定性模板**（不额外调模型 —— 省一次调用，也保证内容可预测）。 */
function bedtimeTemplate ({ counts, energy, mood, boredom, lastLine }) {
  const watched = Number(counts?.read ?? 0)
  const comments = Number(counts?.comment ?? 0)
  const replies = Number(counts?.reply ?? 0)
  const dynamics = Number(counts?.dynamic ?? 0)
  const said = comments + replies + dynamics
  const lines = [
    '今天这会儿我做了这些：',
    `· 看了 ${watched} 条视频（B 站热门/排行/关注）`,
    `· 说了 ${said} 句（评论 ${comments} 条、回复 ${replies} 条、动态 ${dynamics} 条）`,
    `· 现在：精力 ${energy} · 心情 ${mood} · 倦怠 ${boredom}`,
  ]
  // 「最后一句话」这一行**有内容才写**：空着写「最后一句话：「」」比不写更难看，
  //   而且会让人以为她说了句空的。
  const tail = String(lastLine ?? '').trim()
  if (tail !== '') lines.push(`· 最后一句话：「${tail}」`)
  lines.push('睡一会儿，醒来再说。')
  return lines.join('\n')
}

/**
 * 睡前汇报（§20.2）：只在"本窗口最后一次醒来"时发，每个窗口最多一条。
 * 失败只记审计，不重试、不阻塞（mail 层已经受 dmGapSec 与 token 预算管）。
 */
async function maybeBedtimeReport ({ deps, now, nextWake, say, previousLine }) {
  const schedule = loadSchedule()
  if (schedule.bedtimeReport !== true) return null
  if (nextWake === null) return null
  if (inWindow(schedule, nextWake) === true) return null   // 下次还在窗口内 → 不是最后一次
  if (effectiveAllows(schedule.allows, readMetrics()).dm !== true) return null // 私信通道关着 → 不发

  // 每个窗口最多一条：上一次汇报若落在"本窗口这一次会话"之内，就不再发
  const state = readState()
  const lastAt = Date.parse(String(state.lastBedtimeReportAt ?? ''))
  const sessionStart = currentWindowStart(schedule, now)
  if (Number.isFinite(lastAt) && lastAt >= sessionStart) return null
  if (Number.isFinite(lastAt) && now - lastAt < 30 * 60_000) return null // 兜底：30 分钟内不重复

  const metrics = readMetrics()
  const text = bedtimeTemplate({
    counts: countsToday(),
    energy: metrics.energy,
    mood: metrics.mood,
    boredom: metrics.boredom,
    // 用**这一轮她真正说的话**（thought.say）；没有才退回**上一轮**的 lastLine。
    //   两者都空 → 模板会把这一行整行省略（不要写「最后一句话：「」」）。
    lastLine: String(say ?? '').trim() !== '' ? String(say).trim() : String(previousLine ?? '').trim(),
  })
  const result = await runTool(deps, 'bili_dm', { text })
  appendAudit({ tool: 'bili_dm', args: { text, report: true }, why: '睡前汇报', result: resultBrief(result) })
  if (result !== null && result.ok === true) {
    try { patchState({ lastBedtimeReportAt: new Date(now).toISOString() }) } catch { /* 去重写不进去 → 下次可能重发一条，可接受 */ }
    // 落在数据里的文案也要跟着他设的称呼走（日记是给人看的，不是代码注释）
    try { appendDiary(`睡前给${readProfile().ownerTitle}汇报了一下今天做了什么`) } catch { /* 日记写不进去不影响 */ }
  }
  return result
}

/** 醒来汇报的正文（§21.1）：确定性模板，≤200 字，只用**本轮增量**。 */
function wakeTemplate ({ now, watched, said, say }) {
  const d = new Date(now)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const lines = [
    `${hh}:${mm} 醒了。`,
    `这轮：看过 ${watched} 条 / 说了 ${said} 句`,
  ]
  const tail = String(say ?? '').trim()
  if (tail !== '') lines.push(`说：「${tail}」`)
  return lines.join('\n').slice(0, 200)
}

/**
 * 每次醒来发一条短私信（§21.1）。默认关；与睡前汇报互斥（一晚不要两条）。
 * 失败只记审计，不重试、不阻塞。
 */
async function maybeWakeReport ({ deps, now, allowed, before, whenBedtimeReported, say }) {
  const schedule = loadSchedule()
  if (schedule.dmEveryWake !== true) return null
  if (whenBedtimeReported === true) return null   // 这一轮已经发了睡前汇报 → 不再发
  if (allowed !== true) return null               // 私信通道关着

  const after = countsToday()
  // 只算**本轮增量**：全天累计会让"这轮：看过 27 条"变成误导
  const watched = Math.max(0, Number(after.read ?? 0) - Number(before?.read ?? 0))
  const comments = Math.max(0, Number(after.comment ?? 0) - Number(before?.comment ?? 0))
  const replies = Math.max(0, Number(after.reply ?? 0) - Number(before?.reply ?? 0))
  const dynamics = Math.max(0, Number(after.dynamic ?? 0) - Number(before?.dynamic ?? 0))
  const text = wakeTemplate({ now, watched, said: comments + replies + dynamics, say })
  const result = await runTool(deps, 'bili_dm', { text })
  appendAudit({ tool: 'bili_dm', args: { text, wakeReport: true }, why: '醒来汇报', result: resultBrief(result) })
  return result
}

/** 评论正文：去掉开头的 @xx、压掉换行、≤120 字；没有就拿一句实话顶上（不编观点）。 */
const COMMENT_FALLBACK_TEXT = '看完这条了，先记着。'
function commentTextOf (say) {
  const raw = String(say ?? '')
    .replace(/^(\s*@[^\s@]+\s*)+/u, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const text = raw.slice(0, 120)
  return text === '' ? COMMENT_FALLBACK_TEXT : text
}

/**
 * 「看完必须评论」（§22）：这一轮看过视频但没发过 bili_comment → 兜底补一条。
 *
 * 为什么用 runActions 而不是直接 runTool：**闸必须照旧生效**
 *   （allows.comment / confidence 阈值 / 每日上限 / 写间隔 / 同 bvid 去重 / token 预算），
 *   这些判断都长在 actions + api 层里，绕过去等于开了一个后门。
 * 每轮最多补一条；失败/被跳过只记审计，不重试。
 */
async function ensureCommentAfterWatch ({ deps, schedule, outcome, say }) {
  if (schedule.commentAfterWatch === false) return []
  const watched = outcome.executed.some((x) => x.ok === true && WATCH_TOOLS.has(x.tool))
  if (!watched) return []
  if (outcome.executed.some((x) => x.ok === true && x.tool === 'bili_comment')) return []

  // bvid：actions 在 watch / video_info 成功后已写进 state.lastWatchedBvid
  const bvid = String(readState().lastWatchedBvid ?? '').trim()
  if (bvid === '') {
    appendAudit({ tool: 'bili_comment', args: { commentFallback: true }, why: '看完评论（兜底·没有可用的 bvid，跳过）', result: { ok: false, reason: 'no-bvid' } })
    return []
  }

  const out = await runActions({
    ok: true,
    actions: [{ tool: 'bili_comment', args: { bvid, message: commentTextOf(say) }, why: '看完评论（兜底）', fallback: true }],
  }, deps)
  const okComment = out.executed.filter((x) => x.tool === 'bili_comment' && x.ok === true)
  if (okComment.length === 0) {
    // 没发出去：分两种，别重复记账
    //   · 被闸挡下（根本没调用工具）→ 补一条审计说明原因；
    //   · 调了但失败（写间隔 / token 预算 / 接口错误）→ actions 已经记过那条失败审计，这里不再加。
    const attempted = out.executed.some((x) => x.tool === 'bili_comment')
    if (!attempted) {
      const whySkipped = out.skipped.find((x) => x.tool === 'bili_comment')?.why ?? 'unknown'
      appendAudit({ tool: 'bili_comment', args: { commentFallback: true }, why: '看完评论（兜底·被跳过：' + whySkipped + '）', result: { ok: false, reason: whySkipped } })
    }
  }
  return okComment
}

/* ───────────────── 有人回复/私信时要回（§23） ───────────────── */

/** 检查哪些评论：最多 3 条最新、48 小时内（§23.2 的成本上限）。 */
const REPLY_CHECK_MAX = 3
const REPLY_CHECK_WINDOW_MS = 48 * 3600_000
/** 已见过的回复 rpid 最多记这么多条。 */
const SEEN_REPLY_MAX = 100
/**
 * 两次"检查有没有人回复"之间至少隔 30 分钟。
 *
 * 来源：省读请求（§23.3 的成本上限 + 2026-11-01 用户决定）。
 *   每轮都查 3 条 = 一晚几十次 bili_replies，而别人的回复不会在半小时内反复变；
 *   30 分钟的延迟对"回一句"完全够用。
 */
const REPLY_CHECK_GAP_MS = 30 * 60_000
/** 私信兜底 / 评论回复兜底的正文（都没话说时用，承认没话说）。 */
const DM_FALLBACK_TEXT = '看到你的消息了，我先记着。'
const REPLY_FALLBACK_TEXT = '看到了，等下细说。'

/** dm 触发的那一轮：没发出 bili_dm → 兜底回一条（§23.1）。 */
async function ensureDmReply ({ deps, schedule, outcome, trigger, say }) {
  if (trigger !== 'dm') return []
  if (schedule.replyToDm === false) return []
  if (outcome.executed.some((x) => x.ok === true && x.tool === 'bili_dm')) return []
  const text = String(say ?? '').trim() || DM_FALLBACK_TEXT
  const out = await runActions({
    ok: true,
    actions: [{ tool: 'bili_dm', args: { text }, why: '回复私信（兜底）', fallbackKind: 'dm' }],
  }, deps)
  return out.executed.filter((x) => x.tool === 'bili_dm' && x.ok === true)
}

/**
 * 有人回了她的评论 → 回一句（§23.2）。
 *
 * 成本纪律（§23.3）：每轮最多 3 次读（只查 3 条最新、48h 内），最多 1 条回复；
 *   **不在这里调 llm**（上下文已经有了这一轮的决策），也不引入任何定时器。
 */
async function ensureCommentReply ({ deps, schedule, outcome, say }) {
  if (schedule.replyToComments === false) return []
  if (outcome.executed.some((x) => x.ok === true && x.tool === 'bili_reply')) return []

  const state = readState()
  const mine = (Array.isArray(state.myComments) ? state.myComments : [])
    .filter((x) => x !== null && typeof x === 'object' && Date.now() - Date.parse(String(x.at ?? '')) <= REPLY_CHECK_WINDOW_MS)
    .slice(-REPLY_CHECK_MAX)    // 只看最新 3 条（§23.2 的成本上限）
  if (mine.length === 0) return []

  // 节流：30 分钟内查过就不再查。**不写审计** —— 否则每轮一条"没查"的噪音。
  const lastCheck = Date.parse(String(state.lastReplyCheckAt ?? ''))
  if (Number.isFinite(lastCheck) && Date.now() - lastCheck < REPLY_CHECK_GAP_MS) return []
  try { patchState({ lastReplyCheckAt: new Date().toISOString() }) } catch { /* 写不进去 → 下轮可能再查一次，不影响正确性 */ }

  const seen = new Set((Array.isArray(state.seenReplyRpids) ? state.seenReplyRpids : []).map((x) => String(x)))
  const selfMid = String(state.selfMid ?? '').trim()
  const fresh = []
  for (const entry of mine) {
    const root = String(entry.rpid ?? '').trim()
    const oid = String(entry.aid ?? '').trim()
    if (root === '' || oid === '') continue
    const out = await runTool(deps, 'bili_replies', { oid, root })
    if (out === null || out.ok !== true) continue
    const list = Array.isArray(out.data?.replies) ? out.data.replies : (Array.isArray(out.data?.items) ? out.data.items : [])
    for (const item of list) {
      const rpid = String(item?.rpid ?? '').trim()
      if (rpid === '' || seen.has(rpid)) continue
      const mid = String(item?.mid ?? item?.author?.mid ?? '').trim()
      if (selfMid !== '' && mid === selfMid) continue   // 自己的回复不算
      // §24.3：必须**直接回她那条**（parent === 她的 rpid）。别人回别人不该她插嘴 ——
      //   bili_replies 里 parent 字段实测存在，用它而不是"在这层楼里就算"。
      const parent = String(item?.parent ?? item?.parentStr ?? '').trim()
      if (parent !== '' && parent !== String(entry.rpid)) continue
      fresh.push({ oid, root, rpid, text: clip(item?.content?.message ?? item?.text ?? '', 200) })
    }
  }
  appendAudit({ tool: 'bili_replies', args: { replyCheck: true }, why: '检查评论回复：检查 ' + mine.length + ' 条 / 新 ' + fresh.length + ' 条', result: { ok: true } })
  if (fresh.length === 0) return []

  // 记下已见（避免下一轮重复回同一条）
  try {
    const nextSeen = [...seen, ...fresh.map((x) => x.rpid)].slice(-SEEN_REPLY_MAX)
    patchState({ seenReplyRpids: nextSeen })
  } catch { /* 写不进去 → 下轮可能重复回一条，能接受 */ }

  // 用最近 3 条新回复里最新的一条作为回复目标
  const target = fresh[fresh.length - 1]
  const text = String(say ?? '').trim() || REPLY_FALLBACK_TEXT
  const out = await runActions({
    ok: true,
    actions: [{
      tool: 'bili_reply',
      args: { oid: target.oid, root: target.root, rpid: target.rpid, message: text },
      why: '回复评论（兜底）',
      fallbackKind: 'reply',
    }],
  }, deps)
  const okReply = out.executed.filter((x) => x.tool === 'bili_reply' && x.ok === true)
  if (okReply.length === 0) {
    const attempted = out.executed.some((x) => x.tool === 'bili_reply')
    if (!attempted) {
      const whySkipped = out.skipped.find((x) => x.tool === 'bili_reply')?.why ?? 'unknown'
      appendAudit({ tool: 'bili_reply', args: { replyFallback: true }, why: '回复评论（兜底·被跳过：' + whySkipped + '）', result: { ok: false, reason: whySkipped } })
    }
  }
  return okReply
}

/** 已见过的 @ id 最多记这么多条。 */
const SEEN_AT_ME_MAX = 100
/** 「有人 @ 我」的兜底正文。 */
const MENTION_FALLBACK_TEXT = '看到你@我了，我来了。'
/**
 * 「@ 我」的检查与评论回复**共用**同一个 30 分钟节流窗口（不再单独加一个 lastMentionCheckAt）。
 * 为什么合用：两者都是"看看有没有人跟我说话"，同一轮一起查最省；
 *   分成两个独立窗口只会在同一分钟里发两次读请求，还多一个状态字段要维护。
 */
const MENTION_LIMIT = 5

/**
 * 「@ 我」的前置检查（§24.2 + §25 结构改造）。
 *
 * 2026-11-02 改：**从"回完再看"改成"先看再决策"**。
 *   以前的顺序是 决策 → 读视频 → 用**上一轮**的 say 回一句，于是回复注定只能是
 *   "看到你@我了" 这种空话 —— 用户要的是"我真的看了，这个剪辑…"。
 *   现在把读 @ / 读视频提前到 decide 之前，视频信息直接进**本轮**的 prompt，
 *   模型这一次就能针对那条视频说话；而且**仍然只调 1 次模型**（不额外烧一轮）。
 *
 * 成本纪律：与评论回复共用 30 分钟节流窗口；每轮 bili_at_me 最多 1 次、
 *   bili_video_info 最多 1 次（只对"要回的那一条"读），失败不重试、不抛。
 */
async function checkMentions ({ deps, schedule }) {
  if (schedule.replyToMentions === false) return null

  const state = readState()
  const lastCheck = Date.parse(String(state.lastReplyCheckAt ?? ''))
  if (Number.isFinite(lastCheck) && Date.now() - lastCheck < REPLY_CHECK_GAP_MS) return null
  try { patchState({ lastReplyCheckAt: new Date().toISOString() }) } catch { /* 写不进去 → 下轮可能再查 */ }

  const out = await runTool(deps, 'bili_at_me', { limit: MENTION_LIMIT })
  if (out === null || out.ok !== true) return null
  const items = Array.isArray(out.items) ? out.items : (Array.isArray(out.data?.items) ? out.data.items : [])
  const seen = new Set((Array.isArray(state.seenAtMeIds) ? state.seenAtMeIds : []).map((x) => String(x)))
  const fresh = items.filter((item) => item !== null && typeof item === 'object' && String(item.id ?? '') !== '' && !seen.has(String(item.id)))
  appendAudit({ tool: 'bili_at_me', args: { mentionCheck: true }, why: '检查@我：查 ' + items.length + ' 条 / 新 ' + fresh.length + ' 条', result: { ok: true } })
  if (fresh.length === 0) return null

  // 新 @ 一律记为"看过了"，哪怕这条回不了（否则每轮都会把同一条翻出来）
  try {
    const nextSeen = [...seen, ...fresh.map((x) => String(x.id))].slice(-SEEN_AT_ME_MAX)
    patchState({ seenAtMeIds: nextSeen })
  } catch { /* 写不进去 → 下轮可能重复回一条，能接受 */ }

  // 取最新一条能回复的（要 oid + root + rpid 三件齐；只有 oid 的回不了）
  const target = fresh.slice().reverse().find((item) => String(item.oid ?? '') !== '')
  if (target === undefined) {
    appendAudit({ tool: 'bili_reply', args: { mentionFallback: true }, why: '回复@我（兜底·没有可回复的坐标：缺 oid）', result: { ok: false, reason: 'no-target' } })
    return null
  }
  const oid = String(target.oid ?? '').trim()
  const root = String(target.root ?? '').trim()
  const rpid = String(target.rpid ?? '').trim()
  if (root === '' || rpid === '') {
    // 只解析出 oid（缺 root/rpid）→ 跳过并写清原因：宁可不回，也不要发成顶层评论
    appendAudit({ tool: 'bili_reply', args: { mentionFallback: true }, why: '回复@我（兜底·坐标不全，跳过：oid=' + oid + ' root=' + (root || '-') + ' rpid=' + (rpid || '-') + '）', result: { ok: false, reason: 'incomplete-target' } })
    return null
  }

  // 真的看一眼：@ 里带 bvid 就读一次元信息（每条 @ 最多 1 次，不重试、不抛）
  const bvid = String(target.bvid ?? '').trim()
  let watch = null
  if (bvid !== '') {
    const info = await runTool(deps, 'bili_video_info', { bvid })
    if (info !== null && info.ok === true) {
      const data = info.data ?? {}
      watch = {
        bvid,
        title: clip(data.title ?? '', 80),
        desc: clip(data.desc ?? '', 120),
        duration: Number.isFinite(Number(data.duration)) ? Number(data.duration) : null,
        owner: clip(data.owner?.name ?? data.upName ?? '', 40),
        view: Number.isFinite(Number(data.stat?.view)) ? Number(data.stat.view) : null,
        at: new Date().toISOString(),
      }
      // 审计的 args 会被 audit.js 摊平成字符串（对象变 "[object]"），所以给 JSON 串 + 扁平字段
      appendAudit({
        tool: 'bili_video_info',
        args: { mentionWatch: JSON.stringify({ bvid, title: watch.title }), mentionBvid: bvid, mentionTitle: watch.title },
        why: '看被 @ 的那条视频',
        result: { ok: true },
      })
    } else {
      const err = info === null ? 'tool-missing' : String(info.reason ?? 'unknown')
      appendAudit({
        tool: 'bili_video_info',
        args: { mentionWatch: JSON.stringify({ bvid, error: err }), mentionBvid: bvid, mentionError: err },
        why: '看被 @ 的那条视频（没看成）',
        result: { ok: false, reason: err },
      })
    }
  }

  return { id: String(target.id ?? ''), oid, root, rpid, bvid, watch, text: clip(target.text ?? '', 200), uname: clip(target.uname ?? '', 40) }
}

/**
 * 用**本轮的 pending mention** 回一句（§24.2）。
 * 读 @ / 读视频已经在 checkMentions 里做过（决策之前），这里只负责把话发出去。
 * 每轮最多 1 条；被闸挡下只在 why 写原因，不重试。
 */
async function replyToMention ({ deps, outcome, mention, say }) {
  if (mention === null || mention === undefined) return []
  if (outcome.executed.some((x) => x.ok === true && x.tool === 'bili_reply')) return []

  const text = String(say ?? '').trim() || MENTION_FALLBACK_TEXT
  const action = { tool: 'bili_reply', args: { oid: mention.oid, root: mention.root, rpid: mention.rpid, message: text }, why: '回复@我（兜底）', fallbackKind: 'mention' }
  let replyOut = await runActions({ ok: true, actions: [action] }, deps)
  let okReply = replyOut.executed.filter((x) => x.tool === 'bili_reply' && x.ok === true)

  // ⑤ risk-control 时**重试一次**（§：-412 有时是瞬时的，而这条 @ 她已经看过视频了，值得再试）。
  //    同一条 @ 只重试 1 次；第二次仍失败 → 放弃并记 retried=true。
  const firstFailedRisk = okReply.length === 0 && replyOut.executed.some((x) => x.tool === 'bili_reply' && x.ok !== true && String(x.reason ?? '') === 'risk-control')
  if (firstFailedRisk) {
    const delayMs = Number.isFinite(Number(deps?.mentionRetryDelayMs)) ? Number(deps.mentionRetryDelayMs) : REPLY_RETRY_DELAY_MS
    // 注意：这里**不能 unref** —— unref 的定时器不阻止进程退出，await 会永远挂着（自验时踩到）。
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    // 第一次失败时 actions 已经设了 10 分钟写冷却；重试这一下要把它清掉，
    // 否则第二次会被自己的冷却挡成 write-cooldown（就白重试了）。
    try { patchState({ writeCooldownUntil: '' }) } catch { /* 清不掉就放弃重试 */ }
    replyOut = await runActions({ ok: true, actions: [{ ...action, why: '回复@我（兜底·重试一次）' }] }, deps)
    okReply = replyOut.executed.filter((x) => x.tool === 'bili_reply' && x.ok === true)
    if (okReply.length === 0) {
      appendAudit({ tool: 'bili_reply', args: { mentionFallback: true, retried: true }, why: '回复@我（重试一次仍被 risk-control 拒，放弃）', result: { ok: false, reason: 'risk-control' } })
    }
  }
  if (okReply.length === 0 && !replyOut.executed.some((x) => x.tool === 'bili_reply')) {
    const whySkipped = replyOut.skipped.find((x) => x.tool === 'bili_reply')?.why ?? 'unknown'
    appendAudit({ tool: 'bili_reply', args: { mentionFallback: true }, why: '回复@我（兜底·被跳过：' + whySkipped + '）', result: { ok: false, reason: whySkipped } })
  }
  return okReply
}

function schedulePrint (schedule) {
  return JSON.stringify({
    enabled: schedule?.enabled === true,
    windows: schedule?.windows ?? null,
    weekendAllDay: schedule?.weekendAllDay === true,
    weekendIntervalMin: schedule?.weekendIntervalMin ?? null,
    intervalMin: schedule?.intervalMin ?? null,
    jitter: schedule?.jitter ?? null,
  })
}

/**
 * 跑一个 tick（内部用；外部请走 runOnce）。
 * @param {'timer'|'reply'|'dm'|'manual'} trigger
 */
async function tick (trigger, deps) {
  const schedule = loadSchedule()
  const now = Date.now()
  if (trigger !== 'manual') {
    // ignoreLock: 我们已经持锁（runOnce 的第一行拿到了），这里的锁判断只会把自己判成 busy
    const verdict = canRunNow(now, schedule, { ignoreLock: true })
    if (verdict.ok !== true) {
      patchState({ lastSkip: { at: new Date(now).toISOString(), reason: verdict.reason } })
      return { ok: false, reason: verdict.reason, executed: [], skipped: [] }
    }
  } else if (!schedule.enabled) {
    return { ok: false, reason: 'disabled', executed: [], skipped: [] }
  }

  // ① 指标：先做跨天恢复（day-pass）→ 再按整小时恢复精力（§19）→ 最后记"醒来"的消耗。
  //    顺序有意义：前两步都是"休息"，wake 是"起床动了一下"，必须记在休息之后。
  let wakeMetric = null
  try {
    decayTo(now)            // 跨天：energy +15 / boredom -5 / mood 靠 50
    regenEnergy(now)        // 按闲置整小时恢复（窗口内 +3/h、窗口外 +6/h）；幂等
    wakeMetric = applyEvent('wake')  // 最后才扣本次醒来的消耗（-2）
  } catch { /* 指标写不进去不影响这一轮 */ }

  // ①b 梗库每月刷新（§14.3）：到期就试一次，**一天最多一次**、30 秒超时、失败不阻塞。
  //     故意不 await —— 刷新是"给下一轮准备料"，这一轮该干嘛干嘛；
  //     refreshMemes 自己会在最外层 catch 并把 stage 标成 stale。
  //
  //     只在**定时醒来**时尝试（trigger === 'timer'）：
  //       · 手动 run-once 是"现在想看看她说什么"，不该顺带烧一次模型调用；
  //       · 事件插队（有新私信/回复）更该先把回应做完。
  //     梗是按月变的，少这几次尝试完全不影响时效性。
  if (trigger === 'timer' && shouldRefresh(now)) {
    void refreshMemes({ llm: deps?.llm, tools: deps?.tools, ctx: deps?.ctx, now }).catch(() => {})
  }

  // ② 先看状态：**只有确实不能动时才整层静默**（2026-11-02 真机过激处置修复）。
  //    现场：一次 bili_reply 的 -412 让 bili_status 里出现 risk-control，
  //    于是整层被 silenceFor(2h) —— 她连『看』和『跟你说话』都停了，代价远大于一次写失败。
  //    分级：
  //      · "banned":true / token-budget-exhausted → 真的不能动：静默（2h / 1h）+ 审计。
  //      · 只是 risk-control 字样 → 视为**写通道被限**：只设 10 分钟写冷却，本轮照常走完。
  let blocked = null
  try {
    const status = await runTool(deps, 'bili_status', {})
    const text = JSON.stringify(status ?? {})
    if (/"banned":true/.test(text)) blocked = 'banned'
    else if (/token-budget-exhausted/.test(text)) blocked = 'token-budget-exhausted'
    else if (/risk-control/.test(text)) {
      // 低等级：只冷却写通道
      try { patchState({ writeCooldownUntil: new Date(now + WRITE_COOLDOWN_MS).toISOString() }) } catch { /* 写不进去 → 下一轮再判 */ }
      appendAudit({ tool: 'guard', args: { level: 'write-only', until: new Date(now + WRITE_COOLDOWN_MS).toISOString() }, why: '状态里出现 risk-control：只冷却写通道 10 分钟，不停读、不停 tick', result: { ok: true } })
    }
    if (blocked !== null) {
      const ms = blocked === 'banned' ? 2 * 3600_000 : 3600_000
      silenceFor(ms, blocked)
      // 重决策必须留痕：state 反推太费劲，这里直接写一条审计
      appendAudit({ tool: 'guard', args: { level: 'full', reason: blocked, ms }, why: `${blocked}：整层静默 ${Math.round(ms / 60000)} 分钟（${blocked === 'banned' ? '账号被禁' : 'token 预算耗尽'}）`, result: { ok: false, reason: blocked } })
      appendDiary(`（不动了：${blocked === 'banned' ? '账号被禁' : '今天的 token 预算用完了'}，安安静静待着）`)
      patchState({ lastWakeAt: new Date(now).toISOString(), lastSkip: { at: new Date(now).toISOString(), reason: blocked } })
      return { ok: false, reason: blocked, executed: [], skipped: [] }
    }
  } catch { /* 状态读不到就继续走（fail-open：读不到不等于不能活） */ }

  // ①c @ 我 的前置检查（§25 结构改造）：**先读 @、先看视频，再让她想**。
  //     为什么必须在 decide 之前：决策一旦定下来，视频信息就只能等下一轮才进上下文，
  //     这一次的回复只能是"看到你@我了"这种空话。提前读，同一条回复本身就能带视频细节。
  //     成本：bili_at_me 最多 1 次、bili_video_info 最多 1 次（只对要回的那条），
  //     仍然只有 1 次模型调用（不是"再问一遍模型"）。
  let pendingMention = null
  try {
    pendingMention = await checkMentions({ deps, schedule })
  } catch { /* 读 @ 失败不影响这一轮 */ }

  // ② 想
  const thought = await decide({ trigger, deps, llm: deps?.llm, ctx: deps?.ctx, mention: pendingMention })
  if (thought.ok !== true) {
    appendMemory({ kind: 'system', text: 'brain-parse-failed：这次没想出可执行的计划，只做了只读', ref: trigger })
    appendDiary('（这次没想出计划，就只是刷了刷，没动嘴）')
    patchState({ lastWakeAt: new Date(now).toISOString(), lastSkip: { at: new Date(now).toISOString(), reason: thought.reason ?? 'brain-failed' } })
    return { ok: false, reason: thought.reason ?? 'brain-failed', executed: [], skipped: [] }
  }

  // 本轮计数快照：醒来汇报只报**本轮增量**（§21.1）
  const countsBefore = countsToday()

  // ②b selfMid 自愈（§23 修正）：不知道自己的 mid 时，会把**自己的回复**当成别人的新回复去回。
  //     只在缺失时调一次只读的 bili_status；失败就保持未知（不抛、不重试）。
  try {
    if (String(readState().selfMid ?? '').trim() === '') {
      const self = await runTool(deps, 'bili_status', {})
      const mid = self !== null && self.ok === true
        ? String(self.data?.login?.mid ?? self.data?.mid ?? self.data?.uid ?? '').trim()
        : ''
      if (mid !== '') patchState({ selfMid: mid })
    }
  } catch { /* 拿不到 mid 就保持未知，不影响这一轮 */ }

  // ③ 做（白名单 / 开关 / 预算 / 配额 / 去重都在 actions 里）
  // interest 是"这次刷到的东西真的命中她的喜好"（判据只来自大脑），透传给 actions 记一次 interest-hit
  const outcome = await runActions({ ok: true, actions: thought.actions, interest: thought.interest === true }, deps)

  // ③b 兜底：这一轮一条"看视频"的动作都没成功 → 至少看一个（§18）。
  //     它不绕过任何闸（读通道 / 精力 / 白名单都在 actions 里或这里先判过），
  //     也不与"去重"冲突：兜底用的 source/limit 是固定参数，不会重复发内容。


  const metricsNow = readMetrics()
  let fallbackExecuted = []
  if (schedule.minWatchPerWake === true) {
    const watched = outcome.executed.some((x) => x.ok === true && WATCH_TOOLS.has(x.tool))
    if (!watched) {
      try {
        fallbackExecuted = (await ensureMinWatch({ deps, schedule, metrics: metricsNow, trigger })) ?? []
      } catch { /* 兜底失败绝不影响这一轮 */ }
    }
  }
  if (fallbackExecuted.length > 0) outcome.executed = [...outcome.executed, ...fallbackExecuted]

  // ③b' 看完必须评论（§22）：看过视频但这一轮没发评论 → 补一条（闸全部照旧）
  try {
    const commentExecuted = await ensureCommentAfterWatch({ deps, schedule, outcome, say: thought.say })
    if (commentExecuted.length > 0) outcome.executed = [...outcome.executed, ...commentExecuted]
  } catch { /* 兜底评论失败绝不影响这一轮 */ }

  // ③b'' 有人回复/私信时要回（§23）：先私信，再评论回复；全部走 runActions，闸照旧
  try {
    const dmRows = await ensureDmReply({ deps, schedule, outcome, trigger, say: thought.say })
    if (dmRows.length > 0) outcome.executed = [...outcome.executed, ...dmRows]
  } catch { /* 私信兜底失败绝不影响这一轮 */ }
  try {
    const replyRows = await ensureCommentReply({ deps, schedule, outcome, say: thought.say })
    if (replyRows.length > 0) outcome.executed = [...outcome.executed, ...replyRows]
  } catch { /* 评论回复兜底失败绝不影响这一轮 */ }
  try {
    const mentionRows = await replyToMention({ deps, outcome, mention: pendingMention, say: thought.say })
    if (mentionRows.length > 0) outcome.executed = [...outcome.executed, ...mentionRows]
  } catch { /* @ 我兜底失败绝不影响这一轮 */ }

  // ③d 风险分级（§ 真机过激处置修复）：放在**所有兜底之后** —— 兜底里的读动作也可能被拒。
  //     · 读通道被 risk-control 拒 → 账号可能真被风控 → 静默 2 小时 + guard 审计；
  //     · 只有写通道被拒 → 只冷却写 10 分钟，**不停 tick、不静默整层**（还能看、还能说话）。
  try {
    const riskRows = outcome.executed.filter((x) => x.ok !== true && String(x.reason ?? '') === 'risk-control')
    const readRisk = riskRows.filter((x) => !WRITE_TOOLS.has(x.tool))
    const writeRisk = riskRows.filter((x) => WRITE_TOOLS.has(x.tool))
    if (readRisk.length > 0) {
      silenceFor(2 * 3600_000, 'risk-control')
      appendAudit({ tool: 'guard', args: { level: 'full', source: 'read', tools: readRisk.map((x) => x.tool) }, why: '读通道被 risk-control 拒：按账号风控处理，静默 2 小时', result: { ok: false, reason: 'risk-control' } })
      patchState({ lastSkip: { at: new Date(now).toISOString(), reason: 'risk-control' } })
    } else if (writeRisk.length > 0) {
      const until = new Date(now + WRITE_COOLDOWN_MS).toISOString()
      try { patchState({ writeCooldownUntil: until, lastSkip: { at: new Date(now).toISOString(), reason: 'write-risk' } }) } catch { /* 写不进去 → 下一轮再判 */ }
      appendAudit({ tool: 'guard', args: { level: 'write-only', until, tools: writeRisk.map((x) => x.tool) }, why: '写通道被 risk-control 拒：只冷却写 10 分钟，本轮继续', result: { ok: false, reason: 'risk-control' } })
    }
  } catch { /* 分级失败不影响这一轮 */ }

  // ④ 记：情绪、台词、日记、记忆。
  //    这里有一条硬规矩：**每一轮都要留下痕迹**（日记一行 + memory 一条 + lastLine 非空）。
  //    "醒了没做事"是常态，不是不存在 —— 见 fallbackLine 的注释。
  const outsideWindow = inWindow(loadSchedule(), now) !== true
  const line = clip(thought.say, 60)
  const effectiveLine = line !== ''
    ? line
    : fallbackLine({ outsideWindow, energy: metricsNow.energy, boredom: metricsNow.boredom, mood: metricsNow.mood })
  // 日记优先用决策里那段；没有就用"这一轮的那句话"
  const diaryText = clip(thought.diary, 1200) !== '' ? clip(thought.diary, 1200) : effectiveLine
  // 睡前汇报要用"**上一轮**她真正说的那句话"：这里必须在下面 patchState 覆盖 lastLine **之前**读，
  // 否则拿到的是本轮兜底句（那就成了"每天睡前都在说同一句兜底话"）。
  const previousLine = String(readState().lastLine ?? '').trim()
  patchState({
    mood: thought.mood ?? readState().mood ?? '平静',
    lastLine: effectiveLine,
    lastWakeAt: new Date(now).toISOString(),
    lastTrigger: trigger,
    lastExecuted: outcome.executed.map((x) => ({ tool: x.tool, ok: x.ok, reason: x.reason ?? null })).slice(0, 10),
    lastSkipped: outcome.skipped.slice(0, 20),
  })

  // 日记：**无条件**写一行（有决策日记就用它，否则用这一轮的那句话）
  try { appendDiary(diaryText) } catch { /* 日记写不进去不影响这一轮 */ }
  if (line !== '' && line !== diaryText) {
    try { appendDiary('说：' + line) } catch { /* 同上 */ }
  }
  // 记忆：无条件落一条 thought —— "她今天醒过几次、说了什么"从此可追溯
  try { appendMemory({ kind: 'thought', text: clip(diaryText, 200), ref: trigger }) } catch { /* 同上 */ }
  for (const item of Array.isArray(thought.memory) ? thought.memory : []) {
    try { appendMemory({ kind: 'thought', text: item, ref: trigger }) } catch { /* 同上 */ }
  }
  if (outcome.executed.some((x) => x.ok === true)) {
    try { appendMemory({ kind: 'event', text: `这轮做了：${outcome.executed.filter((x) => x.ok).map((x) => x.tool).join('、')}`, ref: trigger }) } catch { /* 同上 */ }
  }

  // ④b 用到的梗记一次 seen（写盘失败不影响这一轮）
  if (typeof thought.meme === 'string' && thought.meme !== '') {
    try { bumpSeen(thought.meme) } catch { /* 梗库写不进去就算了 */ }
  }

  // ⑤ 形象插件（可选依赖）：拿不到就只写日记，不报错
  const avatar = avatarOf(deps?.ctx)
  if (line !== '' && avatar !== null && typeof avatar.say === 'function') {
    try { avatar.say({ text: line, emotion: moodToEmotion(thought.mood) }) } catch { /* 形象层坏了不该影响这里 */ }
  }

  markSuccess()
  const nextWake = nextWakeAt(Date.now(), loadSchedule())
  patchState({ nextWakeAt: nextWake })
  // ③c 汇报（§20.2 / §21.1）：两者互斥，睡前优先 —— 一晚不要两条。
  let bedtimeSent = false
  try {
    const bedtime = await maybeBedtimeReport({ deps, now, nextWake, say: thought.say, previousLine })
    bedtimeSent = bedtime !== null && bedtime.ok === true
  } catch { /* 睡前汇报失败绝不影响这一轮 */ }
  try {
    await maybeWakeReport({
      deps,
      now,
      allowed: effectiveAllows(loadSchedule().allows, readMetrics()).dm === true,
      before: countsBefore,
      whenBedtimeReported: bedtimeSent,
      say: thought.say,
    })
  } catch { /* 醒来汇报失败绝不影响这一轮 */ }
  appendAudit({
    tool: 'wake',
    args: {
      trigger,
      // 把这次醒来带来的精力变化写进审计：事后能回答"她那天为什么越来越没劲"
      energy: wakeMetric === null ? null : `${wakeMetric.before.energy}→${wakeMetric.after.energy}`,
      mood: wakeMetric === null ? null : `${wakeMetric.before.mood}→${wakeMetric.after.mood}`,
      // 玩了哪个梗：事后能回看"她最近在玩什么"（§14.4 第 4 条）
      meme: typeof thought.meme === 'string' && thought.meme !== '' ? thought.meme : null,
      // 这轮她说了什么（空就是空，字段保留 —— 事后要能分辨"没说话"与"没记"）
      say: line,
    },
    why: 'tick 完成',
    result: { ok: true, reason: null },
  })
  return { ok: true, mood: thought.mood, say: line, executed: outcome.executed, skipped: outcome.skipped }
}

async function runTool (deps, name, args) {
  const bag = deps?.tools
  let tool = null
  if (Array.isArray(bag)) tool = bag.find((t) => t?.name === name) ?? null
  else if (bag && typeof bag.get === 'function') tool = bag.get(name) ?? null
  else if (bag && typeof bag === 'object') tool = bag[name] ?? null
  if (tool === null || typeof tool.execute !== 'function') return null
  try {
    return await tool.execute(args ?? {}, {})
  } catch (error) {
    return { ok: false, reason: 'threw', human: clip(error?.message ?? error, 120) }
  }
}

/**
 * 跑一次（手动 / 定时 / 事件都走这里）：单飞锁 + 总超时 + 失败退避。
 * @param {'timer'|'reply'|'dm'|'manual'} trigger
 */
export async function runOnce (trigger = 'manual', deps = runtime?.deps) {
  if (!tryLock()) return { ok: false, reason: 'busy', executed: [], skipped: [] }
  try {
    const result = await withTimeout(tick(trigger, deps ?? {}), TICK_TIMEOUT_MS)
    if (result === null || typeof result !== 'object') return { ok: false, reason: 'no-result', executed: [], skipped: [] }
    if (result.ok !== true && result.reason !== 'disabled' && result.reason !== 'outside-window' && result.reason !== 'busy' && result.reason !== 'silenced') {
      markFailure()
    }
    return result
  } catch (error) {
    markFailure()
    return { ok: false, reason: 'tick-failed: ' + clip(error?.message ?? error, 80), executed: [], skipped: [] }
  } finally {
    unlock()
  }
}

/**
 * 启动自主层。**绝不抛**：任何失败只记日志并返回 { started:false }。
 * @param {object} ctx scoped 上下文（注入过 tools）
 * @param {object} deps { tools, log, llm, ctx }
 * @param {{logger?: Function, llm?: object, tools?: any}} [options]
 */
export function start (ctx, deps = {}, options = {}) {
  try {
    if (runtime !== null) stop()
    const log = typeof options.logger === 'function' ? options.logger : (typeof deps.log === 'function' ? deps.log : () => {})
    const llm = options.llm ?? deps.llm ?? null
    if (llm === null || llm === undefined) {
      log('自主层未启动（不影响工具）：宿主没有提供 llm')
      return { started: false, reason: 'llm-unavailable' }
    }
    const merged = { ...deps, llm, ctx: deps.ctx ?? ctx, tools: options.tools ?? deps.tools ?? ctx?.tools }
    const cleanups = []
    runtime = { deps: merged, cleanups, stopped: false }

    // 计划器：每分钟看一眼"该不该醒"（抖动/窗口都在 schedule 里算，这里只负责到点敲一下）。
    //
    // 2026-11-01 真机 bug：nextAt 只在启动时算一次 → 用户把间隔从 60 改到 5，
    //   最长还要等旧的 60 分钟才生效（现场：20:14 改设置，20:19 什么都没发生）。
    //   现在每次 tick 都按**当前** schedule 重算一次，但**只在作息指纹变化时才采纳** —— 见 schedulePrint。
    let nextAt = nextWakeAt(Date.now(), loadSchedule())
    let print = schedulePrint(loadSchedule())
    every(ctx, PLANNER_MS, () => {
      if (runtime === null || runtime.stopped) return
      const now = Date.now()
      const current = loadSchedule()
      const freshPrint = schedulePrint(current)
      const fresh = nextWakeAt(now, current)

      if (freshPrint !== print) {
        // 用户改了作息（窗口/间隔/周末/开关）：立刻采纳，缩短与延长都马上生效
        print = freshPrint
        nextAt = fresh
        try { patchState({ nextWakeAt: nextAt }) } catch { /* 状态写不进去不影响排程 */ }
      } else if (nextAt === null && fresh !== null) {
        nextAt = fresh // 极端：缓存是 null 但现在已经算得出时间（例如 enabled 刚被外部改回）
      }

      if (nextAt === null) return
      if (now < nextAt) return
      // 到点：先重算下一次，再醒来（避免醒来期间计划器又排一遍）
      nextAt = nextWakeAt(now, current)
      print = freshPrint
      try { patchState({ nextWakeAt: nextAt }) } catch { /* 同上 */ }
      void runOnce('timer')
    }, cleanups)

    // 事件插队：每 5 分钟查一次私信（只有内核提供只读工具时才查，绝不自己拼请求）
    let lastSeen = String(readState().lastDmFingerprint ?? '')
    every(ctx, EVENT_POLL_MS, () => {
      if (runtime === null || runtime.stopped) return
      if (loadSchedule().enabled !== true) return
      void (async () => {
        const out = await runTool(merged, 'bili_dm_inbox', { limit: 3 })
        if (out === null || out.ok !== true) return
        const items = Array.isArray(out.data?.messages) ? out.data.messages : (Array.isArray(out.data?.items) ? out.data.items : [])
        const latest = items[0] ?? items.at(-1) ?? null
        if (latest === null) return
        const fp = String(latest.seq ?? '') + '|' + clip(latest.text ?? latest.content ?? '', 40)
        if (fp === lastSeen) return
        lastSeen = fp
        patchState({ lastDmFingerprint: fp })
        if (latest.from === 'owner' || latest.senderUid === undefined) void runOnce('dm')
      })().catch(() => { /* 轮询失败不影响主循环 */ })
    }, cleanups)

    patchState({ lastStartAt: new Date().toISOString(), nextWakeAt: nextAt })
    log(`自主层已启动：窗口 ${loadSchedule().window.start}–${loadSchedule().window.end}，间隔 ${loadSchedule().intervalMin} 分钟`)
    return { started: true }
  } catch (error) {
    try {
      const logger = typeof options.logger === 'function' ? options.logger : () => {}
      logger('自主层未启动（不影响工具）：' + String(error?.message ?? error))
    } catch { /* 连日志都坏了，那就安静 */ }
    runtime = null
    return { started: false, reason: 'start-failed' }
  }
}

/** 停掉全部定时器（幂等）。 */
export function stop () {
  try {
    if (runtime !== null) {
      for (const cleanup of runtime.cleanups.splice(0)) {
        try { cleanup() } catch { /* 单个清理失败不影响其它 */ }
      }
      runtime.stopped = true
    }
  } catch { /* 清理失败不该抛 */ }
  runtime = null
  unlock()
  return true
}

/** 给设置页用的一屏现状（只读）。 */
export function snapshot () {
  const state = readState()
  const schedule = loadSchedule()
  return {
    enabled: schedule.enabled,
    running: runtime !== null && runtime.stopped === false,
    allows: schedule.allows,
    window: schedule.window,
    intervalMin: schedule.intervalMin,
    jitter: schedule.jitter,
    caps: schedule.caps,
    counts: countsToday(),
    mood: state.mood ?? '',
    lastLine: state.lastLine ?? '',
    lastWakeAt: state.lastWakeAt ?? null,
    nextWakeAt: state.nextWakeAt ?? null,
    lastSkip: state.lastSkip ?? null,
    metrics: readMetrics(),
    behavior: behaviorHints(readMetrics()),
    personaChars: readPersona().length,
    memoryCount: recentMemory(200).length,
    diaryToday: todayDiary(5),
    silenceUntil: Number(state.silenceUntil ?? 0) > Date.now() ? Number(state.silenceUntil) : 0,
  }
}

/** 手动解除静默（设置页"现在醒一次"之前用）。 */
export function wakeNow () {
  clearSilence()
  return runOnce('manual')
}
