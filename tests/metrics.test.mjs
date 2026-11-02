// tests/metrics.test.mjs —— 指标系统（AUTONOMY-PROMPT §14）
//
// 为什么这样测：
//   §14 的核心不是"有六个数字"，而是**数字必须真的改变行为**，而且改法必须是确定性规则：
//   同一段经历不能两次跑出两个情绪，更不能让模型自己改数字。所以这里三件事分开测：
//     ① 事件表：每个 kind 的增减逐项断言到具体数值（不是"有变化"）；
//     ② 钳制与滚动：0/100 边界不溢出、history 只留最近 50 条；
//     ③ 折算生效：effectiveAllows / dmFactor 真的把写通道关掉、把私信上限减半
//        —— 这一层如果只是"展示用"，前面两条再对也没有意义。
//   全部用临时 self 目录（DSH_BILI_SELF_DIR → os.tmpdir()），不碰真实 state.json、零网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

/** 每个用例一个临时 self 目录（指标落在 state.json，不能串味）。 */
function metricsEnv (tag) {
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

/** 把六项指标直接写进 state（构造"她现在什么状态"的最短路径）。 */
async function seedMetrics (metrics) {
  const { patchState } = await import(repoUrl('lib/core/state.js'))
  patchState({ metrics })
}

const BASE = { energy: 60, mood: 55, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 }

/* ══════════════════════════ a. 事件表逐条 ══════════════════════════ */

test('事件表逐条：wake / read-action / write-action / action-ok / action-fail / risk / interest-hit / repeat / dm-sent / owner-reply', async () => {
  const env = metricsEnv('metrics-events')
  try {
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    const cases = [
      { kind: 'wake', expect: { energy: 58 }, changes: [{ key: 'energy', delta: -2 }] },
      { kind: 'read-action', expect: { energy: 60 }, changes: [] },   // §19: 看不算消耗
      { kind: 'write-action', expect: { energy: 57 }, changes: [{ key: 'energy', delta: -3 }] },
      { kind: 'action-ok', expect: { confidence: 46 }, changes: [{ key: 'confidence', delta: 1 }] },
      { kind: 'action-fail', expect: { confidence: 42 }, changes: [{ key: 'confidence', delta: -3 }] },
      { kind: 'risk', expect: { mood: 47, confidence: 40, energy: 55 }, changes: [{ key: 'mood', delta: -8 }, { key: 'confidence', delta: -5 }, { key: 'energy', delta: -5 }] },
      { kind: 'interest-hit', expect: { mood: 58, curiosity: 67 }, changes: [{ key: 'mood', delta: 3 }, { key: 'curiosity', delta: 2 }] },
      { kind: 'repeat', expect: { boredom: 34, curiosity: 63 }, changes: [{ key: 'boredom', delta: 4 }, { key: 'curiosity', delta: -2 }] },
      { kind: 'dm-sent', expect: { affinity: 55 }, changes: [{ key: 'affinity', delta: 5 }] },
      { kind: 'owner-reply', expect: { affinity: 60 }, changes: [{ key: 'affinity', delta: 10 }] },
    ]

    for (const item of cases) {
      await seedMetrics({ ...BASE })
      const result = metrics.applyEvent(item.kind)
      // 只断言这个事件该动的那几项，其余必须原样
      for (const key of metrics.METRIC_KEYS) {
        const expected = item.expect[key] === undefined ? BASE[key] : item.expect[key]
        assert.equal(result.after[key], expected, item.kind + ' 之后 ' + key + ' 应当是 ' + expected + '，实际 ' + result.after[key])
      }
      assert.deepEqual(result.changes, item.changes, item.kind + ' 的 changes 必须逐项对得上（key+delta），实际 ' + JSON.stringify(result.changes))
      assert.deepEqual(metrics.readMetrics(), result.after, item.kind + ' 必须真的落盘（readMetrics 要读回同一份）')
    }
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ b. clamp ══════════════════════════ */

test('clamp：action-ok ×100 封顶 100、action-fail ×100 见底 0，任何事件都不溢出 0–100', async () => {
  const env = metricsEnv('metrics-clamp')
  try {
    const metrics = await import(repoUrl('lib/core/metrics.js'))

    // ① 从 100 再加 100 次：必须一直停在 100（而且 changes 应当为空 —— 没变就不该记一笔"变化"）
    await seedMetrics({ ...BASE, confidence: 100 })
    for (let i = 0; i < 100; i += 1) metrics.applyEvent('action-ok')
    assert.equal(metrics.readMetrics().confidence, 100, 'confidence 封顶必须是 100')
    const capped = metrics.applyEvent('action-ok')
    assert.equal(capped.after.confidence, 100, '已经在 100 时再加仍是 100')
    assert.deepEqual(capped.changes, [], '没有真的变化时 changes 必须是空数组')

    // ② 从 0 再减 100 次：必须一直停在 0
    await seedMetrics({ ...BASE, confidence: 0 })
    for (let i = 0; i < 100; i += 1) metrics.applyEvent('action-fail')
    assert.equal(metrics.readMetrics().confidence, 0, 'confidence 下限必须是 0')

    // ③ 极限值上把所有事件都打一遍：六项都必须留在 [0,100] 的整数区间
    await seedMetrics({ energy: 0, mood: 100, curiosity: 0, affinity: 100, boredom: 0, confidence: 0 })
    for (const kind of ['wake', 'read-action', 'write-action', 'action-ok', 'action-fail', 'risk', 'interest-hit', 'repeat', 'dm-sent', 'owner-reply']) {
      for (let i = 0; i < 5; i += 1) metrics.applyEvent(kind)
    }
    const after = metrics.readMetrics()
    for (const key of metrics.METRIC_KEYS) {
      assert.equal(Number.isInteger(after[key]), true, key + ' 必须是整数，实际 ' + after[key])
      assert.ok(after[key] >= 0 && after[key] <= 100, key + ' 必须留在 0–100，实际 ' + after[key])
    }
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ c. effectiveAllows（拆两条） ══════════════════════════ */

test('effectiveAllows·精力：energy=15 只关公开通道（保留 read+dm），energy=8 全关', async () => {
  const env = metricsEnv('metrics-energy')
  try {
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    const open = { read: true, dm: true, comment: true, reply: true, dynamic: true, like: true, follow: true }

    // energy=15：< 20 但 ≥ 10 → 只关公开通道，私信保留（§14.3，2026-11-01 裁决）
    const tired = metrics.effectiveAllows(open, { ...BASE, energy: 15 })
    assert.equal(tired.read, true, '累到 15 也要能读')
    assert.equal(tired.dm, true, 'energy=15 时私信必须保留（<10 才关）')
    for (const key of ['comment', 'reply', 'dynamic', 'like', 'follow']) assert.equal(tired[key], false, 'energy=15 时 ' + key + ' 必须关掉')
    assert.equal(metrics.behaviorHints({ ...BASE, energy: 15 }).maxWrites, 0, 'energy<20 时本次醒来写动作预算必须是 0')

    // energy=8：连私信都不发
    const exhausted = metrics.effectiveAllows(open, { ...BASE, energy: 8 })
    for (const key of ['read', 'dm', 'comment', 'reply', 'dynamic', 'like', 'follow']) {
      assert.equal(exhausted[key], false, 'energy=8 时 ' + key + ' 必须 false')
    }
    assert.equal(metrics.behaviorHints({ ...BASE, energy: 8 }).maxWrites, 0, 'energy=8 时写动作预算同样 0')

    // 只收紧、不放开：原对象不许被改
    assert.deepEqual(open, { read: true, dm: true, comment: true, reply: true, dynamic: true, like: true, follow: true }, 'effectiveAllows 不许修改传入的 allows')
    // 也不许把原本关着的东西打开
    const closedBase = { read: true, dm: true, comment: false, reply: false, dynamic: false, like: false, follow: false }
    const stillClosed = metrics.effectiveAllows(closedBase, { ...BASE, confidence: 100, energy: 100 })
    assert.equal(stillClosed.comment, false, '指标好起来也不许把用户关掉的通道打开')
  } finally {
    env.restore()
  }
})

test('effectiveAllows·自信：confidence=25 关 comment/reply/dynamic（like 仍在），confidence=10 连 like/follow 也关', async () => {
  const env = metricsEnv('metrics-confidence')
  try {
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    const open = { read: true, dm: true, comment: true, reply: true, dynamic: true, like: true, follow: true }

    const shy = metrics.effectiveAllows(open, { ...BASE, confidence: 25 })
    for (const key of ['comment', 'reply', 'dynamic']) assert.equal(shy[key], false, 'confidence=25 时 ' + key + ' 必须关')
    for (const key of ['like', 'follow', 'dm', 'read']) assert.equal(shy[key], true, 'confidence=25 时 ' + key + ' 仍应可用')

    const timid = metrics.effectiveAllows(open, { ...BASE, confidence: 10 })
    for (const key of ['comment', 'reply', 'dynamic', 'like', 'follow']) assert.equal(timid[key], false, 'confidence=10 时 ' + key + ' 必须关')
    assert.equal(timid.dm, true, 'confidence=10 时私信仍可用（只关公开动作）')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ d. dm 配额折算 ══════════════════════════ */

test('dm 配额折算：affinity=35（dmFactor 0.5）+ caps.dm=4 → 生效上限 2，第 3 条 skipped=cap', async () => {
  const env = metricsEnv('metrics-dmcap')
  try {
    const actions = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    const { localDayKey } = await import('./helpers/harness.mjs')
    schedule.unlock()
    schedule.saveSchedule({ allows: { dm: true }, caps: { dm: 4 } })

    // "今天已发 N 条"直接写进 counters（走 bumpCount 会顺带触发 dm-sent → affinity +5，
    // 而 affinity 一旦 ≥40 折算系数就回到 1，测到的就不是 0.5 这一档了）。
    // 注意：这条用例验的是**折算规则**，所以要把"已发几条"钉成外部给定值。
    const seedCounts = (dmCount) => patchState({ counters: { date: localDayKey(), counts: { dm: dmCount, comment: 0, reply: 0, dynamic: 0, like: 0, follow: 0 } } })

    const dm = { name: 'bili_dm', description: '桩', calls: [], async execute (args) { dm.calls.push(args); return { ok: true, data: {} } } }
    const deps = { tools: new Map([['bili_dm', dm]]), log: () => {} }

    // ① affinity=35 → dmFactor 0.5 → 生效上限 floor(4 × 0.5) = 2
    await seedMetrics({ ...BASE, affinity: 35 })
    patchState({ silenceUntil: 0 })
    assert.equal(metrics.behaviorHints(metrics.readMetrics()).dmFactor, 0.5, 'affinity=35 时 dmFactor 必须是 0.5')

    seedCounts(1)
    const allowed = await actions.runActions({ ok: true, actions: [{ tool: 'bili_dm', args: { text: '第 2 条' } }] }, deps)
    assert.equal(allowed.executed.length, 1, '已发 1 条 < 折算上限 2 → 应当放行，实际 ' + JSON.stringify(allowed))
    assert.equal(dm.calls.length, 1, '放行就该真的调用一次工具')

    await seedMetrics({ ...BASE, affinity: 35 })   // dm-sent 会把 affinity 推到 40，这里重新钉回 35
    seedCounts(2)
    const capped = await actions.runActions({ ok: true, actions: [{ tool: 'bili_dm', args: { text: '第 3 条' } }] }, deps)
    assert.deepEqual(capped.skipped, [{ tool: 'bili_dm', why: 'cap' }], '折算成 2 条之后第 3 条必须记 cap，实际 ' + JSON.stringify(capped.skipped))
    assert.equal(dm.calls.length, 1, '被 cap 挡下的那次绝不许调用工具，实际调用 ' + dm.calls.length + ' 次')

    // ② 对照：affinity=50 → dmFactor=1 → 生效上限仍是 4，同样"已发 2 条"就放行
    await seedMetrics({ ...BASE, affinity: 50 })
    seedCounts(2)
    const backToFour = await actions.runActions({ ok: true, actions: [{ tool: 'bili_dm', args: { text: '第 3 条（折算恢复）' } }] }, deps)
    assert.equal(backToFour.executed.length, 1, 'dmFactor=1 时上限是 4，已发 2 条应当仍放行，实际 ' + JSON.stringify(backToFour.skipped))
    assert.equal(dm.calls.length, 2, '对照那一次应当真的调用（累计 2 次）')

    // ③ 反馈环本身也要说清楚（这是"连发三条就撞不到 cap"的原因，不是缺陷）：
    //    一次成功的私信会 applyEvent('dm-sent') → affinity +5。
    await seedMetrics({ ...BASE, affinity: 35 })
    const before = metrics.readMetrics().affinity
    seedCounts(0)
    await actions.runActions({ ok: true, actions: [{ tool: 'bili_dm', args: { text: '喂饱亲近度' } }] }, deps)
    const afterAffinity = metrics.readMetrics().affinity
    assert.equal(afterAffinity, before + 5, '私信成功必须给 affinity +5，实际 ' + afterAffinity)
    assert.equal(metrics.behaviorHints(metrics.readMetrics()).dmFactor, 1, 'affinity 到 40 之后 dmFactor 就该回到 1（这正是"连发三条撞不到 cap"的原因）')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ e. decayTo 跨天 ══════════════════════════ */

test('decayTo 跨天：energy+15 封顶、boredom-5 下限 0、mood 向 50 靠 1；同一天再调不变', async () => {
  const env = metricsEnv('metrics-decay')
  try {
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))

    const runCase = async (before) => {
      patchState({ metrics: { ...before }, metricsDay: '2000-01-01', metricsHistory: [] })
      const result = metrics.decayTo(Date.now())
      return { after: metrics.readMetrics(), result }
    }

    const high = await runCase({ energy: 85, mood: 55, curiosity: 65, affinity: 50, boredom: 3, confidence: 45 })
    assert.equal(high.after.energy, 100, 'energy 85+25 必须封顶 100，实际 ' + high.after.energy)
    assert.equal(high.after.boredom, 0, 'boredom 3-5 必须见底 0，实际 ' + high.after.boredom)
    assert.equal(high.after.mood, 54, 'mood 55 必须向 50 靠 1（55→54），实际 ' + high.after.mood)

    const low = await runCase({ energy: 60, mood: 45, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 })
    assert.equal(low.after.mood, 46, 'mood 45 必须向 50 靠 1（45→46），实际 ' + low.after.mood)
    assert.equal(low.after.energy, 75, 'energy 60+15 = 75（§19：跨天不再给一大口）')
    assert.equal(low.after.boredom, 25, 'boredom 30-5 = 25')

    const neutral = await runCase({ energy: 60, mood: 50, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 })
    assert.equal(neutral.after.mood, 50, 'mood 正好 50 时不动，实际 ' + neutral.after.mood)

    // 同一天再调：一律不变（changes 为空），否则一天醒 20 次就会满血 20 次
    const again = metrics.decayTo(Date.now())
    assert.deepEqual(again.changes, [], '同一天第二次 decayTo 不该产生任何变化，实际 ' + JSON.stringify(again.changes))
    assert.deepEqual(metrics.readMetrics(), neutral.after, '同一天第二次 decayTo 之后指标必须一模一样')

    // 首次运行（没有 metricsDay 基线）只记今天，不假装"跨了一天"
    patchState({ metrics: { ...BASE, energy: 10 }, metricsDay: '', metricsHistory: [] })
    const first = metrics.decayTo(Date.now())
    assert.deepEqual(first.changes, [], '没有日期基线时只建基线，不恢复')
    assert.equal(metrics.readMetrics().energy, 10, '首次运行不许悄悄加 energy')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ f. describe ══════════════════════════ */

test('describe：六项都在、以「 · 」分隔、0 与 100 边界都能输出', async () => {
  const env = metricsEnv('metrics-describe')
  try {
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    const labels = ['精力', '心情', '好奇', '亲近', '倦怠', '自信']

    const line = metrics.describe({ energy: 60, mood: 55, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 })
    const parts = line.split(' · ')
    assert.equal(parts.length, 6, '必须是六项、用「 · 」分隔，实际 ' + line)
    for (let i = 0; i < labels.length; i += 1) {
      assert.match(parts[i], new RegExp('^' + labels[i] + ' \\d+$'), '第 ' + (i + 1) + ' 项应当是「' + labels[i] + ' N」，实际 ' + parts[i])
    }
    assert.match(line, /精力 60/, '数值要如实写进这一行')

    const zeros = metrics.describe({ energy: 0, mood: 0, curiosity: 0, affinity: 0, boredom: 0, confidence: 0 })
    assert.equal(zeros.split(' · ').length, 6, '0 值也要输出六项：' + zeros)
    assert.match(zeros, /精力 0/)

    const full = metrics.describe({ energy: 100, mood: 100, curiosity: 100, affinity: 100, boredom: 100, confidence: 100 })
    assert.equal(full.split(' · ').length, 6, '100 值也要输出六项：' + full)
    assert.match(full, /自信 100/)

    // 坏输入不能抛（describe(undefined) 读现读状态）
    assert.equal(typeof metrics.describe(undefined), 'string', 'describe(undefined) 必须回一行字符串')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ g. risk 与预算耗尽的静默 ══════════════════════════ */

test('risk 静默：applyEvent(risk) → silenceUntil≈2h 且 canRunNow 拒；token-budget 只静默≈1h 且不动心情/自信', async () => {
  const env = metricsEnv('metrics-silence')
  try {
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { readState, patchState } = await import(repoUrl('lib/core/state.js'))
    schedule.unlock()
    schedule.saveSchedule({ allows: { comment: true } })

    // ① risk：静默 2 小时（并且指标也掉了）
    await seedMetrics({ ...BASE })
    patchState({ silenceUntil: 0, counters: {} })
    const risk = metrics.applyEvent('risk')
    const left2h = Number(readState().silenceUntil ?? 0) - Date.now()
    assert.ok(left2h > 1.9 * 3600_000 && left2h <= 2 * 3600_000 + 60_000, 'risk 的静默应≈2 小时，实际 ' + Math.round(left2h / 60000) + ' 分钟')
    const blocked = schedule.canRunNow(Date.now())
    assert.equal(blocked.ok, false, '静默期间 canRunNow 必须拒')
    assert.match(String(blocked.reason), /silenced|静默/, 'reason 要能看出是静默，实际 ' + blocked.reason)
    assert.equal(risk.after.mood, 47, 'risk 同时要把心情打下去（55-8）')

    // ② token 预算耗尽：这是 actions 层的事，只停手、不动心情 —— 静默≈1 小时
    patchState({ silenceUntil: 0, counters: {}, metrics: { ...BASE } })
    const actions = await import(repoUrl('lib/core/actions.js'))
    const comment = { name: 'bili_comment', description: '桩', calls: [], async execute (args) { comment.calls.push(args); return { ok: false, reason: 'token-budget-exhausted' } } }
    const status = { name: 'bili_status', description: '桩', async execute () { return { ok: true, data: { tokens: { source: 'ledger' }, client: { banned: false } } } } }
    const deps = { tools: new Map([['bili_comment', comment], ['bili_status', status]]), log: () => {} }
    const before = metrics.readMetrics()
    const outcome = await actions.runActions({ ok: true, actions: [{ tool: 'bili_comment', args: { bvid: 'BV1GJ411x7h7', message: '预算没了' } }] }, deps)
    assert.equal(outcome.executed.length, 1, '预算是工具返回的拒绝（不是预检拦下），动作应当"执行过一次"')
    assert.equal(comment.calls.length, 1)
    const left1h = Number(readState().silenceUntil ?? 0) - Date.now()
    assert.ok(left1h > 0.9 * 3600_000 && left1h <= 3600_000 + 60_000, 'token 预算耗尽的静默应≈1 小时，实际 ' + Math.round(left1h / 60000) + ' 分钟')
    const after = metrics.readMetrics()
    assert.equal(after.mood, before.mood, '预算耗尽不是"被平台打了一下"，心情不该掉，实际 ' + after.mood + ' vs ' + before.mood)
    assert.equal(after.confidence, before.confidence - 3, '但它是 action-fail：自信按 -3 记（这是动作失败，不是风控）')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ h. history 滚动 ══════════════════════════ */

test('history 滚动：连写 60 次 → metricsHistory 恰 50 条、末条是最新的', async () => {
  const env = metricsEnv('metrics-history')
  try {
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    const { readState } = await import(repoUrl('lib/core/state.js'))
    await seedMetrics({ ...BASE })

    for (let i = 0; i < 60; i += 1) metrics.applyEvent('action-ok')
    const history = readState().metricsHistory
    assert.equal(Array.isArray(history), true, 'metricsHistory 必须是数组')
    assert.equal(history.length, metrics.HISTORY_MAX, '只保留最近 ' + metrics.HISTORY_MAX + ' 条，实际 ' + history.length)
    assert.equal(history.at(-1).event, 'action-ok', '末条必须是最近一次事件')
    assert.ok(Array.isArray(history.at(-1).changes), '每条都要带 changes')
    assert.equal(typeof history.at(-1).at, 'string', '每条都要带时间戳')
    // 滚动是"丢最老的"，不是"丢最新的"：60 次之后仍然每 10 条里能看到连续的 at
    const times = history.map((row) => Date.parse(row.at))
    for (let i = 1; i < times.length; i += 1) assert.ok(times[i] >= times[i - 1], 'history 必须按时间正序（新的在后）')

    assert.equal(metrics.recentChanges(3).length, 3, 'recentChanges(3) 取最近 3 条')
    assert.deepEqual(metrics.recentChanges(3).at(-1), history.at(-1), 'recentChanges 的末条就是 history 的末条')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ i. interest 只应用一次 ══════════════════════════ */

test('interest 只应用一次：决策级 interest 或两条动作各带 interest 都只产生一条 interest-hit', async () => {
  const env = metricsEnv('metrics-interest')
  try {
    const actions = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState, readState } = await import(repoUrl('lib/core/state.js'))
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    schedule.unlock()
    schedule.saveSchedule({ allows: { read: true }, caps: {} })

    const watch = { name: 'bili_watch', description: '桩', calls: 0, async execute () { watch.calls += 1; return { ok: true, data: { count: 1, items: [] } } } }
    const comments = { name: 'bili_comments', description: '桩', calls: 0, async execute () { comments.calls += 1; return { ok: true, data: { count: 0 } } } }
    const deps = { tools: new Map([['bili_watch', watch], ['bili_comments', comments]]), log: () => {} }
    const hits = () => (readState().metricsHistory ?? []).filter((row) => row.event === 'interest-hit')

    // 相一：决策级 interest:true（actions 目前唯一认的形状）→ 恰好一条
    await seedMetrics({ ...BASE })
    patchState({ counters: {}, silenceUntil: 0, metricsHistory: [] })
    const first = await actions.runActions({ ok: true, interest: true, actions: [{ tool: 'bili_watch', args: { limit: 3 }, why: '标题让我停下来了' }] }, deps)
    assert.equal(first.executed.length, 1, '只读动作应当执行')
    assert.equal(hits().length, 1, '决策级 interest 必须记一条 interest-hit，实际 ' + hits().length + ' 条')
    assert.equal(metrics.readMetrics().mood, BASE.mood + 3, 'interest-hit 一次 → 心情 +3')
    assert.equal(metrics.readMetrics().curiosity, BASE.curiosity + 2, '好奇 +2')

    // 相二：**两个动作各带 interest:true**（契约原文「同一次决策里出现两次」）→ 仍然只许一条，
    // 且心情只 +3（若按动作各记一次就会是 +6 —— 那正是要防的翻倍）。
    await seedMetrics({ ...BASE })
    patchState({ counters: {}, silenceUntil: 0, metricsHistory: [] })
    watch.calls = 0
    comments.calls = 0
    const second = await actions.runActions({
      ok: true,
      actions: [
        { tool: 'bili_watch', args: { limit: 3 }, interest: true, why: '这个标题让我停下来了' },
        { tool: 'bili_comments', args: { oid: '123' }, interest: true, why: '同一次醒来又看到一个' },
      ],
    }, deps)
    assert.equal(second.executed.length, 2, '两个只读动作都该执行')
    assert.equal(hits().length, 1, '一次决策里出现两次 interest 也只许记一条 interest-hit，实际 ' + hits().length + ' 条')
    assert.equal(metrics.readMetrics().mood, BASE.mood + 3, '只应用一次 → 心情只 +3（两次就该是 +6 了），实际 ' + metrics.readMetrics().mood)
    assert.equal(metrics.readMetrics().curiosity, BASE.curiosity + 2, '好奇只 +2')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ j. energy<10：runActions 层什么都不做 ══════════════════════════ */

test('energy<10：runActions 层连只读都不做 —— 零执行、工具零调用、全部跳过', async () => {
  const env = metricsEnv('metrics-exhausted')
  try {
    const actions = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    schedule.unlock()
    schedule.saveSchedule({ allows: { read: true, dm: true, comment: true }, caps: { dm: 4, comment: 6 } })

    // 契约 §14.3（两档）：energy<20 保留 read+dm；energy<10 连 read 也关 —— 这一轮什么都不做。
    await seedMetrics({ ...BASE, energy: 8 })
    patchState({ counters: {}, silenceUntil: 0 })
    const effective = metrics.effectiveAllows(schedule.loadSchedule().allows, metrics.readMetrics())
    assert.equal(effective.read, false, '前提：energy=8 时 effectiveAllows 连 read 都关')
    assert.equal(metrics.behaviorHints(metrics.readMetrics()).maxWrites, 0, '前提：energy=8 时写动作预算 0')

    const watch = { name: 'bili_watch', description: '桩', calls: 0, async execute () { watch.calls += 1; return { ok: true, data: { count: 1 } } } }
    const comment = { name: 'bili_comment', description: '桩', calls: 0, async execute () { comment.calls += 1; return { ok: true, data: {} } } }
    const dm = { name: 'bili_dm', description: '桩', calls: 0, async execute () { dm.calls += 1; return { ok: true, data: {} } } }
    const deps = { tools: new Map([['bili_watch', watch], ['bili_comment', comment], ['bili_dm', dm]]), log: () => {} }

    const outcome = await actions.runActions({
      ok: true,
      actions: [
        { tool: 'bili_watch', args: { limit: 2 } },
        { tool: 'bili_comment', args: { bvid: 'BV1GJ411x7h7', message: '累了发不出' } },
        { tool: 'bili_dm', args: { text: '累了也不想说话' } },
      ],
    }, deps)

    assert.deepEqual(outcome.executed, [], 'energy<10 时一个动作都不许执行，实际 ' + JSON.stringify(outcome.executed))
    assert.equal(outcome.skipped.length, 3, '三个动作都必须记跳过，实际 ' + JSON.stringify(outcome.skipped))
    // why 是可观测契约：审计里唯一能解释"那天为什么一条都没动"的就是这个字符串。
    // 钉死它 —— 改文案等于改行为，应该让用例红，而不是静默漂移。
    for (const item of outcome.skipped) assert.equal(item.why, 'energy-too-low', '每个跳过的 reason 都必须是 energy-too-low，实际 ' + JSON.stringify(item))
    assert.equal(watch.calls, 0, 'energy<10 时连只读工具都不许被调用，实际 ' + watch.calls + ' 次')
    assert.equal(comment.calls, 0, '写工具同样零调用，实际 ' + comment.calls + ' 次')
    assert.equal(dm.calls, 0, '私信同样零调用，实际 ' + dm.calls + ' 次')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ k. curiosity 行为闸（2026-11-01 新） ══════════════════════════ */

test('curiosity 闸·纯函数：noExplore 在 curiosity<25 时为 true，阈值常量是 25', async () => {
  const env = metricsEnv('metrics-curiosity-hints')
  try {
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    assert.equal(metrics.CURIOSITY_EXPLORE_MIN, 25, '阈值常量必须导出且等于 25（否则规则会随实现漂移）')

    assert.equal(metrics.behaviorHints({ ...BASE, curiosity: 20 }).noExplore, true, 'curiosity=20 < 25 → 不探索')
    assert.equal(metrics.behaviorHints({ ...BASE, curiosity: 24 }).noExplore, true, '24 仍在阈值下')
    assert.equal(metrics.behaviorHints({ ...BASE, curiosity: 25 }).noExplore, false, '阈值本身（25）算"还有好奇"，不该被关')
    assert.equal(metrics.behaviorHints({ ...BASE, curiosity: 60 }).noExplore, false, 'curiosity=60 当然可以探索')

    // 提示文案要跟着变：noExplore 时 brain 上下文里会出现"不想探索"的意思
    const text = metrics.hintsText({ ...metrics.behaviorHints({ ...BASE, curiosity: 20 }) })
    assert.match(text, /探索|热门/, 'noExplore 时 hintsText 要给一句"今天不想探索"之类的话，实际：' + text)
    assert.equal(metrics.hintsText({ ...metrics.behaviorHints({ ...BASE, curiosity: 60 }) }).includes('不想探索'), false, '好奇正常时不该出现"不想探索"')
  } finally {
    env.restore()
  }
})

test('curiosity 闸·runActions：curiosity=20 时 bili_search / bili_playurl 记 low-curiosity 且零调用，bili_watch 照常', async () => {
  const env = metricsEnv('metrics-curiosity-low')
  try {
    const actions = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    schedule.unlock()
    schedule.saveSchedule({ allows: { read: true } })

    await seedMetrics({ ...BASE, curiosity: 20 })
    patchState({ counters: {}, silenceUntil: 0 })
    const watch = { name: 'bili_watch', description: '桩', calls: 0, async execute () { watch.calls += 1; return { ok: true, data: { count: 2, items: [] } } } }
    const search = { name: 'bili_search', description: '桩', calls: 0, async execute () { search.calls += 1; return { ok: true, data: { count: 0, items: [] } } } }
    const playurl = { name: 'bili_playurl', description: '桩', calls: 0, async execute () { playurl.calls += 1; return { ok: true, data: { urls: [] } } } }
    const deps = { tools: new Map([['bili_watch', watch], ['bili_search', search], ['bili_playurl', playurl]]), log: () => {} }

    const outcome = await actions.runActions({
      ok: true,
      actions: [
        { tool: 'bili_watch', args: { limit: 2 } },
        { tool: 'bili_search', args: { keyword: '想搜一下' } },
        { tool: 'bili_playurl', args: { bvid: 'BV1GJ411x7h7' } },
      ],
    }, deps)

    assert.deepEqual(outcome.executed.map((item) => item.tool), ['bili_watch'], '低好奇时只有"刷热门"该执行，实际 ' + JSON.stringify(outcome.executed))
    assert.deepEqual(
      outcome.skipped.map((item) => ({ tool: item.tool, why: item.why })),
      [{ tool: 'bili_search', why: 'low-curiosity' }, { tool: 'bili_playurl', why: 'low-curiosity' }],
      '两个探索动作都必须记 low-curiosity，实际 ' + JSON.stringify(outcome.skipped)
    )
    assert.equal(watch.calls, 1, 'bili_watch 要照常执行一次')
    assert.equal(search.calls, 0, '被 low-curiosity 挡下的 bili_search 绝不许调用，实际 ' + search.calls + ' 次')
    assert.equal(playurl.calls, 0, '被 low-curiosity 挡下的 bili_playurl 绝不许调用，实际 ' + playurl.calls + ' 次')
  } finally {
    env.restore()
  }
})

test('curiosity 闸·回归：curiosity=60 时 watch / search / playurl 三条都执行', async () => {
  const env = metricsEnv('metrics-curiosity-high')
  try {
    const actions = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    schedule.unlock()
    schedule.saveSchedule({ allows: { read: true } })

    await seedMetrics({ ...BASE, curiosity: 60 })
    patchState({ counters: {}, silenceUntil: 0 })
    const watch = { name: 'bili_watch', description: '桩', calls: 0, async execute () { watch.calls += 1; return { ok: true, data: {} } } }
    const search = { name: 'bili_search', description: '桩', calls: 0, async execute () { search.calls += 1; return { ok: true, data: {} } } }
    const playurl = { name: 'bili_playurl', description: '桩', calls: 0, async execute () { playurl.calls += 1; return { ok: true, data: {} } } }
    const deps = { tools: new Map([['bili_watch', watch], ['bili_search', search], ['bili_playurl', playurl]]), log: () => {} }

    const outcome = await actions.runActions({
      ok: true,
      actions: [
        { tool: 'bili_watch', args: { limit: 2 } },
        { tool: 'bili_search', args: { keyword: '想搜一下' } },
        { tool: 'bili_playurl', args: { bvid: 'BV1GJ411x7h7' } },
      ],
    }, deps)

    assert.equal(outcome.executed.length, 3, '好奇正常时三条都要执行，实际 ' + JSON.stringify(outcome.executed))
    assert.deepEqual(outcome.skipped, [], '好奇心正常时不该有任何 low-curiosity 跳过')
    assert.equal(watch.calls + search.calls + playurl.calls, 3, '三个工具各调用一次')
  } finally {
    env.restore()
  }
})

test('白名单 16 项：含 bili_playurl、仍不含 bili_image_upload；低好奇时 playurl 的理由是 low-curiosity 而不是 whitelist', async () => {
  const env = metricsEnv('metrics-whitelist')
  try {
    const actions = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    schedule.unlock()

    assert.equal(actions.WHITELIST.length, 16, '白名单必须是 16 项（第二批补了 bili_playurl），实际 ' + actions.WHITELIST.length + ' 项：' + actions.WHITELIST.join(','))
    assert.ok(actions.WHITELIST.includes('bili_playurl'), 'bili_playurl 必须在白名单里（否则 low-curiosity 永远看不到）')
    assert.equal(actions.WHITELIST.includes('bili_image_upload'), false, 'bili_image_upload 必须仍在白名单外（传图不算她的日常动作）')

    // 语义钉死：playurl 被拦的理由只能是 low-curiosity（白名单先拦的话就说明它没进白名单）
    schedule.saveSchedule({ allows: { read: true } })
    await seedMetrics({ ...BASE, curiosity: 20 })
    patchState({ counters: {}, silenceUntil: 0 })
    const playurl = { name: 'bili_playurl', description: '桩', calls: 0, async execute () { playurl.calls += 1; return { ok: true, data: {} } } }
    const deps = { tools: new Map([['bili_playurl', playurl]]), log: () => {} }
    const outcome = await actions.runActions({ ok: true, actions: [{ tool: 'bili_playurl', args: { bvid: 'BV1GJ411x7h7' } }] }, deps)
    assert.deepEqual(outcome.skipped, [{ tool: 'bili_playurl', why: 'low-curiosity' }], '低好奇时 reason 必须是 low-curiosity（不是 whitelist），实际 ' + JSON.stringify(outcome.skipped))
    assert.equal(playurl.calls, 0, '被挡下的 playurl 零调用')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ l. 按小时恢复精力（§19.2 regenEnergy） ══════════════════════════
 *
 * 为什么这样测：
 *   §19 的现场证据是"她每晚都会在清晨前累瘫，然后整晚不说话"。降消耗只是一半，另一半是
 *   按闲置时长回血 —— 而回血最容易错的不是速率，是**记账口径**：
 *     · 余数不能被丢掉（40 分钟 + 30 分钟必须凑成 1 小时，否则每次醒来都白丢 40 分钟）；
 *     · 同一时刻重复调用不能叠加（每次 tick 都会调它）；
 *     · 上限要 clamp（95 + 30 不能变成 125）。
 *   这里的 now 全部是固定时间戳（2026-11-03 12:00 一类），窗口由 schedule.json 决定，不依赖真实时钟。
 */

const HOUR = 3600 * 1000
/** 固定本地时间戳：2026-11-03 12:00（周二），后续按 HOUR 偏移。 */
const AT_NOON = new Date(2026, 10, 3, 12, 0, 0, 0).getTime()

/** 把"上次醒来"与精力钉成外部给定值，并清掉上次恢复点。 */
async function seedWake (energy, lastWakeAt) {
  const { patchState } = await import(repoUrl("lib/core/state.js"))
  patchState({
    metrics: { energy, mood: 55, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 },
    lastWakeAt: lastWakeAt === null ? "" : new Date(lastWakeAt).toISOString(),
    lastRegenAt: "",
  })
}

/** 把窗口设成"覆盖 AT_NOON"或"不覆盖 AT_NOON"。 */
async function seedWindow (covering) {
  const schedule = await import(repoUrl("lib/core/schedule.js"))
  schedule.unlock()
  const windows = covering ? [{ start: "00:00", end: "24:00" }] : [{ start: "20:00", end: "24:00" }]
  const saved = schedule.saveSchedule({ enabled: true, windows })
  assert.equal(saved.ok, true, "前提：窗口必须写成功")
  return schedule
}

test("regenEnergy·窗口内：闲置 3 小时 → added=9（+3/h），再 wake 扣 2", async () => {
  const env = metricsEnv("regen-in")
  try {
    const metrics = await import(repoUrl("lib/core/metrics.js"))
    await seedWindow(true)
    await seedWake(18, AT_NOON - 3 * HOUR)

    const result = metrics.regenEnergy(AT_NOON)
    assert.equal(result.added, 9, "窗口内闲置 3 小时应当 +9（3/h），实际 " + result.added)
    assert.equal(result.energy, 27, "18 + 9 = 27，实际 " + result.energy)
    assert.equal(metrics.readMetrics().energy, 27, "必须真的落盘")

    const woke = metrics.applyEvent("wake")
    assert.equal(woke.after.energy, 25, "醒来再扣 2（§19）→ 25，实际 " + woke.after.energy)
  } finally {
    env.restore()
  }
})

test("regenEnergy·窗口外：同样 3 小时 → added=18（+6/h）", async () => {
  const env = metricsEnv("regen-out")
  try {
    const metrics = await import(repoUrl("lib/core/metrics.js"))
    await seedWindow(false)   // 20:00–24:00 的窗口，AT_NOON(12:00) 在窗外
    const schedule = await import(repoUrl("lib/core/schedule.js"))
    assert.equal(schedule.inWindow(schedule.loadSchedule(), AT_NOON), false, "前提：AT_NOON 必须在窗口外")
    await seedWake(18, AT_NOON - 3 * HOUR)

    const result = metrics.regenEnergy(AT_NOON)
    assert.equal(result.added, 18, "窗口外（在睡）闲置 3 小时应当 +18（6/h），实际 " + result.added)
    assert.equal(result.energy, 36, "18 + 18 = 36，实际 " + result.energy)
  } finally {
    env.restore()
  }
})

test("regenEnergy·幂等：同一 now 连调两次，第二次 added=0", async () => {
  const env = metricsEnv("regen-idempotent")
  try {
    const metrics = await import(repoUrl("lib/core/metrics.js"))
    await seedWindow(true)
    await seedWake(18, AT_NOON - 3 * HOUR)

    const first = metrics.regenEnergy(AT_NOON)
    assert.equal(first.added, 9, "第一次应当 +9，实际 " + first.added)
    const second = metrics.regenEnergy(AT_NOON)
    assert.equal(second.added, 0, "同一时刻第二次不许再叠加（tick 里每次都会调它），实际 " + second.added)
    assert.equal(second.energy, 27, "能量也不许变，实际 " + second.energy)
  } finally {
    env.restore()
  }
})

test("regenEnergy·余数不丢：闲置 40 分钟不恢复，再过 30 分钟（累计 70 分钟）恢复 1 小时", async () => {
  const env = metricsEnv("regen-remainder")
  try {
    const metrics = await import(repoUrl("lib/core/metrics.js"))
    await seedWindow(true)
    await seedWake(18, AT_NOON - 40 * 60 * 1000)

    const early = metrics.regenEnergy(AT_NOON)
    assert.equal(early.added, 0, "不足 1 小时不该恢复，实际 " + early.added)
    assert.equal(early.energy, 18, "能量不变，实际 " + early.energy)

    // 再过 30 分钟：累计 70 分钟 → 结算 1 小时（+3），余下 10 分钟留给下一次
    const later = metrics.regenEnergy(AT_NOON + 30 * 60 * 1000)
    assert.equal(later.added, 3, "累计 70 分钟应当结算 1 小时 = +3（窗口内），实际 " + later.added)
    assert.equal(later.energy, 21, "18 + 3 = 21，实际 " + later.energy)
  } finally {
    env.restore()
  }
})

test("regenEnergy·上限与坏输入：energy=95 + 10 小时 → 100（clamp）；lastWakeAt 非法 → added=0 且不抛", async () => {
  const env = metricsEnv("regen-clamp")
  try {
    const metrics = await import(repoUrl("lib/core/metrics.js"))
    await seedWindow(true)
    await seedWake(95, AT_NOON - 10 * HOUR)

    const capped = metrics.regenEnergy(AT_NOON)
    assert.equal(capped.energy, 100, "95 + 30 必须封顶 100，实际 " + capped.energy)
    assert.equal(capped.added, 5, "added 要按实际增加量算（5，不是 30），实际 " + capped.added)

    // lastWakeAt 非法：首跑 / 坏文件时不许恢复、也不许抛
    const { patchState } = await import(repoUrl("lib/core/state.js"))
    patchState({ metrics: { energy: 40, mood: 55, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 }, lastWakeAt: "不是时间", lastRegenAt: "" })
    let bad = null
    assert.doesNotThrow(() => { bad = metrics.regenEnergy(AT_NOON) }, "坏 lastWakeAt 绝不许抛")
    assert.equal(bad.added, 0, "坏 lastWakeAt 不许恢复，实际 " + bad.added)
    assert.equal(bad.energy, 40, "能量不许变，实际 " + bad.energy)

    // 完全没有 lastWakeAt（首跑）也一样
    patchState({ metrics: { energy: 40, mood: 55, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 }, lastWakeAt: "", lastRegenAt: "" })
    const fresh = metrics.regenEnergy(AT_NOON)
    assert.equal(fresh.added, 0, "缺 lastWakeAt 时按首跑处理（不恢复），实际 " + fresh.added)
  } finally {
    env.restore()
  }
})
