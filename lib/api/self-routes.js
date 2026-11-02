// 「她」—— 自主运营层的设置页后端（前缀 /dsh-bili/api/self）。
//
// 职责只有一件事：把 lib/core/{persona,schedule,state,audit,diary,autonomy}.js 的纯函数
// 包成五条同源 HTTP 路由，形状照 AUTONOMY-PROMPT §12.1。业务逻辑一行都不在这里 ——
// 判断"该不该醒""该做什么"是 brain/actions/schedule 的事，这里只负责校验、读写、回包。
//
// 为什么每个 core 模块都用**动态 import**：这一层是并行实现的，文件可能还没落盘。
// 静态 import 一个不存在的模块会让整个设置页模块加载失败 —— 那样「B站账号」那页也一起没了。
// 所以拿不到就当"自主层未就绪"（/state 回 { available:false }），界面照常能开。
//
// 为什么前缀是 /dsh-bili/api/self 而不是 /kernel/self：
//   kernel/* 是内核设置页（主人身份、token 预算、cookie），self/* 是自主层。
//   两者分开的好处是宿主重复 exact 路由的丢弃只可能发生在各自内部，不会互相顶掉。
//
// 凭据：这个文件**从不读凭据**，所以也不可能回显它。日志里也只出现路由名与错误消息。

/** 路由前缀（与客户端 lib/client.js 的 SELF_API 常量是同一份契约）。 */
const API = '/dsh-bili/api/self'
const PATH_STATE = API + '/state'
const PATH_SETTINGS = API + '/settings'
const PATH_PERSONA = API + '/persona'
const PATH_RUN_ONCE = API + '/run-once'
const PATH_AUDIT = API + '/audit'
const PATH_PROFILE = API + '/profile'
const PATH_MEMES = API + '/memes'
const PATH_MEME_REFRESH = API + '/meme-refresh'

const BODY_LIMIT = 256 * 1024          // persona 上限 20000 字符，256KB 已经够宽容
const PERSONA_MAX = 20_000

/* ────────────────────────────── core 模块（可缺失） ────────────────────────────── */

const moduleCache = new Map()

/**
 * 取一个 core 模块；文件不存在/自身抛错 → null。
 * 失败**不缓存**：另一路实现把文件写下来之后，下一次请求就自动接上（不用重启宿主）。
 */
function coreModule (name) {
  if (moduleCache.has(name)) return moduleCache.get(name)
  const promise = import('../core/' + name + '.js').catch(() => {
    moduleCache.delete(name)
    return null
  })
  moduleCache.set(name, promise)
  return promise
}

