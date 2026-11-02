// 热梗库：一个月换一次的网络梗（AUTONOMY-PROMPT §14.3）。
//
// 为什么要"每月刷新"而不是每次醒来现查：梗是有保质期的，但**每半小时查一次**既慢又烧钱，
//   而且会让她的口径在同一天里来回变。一个月一换，既跟得上，又有个稳定的"这个月她爱说什么"。
//
// 为什么必须有界（40 条）：梗库是要塞进 system 提示的。无界 = 上下文被梗挤爆，
//   而且梗越多她越可能挑一个不合适的。
//
// 为什么来源要如实标注（web_search / llm / stale）：
//   用模型编的梗冒充"网上搜来的"是两回事 —— 前者可能全是我编的、也可能是过期的。
//   标注出来，主人在设置页一眼就能知道"这些梗可信吗"。
//   都拿不到时**保留旧列表**并标 stale，绝不写一份空库（空库等于让她彻底不会玩梗）。
//
// 为什么自己实现一份 llm 收集（而不是复用 brain 的）：memes 与 brain 互相需要
//   （brain 要读梗库、memes 要调模型），复用会形成 import 环。这里只重复 20 行协议代码，
//   换来的是两个模块可以各自被单独导入与测试。
import fs from 'node:fs'
import path from 'node:path'

import { selfDir, readState, patchState, writeTextAtomic } from './state.js'

/** 梗库上限（§14.3）。 */
export const MEMES_MAX = 40
/** 刷新周期：30 天（§14.3）。 */
export const REFRESH_AFTER_MS = 30 * 24 * 3600 * 1000
/** 刷新超时（§14.3：30 秒）。 */
export const REFRESH_TIMEOUT_MS = 30_000

/**
 * 同一个梗的冷却窗：7 天（persona.md 第 43 行 / brain 的 system 规则 B：
 * 「同一梗 7 天内最多用 2 次」）。
 *
 * 为什么这条必须由代码算、不能写进提示让模型自觉：
 *   提示里的"最多两次"是**软约束** —— 模型看不到自己过去 7 天用过几次，
 *   它只能凭这一轮的上下文猜。于是同一条梗会在一天里被反复用（真实感直接崩）。
 *   所以这里把它变成**选择期过滤**：超限的梗根本不会出现在提示的候选列表里。
 */
export const MEME_COOLDOWN_MS = 7 * 24 * 3600 * 1000
/** 冷却窗内允许的使用次数上限（同上）。 */
export const MEME_MAX_USES_IN_WINDOW = 2
/** 每条梗保留最近多少次使用时间戳（只要够算 7 天窗口就行）。 */
export const MEME_USES_KEPT = 10

const clip = (value, max) => String(value ?? '').trim().slice(0, max)
const todayKey = (now = Date.now()) => new Date(now).toLocaleDateString('sv-SE')

export function memesPath () {
  return path.join(selfDir(), 'memes.json')
}

const EMPTY = { updatedAt: '', source: 'unavailable', stage: 'stale', items: [], lastAttemptAt: '', lastMemeError: '' }

