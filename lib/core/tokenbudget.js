// token 预算闸：额度按**花费的 token** 计（2026-11-01 用户决定，取代"读写次数配额"）。
//
// 为什么改成 token：按条数计跟真实成本无关 —— 一次深读视频能烧掉几十万 token，
//   而"发一条评论"只花几百。按条数额度会两头都错：贵的事放行、便宜的事被拦。
//
// 为什么小时桶要"采样差分"：宿主写的用量账本（$DSH_HOME/dsh-usage/usage-ledger.json）
//   只有**按天**粒度（按 provider/model 记 inputTokens/outputTokens），没有小时桶。
//   所以每次检查时读一次"当天合计"，把与上次采样的差值累加到当前小时桶 —— 这是唯一
//   能在不修改宿主账本的前提下拿到小时粒度的办法。代价是"小时桶"对**同一进程内**的
//   精度是采样间隔级（两次检查之间发生的花费会被记到后一次），这对"拦住失控的写通道"足够。
//
// 为什么 fail-open：账本读不到/坏掉时**不拦**（source:'unavailable'）。宿主没写账本就是
//   宿主的责任，不能因此把插件锁死 —— 那会让"B站 能用、插件却什么都不让发"。宁可少拦，
//   也要让状态里看得见"这一轮没在计量"（bili_status 会显示出来）。
//
// 为什么只拦写通道：读是本插件存在的前提（刷视频/看评论）；写才是会产生外部影响、
//   也才值得为成本负责的动作。这条边界写在 quota.gate() 里。
import fs from 'node:fs'
import path from 'node:path'

import { DSH_HOME } from '../vendor/paths.mjs'
import { DEFAULTS, readJsonSafe, stateDir, writeJsonAtomic } from './config.js'

const HOUR_MS = 3600 * 1000

/** 用量账本：宿主写的按天账本。$DSH_BILI_USAGE_LEDGER 只给测试用（默认路径不变）。 */
export function usageLedgerPath () {
  const override = process.env.DSH_BILI_USAGE_LEDGER
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim())
  return path.join(DSH_HOME, 'dsh-usage', 'usage-ledger.json')
}

/** 采样状态文件（小时桶的差分账）：<stateDir>/token-budget.json。 */
export function budgetStatePath (config) {
  return path.join(stateDir(config), 'token-budget.json')
}

const localDay = (d = new Date()) => d.toLocaleDateString('sv-SE')            // YYYY-MM-DD（本地）
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10)               // 宿主若按 UTC 记账
const localHourKey = (d = new Date()) => localDay(d) + 'T' + String(d.getHours()).padStart(2, '0')

const fmt = (n) => Number(n).toLocaleString('en-US')
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/** 一天的账：provider → model → { inputTokens, outputTokens, ... }。只算 input+output。 */
function sumDay (bucket) {
  let total = 0
  for (const models of Object.values(bucket ?? {})) {
    for (const entry of Object.values(models ?? {})) {
      const input = Number(entry?.inputTokens)
      const output = Number(entry?.outputTokens)
      if (Number.isFinite(input)) total += input
      if (Number.isFinite(output)) total += output
    }
  }
  return total
}

/**
 * 读账本当天的合计。
 * @returns {{file: string, total: number|null}} total = null 表示"读不到"（缺失/坏/结构不对）
 */
function readDayTotal () {
  const file = usageLedgerPath()
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { file, total: null }
  }
  let parsed
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return { file, total: null }
  }
  const days = parsed?.days
  if (parsed === null || typeof parsed !== 'object' || days === null || typeof days !== 'object') return { file, total: null }
  const local = localDay()
  const utc = utcDay()
  // 宿主按哪个时区切日期是实现细节：优先本地日；本地日不存在而 UTC 日存在就用 UTC 日
  if (days[local] !== undefined) return { file, total: sumDay(days[local]) }
  if (utc !== local && days[utc] !== undefined) return { file, total: sumDay(days[utc]) }
  return { file, total: 0 }
}

/** 生效预算（>0 才生效；0/缺省回落默认，防手滑把闸门关掉）。 */
function budgetOf (config) {
  const raw = config?.budget ?? {}
  const pick = (key, fallback) => {
    const n = Number(raw[key])
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
  }
  return {
    tokenHourly: pick('tokenHourly', DEFAULTS.budget.tokenHourly),
    tokenDaily: pick('tokenDaily', DEFAULTS.budget.tokenDaily),
  }
}

const sameState = (a, b) => a.hourKey === b.hourKey && a.hourUsed === b.hourUsed && a.dayKey === b.dayKey && a.dayBase === b.dayBase && a.sampledTotal === b.sampledTotal

/**
 * 当前 token 用量。
 * @returns {{hour:{used:number,limit:number}, day:{used:number,limit:number}, source:'ledger'|'unavailable', sampledAt:string, file:string, stateFile:string}}
 *
 * 注意：这个函数**有副作用**（会推进采样状态并原子落盘）—— 因为"小时桶"只能靠采样差分得到，
 * 不给它写状态的权限就永远算不出小时用量。状态文件写不进去只影响精度，绝不影响放行（fail-open）。
 */