/** 安全调用一个模块函数：模块不在、函数不在、自己抛错 → undefined（调用方负责降级）。 */
async function callCore (name, fn, ...args) {
  const mod = await coreModule(name)
  if (mod === null || typeof mod[fn] !== 'function') return undefined
  try {
    return await mod[fn](...args)
  } catch {
    return undefined
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

/** 回环快速通道（Host 头是 127.0.0.1 / localhost / [::1]）。 */
function isLoopbackReq (req) {
  const host = String(req?.headers?.host ?? '').toLowerCase()
  const head = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return head === '127.0.0.1' || head === 'localhost' || head === '[::1]' || head === '::1'
}

/** 完整信任判定：回环 OR 宿主 connection.isTrusted；判定不可用 = 不可信（fail-closed）。 */
function isTrustedReq (req, ctx) {
  if (isLoopbackReq(req)) return true
  try {
    const conn = typeof ctx?.get === 'function' ? ctx.get('connection') : ctx?.connection
    if (conn !== null && conn !== undefined && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
  } catch { /* 栅栏不可用 → 下面按不可信处理 */ }
  return false
}

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

/* ────────────────────────────── 校验 ────────────────────────────── */

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** allow 通道名（顺序即界面顺序，INTERFACE/§11 的七项）。 */
const CHANNELS = ['read', 'dm', 'comment', 'reply', 'dynamic', 'like', 'follow']
/** caps 的键（read 没有上限：只读不产出内容）。 */
const CAP_KEYS = ['dm', 'comment', 'reply', 'dynamic', 'like', 'follow']
/**
 * 行为开关（校验表）：除 dmEveryWake 外**默认 true**（缺字段按 true）；dmEveryWake **默认 false**
 * （缺字段按 false）—— 它会让每次醒来都发一条私信，默认关才不会吵到主人。投影在 /state 里分开写。
 */
const BOOLEAN_SWITCHES = [
  'minWatchPerWake', 'atOwnerOnComment', 'bedtimeReport', 'dmEveryWake', 'commentAfterWatch',
  // §23：主人私信她时必定回一条 / 别人回复她的评论时她回一句
  'replyToDm', 'replyToComments',
  // §24：有人在评论区 @ 她时她回一句
  'replyToMentions',
]

/** §16：一天最多 6 个清醒时段（多了没有意义，只会把"醒着"变成"永远醒着"）。 */
const WINDOWS_MAX = 6

/** 模型路由（可选）：留空 = 交给宿主的默认路由（core/brain.js 用 ctx.llm.stream）。 */
const LLM_KEYS = ['llmProvider', 'llmModel']
const LLM_MAX = 120
/** 六项指标（顺序即界面顺序，与 core/metrics.js 的 METRIC_KEYS 一致）。 */
const METRIC_KEYS = ['energy', 'mood', 'curiosity', 'affinity', 'boredom', 'confidence']

/** HH:MM；end 额外允许 24:00（§11 的默认窗口就是 20:00–24:00）。 */
function isClock (value, { allow24 = false } = {}) {
  if (typeof value !== 'string') return false
  const matched = /^(\d{2}):(\d{2})$/.exec(value.trim())
  if (matched === null) return false
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  if (minute > 59) return false
  if (allow24 && hour === 24 && minute === 0) return true
  return hour >= 0 && hour <= 23
}

function toCount (raw, min, max) {
  if (typeof raw === 'number') return Number.isFinite(raw) && Number.isInteger(raw) && raw >= min && raw <= max ? raw : null
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const value = Number(raw.trim())
    return value >= min && value <= max ? value : null
  }
  return null
}

/**
 * 部分更新校验：只认 §11 那六个字段 + 两个模型路由字段，其余丢弃（客户端多送一个字段不该让保存失败）。
 * 类型不对**报错**（静默吞掉 = 用户以为存上了）。
 * @returns {{ ok: true, patch: object } | { ok: false, error: string }}
 */
function validateSettings (incoming) {
  if (!isPlain(incoming)) return { ok: false, error: '请求体必须是对象' }
  const body = isPlain(incoming.settings) ? incoming.settings : incoming
  const problems = []
  const patch = {}

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') problems.push('enabled 必须是布尔值')
    else patch.enabled = body.enabled
  }

  if (body.allows !== undefined) {
    if (!isPlain(body.allows)) {
      problems.push('allows 必须是对象')
    } else {
      const allows = {}
      for (const key of CHANNELS) {
        const raw = body.allows[key]
        if (raw === undefined) continue
        if (typeof raw !== 'boolean') { problems.push('allows.' + key + ' 必须是布尔值，收到 ' + JSON.stringify(raw)); continue }
        allows[key] = raw
      }
      if (Object.keys(allows).length > 0) patch.allows = allows
    }
  }

  if (body.window !== undefined) {
    if (!isPlain(body.window)) {
      problems.push('window 必须是对象（{ start, end }）')
    } else {
      const window = {}
      if (body.window.start !== undefined) {
        if (!isClock(body.window.start)) problems.push('window.start 必须是 HH:MM（00:00–23:59），收到 ' + JSON.stringify(body.window.start))
        else window.start = String(body.window.start).trim()
      }
      if (body.window.end !== undefined) {
        if (!isClock(body.window.end, { allow24: true })) problems.push('window.end 必须是 HH:MM（00:00–24:00），收到 ' + JSON.stringify(body.window.end))
        else window.end = String(body.window.end).trim()
      }
      if (Object.keys(window).length > 0) patch.window = window
    }
  }


  // §16：多个时段 + 周末全天。跨午夜（start > end）是合法的，**只有 start === end 才拒**。
  if (body.windows !== undefined) {
    if (!Array.isArray(body.windows)) {
      problems.push('windows 必须是数组（1–6 个时段）')
    } else if (body.windows.length < 1 || body.windows.length > WINDOWS_MAX) {
      problems.push('windows 必须有 1–' + WINDOWS_MAX + ' 个时段，收到 ' + body.windows.length)
    } else {
      const windows = []
      let bad = false
      for (let i = 0; i < body.windows.length; i += 1) {
        const raw = body.windows[i]
        if (!isPlain(raw)) { problems.push('windows[' + i + '] 必须是 { start, end }'); bad = true; break }
        if (!isClock(raw.start)) { problems.push('windows[' + i + '].start 必须是 HH:MM（00:00–23:59），收到 ' + JSON.stringify(raw.start)); bad = true; break }
        if (!isClock(raw.end, { allow24: true })) { problems.push('windows[' + i + '].end 必须是 HH:MM（00:00–24:00），收到 ' + JSON.stringify(raw.end)); bad = true; break }
        const start = String(raw.start).trim()
        const end = String(raw.end).trim()
        if (start === end) { problems.push('windows[' + i + '] 的起止不能相同（' + start + '）'); bad = true; break }
        windows.push({ start, end })
      }
      if (!bad) patch.windows = windows
    }
  }

  if (body.weekendAllDay !== undefined) {
    if (typeof body.weekendAllDay !== 'boolean') problems.push('weekendAllDay 必须是布尔值，收到 ' + JSON.stringify(body.weekendAllDay))
    else patch.weekendAllDay = body.weekendAllDay
  }

  if (body.weekendIntervalMin !== undefined) {
    const value = toCount(body.weekendIntervalMin, 5, 720)
    if (value === null) problems.push('weekendIntervalMin 必须是 5–720 的整数（分钟），收到 ' + JSON.stringify(body.weekendIntervalMin))
    else patch.weekendIntervalMin = value
  }

  // §18.3 / §20：三个行为开关，都必须是布尔（默认 true）
  for (const key of BOOLEAN_SWITCHES) {
    if (body[key] === undefined) continue
    if (typeof body[key] !== 'boolean') { problems.push(key + ' 必须是布尔值，收到 ' + JSON.stringify(body[key])); continue }
    patch[key] = body[key]
  }

  // 上下界与 core/schedule.js 的 clamp 完全一致：那边是 5–720 分钟、抖动 0–0.5。
  // 如果我们这边宽、那边严，用户会看到"保存失败"却不知道是哪一层拒的。
  if (body.intervalMin !== undefined) {
    const value = toCount(body.intervalMin, 5, 720)
    if (value === null) problems.push('intervalMin 必须是 5–720 的整数（分钟），收到 ' + JSON.stringify(body.intervalMin))
    else patch.intervalMin = value
  }

  if (body.jitter !== undefined) {
    const value = Number(body.jitter)
    if (!Number.isFinite(value) || value < 0 || value > 0.5) problems.push('jitter 必须是 0–0.5 之间的小数，收到 ' + JSON.stringify(body.jitter))
    else patch.jitter = value
  }

  if (body.caps !== undefined) {
    if (!isPlain(body.caps)) {
      problems.push('caps 必须是对象')
    } else {
      const caps = {}
      for (const key of CAP_KEYS) {
        const raw = body.caps[key]
        if (raw === undefined) continue
        const value = toCount(raw, 0, 1000)
        // null = 不限（§17）。0 是"禁止"，与"不限"必须能区分 —— 所以这里不能把 null 折成 0。
        if (raw === null) { caps[key] = null; continue }
        if (value === null) { problems.push('caps.' + key + ' 必须是 null（不限）或 0–1000 的整数，收到 ' + JSON.stringify(raw)); continue }
        caps[key] = value
      }
      if (Object.keys(caps).length > 0) patch.caps = caps
    }
  }

  // 模型路由：空串**是合法值**（= 回到宿主默认路由），所以不能套用"空值即拒绝"的那套 ——
  // 这与 owner.mid 正好相反：那个空值危险（写通道失去收件人），这个空值就是默认。
  for (const key of LLM_KEYS) {
    if (body[key] === undefined) continue
    const raw = body[key]
    if (typeof raw !== 'string') {
      problems.push(key + ' 必须是字符串（留空表示用宿主默认路由），收到 ' + JSON.stringify(raw))
      continue
    }
    const text = raw.trim()
    if (text.length > LLM_MAX) {
      problems.push(key + ' 最多 ' + LLM_MAX + ' 个字符（留空表示用宿主默认路由），收到 ' + text.length)
      continue
    }
    patch[key] = text
  }

  if (problems.length > 0) return { ok: false, error: problems.join('；') }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: '没有任何可写字段（只认 enabled / allows / window / intervalMin / jitter / caps / llmProvider / llmModel）' }
  }
  return { ok: true, patch }
}

