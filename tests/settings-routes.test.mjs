// tests/settings-routes.test.mjs —— 回归用例：设置页路由必须落在独立命名空间（真机缺陷 2026-11-01）
//
// 为什么这样测：
//   真机事故不是"路由写错"，而是**路由撞车后被静默丢弃**：鲸鱼插件先占了
//   /dsh-bili/api/status 与 /dsh-bili/api/settings，宿主的重复 (kind, path) 检查把我们的
//   register 静默丢掉，于是设置页的请求落到鲸鱼的 handler 上 → 401。
//   这种缺陷用"路由表里有我的路径"是测不出来的（撞车时根本没有进表），所以这里做两件事：
//     ① 复刻撞车现场：假 webServer 先把**旧路径**占住，register 时抛 duplicate exact route；
//        然后调 mountSettingsRoutes —— 必须一条都不抛、三条新路径全部注册成功；
//     ② 顺手钉住幂等性（HMR 场景）：同一台 server 上再挂一次，三条都算重复 →
//        必须返回空数组且不抛（实现里只吞 duplicate，别的错误仍要冒出去，这一点由 ① 之外
//        的第三个断言守住：假 server 的其它错误不许被吞）。
//   路径字符串是**逐条写死**的：换命名空间是装配契约的变化，不该被"从实现里读常量"糊过去。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { cleanupTmp, repoUrl, sandboxEnv, tmpDir } from './helpers/harness.mjs'

const NEW_PATHS = [
  '/dsh-bili/api/kernel/status',
  '/dsh-bili/api/kernel/settings',
  '/dsh-bili/api/kernel/credential',
]
/** 鲸鱼插件占住的两条旧路径（真机实测：宿主把我们的注册静默丢弃，请求落到它的 handler 上）。 */
const TAKEN_BY_OTHER_PLUGIN = ['/dsh-bili/api/status', '/dsh-bili/api/settings']

/** 假 webServer：对重复 (kind, path) 抛 duplicate exact route —— 照宿主的行为写。 */
function fakeServer (preTaken = []) {
  const routes = new Map(preTaken.map((path) => ['exact:' + path, { kind: 'exact', path, handler: () => {}, foreign: true }]))
  const attempts = []
  return {
    routes,
    attempts,
    register (route) {
      attempts.push({ kind: route.kind, path: route.path })
      const key = route.kind + ':' + route.path
      if (routes.has(key)) throw new Error('duplicate exact route: ' + route.path)
      routes.set(key, { ...route })
    },
  }
}

