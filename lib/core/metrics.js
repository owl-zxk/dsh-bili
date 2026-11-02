// 指标：六项会随经历变化的数字（AUTONOMY-PROMPT §14 的机器实现）。
//
// 为什么这些数字是**确定性规则算出来的**，而不是让模型自己说：
//   人设里写的是"她会累、会被腻到、被主人回了会开心"。如果让模型自由发挥，
//   同一段经历两次跑出两个情绪，行为就不可复现，也没法和人设文件对齐；
//   更糟的是"心情好就多说话"这种规则会变成模型的一次幻觉。
//   所以：**规则算数字，模型只负责在台词里体现**（它不许改这些值）。
//
// 为什么落在 state.json 而不是独立文件：
//   它和"今天发了几条""上次醒来几点"是同一类状态 —— 进程重启就该记得。
//   同一次 patchState 里一起写，少一次磁盘往返，也少一个可能写坏的文件。
//
// 为什么每个事件都记 changes（而不是记全文）：metricsHistory 只保留最近 50 条，
//   用途是"最近为什么变成这样"，所以差量就够；存全文会让它膨胀成第二份 state。
import { readState, patchState } from './state.js'
import { inWindow, loadSchedule, silenceFor } from './schedule.js'

/** 六项指标（顺序即展示顺序）。 */
export const METRIC_KEYS = ['energy', 'mood', 'curiosity', 'affinity', 'boredom', 'confidence']

/** 默认值（§14.1）：一个"刚起床、不冷不热"的人。 */
export const METRIC_DEFAULTS = { energy: 60, mood: 55, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 }

/** 最近变化的保留条数（§14.1）。 */
export const HISTORY_MAX = 50

/**
 * 「好奇」低到不想探索的阈值（persona.md 第六节：「好奇 < 25 → 只看热门，不搜索、不点开长视频」）。
 * 为什么写在这里而不是散在 actions 里：阈值是**人设的一部分**，将来主人改 persona 时
 *   这个数字也该跟着改一处 —— 所以留一个具名常量，别让 25 变成第二个魔法数字。
 */
export const CURIOSITY_EXPLORE_MIN = 25

const LABEL = { energy: '精力', mood: '心情', curiosity: '好奇', affinity: '亲近', boredom: '倦怠', confidence: '自信' }

/**
 * 事件表（§14.2）。day-pass 也在表里，但实际入口是 decayTo() —— 它要先判断"是不是真的跨天了"。
 */
const EVENTS = {
  // 精力的消耗表（2026-11-01 §19 重平衡：降低单次消耗 + 按小时恢复，见 regenEnergy）
  //   · 醒来 -2（不动手也要付一点，"存在"本身有成本）
  //   · 看不算消耗（读动作 0）—— 看视频是她的基本生活方式，不该越看越累
  //   · 写 -3（真正动嘴才累）
  'wake': { energy: -2 },
  'read-action': {},
  'write-action': { energy: -3 },
  'action-ok': { confidence: 1 },
  'action-fail': { confidence: -3 },
  'risk': { mood: -8, confidence: -5, energy: -5 },
  'interest-hit': { mood: 3, curiosity: 2 },
  'repeat': { boredom: 4, curiosity: -2 },
  'dm-sent': { affinity: 5 },
  'owner-reply': { affinity: 10 },
  'day-pass': { energy: 15, boredom: -5 },
}

const clamp = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

/** 把任意输入规整成六项 0–100 整数（缺/坏一律回默认，永不抛）。 */
export function normalizeMetrics (input) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const out = {}
  for (const key of METRIC_KEYS) {
    const n = Number(raw[key])
    out[key] = Number.isFinite(n) ? clamp(n) : METRIC_DEFAULTS[key]
  }
  return out
}

/** 当前六项指标。 */
export function readMetrics () {
  try {
    return normalizeMetrics(readState().metrics)
  } catch {
    return { ...METRIC_DEFAULTS }
  }
}

const dayKey = (now = Date.now()) => new Date(now).toLocaleDateString('sv-SE')

