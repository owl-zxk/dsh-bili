// tests/autonomy-http.test.mjs —— 自主层的 HTTP 面（/dsh-bili/api/self/*）+ 窗口 / 静默 / 模型路由
//
// 为什么另起一个文件：
//   上一版 autonomy.test.mjs 只证明了"五条路由挂上了"，没证明"它们回什么"。设置页是主人唯一的
//   操作面 —— 保存动作写坏一次日程、人设截断一次、run-once 在忙时不回 409，都会让人以为
//   "点了没反应"。所以这里把五个 handler 真正用假 req/res 打一遍，并按契约验状态码与回包形状。
//
//   另外三块（窗口判定 / 连续失败静默 / llm 路由透传）都要**注入时间或注入 llm**，
//   全靠真实时钟等于把用例交给当前几点。所以：窗口用 canRunNow(now, schedule) 传时间戳，
//   静默用三次必失败的 tick 累加，模型路由用会记录 options 的假 llm。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { REPO_ROOT, cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

/* ────────────────────────────── 基建 ────────────────────────────── */

/** 假 webServer：重复 (kind, path) 抛 duplicate exact route（照宿主行为）。 */
function fakeServer () {
  const routes = new Map()
  return {
    routes,
    register (route) {
      const key = route.kind + ':' + route.path
      if (routes.has(key)) throw new Error('duplicate exact route: ' + route.path)
      routes.set(key, { ...route })
    },
  }
}

/** 每个用例一个临时 self 目录 + 沙盒状态目录（绝不碰真实 ~/.dsh）。 */
function selfEnv (tag) {
  const root = tmpDir(tag)
  const restoreSandbox = sandboxEnv(root)
  const restoreSelf = setEnv({ DSH_BILI_SELF_DIR: path.join(root, 'self') })
  fs.mkdirSync(path.join(root, 'self'), { recursive: true })
  return {
    root,
    selfDir: path.join(root, 'self'),
    restore () { restoreSelf(); restoreSandbox(); cleanupTmp() },
  }
}

/** 真流式 body：handler 里走 readBody(req) → req.on('data'/'end')，普通对象会被读成空。 */
function exchange (url, { method = 'GET', body, host = '127.0.0.1:52771' } = {}) {
  const res = {
    code: 0,
    headers: null,
    body: '',
    writeHead (code, headers) { this.code = code; this.headers = headers },
    end (payload) { this.body = String(payload ?? '') },
  }
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = method
  req.url = url
  req.headers = { host, 'content-type': 'application/json' }
  return { req, res }
}

/** 挂上五条 self 路由，并给一个"像浏览器那样打它们"的请求函数。 */
async function mountSelf (moduleUrl = repoUrl('lib/api/self-routes.js'), { ctx = {}, deps: depsOverride } = {}) {
  const { mountSelfRoutes } = await import(moduleUrl)
  const server = fakeServer()
  const deps = depsOverride ?? { log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, config: {}, tools: new Map() }
  const registered = await mountSelfRoutes({ webServer: server }, { ctx, deps })
  return {
    server,
    registered,
    deps,
    async call (routePath, options = {}) {
      const key = 'exact:' + routePath
      const route = server.routes.get(key)
      assert.ok(route !== undefined, '路由没挂上：' + routePath)
      const { req, res } = exchange(routePath + (options.query ?? ''), options)
      await route.handler(req, res)
      let payload = null
      try { payload = JSON.parse(res.body) } catch { payload = null }
      return { code: res.code, payload, raw: res.body }
    },
  }
}

/** 让出若干轮事件循环（动态 import + promise 链要靠它推进，不睡真实时间）。 */
async function tickTurns (turns = 40) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

async function waitFor (predicate, turns = 300) {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return true
    await new Promise((resolve) => setImmediate(resolve))
  }
  return predicate()
}

/** 本地的某个整点时间戳（用来注入 now，不依赖真实时钟）。 */
function at (hour, minute = 0) {
  const d = new Date(2026, 10, 1, hour, minute, 0, 0)   // 2026-11-01，本地时区
  return d.getTime()
}

/* ══════════════════════════ 1. GET /state ══════════════════════════ */

