// 配额闸：**预检闸 + 共享内容账本**，不是第二套运行时限速。
//
// 为什么不做运行时限速（这一条最容易做错）：
//   vendor/traffic.mjs 的 guard 在**每个请求发出时**已经强制了 readHourly / readDaily /
//   writeHourly / writeDaily / writeGapSec / dmGapSec / minGapMs，状态落在共享的
//   <stateDir>/traffic-state.json，另外还有"相同写操作去重"。再复刻一套一模一样的速度控制，
//   只会得到两套互相不知道的计数器 —— 那正是旧实现踩过的坑（两个插件各写 30 条 = 实际 60 条）。
//   所以这里只做两件 guard 看不见的事：① 发之前的**内容账本**预检；
//   ② 发成功之后的**记账**（带 type/target/note，人能看懂"今天到底发了什么"）。
//
// 为什么两个方向都只能更严、不能更松：
//   · 预检通过 ≠ guard 放行（guard 还会拦冷却 / 去重 / 风控暂停）→ 调用方必须两关都过。
//   · guard 抛 TrafficError（暂停 / 冷却 / 重复）→ 客户端转成结构化错误，**不记账**（没发出去）。
//   · 账本坏掉 = 状态未知 → 拒绝发送（fail-closed）。这一点抄自旧实现的血泪：
//     以前 catch 后直接退默认值，等于坏一次额度就重置，闸门形同不存在 ✗
//
// 账本格式必须与既有文件逐字段一致（{ log: [{ at, type, auto, share, target, note }] }）：
//   两个插件共用一个 ~/.bili-ai/quota.json，字段名差一个字就会各算各的。
//   读取时**容忍任意既有字段**（容忍 auto/share 为 true、容忍别的实现加的字段），
//   绝不因为不认识某一条就整份报错 —— 报错等于把主人正在用的账本判成坏文件。
import fs from 'node:fs'
import path from 'node:path'

import { DEFAULTS, stateDir, writeJsonAtomic } from './config.js'
import { gateToken, tokenStatus } from './tokenbudget.js'

/**
 * 走闸的写通道（INTERFACE §6 / §13.2）。'dm' 单独用 dmGapSec，其余用 writeGapSec。
 * 'relation'（关注 / 取关）是 2026-11-01 第二批工具加进来的写动作：它改变账号的对外关系，
 * 和评论一样要过 token 预算 + 写间隔 —— 不是"读一下别人的主页"那种动作。
 */
export const WRITE_TYPES = ['comment', 'reply', 'dynamic', 'dynamic_edit', 'danmaku', 'dm', 'favorite', 'like', 'relation']

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

/** 账本文件：<stateDir>/quota.json —— 与同一账号下的其它实现**共用同一份**。 */
export function quotaFile (config) {
  return path.join(stateDir(config), 'quota.json')
}

/**
 * 生效的预算。归一化规则与 vendor/traffic.mjs 的 riskSettings 完全对齐：
 *   · 预算类（hourly/daily）必须 > 0 才生效（写 0 = 没填，防止手滑把闸门关掉）
 *   · writeGapSec 最低 30 秒 · dmGapSec 允许 0（主人明确要求私信不冷却）
 *   —— 这里若比 guard 松，就会出现"预检说行、guard 拒绝"的困惑；若比 guard 紧，
 *      主人改设置会发现改不动。所以只能对齐。
 */
function budgets (config) {
  const raw = config?.risk ?? {}
  const pick = (key, fallback) => {
    const n = Number(raw[key])
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
  }
  const dmRaw = Number(raw.dmGapSec)
  return {
    writeHourly: pick('writeHourly', DEFAULTS.risk.writeHourly),
    writeDaily: pick('writeDaily', DEFAULTS.risk.writeDaily),
    writeGapSec: Math.max(30, pick('writeGapSec', DEFAULTS.risk.writeGapSec)),
    dmGapSec: Number.isFinite(dmRaw) && dmRaw >= 0 ? Math.max(0, Math.floor(dmRaw)) : DEFAULTS.risk.dmGapSec,
  }
}

/** 读账本。文件不存在 = 全新安装（空账本，不算坏）；读不出来 = 坏（调用方据此 fail-closed）。 */
function readLedger (config) {
  const file = quotaFile(config)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { log: [], corrupt: false, file }
  }
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    const list = Array.isArray(parsed?.log) ? parsed.log : Array.isArray(parsed) ? parsed : []
    // 容忍：只要 at 能解析就算一条；不认识的字段原样留着（本模块只追加，从不重写别人的条目）
    return { log: list.filter((item) => item !== null && typeof item === 'object'), corrupt: false, file }
  } catch {
    return { log: [], corrupt: true, file }
  }
}

/** 等锁的总预算（毫秒）：足够扛住"另一个进程正在读-改-写"的几十毫秒，又不会把工具调用拖死。 */
const LOCK_TIMEOUT_MS = 5000
/** 陈旧锁判定：持有者崩了（Windows 上被杀/断电）超过这个时间就接管，否则闸门永久卡死。 */
const LOCK_STALE_MS = 10_000

