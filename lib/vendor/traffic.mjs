// 请求守卫（节流 / 预算 / 冷却 / 熔断 / 相同写操作去重）。
//
// 复制适配清单（逻辑部分尽量一个字节都没动 —— 锁定、原子写、状态文件结构、去重、退避全部原样）：
//
//   ① 去掉对参考实现 config.mjs 的依赖（import { testModeEnabled }），也去掉对 paths.configPath 的依赖。
//      旧实现 riskSettings() 直接读那份插件的配置文件，trafficGuard() 直接问它"测试开关开了吗"。
//      本包没有、也不该读那份文件（解耦红线：对方卸载后本包必须完全正常）。
//      现在：risk 由 core/client.js 通过 configureTraffic({ settings }) 注入，
//      注入源是 core/config.js 的 loadConfig() —— 每次请求现读，所以设置页改完立刻生效；
//      拿不到（没人注入）就用 RISK_DEFAULTS。宁可保守，也不去猜别人的文件。
//
//   ② 单例的状态目录从写死的 ~/.bili-ai 改成 stateDir()（默认仍是 ~/.bili-ai）。
//      理由与 bili-api.mjs 完全相同：熔断/预算状态**必须共享**（一个撞 412，另一个也该退），
//      所以默认值不变；但测试期不能往真实 ~/.bili-ai 写，于是可被 configureTraffic({ directory }) 覆盖。
//
//   ③ testMode 的默认值仍然是「关」，没有被"顺手打开"：
//      它只影响本地预算/冷却/最小间隔（放开），blocked() 那道"平台翻脸"的闸一行没动 ✓
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { stateDir } from './paths.mjs'

export const RISK_DEFAULTS = { minGapMs: 1500, readHourly: 600, readDaily: 3000, writeHourly: 12, writeDaily: 30, writeGapSec: 120, dmGapSec: 60 }
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
// 见头部 ①：risk 不再来自某份磁盘配置文件，而是来自注入的 provider（core/client.js → core/config.js）。
// 没注入 = RISK_DEFAULTS。下面的归一化逻辑（dmGapSec 允许 0、预算类必须 >0、minGapMs ≥500、
// writeGapSec ≥30）一个字符都没改 —— 那些数字是实测过的。
let riskProvider = null

export function riskSettings() {
  let cfg = {}
  try { cfg = (typeof riskProvider === 'function' ? riskProvider() : null) ?? {} } catch { cfg = {} }
  const result = { ...RISK_DEFAULTS }
  for (const key of Object.keys(result)) {
    const n = Number(cfg[key])
    // 2026-10-23 改：dmGapSec 允许 0（主人要求「私信冷却不要」✗）
    //   其他预算类仍然是 >0 才生效 ✓（0 会被当成没填 ✓ 防手滑关掉闸门）
    if (Number.isFinite(n) && (n > 0 || key === 'dmGapSec')) result[key] = Math.max(0, Math.floor(n))
  }
  result.minGapMs = Math.max(500, result.minGapMs)
  result.writeGapSec = Math.max(30, result.writeGapSec)
  // 2026-10-23 改（主人要求）：私信冷却先不要 ✗
//   原来是 Math.max(30, ...) → 最低 30 秒，改不了 0 ✗
//   现在允许 0 = 不冷却（私信本来就一天只锁一个收信人 + 条数不限 ✓）
result.dmGapSec = Math.max(0, Number(result.dmGapSec) || 0)
  return result
}
const isBili = u => u.hostname === 'bilibili.com' || u.hostname.endsWith('.bilibili.com')
export class TrafficError extends Error { constructor(message) { super(message); this.name = 'TrafficError'; this.code = 'BILI_TRAFFIC_PAUSED' } }

