// 设置页后端：三条同源 HTTP 路由（status / settings / credential）。
//
// 为什么单独一个文件而不是塞进 lib/index.js：
//   入口只做装配（挂载点已经留在那），而这里全是"信任栅栏 + 白名单校验 + 不回显凭据"这类
//   有分支的规则 —— 塞进入口就没法单独审它，而这恰恰是最该被审的部分。
//
// 为什么每条路由都过信任栅栏（来历见宿主侧实现顶部的注释）：
//   DSH 的 Web 端口是回环地址，但**回环地址不等于可信来源**：浏览器里任意一个标签页都能
//   向 127.0.0.1 发请求。不挡，等于把主人 mid、风控预算和"写凭据"这条通道开放给随便哪个网页。
//   所以**读也挡**：读请求 fail-open 等于把"这台机器上有没有登录态"白送出去。
//
// 零真实网络：status 只用 deps.client.state()（纯读本地熔断/缓存状态）与 core 的现成函数，
//   不碰 nav —— 打开一次设置页就朝 B 站发一个包，是最没必要的那种流量。

import fs from 'node:fs'

import { CONFIG_PATH, DEFAULTS, loadConfig, saveConfig } from './core/config.js'
import { credStatus, saveCookie } from './core/credentials.js'
import { quotaStatus } from './core/quota.js'

/**
 * 路由前缀（与客户端 lib/client.js 的 API 常量是同一份契约，改一处必须改两处）。
 *
 * 为什么中间多一层 `/kernel`：`/dsh-bili/api/*` 这个命名空间已经被另一个同源插件占了
 * （它注册了 exact 的 /api/status 与 /api/settings），而宿主对重复的 (kind, path) **直接 throw**，
 * 我们的注册被静默丢弃 → 请求落到对方的 handler 上（真机症状：401 空 body、无 content-type）。
 * 迁到 kernel 这一层之后，对方在与不在都与我们无关；反过来也不占别人的命名空间。
 */
const API = '/dsh-bili/api/kernel'
const PATH_STATUS = API + '/status'
const PATH_SETTINGS = API + '/settings'
const PATH_CREDENTIAL = API + '/credential'

/** 请求体上限：这三条路由只收几百字节的 JSON，64KB 已经是宽容值。 */
const BODY_LIMIT = 64 * 1024

/**
 * risk 的边界。上下界的来历：下界抄 core/quota.js 的归一化（写间距 30 秒是 guard 的硬下限，
 * 填更小的值会被静默抬到 30，界面就会"存了但没生效"）；上界只是防手滑。
 *
 * 额度口径已改成 token（INTERFACE §11）：readHourly / readDaily / writeHourly / writeDaily
 * 仍然**接受写入**（旧配置文件、旧客户端不会炸），但**不再参与任何判定** —— 所以标 deprecated。
 */
const RISK_RULES = Object.freeze({
  minGapMs: { min: 1, max: 3_600_000 },
  writeGapSec: { min: 30, max: 86_400 },
  dmGapSec: { min: 0, max: 86_400 },
  // —— 以下四个已废弃，仅兼容写入（INTERFACE §11.2）——
  readHourly: { min: 1, max: 100_000, deprecated: true },
  readDaily: { min: 1, max: 1_000_000, deprecated: true },
  writeHourly: { min: 1, max: 10_000, deprecated: true },
  writeDaily: { min: 1, max: 100_000, deprecated: true },
})
const RISK_KEYS = Object.keys(RISK_RULES)

/** config.budget 的边界：1 token – 1e12 token（上界只是防手滑，不是业务判断）。 */
const BUDGET_RULES = Object.freeze({
  tokenHourly: { min: 1, max: 1e12 },
  tokenDaily: { min: 1, max: 1e12 },
})
const BUDGET_KEYS = Object.keys(BUDGET_RULES)