/** 把 core 里可能缺失的字段补成界面能直接渲染的形状。 */
const DEFAULT_WINDOW = { start: '20:00', end: '24:00' }
const DEFAULT_ALLOWS = { read: true, dm: true, comment: false, reply: false, dynamic: false, like: false, follow: false }
// §17.1：除「发动态每天 2 条」外，其余通道默认**不限**（null）。0 表示禁止，不能拿来当哨兵。
const DEFAULT_CAPS = { dm: null, comment: null, reply: null, dynamic: 2, like: null, follow: null }

function fillAllows (value) {
  const src = isPlain(value) ? value : {}
  const out = {}
  for (const key of CHANNELS) out[key] = typeof src[key] === 'boolean' ? src[key] : DEFAULT_ALLOWS[key]
  return out
}

function fillCaps (value) {
  const src = isPlain(value) ? value : {}
  const out = {}
  const norm = (raw) => {
    // null / 缺省 = 不限，回 null（**不转 0、不省略**）；数字照原样回整数。
    if (raw === null || raw === undefined) return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.floor(n) : null
  }
  // 先把 core 给的所有键原样规整过来（例如 §18 新增的 read 计数通道），
  // 再补齐六个写通道 —— "原样回 caps" 就是这个意思：不认识的新键也不要吃掉。
  for (const key of Object.keys(src)) out[key] = norm(src[key])
  for (const key of CAP_KEYS) if (!(key in out)) out[key] = norm(undefined)
  return out
}

/* ────────────────────────────── 五条路由 ────────────────────────────── */

/**
 * GET /state —— 一屏现状。
 *
 * core/schedule.js 或 core/metrics.js 不在 = 自主层未就绪 → { available:false }（200，不是错误：
 * "没装"和"装坏了"要分开呈现，界面靠 available 决定要不要禁用按钮）。
 * 为什么 metrics 也算进"就绪"：core/autonomy.js 自己就 import 它，缺了它连 tick 都跑不起来 ——
 * 那种状态下让界面显示一堆可点的开关，才是真的误导。
 */