// One state and lock per local plugin data directory, shared by CLI children and
// the Electron host. The lock covers reservation/update only, never network I/O.
//
// ⚠️ testMode 的默认值是「关」，**不是**去读配置文件 —— 这是故意的：
//   createTrafficGuard 会被测试直接构造（注入 directory/settings/now），
//   如果它默认去读真实的那份插件配置，整套测试就跟着主人的开关跑 ✗
//   （2026-10-30 实测踩到：主人一打开测试开关，预算/冷却的断言集体失效）
//   生产路径走 trafficGuard() 单例，那里显式传 testModeEnabled ✓
export function createTrafficGuard({ directory, transport = (...a) => globalThis.fetch(...a), settings = riskSettings, now = Date.now, sleep = delay, testMode = () => false } = {}) {
  const stateFile = path.join(directory, 'traffic-state.json'), lockFile = stateFile + '.lock'
  function read() {
    try { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (!s || typeof s !== 'object') throw Error('invalid state'); return s }
    catch (e) { if (e.code === 'ENOENT') return {}; throw new TrafficError('请求保护状态损坏，请检查 traffic-state.json；已停止网络请求') }
  }
  async function locked(fn) {
    fs.mkdirSync(directory, { recursive: true })
    const deadline = Date.now() + 10000
    let fd
    while (fd === undefined) {
      try { fd = fs.openSync(lockFile, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })) }
      catch (e) {
        if (e.code !== 'EEXIST') throw e
        try {
          const age = Date.now() - fs.statSync(lockFile).mtimeMs
          let pid
          try { pid = JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid } catch {}
          let dead = false
          if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0) } catch (x) { dead = x.code === 'ESRCH' } }
          if (dead || (!pid && age > 10000)) { fs.unlinkSync(lockFile); continue }
        } catch {}
        if (Date.now() >= deadline) throw new TrafficError('请求保护锁繁忙，本次停止；请稍后再试')
        await delay(25)
      }
    }
    try {
      const s = read(), result = fn(s)
      const temp = stateFile + '.' + process.pid + '.tmp'
      try { fs.writeFileSync(temp, JSON.stringify(s)); fs.renameSync(temp, stateFile) }
      finally { fs.rmSync(temp, { force: true }) }
      return result
    } finally { fs.closeSync(fd); fs.unlinkSync(lockFile) }
  }
  function blocked(s, account) {
    if (s.manual?.[account]) throw new TrafficError('账号需要人工处理登录或验证码；处理后运行 traffic resume --go')
    if (Number(s.until ?? 0) > now()) throw new TrafficError(`请求已暂停，${new Date(s.until).toISOString()} 后再试（${s.reason ?? '平台限制'}）`)
    let legacy = {}
    try { legacy=JSON.parse(fs.readFileSync(path.join(directory,'api-ban.json'),'utf8')) } catch {}
    if (Number(legacy.until??0)>now()) throw new TrafficError('已有接口风控等待尚未结束，请等待恢复')
  }
  function identity(headers) {
    const cookie = new Headers(headers).get('cookie') ?? ''
    return digest(((cookie.match(/(?:^|;)\s*SESSDATA=([^;]*)/i) ?? [])[1] ?? cookie) || 'anonymous')
  }
  async function fingerprint(url, body) {
    const ignored = /^(csrf|csrf_token|wts|w_rid|rnd|timestamp|msg\[timestamp\]|msg\[dev_id\])$/
    const raw = body instanceof URLSearchParams ? body.toString() : typeof body === 'string' ? body : null
    if (body instanceof FormData) {
      const parts=[]
      for (const [key,value] of body) if (!ignored.test(key)) parts.push([key,typeof value==='string'?value:digest(Buffer.from(await value.arrayBuffer()))])
      return digest(url.origin+url.pathname+JSON.stringify(parts.sort(([a],[b])=>a.localeCompare(b))))
    }
    if (raw === null) return digest(url.pathname + ':' + String(body))
    let value
    try { value = JSON.stringify(JSON.parse(raw), (k, v) => ignored.test(k) ? undefined : v) }
    catch { value = new URLSearchParams([...new URLSearchParams(raw)].filter(([k]) => !ignored.test(k)).sort(([a],[b]) => a.localeCompare(b))).toString() }
    return digest(url.origin + url.pathname + ':' + value)
  }
  async function guarded(input, options = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (!isBili(url)) return transport(input, options)
    const headers = options.headers ?? input.headers ?? {}, account = identity(headers)
    const method = String(options.method ?? input.method ?? 'GET').toUpperCase()
    const writing = !['GET','HEAD','OPTIONS'].includes(method)
    const body = options.body ?? (writing && input instanceof Request ? await input.clone().text() : undefined)
    const operation = writing ? await fingerprint(url, body) : null
    const id = operation ? account.slice(0,16) + ':' + operation : null
    const cfg = settings()
    // ── 测试开关（2026-10-30 主人加）─────────────────────────────────────
    //   打开 = 放开本地缰绳：**总量（预算）+ 间隔（冷却 / 最小间隔）**都不管 ✓
    //   不放开 = **平台翻脸**：`blocked()` 一行没动 —— 412/429 之后的暂停、
    //   要人工处理（登录/验证码）的账号、接口风控等待，照旧拦 ✓（这才是保命的那道）
    //   连"计数"也一起跳过：测试模式**不消耗**本地预算额度 →
    //   关掉开关就回到测试前的样子（不会一关就被自己攒下的额度顶住）✓
    const test = !!testMode()
    const gaps = test ? { ...cfg, minGapMs: 0, writeGapSec: 0, dmGapSec: 0 } : cfg
    let timestamp = now()
    const waitDeadline=timestamp+Math.min(180000,Math.max(0,Number(options.waitWriteMs)||0))
    const requestToken = crypto.randomUUID()
    let reservation
    for (;;) {
    timestamp=now()
    try { reservation = await locked(s => {
      blocked(s, account)
      s.accounts ??= {}; s.operations ??= {}
      const a = s.accounts[account] ??= {}
      const date = new Date(timestamp).toLocaleDateString('sv-SE')
      if (a.date !== date) Object.assign(a, { date, readDay: 0, writeDay: 0 })
      if (!a.hourAt || timestamp - a.hourAt >= 3600000) Object.assign(a, { hourAt: timestamp, readHour: 0, writeHour: 0 })
      for (const [key, item] of Object.entries(s.operations)) if (item.status !== 'unknown' && item.status !== 'pending' && timestamp - item.at > 86400000) delete s.operations[key]
      if (writing) {
        if (s.operations[id]) throw new TrafficError(`相同操作已提交或结果待核查，禁止重复发送；操作 ID：${id}`)
        if (Object.keys(s.operations).length >= 2000) throw new TrafficError('发送记录已满，请先核查未确认操作')
        // 测试模式：间隔归零 ✓（冷却与最小请求间隔都不管）；重复发送保护**保留** ✓
        const gap = (url.pathname.endsWith('/send_msg') ? gaps.dmGapSec : gaps.writeGapSec) * 1000
        if (!test && a.lastWrite && timestamp - a.lastWrite < gap && !url.pathname.endsWith('/reply/del')) throw Object.assign(new TrafficError('写操作冷却中，请稍后再发送'), { cooldownMs: a.lastWrite + gap - timestamp })
        // 测试模式：总量不拦、也不计数 ✓
        if (!test && ((a.writeHour ?? 0) >= cfg.writeHourly || (a.writeDay ?? 0) >= cfg.writeDaily)) throw new TrafficError('已达到本地写操作预算，本次不发送')
      } else if (!test && ((a.readHour ?? 0) >= cfg.readHourly || (a.readDay ?? 0) >= cfg.readDaily)) throw new TrafficError('已达到本地读取预算，请等待预算窗口恢复')
      // 测试模式：不等本地队列（nextAt）✓ —— 否则会被测试前排的队卡住
      const slot = test ? timestamp : Math.max(timestamp, Number(s.nextAt ?? 0))
      if (slot - timestamp > 30000) throw new TrafficError('请求队列已满，本次停止')
      s.nextAt = slot + gaps.minGapMs
      if (writing) {
        if (!test) { a.writeHour=(a.writeHour??0)+1; a.writeDay=(a.writeDay??0)+1; a.lastWrite=timestamp }
        s.operations[id]={at:timestamp,status:'pending',endpoint:url.pathname}
      }
      else if (!test) { a.readHour=(a.readHour??0)+1; a.readDay=(a.readDay??0)+1 }
      return { slot }
    })
      break
    } catch(e) {
      if(!e.cooldownMs || now()+e.cooldownMs>waitDeadline || !options.waitWriteMs) throw e
      await sleep(e.cooldownMs)
      options.signal?.throwIfAborted()
    }
    }
    let dispatched = false
    try {
      await sleep(Math.max(0, reservation.slot-now()))
      options.signal?.throwIfAborted()
      for (;;) {
        const wait = await locked(s => {
          blocked(s, account)
          if (s.active && Number(s.active.until)>now()) {
            let dead=false
            try { process.kill(s.active.pid,0) } catch(e) {dead=e.code==='ESRCH'}
            if(!dead) return 100
          }
          const remaining = Math.max(0, Number(s.lastDispatch ?? 0)+gaps.minGapMs-now())
          if (!remaining) { s.lastDispatch=now();s.active={token:requestToken,pid:process.pid,until:now()+35000} }
          return remaining
        })
        if (!wait) break
        await sleep(wait)
        options.signal?.throwIfAborted()
      }
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
      dispatched = true
      const response = await transport(input, { ...options, signal })
      let payload
      if ((response.headers?.get('content-type') ?? '').includes('json')) {
        try { payload = await response.clone().json() } catch {}
      }
      const code = Number(payload?.code)
      const risk = [412,429].includes(response.status) || [-412,-352,-799,-509,-10403].includes(code)
      const session = (new Headers(headers).get('cookie')?.match(/(?:^|;)\s*SESSDATA=([^;]+)/i) ?? [])[1]
      const authenticated = !!session && !['undefined','null'].includes(session)
      const manual = [12015,-105].includes(code) || (authenticated && (code === -101 || response.status === 401))
      const retry = response.headers?.get('retry-after')
      const retryMs = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry)*1000 : Math.max(0, Date.parse(retry)-now())) : 0
      await locked(s => {
        if (s.active?.token===requestToken) delete s.active
        if (risk) {
          s.streak = Math.min(8, Number(s.streak ?? 0)+1)
          s.until = Math.max(Number(s.until??0),now()+Math.max(Number.isFinite(retryMs)?retryMs:0,Math.min(1800000,300000*2**(s.streak-1))))
          s.reason = `HTTP ${response.status} / code ${Number.isFinite(code)?code:'unknown'}`
          s.riskEndpoint = url.pathname
        } else if (code === 0 && s.riskEndpoint === url.pathname && now() >= Number(s.until??0)) s.streak = 0
        if (manual) { s.manual ??= {}; s.manual[account] = {at:now(),code:Number.isFinite(code)?code:response.status} }
        if (id) {
          if (response.ok && code === 0) s.operations[id].status = 'confirmed'
          else if (payload && Number.isFinite(code) && code !== 0) delete s.operations[id]
          else s.operations[id].status = 'unknown'
        }
        s.last = { at: now(), endpoint: url.pathname, method, http: response.status, code: Number.isFinite(code)?code:null }
      })
      return response
    } catch (e) {
      await locked(s => { if(s.active?.token===requestToken)delete s.active; if (id) { if (!dispatched) delete s.operations[id]; else if (s.operations[id]) s.operations[id].status='unknown' } })
      if (dispatched && writing) throw new TrafficError(`发送结果不确定，已禁止自动重发。请回读核查；操作 ID：${id}`)
      throw e
    }
  }
  const inflight = new Map()
  return {
    fetch: (input, options={}) => {
      const url=new URL(typeof input==='string'||input instanceof URL ? input : input.url)
      if (!isBili(url) || String(options.method??input.method??'GET').toUpperCase()!=='GET' || options.signal) return guarded(input,options)
      const key=identity(options.headers??input.headers??{})+':'+url.href
      if(!inflight.has(key)) inflight.set(key,guarded(input,options).finally(()=>inflight.delete(key)))
      return inflight.get(key).then(r=>r.clone())
    },
    status: () => read(),
    pauseReason: headers => { try { blocked(read(),identity(headers));return null } catch(e) {return e.message} },
    resume: headers => locked(s => { if (s.manual) delete s.manual[identity(headers)] }),
    resolve: (id, outcome) => locked(s => { if (!s.operations?.[id]) throw new TrafficError('找不到操作 ID'); if (outcome === 'not-sent') delete s.operations[id]; else if (outcome === 'confirmed') s.operations[id].status='confirmed'; else throw new TrafficError('outcome 必须是 confirmed 或 not-sent') }),
  }
}
let singleton
let guardDirectory = null
let guardTestMode = () => false