function pushHistory (state, entry) {
  const list = Array.isArray(state.metricsHistory) ? state.metricsHistory : []
  return [...list, entry].slice(-HISTORY_MAX)
}

/** 把一组新的指标写盘（连同一条变化记录）。 */
function commit (before, after, event, changes, extra = {}) {
  const state = readState()
  const entry = { at: new Date().toISOString(), event, changes }
  patchState({
    ...extra,
    metrics: after,
    metricsHistory: pushHistory(state, entry),
  })
  return { before, after, changes }
}

/**
 * 应用一个事件。
 * @param {string} kind 见 EVENTS 表
 * @param {object} [payload] 目前只用于诊断（存在 history 之外的字段不影响指标）
 * @param {{now?: number}} [opts]
 * @returns {{before: object, after: object, changes: Array<{key: string, delta: number}>}}
 */
export function applyEvent (kind, payload = {}, opts = {}) {
  const before = readMetrics()
  const table = EVENTS[String(kind ?? '')]
  if (table === undefined) return { before, after: before, changes: [] }

  const after = { ...before }
  const changes = []
  for (const [key, delta] of Object.entries(table)) {
    const next = clamp(after[key] + delta)
    if (next !== after[key]) changes.push({ key, delta: next - after[key] })
    after[key] = next
  }
  const result = commit(before, after, String(kind), changes)

  // risk 是唯一带**行为后果**的事件：撞风控就当场静默（§14.2 表里的"并当场静默"）。
  // 放在这里而不是让每个调用方各记一次，是为了"指标变了 ⇒ 行为也跟着变"只有一处真相。
  if (kind === 'risk') {
    try { silenceFor(2 * 3600_000, '风控命中（risk-control）') } catch { /* 静默写不进去不影响指标 */ }
  }
  void payload
  void opts
  return result
}

/** 一小时（毫秒）。 */
const HOUR_MS = 3600 * 1000
/** 窗口内每小时恢复多少精力（§19.2）。 */
const REGEN_IN_WINDOW = 3
/** 窗口外（睡觉）每小时恢复多少（§19.2：睡着恢复得更快）。 */
const REGEN_OUT_WINDOW = 6

/**
 * 按**整小时**恢复精力（§19.2）。
 *
 * 为什么按 lastWakeAt 而不是"每次调用加一点"：醒来是稀疏事件，中间可能隔 3 小时；
 *   如果只在 tick 里按次加，那"她休息了三小时"和"她刚醒过"就没有区别。
 *
 * 幂等：把"已经结算到哪个时刻"记在 state.lastRegenAt（base = max(lastWakeAt, lastRegenAt)），
 *   同一 now 连续调用两次，第二次的整小时差为 0 → added = 0，不会叠加。
 * 不足一小时不结算（40 分钟 → 0），余数留在 lastRegenAt 里，下次接着攒。
 *
 * @returns {{energy: number, added: number}}
 */