async function handleState (env, res) {
  const schedule = await coreModule('schedule')
  const metricsMod = await coreModule('metrics')
  if (schedule === null || metricsMod === null) {
    const missing = []
    if (schedule === null) missing.push('core/schedule.js')
    if (metricsMod === null) missing.push('core/metrics.js')
    json(res, 200, { ok: true, data: { available: false, reason: '自主层未就绪（' + missing.join(' 与 ') + ' 还没落盘）' } })
    return
  }
  const config = env.deps?.config ?? {}
  const settings = (await callCore('schedule', 'loadSchedule', config)) ?? {}
  // 老 core 只给 window（没有 windows）：按单项数组回退，界面永远拿到统一形状。
  const windows = (() => {
    const list = Array.isArray(settings?.windows) ? settings.windows : null
    if (list !== null && list.length > 0) {
      return list.map((item) => ({
        start: typeof item?.start === 'string' ? item.start : DEFAULT_WINDOW.start,
        end: typeof item?.end === 'string' ? item.end : DEFAULT_WINDOW.end,
      }))
    }
    if (isPlain(settings?.window)) {
      return [{ start: settings.window.start ?? DEFAULT_WINDOW.start, end: settings.window.end ?? DEFAULT_WINDOW.end }]
    }
    return [{ ...DEFAULT_WINDOW }]
  })()
  const state = (await callCore('state', 'readState')) ?? {}
  const nextWakeAt = (await callCore('schedule', 'nextWakeAt')) ?? null
  const todayCounts = (await callCore('schedule', 'countsToday')) ?? null
  const auditTail = (await callCore('audit', 'readAudit', 20)) ?? []
  const diaryToday = (await callCore('diary', 'todayDiary', 10)) ?? null

  // 指标：优先用 autonomy.snapshot()（它就是给设置页准备的一屏快照，metrics 与 behavior 一起给）；
  // 快照不可用（autonomy 还没落盘）就退到 metrics 模块自己算 —— 但**绝不编默认值**：
  // 拿不到就是 null，界面显示「指标未就绪」，而不是显示一组看着像真的假数字。
  const snapshot = await callCore('autonomy', 'snapshot')
  const rawMetrics = isPlain(snapshot) && isPlain(snapshot.metrics) ? snapshot.metrics : null
  const metrics = rawMetrics ?? (await callCore('metrics', 'readMetrics')) ?? null
  const behavior = isPlain(snapshot) && isPlain(snapshot.behavior) ? snapshot.behavior : (await callCore('metrics', 'behaviorHints')) ?? null
  const recentRaw = await callCore('metrics', 'recentChanges', 5)
  const metricsRecent = Array.isArray(recentRaw) ? recentRaw.map((entry) => ({
    at: typeof entry?.at === 'string' ? entry.at : null,
    event: typeof entry?.event === 'string' ? entry.event : '',
    changes: Array.isArray(entry?.changes)
      ? entry.changes.map((change) => ({ key: String(change?.key ?? ''), delta: Number(change?.delta ?? 0) })).filter((change) => change.key !== '')
      : [],
  })) : null

  json(res, 200, {
    ok: true,
    data: {
      available: true,
      enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : true,
      allows: fillAllows(settings?.allows),
      windows,
      // 旧字段：恒等于 windows[0]（§16.1 要求写盘时同时保留 window，旧读取方不会炸）
      window: windows[0],
      weekendAllDay: settings?.weekendAllDay === true,
      // 前三个默认开：老 core 没有这些字段 → 按 true 处理
      minWatchPerWake: settings?.minWatchPerWake !== false,
      atOwnerOnComment: settings?.atOwnerOnComment !== false,
      bedtimeReport: settings?.bedtimeReport !== false,
      commentAfterWatch: settings?.commentAfterWatch !== false,
      replyToDm: settings?.replyToDm !== false,
      replyToComments: settings?.replyToComments !== false,
      replyToMentions: settings?.replyToMentions !== false,
      // 这个默认关（缺字段 = false）：每醒一次发一条私信，默认开太吵
      dmEveryWake: settings?.dmEveryWake === true,
      weekendIntervalMin: Number.isFinite(Number(settings?.weekendIntervalMin)) ? Number(settings.weekendIntervalMin) : 90,
      intervalMin: Number.isFinite(Number(settings?.intervalMin)) ? Number(settings.intervalMin) : 45,
      jitter: Number.isFinite(Number(settings?.jitter)) ? Number(settings.jitter) : 0.2,
      caps: fillCaps(settings?.caps),
      mood: typeof state?.mood === 'string' ? state.mood : null,
      lastLine: typeof state?.lastLine === 'string' ? state.lastLine : null,
      lastWakeAt: state?.lastWakeAt ?? null,
      nextWakeAt,
      todayCounts: isPlain(todayCounts) ? todayCounts : { dm: 0, comment: 0, reply: 0, dynamic: 0, like: 0, follow: 0 },
      metrics: isPlain(metrics) ? METRIC_KEYS.reduce((out, key) => { const n = Number(metrics[key]); out[key] = Number.isFinite(n) ? Math.round(n) : null; return out }, {}) : null,
      behavior,
      metricsRecent,
      llmProvider: typeof settings?.llmProvider === 'string' ? settings.llmProvider : '',
      llmModel: typeof settings?.llmModel === 'string' ? settings.llmModel : '',
      auditTail: Array.isArray(auditTail) ? auditTail : [],
      diaryToday: typeof diaryToday === 'string' ? diaryToday : (Array.isArray(diaryToday) ? diaryToday.join('\n') : ''),
    },
  })
}

