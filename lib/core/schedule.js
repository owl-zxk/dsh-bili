// 日程与节流：什么时候醒、醒了能不能动、今天已经动了多少次、失败要不要静默。
//
// 为什么这些状态在**文件**里而不是内存里：
//   插件会被宿主热重载（改一次代码就 reload），内存里的"今天发过 3 条"会清零 →
//   一天之内可能连发十几条。所以计数、连续失败、静默截止时间都落 state.json。
//
// 为什么单飞锁在**内存**里：
//   锁的语义是"此刻有没有一个 tick 正在跑"，那只可能是同一进程里的事；
//   跨进程的互斥由内核的 traffic 守卫与 token 预算做（见 core/tokenbudget.js 的注释）。
//
// 窗口外的 nextWakeAt 返回什么（2026-11-01 定，实现见 nextWakeAt/nextWindowStart）：
//   **返回下一个窗口开始的时刻**，让定时器直接睡到点；只有 enabled=false 才返回 null。
//   当初的顾虑仍然成立、也值得记下来：曾经考虑过返回 null（"现在睡了就不必排下一次"），
//   因为一个未来的时刻意味着定时器会在那一刻醒来，而醒来要读状态、可能触发 LLM。
//   改成一具体时刻，是因为 null 会逼调用方自己每分钟再问一次"到点了吗"——
//   那等于把窗口逻辑复制一份到 autonomy 里，而且那一整夜的每分钟都真的会醒一次。
//   两边都要付代价，选"睡到点再醒"：一次确定的醒来，胜过一千次空转。
import fs from 'node:fs'
import path from 'node:path'

import { selfDir, readState, patchState, writeTextAtomic } from './state.js'

/** 默认档位（AUTONOMY-PROMPT §11，用户已定 2026-11-01）：只读 + 私信主人。 */
export const DEFAULTS = {
  enabled: true,
  allows: { read: true, dm: true, comment: false, reply: false, dynamic: false, like: false, follow: false },
  // 一天可以有多个清醒时段（§16.1，2026-11-01）。window 保留给旧代码：它恒等于 windows[0]。
  windows: [{ start: '20:00', end: '24:00' }],
  window: { start: '20:00', end: '24:00' },
  weekendAllDay: false,
  weekendIntervalMin: 90,
  intervalMin: 45,
  jitter: 0.2,
  // 每日上限（2026-11-01 用户要求，见 §17）：**null = 不限**，数字 = 上限，0 = 禁止。
  // 只有"发动态"保留每天 2 条 —— 那是唯一会出现在首页时间线上的动作。
  // 注意 null 与 0 必须能区分：0 是"禁止"，null 是"随便发"（别用 0 当哨兵）。
  caps: { dm: null, comment: null, reply: null, dynamic: 2, like: null, follow: null },
  // 每次醒来至少看一个视频（§18，默认开）。关掉就纯靠她自觉。
  minWatchPerWake: true,
  // 评论时自动 @主人（§20.1，默认开）：模型没显式给 atOwner 时补 true
  atOwnerOnComment: true,
  // 睡前汇报（§20.2，默认开）：本窗口最后一次醒来时给主人发一条私信
  bedtimeReport: true,
  // 每次醒来发一条短私信（§21.1，**默认关**：那会很吵，得用户自己开）
  dmEveryWake: false,
  // 看完视频必须补一条评论（§22，默认开）。关掉就退回"真有话说才发"。
  commentAfterWatch: true,
  // 主人私信来时兜底回一条（§23.1，默认开）
  replyToDm: true,
  // 有人回复她的评论时回一句（§23.2，默认开）
  replyToComments: true,
  // 有人 @ 她时回一句（§24.2，默认开）
  replyToMentions: true,
  // 走哪个模型（2026-11-01 加）：空 = 用宿主默认路由。
  // 为什么可配：宿主默认路由通常是"当前会话的模型"，而她是后台跑的 —— 主人往往想给她指定
  // 一个便宜/快的模型。留空就交给宿主，不猜、不硬编码。
  llmProvider: '',
  llmModel: '',
}