/**
 * 真正的互斥文件锁（`<file>.lock`，`openSync(..., 'wx')` 独占创建）。
 *
 * 2026-11-01 的重要教训（**原子写 ≠ 互斥**）：
 *   tmp+rename 只保证"文件不会坏"，它**不保证不丢更新** —— 两个进程各自
 *   「读账本(20 条) → push(21) → 原子写回」时，后写的那个把前一个的第 21 条覆盖掉了。
 *   真机上这意味着共享 `quota.json` 的两个实现会**少记**：配额算少 → 多发 → 更容易被风控。
 *   所以这里必须是硬锁：**先拿锁，再读账本**（顺序反了等于没锁）。
 *
 * 拿不到锁时**不再"照常干活"**（以前就是这么丢记录的）：返回 { locked:false, reason }，
 *   由 record() 变成结构化失败 `{ ok:false, reason:'busy' }` —— 宁可这一次不记，
 *   也不能静默丢一条让闸门变松。
 *
 * 等不到锁也不制造幻象：预算是 LOCK_TIMEOUT_MS（5 秒），退避 10–35ms 抖动。
 */
function withLock (file, fn) {
  const lock = `${file}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let fd
  try { fs.mkdirSync(path.dirname(file), { recursive: true }) } catch { /* 权限问题留给 open/write 去暴露 */ }
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx')
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })) } catch { /* 内容只是给人看的 */ }
      break
    } catch (error) {
      // Windows 上"文件已存在"不一定报 EEXIST：杀软/其它进程刚碰到它时可能给 EPERM/EBUSY/EACCES。
      // 这几种都表示"别人正在拿着"，必须**继续等**；只有真正不可用（ENOSPC/EACCES 到目录等）才放弃。
      const code = String(error?.code ?? error)
      if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(code)) return { locked: false, reason: 'lock-unavailable: ' + code }
      try {
        // 陈旧锁：持有者崩了 → 接管，否则闸门会永久卡死
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true })
          continue
        }
      } catch { /* 锁刚被别人删掉 → 下一轮自己抢 */ }
      if (Date.now() > deadline) return { locked: false, reason: 'lock-timeout' }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.floor(Math.random() * 25))
    }
  }
  try {
    return { locked: true, value: fn() }
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* 已关 */ }
      try { fs.rmSync(lock, { force: true }) } catch { /* 已被别人接管 */ }
    }
  }
}

const timeOf = (entry) => {
  const t = Date.parse(String(entry?.at ?? ''))
  return Number.isFinite(t) ? t : null
}

function countWithin (log, now, windowMs) {
  let n = 0
  for (const entry of log) {
    const t = timeOf(entry)
    if (t !== null && now - t < windowMs) n += 1
  }
  return n
}

function lastAtOfType (log, type) {
  let last = 0
  for (const entry of log) {
    if (String(entry?.type ?? '') !== type) continue
    const t = timeOf(entry)
    if (t !== null && t > last) last = t
  }
  return last
}

/** 最近一次"任意通道"的写（§ 真机 bug：写间隔必须跨类型，风控看的是账号整体节奏）。 */
function lastAnyWriteAt (log) {
  let last = 0
  for (const entry of log) {
    const t = timeOf(entry)
    if (t !== null && t > last) last = t
  }
  return last
}

function lastAtExceptType (log, type) {
  let last = 0
  for (const entry of log) {
    if (String(entry?.type ?? '') === type) continue
    const t = timeOf(entry)
    if (t !== null && t > last) last = t
  }
  return last
}

/**
 * 发之前过闸。
 * @param {object} config 生效配置（现读的那份）
 * @param {{type: string, target?: string}} options
 * @returns {{ok: true} | {ok: false, reason: string, human: string, detail: object}}
 *
 * 顺序（INTERFACE §11.2）：**token 预算 → 写间隔（gap）**。两者任一不过就拒，且都**不记账**。
 * 2026-11-01 起不再按"读写条数"判定 —— writeHourly/writeDaily 已废弃（只留在配置里兼容旧文件）。
 *
 * 注意：**gate() 不记账**。不通过的每一次调用都只是读账本/读用量，碰都不碰配额账本。
 */
export function gate (config, options = {}) {
  const type = String(options?.type ?? '').trim()
  if (type === '') {
    return { ok: false, reason: 'bad-argument', human: 'gate() 需要一个 type（写通道的类型）', detail: { used: null, limit: null, window: 'argument' } }
  }

  // ① token 预算（额度真正的判据）。账本不可用时 fail-open，由 gateToken 自己决定。
  const token = gateToken(config)
  if (token.ok !== true) return token

  const limit = budgets(config)
  const { log, corrupt, file } = readLedger(config)
  if (corrupt) {
    return {
      ok: false,
      reason: 'quota-exceeded',
      human: `配额账本读不出来（${file} 不是合法 JSON）→ 状态未知，本次不发送。确认无误后可以删掉它（删 = 当天额度从 0 重算）`,
      detail: { used: null, limit: null, window: 'ledger', path: file },
    }
  }
  const now = Date.now()
  // ② 写间隔：**跨所有写类型**，不是按类型各算各的（2026-11-02 真机 bug 修复）。
  //   现场：comment 记在 16:22:51.678，reply 请求在 16:22:51.726（48 毫秒后）→ B站 直接 risk-control。
  //   根因：以前用 lastAtOfType(log, type) 找"同类上一条"，comment 与 reply 是不同类型 → 各算各的间隔。
  //   为什么必须跨类型：**风控看的是"这个账号短时间内在发东西"，不是"这个通道发了几次"。**
  //   dm 也按自己的 dmGapSec 判，但它同样要看到"上一条是 comment"——否则私信会紧跟着评论发出去。
  const gapSec = type === 'dm' ? limit.dmGapSec : limit.writeGapSec
  const last = Math.max(lastAnyWriteAt(log), lastAtOfType(log, type))
  if (last > 0 && gapSec > 0) {
    const leftMs = gapSec * 1000 - (now - last)
    if (leftMs > 0) {
      return {
        ok: false,
        reason: 'quota-exceeded',
        human: `上一条写（任意通道）刚发出去，还要等 ${Math.ceil(leftMs / 1000)} 秒（间隔 ${gapSec} 秒）`,
        detail: { used: Math.floor((now - last) / 1000), limit: gapSec, window: 'gap' },
      }
    }
  }
  return { ok: true }
}

/**
 * 发送成功后记账（**失败不记** —— 没发出去就不该占额度）。
 *
 * 为什么必须在**同一把锁里** read → append → 原子写（顺序不能反）：
 *   先读后锁 = 两个进程读到同一份 log，各 append 一条，后写的把先写的覆盖掉 ——
 *   这就是 lost update。原子写只保证文件不坏，**不保证不丢更新**。
 *   少记一条 = 闸门悄悄变松 = 多发 = 更容易被风控。
 *
 * 拿不到锁时返回 `{ ok:false, reason:'busy' }`：宁可这次不记（下次还有机会），
 *   也绝不静默丢一条。调用方（api/actions）看到 ok:false 就不会把这次当成"已记账"。
 */
export function record (config, options = {}) {
  const type = String(options?.type ?? '').trim()
  if (type === '') {
    return { ok: false, reason: 'bad-argument', human: 'record() 需要一个 type（写通道的类型）' }
  }
  const target = String(options?.target ?? '')
  const file = quotaFile(config)
  const locked = withLock(file, () => {
    const { log } = readLedger(config)
    // 字段名/顺序与既有账本一致（at/type/auto/share/target/note）；note 截 40 字符照旧
    const entry = {
      at: new Date().toISOString(),
      type,
      auto: options?.auto === true,
      share: options?.share === true,
      target: target === '' ? null : target,
      note: String(options?.note ?? '').slice(0, 40) || null,
    }
    writeJsonAtomic(file, { log: [...log, entry] })
    return { ok: true, data: quotaStatus(config) }
  })
  if (locked.locked !== true) {
    return {
      ok: false,
      reason: 'busy',
      human: `配额账本正被另一个进程写（${locked.reason}）—— 这次没有记账。稍后重试；若反复出现，检查是否有两个实现同时高频写 ${file}`,
      detail: { file, reason: locked.reason },
    }
  }
  return locked.value
}

/** 现状：小时/天的用量与上限，以及两个冷却还剩多少秒。共享账本，所以数字是"两个插件加起来"的。 */
export function quotaStatus (config) {
  const limit = budgets(config)
  const { log, corrupt, file } = readLedger(config)
  const now = Date.now()
  const lastDm = lastAtOfType(log, 'dm')
  const lastWrite = lastAtExceptType(log, 'dm')
  const leftSec = (lastAt, gapSec) => (lastAt > 0 && gapSec > 0 ? Math.max(0, Math.ceil((lastAt + gapSec * 1000 - now) / 1000)) : 0)
  // 额度真正的判据（token 预算）；hour/day 那两行是**账本条目数**，保留只作参考，不再是额度
  const tokens = tokenStatus(config)
  return {
    tokens: {
      hour: { used: tokens.hour.used, limit: tokens.hour.limit },
      day: { used: tokens.day.used, limit: tokens.day.limit },
      source: tokens.source,
    },
    hour: { used: countWithin(log, now, HOUR_MS), limit: limit.writeHourly },
    day: { used: countWithin(log, now, DAY_MS), limit: limit.writeDaily },
    writeGapLeftSec: leftSec(lastWrite, limit.writeGapSec),
    dmGapLeftSec: leftSec(lastDm, limit.dmGapSec),
    entries: log.length,
    corrupt,
    file,
  }
}

/**
 * 测试用复位。实话说：本模块**没有任何模块级缓存**（每次调用现读文件，
 * 因为账本是两个进程共享的，缓存就等于读到别人的旧状态），所以这里没什么可清的。
 * 保留这个导出是因为契约里写了它，而且将来若加了缓存，复位点已经在了。
 */
export function resetForTest () {
  return true
}
