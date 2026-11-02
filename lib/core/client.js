// B站 HTTP 客户端：签名 / 缓存 / 退避 / 节流全部复用 vendor 里的实现，这里只做装配与补缺。
//
// 为什么 GET 直接转给 vendor 的 apiGet：
//   WBI 签名、24 小时缓存、指数退避、300ms 节流、缓存 400 条上限 —— 那套代码是真实账号上
//   撞过 412 才调出来的（B站 的 412 是 IP 级限流，换接口救不了）。重写一遍是纯粹的退步。
//
// 为什么 POST 必须自己写：
//   apiGet 只发 GET（签名/缓存都是给元信息用的），而写操作要的是"csrf=bili_jct + 凭据 header
//   + 节流 + 412/429 熔断 + 风控码熔断"。所以 POST 走 vendor 的 guardedFetch（它负责节流、
//   预算、冷却、相同写操作去重、412/429 后的暂停），本文件补三件事：
//     ① 带上凭据与 csrf，缺凭据就**不发请求**（省掉那一次注定 code=-111 的往返）
//     ② 撞到 412/429 或风控码时写同一份 api-ban.json —— 让**读**那边也立刻退（风控是账号级的）
//     ③ 300ms 地板间隔（guard 的 minGapMs 已经更大，这里只是不让"配置被改成 0"时裸奔）
//
// 为什么要写 api-ban.json 而不是自己另开一个状态文件：
//   §1.4 的硬要求：熔断必须共享。读路径由 vendor 的 apiGet 读这份文件，
//   写路径（本文件）也必须落到同一份，否则会出现"评论还在发、视频却读不了"的分裂状态。
//   注意 vendor 里那次写入是私有的，且规定"其余逻辑一行都不许改"，
//   所以这里按**完全相同的字段形状**（until / why / at / streak）自己写一份。
//
// 为什么每次都同步状态目录（ensure()）：
//   设置页可以把 paths.stateDir 改掉，测试会把 DSH_BILI_STATE_DIR 指到临时目录。
//   目录换了还往旧目录写，症状是"熔断看着是空的、然后继续撞"。所以每个请求前对齐一次。
//
// raw() 的三种请求体（api 层的实际用法，INTERFACE §5 只写了"json=false 取二进制"那一半）：
//   { json: { … } }        → 发 JSON 体（动态 create / edit / set_top 这类端点），并补 csrf
//   { form: { … } }        → 发 form-urlencoded 体（私信 send_msg），并补 csrf
//   { form: FormData }     → 原样发 multipart（传图 upload_bfs），**不许自己设 content-type**，
//                            否则 boundary 没了，B站 只会回一个参数错误
//   { binary: true }（或旧写法 json:false） → 相反方向的意思：响应按二进制返回 { ok, status, buffer }
//   响应形状照 api 层的实际契约：**是 JSON 就原样返回 B站 对象 { code, message, data }**，
//   不是 JSON（或明确要二进制）才返回 { ok, status, buffer }。
//   为什么原样返回而不是包一层 { ok, status, data }：api 层的 unwrapRaw 认的就是 B站 那个形状，
//   包一层等于让每个端点各判一次"里面到底是哪一层"，包错一次就是"发成功却报网络失败"。
//
//   跨域名：私信走 api.vc.bilibili.com、头像走 a1.bilibili.com —— 绝对 URL 进来就不要再拼 base，
//   但节流 / 熔断 / 凭据 header 一样要过（否则写通道等于绕过风控）。
// 一个选项名承担两个方向是契约留下的口子；这里按类型区分（false / 对象），并在注释里写死，
// 免得以后有人"顺手统一"成一种含义，把其中一半的端点弄坏。
//
// 为什么永不让网络异常冒出去：
//   调用方（api/* 与 tools/*）只需要一个结构化结果。网络失败 → { code:-1, message }，
//   与 B站 自己的返回形状一样，上层不用写两套分支。日志与错误信息里**永远不出现**
//   cookie / 凭据 / 响应正文。
import path from 'node:path'

import { apiGet, apiState, configureState, signWbi } from '../vendor/bili-api.mjs'
import { configureTraffic, guardedFetch } from '../vendor/traffic.mjs'
import { DEPRECATED_COUNT_LIMIT, loadConfig, readJsonSafe, stateDir, writeJsonAtomic } from './config.js'
import { loadCred, requireForWrite } from './credentials.js'

