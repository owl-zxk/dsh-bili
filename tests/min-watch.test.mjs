// tests/min-watch.test.mjs —— 每次醒来至少看一个视频（契约 §18）
//
// 为什么这样测：
//   这条兜底是"她真的在过日子"的唯一证据 —— 没有它，模型给个空 actions 就等于"醒了但什么也没做"。
//   但它同时是**最容易绕过闸**的地方（兜底动作也是一次真实请求），所以用例必须同时钉两件事：
//     ① 该兜底时真的兜底（调 bili_watch(popular, 5)，拿到列表再看第一条详情）；
//     ② 不该兜底时一次都不许调（已看过 / 读通道关 / 精力<10 / 开关关掉）。
//   审计字段 args.fallback 落盘后是**字符串 "true"**（audit.summarize 会把值 String 化），
//   断言按落盘形状写，免得以后有人以为那里是布尔。
//   全部假 llm / 假工具 + 临时 self 目录，零真实网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { BVID, cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

const BASE_METRICS = { energy: 60, mood: 55, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 }

function watchEnv (tag) {
  const root = tmpDir(tag)
  const restoreSandbox = sandboxEnv(root)
  const restoreSelf = setEnv({ DSH_BILI_SELF_DIR: path.join(root, 'self') })
  fs.mkdirSync(path.join(root, 'self'), { recursive: true })
  return {
    root,
    selfDir: path.join(root, 'self'),
    restore () { restoreSelf(); restoreSandbox(); cleanupTmp() }
  }
}

/** 假工具：handler 决定返回什么，calls 记下每次入参。 */
function tool (name, handler = () => ({ ok: true, data: {} })) {
  const t = { name, description: '桩', calls: [], async execute (args) { t.calls.push(args ?? {}); return handler(args ?? {}) } }
  return t
}

/** 假 llm：一次调用返回给定决策（分片协议与 brain 一致）。 */
function fakeLlm (decision) {
  return {
    calls: 0,
    async *stream () {
      this.calls += 1
      yield { type: 'text-delta', text: JSON.stringify(decision) }
      yield { type: 'finish', reason: { kind: 'ok' } }
    }
  }
}

/** 一份能覆盖"现在"的日程（manual/timer 都跑得起来）。 */
async function primeSchedule (over = {}) {
  const schedule = await import(repoUrl('lib/core/schedule.js'))
  schedule.unlock()
  const saved = schedule.saveSchedule({ enabled: true, windows: [{ start: '00:00', end: '24:00' }], allows: { read: true }, minWatchPerWake: true, ...over })
  assert.equal(saved.ok, true, '前提：日程必须写成功，实际 ' + JSON.stringify(saved))
  return schedule
}

async function seedState (metrics) {
  const { patchState } = await import(repoUrl('lib/core/state.js'))
  patchState({ counters: {}, silenceUntil: 0, metrics: { ...(metrics ?? BASE_METRICS) } })
}

const auditRows = (audit) => audit.readAudit(50)

/* ══════════════════════════ a. 空动作 → 兜底 ══════════════════════════ */

