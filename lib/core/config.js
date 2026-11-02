// 配置层：一个 JSON 文件承载"属于使用者"的东西（主人 mid、风控预算、状态目录）。
//
// 为什么每一层都"每次现读"而不是在 apply 时解析一次：
//   设置页保存只写一个 JSON 文件，宿主不会因此重载插件。配置一旦被冻结，
//   用户改完主人 mid / 预算之后，下一次调用用的还是旧值 —— 界面说"已保存"却没效果，
//   那比没有界面更糟。所以 loadConfig() 每次现读文件 + 现合并，**不缓存**。
//
// 为什么文件坏了要静默退回默认值而不是抛：
//   Windows 上被记事本存过的 JSON 会带 BOM，一次手滑编辑就能让插件整体加载失败 ——
//   而"读不到配置"的正确行为是保守地跑默认值（默认主人 mid / 默认预算都是安全的），
//   然后让人在设置页重新保存一次。抛异常等于把可用性交给一次文本编辑。
//
// 这三个默认值全部来自实测（PROMPT §3 / §6.1），不是猜的：
//   主人的 mid、七个风控数字、状态目录留空 = ~/.bili-ai（共享，见 §1.4）。
//
// 为什么 writeJsonAtomic / readJsonSafe 也在这里：
//   本模块的目录是**别人定死的**（lib/core 只有五个文件，没有 fs 工具位），
//   而配额账本和凭据都要"原子写"，三处各抄一遍迟早有一处忘记 tmp+rename。
//   config 是最底层（不 import 其它 core 模块），放在这里不会有环。
import fs from 'node:fs'
import path from 'node:path'

import { dshPath, stateDir as vendorStateDir } from '../vendor/paths.mjs'

/** 默认配置文件位置（可用 $DSH_BILI_CONFIG 覆盖，测试用 setConfigPathForTest）。 */
const DEFAULT_CONFIG_PATH = process.env.DSH_BILI_CONFIG
  ? path.resolve(process.env.DSH_BILI_CONFIG)
  : dshPath('dsh-bili.config.json')

/**
 * 当前生效的配置文件路径 —— 是个**活的** export（ESM live binding）：
 * setConfigPathForTest() 改了之后，所有 import 它的人立刻看到新值，
 * 不需要重启、也不需要把路径在别的模块里再拼一遍（拼两遍就会分叉）。
 */
export let CONFIG_PATH = DEFAULT_CONFIG_PATH

/**
 * 内置默认值。owner 是实测的主人不变量；risk 是平台安全带；budget 才是**额度**。
 *
 * 2026-11-01 需求变更（用户决定）：额度按**花费的 token** 计，不再按读写条数。于是：
 *   · `risk.readHourly/readDaily/writeHourly/writeDaily` **保留字段但已废弃** —— 留着是为了
 *     旧配置文件（里面可能还是 600/3000/12/30）能被照常合并、不炸；但判定不再看它们。
 *     默认值改成 1e7 是第二道保险：万一有别的路径仍在读这两个数字（vendor 的 guard 就是），
 *     那个量级等于是"不拦"，不会再把人锁死在旧阈值上。
 *   · 真正起作用的是 `budget.tokenHourly/tokenDaily`（见 core/tokenbudget.js）。
 *   · `minGapMs / writeGapSec / dmGapSec` 原样保留：那是 B站 平台安全带（间隔），不是额度。
 */
export const DEPRECATED_COUNT_LIMIT = 10_000_000