/** 读梗库；缺文件/坏 JSON → 空库（永不抛）。 */
export function loadMemes () {
  let parsed = null
  try {
    parsed = JSON.parse(fs.readFileSync(memesPath(), 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return { ...EMPTY, items: [] }
  }
  if (parsed === null || typeof parsed !== 'object') return { ...EMPTY, items: [] }
  const items = Array.isArray(parsed.items) ? parsed.items : []
  return {
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    source: ['web_search', 'llm', 'unavailable'].includes(parsed.source) ? parsed.source : 'unavailable',
    stage: parsed.stage === 'fresh' ? 'fresh' : 'stale',
    items: items
      .filter((item) => item !== null && typeof item === 'object')
      .map((item) => ({
        meme: clip(item.meme, 24),
        meaning: clip(item.meaning, 60),
        example: clip(item.example, 80),
        seen: Math.max(0, Math.round(Number(item.seen) || 0)),
        // uses：使用时间戳（ISO）。**旧文件没有这个字段 → 当空数组**（兼容，不抛）
        uses: Array.isArray(item.uses)
          ? item.uses.map((t) => String(t)).filter((t) => Number.isFinite(Date.parse(t))).slice(-MEME_USES_KEPT)
          : [],
      }))
      .filter((item) => item.meme !== '')
      .slice(0, MEMES_MAX),
    lastAttemptAt: typeof parsed.lastAttemptAt === 'string' ? parsed.lastAttemptAt : '',
    lastMemeError: typeof parsed.lastMemeError === 'string' ? parsed.lastMemeError : '',
  }
}

function saveMemes (next) {
  try {
    writeTextAtomic(memesPath(), JSON.stringify(next, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

/** 该不该刷新：从未刷新，或 updatedAt 距今 ≥ 30 天。 */
export function shouldRefresh (now = Date.now()) {
  const memes = loadMemes()
  if (memes.updatedAt === '') return true
  const at = Date.parse(memes.updatedAt)
  if (!Number.isFinite(at)) return true
  return now - at >= REFRESH_AFTER_MS
}

/** 今天是否已经尝试过（成功或失败都算，§14.3）。 */
export function attemptedToday (now = Date.now()) {
  const at = Date.parse(loadMemes().lastAttemptAt)
  if (!Number.isFinite(at)) return false
  return todayKey(at) === todayKey(now)
}

/* ─────────────────────────── 来源探测 ─────────────────────────── */

const toolFrom = (bag, name) => {
  if (bag === null || bag === undefined) return null
  if (Array.isArray(bag)) return bag.find((t) => t?.name === name) ?? null
  if (typeof bag.get === 'function') {
    try { return bag.get(name) ?? null } catch { return null }
  }
  if (typeof bag === 'object') return bag[name] ?? null
  return null
}

/**
 * 找宿主可执行的那一个工具。
 * 形状都要试一遍：deps.tools（本插件自己的索引）/ ctx.tools.get(name) / ctx.get('tools').get(name)。
 * **探测不到就返回 null**，绝不假装有（§14.3 明确不许伪造 source）。
 */
export function findHostTool ({ tools, ctx } = {}, name) {
  const direct = toolFrom(tools, name)
  if (direct !== null && typeof direct.execute === 'function') return direct
  const candidates = []
  try { if (ctx !== null && ctx !== undefined && typeof ctx.get === 'function') candidates.push(ctx.get('tools')) } catch { /* 忽略 */ }
  try { if (ctx !== null && ctx !== undefined && ctx.tools !== undefined) candidates.push(ctx.tools) } catch { /* 忽略 */ }
  for (const bag of candidates) {
    const tool = toolFrom(bag, name)
    if (tool !== null && typeof tool.execute === 'function') return tool
  }
  return null
}

/* ─────────────────────────── 模型调用（自带流收集） ─────────────────────────── */

const textOf = (chunk) => {
  if (chunk === null || typeof chunk !== 'object') return ''
  const type = chunk.type
  if (type === 'text-delta') return typeof chunk.text === 'string' ? chunk.text : ''
  if (type === 'block-end') return chunk?.block?.type === 'text' && typeof chunk.block.text === 'string' ? chunk.block.text : ''
  return ''
}

/** 调一次模型，把流里的文本拼回来（协议与 brain 一致，见那里的注释）。 */
async function askLlm (llm, { system, user, signal }) {
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') throw Object.assign(new Error('llm 不可用'), { code: 'llm-unavailable' })
  let deltas = ''
  const blocks = []
  for await (const chunk of llm.stream({ system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], signal })) {
    if (chunk?.type === 'block-end') { if (chunk?.block?.type === 'text' && typeof chunk.block.text === 'string') blocks.push(chunk.block.text); continue }
    deltas += textOf(chunk)
    if (chunk?.type === 'finish' && chunk?.reason?.kind && chunk.reason.kind !== 'ok') {
      throw Object.assign(new Error('流以 ' + chunk.reason.kind + ' 结束'), { code: 'llm-stream-failed' })
    }
  }
  return blocks.length > 0 ? blocks.join('') : deltas
}

function extractJsonArray (text) {
  const raw = String(text ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fenced === null ? raw : fenced[1]
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(body.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const normalizeItems = (list, previous) => {
  const seenOf = new Map((previous ?? []).map((item) => [item.meme, item.seen ?? 0]))
  // 刷新只换"梗的内容"，不该把使用历史清零 —— 否则每月刷新一次就等于给所有梗免一次冷却
  const usesOf = new Map((previous ?? []).map((item) => [item.meme, Array.isArray(item.uses) ? item.uses.slice(-MEME_USES_KEPT) : []]))
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    if (item === null || typeof item !== 'object') continue
    const meme = clip(item.meme ?? item.text ?? item.name, 24)
    if (meme === '') continue
    out.push({
      meme,
      meaning: clip(item.meaning ?? item.desc, 60),
      example: clip(item.example ?? '', 80),
      seen: Math.max(0, Math.round(Number(seenOf.get(meme) ?? item.seen ?? 0)) || 0),
      uses: usesOf.get(meme) ?? [],
    })
    if (out.length >= MEMES_MAX) break
  }
  return out
}

/**
 * 刷新梗库。**一天最多尝试一次**（成功或失败都记 lastAttemptAt），30 秒超时，失败不抛。
 *
 * @param {{llm?: object, tools?: any, ctx?: object, now?: number}} input
 * @returns {Promise<{ok:boolean, source:string, stage:string, count:number, reason?:string, error?:string}>}
 */
export async function refreshMemes ({ llm, tools, ctx, now = Date.now() } = {}) {
  const before = loadMemes()
  if (attemptedToday(now)) return { ok: false, source: before.source, stage: before.stage, count: before.items.length, reason: 'daily-limit' }

  const markAttempt = (extra) => {
    const next = { ...before, ...extra, lastAttemptAt: new Date(now).toISOString() }
    saveMemes(next)
    return next
  }

  const controller = new AbortController()
  const timer = setTimeout(() => { try { controller.abort() } catch { /* 已结束 */ } }, REFRESH_TIMEOUT_MS)
  if (typeof timer.unref === 'function') timer.unref()

  const fail = (error) => {
    // 失败：保留旧列表，只标 stale + 记原因（§14.3）
    markAttempt({ stage: 'stale', lastMemeError: clip(error, 160) })
    return { ok: false, source: before.source, stage: 'stale', count: before.items.length, error: clip(error, 160) }
  }

  try {
    // ① 优先用宿主的 web_search 取"原料"（真实联网，可信）；结构化仍要模型 —— 只有搜索文本
    //    拼不出 meaning/example。所以 source 只有"搜索成功且结构化成功"时才算 web_search。
    const search = findHostTool({ tools, ctx }, 'web_search')
    let material = ''
    let usedSearch = false
    if (search !== null) {
      try {
        const out = await search.execute({ queries: ['最近流行的 B站 网络热梗', '2026 网络流行语 梗 含义'] }, {})
        if (out !== null && typeof out === 'object' && out.ok !== false) {
          material = clip(out.content ?? JSON.stringify(out.sources ?? []), 4000)
          usedSearch = material.trim() !== ''
        }
      } catch { /* 搜索失败 → 退到模型 */ }
    }

    const system = [
      '你要整理一份「最近流行的中文网络热梗」清单，用于聊天时偶尔玩梗。',
      '只输出 JSON 数组，不要解释。每个元素：{"meme":"梗本身","meaning":"一句话含义","example":"一个自然的使用例子"}。',
      '只要 12–20 条；过气或重复的不要；含义不清的不要。',
    ].join('\n')
    const user = usedSearch
      ? '下面是联网搜到的素材，请据此整理（不要编造素材里没有的梗）：\n' + material
      : '你凭已有知识列出近半年内中文互联网上常用、且不容易冒犯人的热梗。'

    const raw = await askLlm(llm, { system, user, signal: controller.signal })
    const items = normalizeItems(extractJsonArray(raw), before.items)
    if (items.length === 0) return fail('模型没有给出可用的梗列表（JSON 解析为空）')

    const next = markAttempt({
      updatedAt: new Date(now).toISOString(),
      source: usedSearch ? 'web_search' : 'llm',
      stage: 'fresh',
      items,
      lastMemeError: '',
    })
    return { ok: true, source: next.source, stage: 'fresh', count: next.items.length }
  } catch (error) {
    return fail(error?.message ?? String(error))
  } finally {
    clearTimeout(timer)
  }
}

/** 用了一次梗：seen + 1、uses 追加一条（落盘）。 */
export function bumpSeen (meme, nowMs = Date.now()) {
  const key = clip(meme, 24)
  if (key === '') return { ok: false }
  const memes = loadMemes()
  let hit = false
  const now = new Date(nowMs).toISOString()
  for (const item of memes.items) {
    if (item.meme !== key) continue
    item.seen += 1
    // 只保留最近 MEME_USES_KEPT 条：算 7 天窗口用不到更老的，留多了只是让文件变肥
    item.uses = [...(Array.isArray(item.uses) ? item.uses : []), now].slice(-MEME_USES_KEPT)
    hit = true
  }
  if (!hit) return { ok: false }
  saveMemes(memes)
  const item = memes.items.find((entry) => entry.meme === key)
  return { ok: true, seen: item?.seen ?? 0, uses: item?.uses?.length ?? 0 }
}

/** 某条梗在冷却窗内用了几次（窗口外的历史不计）。 */
export function usesInWindow (item, now = Date.now()) {
  const uses = Array.isArray(item?.uses) ? item.uses : []
  let count = 0
  for (const at of uses) {
    const ms = Date.parse(String(at))
    if (Number.isFinite(ms) && now - ms < MEME_COOLDOWN_MS) count += 1
  }
  return count
}

/**
 * 取 n 条给提示用。
 *
 * 两道筛选：
 *   ① **7 天内用过 ≥2 次的梗直接不出现**（persona.md L43 的硬规则，见 MEME_COOLDOWN_MS 注释）；
 *   ② 含义为空的不用（模型看不懂的梗不如不给）。
 * 排序按累计 seen 升序（用得少的优先），取前 n 条。
 * 过滤后不足 n 条就返回剩下的全部 —— **绝不用超限的梗凑数**；
 * 一条都不剩时返回 `[]`（brain 那边就没有梗可列，她自然这轮不玩梗）。
 */
export function pickForPrompt (n = 12, now = Date.now()) {
  const items = loadMemes().items
    .filter((item) => item.meaning !== '')
    .filter((item) => usesInWindow(item, now) < MEME_MAX_USES_IN_WINDOW)
  const sorted = items.slice().sort((a, b) => (a.seen ?? 0) - (b.seen ?? 0))
  return sorted.slice(0, Math.max(1, Math.round(Number(n) || 12)))
}

/** 给设置页/状态页的一行摘要。 */
export function memeSummary (now = Date.now()) {
  const memes = loadMemes()
  const at = Date.parse(memes.updatedAt)
  const days = Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 86_400_000)) : null
  return {
    updatedAt: memes.updatedAt,
    daysAgo: days,
    count: memes.items.length,
    source: memes.source,
    stage: memes.stage,
    lastAttemptAt: memes.lastAttemptAt,
    lastMemeError: memes.lastMemeError,
  }
}

/** 测试用复位（清空梗库文件与状态）。 */
export function resetForTest () {
  try { fs.rmSync(memesPath(), { force: true }) } catch { /* 没有就算了 */ }
  try { patchState({ lastMemeError: '' }) } catch { /* 无关紧要 */ }
  void readState
  return true
}