/** POST /settings —— 部分更新；原子写由 core/schedule.js 负责。 */
async function handleSettings (env, req, res) {
  // GET = 读现状（caps 里的 null 原样回，不转 0 也不省略）；POST = 部分更新。
  if (req.method === 'GET') {
    const current = (await callCore('schedule', 'loadSchedule', env.deps?.config ?? {})) ?? undefined
    if (current === undefined) { json(res, 503, { ok: false, error: '自主层未就绪（core/schedule.js 不可用）' }); return }
    json(res, 200, { ok: true, data: { settings: isPlain(current) ? current : null } })
    return
  }
  if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 GET / POST' }); return }
  const verdict = validateSettings(await readJsonBody(req))
  if (verdict.ok !== true) { json(res, 400, { ok: false, error: verdict.error }); return }
  const saved = await callCore('schedule', 'saveSchedule', verdict.patch)
  if (saved === undefined) {
    json(res, 503, { ok: false, error: '自主层未就绪（core/schedule.js 不可用）' })
    return
  }
  // core 的返回是 { ok:true, schedule } | { ok:false, error }：它自己的白名单/边界也会拒，
  // 那同样是 400 —— 不能让界面看到"200 + 什么都没变"。
  if (isPlain(saved) && saved.ok === false) {
    json(res, 400, { ok: false, error: String(saved.error ?? '日程校验未通过') })
    return
  }
  json(res, 200, {
    ok: true,
    data: {
      saved: verdict.patch,
      settings: isPlain(saved) && isPlain(saved.schedule) ? saved.schedule : null,
    },
  })
}

/** 结构化人设的字段名（与 core/persona.js 的 parseSections 输出键一致）。 */
const PERSONA_LIST_KEYS = ['personality', 'interests', 'dislikes', 'phrases', 'boundaries']
const PERSONA_LISTS = PERSONA_LIST_KEYS.concat(['tagline'])
const PERSONA_ITEM_MAX = 200
const PERSONA_ITEMS_MAX = 40

/** 把 core 的 parseSections 输出抹成界面要的固定形状（缺项给空，不编内容）。 */
function normalizeSections (raw) {
  const src = isPlain(raw) ? raw : {}
  const out = { tagline: typeof src.tagline === 'string' ? src.tagline : '' }
  for (const key of PERSONA_LIST_KEYS) {
    out[key] = Array.isArray(src[key]) ? src[key].map((item) => String(item)).filter((item) => item.trim() !== '') : []
  }
  return out
}

/**
 * 校验结构化补丁（§15.1/§15.2）：只认六个节，其余丢弃。
 * tagline ≤200 字；列表 ≤40 项 × 每项 ≤200 字。超限 → 报错（不静默截断：
 * 截断的后果是用户以为存上了，而内容悄悄少了）。
 */
function validateSections (incoming) {
  if (!isPlain(incoming)) return { ok: false, error: 'sections 必须是对象' }
  const problems = []
  const patch = {}
  // 不可写的键（如只读的 notes）**不报错**：请求体是合法的，只是没有可写的节。
  // 丢掉的键要回给调用方（dropped），否则"发了却没生效"只能靠猜。
  const dropped = Object.keys(incoming).filter((key) => key !== 'tagline' && !PERSONA_LIST_KEYS.includes(key))
  if (incoming.tagline !== undefined) {
    if (typeof incoming.tagline !== 'string') problems.push('tagline（一句话）必须是字符串')
    else if (incoming.tagline.length > PERSONA_ITEM_MAX) problems.push('tagline（一句话）最多 ' + PERSONA_ITEM_MAX + ' 个字符，收到 ' + incoming.tagline.length)
    else patch.tagline = incoming.tagline
  }
  for (const key of PERSONA_LIST_KEYS) {
    const raw = incoming[key]
    if (raw === undefined) continue
    if (!Array.isArray(raw)) { problems.push(key + ' 必须是数组（一行一项）'); continue }
    const items = []
    let bad = false
    for (const item of raw) {
      if (typeof item !== 'string') { problems.push(key + ' 的每一项都必须是字符串'); bad = true; break }
      const text = item.trim()
      if (text === '') continue
      if (text.length > PERSONA_ITEM_MAX) { problems.push(key + ' 的每一项最多 ' + PERSONA_ITEM_MAX + ' 个字符，收到 ' + text.length); bad = true; break }
      items.push(text)
    }
    if (bad) continue
    if (items.length > PERSONA_ITEMS_MAX) { problems.push(key + ' 最多 ' + PERSONA_ITEMS_MAX + ' 项，收到 ' + items.length); continue }
    patch[key] = items
  }
  if (problems.length > 0) return { ok: false, error: problems.join('；') }
  // 就算 patch 是空的也返回 ok —— 那是幂等 no-op（200 + changed:[] + dropped），不是客户端错误。
  return { ok: true, patch, dropped }
}

