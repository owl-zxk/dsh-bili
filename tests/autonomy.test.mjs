// tests/autonomy.test.mjs —— 自主运营层（AUTONOMY-PROMPT §11 默认档位 / §12 模块契约）
//
// 为什么这样测：
//   这一层会用主人的账号在公开场合说话，所以它最贵的错误不是"崩了"，而是**悄悄越权**：
//   没 llm 却把插件拖死、通道关了还发、私信带了 mid、额度用尽照写、同一条发两遍、
//   定时器泄漏把进程挂住。每一条都单独一个用例，全部用假 ctx / 假 llm / 假工具，
//   数据目录一律指向 os.tmpdir()（DSH_BILI_SELF_DIR），绝不碰真实 ~/.dsh、绝不联网。
//
//   另有两类断言是"装配期必须活着"的证据（a/b/c）：自主层是**可选依赖**，它的模块坏掉、
//   webServer 缺失、llm 缺席，都只能多一条 warn —— 25 个工具一个都不能少。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { REPO_ROOT, cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

/* ────────────────────────────── 装配期用的假 ctx ────────────────────────────── */

/** 假 webServer：对重复 (kind, path) 抛 duplicate exact route（照宿主的行为）。 */
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

/**
 * 假 ctx：tools.register 收集工具；logger 收集日志；inject 立刻回调并记录返回的 promise；
 * effect 收集清理函数（自主层的定时器就挂在这里）。
 */
function fakeCtx ({ server = fakeServer() } = {}) {
  const ctx = {
    tools: { register (tool) { ctx.registered.push(tool) } },
    registered: [],
    infos: [],
    warns: [],
    pending: [],
    effects: [],
    services: {},
    logger: {
      info: (message) => { ctx.infos.push(String(message)) },
      warn: (message) => { ctx.warns.push(String(message)) },
      debug: () => {},
      error: (message) => { ctx.warns.push(String(message)) },
    },
    provide (name, service) { ctx.services[name] = service },
    inject (spec, callback) {
      const scoped = { webServer: server, tools: ctx.tools, get: () => server }
      try {
        ctx.pending.push(Promise.resolve(callback(scoped)))
      } catch (error) {
        ctx.pending.push(Promise.reject(error))
      }
    },
    effect (fn) { ctx.effects.push(fn) },
    server,
  }
  return ctx
}

/** 让出若干轮事件循环（动态 import + promise 链要靠它推进；不睡真实时间）。 */
async function tickTurns (turns = 40) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** 等到 predicate 成立（有上限）；成立返回 true，超时返回 false。 */
async function waitFor (predicate, turns = 200) {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return true
    await new Promise((resolve) => setImmediate(resolve))
  }
  return predicate()
}

/* ────────────────────────────── 假工具 ────────────────────────────── */

/** 造一个假工具：记下每次调用，返回预置结果。 */
function fakeTool (name, result = { ok: true, data: {} }) {
  const tool = {
    name,
    description: name + '（测试桩）',
    calls: [],
    async execute (args) {
      tool.calls.push(args ?? {})
      return typeof result === 'function' ? result(args ?? {}) : result
    },
  }
  return tool
}

/** deps.tools 认 Map / 数组 / 对象三种形状；这里给 Map（最贴近内核里的 toolIndex）。 */
function toolBag (tools) {
  return new Map(tools.map((tool) => [tool.name, tool]))
}

/* ────────────────────────────── 环境 ────────────────────────────── */

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