/**
 * 注入 risk provider / 状态目录 / 测试开关（core/client.js 调用）。
 *
 * 为什么每次都重建单例：目录与设置都可能变（切 profile、设置页改 risk、测试切临时目录）。
 * 重建的代价只是一次对象构造 —— 真正的状态在磁盘上（traffic-state.json），不在内存里，
 * 所以重建不会丢任何预算/冷却计数 ✓
 *
 * @param {{settings?: () => object, directory?: string, testMode?: () => boolean}} [options]
 */
export function configureTraffic(options = {}) {
  if (typeof options.settings === 'function') riskProvider = options.settings
  if (typeof options.testMode === 'function') guardTestMode = options.testMode
  if (typeof options.directory === 'string' && options.directory.trim() !== '') guardDirectory = path.resolve(options.directory.trim())
  singleton = undefined
  return { directory: guardDirectory ?? stateDir() }
}

// 生产唯一入口：默认目录 = stateDir()（不注入就是 ~/.bili-ai，与原实现一致 ✓）；
// 测试开关默认「关」（createTrafficGuard 自己那层的默认也是关 ✓）
export function trafficGuard() {
  return singleton ??= createTrafficGuard({
    directory: guardDirectory ?? stateDir(),
    settings: riskSettings,
    testMode: () => {
      try { return guardTestMode() === true } catch { return false }
    },
  })
}
export function guardedFetch(...args) {
  // Legacy fixture suites replace fetch and opt out explicitly. Production
  // BILI_NO_CACHE does NOT disable traffic protection.
  if (process.env.BILI_TRAFFIC_TEST === '1' && process.env.NODE_TEST_CONTEXT) return globalThis.fetch(...args)
  return trafficGuard().fetch(...args)
}