/**
 * GET/POST /persona —— 结构化人设（§15）。
 *
 * GET 同时回 sections（界面用的结构化字段）与 text（整篇原文，**只给排障**，界面不显示）；
 * POST 兼容两种 body：老形状 { text }（整篇覆盖）与新形状 { sections: {...} }（只改出现的节）。
 *
 * core/persona.js 还没有 parseSections/writeSections 时怎么降级：
 *   GET 只回 text（available:false），POST 只认老形状 —— 老版本 core 上设置页仍可用，
 *   只是没有结构化编辑。绝不让整页崩。
 */
async function handlePersona (env, req, res) {
  if (req.method === 'GET') {
    const text = await callCore('persona', 'readPersona')
    const path = await callCore('persona', 'personaPath')
    const parsed = await callCore('persona', 'parseSections')
    if (text === undefined && path === undefined && parsed === undefined) {
      json(res, 503, { ok: false, error: '自主层未就绪（core/persona.js 不可用）' })
      return
    }
    json(res, 200, {
      ok: true,
      data: {
        available: isPlain(parsed),
        sections: isPlain(parsed) ? normalizeSections(parsed) : null,
        notes: isPlain(parsed) && typeof parsed.notes === 'string' ? parsed.notes : '',
        text: typeof text === 'string' ? text : '',
        path: typeof path === 'string' ? path : null,
      },
    })
    return
  }
  if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 GET / POST' }); return }
  const body = await readJsonBody(req)

  // 新形状：结构化补丁（只提交改动过的节）
  if (body?.sections !== undefined) {
    const verdict = validateSections(body.sections)
    if (verdict.ok !== true) { json(res, 400, { ok: false, error: verdict.error }); return }
    // 一个可写节都没有（例如只发了只读的 notes）→ 幂等 no-op：200 + changed:[] + dropped。
    // **不写盘**（连一次 writeSections 都不调，"没改"就该真的没动文件）。
    if (Object.keys(verdict.patch).length === 0) {
      const currentParsed = await callCore('persona', 'parseSections')
      json(res, 200, {
        ok: true,
        data: {
          changed: [],
          dropped: verdict.dropped,
          sections: isPlain(currentParsed) ? normalizeSections(currentParsed) : null,
          notes: isPlain(currentParsed) && typeof currentParsed.notes === 'string' ? currentParsed.notes : '',
        },
      })
      return
    }
    const result = await callCore('persona', 'writeSections', verdict.patch)
    if (result === undefined) {
      json(res, 503, { ok: false, error: '自主层未就绪（core/persona.js 的 writeSections 不可用）' })
      return
    }
    if (isPlain(result) && result.ok === false) { json(res, 400, { ok: false, error: String(result.error ?? '人设校验未通过') }); return }
    const changed = isPlain(result) && Array.isArray(result.changed) ? result.changed.map((key) => String(key)) : Object.keys(verdict.patch)
    const parsed = await callCore('persona', 'parseSections')
    env.deps?.log?.info?.('设置页按节保存了人设（只改：' + changed.join('、') + '）')
    json(res, 200, {
      ok: true,
      data: {
        changed,
        dropped: verdict.dropped,
        sections: isPlain(parsed) ? normalizeSections(parsed) : null,
        notes: isPlain(parsed) && typeof parsed.notes === 'string' ? parsed.notes : '',
      },
    })
    return
  }

  // 老形状：整篇覆盖（保留兼容，界面上已经没有入口）
  if (typeof body?.text !== 'string') { json(res, 400, { ok: false, error: 'text 必须是字符串（或改用 { sections: {...} }）' }); return }
  if (body.text.length > PERSONA_MAX) {
    json(res, 400, { ok: false, error: '人设最多 ' + PERSONA_MAX + ' 个字符，收到 ' + body.text.length })
    return
  }
  const result = await callCore('persona', 'writePersona', body.text)
  if (result === undefined) { json(res, 503, { ok: false, error: '自主层未就绪（core/persona.js 不可用）' }); return }
  const path = isPlain(result) && typeof result.path === 'string' ? result.path : (await callCore('persona', 'personaPath')) ?? null
  env.deps?.log?.info?.('设置页保存了整篇人设（' + body.text.length + ' 字符）')
  json(res, 200, { ok: true, data: { path, length: body.text.length, changed: ['text'] } })
}

/**
 * POST /run-once —— 立刻醒一次。
 *
 * **立即返回** accepted:true：一次运行最长 90 秒，让它同步等就把设置页的请求拖死。
 * 结果由 core/autonomy.js 写进审计，界面靠 /state 的 auditTail 看到。
 * 已经有一次在跑 → 409（这里用本模块的在飞标志做第一道闸，core 自己的单飞锁是第二道）。
 */
let inFlight = false

async function handleRunOnce (env, req, res) {
  if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return }
  const autonomy = await coreModule('autonomy')
  if (autonomy === null || typeof autonomy.runOnce !== 'function') {
    json(res, 503, { ok: false, error: '自主层未就绪' })
    return
  }
  if (inFlight === true) { json(res, 409, { ok: false, error: '已经醒着（上一次还没跑完）' }); return }
  inFlight = true
  // 故意不 await：路由立刻回包，跑完由审计留痕
  Promise.resolve()
    .then(() => autonomy.runOnce('manual'))
    .catch((error) => env.deps?.log?.warn?.('手动唤醒失败：' + String(error?.message ?? error)))
    .finally(() => { inFlight = false })
  json(res, 200, { ok: true, data: { accepted: true, trigger: 'manual' } })
}