/** 契约 §11 的默认预算：core/config.js 的 DEFAULTS.budget 还没落地时用它兜底（界面不至于显示空）。 */
const CONTRACT_BUDGET = Object.freeze({ tokenHourly: 1_000_000, tokenDaily: 8_000_000 })

/** 版本号：直接读本包 package.json（不是 process.env / 宿主注入，失败就报 0.0.0）。 */
function readVersion () {
  try {
    const parsed = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof parsed?.version === 'string' && parsed.version !== '' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/* ────────────────────────────── HTTP 小工具 ────────────────────────────── */

function json (res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function readBody (req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJsonBody (req) {
  const text = await readBody(req)
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/* ────────────────────────────── 信任栅栏 ────────────────────────────── */

/** 回环快速通道：Host 头是 127.0.0.1 / localhost / [::1] 时直接算可信。 */
function isLoopbackReq (req) {
  const host = String(req?.headers?.host ?? '').toLowerCase()
  const head = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return head === '127.0.0.1' || head === 'localhost' || head === '[::1]' || head === '::1'
}

function connectionOf (ctx) {
  try {
    if (ctx === null || typeof ctx !== 'object') return null
    if (typeof ctx.get === 'function') return ctx.get('connection') ?? null
    return ctx.connection ?? null
  } catch {
    return null
  }
}

/**
 * 完整信任判定：回环 OR 宿主的 connection.isTrusted(req)。
 * 非回环不能一刀切拒 —— DSH 允许绑局域网地址部署，那时合法浏览器访问的 Host 必然非回环。
 * 但**拿不到判定就当不可信**（fail-closed）：安全组件的默认值只能是"关"。
 */
function isTrustedReq (req, ctx) {
  if (isLoopbackReq(req)) return true
  try {
    const conn = connectionOf(ctx)
    if (conn !== null && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
  } catch { /* 栅栏不可用 → 下面按不可信处理 */ }
  return false
}

/** 每条路由都先过栅栏；handler 抛错只回一条人话，绝不把请求体/凭据带进响应或日志。 */
function guarded (ctx, handler) {
  return async (req, res) => {
    if (isTrustedReq(req, ctx) === false) {
      json(res, 403, { ok: false, error: '不受信任的访问来源' })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      try { json(res, 500, { ok: false, error: String(error?.message ?? error) }) } catch { /* 响应已结束 */ }
    }
  }
}

/* ────────────────────────────── 校验与投影 ────────────────────────────── */

/** 数字串 / 整数 → 整数；其它一律 null（让调用方报错，不静默变成 0）。 */
function toInt (raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && Number.isInteger(raw) ? raw : null
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim())
  return null
}

/**
 * token 预算的输入解析：接受带单位的写法（`200K` / `1.5M` / `2,000,000` / `1_500_000` / `8000000`）。
 *
 * 规则（契约）：可选前后空格；可选千分位（`,` 或 `_`）；数字部分可带小数；单位后缀 K/k/M/m
 * 可紧贴也可隔空格。**换算结果必须是整数** —— 所以 `1.234K`（= 1234）可以，`0.0001K`（= 0.1）拒。
 *
 * 为什么用 BigInt 而不是 Number 相乘：`1.234 * 1000` 在浮点里是 1233.9999999999998，
 * 用容差判"是不是整数"就得挑一个容差，而 1e12 量级下任何固定容差都可能放进非整数。
 * 十进制串 × 整数幂 → 精确整除，没有容差，也就没有边界。
 *
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
export function parseTokenAmount (raw) {
  const hint = '支持 200K / 1.5M / 8000000 这类写法'
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) return { ok: false, error: '必须是整数 token 数（' + hint + '）' }
    return { ok: true, value: raw }
  }
  if (typeof raw !== 'string') return { ok: false, error: '必须是字符串或数字（' + hint + '）' }
  // 千分位先剥掉；再按「数字 + 可选单位」整体匹配 —— 负数、1e13、小数点位置错都会在这里落空
  const text = raw.replace(/[,]/g, '').replace(/_/g, '').trim()
  const matched = /^(\d+(?:\.\d*)?|\.\d+)\s*([km])?$/i.exec(text)
  if (matched === null) return { ok: false, error: '看不懂 ' + JSON.stringify(raw) + '（' + hint + '）' }
  const numberPart = matched[1]
  const unit = (matched[2] ?? '').toLowerCase()
  const multiplier = unit === 'k' ? 1000n : unit === 'm' ? 1_000_000n : 1n

  const dot = numberPart.indexOf('.')
  const intPart = dot === -1 ? numberPart : numberPart.slice(0, dot)
  const fracPart = dot === -1 ? '' : numberPart.slice(dot + 1)
  if (intPart.length + fracPart.length > 25 || fracPart.length > 20) {
    return { ok: false, error: '数字太长了（' + hint + '）' }
  }
  const numerator = BigInt((intPart === '' ? '0' : intPart) + fracPart) * multiplier
  const denominator = 10n ** BigInt(fracPart.length)
  if (numerator % denominator !== 0n) {
    return { ok: false, error: '换算后必须是整数 token 数，' + JSON.stringify(raw) + ' = ' + (Number(numerator) / Number(denominator)) + ' tokens（' + hint + '）' }
  }
  const value = numerator / denominator
  if (value < 1n) return { ok: false, error: '必须 ≥ 1 token，收到 ' + JSON.stringify(raw) + '（' + hint + '）' }
  if (value > 1_000_000_000_000n) return { ok: false, error: '超过了 1e12 token 的上限，收到 ' + String(value) + '（' + hint + '）' }
  return { ok: true, value: Number(value) }
}

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 校验一份待写入的设置。
 *   · 未知字段丢弃（客户端多送一个字段不该让保存失败）
 *   · 校验不过 **报错**（静默吞掉的后果是用户以为存上了）
 *   · owner.mid 空串 = **不改**（把它存成空串会让所有写通道拿不到收件人，比报错难查得多）
 * @returns {{ ok: true, patch: object } | { ok: false, error: string }}
 */
function validateSettings (incoming) {
  if (!isPlain(incoming)) return { ok: false, error: '请求体必须是对象' }
  const body = isPlain(incoming.settings) ? incoming.settings
    : isPlain(incoming.config) ? incoming.config
      : incoming
  const patch = {}
  const problems = []

  if (body.owner !== undefined) {
    if (!isPlain(body.owner)) return { ok: false, error: 'owner 必须是对象（{ mid, name }）' }
    const owner = {}
    const rawMid = body.owner.mid
    if (rawMid !== undefined && rawMid !== null && String(rawMid).trim() !== '') {
      const mid = String(rawMid).trim()
      if (!/^\d+$/.test(mid)) problems.push('mid 必须是纯数字串，收到 ' + JSON.stringify(rawMid))
      else if (mid.length > 20) problems.push('mid 太长了（B 站 mid 是十进制数字串）')
      else owner.mid = mid
    }
    const rawName = body.owner.name
    if (rawName !== undefined && rawName !== null) {
      if (typeof rawName !== 'string') problems.push('name 必须是字符串')
      else {
        const name = rawName.trim()
        if (name !== '') {
          if (name.length > 60) problems.push('name 最多 60 个字符')
          else owner.name = name
        }
      }
    }
    if (Object.keys(owner).length > 0) patch.owner = owner
  }

  if (body.risk !== undefined) {
    if (!isPlain(body.risk)) return { ok: false, error: 'risk 必须是对象（数字字段）' }
    const risk = {}
    for (const key of RISK_KEYS) {
      const raw = body.risk[key]
      if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) continue
      const rule = RISK_RULES[key]
      const value = toInt(raw)
      if (value === null) { problems.push(key + ' 必须是正整数，收到 ' + JSON.stringify(raw)); continue }
      if (value < rule.min || value > rule.max) {
        problems.push(key + ' 必须在 ' + rule.min + '–' + rule.max + ' 之间，收到 ' + value)
        continue
      }
      risk[key] = value
    }
    if (Object.keys(risk).length > 0) patch.risk = risk
  }

  // 额度：token 预算（INTERFACE §11）。落在 config.budget，不再进 risk。
  if (body.budget !== undefined) {
    if (!isPlain(body.budget)) return { ok: false, error: 'budget 必须是对象（{ tokenHourly, tokenDaily }）' }
    const budget = {}
    for (const key of BUDGET_KEYS) {
      const raw = body.budget[key]
      if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) continue
      const parsed = parseTokenAmount(raw)
      if (parsed.ok !== true) { problems.push(key + '：' + parsed.error); continue }
      const rule = BUDGET_RULES[key]
      if (parsed.value < rule.min || parsed.value > rule.max) {
        problems.push(key + ' 必须在 ' + rule.min + '–' + rule.max + ' 之间，收到 ' + parsed.value + '（支持 200K / 1.5M / 8000000 这类写法）')
        continue
      }
      budget[key] = parsed.value   // 落盘与回读一律是整数
    }
    if (Object.keys(budget).length > 0) patch.budget = budget
  }

  // 会话模式（2026-11-02）：off = 内核自己 decide；board = 让任务板卡片里的她动手（长期复用同一会话）
  if (body.sessionMode !== undefined) {
    const mode = String(body.sessionMode ?? '').trim()
    if (mode !== 'off' && mode !== 'board') problems.push('sessionMode 只能是 off 或 board，收到 ' + JSON.stringify(body.sessionMode))
    else patch.sessionMode = mode
  }
  if (body.sessionCardId !== undefined) {
    const raw = body.sessionCardId
    if (raw !== null && typeof raw !== 'string') problems.push('sessionCardId 必须是字符串（任务板卡片 ID，留空表示不启用）')
    else {
      const cardId = String(raw ?? '').trim()
      if (cardId.length > 64) problems.push('sessionCardId 最多 64 个字符')
      else patch.sessionCardId = cardId
    }
  }

  if (problems.length > 0) return { ok: false, error: problems.join('；') }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: '没有任何可写字段（只认 owner.mid / owner.name、risk 的间隔字段与 budget 的两个 token 预算）' }
  }
  return { ok: true, patch }
}

/** risk 的展示投影：配置文件缺字段时用 DEFAULTS 补齐，界面就不必自己算回落。 */
function pickRisk (risk) {
  const src = isPlain(risk) ? risk : {}
  const out = {}
  for (const key of RISK_KEYS) {
    const value = Number(src[key])
    out[key] = Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULTS.risk[key]
  }
  return out
}

/** budget 的展示投影：配置文件缺字段时依次回落 DEFAULTS.budget → 契约默认值。 */
function pickBudget (budget) {
  const src = isPlain(budget) ? budget : {}
  const base = isPlain(DEFAULTS.budget) ? DEFAULTS.budget : CONTRACT_BUDGET
  const out = {}
  for (const key of BUDGET_KEYS) {
    const value = Number(src[key] ?? base[key] ?? CONTRACT_BUDGET[key])
    out[key] = Number.isFinite(value) && value >= 0 ? Math.floor(value) : CONTRACT_BUDGET[key]
  }
  return out
}

/**
 * token 用量快照（INTERFACE §11.1 的 core/tokenbudget.js）。
 *
 * 为什么用**动态** import：那个模块是内核实现者并行写的，静态 import 会让"文件还没落地"
 * 直接炸掉整个设置页模块 —— 而这一页坏了不该连工具一起拖下水。拿不到就报 source:'unavailable'，
 * 并且把失败的 promise 清掉，等文件出现后下一次请求自动重试（无需重启）。
 */
let tokenModulePromise = null
function tokenModule () {
  if (tokenModulePromise === null) {
    tokenModulePromise = import('./core/tokenbudget.js').catch(() => {
      tokenModulePromise = null
      return null
    })
  }
  return tokenModulePromise
}

async function tokenSnapshot (config) {
  try {
    const mod = await tokenModule()
    if (mod !== null && typeof mod?.tokenStatus === 'function') {
      const status = mod.tokenStatus(config)
      if (isPlain(status)) return status
    }
  } catch { /* 模块在但它自己抛了：同样降级，不让设置页跟着坏 */ }
  return { source: 'unavailable' }
}

/** 凭据只回 presence，**永不回显值**（INTERFACE §4：credStatus 本身已经这么保证）。 */
function presenceOf (status) {
  const s = isPlain(status) ? status : {}
  return {
    present: s.present === true,
    hasSessdata: s.hasSessdata === true,
    hasJct: s.hasJct === true,
    hasBuvid3: s.hasBuvid3 === true,
    missing: Array.isArray(s.missing) ? s.missing.map((item) => String(item)) : [],
  }
}

function safeTraffic (deps) {
  try {
    const state = deps?.client?.state?.()
    if (isPlain(state)) return state
  } catch { /* 熔断状态读不出来不影响这个页面 */ }
  return { banned: false, banMinutesLeft: 0, banWhy: null, cacheEntries: 0 }
}

function safeQuota (deps, config) {
  try {
    const live = deps?.quota?.status?.()
    if (isPlain(live)) return live
  } catch { /* 退到 core 的现算 */ }
  try {
    return quotaStatus(config)
  } catch {
    return null
  }
}

function capabilityIds (deps) {
  try {
    const list = deps?.capabilities?.list?.()
    if (Array.isArray(list)) return list.map((item) => String(item?.id ?? '')).filter((id) => id !== '')
  } catch { /* 能力表读不出来就报空数组，不假装有 */ }
  return []
}

/** 工具数：能拿到 TOOL_NAMES 就用实际长度，拿不到退回契约里写的 15。 */
async function countTools () {
  try {
    const mod = await import('./tools/index.js')
    if (Array.isArray(mod.TOOL_NAMES) && mod.TOOL_NAMES.length > 0) return mod.TOOL_NAMES.length
  } catch { /* tools 还没装配好（或其中一个 api 模块有问题）→ 用契约里的数字 */ }
  return 15
}

/* ────────────────────────────── 三条路由 ────────────────────────────── */

async function handleStatus (env, res) {
  const config = loadConfig()
  json(res, 200, {
    ok: true,
    data: {
      version: env.version,
      owner: { mid: config?.owner?.mid ?? DEFAULTS.owner.mid, name: config?.owner?.name ?? DEFAULTS.owner.name },
      risk: pickRisk(config?.risk),
      budget: pickBudget(config?.budget),
      tokens: await tokenSnapshot(config),
      credentials: presenceOf(credStatus()),
      traffic: safeTraffic(env.deps),
      quota: safeQuota(env.deps, config),
      capabilities: capabilityIds(env.deps),
      tools: env.toolCount,
    },
  })
}

async function handleSettings (env, req, res) {
  if (req.method === 'GET') {
    const config = loadConfig()
    json(res, 200, {
      ok: true,
      data: {
        owner: { mid: config?.owner?.mid ?? DEFAULTS.owner.mid, name: config?.owner?.name ?? DEFAULTS.owner.name },
        risk: pickRisk(config?.risk),
        budget: pickBudget(config?.budget),
        sessionMode: config?.sessionMode === 'board' ? 'board' : 'off',
        sessionCardId: String(config?.sessionCardId ?? ''),
      },
      configPath: env.configPath,
    })
    return
  }
  if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 GET / POST' }); return }
  const verdict = validateSettings(await readJsonBody(req))
  if (!verdict.ok) { json(res, 400, { ok: false, error: verdict.error }); return }
  const merged = saveConfig(verdict.patch)   // core/config.js：tmp + rename 原子写
  json(res, 200, {
    ok: true,
    data: {
      owner: { mid: merged?.owner?.mid ?? DEFAULTS.owner.mid, name: merged?.owner?.name ?? DEFAULTS.owner.name },
      risk: pickRisk(merged?.risk),
      budget: pickBudget(merged?.budget),
      sessionMode: merged?.sessionMode === 'board' ? 'board' : 'off',
      sessionCardId: String(merged?.sessionCardId ?? ''),
    },
    configPath: env.configPath,
  })
}

async function handleCredential (env, req, res) {
  if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return }
  const body = await readJsonBody(req)
  const cookie = typeof body?.cookie === 'string' ? body.cookie : ''
  if (cookie.trim() === '') { json(res, 400, { ok: false, error: 'cookie 不能为空（整段复制 SESSDATA / bili_jct / buvid3）' }); return }
  // saveCookie 解析不出东西时**抛错不落盘**（写空文件 = 把主人的登录态抹掉）。
  // 它的每条 human 都只说"缺哪个字段"，永远不带值 —— 所以这里可以原样回给界面。
  // 也**不要**把 cookie / 异常对象丢给 log：日志里出现一次就等于永久泄漏。
  let status
  try {
    status = saveCookie(cookie)
  } catch (error) {
    json(res, 400, { ok: false, error: String(error?.message ?? error) })
    return
  }
  env.deps?.log?.info?.('设置页写入了新的 cookie 凭据（内容不回显、不进日志）')
  json(res, 200, { ok: true, data: presenceOf(status) })
}