test('兜底：空 actions 时调 bili_watch(popular,5) + 第一条的 bili_video_info，两条审计都带 fallback，read 计数与 energy 都记', async () => {
  const env = watchEnv('watch-empty')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    const schedule = await primeSchedule()
    autonomy.stop()
    await seedState()

    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid: BVID }, { bvid: 'BV1xx411c7mD' }] } }))
    const info = tool('bili_video_info', () => ({ ok: true, data: { bvid: BVID, title: '第一條' } }))
    const llm = fakeLlm({ mood: '平静', say: '', actions: [], diary: '', memory: [] })
    const deps = { tools: new Map([['bili_watch', watch], ['bili_video_info', info]]), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('timer', deps)
    assert.equal(result.ok, true, '这一轮应当成功，实际 ' + JSON.stringify(result).slice(0, 200))

    // ① 调用序列：popular(limit 5) → 第一条 bvid 的详情
    assert.equal(watch.calls.length, 1, '兜底应当只调一次 bili_watch，实际 ' + watch.calls.length + ' 次')
    assert.deepEqual(watch.calls[0], { source: 'popular', limit: 5 }, '兜底的 bili_watch 必须是 popular + limit 5，实际 ' + JSON.stringify(watch.calls[0]))
    assert.equal(info.calls.length, 1, '拿到列表后应当对第一条调一次 bili_video_info，实际 ' + info.calls.length + ' 次')
    assert.deepEqual(info.calls[0], { bvid: BVID }, '看详情用的必须是列表第一条的 bvid，实际 ' + JSON.stringify(info.calls[0]))

    // ② executed 里两条都要标 fallback:true
    const executedFallbacks = result.executed.filter((item) => item.fallback === true).map((item) => item.tool)
    assert.deepEqual(executedFallbacks.sort(), ['bili_video_info', 'bili_watch'], 'executed 里应当有两条 fallback，实际 ' + JSON.stringify(result.executed))

    // ③ 审计：两条都带 fallback（落盘是字符串 "true"）
    const rows = auditRows(audit)
    const fallbackRows = rows.filter((row) => row.args?.fallback === 'true')
    assert.equal(fallbackRows.length, 2, '应当有两条 fallback 审计（watch + video_info），实际 ' + fallbackRows.length + '：' + JSON.stringify(fallbackRows.map((r) => r.tool)))
    assert.deepEqual(fallbackRows.map((row) => row.tool).sort(), ['bili_video_info', 'bili_watch'], '审计里的工具名对不上：' + JSON.stringify(fallbackRows.map((r) => r.tool)))
    const watchRow = fallbackRows.find((row) => row.tool === 'bili_watch')
    assert.equal(watchRow.args.source, 'popular', 'watch 审计要记来源，实际 ' + JSON.stringify(watchRow.args))

    // ④ 计数与指标：read +1、energy 在 wake(-3) 之外再 -1
    assert.equal(schedule.countsToday().read, 1, '兜底要计入今天的 read 计数，实际 ' + schedule.countsToday().read)
    assert.equal(metrics.readMetrics().energy, 60 - 2 + 0, 'energy 应当是 wake(-2) + read-action(0) = 58，实际 ' + metrics.readMetrics().energy)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ b. 已看过 → 不兜底 ══════════════════════════ */

test('已看过：不再兜底看（watch 只 1 次），但「看完必须评论」的补写会读 1 次 video_info', async () => {
  const env = watchEnv('watch-already')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    const schedule = await primeSchedule()
    autonomy.stop()
    await seedState()

    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid: BVID }] } }))
    const info = tool('bili_video_info', () => ({ ok: true, data: {} }))
    const llm = fakeLlm({ mood: '平静', say: '刷一下', actions: [{ tool: 'bili_watch', args: { limit: 2 }, why: '想刷' }], diary: '', memory: [] })
    const deps = { tools: new Map([['bili_watch', watch], ['bili_video_info', info]]), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('timer', deps)
    assert.equal(result.ok, true, '这一轮应当成功')

    assert.equal(watch.calls.length, 1, '已经看过视频时 bili_watch 只该被调用 1 次（模型那次），实际 ' + watch.calls.length + ' 次')
    assert.deepEqual(watch.calls[0], { limit: 2 }, '那一次必须来自模型给的参数，而不是兜底的 popular/5，实际 ' + JSON.stringify(watch.calls[0]))
    // 2026-11-02：看完必须评论 → 没有 comment 时会补写一次，补写要先读一次 video_info
    // （那是**读**，不占写闸；也不等于「兜底看视频」）。上限 1 次：不许为了补写反复读。
    assert.ok(info.calls.length <= 1, '补写最多读一次详情，实际 ' + info.calls.length + ' 次')
    if (info.calls.length === 1) assert.equal(info.calls[0].bvid, BVID, '读的就是刚看的那个视频，实际 ' + JSON.stringify(info.calls[0]))
    const fallbackRows = auditRows(audit).filter((row) => row.args?.fallback === 'true')
    assert.equal(fallbackRows.length, 0, '不兜底时不该有 fallback 审计，实际 ' + JSON.stringify(fallbackRows))
    // 模型那条走 actions 的记账 —— 2026-11-01 起**主动读也计入** todayCounts.read（此前只有兜底计），
    // 所以这里是 1（这一次主动读），不是 0，也不该是 2（兜底没跑）。
    assert.equal(schedule.countsToday().read, 1, '模型主动读一次应当记 1 次 read（兜底没跑，不该是 2），实际 ' + schedule.countsToday().read)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ c. 只换一次源 ══════════════════════════ */

test('换源只换一次：popular 失败 → ranking 成功（恰好两次，不重试第三次），并对 ranking 的第一条看详情', async () => {
  const env = watchEnv('watch-fallback-once')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    const schedule = await primeSchedule()
    autonomy.stop()
    await seedState()

    const RANKING_BVID = 'BV1xx411c7mD'
    const watch = tool('bili_watch', (args) => (args.source === 'popular'
      ? { ok: false, reason: 'bili-error', human: '热门挂了' }
      : { ok: true, data: { items: [{ bvid: RANKING_BVID }] } }))
    const info = tool('bili_video_info', () => ({ ok: true, data: { bvid: RANKING_BVID } }))
    const llm = fakeLlm({ mood: '平静', say: '', actions: [], diary: '', memory: [] })
    const deps = { tools: new Map([['bili_watch', watch], ['bili_video_info', info]]), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('timer', deps)
    assert.equal(result.ok, true, 'popular 失败但兜底换源成功，这一轮仍应当 ok')

    const sources = watch.calls.map((call) => call.source)
    assert.deepEqual(sources, ['popular', 'ranking'], '恰好试两个来源、每个一次（不重试第三次），实际 ' + JSON.stringify(sources))
    // 读代码确认的语义：换源成功后 **ranking 的 items 仍会被用来挑第一条看详情**
    assert.deepEqual(info.calls, [{ bvid: RANKING_BVID }], '换源拿到列表后，仍然要对第一条看详情（用的必须是 ranking 的第一条），实际 ' + JSON.stringify(info.calls))

    const rows = auditRows(audit).filter((row) => row.args?.fallback === 'true')
    assert.equal(rows.length, 3, '应当有三条 fallback 审计（popular 失败、ranking 成功、看详情），实际 ' + rows.length + '：' + JSON.stringify(rows.map((r) => r.tool + '/' + (r.args?.source ?? r.args?.bvid))))
    assert.deepEqual(rows.filter((row) => row.tool === 'bili_watch').map((row) => row.args.source), ['popular', 'ranking'], '两条 watch 审计的来源要对得上')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ d. 闸：精力 / 读通道 / 开关 ══════════════════════════ */

test('闸：energy=8 → 最小动作（popular/limit 1，不取详情）；allows.read=false 与开关关 → 零调用', async () => {
  const env = watchEnv('watch-gates')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    autonomy.stop()

    const runCase = async ({ metrics, allows, minWatchPerWake }) => {
      const schedule = await import(repoUrl('lib/core/schedule.js'))
      schedule.unlock()
      schedule.saveSchedule({ enabled: true, windows: [{ start: '00:00', end: '24:00' }], allows: { read: true, ...allows }, minWatchPerWake })
      await seedState(metrics)
      const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid: BVID }] } }))
      const info = tool('bili_video_info', () => ({ ok: true, data: {} }))
      const llm = fakeLlm({ mood: '平静', say: '', actions: [], diary: '', memory: [] })
      const deps = { tools: new Map([['bili_watch', watch], ['bili_video_info', info]]), llm, log: () => {}, ctx: {} }
      // 审计文件是同一个（同一个 self 目录），所以只取"本次新增"的那几行，
      // 否则三种闸的跳过记录会互相串味（第一版就这么错过一次）。
      const before = auditRows(audit).length
      const result = await autonomy.runOnce('timer', deps)
      return { result, watch, info, rows: auditRows(audit).slice(before) }
    }

    // ① 精力低（energy=8：>=3 但 <10）→ 最小动作，不是取消兜底。
    //    用户 2026-11-02 的要求是「除了 token 之外不该有别的东西拦住她看视频」；
    //    energy 低只压缩动作规模（limit 1、不深读、不取详情），不取消「看一眼」。
    const metricsModule = await import(repoUrl('lib/core/metrics.js'))
    assert.equal(metricsModule.effectiveAllows({ read: true }, { ...BASE_METRICS, energy: 8 }).read, false, '前提：energy<10 时 effectiveAllows 仍会关掉 read（但兜底已不看这条）')
    const tired = await runCase({ metrics: { ...BASE_METRICS, energy: 8 }, allows: {}, minWatchPerWake: true })
    assert.equal(tired.watch.calls.length, 1, 'energy=8 时应当恰好兜底一次 bili_watch，实际 ' + tired.watch.calls.length + ' 次')
    assert.deepEqual(tired.watch.calls[0], { source: 'popular', limit: 1 }, '最小动作必须是 popular + limit 1，实际 ' + JSON.stringify(tired.watch.calls[0]))
    assert.equal('deep' in tired.watch.calls[0], false, '最小动作不许带 deep（深读一条约 2 万 token，累到不行不该烧）')
    assert.equal(tired.info.calls.length, 0, '最小动作连详情都不取（那是第二次请求），实际 ' + tired.info.calls.length + ' 次')
    const minimalRows = tired.rows.filter((row) => row.args?.minimal === 'true')
    assert.equal(minimalRows.length, 1, '必须留一条带 minimal:true 的审计（事后能看出这轮是精简模式），实际 ' + minimalRows.length)
    assert.match(String(minimalRows[0].why), /精力低/, '那条审计的 why 要写清是精力低：' + minimalRows[0].why)
    // ② 读通道被关：同样不兜底
    const readOff = await runCase({ metrics: { ...BASE_METRICS }, allows: { read: false }, minWatchPerWake: true })
    assert.equal(readOff.watch.calls.length, 0, 'allows.read=false 时不许兜底，实际 ' + readOff.watch.calls.length + ' 次')
    const readSkip = readOff.rows.filter((row) => row.tool === 'watch-fallback')
    assert.equal(readSkip.length, 1, '读通道关掉时也要留一条 watch-fallback 审计，实际 ' + readSkip.length)
    assert.match(String(readSkip[0].args.skipped), /读通道/, 'args.skipped 要说清是读通道被关：' + readSkip[0].args.skipped)

    // ③ 开关关掉：**完全不兜底**，连"跳过"审计都不该有（不是"跳过"，是没这条规则）
    const off = await runCase({ metrics: { ...BASE_METRICS }, allows: {}, minWatchPerWake: false })
    assert.equal(off.watch.calls.length, 0, 'minWatchPerWake=false 时不许兜底，实际 ' + off.watch.calls.length + ' 次')
    assert.equal(off.rows.filter((row) => row.tool === 'watch-fallback').length, 0, '开关关掉时不该有 watch-fallback 审计（连跳过都不记），实际 ' + JSON.stringify(off.rows.filter((row) => row.tool === 'watch-fallback')))
    assert.equal(off.result.ok, true, '关掉兜底不影响这一轮本身（仍然 ok）')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 新语义的两条保护（2026-11-02） ══════════════════════════ */