export function regenEnergy (now = Date.now()) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const state = readState()
  const metrics = normalizeMetrics(state.metrics)
  const lastWake = Date.parse(String(state.lastWakeAt ?? ''))
  if (!Number.isFinite(lastWake)) return { energy: metrics.energy, added: 0 }
  const lastRegen = Date.parse(String(state.lastRegenAt ?? ''))
  const base = Number.isFinite(lastRegen) && lastRegen > lastWake ? lastRegen : lastWake
  const hours = Math.floor((at - base) / HOUR_MS)
  if (hours <= 0) return { energy: metrics.energy, added: 0 }
  // 速率**按小时逐段算**（2026-11-01 修正）：以前整段用"now 那一刻"的速率，于是
  //   「昨晚 09:00 醒 → 18:00 再醒」这 9 小时（全程窗口外、她在睡）会被按白天速率 +3/h 算，
  //   只回一半精力 —— 她每晚都带着没恢复完的血条开工。现在每一小时的起点各判一次在不在窗口内。
  //
  // 窗口算不出来（schedule 坏了 / 函数缺失）时**回落到单一速率**（保守按窗口内 +3/h），
  // 绝不因为窗口判不了就整段不恢复 —— 那会让她的精力永久卡住。
  let gained = 0
  let scheduleRef = null
  try { scheduleRef = loadSchedule() } catch { scheduleRef = null }
  for (let i = 0; i < hours; i += 1) {
    const hourStart = base + i * HOUR_MS
    let rate = REGEN_IN_WINDOW
    if (scheduleRef !== null) {
      try { rate = inWindow(scheduleRef, hourStart) ? REGEN_IN_WINDOW : REGEN_OUT_WINDOW } catch { rate = REGEN_IN_WINDOW }
    }
    gained += rate
  }
  const next = clamp(metrics.energy + gained)
  const added = next - metrics.energy
  try {
    patchState({
      metrics: { ...metrics, energy: next },
      // 只结算整小时，余数留给下一次（这样 40 分钟 + 20 分钟 = 一次恢复，不会白丢）
      lastRegenAt: new Date(base + hours * HOUR_MS).toISOString(),
    })
  } catch { /* 落盘失败 → 下次还会再算，不丢 */ }
  return { energy: next, added }
}

/**
 * 跨天恢复（§14.2 的 day-pass）：energy +15（封顶 100）、boredom −5、mood 向 50 靠 1。
 *
 * 为什么 mood 是"靠近 50"而不是固定值：心情没有"睡一觉就满血"这回事，
 *   只有慢慢回到中性；所以 >50 减 1、<50 加 1、=50 不动。
 * 为什么用 metricsDay 而不是"上次醒来时间"：一天可能醒很多次，只有跨天那一次该恢复。
 *
 * @returns {{before, after, changes}} 没跨天时 changes 为空数组
 */
export function decayTo (now = Date.now()) {
  const before = readMetrics()
  const day = dayKey(now)
  const state = readState()
  const last = typeof state.metricsDay === 'string' ? state.metricsDay : ''

  // 第一次运行（没有 baseline）：只记下今天是哪天，不假装"跨了一天"
  if (last === '') {
    patchState({ metrics: before, metricsDay: day })
    return { before, after: before, changes: [] }
  }
  if (last === day) return { before, after: before, changes: [] }

  const after = { ...before }
  const changes = []
  const bump = (key, delta) => {
    const next = clamp(after[key] + delta)
    if (next !== after[key]) changes.push({ key, delta: next - after[key] })
    after[key] = next
  }
  bump('energy', 15)
  bump('boredom', -5)
  if (after.mood > 50) bump('mood', -1)
  else if (after.mood < 50) bump('mood', 1)

  const result = commit(before, after, 'day-pass', changes, { metricsDay: day })
  return result
}

/** 一行中文（给 brain 上下文与设置页）。 */
export function describe (metrics) {
  const m = normalizeMetrics(metrics ?? readMetrics())
  return METRIC_KEYS.map((key) => `${LABEL[key]} ${m[key]}`).join(' · ')
}

/** 最近 n 条变化（新的在后）。 */
export function recentChanges (n = 3) {
  const list = readState().metricsHistory
  if (!Array.isArray(list)) return []
  return list.slice(-Math.max(1, Math.round(Number(n) || 3)))
}

/**
 * 指标**收紧**后的 allows（不改原对象）。只收紧、不放开 —— 数字只能让她更保守。
 * @param {object} allows schedule.allows
 * @param {object} [metrics]
 */