/* ────────────────────────────── 挂载 ────────────────────────────── */

/**
 * 把三条路由挂到 scoped 的 webServer 上（lib/index.js ⑥ 调用）。
 *
 * 必须挂在 scoped：cordis 卸载这个 fiber 时会连带释放路由，而宿主对重复的 (kind, path)
 * **直接 throw**。HMR 时旧 fiber 还没 dispose 新的就 apply，于是会撞上重复注册 ——
 * 那种情况静默跳过（第一个 handler 已经能服务同一路径），其它错误继续冒出去。
 *
 * @returns {Promise<string[]>} 实际注册成功的路径（测试与排障用）
 */
export async function mountSettingsRoutes (scoped, { ctx, deps } = {}) {
  const server = scoped?.webServer ?? (typeof scoped?.get === 'function' ? scoped.get('webServer') : undefined)
  if (server === undefined || server === null || typeof server.register !== 'function') return []

  // CONFIG_PATH 是 ESM live binding：setConfigPathForTest 之后这里读到的就是新路径
  const env = { ctx, deps, version: readVersion(), toolCount: await countTools(), configPath: CONFIG_PATH }

  const handlers = [
    [PATH_STATUS, (req, res) => handleStatus(env, res)],
    [PATH_SETTINGS, (req, res) => handleSettings(env, req, res)],
    [PATH_CREDENTIAL, (req, res) => handleCredential(env, req, res)],
    // 只读探测（不建会话、不调工具）：真机上回答"宿主给了我们什么"
    [PATH_PROBE, (req, res) => handleProbe(env, res)],
  ]

  const registered = []
  for (const [path, handler] of handlers) {
    try {
      server.register({ kind: 'exact', path, handler: guarded(ctx, handler) })
      registered.push(path)
    } catch (error) {
      // 只吞"重复注册"：路由表坏了之类的真故障必须冒出去
      if (!/duplicate .*route/i.test(String(error?.message ?? error))) throw error
    }
  }
  deps?.log?.debug?.('设置页路由已挂载：' + registered.join(' '))
  return registered
}