export const DEFAULTS = {
  owner: { mid: 389989266, name: '往生堂七七代堂主' },
  budget: {
    tokenHourly: 1_000_000,   // 本小时可用 token（input+output）
    tokenDaily: 8_000_000,    // 本天可用 token
  },
  risk: {
    minGapMs: 1500,      // 两次动作最小间隔（保留）
    readHourly: DEPRECATED_COUNT_LIMIT,   // 已废弃：仅兼容旧配置，不再参与判定
    readDaily: DEPRECATED_COUNT_LIMIT,    // 已废弃
    writeHourly: DEPRECATED_COUNT_LIMIT,  // 已废弃（写额度改看 token budget）
    writeDaily: DEPRECATED_COUNT_LIMIT,   // 已废弃
    writeGapSec: 120,    // 两次写之间最小间隔（保留）
    dmGapSec: 60,        // 两次私信之间最小间隔（保留）
  },
  paths: { stateDir: '' },
}

/** apply(ctx, rawConfig) 传进来的插件配置 —— 优先级低于配置文件，高于内置默认。 */
let pluginConfig = {}

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 深合并（数组整体替换：预算是标量、whitelist 这类数组"合并"语义说不清，替换才可预期）。 */
function merge (base, over) {
  const out = isPlain(base) ? { ...base } : {}
  if (!isPlain(over)) return out
  for (const [key, value] of Object.entries(over)) {
    out[key] = isPlain(value) ? merge(isPlain(base?.[key]) ? base[key] : {}, value) : value
  }
  return out
}

/** 读一个 JSON 文件；不存在/坏掉/带 BOM 都返回 fallback，绝不抛。 */
export function readJsonSafe (file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

/* ───────────────────── 原子写：tmp + rename（+ Windows 有界重试） ─────────────────────
 *
 * 为什么必须有重试（2026-11-01 真机事故，不是测试瑕疵）：
 *   Windows 上 rename 覆盖一个"正被别的进程打开/正在被 rename"的目标文件，会直接返回
 *   EPERM / EBUSY（POSIX 上同名操作是原子的，Windows 不是）。而共享状态文件天然会被
 *   两个插件、或同一插件的两个子进程同时写：api-ban.json（熔断）、quota.json（配额账本）。
 *   没有重试的后果很具体：一次 412 之后的熔断落盘直接抛错 → 记账失败 → 闸门状态错乱。
 *   这正是 PROMPT §1.4 要求"共享状态不能坏"的那一条。
 *
 * 为什么不是"先删目标再 rename"：
 *   那就不是原子写了。断电/崩溃的瞬间账本会整份消失（旧读者会读到 ENOENT → 当"全新安装"
 *   → 额度从 0 重算）。宁可重试 1 秒，也不换掉原子性。
 *
 * 为什么最终失败时**保留 tmp**：
 *   排障时只剩一句 EPERM 等于什么都没说。留下 tmp，人能直接看到"这一次到底要写什么"，
 *   也能手工 rename 回去；错误信息里带上 tmp 路径与原始 code。
 *
 * 这里的 sleep 同步（Atomics.wait）：本函数是同步 API，调用方（record / saveConfig）
 * 都在同步上下文里，改成 async 会污染整条调用链。
 *
 * 已知边界（别指望重试能解决）：对方**永久**持有目标文件时，Windows 上 rename 覆盖永远 EPERM。
 *   实测（2026-11-01）：另一个进程把文件开着不放 → 8 次重试 1 秒预算全用完仍失败；
 *   而"短暂持有"（实测 300ms）→ 重试 351ms 后成功。所以重试治的是**抖动**，不是死锁；
 *   死锁只能由持有方松手，或由人事后按报错里的 tmp 路径恢复。
 */
const RENAME_ATTEMPTS = 8
const RENAME_BASE_WAIT_MS = 10
const RENAME_MAX_WAIT_MS = 200
const RENAME_BUDGET_MS = 1000
/** 可重试的 rename 失败：Windows 的占用（EPERM/EBUSY/EACCES）、对端刚清掉 tmp（ENOENT）、以及瞬时 EAGAIN。 */
const RENAME_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOENT', 'EAGAIN'])

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** tmp 名唯一化用的进程内序号：同一毫秒内两次写（同 pid）不会拿到同一个 tmp。 */
let tmpSeq = 0

/**
 * 原子写 JSON（tmp + rename；同目录内的 rename 才是原子的，跨盘会退化成复制）。
 * quota.json / credentials.json / 配置文件都走这一个实现 —— 原子写只允许有一份。
 */
export function writeJsonAtomic (file, value, { pretty = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  tmpSeq = (tmpSeq + 1) % 1_000_000
  const tmp = `${file}.${process.pid}.${Date.now()}.${tmpSeq}.tmp`
  const text = JSON.stringify(value, null, pretty ? 2 : 0) + (pretty ? '\n' : '')

  // 先把内容完整落到 tmp。这一步失败（盘满/无权限）就没必要重试了。
  try {
    fs.writeFileSync(tmp, text)
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 半个 tmp 删不掉也不影响真正的错误 */ }
    throw error
  }

  let lastError = null
  const deadline = Date.now() + RENAME_BUDGET_MS
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (error) {
      lastError = error
    }
    if (!RENAME_RETRYABLE.has(lastError?.code)) break
    if (attempt >= RENAME_ATTEMPTS) break
    // ENOENT = tmp 被对端清掉了（撞名/清理器），重写一份再试；其它码只是等对方松手
    if (lastError.code === 'ENOENT') {
      try { fs.writeFileSync(tmp, text) } catch { /* 写不回去就让下一轮以原始错误收场 */ }
    }
    const wait = Math.min(RENAME_MAX_WAIT_MS, RENAME_BASE_WAIT_MS * 2 ** (attempt - 1))
    if (Date.now() + wait > deadline) break
    sleepSync(wait)
  }

  // 到这里 = 重试预算内没能换成。**保留 tmp**，把原始 code 与 tmp 路径一起抛出去。
  const wrapped = new Error(
    `原子写失败（${lastError?.code ?? 'unknown'}）：${file} —— 内容已留在 ${tmp}，可手工恢复；原始错误：${lastError?.message ?? 'unknown'}`
  )
  wrapped.code = lastError?.code
  wrapped.cause = lastError
  wrapped.tmpPath = tmp
  throw wrapped
}