/** 复制整个 lib 到临时目录（用来模拟"某个可选模块不存在"）。 */
function copyLib (dest) {
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

/* ══════════════════════════════ a. 隔离 ══════════════════════════════ */

test('隔离：ctx 没有 llm 时 apply 不抛，25 个工具照常注册，只多一条 warn', async () => {
  const env = selfEnv('aut-a')
  try {
    const plugin = await import(repoUrl('lib/index.js'))
    const ctx = fakeCtx()   // 故意不给 ctx.llm
    assert.doesNotThrow(() => plugin.apply(ctx, {}), 'apply 绝不能被自主层拖垮')
    await Promise.allSettled(ctx.pending)
    const gotWarn = await waitFor(() => ctx.warns.some((line) => /自主层/.test(line)))

    assert.equal(ctx.registered.length, 25, '25 个工具必须一个不少，实际 ' + ctx.registered.length)
    assert.ok(gotWarn, '没有 llm 时必须有一条 warn 说明自主层未启动，实际日志：' + JSON.stringify(ctx.warns))
    const autonomyWarns = ctx.warns.filter((line) => /自主层/.test(line))
    assert.equal(autonomyWarns.length, 1, '只许多一条 warn（不是每次 tick 都喊），实际 ' + JSON.stringify(autonomyWarns))
    assert.match(autonomyWarns[0], /llm/, 'warn 要说清是因为宿主没有提供 llm：' + autonomyWarns[0])
    assert.ok(ctx.services.bili !== undefined, 'ctx.bili 仍然要 provide 出来（工具与扩展都靠它）')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════════ b. apply 期自愈 ══════════════════════════════ */

test('apply 期自愈：lib/core/autonomy.js 缺失时 apply 仍成功、25 工具在、只多一条 warn', async () => {
  const env = selfEnv('aut-b')
  try {
    const dest = tmpDir('aut-b-copy')
    copyLib(dest)
    fs.rmSync(path.join(dest, 'lib', 'core', 'autonomy.js'))
    assert.equal(fs.existsSync(path.join(dest, 'lib', 'core', 'autonomy.js')), false, '前提：副本里这个模块真的没了')

    const plugin = await import('file://' + path.join(dest, 'lib', 'index.js').replace(/\\/g, '/'))
    const ctx = fakeCtx()
    ctx.llm = { chat: async () => ({ text: '{}' }) }   // 就算有 llm，模块没了也不许炸
    assert.doesNotThrow(() => plugin.apply(ctx, {}), '模块缺失只该降级，不该让整插件加载失败')
    await Promise.allSettled(ctx.pending)
    const gotWarn = await waitFor(() => ctx.warns.some((line) => /自主层/.test(line)))

    assert.equal(ctx.registered.length, 25, '自主层坏了也必须还有 25 个工具')
    assert.ok(gotWarn, '必须喊出来自主层没启动，实际日志：' + JSON.stringify(ctx.warns))
    const autonomyWarns = ctx.warns.filter((line) => /自主层/.test(line))
    assert.equal(autonomyWarns.length, 1, '只许多一条 warn，实际 ' + JSON.stringify(autonomyWarns))
    assert.match(autonomyWarns[0], /Cannot find module|ERR_MODULE_NOT_FOUND|自主层未启动/, 'warn 要能看出是模块加载失败：' + autonomyWarns[0])
  } finally {
    env.restore()
  }
})

/* ══════════════════════════════ c. 路由挂载 ══════════════════════════════ */

test('路由挂载：kernel 3 条 + self 8 条 = 11；self-routes 缺失时仍 3 条 + 25 工具 + warn', async () => {
  const env = selfEnv('aut-c')
  try {
    const KERNEL = ['/dsh-bili/api/kernel/status', '/dsh-bili/api/kernel/settings', '/dsh-bili/api/kernel/credential']
    // self 现在 8 条（§14.5 加了 profile / memes / meme-refresh）。逐条列出来，别只断言数量 ——
    // 数字对但路径换了是发生在"用户点开那一页 404"之后才会被发现的事。
    const SELF = [
      '/dsh-bili/api/self/state',
      '/dsh-bili/api/self/settings',
      '/dsh-bili/api/self/persona',
      '/dsh-bili/api/self/run-once',
      '/dsh-bili/api/self/audit',
      '/dsh-bili/api/self/profile',
      '/dsh-bili/api/self/memes',
      '/dsh-bili/api/self/meme-refresh',
    ]

    // ① 两个模块都在：8 条路由全部挂上
    {
      const plugin = await import(repoUrl('lib/index.js'))
      const ctx = fakeCtx()
      plugin.apply(ctx, {})
      await Promise.allSettled(ctx.pending)
      await waitFor(() => SELF.every((p) => ctx.server.routes.has('exact:' + p)))
      for (const p of KERNEL) assert.ok(ctx.server.routes.has('exact:' + p), 'kernel 路由没挂上：' + p)
      for (const p of SELF) assert.ok(ctx.server.routes.has('exact:' + p), '自主层路由没挂上：' + p)
      assert.equal(ctx.server.routes.size, 11, '一共 11 条（kernel 3 + self 8），实际 ' + ctx.server.routes.size + '：' + [...ctx.server.routes.keys()].join(' '))
      assert.equal(ctx.registered.length, 25)
    }

    // ② self-routes 缺失：kernel 3 条照挂，24 工具照在，只多一条 warn
    {
      const dest = tmpDir('aut-c-copy')
      copyLib(dest)
      fs.rmSync(path.join(dest, 'lib', 'api', 'self-routes.js'))
      const plugin = await import('file://' + path.join(dest, 'lib', 'index.js').replace(/\\/g, '/'))
      const ctx = fakeCtx()
      assert.doesNotThrow(() => plugin.apply(ctx, {}))
      await Promise.allSettled(ctx.pending)
      await waitFor(() => ctx.warns.some((line) => /路由未挂载/.test(line)))
      for (const p of KERNEL) assert.ok(ctx.server.routes.has('exact:' + p), 'self-routes 挂了不该连累 kernel 路由：' + p)
      assert.equal(ctx.server.routes.size, 3, '只剩 kernel 3 条，实际 ' + ctx.server.routes.size)
      assert.equal(ctx.registered.length, 25, '路由少了几条也必须还有 25 个工具')
      const selfWarns = ctx.warns.filter((line) => /路由未挂载/.test(line))
      assert.equal(selfWarns.length, 1, '自愈只许一条 warn，实际 ' + JSON.stringify(selfWarns))
    }
  } finally {
    env.restore()
  }
})

/* ══════════════════════════════ d. 动作六道闸 ══════════════════════════════ */

test('动作六道闸：白名单 / 通道开关 / 私信 owner-only / caps / 每次醒来 K=2 / 去重，逐条断言工具没被调用', async () => {
  const env = selfEnv('aut-d')
  try {
    const { runActions } = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    schedule.unlock()

    const tools = {
      comment: fakeTool('bili_comment'),
      del: fakeTool('bili_comment_del'),
      dm: fakeTool('bili_dm'),
      status: fakeTool('bili_status', { ok: true, data: { tokens: { source: 'ledger' }, client: { banned: false } } }),
    }
    const deps = { tools: toolBag(Object.values(tools)), log: () => {} }
    const zeroCounts = () => patchState({ counters: {} })

    // ① 白名单：bili_comment_del 不在 §5 名单里
    zeroCounts()
    schedule.saveSchedule({ allows: { comment: true } })
    const whitelist = await runActions({ ok: true, actions: [{ tool: 'bili_comment_del', args: { oid: '1', rpid: '2' } }] }, deps)
    assert.deepEqual(whitelist.skipped, [{ tool: 'bili_comment_del', why: 'whitelist' }], '白名单外的工具必须被拒')
    assert.equal(tools.del.calls.length, 0, '白名单外的工具一次都不许被调用')

    // ② 通道开关：默认档位 allows.comment = false
    zeroCounts()
    schedule.saveSchedule({ allows: { comment: false } })
    const channelOff = await runActions({ ok: true, actions: [{ tool: 'bili_comment', args: { oid: '1', message: '关了就别发' } }] }, deps)
    assert.deepEqual(channelOff.skipped, [{ tool: 'bili_comment', why: 'channel-off' }], '通道关掉的动作必须丢弃并记 channel-off')
    assert.equal(tools.comment.calls.length, 0, '通道关掉时工具绝不许被调用')

    // ③ 私信硬限制：args 里出现任何"收件人"字段 → 整条丢弃（不是过滤一下）
    zeroCounts()
    schedule.saveSchedule({ allows: { dm: true }, caps: { dm: 4 } })
    const ownerOnly = await runActions({ ok: true, actions: [{ tool: 'bili_dm', args: { text: '想发给别人', mid: '123456' } }] }, deps)
    assert.deepEqual(ownerOnly.skipped, [{ tool: 'bili_dm', why: 'owner-only' }], '带 mid 的私信必须整条丢弃')
    assert.equal(tools.dm.calls.length, 0, '带收件人参数的私信绝不许发出去')

    // ④ caps 用尽：今天已经发满 dm 上限
    zeroCounts()
    schedule.saveSchedule({ allows: { dm: true }, caps: { dm: 1 } })
    schedule.bumpCount('dm')
    const capped = await runActions({ ok: true, actions: [{ tool: 'bili_dm', args: { text: '超额的一条' } }] }, deps)
    assert.deepEqual(capped.skipped, [{ tool: 'bili_dm', why: 'cap' }], '每日上限用尽必须拒')
    assert.equal(tools.dm.calls.length, 0, '上限用尽时一条都不许发')

    // ⑤ 每次醒来最多 K=2 条写
    zeroCounts()
    schedule.saveSchedule({ allows: { dm: true }, caps: { dm: 10 } })
    const burst = await runActions({
      ok: true,
      actions: [
        { tool: 'bili_dm', args: { text: '第一条' } },
        { tool: 'bili_dm', args: { text: '第二条' } },
        { tool: 'bili_dm', args: { text: '第三条' } },
      ],
    }, deps)
    assert.equal(burst.executed.length, 2, '一次醒来最多 2 条写动作，实际 ' + burst.executed.length)
    assert.deepEqual(burst.skipped, [{ tool: 'bili_dm', why: 'wake-budget' }], '第 3 条必须记 wake-budget')
    assert.equal(tools.dm.calls.length, 2, '被 wake-budget 挡下的那条不许被调用，实际调用 ' + tools.dm.calls.length + ' 次')

    // ⑥ 去重：同一段正文第二次
    tools.dm.calls.length = 0
    zeroCounts()
    schedule.saveSchedule({ allows: { dm: true }, caps: { dm: 10 } })
    const once = await runActions({ ok: true, actions: [{ tool: 'bili_dm', args: { text: '同样一句话' } }] }, deps)
    assert.equal(once.executed.length, 1, '第一次应当执行')
    const twice = await runActions({ ok: true, actions: [{ tool: 'bili_dm', args: { text: '同样一句话' } }] }, deps)
    assert.deepEqual(twice.skipped, [{ tool: 'bili_dm', why: 'duplicate' }], '同正文第二次必须记 duplicate')
    assert.equal(tools.dm.calls.length, 1, '重复的那次绝不许再调用工具，实际调用 ' + tools.dm.calls.length + ' 次')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════════ e. 默认档位 ══════════════════════════════ */

test('默认档位：只读执行、5 个写动作全部 skipped（reason 明确），与 §11 的 allows 一致', async () => {
  const env = selfEnv('aut-e')
  try {
    const { runActions } = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    schedule.unlock()

    const allows = schedule.loadSchedule().allows
    assert.deepEqual(allows, { read: true, dm: true, comment: false, reply: false, dynamic: false, like: false, follow: false }, '默认档位必须是「只读 + 私信主人」，实际 ' + JSON.stringify(allows))

    const watch = fakeTool('bili_watch', { ok: true, data: { count: 1, items: [] } })
    const writes = [fakeTool('bili_comment'), fakeTool('bili_reply'), fakeTool('bili_dynamic'), fakeTool('bili_like'), fakeTool('bili_follow')]
    const status = fakeTool('bili_status', { ok: true, data: { tokens: { source: 'ledger' } } })
    const deps = { tools: toolBag([watch, status, ...writes]), log: () => {} }

    const outcome = await runActions({
      ok: true,
      actions: [
        { tool: 'bili_watch', args: { limit: 2 } },
        { tool: 'bili_comment', args: { bvid: 'BV1GJ411x7h7', message: '默认档位不该发' } },
        { tool: 'bili_reply', args: { bvid: 'BV1GJ411x7h7', root: '1', rpid: '2', message: 'x' } },
        { tool: 'bili_dynamic', args: { text: 'x' } },
        { tool: 'bili_like', args: { bvid: 'BV1GJ411x7h7' } },
        { tool: 'bili_follow', args: { mid: '9' } },
      ],
    }, deps)

    assert.deepEqual(outcome.executed.map((item) => item.tool), ['bili_watch'], '默认档位下只有只读动作该执行，实际 ' + JSON.stringify(outcome.executed))
    assert.equal(watch.calls.length, 1, '只读动作必须真的跑了一次')
    // 五个写动作都在白名单里（follow 2026-11-01 起在），所以它们撞的是 §11 的通道开关：
    // 默认 allows.follow=false → channel-off（不是 whitelist）。
    assert.deepEqual(
      outcome.skipped.map((item) => ({ tool: item.tool, why: item.why })),
      [
        { tool: 'bili_comment', why: 'channel-off' },
        { tool: 'bili_reply', why: 'channel-off' },
        { tool: 'bili_dynamic', why: 'channel-off' },
        { tool: 'bili_like', why: 'channel-off' },
        { tool: 'bili_follow', why: 'channel-off' },
      ],
      '5 个写动作必须全部被挡下且 reason 明确，实际 ' + JSON.stringify(outcome.skipped)
    )
    for (const tool of writes) assert.equal(tool.calls.length, 0, '默认档位下 ' + tool.name + ' 一次都不许被调用')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════════ f. 预算 ══════════════════════════════ */

test('预算：bili_status 报 token-budget-exhausted → 写工具调用 0 次', async () => {
  const env = selfEnv('aut-f')
  try {
    const { runActions } = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState, readState } = await import(repoUrl('lib/core/state.js'))
    schedule.unlock()
    patchState({ counters: {}, silenceUntil: 0 })
    schedule.saveSchedule({ allows: { comment: true, dm: true }, caps: { comment: 6, dm: 4 } })

    const comment = fakeTool('bili_comment')
    const dm = fakeTool('bili_dm')
    const status = fakeTool('bili_status', {
      ok: true,
      data: { tokens: { source: 'ledger', note: 'token-budget-exhausted', day: { used: 9e6, limit: 8e6 } }, client: { banned: false } },
    })
    const deps = { tools: toolBag([comment, dm, status]), log: () => {} }

    const outcome = await runActions({
      ok: true,
      actions: [
        { tool: 'bili_comment', args: { bvid: 'BV1GJ411x7h7', message: '预算没了别发' } },
        { tool: 'bili_dm', args: { text: '预算没了也别发' } },
      ],
    }, deps)

    assert.equal(outcome.executed.length, 0, '预算耗尽时一条写动作都不该执行')
    assert.deepEqual(outcome.skipped.map((item) => item.why), ['token-budget-exhausted', 'token-budget-exhausted'], 'reason 必须是 token-budget-exhausted，实际 ' + JSON.stringify(outcome.skipped))
    assert.equal(comment.calls.length, 0, '预算耗尽时 bili_comment 不许被调用')
    assert.equal(dm.calls.length, 0, '预算耗尽时 bili_dm 不许被调用')
    assert.ok(Number(readState().silenceUntil ?? 0) === 0, '只是跳过一次，不该顺手把自己静默掉（静默由真正的失败/风控触发）')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════════ g. 大脑降级 ══════════════════════════════ */

test('大脑降级：坏 JSON 只重试 1 次（共 2 次调用）→ brain-parse-failed；没有 stream 函数 → llm-unavailable', async () => {
  const env = selfEnv('aut-g')
  try {
    const { decide } = await import(repoUrl('lib/core/brain.js'))

    let calls = 0
    const badLlm = {
      // 宿主 llm 的流式形态（brain.js 只认这一种）：async generator，分片是
      // { type:'text', text } / { type:'finish', reason }。这里吐的是**不是 JSON** 的文本。
      async *stream () {
        calls += 1
        yield { type: 'text-delta', text: '我不太想按 JSON 回答，随便说两句吧。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const failed = await decide({ trigger: 'timer', deps: { tools: toolBag([]) }, llm: badLlm })
    assert.equal(failed.ok, false, '解析不出来时必须降级，绝不能把一段散文当成决策')
    assert.equal(failed.reason, 'brain-parse-failed', 'reason 必须是 brain-parse-failed，实际 ' + failed.reason)
    assert.equal(calls, 2, '解析失败只重试 1 次（总调用 2 次），实际 ' + calls + ' 次')

    // 宿主 llm 的形态完全对不上（没有 chat/complete/generate/ask/stream）
    const unknown = await decide({ trigger: 'timer', deps: { tools: toolBag([]) }, llm: { prepareCall () {} } })
    assert.equal(unknown.ok, false, '形态不认识时必须降级')
    assert.equal(unknown.reason, 'llm-unavailable', 'reason 必须是 llm-unavailable，实际 ' + unknown.reason)

    // 连 llm 都没有
    const missing = await decide({ trigger: 'timer', deps: { tools: toolBag([]) } })
    assert.equal(missing.reason, 'llm-unavailable', '没有 llm 时也必须是一个可预期的 reason')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════════ h. 数据层 ══════════════════════════════ */

test('数据层：记忆 2001→2000 滚动、日记追加不覆盖、审计不含凭据且正文 ≤80、坏 state 回默认不抛', async () => {
  const env = selfEnv('aut-h')
  try {
    const memory = await import(repoUrl('lib/core/memory.js'))
    const diary = await import(repoUrl('lib/core/diary.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    const state = await import(repoUrl('lib/core/state.js'))
    fs.mkdirSync(env.selfDir, { recursive: true })

    // ① 记忆滚动：先铺满 2000 行，再追加 1 条 → 仍是 2000，最老那条被挤掉
    const seed = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ at: new Date().toISOString(), kind: 'event', text: 'line-' + (i + 1), ref: null }))
    fs.writeFileSync(memory.memoryPath(), seed.join('\n') + '\n')
    const appended = memory.appendMemory({ kind: 'thought', text: '第 2001 条' })
    assert.equal(appended.ok, true, '追加必须成功，实际 ' + JSON.stringify(appended))
    assert.equal(memory.memoryCount(), 2000, '记忆上限是 2000 行，实际 ' + memory.memoryCount())
    const recent = memory.recentMemory(2000)
    assert.equal(recent[0].text, 'line-2', '滚动后最老的一条应当被挤掉（首条变成 line-2），实际 ' + recent[0].text)
    assert.equal(recent[recent.length - 1].text, '第 2001 条', '最新一条必须在末尾')

    // ② 日记：同一天追加两次，不覆盖
    const first = diary.appendDiary('第一段：今天刷了会儿视频')
    const second = diary.appendDiary('第二段：回了主人一条私信')
    assert.equal(first.ok, true); assert.equal(second.ok, true)
    assert.equal(first.path, second.path, '同一天必须是同一个日记文件')
    const text = fs.readFileSync(first.path, 'utf8')
    assert.match(text, /^# \d{4}-\d{2}-\d{2}/, '首行应当是当天日期标题')
    assert.match(text, /第一段：今天刷了会儿视频/, '第一次写的内容必须还在（追加不是覆盖）')
    assert.match(text, /第二段：回了主人一条私信/, '第二次写的内容也要在')
    assert.match(diary.todayDiary(10), /第二段/, 'todayDiary 要能读到今天的追加')

    // ③ 审计：凭据按键名/形状脱敏，正文/备注各截到 80 字
    const longText = '很长的正文'.repeat(60)
    const auditResult = audit.appendAudit({
      tool: 'bili_dm',
      args: {
        text: longText,
        bvid: 'BV1GJ411x7h7',
        cookie: 'SESSDATA=THIS-MUST-NOT-APPEAR',
        sessdata: 'THIS-MUST-NOT-APPEAR-EITHER',
        bili_jct: '0123456789abcdef0123456789abcdef',
      },
      why: '因为'.repeat(80),
      result: { ok: true },
    })
    assert.equal(auditResult.ok, true, '审计写入必须成功，实际 ' + JSON.stringify(auditResult))
    const row = audit.readAudit(1)[0]
    assert.equal(row.args.cookie, '***', '键名像凭据的必须脱敏')
    assert.equal(row.args.sessdata, '***', 'sessdata 必须脱敏')
    assert.equal(row.args.bili_jct, '***', '32 位十六进制（bili_jct 的形状）必须脱敏')
    assert.ok(row.args.text.length <= audit.TEXT_MAX + 1, '正文必须截到 80 字（含省略号 ≤81），实际 ' + row.args.text.length)
    assert.ok(row.why.length <= audit.TEXT_MAX + 1, '备注同样要截断，实际 ' + row.why.length)
    const raw = fs.readFileSync(audit.auditPath(), 'utf8')
    for (const secret of ['THIS-MUST-NOT-APPEAR', '0123456789abcdef0123456789abcdef']) {
      assert.equal(raw.includes(secret), false, '审计文件里不许出现凭据值：' + secret)
    }

    // ④ state 坏 JSON：读回默认 {}，不抛；之后还能写
    fs.writeFileSync(state.statePath(), '{ 这不是 JSON')
    assert.deepEqual(state.readState(), {}, '坏 state 必须安静回默认空对象')
    state.patchState({ mood: '平静' })
    assert.equal(state.readState().mood, '平静', '坏文件之后仍要能重新写进去')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════════ i. 单飞锁 ══════════════════════════════ */

test('单飞锁：并发两次 runOnce → 第二次 busy，且动作只执行一次', async () => {
  const env = selfEnv('aut-i')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    schedule.unlock()
    autonomy.stop()
    patchState({ counters: {}, silenceUntil: 0 })
    schedule.saveSchedule({ allows: { comment: true }, caps: { comment: 5 } })

    let release = null
    const gate = new Promise((resolve) => { release = resolve })
    const comment = fakeTool('bili_comment')
    let llmCalls = 0
    const llm = {
      async *stream () {
        llmCalls += 1
        await gate                       // 第一次醒来卡在这里，需要外部放行
        yield { type: 'text-delta', text: JSON.stringify({ mood: '平静', say: '看一眼', actions: [{ tool: 'bili_comment', args: { bvid: 'BV1GJ411x7h7', message: '只发一次' } }], diary: '', memory: [] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const deps = { tools: toolBag([comment]), llm, log: () => {}, ctx: {} }

    const first = autonomy.runOnce('manual', deps)
    await tickTurns(5)                  // 让第一个 tick 真的进到"占着锁"的状态
    const second = await autonomy.runOnce('manual', deps)
    assert.equal(second.ok, false, '重叠的第二次醒来必须失败')
    assert.equal(second.reason, 'busy', '第二次必须是 busy（单飞锁），实际 ' + second.reason)
    assert.deepEqual(second.executed, [], 'busy 的那次不许执行任何动作')

    release()
    const settled = await first
    assert.equal(settled.ok, true, '第一个 tick 应当完成，实际 ' + JSON.stringify(settled).slice(0, 200))
    assert.equal(comment.calls.length, 1, '动作只能执行一次（并发不该变成两次发言），实际 ' + comment.calls.length)
    assert.equal(llmCalls, 1, '只该花一次 LLM 调用，实际 ' + llmCalls)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════════ j. 定时器释放 ══════════════════════════════ */

test('定时器释放：start 后注册了 interval，stop 后全部 clear；重复 start 先停旧的', async () => {
  const env = selfEnv('aut-j')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    autonomy.stop()

    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    const intervals = []
    const cleared = []
    let seq = 0
    globalThis.setInterval = (fn, ms) => { const id = ++seq; intervals.push({ id, ms }); return id }
    globalThis.clearInterval = (id) => { cleared.push(id) }
    try {
      const effects = []
      const ctx = { effect: (fn) => { effects.push(fn) }, get: () => null }
      const started = autonomy.start(ctx, { log: () => {} }, { llm: { chat: async () => ({ text: '{}' }) } })
      assert.equal(started.started, true, '有 llm 时必须启动成功，实际 ' + JSON.stringify(started))
      assert.equal(intervals.length, 2, '计划器 + 事件轮询 = 2 个 interval，实际 ' + intervals.length)
      assert.equal(effects.length, 2, '两个 interval 都必须挂到 ctx.effect 上（卸载才能自动清理）')

      autonomy.stop()
      assert.equal(cleared.length, 2, 'stop() 必须 clear 掉全部 interval，实际 ' + cleared.length)
      assert.deepEqual(cleared.slice().sort(), intervals.map((item) => item.id).sort(), '清掉的必须正是注册过的那两个')

      // 重复 start：必须先把旧的停掉，再注册新的（否则热重载会一轮多一份定时器）
      const before = { intervals: intervals.length, cleared: cleared.length }
      autonomy.start(ctx, { log: () => {} }, { llm: { chat: async () => ({ text: '{}' }) } })
      autonomy.start(ctx, { log: () => {} }, { llm: { chat: async () => ({ text: '{}' }) } })
      assert.equal(intervals.length - before.intervals, 4, '两次 start 各注册 2 个 interval，实际新增 ' + (intervals.length - before.intervals))
      assert.equal(cleared.length - before.cleared, 2, '第二次 start 前必须把第一次的两个清掉，实际清掉 ' + (cleared.length - before.cleared))
      autonomy.stop()
      assert.equal(cleared.length - before.cleared, 4, '最终 stop 要清掉最后两个')
    } finally {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
      autonomy.stop()
    }
  } finally {
    env.restore()
  }
})

/* ────────────── follow 与白名单：三条语义（2026-11-01 契约） ──────────────
 *
 * follow 进了白名单之后，它就和其他写通道一样受 allows/caps 管；而 bili_image_upload
 * 被移出白名单（它产出的是图床地址、不是公开表态，不该让模型随手用她的账号传图）。
 * 这三条都断言**工具调用次数**，不只看 reason —— 原因写错了还能改，真把请求发出去就收不回。
 */

test('follow 默认关：allows.follow=false → 不调用 bili_follow，why=channel-off', async () => {
  const env = selfEnv('follow-default')
  try {
    const { runActions } = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    schedule.unlock()
    patchState({ counters: {} })

    assert.equal(schedule.loadSchedule().allows.follow, false, '前提：默认 allows.follow=false（§11）')
    const follow = fakeTool('bili_follow')
    const deps = { tools: toolBag([follow]), log: () => {} }

    const outcome = await runActions({ ok: true, actions: [{ tool: 'bili_follow', args: { mid: '9', action: 'follow' } }] }, deps)
    assert.deepEqual(outcome.skipped, [{ tool: 'bili_follow', why: 'channel-off' }], '默认关掉时必须记 channel-off，实际 ' + JSON.stringify(outcome.skipped))
    assert.equal(follow.calls.length, 0, '默认关掉时 bili_follow 一次都不许被调用，实际 ' + follow.calls.length + ' 次')
  } finally {
    env.restore()
  }
})

test('follow 打开但 caps.follow=1：第一次执行、第二次 why=cap（且工具只被调用一次）', async () => {
  const env = selfEnv('follow-cap')
  try {
    const { runActions } = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    schedule.unlock()
    patchState({ counters: {} })
    schedule.saveSchedule({ allows: { follow: true }, caps: { follow: 1 } })

    const follow = fakeTool('bili_follow')
    const deps = { tools: toolBag([follow]), log: () => {} }

    const first = await runActions({ ok: true, actions: [{ tool: 'bili_follow', args: { mid: '9', action: 'follow' } }] }, deps)
    assert.equal(first.executed.length, 1, '开关打开且额度未满时应当执行，实际 ' + JSON.stringify(first))
    assert.equal(first.executed[0].ok, true, '第一次应当成功')
    assert.equal(follow.calls.length, 1, '第一次应当真的调用一次工具')

    const second = await runActions({ ok: true, actions: [{ tool: 'bili_follow', args: { mid: '10', action: 'follow' } }] }, deps)
    assert.deepEqual(second.skipped, [{ tool: 'bili_follow', why: 'cap' }], '超过 caps.follow=1 之后必须记 cap，实际 ' + JSON.stringify(second.skipped))
    assert.equal(follow.calls.length, 1, '被 caps 挡下的那次绝不许再调用工具，实际 ' + follow.calls.length + ' 次')
  } finally {
    env.restore()
  }
})

test('bili_image_upload 不在白名单：决策里出现它也 why=whitelist 且零调用', async () => {
  const env = selfEnv('image-not-whitelisted')
  try {
    const { runActions, WHITELIST } = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    schedule.unlock()
    assert.equal(WHITELIST.includes('bili_image_upload'), false, '前提：bili_image_upload 不在动作白名单里')

    const upload = fakeTool('bili_image_upload')
    const deps = { tools: toolBag([upload]), log: () => {} }
    const outcome = await runActions({ ok: true, actions: [{ tool: 'bili_image_upload', args: { path: '/tmp/x.png' } }] }, deps)

    assert.deepEqual(outcome.skipped, [{ tool: 'bili_image_upload', why: 'whitelist' }], '白名单外的工具必须记 whitelist，实际 ' + JSON.stringify(outcome.skipped))
    assert.equal(upload.calls.length, 0, '白名单外的工具一次都不许被调用，实际 ' + upload.calls.length + ' 次')
  } finally {
    env.restore()
  }
})

/* ────────────── 宿主真实分片协议：block-end 也算文本；空输出要能自证 ──────────────
 *
 * 为什么补这两条：2026-11-01 真机事故是"调到了、路由通了、但界面一直说解析失败"，
 * 根因是把 **block 的 type** 当成了 **chunk 的 type**（只认 {type:'text'}，而宿主发的是
 * {type:'text-delta'} 与 {type:'block-end', block:{type:'text'}}）。所以：
 *   ① block-end（整块文本）必须能解析成功 —— 有的适配器只发整块、不发增量；
 *   ② 空输出与非 JSON 必须能**区分**：空输出写「（空输出）」，非空把模型原文前 200 字符带上。
 *      否则下次再出事故，日志里还是只有一句"解析失败"，又要靠猜。
 */

test('chunk 协议：只发 block-end（整块文本）也能解析成功，字段完整', async () => {
  const env = selfEnv('chunk-block-end')
  try {
    const { decide } = await import(repoUrl('lib/core/brain.js'))
    const payload = { mood: '好奇', say: '看看就好', actions: [{ tool: 'bili_watch', args: { limit: 2 }, why: '想刷' }], diary: '今天很安静', memory: ['记住了这条'] }
    let calls = 0
    const llm = {
      async *stream () {
        calls += 1
        // 只发整块，不发任何增量 —— 这正是宿主 block-end 的形态
        yield { type: 'block-end', block: { type: 'text', text: JSON.stringify(payload) } }
        yield { type: 'finish', reason: { kind: 'ok' } }
      },
    }
    const result = await decide({ trigger: 'manual', deps: { tools: new Map() }, llm })

    assert.equal(result.ok, true, 'block-end 形态必须解析成功，实际 ' + JSON.stringify(result).slice(0, 200))
    assert.equal(calls, 1, '一次就解析成功时不该重试，实际 ' + calls + ' 次')
    assert.equal(result.mood, '好奇', 'mood 要透出')
    assert.equal(result.say, '看看就好', 'say 要透出')
    assert.deepEqual(result.actions, [{ tool: 'bili_watch', args: { limit: 2 }, why: '想刷' }], 'actions 要原样透出（含 args 与 why）')
    assert.equal(result.diary, '今天很安静', 'diary 要透出')
    assert.deepEqual(result.memory, ['记住了这条'], 'memory 要透出')
    // block 的 type 不是 text（例如 tool_use 块）时不该被当成正文。
    // 这里故意给 tool_use 块塞一段"像 JSON 但不是我们要的"的 text：如果实现只看 chunk.type
    // 就把 block.text 拼进来，正文会变成两段 JSON 粘在一起 → 解析失败 → 下面的 ok:true 会红。
    const otherBlocks = {
      async *stream () {
        yield { type: 'block-end', block: { type: 'tool_use', id: 'x', text: '{"不是正文":true}' } }
        yield { type: 'block-end', block: { type: 'text', text: JSON.stringify(payload) } }
        yield { type: 'finish', reason: { kind: 'ok' } }
      },
    }
    const second = await decide({ trigger: 'manual', deps: { tools: new Map() }, llm: otherBlocks })
    assert.equal(second.ok, true, '只有 type=text 的块才算正文，其它块要被忽略而不是拼进 JSON')
    assert.equal(second.say, '看看就好')
  } finally {
    env.restore()
  }
})

test('空输出 vs 非 JSON：both 降级 brain-parse-failed，但 state.lastLlmFailure.detail 要能区分', async () => {
  const env = selfEnv('chunk-diagnose')
  try {
    const { decide } = await import(repoUrl('lib/core/brain.js'))
    const { readState } = await import(repoUrl('lib/core/state.js'))
    const deps = { tools: new Map() }

    // ① 只发 finish：一个字都没吐 → detail 里必须出现「（空输出）」
    const silent = {
      async *stream () {
        yield { type: 'finish', reason: { kind: 'ok' } }
      },
    }
    const empty = await decide({ trigger: 'manual', deps, llm: silent })
    assert.equal(empty.ok, false, '一个字都没有时必须降级')
    assert.equal(empty.reason, 'brain-parse-failed', 'reason 必须是 brain-parse-failed，实际 ' + empty.reason)
    const emptyState = readState().lastLlmFailure
    assert.ok(emptyState !== undefined && emptyState !== null, '必须把这次失败记进 state.lastLlmFailure（否则排障只能靠猜）')
    assert.equal(emptyState.reason, 'brain-parse-failed', 'state 里的 reason 要与返回值一致')
    assert.match(String(emptyState.detail), /（空输出）/, '空输出的 detail 必须带「（空输出）」标记，实际 ' + emptyState.detail)

    // ② 非空但不是 JSON：detail 里要带模型原文（前 200 字符）
    const SENTINEL = '哨兵文本-SENTINEL-42：我不想按格式回答'
    const talkative = {
      async *stream () {
        yield { type: 'text-delta', text: SENTINEL }
        yield { type: 'finish', reason: { kind: 'ok' } }
      },
    }
    const garbled = await decide({ trigger: 'manual', deps, llm: talkative })
    assert.equal(garbled.ok, false, '非 JSON 也必须降级')
    assert.equal(garbled.reason, 'brain-parse-failed')
    const garbledState = readState().lastLlmFailure
    assert.match(String(garbledState.detail), new RegExp(SENTINEL), '非空输出的 detail 必须带上模型原文（前 200 字符），实际 ' + garbledState.detail)
    assert.equal(/（空输出）/.test(String(garbledState.detail)), false, '非空输出不该被标成「（空输出）」——两者必须能区分')
  } finally {
    env.restore()
  }
})

/* ────────────── brain 上下文：指标要真的进了 prompt（§14.3） ──────────────
 *
 * 为什么这条值得单独测：指标如果只落在 state.json 里、没进 prompt，那"她会累、会被腻到"
 * 对模型就是零信息 —— 行为报告里看不出区别，但她的台词会永远像第一天。
 * 上下文是纯函数拼的，所以直接把 llm.stream(options) 的 options 存下来断言即可，不用抓网络。
 */

test('brain 上下文：【我的状态】就是 describe() 的输出（含六项数字），【最近变化】不为空，system 写明不许自己编数字', async () => {
  const env = selfEnv('brain-context')
  try {
    const { decide } = await import(repoUrl('lib/core/brain.js'))
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))

    // 造一个确定的指标状态 + 两条最近变化（这样子行为不依赖默认值）
    patchState({ metrics: { energy: 42, mood: 37, curiosity: 61, affinity: 52, boredom: 33, confidence: 44 }, metricsHistory: [] })
    metrics.applyEvent('action-ok')
    metrics.applyEvent('interest-hit')
    const expected = metrics.describe(metrics.readMetrics())

    const seen = []
    const llm = {
      async *stream (options) {
        seen.push(options)
        yield { type: 'text-delta', text: JSON.stringify({ mood: '平静', say: '', actions: [], diary: '', memory: [] }) }
        yield { type: 'finish', reason: { kind: 'ok' } }
      },
    }
    const result = await decide({ trigger: 'manual', deps: { tools: new Map() }, llm })
    assert.equal(result.ok, true, '正常 JSON 应当解析成功，实际 ' + JSON.stringify(result).slice(0, 160))
    assert.equal(seen.length, 1, '一次调用')

    const user = seen[0].messages[0].content[0].text
    assert.match(user, /【我的状态】/, 'user 上下文里必须有【我的状态】')
    assert.match(user, /【最近变化】/, 'user 上下文里必须有【最近变化】')

    const lines = user.split('\n')
    const stateLine = lines.find((line) => line.startsWith('【我的状态】'))
    assert.ok(stateLine !== undefined, '要能找到【我的状态】那一行')
    assert.equal(stateLine, '【我的状态】' + expected, '状态行必须就是 describe() 的输出（系统算的，不是模型编的，也不是旧值），实际 ' + stateLine)
    const numbers = stateLine.match(/\d+/g) ?? []
    assert.ok(numbers.length >= 2, '状态行里至少要看得到两个数字，实际 ' + stateLine)

    const changeLine = lines.find((line) => line.startsWith('【最近变化】'))
    assert.ok(changeLine !== undefined, '要能找到【最近变化】那一行')
    assert.ok(changeLine.length > '【最近变化】'.length, '刚写过两条变化，这一行不该是空的，实际 ' + JSON.stringify(changeLine))

    assert.match(seen[0].system, /不要自己编数字/, 'system 必须写明"状态是系统算好的、不许自己编数字"')
    assert.match(seen[0].system, /私信只能发给主人/, 'system 里的私信硬限制也要在')
  } finally {
    env.restore()
  }
})

/* ────────────── brain 上下文：身份与每月梗库（§14.1 / §14.5） ──────────────
 *
 * 为什么这两样要进 prompt 才算数：名字/称呼决定她怎么称呼主人，梗库决定她玩不玩梗。
 *   两者都只存在于文件里的话，界面上改完"下一轮就生效"这句话就是假的 ——
 *   所以这里抓 options.system 直接验：身份那一句、四条梗规矩、以及真的把梗列了出来。
 */

test('brain 上下文含身份与梗：你叫 <name>，称呼对方为 <ownerTitle> / 四条梗规矩 / ≥3 条梗；stale 时出现「可能过期」', async () => {
  const env = selfEnv('brain-identity-memes')
  try {
    const { decide } = await import(repoUrl('lib/core/brain.js'))
    const persona = await import(repoUrl('lib/core/persona.js'))
    const memes = await import(repoUrl('lib/core/memes.js'))

    persona.writeProfile({ name: '小鲤', ownerTitle: '饲主' })
    const ITEMS = [
      { meme: '尊嘟假嘟', meaning: '真的假的', example: '尊嘟假嘟？', seen: 0 },
      { meme: 'city不city', meaning: '洋气吗', example: '', seen: 0 },
      { meme: '水灵灵地', meaning: '很自然地（反讽）', example: '', seen: 0 },
      { meme: '已老实', meaning: '认怂了', example: '', seen: 0 },
    ]
    const writeMemes = (stage) => fs.writeFileSync(memes.memesPath(), JSON.stringify({
      updatedAt: new Date().toISOString(), source: 'llm', stage, items: ITEMS, lastAttemptAt: '', lastMemeError: '',
    }))

    const capture = async () => {
      let system = ''
      const llm = {
        async *stream (options) {
          system = String(options.system ?? '')
          yield { type: 'text-delta', text: JSON.stringify({ mood: '平静', say: '', actions: [], diary: '', memory: [] }) }
          yield { type: 'finish', reason: { kind: 'ok' } }
        },
      }
      const result = await decide({ trigger: 'manual', deps: { tools: new Map() }, llm })
      assert.equal(result.ok, true, '正常 JSON 应当解析成功，实际 ' + JSON.stringify(result).slice(0, 160))
      return system
    }

    // ① 新鲜梗库：身份 + 四条规矩 + 梗列表
    writeMemes('fresh')
    const fresh = await capture()
    assert.match(fresh, /你叫 小鲤，称呼对方为 饲主/, 'system 第一句必须是身份，实际开头：' + fresh.slice(0, 120))
    assert.ok(fresh.includes('关于玩梗（规则，不是建议）'), '必须有梗规矩那一段')
    for (const rule of ['A. 只能用下面', 'B. 每条消息最多一个梗', 'C. 与正文语气冲突时', 'D. 用了就把该条写进']) {
      assert.ok(fresh.includes(rule), '缺少梗规矩：' + rule)
    }
    const listed = ITEMS.filter((item) => fresh.includes(item.meme))
    assert.ok(listed.length >= 3, '至少要把 3 条梗列进上下文，实际 ' + listed.length + ' 条：' + listed.map((item) => item.meme).join('/'))
    assert.equal(fresh.includes('可能过期'), false, '梗库新鲜时不该出现「可能过期」')

    // ② 过期梗库：要提醒"可能过期，尽量少用"
    writeMemes('stale')
    const stale = await capture()
    assert.ok(stale.includes('可能过期'), 'stage=stale 时上下文必须提醒可能过期')
    assert.match(stale, /你叫 小鲤，称呼对方为 饲主/, '过期不影响身份那一句')
  } finally {
    env.restore()
  }
})