/* ────────────── 宿主能力探测（只读；2026-11-02「独立会话」可行性调研） ────────────── */

const PATH_PROBE = API + '/probe'

/** 想探的宿主工具名（只判能不能拿到，**绝不调用**）。 */
const PROBE_TOOLS = ['subagent', 'subagent_fork', 'send_message', 'task_board_create', 'task_board_run', 'squad_member_add', 'squads_run_member', 'video_understand']

/** 只读地看一眼某个宿主服务在不在（不调用任何方法）。 */
function probeService (ctx, name) {
  try {
    if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') return { present: false }
    const value = ctx.get(name)
    return value === undefined || value === null ? { present: false } : { present: true, kind: typeof value, value }
  } catch (error) {
    return { present: false, error: String(error && error.message ? error.message : error) }
  }
}

/** 列出对象自己身上的方法名（不调用、也不遍历原型链）。 */
function methodNames (value) {
  if (value === null || value === undefined) return []
  if (typeof value !== 'object' && typeof value !== 'function') return []
  try {
    return Object.keys(value).filter((k) => typeof value[k] === 'function').sort()
  } catch {
    return []
  }
}

/**
 * GET /probe：回答「宿主到底给了我们什么」这一组是非题，**纯只读**。
 *
 * 为什么要有它：想知道"能不能给她建一个独立会话"，但会话创建能力有的在服务里、
 *   有的只在别的插件的内部类里。与其猜，不如让真机自己回答一次 —— 结果直接决定走哪条路。
 * 三条纪律：① 不建会话、不发消息、不调用任何工具；
 *   ② 不返回任何凭据 / token / cookie（只回布尔与名字）；
 *   ③ 任何一步抛错都进 errors，路由仍然 200。
 */