/** GET /audit?limit=50 */
async function handleAudit (env, req, res) {
  if (req.method !== 'GET') { json(res, 405, { ok: false, error: '只支持 GET' }); return }
  const limit = toCount(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('limit') ?? '50', 1, 500) ?? 50
  const entries = await callCore('audit', 'readAudit', limit)
  if (entries === undefined) {
    json(res, 200, { ok: true, data: { available: false, limit, entries: [] } })
    return
  }
  json(res, 200, { ok: true, data: { available: true, limit, entries: Array.isArray(entries) ? entries : [] } })
}


/** 身份字段的默认值（core/persona.js 缺席时界面也有东西可显示）。 */
const DEFAULT_PROFILE = Object.freeze({ name: '赛博友人', ownerTitle: '主人' })
const PROFILE_MAX = 20

/**
 * GET/POST /profile —— 人设 front-matter 的两行（§14.1）。
 * 只改 front-matter、正文一个字节不动：那是 core/persona.js writeProfile 的职责，这里只校验与转接。
 */
async function handleProfile (env, req, res) {
  if (req.method === 'GET') {
    const profile = await callCore('persona', 'readProfile')
    if (!isPlain(profile)) {
      // 模块还没落盘：给默认值 + available:false —— 界面照常能画，但保存会 503
      json(res, 200, { ok: true, data: { ...DEFAULT_PROFILE, available: false } })
      return
    }
    json(res, 200, {
      ok: true,
      data: {
        available: true,
        name: typeof profile.name === 'string' && profile.name !== '' ? profile.name : DEFAULT_PROFILE.name,
        ownerTitle: typeof profile.ownerTitle === 'string' && profile.ownerTitle !== '' ? profile.ownerTitle : DEFAULT_PROFILE.ownerTitle,
      },
    })
    return
  }
  if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 GET / POST' }); return }
  const body = await readJsonBody(req)
  const problems = []
  const patch = {}
  for (const key of ['name', 'ownerTitle']) {
    if (body?.[key] === undefined) continue
    if (typeof body[key] !== 'string') { problems.push(key + ' 必须是字符串'); continue }
    const text = body[key].trim()
    if (text === '') { problems.push(key + ' 不能为空（她的名字 / 你对她的称呼都要有个字）'); continue }
    if (text.length > PROFILE_MAX) { problems.push(key + ' 最多 ' + PROFILE_MAX + ' 个字符，收到 ' + text.length); continue }
    patch[key] = text
  }
  if (problems.length > 0) { json(res, 400, { ok: false, error: problems.join('；') }); return }
  if (Object.keys(patch).length === 0) { json(res, 400, { ok: false, error: '没有任何可写字段（只认 name / ownerTitle）' }); return }
  const saved = await callCore('persona', 'writeProfile', patch)
  if (saved === undefined) { json(res, 503, { ok: false, error: '自主层未就绪（core/persona.js 的 writeProfile 不可用）' }); return }
  if (isPlain(saved) && saved.ok === false) { json(res, 400, { ok: false, error: String(saved.error ?? '身份字段校验未通过') }); return }
  env.deps?.log?.info?.('设置页保存了身份字段（name / ownerTitle）')
  json(res, 200, { ok: true, data: { saved: patch, profile: isPlain(saved) && isPlain(saved.profile) ? saved.profile : null } })
}

const MEMES_TOP = 10
const DAY_MS = 24 * 60 * 60 * 1000

/** 读热梗库并抹成界面要的形状（§14.3）。模块缺席 → available:false，页面其余部分不受影响。 */
async function readMemesView () {
  // core 里这个函数叫 loadMemes；readMemes 只是老命名的兜底（两边都试一次，不猜）。
  const raw = (await callCore('memes', 'loadMemes')) ?? (await callCore('memes', 'readMemes'))
  if (!isPlain(raw)) return { available: false }
  const items = Array.isArray(raw.items) ? raw.items : []
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null
  const updatedMs = updatedAt === null ? NaN : Date.parse(updatedAt)
  const staleDays = Number.isFinite(updatedMs) ? Math.max(0, Math.floor((Date.now() - updatedMs) / DAY_MS)) : null
  return {
    available: true,
    updatedAt,
    staleDays,
    source: ['web_search', 'llm', 'unavailable'].includes(raw.source) ? raw.source : 'unavailable',
    stage: raw.stage === 'stale' ? 'stale' : 'fresh',
    count: items.length,
    items: items.slice(0, MEMES_TOP).map((item) => ({
      meme: String(item?.meme ?? ''),
      meaning: String(item?.meaning ?? ''),
      seen: Number.isFinite(Number(item?.seen)) ? Number(item.seen) : 0,
    })),
  }
}