const CHANNELS = ['dm', 'comment', 'reply', 'dynamic', 'like', 'follow']
// 'read' 不是写通道，**只**用来给"今天看了多少视频"计数（§18：兜底动作也要进今日计数）。
// 它不进 CHANNELS —— 因为 CHANNELS 同时决定 allows / caps 的形状，
// 把 read 混进去会让 caps 多出一个没人会设的键（设置页与测试都会看到它）。
const COUNT_CHANNELS = [...CHANNELS, 'read']
const ALLOW_KEYS = ['read', 'dm', 'comment', 'reply', 'dynamic', 'like', 'follow']

export function schedulePath () {
  return path.join(selfDir(), 'schedule.json')
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 时间注入（**只给测试用**）：本模块的窗口/抖动/退避都要能在离线跑。
 * 三种写法都认：不传（= 现在）、传毫秒数、传 `{ now: 毫秒 }`。
 * 生产路径永远不传 —— 于是行为与之前一字不差。
 */
function resolveNow (value) {
  if (value !== null && typeof value === 'object') {
    const n = Number(value.now)
    if (Number.isFinite(n)) return n
  }
  const direct = Number(value)
  return Number.isFinite(direct) && direct > 0 ? direct : Date.now()
}

/** "20:00" → 分钟数；非法返回 null。"24:00" 合法（=1440，表示当天结束）。 */
export function parseClock (text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (m === null) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null
  if (h < 0 || h > 24 || min < 0 || min > 59) return null
  if (h === 24 && min !== 0) return null
  return h * 60 + min
}

const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(isPlain(over) ? over : {})) {
    out[k] = isPlain(v) ? merge(isPlain(base?.[k]) ? base[k] : {}, v) : v
  }
  return out
}

/**
 * 读日程：默认值 ← 文件（缺字段/坏文件都回落默认）。
 * @param {object} [_config] 契约占位（日程不来自内核配置，避免两处真值的分叉）
 */
export function loadSchedule (_config, _options = {}) {
  let file = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(schedulePath(), 'utf8').replace(/^\uFEFF/, ''))
    if (isPlain(parsed)) file = parsed
  } catch { /* 没文件/坏文件 → 纯默认 */ }
  const merged = merge(DEFAULTS, file)
  // 时段的来源要**看文件本身**，不能看合并结果：DEFAULTS 里现在也有 windows，
  // 合并之后 merged.windows 永远非空，于是"旧文件只写了 window"就会被默认值盖掉。
  // 优先级：文件里的 windows > 文件里的 window > 默认。
  const fileWindows = Array.isArray(file.windows) && file.windows.length > 0
    ? file.windows
    : (isPlain(file.window) ? [file.window] : DEFAULTS.windows)
  const windows = normalizeWindows({ windows: fileWindows })
  return {
    enabled: merged.enabled !== false,
    allows: Object.fromEntries(ALLOW_KEYS.map((k) => [k, merged.allows?.[k] !== false && (DEFAULTS.allows[k] === true || merged.allows?.[k] === true)])),
    windows,
    // window 恒等于 windows[0]：旧读取方（设置页老版本、别的脚本）仍然拿得到
    window: { ...windows[0] },
    weekendAllDay: merged.weekendAllDay === true,
    weekendIntervalMin: clampNum(merged.weekendIntervalMin, merged.intervalMin ?? DEFAULTS.weekendIntervalMin, 5, 720),
    intervalMin: clampNum(merged.intervalMin, DEFAULTS.intervalMin, 5, 720),
    jitter: clampNum(merged.jitter, DEFAULTS.jitter, 0, 0.5),
    // null/缺省 → 保留 null（= 不限）；只有给了数字才 clamp 0–1000
    caps: Object.fromEntries(CHANNELS.map((k) => [k, normalizeCap(merged.caps?.[k], DEFAULTS.caps[k])])),
    minWatchPerWake: merged.minWatchPerWake !== false,
    atOwnerOnComment: merged.atOwnerOnComment !== false,
    bedtimeReport: merged.bedtimeReport !== false,
    dmEveryWake: merged.dmEveryWake === true,
    commentAfterWatch: merged.commentAfterWatch !== false,
    replyToDm: merged.replyToDm !== false,
    replyToComments: merged.replyToComments !== false,
    replyToMentions: merged.replyToMentions !== false,
    llmProvider: clipText(merged.llmProvider, 120),
    llmModel: clipText(merged.llmModel, 120),
  }
}