export function tokenStatus (config) {
  const limit = budgetOf(config)
  const now = Date.now()
  const sampledAt = new Date(now).toISOString()
  const { file, total } = readDayTotal()
  const stateFile = budgetStatePath(config)

  if (total === null) {
    return {
      hour: { used: 0, limit: limit.tokenHourly },
      day: { used: 0, limit: limit.tokenDaily },
      source: 'unavailable',
      sampledAt,
      file,
      stateFile,
    }
  }

  const dayKey = localDay()
  const hourKey = localHourKey()
  const prev = readJsonSafe(stateFile, null)
  const base = prev !== null && typeof prev === 'object' ? prev : {}
  let hourUsed = Number(base.hourUsed ?? 0)
  if (!Number.isFinite(hourUsed) || hourUsed < 0) hourUsed = 0
  let sampledTotal = Number(base.sampledTotal ?? 0)
  if (!Number.isFinite(sampledTotal)) sampledTotal = 0
  let dayBase = Number(base.dayBase ?? 0)
  if (!Number.isFinite(dayBase)) dayBase = 0

  const hadState = prev !== null && typeof prev === 'object' && String(base.dayKey ?? '') !== ''
  if (!hadState) {
    // 第一次采样（状态文件不存在）：**只建基线**，当前小时从 0 起算。
    //
    // 为什么不能把当天合计整笔记进小时桶（2026-11-01 裁决）："本小时已花"必须真的是本小时。
    //   若把当天整笔算进当前小时，重启就会无故停写到下一个整点 ——
    //   今天已花 2,000,000、每小时上限 1,000,000 的话，重启后整小时不能写，那不是用户要的语义。
    //   代价：插件在"上一次采样之后"到"本小时"之间的花费会被算进本小时（最多一个采样间隔的量）。
    dayBase = 0
    hourUsed = 0
    sampledTotal = total // 基线：本次不算增量，之后只累加 (total - sampledTotal)
  } else if (String(base.dayKey ?? '') !== dayKey) {
    // 跨天：账本当天合计就是今天的起点，小时桶清零，采样基线归位（昨天的花费不计入今天的小时桶）
    dayBase = total
    hourUsed = 0
    sampledTotal = total
  } else if (String(base.hourKey ?? '') !== hourKey) {
    // 换小时：桶清零，并**从当前总量重新建基线** —— 新的一小时只统计它开始之后的新增量，
    //   上一小时的尾巴不会被搬进这一小时（否则整点后的第一笔就会带着上一小时的账）。
    hourUsed = 0
    sampledTotal = total
  }

  const delta = total - sampledTotal
  if (delta > 0) hourUsed += delta

  const next = { hourKey, hourUsed, dayKey, dayBase, sampledTotal: total }
  if (!sameState({ ...base, ...{} }, next)) {
    try {
      writeJsonAtomic(stateFile, next)
    } catch { /* 采样状态写不进去 → 精度下降，但绝不因此锁死写通道 */ }
  }

  return {
    hour: { used: hourUsed, limit: limit.tokenHourly },
    day: { used: total, limit: limit.tokenDaily },
    source: 'ledger',
    sampledAt,
    file,
    stateFile,
  }
}

/**
 * 写通道的 token 预算闸。
 * @returns {{ok:true, status:object} | {ok:false, reason:'token-budget-exhausted', human:string, detail:object}}
 *
 * fail-open：账本不可用 → 直接放行（见文件头）。
 */
export function gateToken (config) {
  const status = tokenStatus(config)
  if (status.source === 'unavailable') return { ok: true, status }
  const now = Date.now()
  if (status.hour.used >= status.hour.limit) {
    const resumeAt = new Date(Math.ceil(now / HOUR_MS) * HOUR_MS)
    return {
      ok: false,
      reason: 'token-budget-exhausted',
      human: `本小时已花 ${fmt(status.hour.used)} token（上限 ${fmt(status.hour.limit)}）—— 写通道暂停，${hhmm(resumeAt)} 恢复；读通道仍可用`,
      detail: { window: 'hour', hour: status.hour, day: status.day, source: status.source },
    }
  }
  if (status.day.used >= status.day.limit) {
    const resumeAt = new Date(new Date(now).setHours(24, 0, 0, 0))
    return {
      ok: false,
      reason: 'token-budget-exhausted',
      human: `今天已花 ${fmt(status.day.used)} token（上限 ${fmt(status.day.limit)}）—— 写通道暂停，${hhmm(resumeAt)} 恢复；读通道仍可用`,
      detail: { window: 'day', hour: status.hour, day: status.day, source: status.source },
    }
  }
  return { ok: true, status }
}

/**
 * 测试用复位。本模块**没有模块级缓存**（每次现读账本），唯一的状态是磁盘上的采样文件，
 * 而那是每个用例自己的临时目录 —— 所以这里没有可清的东西。
 */
export function resetForTest () {
  return true
}