test('self /state：available:true + 七个 allows + window/intervalMin/jitter/caps + llmProvider/llmModel', async () => {
  const env = selfEnv('self-state')
  try {
    const self = await mountSelf()
    const { code, payload } = await self.call('/dsh-bili/api/self/state')
    assert.equal(code, 200, '/state 必须 200，实际 ' + code)
    assert.equal(payload.ok, true)
    const data = payload.data
    assert.equal(data.available, true, 'core/schedule.js 在就必须 available:true')

    // §11 的七个开关，逐项布尔
    assert.deepEqual(data.allows, { read: true, dm: true, comment: false, reply: false, dynamic: false, like: false, follow: false }, 'allows 必须是 §11 的七项默认值，实际 ' + JSON.stringify(data.allows))
    for (const [key, value] of Object.entries(data.allows)) assert.equal(typeof value, 'boolean', 'allows.' + key + ' 必须是布尔')

    // 日程与节流
    assert.equal(data.enabled, true, '默认启用')
    assert.deepEqual(data.window, { start: '20:00', end: '24:00' }, '窗口默认 20:00–24:00，实际 ' + JSON.stringify(data.window))
    assert.equal(data.intervalMin, 45, '间隔默认 45 分钟')
    assert.equal(data.jitter, 0.2, '抖动默认 0.2')
    // §17：默认「不限量」，只有 dynamic 还留着 2；null 表示不限（与 0 = 禁止 必须能区分）
    assert.deepEqual(data.caps, { dm: null, comment: null, reply: null, dynamic: 2, like: null, follow: null }, 'caps 默认值不对：' + JSON.stringify(data.caps))

    // 模型路由字段必须在（界面要能渲染两个输入框）
    assert.equal(typeof data.llmProvider, 'string', 'data.llmProvider 必须是字符串')
    assert.equal(typeof data.llmModel, 'string', 'data.llmModel 必须是字符串')
    assert.equal(data.llmProvider, '', '默认留空 = 用宿主默认路由')
    assert.equal(data.llmModel, '')

    // 只读尾巴（界面靠这些看"她刚才干了什么"）
    assert.ok(Array.isArray(data.auditTail), 'auditTail 必须是数组')
    assert.equal(typeof data.todayCounts, 'object', 'todayCounts 必须是对象')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 2. POST /settings ══════════════════════════ */

test('self /settings：部分更新 200 且落盘；四类非法输入各 400 且文件字节不变', async () => {
  const env = selfEnv('self-settings')
  try {
    const self = await mountSelf()
    const scheduleFile = path.join(env.selfDir, 'schedule.json')

    // ① 部分更新：只改 intervalMin，别的字段必须原样保留
    const ok = await self.call('/dsh-bili/api/self/settings', { method: 'POST', body: { intervalMin: 30 } })
    assert.equal(ok.code, 200, '合法更新必须 200，实际 ' + ok.code + '：' + JSON.stringify(ok.payload))
    assert.deepEqual(ok.payload.data.saved, { intervalMin: 30 }, '回包要如实说这次改了什么')
    const onDisk = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'))
    assert.equal(onDisk.intervalMin, 30, '必须真的落盘（intervalMin=30），实际 ' + onDisk.intervalMin)
    assert.equal(onDisk.enabled, true, '部分更新不许把没提的字段改掉（enabled）')
    assert.deepEqual(onDisk.caps, { dm: null, comment: null, reply: null, dynamic: 2, like: null, follow: null }, '部分更新不许丢 caps（默认是「不限」的那几项要保留 null）')
    const baseline = fs.readFileSync(scheduleFile, 'utf8')

    // ② 四类非法输入：都要 400，且文件一个字节都不许动
    const cases = [
      ['allows.comment 不是布尔', { allows: { comment: 'yes' } }],
      ['intervalMin 为 0', { intervalMin: 0 }],
      ['window.start 为 25:00', { window: { start: '25:00' } }],
      ['llmProvider 121 字', { llmProvider: 'x'.repeat(121) }],
    ]
    for (const [label, body] of cases) {
      const bad = await self.call('/dsh-bili/api/self/settings', { method: 'POST', body })
      assert.equal(bad.code, 400, label + ' 必须 400，实际 ' + bad.code + '：' + JSON.stringify(bad.payload))
      assert.ok(typeof bad.payload.error === 'string' && bad.payload.error.length > 0, label + ' 必须给 error 文案')
      assert.equal(fs.readFileSync(scheduleFile, 'utf8'), baseline, label + ' 被拒后日程文件必须原样不动')
    }
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 3. POST /persona ══════════════════════════ */

test('self /persona：20001 字 → 400；正常 → 200 且 persona.md 里能读到', async () => {
  const env = selfEnv('self-persona')
  try {
    const self = await mountSelf()
    const persona = await import(repoUrl('lib/core/persona.js'))

    const tooLong = await self.call('/dsh-bili/api/self/persona', { method: 'POST', body: { text: 'x'.repeat(20001) } })
    assert.equal(tooLong.code, 400, '20001 字必须 400（上限 20000）')
    assert.match(String(tooLong.payload.error), /20000/, '文案要说清上限是 20000：' + tooLong.payload.error)

    const text = '# 我是往生堂七七\n\n喜欢在深夜刷 B站。'
    const ok = await self.call('/dsh-bili/api/self/persona', { method: 'POST', body: { text } })
    assert.equal(ok.code, 200, '合法人设必须 200，实际 ' + ok.code + '：' + JSON.stringify(ok.payload))
    assert.equal(ok.payload.data.length, text.length, '回包里的 length 要等于写入字数')
    const file = persona.personaPath()
    assert.ok(fs.existsSync(file), '人设文件必须落盘：' + file)
    assert.ok(fs.readFileSync(file, 'utf8').includes('往生堂七七'), '落盘内容里必须能读到刚写的人设')

    const read = await self.call('/dsh-bili/api/self/persona')
    assert.equal(read.code, 200, 'GET /persona 必须 200')
    assert.ok(String(read.payload.data.text).includes('往生堂七七'), 'GET 要能把刚写的人设读回来')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 4. POST /run-once ══════════════════════════ */

test('self /run-once：单飞占用时 409；core/autonomy.js 缺失时 503', async () => {
  const env = selfEnv('self-runonce')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    autonomy.stop()
    schedule.unlock()
    schedule.saveSchedule({ allows: { dm: true } })

    // ① 409：用一个可控 gate 把第一次 runOnce 卡在 llm 流里，in-flight 标志就不会复位
    let release = null
    const gate = new Promise((resolve) => { release = resolve })
    const llm = {
      async *stream () {
        await gate
        yield { type: 'text-delta', text: JSON.stringify({ mood: '平静', say: '', actions: [], diary: '', memory: [] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    autonomy.start({ effect: () => {}, get: () => null }, { log: () => {}, tools: new Map() }, { llm })
    const self = await mountSelf()

    const first = await self.call('/dsh-bili/api/self/run-once', { method: 'POST' })
    assert.equal(first.code, 200, '第一次手动唤醒必须立刻 200（不等它跑完），实际 ' + first.code)
    assert.equal(first.payload.data.accepted, true, '回包必须是 accepted:true')
    await tickTurns(10)   // 让它真的进到"在跑"的状态

    const second = await self.call('/dsh-bili/api/self/run-once', { method: 'POST' })
    assert.equal(second.code, 409, '已经醒着时第二次必须 409，实际 ' + second.code + '：' + JSON.stringify(second.payload))
    assert.match(String(second.payload.error), /醒着|还没跑完/, '409 的文案要说清是在跑：' + second.payload.error)

    release()
    await tickTurns(20)
    autonomy.stop()

    // ② 503：core/autonomy.js 不存在 → 自主层未就绪
    const copy = tmpDir('self-runonce-copy')
    const copyTree = (from, to) => {
      fs.mkdirSync(to, { recursive: true })
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name)
        const target = path.join(to, entry.name)
        if (entry.isDirectory()) copyTree(source, target)
        else if (entry.isFile()) fs.copyFileSync(source, target)
      }
    }
    copyTree(path.join(REPO_ROOT, 'lib'), path.join(copy, 'lib'))
    fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(copy, 'package.json'))
    fs.rmSync(path.join(copy, 'lib', 'core', 'autonomy.js'))
    const missing = await mountSelf('file://' + path.join(copy, 'lib', 'api', 'self-routes.js').replace(/\\/g, '/'))
    const unavailable = await missing.call('/dsh-bili/api/self/run-once', { method: 'POST' })
    assert.equal(unavailable.code, 503, '自主层模块缺失必须 503，实际 ' + unavailable.code + '：' + JSON.stringify(unavailable.payload))
    assert.match(String(unavailable.payload.error), /未就绪/, '503 的文案要说清自主层没就绪：' + unavailable.payload.error)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 5. 非回环 → 403 ══════════════════════════ */

test('self 五条路由：非回环来源一律 403（信任栅栏在 handler 之前）', async () => {
  const env = selfEnv('self-trust')
  try {
    const self = await mountSelf()
    const routes = [
      ['/dsh-bili/api/self/state', 'GET'],
      ['/dsh-bili/api/self/settings', 'POST'],
      ['/dsh-bili/api/self/persona', 'POST'],
      ['/dsh-bili/api/self/run-once', 'POST'],
      ['/dsh-bili/api/self/audit', 'GET'],
    ]
    for (const [routePath, method] of routes) {
      const { code, payload } = await self.call(routePath, { method, host: 'evil.example.com', body: method === 'POST' ? {} : undefined })
      assert.equal(code, 403, '非回环来源必须 403：' + routePath + ' 实际 ' + code)
      assert.match(String(payload.error), /不可信|信任/, '403 要说清来源不可信：' + payload.error)
    }
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 6. GET /audit ══════════════════════════ */

test('self /audit：?limit=5 返回条数与 limit 一致；不带参数默认 50', async () => {
  const env = selfEnv('self-audit')
  try {
    const audit = await import(repoUrl('lib/core/audit.js'))
    for (let i = 1; i <= 7; i += 1) audit.appendAudit({ tool: 'bili_dm', args: { text: '第 ' + i + ' 条' }, why: '测试', result: { ok: true } })

    const self = await mountSelf()
    const limited = await self.call('/dsh-bili/api/self/audit', { query: '?limit=5' })
    assert.equal(limited.code, 200, '/audit 必须 200')
    assert.equal(limited.payload.data.limit, 5, 'limit 要原样回显，实际 ' + limited.payload.data.limit)
    assert.equal(limited.payload.data.entries.length, 5, 'limit=5 时条目数必须是 5，实际 ' + limited.payload.data.entries.length)
    assert.equal(limited.payload.data.entries.at(-1).args.text, '第 7 条', '取的是最近 5 条（最后一条是第 7 条）')

    const fallback = await self.call('/dsh-bili/api/self/audit')
    assert.equal(fallback.payload.data.limit, 50, '不带 limit 时默认 50')
    assert.equal(fallback.payload.data.entries.length, 7, '只有 7 条时就是 7 条')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 7-9. 窗口判定 ══════════════════════════ */

test('窗口：窗口外 canRunNow 拒、nextWakeAt 指向下一个窗口开始', async () => {
  const env = selfEnv('win-outside')
  try {
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    schedule.unlock()
    const s = { ...schedule.loadSchedule(), enabled: true, window: { start: '20:00', end: '24:00' }, intervalMin: 45, jitter: 0 }

    const at15 = at(15, 0)
    const verdict = schedule.canRunNow(at15, s)
    assert.equal(verdict.ok, false, '15:00 在 20:00–24:00 之外，必须拒')
    assert.equal(verdict.reason, 'outside-window', 'reason 必须是 outside-window，实际 ' + verdict.reason)

    const next = schedule.nextWakeAt(at15, s)
    assert.equal(typeof next, 'number', '窗口外 nextWakeAt 必须给出**下一个窗口开始**（不是 null、也不是"再等一个间隔"），实际 ' + String(next))
    assert.equal(next, at(20, 0), '下一个醒来时刻必须是当天 20:00，实际 ' + new Date(next).toLocaleString('sv-SE'))
  } finally {
    env.restore()
  }
})

test('窗口：跨午夜（22:00–02:00）01:00 放行、03:00 拒', async () => {
  const env = selfEnv('win-midnight')
  try {
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    schedule.unlock()
    const s = { ...schedule.loadSchedule(), enabled: true, window: { start: '22:00', end: '02:00' }, intervalMin: 45, jitter: 0 }

    assert.equal(schedule.canRunNow(at(1, 0), s).ok, true, '跨午夜窗口里 01:00 必须放行')
    assert.equal(schedule.canRunNow(at(23, 30), s).ok, true, '跨午夜窗口里 23:30 必须放行')
    const late = schedule.canRunNow(at(3, 0), s)
    assert.equal(late.ok, false, '03:00 在 22:00–02:00 之外，必须拒')
    assert.equal(late.reason, 'outside-window', 'reason 必须是 outside-window，实际 ' + late.reason)
  } finally {
    env.restore()
  }
})

test('窗口边界：正好 20:00 放行、正好 24:00（= 次日 00:00）拒', async () => {
  const env = selfEnv('win-edge')
  try {
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    schedule.unlock()
    const s = { ...schedule.loadSchedule(), enabled: true, window: { start: '20:00', end: '24:00' }, intervalMin: 45, jitter: 0 }

    assert.equal(schedule.canRunNow(at(20, 0), s).ok, true, '起点 20:00 必须**包含**在窗口内（cur >= start）')
    assert.equal(schedule.canRunNow(at(23, 59), s).ok, true, '23:59 仍在窗口内')
    const end = schedule.canRunNow(at(24, 0) /* Date(2026,10,1,24) = 次日 00:00 */, s)
    assert.equal(end.ok, false, '结束时刻 24:00（= 次日 00:00）必须**不含**在窗口内（cur < end）')
    assert.equal(end.reason, 'outside-window', 'reason 必须是 outside-window，实际 ' + end.reason)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 10. 连续失败 → 静默 ══════════════════════════ */

test('连续 3 次失败 → 静默 2 小时：第 4 次 canRunNow 拒且恢复时间约 2 小时后', async () => {
  const env = selfEnv('silence')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { readState, patchState } = await import(repoUrl('lib/core/state.js'))
    autonomy.stop()
    schedule.unlock()
    patchState({ consecutiveFailures: 0, silenceUntil: 0, counters: {} })
    schedule.saveSchedule({ enabled: true })

    // 必失败的 tick：llm 的流一上来就抛
    const exploding = { async *stream () { throw new Error('模型炸了（测试桩）') } }
    const deps = { tools: new Map(), llm: exploding, log: () => {}, ctx: {} }
    for (let i = 1; i <= 3; i += 1) {
      const outcome = await autonomy.runOnce('manual', deps)
      assert.equal(outcome.ok, false, '第 ' + i + ' 次必失败')
    }

    const state = readState()
    const left = Number(state.silenceUntil ?? 0) - Date.now()
    assert.ok(left > 0, '3 次失败后必须写入静默截止时间，实际 silenceUntil=' + state.silenceUntil)
    assert.ok(left > 1.9 * 3600_000 && left <= 2 * 3600_000 + 60_000, '静默时长应≈2 小时，实际 ' + Math.round(left / 60000) + ' 分钟')

    const verdict = schedule.canRunNow(Date.now())
    assert.equal(verdict.ok, false, '静默期间必须拒')
    assert.match(String(verdict.reason), /silenced|静默/, 'reason 要能看出是静默，实际 ' + verdict.reason)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 11. 模型路由透传 ══════════════════════════ */

test('llm 路由透传：配了 llmProvider/llmModel 就带进 options，留空则两个键都不出现', async () => {
  const env = selfEnv('llm-route')
  try {
    const { decide } = await import(repoUrl('lib/core/brain.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    schedule.unlock()

    const seen = []
    const llm = {
      async *stream (options) {
        seen.push(options)
        yield { type: 'text-delta', text: JSON.stringify({ mood: '平静', say: '', actions: [], diary: '', memory: [] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const deps = { tools: new Map() }

    // ① 配了就用配的
    schedule.saveSchedule({ llmProvider: 'deepseek', llmModel: 'deepseek-v3' })
    const routed = await decide({ trigger: 'manual', deps, llm })
    assert.equal(routed.ok, true, '正常 JSON 应当解析成功，实际 ' + JSON.stringify(routed).slice(0, 160))
    assert.equal(seen.length, 1, '一次调用')
    assert.equal(seen[0].provider, 'deepseek', 'options.provider 必须是配置里的 provider，实际 ' + seen[0].provider)
    assert.equal(seen[0].model, 'deepseek-v3', 'options.model 必须是配置里的 model，实际 ' + seen[0].model)

    // ② 留空 = 交给宿主默认路由：这两个键**不该出现**（传空串可能被当成"指定了一个叫空的模型"）
    schedule.saveSchedule({ llmProvider: '', llmModel: '' })
    const unset = await decide({ trigger: 'manual', deps, llm })
    assert.equal(unset.ok, true)
    assert.equal('provider' in seen[1], false, '留空时 options 里不许出现 provider，实际 ' + JSON.stringify(seen[1]).slice(0, 200))
    assert.equal('model' in seen[1], false, '留空时 options 里不许出现 model')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 12-13. 设置页指标块（§14.4） ══════════════════════════ */

test('self /state：data 里带 metrics 六项、behavior.noExplore、metricsRecent（数组且 ≤5）', async () => {
  const env = selfEnv('self-metrics-block')
  try {
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    const self = await mountSelf()

    // 先造两条变化，好让 metricsRecent 有东西可看
    metrics.applyEvent('action-ok')
    metrics.applyEvent('interest-hit')

    const { code, payload } = await self.call('/dsh-bili/api/self/state')
    assert.equal(code, 200, '/state 必须 200，实际 ' + code)
    const data = payload.data
    assert.equal(data.available, true, 'core 模块都在时必须 available:true')

    // 六项指标：键齐、值是数字（界面要画进度条）
    assert.equal(typeof data.metrics, 'object', 'data.metrics 必须是对象，实际 ' + JSON.stringify(data.metrics))
    for (const key of metrics.METRIC_KEYS) {
      assert.equal(typeof data.metrics[key], 'number', 'data.metrics.' + key + ' 必须是数字，实际 ' + JSON.stringify(data.metrics[key]))
      assert.equal(Number.isInteger(data.metrics[key]), true, 'data.metrics.' + key + ' 必须是整数')
      assert.ok(data.metrics[key] >= 0 && data.metrics[key] <= 100, 'data.metrics.' + key + ' 必须在 0–100')
    }

    // behavior：至少要有 noExplore（curiosity 闸的对外开关）
    assert.equal(typeof data.behavior, 'object', 'data.behavior 必须是对象')
    assert.equal(typeof data.behavior.noExplore, 'boolean', 'data.behavior.noExplore 必须是布尔，实际 ' + JSON.stringify(data.behavior))
    assert.equal(data.behavior.noExplore, metrics.behaviorHints(metrics.readMetrics()).noExplore, 'noExplore 必须与 behaviorHints 一致')

    // metricsRecent：数组、最多 5 条、每条带 event 与 changes
    assert.ok(Array.isArray(data.metricsRecent), 'data.metricsRecent 必须是数组，实际 ' + JSON.stringify(data.metricsRecent))
    assert.ok(data.metricsRecent.length <= 5, 'metricsRecent 最多 5 条，实际 ' + data.metricsRecent.length)
    assert.ok(data.metricsRecent.length >= 1, '刚写过两条变化，metricsRecent 至少有 1 条')
    assert.equal(typeof data.metricsRecent.at(-1).event, 'string', '每条变化要带 event')
    assert.ok(Array.isArray(data.metricsRecent.at(-1).changes), '每条变化要带 changes')
  } finally {
    env.restore()
  }
})

test('self /state：core/metrics.js 缺失的副本 → 仍 200 且 available:false（不把整页打挂）', async () => {
  const env = selfEnv('self-metrics-missing')
  try {
    const copy = tmpDir('self-metrics-copy')
    const copyTree = (from, to) => {
      fs.mkdirSync(to, { recursive: true })
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name)
        const target = path.join(to, entry.name)
        if (entry.isDirectory()) copyTree(source, target)
        else if (entry.isFile()) fs.copyFileSync(source, target)
      }
    }
    copyTree(path.join(REPO_ROOT, 'lib'), path.join(copy, 'lib'))
    fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(copy, 'package.json'))
    fs.rmSync(path.join(copy, 'lib', 'core', 'metrics.js'))
    assert.equal(fs.existsSync(path.join(copy, 'lib', 'core', 'metrics.js')), false, '前提：副本里指标模块真的没了')

    const self = await mountSelf('file://' + path.join(copy, 'lib', 'api', 'self-routes.js').replace(/\\/g, '/'))
    const { code, payload } = await self.call('/dsh-bili/api/self/state')
    assert.equal(code, 200, '指标模块缺失也必须 200（"没装"不是"请求失败"），实际 ' + code)
    assert.equal(payload.ok, true, '回包仍是 { ok:true }')
    assert.equal(payload.data.available, false, '自主层未就绪时必须如实说 available:false，实际 ' + JSON.stringify(payload.data).slice(0, 160))
    assert.match(String(payload.data.reason), /metrics/, 'reason 要点名缺的是 core/metrics.js：' + payload.data.reason)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 14-15. 身份字段与热梗库路由（§14.5） ══════════════════════════ */

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/
const bodyOf = (text) => String(text).replace(FRONT_MATTER, '')

test('self /profile：GET 回 {name,ownerTitle}；POST 只改头部（正文不变）；21 字 / 空值 → 400 且文件字节不变', async () => {
  const env = selfEnv('self-profile')
  try {
    const persona = await import(repoUrl('lib/core/persona.js'))
    // 带连续空行与行尾空格（真实的人手编辑形状）：保存身份时任何"规整正文"的写法都会让哈希变
    const BODY = '正文第一行：我是谁不重要，重要的是我不装。\n\n\n## 备注   \n（主人可以随便改）\n'
    persona.writePersona('---\nname: 旧名字\nownerTitle: 旧称呼\n---\n' + BODY)
    const beforeRaw = fs.readFileSync(persona.personaPath(), 'utf8')
    assert.equal(bodyOf(beforeRaw), BODY, '前提：正文就是写进去的那段')

    const self = await mountSelf()
    // GET：先把旧值读出来（界面要能预填）
    const got = await self.call('/dsh-bili/api/self/profile')
    assert.equal(got.code, 200, 'GET /profile 必须 200，实际 ' + got.code)
    assert.equal(got.payload.data.name, '旧名字', 'GET 要回 front-matter 里的 name，实际 ' + got.payload.data.name)
    assert.equal(got.payload.data.ownerTitle, '旧称呼', 'GET 要回 front-matter 里的 ownerTitle')
    assert.equal(got.payload.data.available, true)

    // POST 合法：200，头部变了、正文一个字节不变
    const ok = await self.call('/dsh-bili/api/self/profile', { method: 'POST', body: { name: '小鲤', ownerTitle: '饲主' } })
    assert.equal(ok.code, 200, '合法保存必须 200，实际 ' + ok.code + '：' + JSON.stringify(ok.payload))
    const afterRaw = fs.readFileSync(persona.personaPath(), 'utf8')
    assert.match(afterRaw, /name: 小鲤/, '头部必须换成新名字')
    assert.match(afterRaw, /ownerTitle: 饲主/, '头部必须换成新称呼')
    assert.equal(bodyOf(afterRaw), BODY, '保存名字绝不能动正文（最贵的那部分文本）')

    const readBack = await self.call('/dsh-bili/api/self/profile')
    assert.equal(readBack.payload.data.name, '小鲤', 'GET 要能读回刚存的名字')
    assert.equal(readBack.payload.data.ownerTitle, '饲主')

    // 非法：21 字 / 空白 → 400 且文件字节不变
    const baseline = fs.readFileSync(persona.personaPath(), 'utf8')
    for (const body of [{ name: 'x'.repeat(21) }, { ownerTitle: '   ' }, { name: '' }]) {
      const bad = await self.call('/dsh-bili/api/self/profile', { method: 'POST', body })
      assert.equal(bad.code, 400, JSON.stringify(body) + ' 必须 400，实际 ' + bad.code + '：' + JSON.stringify(bad.payload))
      assert.ok(typeof bad.payload.error === 'string' && bad.payload.error.length > 0, '必须给 error 文案')
      assert.equal(fs.readFileSync(persona.personaPath(), 'utf8'), baseline, JSON.stringify(body) + ' 被拒后 persona.md 必须原样不动')
    }
  } finally {
    env.restore()
  }
})

test('self /memes + /meme-refresh：GET 视图形状、POST 刷新摘要、刷新中再点 409、core/memes.js 缺失时降级', async () => {
  const env = selfEnv('self-memes')
  try {
    const memes = await import(repoUrl('lib/core/memes.js'))
    memes.resetForTest()

    // ① 刷新：用可控 gate 卡住 llm，先拿 409，再放行拿摘要
    let release = null
    const gate = new Promise((resolve) => { release = resolve })
    const items = [{ meme: '尊嘟假嘟', meaning: '真的假的', example: '尊嘟假嘟？' }, { meme: 'city不city', meaning: '洋气吗', example: '' }]
    const llm = {
      async *stream () {
        await gate
        yield { type: 'text-delta', text: JSON.stringify(items) }
        yield { type: 'finish', reason: { kind: 'ok' } }
      },
    }
    const self = await mountSelf(undefined, { ctx: { llm, tools: new Map() } })

    const first = self.call('/dsh-bili/api/self/meme-refresh', { method: 'POST' })
    await tickTurns(10)
    const second = await self.call('/dsh-bili/api/self/meme-refresh', { method: 'POST' })
    assert.equal(second.code, 409, '刷新进行中再点必须 409，实际 ' + second.code + '：' + JSON.stringify(second.payload))

    release()
    const done = await first
    assert.equal(done.code, 200, '刷新必须 200（摘要用 ok 字段表达成败），实际 ' + done.code)
    assert.equal(done.payload.data.ok, true, '刷新应当成功（假 llm 给了合法 JSON 数组）')
    assert.equal(done.payload.data.source, 'llm', '没有 web_search 工具时来源必须如实写 llm，实际 ' + done.payload.data.source)
    assert.ok(done.payload.data.count >= 1, '刷新摘要要带条数，实际 ' + done.payload.data.count)

    // ② GET 视图：形状与上限
    const view = await self.call('/dsh-bili/api/self/memes')
    assert.equal(view.code, 200, 'GET /memes 必须 200')
    const data = view.payload.data
    assert.equal(data.available, true)
    assert.equal(typeof data.updatedAt, 'string', 'updatedAt 必须是字符串，实际 ' + JSON.stringify(data.updatedAt))
    assert.equal(data.source, 'llm', 'source 要如实')
    assert.equal(data.stage, 'fresh', '刚刷新成功应当是 fresh')
    assert.ok(data.count >= 1, 'count 至少 1')
    assert.ok(Array.isArray(data.items), 'items 必须是数组')
    assert.ok(data.items.length <= 10, 'items 最多 10 条（界面只列前 10），实际 ' + data.items.length)
    assert.equal(data.items[0].meme, '尊嘟假嘟', '前 10 条要带梗本身')
    assert.equal(typeof data.staleDays, 'number', 'staleDays 必须是数字（刚刷新 = 0），实际 ' + JSON.stringify(data.staleDays))

    // ③ core/memes.js 缺失的副本：GET 降级 200（未就绪）、POST 503
    const copy = tmpDir('self-memes-copy')
    const copyTree = (from, to) => {
      fs.mkdirSync(to, { recursive: true })
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name)
        const target = path.join(to, entry.name)
        if (entry.isDirectory()) copyTree(source, target)
        else if (entry.isFile()) fs.copyFileSync(source, target)
      }
    }
    copyTree(path.join(REPO_ROOT, 'lib'), path.join(copy, 'lib'))
    fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(copy, 'package.json'))
    fs.rmSync(path.join(copy, 'lib', 'core', 'memes.js'))
    const broken = await mountSelf('file://' + path.join(copy, 'lib', 'api', 'self-routes.js').replace(/\\/g, '/'))
    const degradedGet = await broken.call('/dsh-bili/api/self/memes')
    assert.equal(degradedGet.code, 200, '梗库模块缺失时 GET 仍要 200（界面照常能开）')
    assert.equal(degradedGet.payload.data.available, false, 'GET 必须如实说 available:false，实际 ' + JSON.stringify(degradedGet.payload.data).slice(0, 160))
    const degradedPost = await broken.call('/dsh-bili/api/self/meme-refresh', { method: 'POST' })
    assert.equal(degradedPost.code, 503, '梗库模块缺失时刷新必须 503，实际 ' + degradedPost.code)
    assert.match(String(degradedPost.payload.error), /未就绪/, '503 文案要说清未就绪：' + degradedPost.payload.error)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 16-18. /self/persona 结构化（§15） ══════════════════════════ */

const SECTION_BODY = (text) => String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
function sectionMap (text) {
  const body = SECTION_BODY(text)
  const matches = [...body.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)]
  const out = { preamble: matches.length === 0 ? body : body.slice(0, matches[0].index), sections: {} }
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length
    out.sections[matches[i][1].trim()] = body.slice(start, end)
  }
  return out
}

const STRUCTURED_PERSONA = [
  '---', 'name: 小鲤', 'ownerTitle: 饲主', '---',
  '前言行。', '',
  '## 一句话', '', '爱看鬼畜的大学生', '',
  '## 性格', '', '- 短句', '',
  '## 兴趣', '', '- 猫咪', '',
  '## 雷点', '', '- 带货', '',
  '## 语料', '', '- 好耶', '',
  '## 边界', '', '- 私信只发主人', '',
  '## 备注', '', '备注正文。', '',
].join('\n')

test('self /persona 结构化：GET 回 sections/notes/text；POST {sections:{interests}} → 200 且只有兴趣节变；非法 400 且文件不变', async () => {
  const env = selfEnv('self-persona-sections')
  try {
    const persona = await import(repoUrl('lib/core/persona.js'))
    persona.writePersona(STRUCTURED_PERSONA)
    const self = await mountSelf()

    // ① GET：结构化字段 + notes + 原文（排障用）
    const got = await self.call('/dsh-bili/api/self/persona')
    assert.equal(got.code, 200, 'GET 必须 200')
    const data = got.payload.data
    assert.equal(data.available, true, 'core 在就必须 available:true')
    assert.equal(typeof data.sections, 'object', 'GET 必须回 sections 对象，实际 ' + JSON.stringify(data.sections))
    for (const key of ['tagline', 'personality', 'interests', 'dislikes', 'phrases', 'boundaries']) {
      assert.ok(key in data.sections, 'sections 缺字段：' + key)
    }
    assert.deepEqual(data.sections.interests, ['猫咪'], 'sections.interests 要读出兴趣，实际 ' + JSON.stringify(data.sections.interests))
    assert.equal(data.notes, '备注正文。', 'notes 要一起回（只读）')
    assert.equal(typeof data.text, 'string', 'text 仍在（排障用）')
    assert.ok(data.text.includes('## 兴趣'), 'text 应当是整篇原文')
    const before = sectionMap(fs.readFileSync(persona.personaPath(), 'utf8'))

    // ② POST 结构化：只改兴趣节
    const saved = await self.call('/dsh-bili/api/self/persona', { method: 'POST', body: { sections: { interests: ['猫咖', '鬼畜'] } } })
    assert.equal(saved.code, 200, '合法结构化保存必须 200，实际 ' + saved.code + '：' + JSON.stringify(saved.payload))
    assert.deepEqual(saved.payload.data.changed, ['interests'], 'changed 只许含 interests，实际 ' + JSON.stringify(saved.payload.data.changed))
    const after = sectionMap(fs.readFileSync(persona.personaPath(), 'utf8'))
    assert.equal(after.sections['兴趣'], '## 兴趣\n\n- 猫咖\n- 鬼畜\n\n', '兴趣节要换成新内容')
    for (const title of ['一句话', '性格', '雷点', '语料', '边界', '备注']) {
      assert.equal(after.sections[title], before.sections[title], title + ' 必须逐字节不变')
    }
    assert.equal(after.preamble, before.preamble, '节外前言必须逐字节不变')

    // ③ 非法：一律 400 且文件字节不变
    const baseline = fs.readFileSync(persona.personaPath(), 'utf8')
    const bads = [
      ['41 项', { sections: { interests: Array.from({ length: 41 }, (_, i) => '项' + i) } }],
      ['单项 201 字', { sections: { interests: ['x'.repeat(201)] } }],
      ['tagline 201 字', { sections: { tagline: 'y'.repeat(201) } }],
      ['不是字符串数组', { sections: { interests: '猫' } }],
      ['数组里有非字符串', { sections: { interests: ['猫', 3] } }],
    ]
    for (const [label, body] of bads) {
      const bad = await self.call('/dsh-bili/api/self/persona', { method: 'POST', body })
      assert.equal(bad.code, 400, label + ' 必须 400，实际 ' + bad.code + '：' + JSON.stringify(bad.payload))
      assert.ok(typeof bad.payload.error === 'string' && bad.payload.error.length > 0, label + ' 必须给 error 文案')
      assert.equal(fs.readFileSync(persona.personaPath(), 'utf8'), baseline, label + ' 被拒后 persona.md 必须原样不动')
    }
  } finally {
    env.restore()
  }
})

test('self /persona：{sections:{notes}} 不可写（文件不变）、老形状 {text} 仍 200', async () => {
  const env = selfEnv('self-persona-notes')
  try {
    const persona = await import(repoUrl('lib/core/persona.js'))
    persona.writePersona(STRUCTURED_PERSONA)
    const self = await mountSelf()
    const baseline = fs.readFileSync(persona.personaPath(), 'utf8')

    // ① notes 只读：提交它应当"被丢弃"，且**不该把整页打红**
    //    契约（本轮 brief）：200 且文件不变；如果实现选择 400，那说明"只读字段"和"没有可写字段"
    //    这两种情况还没分开 —— 断言按契约写，红了要报告而不是放宽。
    const notes = await self.call('/dsh-bili/api/self/persona', { method: 'POST', body: { sections: { notes: '想偷偷改备注' } } })
    assert.equal(notes.code, 200, 'notes 不可写时应当 200（被丢弃），实际 ' + notes.code + '：' + JSON.stringify(notes.payload))
    assert.equal(fs.readFileSync(persona.personaPath(), 'utf8'), baseline, 'notes 不许被写进文件')

    // ② 老形状 { text } 仍然可用
    const legacy = await self.call('/dsh-bili/api/self/persona', { method: 'POST', body: { text: '# 整篇覆盖\n\n新的正文。\n' } })
    assert.equal(legacy.code, 200, '老形状 {text} 必须仍然 200，实际 ' + legacy.code + '：' + JSON.stringify(legacy.payload))
    assert.equal(fs.readFileSync(persona.personaPath(), 'utf8'), '# 整篇覆盖\n\n新的正文。\n', '老形状要整篇覆盖')
  } finally {
    env.restore()
  }
})

test('self /persona 降级：没有 writeSections 时结构化保存 503、老形状仍 200；没有 parseSections 时 GET sections:null', async () => {
  const env = selfEnv('self-persona-degraded')
  try {
    const copyLib = (dest) => {
      const copy = (from, to) => {
        fs.mkdirSync(to, { recursive: true })
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
          const source = path.join(from, entry.name)
          const target = path.join(to, entry.name)
          if (entry.isDirectory()) copy(source, target)
          else if (entry.isFile()) fs.copyFileSync(source, target)
        }
      }
      copy(path.join(REPO_ROOT, 'lib'), path.join(dest, 'lib'))
      fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(dest, 'package.json'))
      return dest
    }

    // ① 只摘 writeSections：结构化保存 503，老形状 200，GET 仍然结构化（parseSections 还在）
    const partial = copyLib(tmpDir('persona-partial'))
    const partialFile = path.join(partial, 'lib', 'core', 'persona.js')
    fs.writeFileSync(partialFile, fs.readFileSync(partialFile, 'utf8').replace('export function writeSections', 'function writeSectionsUnavailable'))
    const partialSelf = await mountSelf('file://' + path.join(partial, 'lib', 'api', 'self-routes.js').replace(/\\/g, '/'))

    const structured503 = await partialSelf.call('/dsh-bili/api/self/persona', { method: 'POST', body: { sections: { interests: ['猫'] } } })
    assert.equal(structured503.code, 503, '没有 writeSections 时结构化保存必须 503，实际 ' + structured503.code + '：' + JSON.stringify(structured503.payload))
    assert.match(String(structured503.payload.error), /未就绪/, '503 文案要说清未就绪：' + structured503.payload.error)

    const legacyOk = await partialSelf.call('/dsh-bili/api/self/persona', { method: 'POST', body: { text: '老形状还能写。\n' } })
    assert.equal(legacyOk.code, 200, '没有 writeSections 时老形状必须仍然 200，实际 ' + legacyOk.code)

    const partialGet = await partialSelf.call('/dsh-bili/api/self/persona')
    assert.equal(partialGet.code, 200, 'GET 必须仍然 200')
    assert.equal(typeof partialGet.payload.data.sections, 'object', 'parseSections 还在时 GET 应当仍有结构化字段，实际 ' + JSON.stringify(partialGet.payload.data.sections))

    // ② 两个都摘：GET 仍 200，但 sections 必须是 null（界面据此退回整篇编辑）
    const full = copyLib(tmpDir('persona-nofields'))
    const fullFile = path.join(full, 'lib', 'core', 'persona.js')
    const source = fs.readFileSync(fullFile, 'utf8')
      .replace('export function writeSections', 'function writeSectionsUnavailable')
      .replace('export function parseSections', 'function parseSectionsUnavailable')
    fs.writeFileSync(fullFile, source)
    const degraded = await mountSelf('file://' + path.join(full, 'lib', 'api', 'self-routes.js').replace(/\\/g, '/'))

    const degradedGet = await degraded.call('/dsh-bili/api/self/persona')
    assert.equal(degradedGet.code, 200, '两个函数都缺时 GET 仍必须 200（页面不能崩），实际 ' + degradedGet.code)
    assert.equal(degradedGet.payload.data.sections, null, '没有 parseSections 时 sections 必须是 null，实际 ' + JSON.stringify(degradedGet.payload.data.sections))
    assert.equal(typeof degradedGet.payload.data.text, 'string', '这时 text 仍要给（界面退回整篇编辑）')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 19-20. 多时段 + 周末全天的设置页面（§16.3） ══════════════════════════ */

test('self /settings 多时段：POST windows+weekendAllDay+weekendIntervalMin → 200 且落盘；GET /state 三个字段齐、window 仍等于 windows[0]', async () => {
  const env = selfEnv('self-windows-save')
  try {
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    schedule.unlock()
    const self = await mountSelf()
    const scheduleFile = path.join(env.selfDir, 'schedule.json')

    const WINDOWS = [{ start: '09:00', end: '12:00' }, { start: '20:00', end: '24:00' }]
    const saved = await self.call('/dsh-bili/api/self/settings', { method: 'POST', body: { windows: WINDOWS, weekendAllDay: true, weekendIntervalMin: 90 } })
    assert.equal(saved.code, 200, '合法多时段保存必须 200，实际 ' + saved.code + '：' + JSON.stringify(saved.payload))
    assert.deepEqual(saved.payload.data.saved.windows, WINDOWS, '回包要如实说这次改了 windows')
    assert.equal(saved.payload.data.saved.weekendAllDay, true, '回包要带 weekendAllDay')
    assert.equal(saved.payload.data.saved.weekendIntervalMin, 90, '回包要带 weekendIntervalMin')

    const onDisk = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'))
    assert.equal(Array.isArray(onDisk.windows), true, '落盘必须有 windows 数组')
    assert.equal(onDisk.windows.length, 2, '两个时段都要落盘，实际 ' + onDisk.windows.length)
    assert.deepEqual(onDisk.windows, WINDOWS, '落盘的时段值要原样')
    assert.equal(onDisk.weekendAllDay, true, 'weekendAllDay 要落盘')
    assert.equal(onDisk.weekendIntervalMin, 90, 'weekendIntervalMin 要落盘')
    assert.deepEqual(onDisk.window, onDisk.windows[0], '落盘的 window 必须恒等于 windows[0]')

    // GET /state：界面要能渲染时段列表与两个周末开关
    const state = await self.call('/dsh-bili/api/self/state')
    assert.equal(state.code, 200, 'GET /state 必须 200')
    const data = state.payload.data
    assert.equal(Array.isArray(data.windows), true, 'data.windows 必须是数组，实际 ' + JSON.stringify(data.windows))
    assert.equal(data.windows.length, 2, 'data.windows 应该有 2 个时段')
    assert.deepEqual(data.windows, WINDOWS, 'data.windows 的值要与落盘一致')
    assert.equal(data.weekendAllDay, true, 'data.weekendAllDay 必须是 true')
    assert.equal(data.weekendIntervalMin, 90, 'data.weekendIntervalMin 必须是 90')
    assert.deepEqual(data.window, data.windows[0], 'data.window 仍须等于 windows[0]（旧读取方）')
  } finally {
    env.restore()
  }
})

test('self /settings 多时段：7 项 / 25:00 / 起止相同 / weekendIntervalMin=0 各 400 且文件字节不变；跨午夜 [{22:00,02:00}] → 200', async () => {
  const env = selfEnv('self-windows-invalid')
  try {
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    schedule.unlock()
    const self = await mountSelf()
    const scheduleFile = path.join(env.selfDir, 'schedule.json')

    const seed = await self.call('/dsh-bili/api/self/settings', { method: 'POST', body: { windows: [{ start: '09:00', end: '12:00' }] } })
    assert.equal(seed.code, 200, '基线必须写成功，实际 ' + seed.code)
    const baseline = fs.readFileSync(scheduleFile, 'utf8')

    const bads = [
      ['7 个时段（上限 6）', { windows: Array.from({ length: 7 }, (_, i) => ({ start: '0' + (i % 10) + ':00', end: '0' + (i % 10) + ':30' })) }],
      ['end 是 25:00', { windows: [{ start: '09:00', end: '25:00' }] }],
      ['起止相同', { windows: [{ start: '09:00', end: '09:00' }] }],
      ['weekendIntervalMin=0', { weekendIntervalMin: 0 }],
    ]
    for (const [label, body] of bads) {
      const bad = await self.call('/dsh-bili/api/self/settings', { method: 'POST', body })
      assert.equal(bad.code, 400, label + ' 必须 400，实际 ' + bad.code + '：' + JSON.stringify(bad.payload))
      assert.ok(typeof bad.payload.error === 'string' && bad.payload.error.length > 0, label + ' 必须给 error 文案')
      assert.equal(fs.readFileSync(scheduleFile, 'utf8'), baseline, label + ' 被拒后日程文件必须原样不动')
    }

    // 跨午夜是**合法**写法（start > end 表示到次日），不许被当成非法
    const midnight = await self.call('/dsh-bili/api/self/settings', { method: 'POST', body: { windows: [{ start: '22:00', end: '02:00' }] } })
    assert.equal(midnight.code, 200, '跨午夜 [{22:00, 02:00}] 必须 200，实际 ' + midnight.code + '：' + JSON.stringify(midnight.payload))
    const onDisk = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'))
    assert.deepEqual(onDisk.windows, [{ start: '22:00', end: '02:00' }], '跨午夜时段要原样落盘，实际 ' + JSON.stringify(onDisk.windows))
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 21. caps 的三态（null / 0 / 数字）路由层 ══════════════════════════ */

test('self /settings caps：null 落盘成不限、0 落盘成禁止；-1 / 1.5 / "无限" 各 400 且文件字节不变', async () => {
  const env = selfEnv('self-caps')
  try {
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    schedule.unlock()
    const self = await mountSelf()
    const scheduleFile = path.join(env.selfDir, 'schedule.json')

    // ① null = 不限：必须原样落成 null（绝不能折成 0 —— 那会变成"全部禁止"）
    const unlimited = await self.call('/dsh-bili/api/self/settings', { method: 'POST', body: { caps: { comment: null } } })
    assert.equal(unlimited.code, 200, 'caps.comment=null 必须 200，实际 ' + unlimited.code + '：' + JSON.stringify(unlimited.payload))
    assert.equal(unlimited.payload.data.saved.caps.comment, null, '回包里必须是 null（不限）')
    assert.equal(JSON.parse(fs.readFileSync(scheduleFile, 'utf8')).caps.comment, null, '落盘的 caps.comment 必须是 null（不限），实际 ' + JSON.stringify(JSON.parse(fs.readFileSync(scheduleFile, 'utf8')).caps.comment))
    const baseline = fs.readFileSync(scheduleFile, 'utf8')

    // ② 非法：负数 / 小数 / 中文 —— 一律 400 且文件不动
    for (const [label, body] of [
      ['caps.comment=-1', { caps: { comment: -1 } }],
      ['caps.comment=1.5', { caps: { comment: 1.5 } }],
      ['caps.comment="无限"', { caps: { comment: '无限' } }],
    ]) {
      const bad = await self.call('/dsh-bili/api/self/settings', { method: 'POST', body })
      assert.equal(bad.code, 400, label + ' 必须 400，实际 ' + bad.code + '：' + JSON.stringify(bad.payload))
      assert.ok(typeof bad.payload.error === 'string' && bad.payload.error.length > 0, label + ' 必须给 error 文案')
      assert.equal(fs.readFileSync(scheduleFile, 'utf8'), baseline, label + ' 被拒后日程文件必须原样不动')
    }

    // ③ 0 = 禁止：合法值，必须落成 0（且与 null 是两个不同状态）
    const zero = await self.call('/dsh-bili/api/self/settings', { method: 'POST', body: { caps: { comment: 0 } } })
    assert.equal(zero.code, 200, 'caps.comment=0 必须 200（0 是"禁止"，是合法值），实际 ' + zero.code + '：' + JSON.stringify(zero.payload))
    const onDisk = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'))
    assert.equal(onDisk.caps.comment, 0, '落盘必须是 0，实际 ' + JSON.stringify(onDisk.caps.comment))
    assert.equal(schedule.loadSchedule().caps.comment, 0, '读回来也必须还是 0（不能与 null 混）')
    assert.notEqual(schedule.loadSchedule().caps.comment, null, '0 与 null 必须能区分')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 22-23. minWatchPerWake 设置（§18） ══════════════════════════ */

test('self /settings minWatchPerWake：false → 200 且落盘 false；"yes" / 1 → 400 且文件字节不变', async () => {
  const env = selfEnv('self-minwatch')
  try {
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    schedule.unlock()
    const self = await mountSelf()
    const scheduleFile = path.join(env.selfDir, 'schedule.json')

    const off = await self.call('/dsh-bili/api/self/settings', { method: 'POST', body: { minWatchPerWake: false } })
    assert.equal(off.code, 200, 'minWatchPerWake=false 必须 200，实际 ' + off.code + '：' + JSON.stringify(off.payload))
    assert.equal(off.payload.data.saved.minWatchPerWake, false, '回包要如实说这次改了它')
    assert.equal(JSON.parse(fs.readFileSync(scheduleFile, 'utf8')).minWatchPerWake, false, '必须真的落盘 false')
    assert.equal(schedule.loadSchedule().minWatchPerWake, false, '读回来也必须是 false')
    const baseline = fs.readFileSync(scheduleFile, 'utf8')

    for (const [label, body] of [['"yes"', { minWatchPerWake: 'yes' }], ['1', { minWatchPerWake: 1 }]]) {
      const bad = await self.call('/dsh-bili/api/self/settings', { method: 'POST', body })
      assert.equal(bad.code, 400, label + ' 必须 400，实际 ' + bad.code + '：' + JSON.stringify(bad.payload))
      assert.match(String(bad.payload.error), /minWatchPerWake|布尔/, '文案要说清是布尔字段：' + bad.payload.error)
      assert.equal(fs.readFileSync(scheduleFile, 'utf8'), baseline, label + ' 被拒后日程文件必须原样不动')
    }
  } finally {
    env.restore()
  }
})

test('self /state minWatchPerWake：字段缺失的旧文件 → 按 true（默认兜底开着）', async () => {
  const env = selfEnv('self-minwatch-default')
  try {
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    schedule.unlock()
    // 旧文件：根本没有 minWatchPerWake 这个键
    fs.writeFileSync(schedule.schedulePath(), JSON.stringify({ enabled: true, windows: [{ start: '09:00', end: '12:00' }], intervalMin: 45 }))
    const self = await mountSelf()
    const state = await self.call('/dsh-bili/api/self/state')
    assert.equal(state.code, 200, 'GET /state 必须 200')
    assert.equal(state.payload.data.minWatchPerWake, true, '缺字段时必须按 true（默认开着），实际 ' + JSON.stringify(state.payload.data.minWatchPerWake))
    assert.equal(schedule.loadSchedule().minWatchPerWake, true, 'loadSchedule 也要回 true')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 24. §20 的两个新开关（设置页） ══════════════════════════ */

test('self /settings §20 开关：atOwnerOnComment / bedtimeReport 可关可开并落盘；非布尔 → 400 且文件字节不变', async () => {
  const env = selfEnv('self-social-switches')
  try {
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    schedule.unlock()
    const self = await mountSelf()
    const scheduleFile = path.join(env.selfDir, 'schedule.json')

    // ① 默认都是开（§20 两个功能默认启用）
    const state = await self.call('/dsh-bili/api/self/state')
    assert.equal(state.payload.data.atOwnerOnComment, true, 'atOwnerOnComment 默认必须是 true，实际 ' + JSON.stringify(state.payload.data.atOwnerOnComment))
    assert.equal(state.payload.data.bedtimeReport, true, 'bedtimeReport 默认必须是 true，实际 ' + JSON.stringify(state.payload.data.bedtimeReport))

    // ② 一起关掉：200 且落盘
    const off = await self.call('/dsh-bili/api/self/settings', { method: 'POST', body: { atOwnerOnComment: false, bedtimeReport: false } })
    assert.equal(off.code, 200, '合法更新必须 200，实际 ' + off.code + '：' + JSON.stringify(off.payload))
    assert.deepEqual(off.payload.data.saved, { atOwnerOnComment: false, bedtimeReport: false }, '回包要如实说改了这两个')
    const onDisk = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'))
    assert.equal(onDisk.atOwnerOnComment, false, 'atOwnerOnComment 必须落盘 false')
    assert.equal(onDisk.bedtimeReport, false, 'bedtimeReport 必须落盘 false')
    assert.equal(schedule.loadSchedule().atOwnerOnComment, false, '读回来也是 false')
    const baseline = fs.readFileSync(scheduleFile, 'utf8')

    // ③ 非布尔：400 且文件不动
    for (const [label, body] of [['atOwnerOnComment=yes', { atOwnerOnComment: 'yes' }], ['bedtimeReport=1', { bedtimeReport: 1 }]]) {
      const bad = await self.call('/dsh-bili/api/self/settings', { method: 'POST', body })
      assert.equal(bad.code, 400, label + ' 必须 400，实际 ' + bad.code + '：' + JSON.stringify(bad.payload))
      assert.match(String(bad.payload.error), /布尔/, '文案要说清是布尔字段：' + bad.payload.error)
      assert.equal(fs.readFileSync(scheduleFile, 'utf8'), baseline, label + ' 被拒后日程文件必须原样不动')
    }

    // ④ 再打开：200，读回 true
    const on = await self.call('/dsh-bili/api/self/settings', { method: 'POST', body: { atOwnerOnComment: true, bedtimeReport: true } })
    assert.equal(on.code, 200)
    assert.equal(schedule.loadSchedule().bedtimeReport, true, '重新打开后必须读回 true')
  } finally {
    env.restore()
  }
})