/** GET /memes —— 热梗库现状（只读）。 */
async function handleMemes (env, req, res) {
  if (req.method !== 'GET') { json(res, 405, { ok: false, error: '只支持 GET' }); return }
  json(res, 200, { ok: true, data: await readMemesView() })
}

/** 刷新结果 → 一句人话（core 用 reason 表达"今天已经试过了"之类）。 */
function refreshErrorText (result, ok) {
  if (ok === true) return null
  if (isPlain(result) && typeof result.error === 'string' && result.error !== '') return result.error
  if (isPlain(result) && typeof result.reason === 'string' && result.reason !== '') {
    if (result.reason === 'daily-limit') return '今天已经尝试过一次刷新了（一天最多一次，明天再来）'
    return result.reason
  }
  return '刷新失败'
}

/** 刷新进行中的标志（30 秒内重复点击 → 409）。 */
let memeRefreshing = false
const MEME_REFRESH_TIMEOUT_MS = 30_000

/**
 * POST /meme-refresh —— 立刻刷新一次热梗库。
 *
 * 30 秒硬上限：刷新要么联网搜索、要么调模型，不设上限就会把设置页的请求挂死。
 * 超时后仍保持"进行中"直到那个 promise 自己结束：宁可让人等，也不并发打两次搜索。
 */
async function handleMemeRefresh (env, req, res) {
  if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return }
  const memes = await coreModule('memes')
  if (memes === null || typeof memes.refreshMemes !== 'function') {
    json(res, 503, { ok: false, error: '热梗库未就绪（core/memes.js 不可用）' })
    return
  }
  if (memeRefreshing === true) { json(res, 409, { ok: false, error: '正在刷新（上一次还没结束）' }); return }
  memeRefreshing = true
  let timer = null
  try {
    const result = await Promise.race([
      // core/memes.js 的签名是 refreshMemes({ llm, tools, ctx })：它要拿宿主的 web_search 与 llm。
      // 从 cordis 上下文里按同名取 —— 缺了它会自己退化成 llm 兜底，不会伪造 web_search 来源。
      Promise.resolve(memes.refreshMemes({ llm: env.ctx?.llm, tools: env.ctx?.tools, ctx: env.ctx })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: '刷新超时（30 秒）' }), MEME_REFRESH_TIMEOUT_MS) }),
    ])
    const view = await readMemesView()
    const ok = isPlain(result) ? result.ok !== false : true
    json(res, 200, {
      ok: true,
      data: {
        ok,
        source: view.available ? view.source : 'unavailable',
        count: view.available ? view.count : 0,
        error: refreshErrorText(result, ok),
      },
    })
  } catch (error) {
    json(res, 200, { ok: true, data: { ok: false, source: 'unavailable', count: 0, error: String(error?.message ?? error) } })
  } finally {
    if (timer !== null) clearTimeout(timer)
    memeRefreshing = false
  }
}

/* ────────────────────────────── 挂载 ────────────────────────────── */

/**
 * 挂五条路由（入口由 lib/index.js 调用；与 settings-api 的 mountSettingsRoutes 同签名）。
 * 宿主对重复 (kind, path) 会 throw，HMR 撞上就静默跳过 —— 第一个 handler 已经在服务同一路径。
 * @returns {Promise<string[]>} 实际注册成功的路径
 */
export async function mountSelfRoutes (scoped, { ctx, deps } = {}) {
  const server = scoped?.webServer ?? (typeof scoped?.get === 'function' ? scoped.get('webServer') : undefined)
  if (server === undefined || server === null || typeof server.register !== 'function') return []

  const env = { ctx, deps }
  const handlers = [
    [PATH_STATE, (req, res) => handleState(env, res)],
    [PATH_SETTINGS, (req, res) => handleSettings(env, req, res)],
    [PATH_PERSONA, (req, res) => handlePersona(env, req, res)],
    [PATH_RUN_ONCE, (req, res) => handleRunOnce(env, req, res)],
    [PATH_AUDIT, (req, res) => handleAudit(env, req, res)],
    [PATH_PROFILE, (req, res) => handleProfile(env, req, res)],
    [PATH_MEMES, (req, res) => handleMemes(env, req, res)],
    [PATH_MEME_REFRESH, (req, res) => handleMemeRefresh(env, req, res)],
  ]

  const registered = []
  for (const [path, handler] of handlers) {
    try {
      server.register({ kind: 'exact', path, handler: guarded(ctx, handler) })
      registered.push(path)
    } catch (error) {
      // 只吞"重复注册"：真故障必须冒出去
      if (!/duplicate .*route/i.test(String(error?.message ?? error))) throw error
    }
  }
  deps?.log?.debug?.('自主层设置页路由已挂载：' + registered.join(' '))
  return registered
}

/** 别名：入口那边叫 mountRoutes 也能用（两种命名都出现过，别让挂载因为名字失败）。 */
export const mountRoutes = mountSelfRoutes

/** 测试用：路由表（只读副本）。 */
export const ROUTES = Object.freeze([PATH_STATE, PATH_SETTINGS, PATH_PERSONA, PATH_RUN_ONCE, PATH_AUDIT, PATH_PROFILE, PATH_MEMES, PATH_MEME_REFRESH])