test('energy=2（< 3）：连兜底看也免 —— bili_watch 零调用，审计写清 energy=N < 3', async () => {
  const env = watchEnv('watch-energy2')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    autonomy.stop()
    schedule.unlock()
    schedule.saveSchedule({ enabled: true, windows: [{ start: '00:00', end: '24:00' }], allows: { read: true }, minWatchPerWake: true })
    // tick 会先 applyEvent('wake') 扣 2 点，所以这里种 4 → 判断时是 2（< 3）
    await seedState({ ...BASE_METRICS, energy: 4 })

    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid: BVID }] } }))
    const info = tool('bili_video_info', () => ({ ok: true, data: {} }))
    const llm = fakeLlm({ mood: '平静', say: '', actions: [], diary: '', memory: [] })
    const deps = { tools: new Map([['bili_watch', watch], ['bili_video_info', info]]), llm, log: () => {}, ctx: {} }
    const before = audit.readAudit(50).length
    await autonomy.runOnce('timer', deps)
    const rows = audit.readAudit(50).slice(before)

    assert.equal(watch.calls.length, 0, 'energy<3 时连兜底看都不许调，实际 ' + watch.calls.length + ' 次')
    assert.equal(info.calls.length, 0, '更不许取详情')
    const skipRows = rows.filter((row) => row.tool === 'watch-fallback')
    assert.equal(skipRows.length, 1, '必须留一条跳过审计，实际 ' + skipRows.length)
    assert.match(String(skipRows[0].args.skipped), /energy=2 < 3/, '审计要写具体数值（判断时 energy=2 < 3），实际 ' + JSON.stringify(skipRows[0].args.skipped))
    assert.match(String(skipRows[0].why), /跳过/, 'why 要写清是跳过：' + skipRows[0].why)
  } finally {
    env.restore()
  }
})