async function handleProbe (env, res) {
  const errors = []
  const data = { tools: {}, needs: {}, services: {}, notes: [] }

  try {
    const tools = typeof env?.ctx?.get === 'function' ? env.ctx.get('tools') : undefined
    data.tools.get = typeof tools?.get === 'function'
    data.tools.list = typeof tools?.list === 'function'
    data.tools.has = typeof tools?.has === 'function'
  } catch (error) {
    data.tools = { get: false, list: false, has: false }
    errors.push('tools: ' + String(error && error.message ? error.message : error))
  }

  for (const name of PROBE_TOOLS) {
    try {
      const tools = typeof env?.ctx?.get === 'function' ? env.ctx.get('tools') : undefined
      const tool = data.tools.get === true && typeof tools?.get === 'function' ? tools.get(name) : undefined
      data.needs[name] = tool !== undefined && tool !== null
    } catch (error) {
      data.needs[name] = false
      errors.push('tools.get(' + name + '): ' + String(error && error.message ? error.message : error))
    }
  }

  for (const name of ['agents', 'workspaces']) {
    try {
      const service = probeService(env?.ctx, name)
      data.services[name] = {
        present: service.present === true,
        kind: service.kind === undefined ? null : service.kind,
        methods: service.present === true ? methodNames(service.value) : []
      }
      if (service.error !== undefined) errors.push(name + ': ' + service.error)
    } catch (error) {
      data.services[name] = { present: false, kind: null, methods: [] }
      errors.push(name + ': ' + String(error && error.message ? error.message : error))
    }
  }

  // 会话复用能力只看"有没有名字里带 session 的方法"，同样不调用
  const agentMethods = data.services.agents.methods
  const wsMethods = data.services.workspaces.methods
  data.notes.push(agentMethods.length === 0
    ? "ctx.get('agents') 拿不到：没有可直接注入的 agents 服务"
    : "ctx.get('agents') 方法：" + agentMethods.join(', '))
  data.notes.push(wsMethods.length === 0
    ? "ctx.get('workspaces') 拿不到：工作区注册表不在这条通道上"
    : "ctx.get('workspaces') 方法：" + wsMethods.join(', '))

  data.errors = errors
  json(res, 200, { ok: true, data })
}

/** 本模块注册的全部路径（测试与排障用）。放在文件末尾，避免 TDZ（PATH_PROBE 在中间才定义）。 */
export const ROUTES = Object.freeze([PATH_STATUS, PATH_SETTINGS, PATH_CREDENTIAL, PATH_PROBE])