const API_ORIGIN = 'https://api.bilibili.com'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
/**
 * 写请求还要带 origin —— 真机对照得出的（2026-11-01）：
 * 既有实现发写请求时同一个 header 里既有 referer 也有 origin，我们的只带 referer。
 * 缺 origin 时 B站 对"看起来像脚本"的表单请求更容易给风控码。
 */
const SITE_ORIGIN = 'https://www.bilibili.com'
/** 接口层风控码：撞到就熔断（与 vendor/bili-api.mjs 里那张表一致）。 */
const BAN_CODES = new Set([-412, -352, -799, -509, -10403])
/** 写请求的间隔地板。guard 的 minGapMs 更大，这里只是防止有人把间隔配成 0 之后裸奔。 */
const POST_MIN_GAP_MS = 300
const TIMEOUT_MS = 30_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 传给 traffic guard 的 risk 设置。
 *
 * 为什么四个"次数"字段要在这里**固定成大数**而不是透传配置（2026-11-01 需求变更）：
 *   额度已经改成按 token 计（core/tokenbudget.js），readHourly/readDaily/writeHourly/writeDaily
 *   已废弃。但旧配置文件里还留着 writeHourly: 12 —— 透传就等于让那个旧数字继续拦人，
 *   而且拦的理由（"已达到本地写操作预算"）会与 token 预算的说法打架，谁都看不懂。
 *   所以这四个固定成"实质不拦"的量级；其余字段（minGapMs / writeGapSec / dmGapSec）原样透传
 *   —— 那些是 B站 平台安全带（间隔），不是额度。
 */
function guardRisk (config) {
  const risk = (config ?? {}).risk ?? {}
  return {
    ...risk,
    readHourly: DEPRECATED_COUNT_LIMIT,
    readDaily: DEPRECATED_COUNT_LIMIT,
    writeHourly: DEPRECATED_COUNT_LIMIT,
    writeDaily: DEPRECATED_COUNT_LIMIT,
  }
}

/**
 * 建客户端。
 * @param {object|(() => object)} [config] 生效配置或取配置的函数。
 *   传函数 = "每次现读"（设置页改完立刻生效）；省略 = 用 core/config.js 的 loadConfig。
 */