test('energy=50 回归：兜底仍是 popular/limit 5 且会取第一条详情（没把正常路径改坏）', async () => {
  const env = watchEnv('watch-energy50')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    autonomy.stop()
    schedule.unlock()
    schedule.saveSchedule({ enabled: true, windows: [{ start: '00:00', end: '24:00' }], allows: { read: true }, minWatchPerWake: true })
    await seedState({ ...BASE_METRICS, energy: 50 })

    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid: BVID }] } }))
    const info = tool('bili_video_info', () => ({ ok: true, data: { bvid: BVID } }))
    const llm = fakeLlm({ mood: '平静', say: '', actions: [], diary: '', memory: [] })
    const deps = { tools: new Map([['bili_watch', watch], ['bili_video_info', info]]), llm, log: () => {}, ctx: {} }
    const before = audit.readAudit(50).length
    await autonomy.runOnce('timer', deps)
    const rows = audit.readAudit(50).slice(before)

    assert.equal(watch.calls.length, 1, '正常精力下兜底仍是一次 bili_watch，实际 ' + watch.calls.length)
    assert.deepEqual(watch.calls[0], { source: 'popular', limit: 5 }, '正常路径必须仍是 popular + limit 5，实际 ' + JSON.stringify(watch.calls[0]))
    assert.equal(info.calls.length, 1, '正常路径必须取第一条详情，实际 ' + info.calls.length)
    assert.deepEqual(info.calls[0], { bvid: BVID }, '看的就是列表第一条，实际 ' + JSON.stringify(info.calls[0]))
    assert.equal(rows.filter((row) => row.args?.minimal === 'true').length, 0, '正常路径不该出现 minimal 审计')
  } finally {
    env.restore()
  }
})