const clipText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/**
 * 归一化一个上限值（§17.1）：null / undefined / 非数字 → null（不限）；数字 → 0–1000 整数。
 * 为什么不能"缺省就回默认数字"：缺省在新语义里就是"不限"，回一个数字等于偷偷给她上了锁。
 */
function normalizeCap (value, fallback = null) {
  if (value === null) return null                 // 显式 null = 不限（哪怕默认是 2）
  if (value === undefined) return fallback       // 缺省 → 用默认（默认可能本来就是 null）
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback        // 坏值 → 回默认，绝不静默变成"禁止"
  return Math.min(1000, Math.max(0, Math.round(n)))
}

function clampNum (value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 单个时段是否合法（HH:MM，start≠end；end 允许 24:00；start > end 表示跨午夜）。 */
function validWindow (item) {
  if (!isPlain(item)) return null
  const start = String(item.start ?? '').trim()
  const end = String(item.end ?? '').trim()
  const s = parseClock(start)
  const e = parseClock(end)
  if (s === null || e === null) return null
  if (s === e) return null
  return { start, end }
}

/**
 * 归一化 windows。
 * 旧文件只有 `window:{start,end}` → 当作一个时段；什么都没有 → 默认夜行 20:00–24:00。
 * 非法项丢弃；一项都不剩回默认；多于 6 项截断（§16.1 的上限）。
 */
export function normalizeWindows (schedule) {
  const multi = Array.isArray(schedule?.windows) ? schedule.windows : []
  const single = isPlain(schedule?.window) ? schedule.window : null
  // 谁是"真值"取决于信息量：
  //   · windows 里有 >1 个时段 → 只能是它（旧字段只是 windows[0] 的副本）
  //   · 否则若 window 存在 → 用 window。这既覆盖老文件，也覆盖"手工构造对象把 window 改掉"的用法
  //     （设置页老版本、测试、脚本都这么写；两者在正常写盘后本来就相等，所以不丢信息）。
  const raw = multi.length > 1 ? multi : (single !== null ? [single] : multi)
  const list = raw.map(validWindow).filter((item) => item !== null).slice(0, 6)
  if (list.length === 0) list.push({ ...DEFAULTS.windows[0] })
  return list
}

/**
 * 部分更新并原子写回。**字段白名单校验**：不认识的键直接拒绝（写坏一份日程比不写更糟）。
 * @returns {{ok:true, schedule:object} | {ok:false, error:string}}
 */
export function saveSchedule (patch) {
  if (!isPlain(patch)) return { ok: false, error: '日程更新必须是对象' }
  const current = loadSchedule()
  const next = merge(current, {})

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') return { ok: false, error: 'enabled 必须是布尔值' }
    next.enabled = patch.enabled
  }
  if (patch.intervalMin !== undefined) {
    const n = Number(patch.intervalMin)
    if (!Number.isFinite(n) || n < 5 || n > 720) return { ok: false, error: 'intervalMin 必须是 5–720 的数字' }
    next.intervalMin = Math.round(n)
  }
  if (patch.jitter !== undefined) {
    const n = Number(patch.jitter)
    if (!Number.isFinite(n) || n < 0 || n > 0.5) return { ok: false, error: 'jitter 必须是 0–0.5 的数字' }
    next.jitter = n
  }
  if (patch.windows !== undefined) {
    if (!Array.isArray(patch.windows)) return { ok: false, error: 'windows 必须是数组' }
    if (patch.windows.length < 1 || patch.windows.length > 6) return { ok: false, error: 'windows 要有 1–6 个时段（现在 ' + patch.windows.length + ' 个）' }
    const list = []
    for (const item of patch.windows) {
      if (!isPlain(item)) return { ok: false, error: '每个时段必须是 {start,end}' }
      const valid = validWindow(item)
      if (valid === null) {
        return {
          ok: false,
          error: '时段必须形如 {start:"09:00", end:"12:00"}：时间 HH:MM（结束可用 24:00），且起止不能相同（' + JSON.stringify(item) + '）',
        }
      }
      list.push(valid)
    }
    next.windows = list
    next.window = { ...list[0] } // 旧读取方兼容：window 恒等于 windows[0]
  }
  if (patch.window !== undefined) {
    // 老形状仍然接受（设置页老版本/脚本）：等价于只给一个时段
    if (!isPlain(patch.window)) return { ok: false, error: 'window 必须是 {start,end}' }
    const start = patch.window.start === undefined ? next.windows[0].start : String(patch.window.start)
    const end = patch.window.end === undefined ? next.windows[0].end : String(patch.window.end)
    const valid = validWindow({ start, end })
    if (valid === null) return { ok: false, error: 'window 的时间必须形如 "20:00"（结束可用 "24:00"，起止不能相同）' }
    next.windows = [valid]
    next.window = { ...valid }
  }
  for (const key of ['minWatchPerWake', 'atOwnerOnComment', 'bedtimeReport', 'dmEveryWake', 'commentAfterWatch', 'replyToDm', 'replyToComments', 'replyToMentions']) {
    if (patch[key] === undefined) continue
    if (typeof patch[key] !== 'boolean') return { ok: false, error: key + ' 必须是布尔值' }
    next[key] = patch[key]
  }
  if (patch.weekendAllDay !== undefined) {
    if (typeof patch.weekendAllDay !== 'boolean') return { ok: false, error: 'weekendAllDay 必须是布尔值' }
    next.weekendAllDay = patch.weekendAllDay
  }
  if (patch.weekendIntervalMin !== undefined) {
    const n = Number(patch.weekendIntervalMin)
    if (!Number.isFinite(n) || n < 5 || n > 720) return { ok: false, error: 'weekendIntervalMin 必须是 5–720 的数字' }
    next.weekendIntervalMin = Math.round(n)
  }
  for (const key of Object.keys(patch)) {
    if (!['enabled', 'intervalMin', 'jitter', 'window', 'windows', 'weekendAllDay', 'weekendIntervalMin', 'minWatchPerWake', 'atOwnerOnComment', 'bedtimeReport', 'dmEveryWake', 'commentAfterWatch', 'replyToDm', 'replyToComments', 'replyToMentions', 'allows', 'caps', 'llmProvider', 'llmModel'].includes(key)) return { ok: false, error: '不认识的字段：' + key }
  }
  for (const key of ['llmProvider', 'llmModel']) {
    if (patch[key] === undefined) continue
    if (typeof patch[key] !== 'string') return { ok: false, error: key + ' 必须是字符串（留空 = 用宿主默认路由）' }
    if (patch[key].length > 120) return { ok: false, error: key + ' 最多 120 字符' }
    next[key] = patch[key].trim()
  }
  if (patch.allows !== undefined) {
    if (!isPlain(patch.allows)) return { ok: false, error: 'allows 必须是对象' }
    for (const [key, value] of Object.entries(patch.allows)) {
      if (!ALLOW_KEYS.includes(key)) return { ok: false, error: '不认识的允许项：' + key }
      if (typeof value !== 'boolean') return { ok: false, error: 'allows.' + key + ' 必须是布尔值' }
      next.allows[key] = value
    }
  }
  if (patch.caps !== undefined) {
    if (!isPlain(patch.caps)) return { ok: false, error: 'caps 必须是对象' }
    for (const [key, value] of Object.entries(patch.caps)) {
      if (!CHANNELS.includes(key)) return { ok: false, error: '不认识的上限项：' + key }
      if (value === null) {
        next.caps[key] = null // 显式写 null = 取消上限（与"不改"不同）
        continue
      }
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0 || n > 1000) return { ok: false, error: 'caps.' + key + ' 必须是 0–1000 的数字，或 null（不限）' }
      next.caps[key] = Math.round(n)
    }
  }

  try {
    // 写盘时**同时**写 windows 与 window（后者恒等于 windows[0]）：这样旧读取方不会炸（§16.1）
    const payload = { ...next, windows: next.windows, window: { ...next.windows[0] } }
    writeTextAtomic(schedulePath(), JSON.stringify(payload, null, 2) + '\n')
    return { ok: true, schedule: loadSchedule() }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 当前分钟（本地）。 */
function nowMinutes (now = Date.now()) {
  const d = new Date(now)
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
}

/** 本地周六/周日。 */
function isWeekend (now = Date.now()) {
  const day = new Date(now).getDay()
  return day === 0 || day === 6
}

/** 单个时段是否命中（cur 是当天分钟数）。跨午夜 = "今天开始–明天结束"。 */
function hitWindow (item, cur) {
  const start = parseClock(item?.start)
  const end = parseClock(item?.end)
  if (start === null || end === null) return false
  if (start === end) return true                      // 全天（校验上不允许，读旧文件时容忍）
  if (end > start) return cur >= start && cur < end
  return cur >= start || cur < end                    // 跨午夜：今天 start 之后，或今天 end 之前
}

/**
 * 是否在清醒窗口内：**任一时段命中**即为 true；周末全天规则优先。
 * 跨午夜（22:00–02:00）在 01:00 命中、03:00 不命中。
 */
export function inWindow (schedule, now = Date.now()) {
  const s = schedule ?? {}
  if (s.weekendAllDay === true && isWeekend(now)) return true
  const windows = normalizeWindows(s)
  const cur = nowMinutes(now)
  return windows.some((item) => hitWindow(item, cur))
}

/** 这次醒来该用多长的间隔：周末且配了 weekendIntervalMin 就用它。 */
export function intervalMs (schedule, now = Date.now()) {
  const s = schedule ?? {}
  const fallback = Number.isFinite(Number(s.intervalMin)) ? Number(s.intervalMin) : DEFAULTS.intervalMin
  const weekend = s.weekendAllDay === true && isWeekend(now)
  const raw = weekend ? Number(s.weekendIntervalMin) : fallback
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : (Number.isFinite(fallback) && fallback > 0 ? fallback : DEFAULTS.intervalMin)
  return Math.max(1, minutes) * 60_000
}

const INTERVAL_MS = (schedule) => intervalMs(schedule)

/** 当天 00:00 的毫秒数（本地）。 */
function midnightOf (now) {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
}

/**
 * 所有时段里**最近的未来起点**（本地）。当前就在窗口内 → null（调用方按间隔排下一次）。
 * 周末全天开着时，周末的 00:00 也算一个起点（周五窗口外 → 下一个周六 00:00）。
 */
export function nextWindowStart (schedule, now = Date.now()) {
  const s = schedule ?? {}
  if (inWindow(s, now)) return null
  const windows = normalizeWindows(s)
  const midnight = midnightOf(now)
  let best = null
  for (const item of windows) {
    const start = parseClock(item.start)
    if (start === null) continue
    for (const dayOffset of [0, 1, 2]) {
      const candidate = midnight + dayOffset * 24 * 3600_000 + start * 60_000
      if (candidate > now && (best === null || candidate < best)) best = candidate
    }
  }
  if (s.weekendAllDay === true) {
    // 周末 00:00 也是一个"起点"：周六 0 点在未来的话，它可以比工作日的窗口更近
    for (const dayOffset of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const dayStart = midnight + dayOffset * 24 * 3600_000
      if (dayStart <= now) continue
      if (!isWeekend(dayStart)) continue
      if (best === null || dayStart < best) best = dayStart
      break
    }
  }
  return best
}

/**
 * 下一次该醒的时刻。
 *
 * 2026-11-01 改：窗口外不再返回 null，而是返回**下一个窗口开始时刻**。
 *   为什么：返回 null 让调用方只能"每分钟自己再问一次"，等于把窗口逻辑复制到 autonomy 里；
 *   返回具体时刻，定时器就能直接睡到点（也就少了一整夜的空转醒来）。只剩 enabled=false 返回 null。
 *
 * @param {number|{now:number}} [now] 毫秒时间戳或 { now }（测试注入）
 * @returns {number|null} null 只在"总开关关掉"时出现
 */
export function nextWakeAt (now = Date.now(), schedule = loadSchedule()) {
  const at = resolveNow(now)
  const s = schedule ?? loadSchedule()
  if (!s.enabled) return null
  if (!inWindow(s, at)) return nextWindowStart(s, at)
  const base = intervalMs(s, at)
  const jitter = Math.min(0.5, Math.max(0, Number(s.jitter) || 0))
  // 抖动故意留着（±jitter）：整点排队醒来不像人，也不像一台机器在打点
  const factor = 1 + (Math.random() * 2 - 1) * jitter
  return at + Math.round(base * factor)
}

/* ─────────────────────────── 单飞锁（内存） ─────────────────────────── */

let ticking = false

/** 尝试占锁：成功返回 true。重叠的 tick 直接跳过（不排队、不等待）。 */
export function tryLock () {
  if (ticking) return false
  ticking = true
  return true
}

export function unlock () {
  ticking = false
}

export function isLocked () {
  return ticking
}

/* ─────────────────────────── 计数 / 退避 ─────────────────────────── */

const todayKey = (now = Date.now()) => new Date(now).toLocaleDateString('sv-SE')

const emptyCounts = () => Object.fromEntries(COUNT_CHANNELS.map((k) => [k, 0]))

/** 今天各写通道已经做了几次（跨天自动归零）。 */
export function countsToday (now = Date.now()) {
  const state = readState()
  const day = todayKey(now)
  if (String(state.counters?.date ?? '') !== day) return { ...emptyCounts(), date: day }
  const counts = state.counters?.counts ?? {}
  return { ...emptyCounts(), ...Object.fromEntries(COUNT_CHANNELS.map((k) => [k, Math.max(0, Math.round(Number(counts[k]) || 0))])), date: day }
}

/** 记一次（在**动作执行成功之后**调用；失败不占额度）。 */
export function bumpCount (channel) {
  if (!COUNT_CHANNELS.includes(channel)) return countsToday()
  const now = Date.now()
  const counts = countsToday(now)
  counts[channel] = (counts[channel] ?? 0) + 1
  patchState({ counters: { date: counts.date, counts: Object.fromEntries(COUNT_CHANNELS.map((k) => [k, counts[k]])) } })
  return counts
}

/**
 * 现在能不能动作。
 * @returns {{ok:true} | {ok:false, reason:'disabled'|'outside-window'|'backoff'|'busy'|'silenced'}}
 */
export function canRunNow (now = Date.now(), schedule = loadSchedule(), options = {}) {
  const at = resolveNow(now)
  const s = schedule ?? loadSchedule()
  if (!s.enabled) return { ok: false, reason: 'disabled' }
  // 锁的判断对"外面的人问：现在能不能起一次"是对的；但**锁内调用必须关掉它** ——
  // 否则 tick 会把自己刚拿到的锁当成"别人正在跑"，于是每次定时醒来都返回 busy
  // （2026-11-01 真机：8 条审计里一条 timer 都没有，原因就是这个自锁）。
  if (options?.ignoreLock !== true && isLocked()) return { ok: false, reason: 'busy' }
  const state = readState()
  const silenceUntil = Number(state.silenceUntil ?? 0)
  if (Number.isFinite(silenceUntil) && silenceUntil > at) return { ok: false, reason: 'silenced' }
  if (!inWindow(s, at)) return { ok: false, reason: 'outside-window' }
  return { ok: true }
}

/** 一次成功：连续失败计数清零。 */
export function markSuccess () {
  const state = readState()
  if (Number(state.consecutiveFailures ?? 0) !== 0) patchState({ consecutiveFailures: 0 })
}

/**
 * 一次失败：连续 3 次 → 静默 2 小时（§4）。风控命中走 silenceFor，不进这条计数。
 */
export function markFailure (now = Date.now()) {
  const state = readState()
  const failures = Math.max(0, Math.round(Number(state.consecutiveFailures) || 0)) + 1
  if (failures >= 3) {
    patchState({ consecutiveFailures: 0, silenceUntil: now + 2 * 3600_000, silenceWhy: '连续 3 次失败' })
    return { silenced: true, failures }
  }
  patchState({ consecutiveFailures: failures })
  return { silenced: false, failures }
}

/** 主动静默（风控命中 / 预算耗尽）。 */
export function silenceFor (ms, why) {
  const until = Date.now() + Math.max(0, Math.round(Number(ms) || 0))
  patchState({ silenceUntil: until, silenceWhy: String(why ?? '').slice(0, 120) })
  return until
}

/** 解除静默（设置页"现在醒一次"或主人手动干预时用）。 */
export function clearSilence () {
  patchState({ silenceUntil: 0, silenceWhy: '', consecutiveFailures: 0 })
}

export const CHANNEL_KEYS = CHANNELS.slice()
export const ALLOW_KEYS_LIST = ALLOW_KEYS.slice()
