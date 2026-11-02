// tests/caps-unlimited.test.mjs —— 每日上限的「不限」（§17）
//
// 为什么这样测：
//   caps 从"每项都是数字"变成了"null = 不限 / 0 = 禁止 / 数字 = 上限"三态。
//   这三态里最容易出错的不是上限，而是**把 null 折成 0**（那等于全部禁止，她会一条都发不出去），
//   以及**计数也停了**（§17 明确要求"计数照旧记，只是超了不拦"）。所以：
//     · 默认档位下连跑 20 条评论，断言"没有 cap 跳过"且 todayCounts 真的涨到 20（不是"什么都没查"）；
//     · 保留的那个上限（dynamic=2）必须仍然真的拦；
//     · 0 与 null 用同一组输入对照着断言；
//     · dm 的折算只在上限存在时发生（无限 × 0.5 仍然是无限）。
//   全部假工具 + 临时 self 目录，零真实网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { BVID, cleanupTmp, localDayKey, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

const BASE_METRICS = { energy: 60, mood: 55, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 }

function capsEnv (tag) {
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

/** 假工具：记调用、返回成功。 */
function tool (name) {
  const t = {
    name,
    description: '桩',
    calls: [],
    async execute (args) { t.calls.push(args ?? {}); return { ok: true, data: {} } }
  }
  return t
}

/** 把"今天已发几条"钉成外部给定值（走 bumpCount 会顺带触发事件，影响 energy / affinity）。 */
async function seedCounts (counts) {
  const { patchState } = await import(repoUrl('lib/core/state.js'))
  patchState({ counters: { date: localDayKey(), counts: { dm: 0, comment: 0, reply: 0, dynamic: 0, like: 0, follow: 0, ...counts } } })
}

/** 每轮前把精力重置：否则第 11 条左右 energy<20 → maxWrites=0，跳过原因会变成 wake-budget。 */
async function resetEnergy () {
  const { patchState } = await import(repoUrl('lib/core/state.js'))
  const metrics = await import(repoUrl('lib/core/metrics.js'))
  patchState({ metrics: { ...metrics.readMetrics(), energy: 60 } })
}

/* ══════════════════════════ a. 默认档位不限量 ══════════════════════════ */

test('默认 caps=null：连跑 20 条评论全部执行、跳过里没有 cap、todayCounts.comment 涨到 20', async () => {
  const env = capsEnv('caps-unlimited')
  try {
    const actions = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    schedule.unlock()
    schedule.saveSchedule({ allows: { comment: true } })
    assert.equal(schedule.loadSchedule().caps.comment, null, '前提：默认 caps.comment 是 null（不限）')
    await seedCounts({})
    patchState({ silenceUntil: 0, metrics: { ...BASE_METRICS } })

    const comment = tool('bili_comment')
    const deps = { tools: new Map([['bili_comment', comment]]), log: () => {} }
    const skippedReasons = []
    for (let i = 1; i <= 20; i += 1) {
      await resetEnergy()          // 只重置精力，避免"累到 maxWrites=0"混进来
      // 每条用**不同 bvid**：§20.1「同一个 bvid 不重复评论」会把同 bvid 的第二条拦成 already-commented，
      // 那是另一条规则，不该混进「不限量」的验收集合里。
      const out = await actions.runActions({ ok: true, actions: [{ tool: 'bili_comment', args: { bvid: 'BV1GJ411x7h' + String(i).padStart(2, '0'), message: '第 ' + i + ' 条' } }] }, deps)
      assert.equal(out.executed.length, 1, '第 ' + i + ' 条应当执行（不限量），实际跳过：' + JSON.stringify(out.skipped))
      skippedReasons.push(...out.skipped.map((item) => item.why))
    }
    assert.equal(skippedReasons.includes('cap'), false, '不限量时绝不该出现 cap 跳过，实际 ' + JSON.stringify(skippedReasons))
    assert.equal(comment.calls.length, 20, '20 条都应该真的调用工具，实际 ' + comment.calls.length + ' 次')
    assert.equal(schedule.countsToday().comment, 20, '计数照旧要记（只是超了不拦）：todayCounts.comment 必须是 20，实际 ' + schedule.countsToday().comment)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ b. dynamic 仍限 2 ══════════════════════════ */

test('dynamic 仍是有上限的：默认 caps.dynamic=2 → 第 3 条 skipped=cap、工具只调用 2 次', async () => {
  const env = capsEnv('caps-dynamic')
  try {
    const actions = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    schedule.unlock()
    schedule.saveSchedule({ allows: { dynamic: true } })
    assert.equal(schedule.loadSchedule().caps.dynamic, 2, '前提：默认 caps.dynamic 是 2')
    await seedCounts({})
    patchState({ silenceUntil: 0, metrics: { ...BASE_METRICS } })

    const dynamic = tool('bili_dynamic')
    const deps = { tools: new Map([['bili_dynamic', dynamic]]), log: () => {} }
    const outcomes = []
    for (const text of ['第一条动态', '第二条动态', '第三条动态']) {
      await resetEnergy()
      outcomes.push(await actions.runActions({ ok: true, actions: [{ tool: 'bili_dynamic', args: { text } }] }, deps))
    }
    assert.equal(outcomes[0].executed.length, 1, '第 1 条动态应当执行')
    assert.equal(outcomes[1].executed.length, 1, '第 2 条动态应当执行')
    assert.deepEqual(outcomes[2].skipped, [{ tool: 'bili_dynamic', why: 'cap' }], '第 3 条必须被 cap 拦下，实际 ' + JSON.stringify(outcomes[2].skipped))
    assert.equal(dynamic.calls.length, 2, '被 cap 拦下的那条不许调用工具，实际 ' + dynamic.calls.length + ' 次')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ c. 0 = 禁止，null = 不限 ══════════════════════════ */

test('caps.comment=0 是禁止（第一条就 cap），caps.comment=null 是不限（对照着断言，不能混）', async () => {
  const env = capsEnv('caps-zero-vs-null')
  try {
    const actions = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    schedule.unlock()
    schedule.saveSchedule({ allows: { comment: true }, caps: { comment: 0 } })
    assert.equal(schedule.loadSchedule().caps.comment, 0, '前提：caps.comment 落成 0（不是 null）')
    await seedCounts({})
    patchState({ silenceUntil: 0, metrics: { ...BASE_METRICS } })

    const comment = tool('bili_comment')
    const deps = { tools: new Map([['bili_comment', comment]]), log: () => {} }
    const blocked = await actions.runActions({ ok: true, actions: [{ tool: 'bili_comment', args: { bvid: BVID, message: '禁止的评论' } }] }, deps)
    assert.deepEqual(blocked.skipped, [{ tool: 'bili_comment', why: 'cap' }], '0 = 禁止：第一条就该被 cap 拦下，实际 ' + JSON.stringify(blocked.skipped))
    assert.equal(comment.calls.length, 0, '0 = 禁止时一次都不许调用')

    // 对照：改成 null（不限）→ 同样一条立刻能发
    schedule.saveSchedule({ caps: { comment: null } })
    assert.equal(schedule.loadSchedule().caps.comment, null, '前提：改成 null 后读回来必须是 null（不是 0）')
    await resetEnergy()
    const allowed = await actions.runActions({ ok: true, actions: [{ tool: 'bili_comment', args: { bvid: BVID, message: '不限的评论' } }] }, deps)
    assert.equal(allowed.executed.length, 1, 'null = 不限：这条应当执行，实际跳过 ' + JSON.stringify(allowed.skipped))
    assert.equal(comment.calls.length, 1, '对照那一次应当真的调用工具')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ d. dm 折算只在上限存在时 ══════════════════════════ */

test('dm 折算：caps.dm=null + affinity=35 → 照发；caps.dm=4 + affinity=35 → 折算成 2，第 3 条 cap', async () => {
  const env = capsEnv('caps-dm-factor')
  try {
    const actions = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    schedule.unlock()
    schedule.saveSchedule({ allows: { dm: true } })
    patchState({ silenceUntil: 0 })

    const dm = tool('bili_dm')
    const deps = { tools: new Map([['bili_dm', dm]]), log: () => {} }

    // ① 不限：今天已经发过 99 条也不拦（无限大 × 0.5 仍是无限）
    schedule.saveSchedule({ caps: { dm: null } })
    await seedCounts({ dm: 99 })
    patchState({ metrics: { ...BASE_METRICS, affinity: 35 } })
    assert.equal(metrics.behaviorHints(metrics.readMetrics()).dmFactor, 0.5, '前提：affinity=35 时 dmFactor 是 0.5')
    assert.equal(metrics.effectiveCap(null, 'dm', metrics.behaviorHints(metrics.readMetrics())), null, '不限时折算后仍然是 null（不是 0）')
    const unlimited = await actions.runActions({ ok: true, actions: [{ tool: 'bili_dm', args: { text: '不限的一次' } }] }, deps)
    assert.equal(unlimited.executed.length, 1, 'caps.dm=null 时应当照发（哪怕计数已经 99），实际跳过 ' + JSON.stringify(unlimited.skipped))
    assert.equal(dm.calls.length, 1)

    // ② 有上限：4 × 0.5 = 2 → 已发 2 条就拦
    schedule.saveSchedule({ caps: { dm: 4 } })
    await seedCounts({ dm: 2 })
    patchState({ metrics: { ...BASE_METRICS, affinity: 35 } })
    assert.equal(metrics.effectiveCap(4, 'dm', metrics.behaviorHints(metrics.readMetrics())), 2, '4 × 0.5 必须折算成 2')
    const capped = await actions.runActions({ ok: true, actions: [{ tool: 'bili_dm', args: { text: '超额的一次' } }] }, deps)
    assert.deepEqual(capped.skipped, [{ tool: 'bili_dm', why: 'cap' }], '折算成 2 之后第 3 条必须被拦，实际 ' + JSON.stringify(capped.skipped))
    assert.equal(dm.calls.length, 1, '被拦的那条不许调用工具')

    // ③ 亲近度回到 50（dmFactor=1）→ 上限恢复 4 → 同样"已发 2 条"就放行
    patchState({ metrics: { ...BASE_METRICS, affinity: 50 } })
    const backToFour = await actions.runActions({ ok: true, actions: [{ tool: 'bili_dm', args: { text: '恢复额度的一次' } }] }, deps)
    assert.equal(backToFour.executed.length, 1, 'dmFactor=1 时上限是 4，已发 2 条应当放行，实际 ' + JSON.stringify(backToFour.skipped))
    assert.equal(dm.calls.length, 2)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ e. 旧文件兼容 ══════════════════════════ */

test('旧文件兼容：手写 caps:{comment:6,...} 的 schedule.json → caps.comment 仍是 6，且第 7 条被 cap 拦', async () => {
  const env = capsEnv('caps-legacy')
  try {
    const actions = await import(repoUrl('lib/core/actions.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    schedule.unlock()

    // 上一版落盘的样子：每项都是数字
    fs.writeFileSync(schedule.schedulePath(), JSON.stringify({
      enabled: true,
      allows: { read: true, dm: true, comment: true, reply: true, dynamic: true, like: true, follow: true },
      caps: { dm: 4, comment: 6, reply: 6, dynamic: 2, like: 10, follow: 2 },
      intervalMin: 45,
      jitter: 0.2,
    }))
    const loaded = schedule.loadSchedule()
    assert.equal(loaded.caps.comment, 6, '旧文件里的数字上限必须原样读出来，实际 ' + JSON.stringify(loaded.caps.comment))
    assert.equal(loaded.caps.dynamic, 2, '其它项同样保留')

    await seedCounts({ comment: 6 })      // 今天已经发满 6 条
    patchState({ silenceUntil: 0, metrics: { ...BASE_METRICS } })
    const comment = tool('bili_comment')
    const deps = { tools: new Map([['bili_comment', comment]]), log: () => {} }
    const out = await actions.runActions({ ok: true, actions: [{ tool: 'bili_comment', args: { bvid: BVID, message: '第 7 条' } }] }, deps)
    assert.deepEqual(out.skipped, [{ tool: 'bili_comment', why: 'cap' }], '第 7 条必须被旧上限拦下，实际 ' + JSON.stringify(out.skipped))
    assert.equal(comment.calls.length, 0, '被拦的那条不许调用工具')
  } finally {
    env.restore()
  }
})