export function createClient (config) {
  const readConfig = typeof config === 'function' ? config : () => (config ?? loadConfig())
  let syncedDir = null
  let lastPostAt = 0

  /** 每次请求前把 vendor 的两个状态目录对齐到当前配置，返回目录（绝对路径）。 */
  function ensure () {
    const current = readConfig() ?? loadConfig()
    const dir = stateDir(current)
    if (dir !== syncedDir) {
      configureState({ dir })
      // settings 是一个**函数**：guard 每次请求都问一次，所以设置页改 risk 不用重启
      configureTraffic({ directory: dir, settings: () => guardRisk(readConfig()) })
      syncedDir = dir
    }
    return dir
  }

  function safeCred () {
    // 凭据缺失是常态（只读也能用一半接口），所以这里只回答"有没有"，不抛
    try { return loadCred() } catch { return null }
  }

  function cookieHeader (cred) {
    if (cred === null || cred === undefined) return ''
    const parts = []
    if (cred.sessdata) parts.push('SESSDATA=' + cred.sessdata)
    if (cred.bili_jct) parts.push('bili_jct=' + cred.bili_jct)
    if (cred.buvid3) parts.push('buvid3=' + cred.buvid3)
    return parts.join('; ')
  }

  /** 请求头。cookie 只在这里拼一次，别处拿不到它 —— 少一个把它打进日志的机会。 */
  function headersFor (cred) {
    const cookie = cookieHeader(cred)
    const headers = { 'user-agent': USER_AGENT, referer: REFERER, origin: SITE_ORIGIN }
    if (cookie !== '') headers.cookie = cookie
    return headers
  }

  function buildUrl (target, query) {
    const url = new URL(String(target ?? ''), API_ORIGIN)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item))
      else url.searchParams.set(key, String(value))
    }
    return url
  }

  function normalize (payload) {
    if (payload === null || typeof payload !== 'object') {
      return { code: -1, message: 'B站返回了非对象响应（可能是风控页或接口变更）' }
    }
    return payload
  }

  function banFile (dir) {
    return path.join(dir, 'api-ban.json')
  }

  /** 熔断还剩多久（与 vendor 的 apiGet 读同一份文件、同一个 until 字段）。 */
  function banLeft (dir) {
    const ban = readJsonSafe(banFile(dir), {})
    const until = Number(ban?.until ?? 0)
    return until > Date.now() ? { ms: until - Date.now(), why: ban?.why ?? null } : null
  }

  /** 写熔断（形状与 vendor 里那次写入一致：until / why / at / streak）。指数退避 5 → 30 分钟。 */
  function setBan (dir, why) {
    const file = banFile(dir)
    const prev = readJsonSafe(file, {})
    const streak = Number(prev?.streak ?? 0) + 1
    const mins = Math.min(30, 5 * 2 ** (streak - 1))
    writeJsonAtomic(file, { until: Date.now() + mins * 60_000, why, at: new Date().toISOString(), streak })
    return mins
  }

  /**
   * traffic 守卫自己的暂停（traffic-state.json 的 until/reason）。
   *
   * 为什么它是**另一套**状态：api-ban.json 是 vendor 的 apiGet（GET 路径）读的那份；
   *   traffic 守卫在**发出**层面按风控码/429 自己暂停，落在 traffic-state.json。
   *   两边都活着的时候只看一份就会得出错误结论 —— 真机就这样：写请求全被拦，
   *   而 client.state() 报 banned:false、api-ban.json 根本不存在（2026-11-01 现场）。
   */
  function guardPause (dir) {
    const state = readJsonSafe(path.join(dir, 'traffic-state.json'), {})
    const until = Number(state?.until ?? 0)
    return until > Date.now() ? { ms: until - Date.now(), why: state?.reason ?? null, until } : null
  }

  /**
   * 把守卫的暂停**镜像**进 api-ban.json（§1.4：熔断必须共享）。
   *
   * 为什么必须镜像而不是各写各的：guard 暂停期间我们的 post 会在发请求前就被 TrafficError 拦下，
   *   那条路径拿不到任何 B站 响应 —— 如果只有"解析到风控码才写 api-ban.json"，
   *   生产里最常见的那种暂停就**永远不会**写进 api-ban.json，
   *   读路径（GET）与另一个进程于是继续打网络 ✗。
   *   until 取两者较大的那个：绝不因为镜像而缩短已有的熔断。
   */
  function mirrorGuardPause (dir) {
    const pause = guardPause(dir)
    if (pause === null) return setBan(dir, 'traffic guard paused')
    const file = banFile(dir)
    const prev = readJsonSafe(file, {})
    writeJsonAtomic(file, {
      until: Math.max(Number(prev?.until ?? 0), pause.until),
      why: 'traffic: ' + String(pause.why ?? '平台限制'),
      at: new Date().toISOString(),
      streak: Math.max(1, Number(prev?.streak ?? 0)),
    })
    return Math.max(1, Math.round(pause.ms / 60_000))
  }

  /** 一次成功就把退避计数清掉（否则下次小风控直接从 10 分钟起跳）。 */
  function clearStreak (dir) {
    const file = banFile(dir)
    const prev = readJsonSafe(file, {})
    if (Number(prev?.streak ?? 0) > 0) writeJsonAtomic(file, { ...prev, streak: 0 })
  }

  /**
   * 取 WBI 签名密钥（nav 的 data.wbi_img）。
   * 走 vendor 的 apiGet ⇒ 复用它的 10 分钟 nav 缓存：签名十次也只打一次网络，
   * 也就不会因为"签名"这件事把请求量打上去（风控关心的正是请求量）。
   * 拿不到返回 null（调用方据此明确失败，绝不退回未签名发送）。
   */
  async function wbiImages (cred) {
    try {
      const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', headersFor(cred), {})
      const img = nav?.data?.wbi_img
      if (img !== null && typeof img === 'object' && typeof img.img_url === 'string' && typeof img.sub_url === 'string') return img
      return null
    } catch {
      return null
    }
  }

  /** 写请求之间的 300ms 地板（见文件头 ③）。 */
  async function postThrottle () {
    const gap = Date.now() - lastPostAt
    if (gap < POST_MIN_GAP_MS) await sleep(POST_MIN_GAP_MS - gap)
    lastPostAt = Date.now()
  }

  // 先建成对象再返回：nav() 要调自己身上的 get()，用 this 会在被解构调用时丢 this
  const api = {
    /**
     * GET。缓存/退避/节流由 vendor 的 apiGet 负责。
     *
     * opts.wbi === true → 对**这份 query** 做 WBI 签名，把 w_rid / wts 拼进查询串（GET 没有 body）。
     *   用途：/x/space/wbi/acc/info（用户信息）必须签名，否则 B站 直接回风控码。
     *   key 走与 post 同一个 wbiImages()：同一份 nav 10 分钟缓存，签名再多次也只打一次网络。
     *   取不到 key → 结构化失败且**一个业务请求都不发**（绝不退回未签名请求：
     *   那等于让调用方拿一个 -412 去猜原因）。
     *
     * 注意：vendor 的 apiGet 只对 /x/web-interface/view 与 /x/player/playurl 自动签名，
     *   其它路径必须由这里显式签 —— 两条签名路径不冲突（那条分支只看路径是否在表里）。
     *
     * @returns {Promise<{code: number, message?: string, data?: any}>} 绝不抛
     */
    async get (target, query = {}, options = {}) {
      try {
        ensure()
        const url = buildUrl(target, query)
        const cred = safeCred()
        if (options.wbi === true) {
          const images = await wbiImages(cred)
          if (images === null) {
            return { code: -1, message: 'WBI 签名密钥不可用：nav 没有返回 wbi_img（未登录 / 风控退避中 / 密钥轮换），本次不发送' }
          }
          let signed
          try {
            signed = new URLSearchParams(signWbi(Object.fromEntries(url.searchParams), images))
          } catch (error) {
            return { code: -1, message: 'WBI 签名失败：' + String(error?.message ?? error).slice(0, 120) }
          }
          const wRid = signed.get('w_rid')
          const wts = signed.get('wts')
          if (wRid === null || wts === null) return { code: -1, message: 'WBI 签名失败：签名结果里没有 w_rid / wts' }
          url.searchParams.set('w_rid', wRid)
          url.searchParams.set('wts', wts)
        }
        return normalize(await apiGet(url.href, headersFor(cred), options))
      } catch {
        // 走到这里只可能是 URL 拼错之类的编程错误，网络异常 apiGet 自己已经兜住了
        return { code: -1, message: '请求失败（客户端参数不合法）' }
      }
    },

    /**
     * POST（写通道）。
     * 缺凭据 → 直接 { code:-111, message:人话 }，一个请求都不发。
     * @returns {Promise<{code: number, message?: string, data?: any}>} 绝不抛
     */
    async post (target, form = {}, options = {}) {
      const cred = safeCred()
      const lack = requireForWrite(cred)
      if (lack !== null) return { code: -111, message: lack.human }

      let dir
      try {
        dir = ensure()
      } catch {
        return { code: -1, message: '状态目录不可用（配置里的 paths.stateDir 指向了一个无法写入的位置）' }
      }
      const ban = banLeft(dir)
      if (ban !== null) {
        const mins = Math.max(1, Math.round(ban.ms / 60_000))
        return { code: -412, message: `B站 风控退避中（${ban.why ?? '平台限制'}），约 ${mins} 分钟后自动恢复；期间不发任何写请求` }
      }

      const url = buildUrl(target, options.query)
      const body = new URLSearchParams()
      for (const [key, value] of Object.entries(form ?? {})) {
        if (value === undefined || value === null) continue
        body.append(key, String(value))
      }
      // csrf 放在最后一行：即使调用方手滑传了 csrf，也以凭据里的为准（否则 B站 回 -111）
      body.set('csrf', cred.bili_jct)

      // ── WBI 签名（2026-11-01 真机）：/x/v2/reply/add 这一条没有签名就固定回 code=-412，
      //    同一凭据同时段动态/私信/点赞/收藏全都能发成功 —— 所以那不是账号限流，是这个端点要签名。
      //    签名口径照既有实现：**对同一份表单参数**（含 csrf）算签名，然后只把 w_rid / wts 拼到 query 上，
      //    body 不变（仍是那份 urlencoded）。不是把整串参数挪到 query —— 那会让 B站 读到两份参数。
      //    密钥取不到时**明确失败、一个请求都不发**：悄悄退回未签名 = 让调用方拿着 -412 去猜。
      if (options.wbi === true) {
        const images = await wbiImages(cred)
        if (images === null) {
          return { code: -1, message: 'WBI 签名密钥不可用：nav 没有返回 wbi_img（未登录 / 风控退避中 / 密钥轮换），本次不发送' }
        }
        let signed
        try {
          signed = new URLSearchParams(signWbi(Object.fromEntries(body.entries()), images))
        } catch (error) {
          return { code: -1, message: 'WBI 签名失败：' + String(error?.message ?? error).slice(0, 120) }
        }
        const wRid = signed.get('w_rid')
        const wts = signed.get('wts')
        if (wRid === null || wts === null) return { code: -1, message: 'WBI 签名失败：签名结果里没有 w_rid / wts' }
        url.searchParams.set('w_rid', wRid)
        url.searchParams.set('wts', wts)
      }

      await postThrottle()
      let response
      try {
        response = await guardedFetch(url.href, {
          method: 'POST',
          headers: { ...headersFor(cred), 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: options.signal ?? AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (error) {
        if (error?.code === 'BILI_TRAFFIC_PAUSED') {
          // 这条分支意味着"请求根本没发出去"（守卫在发出层面暂停/去重/冷却）。
          // 暂停时把它镜像进 api-ban.json，让读路径与其它进程一起退；文案里给出还要等几分钟。
          const mins = mirrorGuardPause(dir)
          return { code: -412, message: `${String(error.message ?? '本地风控闸暂停了这次发送')} —— 已熔断 ${mins} 分钟，期间不发任何写请求` }
        }
        return {
          code: -1,
          message: error?.name === 'TimeoutError' ? `请求超时（${TIMEOUT_MS / 1000} 秒）` : '请求失败（网络异常）',
        }
      }

      if (response.status === 412 || response.status === 429) {
        const mins = setBan(dir, `HTTP ${response.status}`)
        return { code: -412, message: `HTTP ${response.status}（B站 风控）—— 已熔断 ${mins} 分钟，别再打了` }
      }

      let text = ''
      try {
        text = await response.text()
      } catch {
        return { code: -1, message: '响应读取失败（连接中断）' }
      }
      let data
      try {
        data = JSON.parse(text)
        if (data === null || typeof data !== 'object') throw new Error('payload')
      } catch {
        return { code: -1, message: `非 JSON 响应（HTTP ${response.status}），可能是风控或接口变更` }
      }

      const code = Number(data.code)
      if (BAN_CODES.has(code)) {
        const mins = setBan(dir, `code=${code}`)
        return { ...data, message: `${data.message ?? ''}（B站 风控 ${code}）—— 已熔断 ${mins} 分钟` }
      }
      if (code === 0) clearStreak(dir)
      return data
    },

    /**
     * 原样取一个 URL（图片 / 字幕 / 播放地址这类不是 JSON 的东西）。
     * opts.json === false → { ok, status, buffer }
     */
    async raw (target, options = {}) {
      const method = String(options.method ?? 'GET').toUpperCase()
      const writing = method !== 'GET' && method !== 'HEAD'
      try {
        const dir = ensure()
        const url = buildUrl(target, options.query)
        const host = url.hostname
        const apiHost = host === 'bilibili.com' || host.endsWith('.bilibili.com')

        // 写请求同样要先看熔断：api 层的写通道必须共享同一份退避状态，否则就是"评论停了、动态还在打"
        if (apiHost && writing) {
          const ban = banLeft(dir)
          if (ban !== null) {
            const mins = Math.max(1, Math.round(ban.ms / 60_000))
            return { ok: false, status: 0, data: null, message: `B站 风控退避中（${ban.why ?? '平台限制'}），约 ${mins} 分钟后自动恢复` }
          }
        }

        const cred = safeCred()
        const jct = cred !== null && cred !== undefined && cred.bili_jct ? String(cred.bili_jct).trim() : ''
        const headers = { ...headersFor(cred), ...(options.headers ?? {}) }
        let body

        if (writing) {
          if (typeof FormData === 'function' && options.form instanceof FormData) {
            // multipart：**不设 content-type**，boundary 必须由 fetch 自己生成（设了就没有 boundary，
            // B站 只会回一个参数错误）。
            //
            // 2026-11-01 真机缺陷：这条分支以前是唯一**不补 csrf** 的，上传图片固定回 code=-111
            //   （同一凭据下动态 create / 私信 / 点赞全都成功，所以不是凭据问题）。
            //   为什么不能像 urlencoded 那样补：FormData 的体是二进制分片，没有"往 body 字符串上
            //   append 一个字段"这回事 —— csrf 只能作为**表单字段**加进去，或作为**查询参数**带上。
            //   两个都做：B站 的上传端点从哪边认 csrf 没有统一保证，多带一处不会坏事。
            //   已经是 FormData 就直接改它（调用方每次现建一个，不存在跨请求复用同一个体的问题）。
            const form = options.form
            if (jct !== '') {
              const existing = form.get('csrf')
              if (existing === null || existing === undefined || String(existing).trim() === '') form.append('csrf', jct)
              url.searchParams.set('csrf', jct)
            }
            body = form
          } else if (options.json !== null && typeof options.json === 'object') {
            // 见文件头：json 对象 = 这是请求体
            const payload = { ...options.json }
            if (jct !== '') {
              if (payload.csrf === undefined) payload.csrf = jct
              if (payload.csrf_token === undefined) payload.csrf_token = jct
              url.searchParams.set('csrf', jct) // set_top 这类端点从 query 认 csrf
            }
            body = JSON.stringify(payload)
            headers['content-type'] = 'application/json'
          } else if (options.form !== null && typeof options.form === 'object') {
            const form = new URLSearchParams()
            for (const [key, value] of Object.entries(options.form)) {
              if (value === undefined || value === null) continue
              form.append(key, String(value))
            }
            if (jct !== '' && !form.has('csrf')) form.set('csrf', jct)
            body = form
            headers['content-type'] = 'application/x-www-form-urlencoded'
          } else if (options.body !== undefined) {
            body = options.body // 调用方自己拼好的体：原样放行，不再动它
          }
          await postThrottle()
        }

        const response = await guardedFetch(url.href, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: options.signal ?? AbortSignal.timeout(60_000),
        })
        if (apiHost && (response.status === 412 || response.status === 429)) setBan(dir, `HTTP ${response.status}`)

        // 二进制：binary:true，或契约里的旧写法 json:false
        if (options.binary === true || options.json === false) {
          return { ok: response.ok, status: response.status, buffer: Buffer.from(await response.arrayBuffer()) }
        }
        const text = await response.text()
        let parsed = null
        try { parsed = JSON.parse(text) } catch { parsed = null }
        if (parsed !== null && typeof parsed === 'object' && apiHost) {
          const code = Number(parsed.code)
          if (BAN_CODES.has(code)) setBan(dir, `code=${code}`)
          else if (code === 0) clearStreak(dir)
        }
        // 是 JSON 就原样给 B站 那个对象（见文件头）；不是 JSON 才退回二进制
        if (parsed === null || typeof parsed !== 'object') {
          return { ok: response.ok, status: response.status, buffer: Buffer.from(text) }
        }
        return parsed
      } catch (error) {
        if (error?.code === 'BILI_TRAFFIC_PAUSED') {
          const mins = mirrorGuardPause(dir)
          return { ok: false, status: 0, data: null, buffer: Buffer.alloc(0), message: `${String(error.message ?? '本地风控闸暂停了这次请求')} —— 已熔断 ${mins} 分钟，期间不发任何写请求` }
        }
        return {
          ok: false,
          status: 0,
          buffer: Buffer.alloc(0),
          data: null,
          message: error?.name === 'TimeoutError' ? '请求超时' : '请求失败（网络异常）',
        }
      }
    },

    /** 登录态 + WBI 密钥（nav 的 10 分钟缓存由 vendor 负责 —— 密钥会轮换，缓存久了会签名失败）。 */
    async nav () {
      return api.get('/x/web-interface/nav')
    },

    /**
     * 排障现状：{ banned, banMinutesLeft, banWhy, cacheEntries, guardPaused }。
     *
     * 为什么不能直接返回 vendor 的 apiState()：它只读 api-ban.json，而**发出层面**的暂停在
     * traffic-state.json 里。真机踩过：写请求全被拦，状态页却报 banned:false、api-ban.json 不存在
     * —— 两个都"没错"，只是各自只说了半边话。这里合并成一句真话。
     */
    state () {
      try {
        const dir = ensure()
        const base = apiState()
        const pause = guardPause(dir)
        const fromBanMs = Number(base?.banMinutesLeft ?? 0) * 60_000
        const leftMs = Math.max(fromBanMs, pause?.ms ?? 0)
        const banned = base?.banned === true || pause !== null
        return {
          ...base,
          banned,
          banMinutesLeft: banned ? Math.max(1, Math.ceil(leftMs / 60_000)) : 0,
          banWhy: base?.banWhy ?? (pause === null ? null : 'traffic: ' + String(pause.why ?? '平台限制')),
          guardPaused: pause !== null,
        }
      } catch {
        return { banned: false, banMinutesLeft: 0, banWhy: null, cacheEntries: 0, guardPaused: false }
      }
    },

    /** 凭据（内部用；**不要打印返回值**）。缺文件时返回 null 而不是抛。 */
    cred () {
      return safeCred()
    },
  }

  return api
}