test('设置页路由：旧路径被别的插件占住时，三条 /dsh-bili/api/kernel/* 仍全部注册成功且不抛', async () => {
  const root = tmpDir('routes')
  const restoreEnv = sandboxEnv(root)
  try {
    const { mountSettingsRoutes } = await import(repoUrl('lib/settings-api.js'))

    const server = fakeServer(TAKEN_BY_OTHER_PLUGIN)
    const scoped = { webServer: server }
    const deps = { log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }

    let registered
    await assert.doesNotReject(
      async () => { registered = await mountSettingsRoutes(scoped, { ctx: {}, deps }) },
      '旧路径被占住时挂载绝不许抛（撞车是预期情况，不是故障）'
    )

    // ① 三条新路径全部注册成功，且返回的就是它们
    assert.deepEqual(registered, NEW_PATHS, '必须注册三条 /dsh-bili/api/kernel/* 路由，实际：' + JSON.stringify(registered))
    for (const path of NEW_PATHS) {
      assert.ok(server.routes.has('exact:' + path), '新路径没有真的进路由表：' + path)
      assert.equal(typeof server.routes.get('exact:' + path).handler, 'function', '路由必须带 handler：' + path)
      assert.equal(server.routes.get('exact:' + path).kind, 'exact', '路由 kind 必须是 exact：' + path)
    }

    // ② 我们一次都没去碰旧路径（不是"先注册失败再改注册新的"，而是从一开始就用新命名空间）
    assert.equal(server.attempts.length, 3, '应当只尝试注册三条路由，实际 ' + server.attempts.length + ' 次：' + JSON.stringify(server.attempts))
    for (const path of TAKEN_BY_OTHER_PLUGIN) {
      assert.equal(
        server.attempts.some((attempt) => attempt.path === path), false,
        '不许再尝试注册旧路径（撞车就是从这里开始的）：' + path
      )
      assert.equal(server.routes.get('exact:' + path).foreign, true, '别的插件占住的旧路径必须保持原样（我们不许覆盖它）')
    }

    // ③ HMR 幂等：同一台 server 再挂一次 → 三条都重复，返回空数组、不抛
    const second = await mountSettingsRoutes(scoped, { ctx: {}, deps })
    assert.deepEqual(second, [], '重复挂载（HMR）必须返回空数组，实际 ' + JSON.stringify(second))

    // ④ 别的错误不许被吞掉：假 server 换个错法，必须原样冒出来
    const broken = {
      register () { throw new Error('route table is corrupted') },
    }
    await assert.rejects(
      async () => mountSettingsRoutes({ webServer: broken }, { ctx: {}, deps }),
      /route table is corrupted/,
      '只有 duplicate 才允许被吞；真故障必须冒出去（否则设置页会"看着挂上了其实全没挂"）'
    )

    // ⑤ 没有 webServer（宿主没装 web 能力）→ 安静返回空数组，不影响工具
    assert.deepEqual(await mountSettingsRoutes({}, { ctx: {}, deps }), [], '没有 webServer 时必须安静返回空数组')
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})

/**
 * 假 req/res：只要 handler 走到 json(res, ...)，就能从 res.body 拿到响应体。
 * 请求头带 127.0.0.1 的 Host —— 设置页每条路由都过一道信任栅栏（回环快速通道），
 * 少了它只会拿到 403，测不到真正想测的 data。
 */
function fakeExchange (url, { method = 'GET', body } = {}) {
  const res = {
    code: 0,
    headers: null,
    body: '',
    writeHead (code, headers) { this.code = code; this.headers = headers },
    end (payload) { this.body = String(payload ?? '') },
  }
  // POST 的请求体要用**真流**：handler 走 readBody(req)，那是 req.on('data'/'end')。
  // 直接塞一个普通对象会拿到空 body（症状是"明明传了 budget 却说没有可写字段"）。
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:52771', 'content-type': 'application/json' }
  return { req, res }
}

/** 挂上设置页三条路由，并给出"像浏览器那样"调 settings 路由的两个动作。 */
async function mountSettings (root) {
  // 关键：core/config.js 的 CONFIG_PATH 在**模块加载期**就定了（DSH_BILI_CONFIG）。
  // 本文件前面的用例已经 import 过一次，那份 CONFIG_PATH 指向前一个临时目录（已删）。
  // 所以这里显式把配置路径掰到本用例的目录 —— 否则 saveConfig 会往旧目录写，
  // 症状是"POST 说成功，磁盘上却没有文件"（第一版用例就踩了这个）。
  const { setConfigPathForTest } = await import(repoUrl('lib/core/config.js'))
  const configFile = setConfigPathForTest(path.join(root, 'dsh-bili.config.json'))
  const { mountSettingsRoutes } = await import(repoUrl('lib/settings-api.js'))
  const server = fakeServer([])
  const deps = { log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }
  await mountSettingsRoutes({ webServer: server }, { ctx: {}, deps })
  const route = server.routes.get('exact:/dsh-bili/api/kernel/settings')
  assert.ok(route !== undefined, 'settings 路由必须挂上（/dsh-bili/api/kernel/settings）')
  return {
    configFile,
    async post (budget) {
      const { req, res } = fakeExchange('/dsh-bili/api/kernel/settings', { method: 'POST', body: { settings: { budget } } })
      await route.handler(req, res)
      return { code: res.code, payload: JSON.parse(res.body) }
    },
    async get () {
      const { req, res } = fakeExchange('/dsh-bili/api/kernel/settings')
      await route.handler(req, res)
      return { code: res.code, payload: JSON.parse(res.body) }
    },
  }
}

test('设置页 status 路由：data 里同时给 budget.tokenHourly 与 tokens.day.limit（INTERFACE §11）', async () => {
  const root = tmpDir('routes-status')
  const restoreEnv = sandboxEnv(root)
  try {
    const { mountSettingsRoutes } = await import(repoUrl('lib/settings-api.js'))
    const server = fakeServer([])
    const deps = { log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }
    await mountSettingsRoutes({ webServer: server }, { ctx: {}, deps })

    const route = server.routes.get('exact:/dsh-bili/api/kernel/status')
    assert.ok(route !== undefined, 'status 路由必须挂上（/dsh-bili/api/kernel/status）')

    const { req, res } = fakeExchange('/dsh-bili/api/kernel/status')
    await route.handler(req, res)
    assert.equal(res.code, 200, '回环来源的 status 请求必须 200，实际 ' + res.code)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true, '/status 必须回 { ok: true, data }')
    const data = payload.data

    // ① 预算是 token 口径：budget 直接来自 config.budget（默认 1M / 8M）
    assert.equal(typeof data.budget, 'object', 'data.budget 必须是对象')
    assert.equal(data.budget.tokenHourly, 1_000_000, 'data.budget.tokenHourly 必须来自 DEFAULTS.budget，实际 ' + data.budget.tokenHourly)
    assert.equal(data.budget.tokenDaily, 8_000_000, 'data.budget.tokenDaily 必须来自 DEFAULTS.budget，实际 ' + data.budget.tokenDaily)

    // ② 用量快照：tokens.hour / tokens.day 都带 used + limit，且带 source（账本不可用要能看出来）
    assert.equal(typeof data.tokens, 'object', 'data.tokens 必须是对象（§11.1 的 tokenStatus）')
    assert.equal(data.tokens.day.limit, 8_000_000, 'tokens.day.limit 必须等于 tokenDaily，实际 ' + data.tokens.day.limit)
    assert.equal(data.tokens.hour.limit, 1_000_000, 'tokens.hour.limit 必须等于 tokenHourly，实际 ' + data.tokens.hour.limit)
    assert.equal(typeof data.tokens.day.used, 'number', 'tokens.day.used 必须是数字')
    assert.equal(typeof data.tokens.hour.used, 'number', 'tokens.hour.used 必须是数字')
    // 沙盒里账本指向临时目录且不存在 → fail-open：source 必须如实说"没在计量"
    assert.equal(data.tokens.source, 'unavailable', '账本不存在时 tokens.source 必须是 unavailable（界面要能看出这一轮没计量），实际 ' + data.tokens.source)

    // ③ 旧的写次数配额不该再出现在"额度"位置上（它已废弃，仅兼容旧配置）
    assert.equal(data.budget.writeDaily, undefined, 'data.budget 里不该有已废弃的写次数配额')
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})

/* ────────────── token 预算输入支持带单位写法（2026-11-01 需求补充） ──────────────
 *
 * 为什么这样测：
 *   单位写法（200K / 1.5M / 2,000,000）是**给人用的输入**，但落盘的必须是整数 —— 否则
 *   tokenbudget.js 拿 "200K" 去比大小会静默按 NaN 处理，额度的方向就不可控了。
 *   所以这三条用例都同时验两头：HTTP 状态 + **磁盘配置文件里那个值到底是什么类型**，
 *   再 POST 之后用 GET 回读一次，确认"界面看到的"和"落盘的"是同一个整数。
 */

/** 契约给的六种合法写法与期望值（全部要落成整数）。 */
const ACCEPTED = [
  ['200K', 200_000],
  ['200 k', 200_000],
  ['1.5M', 1_500_000],
  ['2,000,000', 2_000_000],
  ['30M', 30_000_000],
  ['8000000', 8_000_000],
]

test('token 预算输入：200K / 200 k / 1.5M / 2,000,000 / 30M / 8000000 全部接受，落盘与回读都是整数', async () => {
  const root = tmpDir('budget-units')
  const restoreEnv = sandboxEnv(root)
  try {
    const settings = await mountSettings(root)
    for (const [input, expected] of ACCEPTED) {
      const { code, payload } = await settings.post({ tokenHourly: input })
      assert.equal(code, 200, '「' + input + '」应当被接受（200），实际 ' + code + '：' + JSON.stringify(payload).slice(0, 200))

      // 磁盘上必须是整数，值必须换算对 —— 这一条才是关键：字符串漏到磁盘会静默算错额度
      const onDisk = JSON.parse(fs.readFileSync(settings.configFile, 'utf8'))
      assert.equal(typeof onDisk.budget.tokenHourly, 'number', '「' + input + '」落盘必须是数字（不能是字符串），实际 ' + JSON.stringify(onDisk.budget))
      assert.equal(Number.isInteger(onDisk.budget.tokenHourly), true, '「' + input + '」落盘必须是整数，实际 ' + onDisk.budget.tokenHourly)
      assert.equal(onDisk.budget.tokenHourly, expected, '「' + input + '」应当换算成 ' + expected + '，实际 ' + onDisk.budget.tokenHourly)

      // GET 回读：也是整数、也是同一个值
      const read = await settings.get()
      assert.equal(read.code, 200, 'GET /settings 必须 200')
      assert.equal(typeof read.payload.data.budget.tokenHourly, 'number', 'GET 回读的 tokenHourly 必须是数字')
      assert.equal(read.payload.data.budget.tokenHourly, expected, 'GET 回读应当是 ' + expected + '，实际 ' + read.payload.data.budget.tokenHourly)
    }

    // tokenDaily 也要能带单位（顺序无关：这次只改 daily，hourly 保持上一次的值）
    const daily = await settings.post({ tokenDaily: '1.5M' })
    assert.equal(daily.code, 200, 'tokenDaily 也该接受 1.5M，实际 ' + daily.code)
    const onDisk = JSON.parse(fs.readFileSync(settings.configFile, 'utf8'))
    assert.equal(onDisk.budget.tokenDaily, 1_500_000, 'tokenDaily 落盘应当是 1500000，实际 ' + onDisk.budget.tokenDaily)
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})

test('token 预算输入：abc / 0 / -5 / 0.0001K / 1e13 一律 400，文案带示例，且配置文件不被改动', async () => {
  const root = tmpDir('budget-reject')
  const restoreEnv = sandboxEnv(root)
  try {
    const settings = await mountSettings(root)
    // 先落一个合法值，作为"拒绝时不许改文件"的基线
    const seed = await settings.post({ tokenHourly: '200K' })
    assert.equal(seed.code, 200, '基线必须写成功，实际 ' + seed.code)
    const baseline = fs.readFileSync(settings.configFile, 'utf8')

    const cases = ['abc', '0', '-5', '0.0001K', '1e13']
    for (const input of cases) {
      const { code, payload } = await settings.post({ tokenHourly: input })
      assert.equal(code, 400, '「' + input + '」必须被拒（400），实际 ' + code + '：' + JSON.stringify(payload).slice(0, 200))
      assert.ok(typeof payload.error === 'string' && payload.error.length > 0, '「' + input + '」被拒时必须给 error 文案')
      assert.match(payload.error, /200K|1\.5M/, '「' + input + '」的文案要给人看示例（200K / 1.5M 这类），实际：' + payload.error)

      // 拒绝 = 一个字节都不许动（尤其是 0 / 负数被当成 0 写进去，那等于把预算闸关掉）
      const now = fs.readFileSync(settings.configFile, 'utf8')
      assert.equal(now, baseline, '「' + input + '」被拒后配置文件必须原样不动')
    }
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})

test('token 预算输入边界：1K/1k→1000，1.99K 是 1000–2000 的整数，1e12 通过、1e12+1 拒绝', async () => {
  const root = tmpDir('budget-bounds')
  const restoreEnv = sandboxEnv(root)
  try {
    const settings = await mountSettings(root)

    for (const input of ['1K', '1k']) {
      const { code } = await settings.post({ tokenHourly: input })
      assert.equal(code, 200, '「' + input + '」应当被接受，实际 ' + code)
      const onDisk = JSON.parse(fs.readFileSync(settings.configFile, 'utf8'))
      assert.equal(onDisk.budget.tokenHourly, 1000, '「' + input + '」应当换算成 1000，实际 ' + onDisk.budget.tokenHourly)
    }

    // 1.99K：契约给的是"若实现取 1990"。实测 parseTokenAmount('1.99K') = 1990，所以这里钉死 1990。
    // 若将来取整方式改成 floor（二进制里 1.99*1000 可能落在 1989.999…）这条会红 —— 那是真的
    // 行为变化，应该重新裁决，而不是把断言放宽成"1000–2000 之间"糊过去。
    const fractional = await settings.post({ tokenHourly: '1.99K' })
    assert.equal(fractional.code, 200, '「1.99K」应当被接受（最多 2 位小数是契约里允许的写法），实际 ' + fractional.code)
    const fractionalValue = JSON.parse(fs.readFileSync(settings.configFile, 'utf8')).budget.tokenHourly
    assert.equal(Number.isInteger(fractionalValue), true, '「1.99K」落盘必须是整数，实际 ' + fractionalValue)
    assert.equal(fractionalValue, 1990, '「1.99K」应当换算成 1990（1.99 × 1000），实际 ' + fractionalValue)

    // 上限恰好通过
    const max = await settings.post({ tokenHourly: '1000000000000' })
    assert.equal(max.code, 200, '1e12（上限）应当恰好通过，实际 ' + max.code)
    assert.equal(JSON.parse(fs.readFileSync(settings.configFile, 'utf8')).budget.tokenHourly, 1_000_000_000_000, '上限值必须原样落盘')

    // 上限 +1 拒绝，并且不许改动刚才那份配置
    const baseline = fs.readFileSync(settings.configFile, 'utf8')
    const over = await settings.post({ tokenHourly: '1000000000001' })
    assert.equal(over.code, 400, '1e12+1 必须被拒（400），实际 ' + over.code)
    assert.equal(fs.readFileSync(settings.configFile, 'utf8'), baseline, '被拒之后配置文件必须原样不动')
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})