/** 设置插件配置（apply 第二参）。传 undefined / 非对象 = 复位。 */
export function setPluginConfig (raw) {
  pluginConfig = isPlain(raw) ? raw : {}
}

/** 每次现读：内置默认 ← 插件配置 ← 配置文件（后面的赢）。文件坏了只影响它自己那一层。 */
export function loadConfig () {
  const base = merge(structuredClone(DEFAULTS), pluginConfig)
  const file = readJsonSafe(CONFIG_PATH, {})
  return merge(base, isPlain(file) ? file : {})
}

/**
 * 合并写回（只写 patch 里的字段，不把默认值烤进文件 —— 否则以后改默认值对老用户不生效）。
 * @returns {object} 合并后的完整配置（含默认值）
 */
export function saveConfig (patch) {
  const current = readJsonSafe(CONFIG_PATH, {})
  writeJsonAtomic(CONFIG_PATH, merge(isPlain(current) ? current : {}, isPlain(patch) ? patch : {}))
  return loadConfig()
}

/**
 * 状态目录绝对路径：config.paths.stateDir > $DSH_BILI_STATE_DIR > <HOME>/.bili-ai。
 * 默认那一档是**故意**共享的：熔断与配额账本分开就是账号级的两个计数器（§1.4）。
 */
export function stateDir (config) {
  const own = config?.paths?.stateDir
  if (typeof own === 'string' && own.trim() !== '') return path.resolve(own.trim())
  return vendorStateDir()
}

/** 测试用：把配置指向临时文件。传 undefined 复位到默认位置。 */
export function setConfigPathForTest (p) {
  CONFIG_PATH = typeof p === 'string' && p.trim() !== '' ? path.resolve(p.trim()) : DEFAULT_CONFIG_PATH
  return CONFIG_PATH
}