export function effectiveAllows (allows, metrics) {
  const base = allows !== null && typeof allows === 'object' ? allows : {}
  const out = { ...base }
  const m = normalizeMetrics(metrics)
  const writes = ['comment', 'reply', 'dynamic', 'like', 'follow', 'dm']

  // 精疲力尽分两档（2026-11-01 裁决）：
  //   < 10 → 真的什么都不做了（连私信都不发）——人设里"累到不能说话"的那个极端
  //   < 20 → 只关公开通道，**保留私信**：私信是私密低耗通道，也是唯一维持关系的通道，
  //          累到不行也该能给主人留一句"我先睡了"
  if (m.energy < 10) {
    // 连只读也关：这一档的语义是"只剩下活着"，与 schedule.enabled=false 同义
    for (const key of ['read', ...writes]) out[key] = false
    return out
  }
  if (m.energy < 20) {
    for (const key of ['comment', 'reply', 'dynamic', 'like', 'follow']) out[key] = false
  }
  // 没底气：不公开发言（评论/回复/动态），但点赞关注这种"轻动作"还在
  if (m.confidence < 30) {
    out.comment = false
    out.reply = false
    out.dynamic = false
  }
  // 更没底气：连点赞关注也关（只剩只读与私信）
  if (m.confidence < 15) {
    out.like = false
    out.follow = false
  }
  return out
}

/** 每次醒来最多几条写（默认 K=2；精疲力尽时 0）。 */
export const DEFAULT_MAX_WRITES = 2

/**
 * 行为提示：给 actions.js 当闸、给 brain.js 当语气。
 * @returns {{maxWrites:number, preferDynamic:boolean, dmFactor:number, sayShort:boolean, noSpeak:boolean}}
 */
export function behaviorHints (metrics) {
  const m = normalizeMetrics(metrics)
  return {
    maxWrites: m.energy < 20 ? 0 : DEFAULT_MAX_WRITES,
    preferDynamic: m.boredom > 70,
    dmFactor: m.affinity < 40 ? 0.5 : 1,
    sayShort: m.mood < 30,
    noSpeak: m.affinity < 20,
    // 好奇过低 → 不想探索：只刷热门，不搜索、不点开（persona §6；阈值见 CURIOSITY_EXPLORE_MIN）
    noExplore: m.curiosity < CURIOSITY_EXPLORE_MIN,
  }
}

/**
 * 「每日上限」的生效值（§17.1 / §17.2 第 3 条）。
 *
 * @param {number|null|undefined} cap schedule.caps[channel]
 * @param {string} channel
 * @param {{dmFactor?: number}} [hints] behaviorHints() 的结果
 * @returns {number|null} null = 不限（调用方据此**不拦**）
 *
 * 关键点：**null 不参与折算** —— 无限大乘 0.5 仍然是无限大。
 *   dmFactor 只在"确实设了私信上限"时才把上限压一半；没设上限就没什么可压的。
 */
export function effectiveCap (cap, channel, hints) {
  if (cap === null || cap === undefined) return null
  const n = Number(cap)
  if (!Number.isFinite(n)) return null
  if (channel !== 'dm') return n
  const factor = Number(hints?.dmFactor)
  const safe = Number.isFinite(factor) && factor > 0 ? factor : 1
  return Math.floor(n * safe)
}

/** 把提示翻成两三句人话（给 brain 的上下文；只在有话说时给）。 */
export function hintsText (hints) {
  const h = hints ?? behaviorHints()
  const lines = []
  if (h.maxWrites === 0) lines.push('今天很累，动作就别做了，安静待着。')
  if (h.preferDynamic) lines.push('今天有点腻，可以换个口味（比如发条动态，而不是一直刷）。')
  if (h.noSpeak) lines.push('和主人有点生疏，别主动开口，等主人先说话。')
  if (h.sayShort) lines.push('今天心情不高，话短一点（≤30 字）。')
  if (h.noExplore) lines.push('今天不太想探索，热门刷两眼就行。')
  if (h.dmFactor < 1) lines.push('私信额度今天减半，挑最想说的一句。')
  return lines.join('\n')
}

/**
 * 测试用复位：指标回默认、历史清空、日期基线清掉。
 * 与 quota/metrics 别处的 resetForTest 不同，这里**确实有状态要清**（state.json 里那几项）。
 */
export function resetForTest (now = Date.now()) {
  patchState({ metrics: { ...METRIC_DEFAULTS }, metricsHistory: [], metricsDay: dayKey(now) })
  return { ...METRIC_DEFAULTS }
}
