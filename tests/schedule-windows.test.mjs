// tests/schedule-windows.test.mjs —— 多时段 + 跨午夜 + 周末全天（AUTONOMY-PROMPT §16）
//
// 为什么这样测：
//   作息判定决定"她什么时候会动"，而它以前只有一个时段 —— 一个时段写错，最坏的后果是
//   **整夜空转醒来**（每次醒来都可能烧一次模型）。所以这里全部用**固定时间戳**注入，
//   不依赖真实时钟（否则用例只在某个钟点跑得对）：
//     · 多时段：任一时段命中即为在窗口内；窗口外 nextWindowStart 要给"最近的开始"；
//     · 跨午夜：22:00–02:00 在 01:00 命中、03:00 不命中（"今天开始–明天结束"）；
//     · 周末全天：周六/周日恒在窗口内、间隔用 weekendIntervalMin；工作日回落到 intervalMin。
//   ⚠️ 参数顺序别搞混：inWindow(schedule, now) 与 nextWindowStart(schedule, now) 是 (schedule, now)，
//      而 canRunNow(now, schedule) 与 nextWakeAt(now, schedule) 是 (now, schedule)。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

function scheduleEnv (tag) {
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

/** 本地时间戳（固定日期，不信真实时钟）。 */
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute, 0, 0).getTime()
/** 某个本地日期 00:00。 */
const midnightOf = (day) => new Date(2026, 10, day, 0, 0, 0, 0).getTime()
const WEEK = ['日', '一', '二', '三', '四', '五', '六']
/** 用例里先断言"这天确实是星期几"，日期算错时立刻炸，而不是让窗口断言去猜。 */
function assertWeekday (day, expected) {
  const actual = new Date(2026, 10, day, 12, 0, 0, 0).getDay()
  assert.equal(actual, expected, '前提：2026-11-' + day + ' 应当是周' + WEEK[expected] + '，实际周' + WEEK[actual])
}

/** 造一份纯对象日程（不走文件，避免与 saveSchedule 的合并逻辑纠缠）。 */
const sched = (over = {}) => ({
  enabled: true,
  windows: [{ start: '20:00', end: '24:00' }],
  intervalMin: 45,
  weekendIntervalMin: 90,
  weekendAllDay: false,
  jitter: 0,
  ...over,
})

/* ══════════════════════════ a. 多时段 ══════════════════════════ */

test('多时段：周二 10:00 在 / 13:00 不在 / 21:00 在；nextWindowStart(13:00)=当天 20:00、(23:00)=null', async () => {
  const env = scheduleEnv('win-multi')
  try {
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    schedule.unlock()
    assertWeekday(3, 2)   // 2026-11-03 周二
    const s = sched({ windows: [{ start: '09:00', end: '12:00' }, { start: '20:00', end: '24:00' }] })

    assert.equal(schedule.inWindow(s, at(3, 10)), true, '周二 10:00 落在第一个时段里，必须在窗口内')
    assert.equal(schedule.inWindow(s, at(3, 13)), false, '周二 13:00 在两个时段之间，必须不在窗口内')
    assert.equal(schedule.inWindow(s, at(3, 21)), true, '周二 21:00 落在第二个时段里，必须在窗口内')
    // 边界：起点含、终点不含（与 §11 一致）
    assert.equal(schedule.inWindow(s, at(3, 9)), true, '09:00 是起点，应包含')
    assert.equal(schedule.inWindow(s, at(3, 12)), false, '12:00 是终点，应排除')

    const next = schedule.nextWindowStart(s, at(3, 13))
    assert.equal(next, at(3, 20), '13:00 的下一个窗口开始必须是当天 20:00，实际 ' + new Date(next ?? 0).toLocaleString('sv-SE'))

    assert.equal(schedule.nextWindowStart(s, at(3, 21)), null, '已经在窗口内时 nextWindowStart 必须回 null（调用方改用间隔）')

    // canRunNow 的判据也走多时段（注意参数顺序：canRunNow(now, schedule)）
    assert.equal(schedule.canRunNow(at(3, 13), s).reason, 'outside-window', '13:00 的 canRunNow 必须是 outside-window')
    assert.equal(schedule.canRunNow(at(3, 10), s).ok, true, '10:00 的 canRunNow 必须放行')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ b. 跨午夜 ══════════════════════════ */

test('跨午夜：22:00–02:00 在 01:00 / 23:30 命中、03:00 不命中；nextWindowStart(03:00)=当天 22:00', async () => {
  const env = scheduleEnv('win-midnight')
  try {
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    schedule.unlock()
    const s = sched({ windows: [{ start: '22:00', end: '02:00' }] })

    assert.equal(schedule.inWindow(s, at(3, 1)), true, '01:00 在 22:00–02:00 里（跨午夜），必须命中')
    assert.equal(schedule.inWindow(s, at(3, 23, 30)), true, '23:30 在 22:00–02:00 里，必须命中')
    assert.equal(schedule.inWindow(s, at(3, 3)), false, '03:00 已经出了 22:00–02:00，必须不命中')
    assert.equal(schedule.inWindow(s, at(3, 2)), false, '02:00 是终点，应排除')

    const next = schedule.nextWindowStart(s, at(3, 3))
    assert.equal(next, at(3, 22), '03:00 的下一个窗口开始必须是当天 22:00，实际 ' + new Date(next ?? 0).toLocaleString('sv-SE'))
    assert.equal(schedule.nextWindowStart(s, at(3, 23, 30)), null, '已经在跨午夜窗口里时 nextWindowStart 必须回 null')
    assert.equal(schedule.canRunNow(at(3, 1), s).ok, true, '01:00 的 canRunNow 必须放行')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ c. 周末全天 ══════════════════════════ */

test('周末全天：周六/周日 15:00 恒在窗口、间隔用 weekendIntervalMin；周一 15:00 不在窗口、21:00 回落 intervalMin', async () => {
  const env = scheduleEnv('win-weekend')
  try {
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    schedule.unlock()
    assertWeekday(7, 6)    // 周六
    assertWeekday(8, 0)    // 周日
    assertWeekday(9, 1)    // 周一

    const s = sched({ weekendAllDay: true, weekendIntervalMin: 90, intervalMin: 45, windows: [{ start: '09:00', end: '12:00' }, { start: '20:00', end: '24:00' }] })
    patchState({ silenceUntil: 0, counters: {} })

    // ① 周六 15:00：本来不在任何时段里，但周末全天规则让它算"在窗口内"
    const sat = at(7, 15)
    assert.equal(schedule.inWindow(s, sat), true, '周末全天开启时，周六 15:00 必须在窗口内')
    assert.equal(schedule.canRunNow(sat, s).ok, true, '周六 15:00 的 canRunNow 必须放行')
    assert.equal(schedule.nextWindowStart(s, sat), null, '周末全天时周六 15:00 已经在窗口内，nextWindowStart 必须是 null')
    assert.equal(schedule.nextWakeAt(sat, s), sat + 90 * 60_000, '周六的醒来间隔必须用 weekendIntervalMin（90 分钟），实际 ' + Math.round((schedule.nextWakeAt(sat, s) - sat) / 60000) + ' 分钟')

    // ② 周日同理
    const sun = at(8, 15)
    assert.equal(schedule.inWindow(s, sun), true, '周日 15:00 也必须在窗口内')
    assert.equal(schedule.nextWakeAt(sun, s), sun + 90 * 60_000, '周日的醒来间隔同样用 weekendIntervalMin')

    // ③ 周一 15:00：周末规则不适用，且不在时段里
    const mon = at(9, 15)
    assert.equal(schedule.inWindow(s, mon), false, '周一 15:00 不在任何时段里，必须不命中（周末规则只管周六周日）')
    assert.equal(schedule.nextWindowStart(s, mon), at(9, 20), '周一 15:00 的下一个窗口开始必须是当天 20:00')
    assert.equal(schedule.nextWakeAt(mon, s), at(9, 20), '窗口外的 nextWakeAt 必须直接给下一个窗口开始')

    // ④ 周一 21:00：在时段内，间隔回落到 intervalMin
    const monNight = at(9, 21)
    assert.equal(schedule.inWindow(s, monNight), true, '周一 21:00 在 20:00–24:00 里')
    assert.equal(schedule.nextWakeAt(monNight, s), monNight + 45 * 60_000, '工作日的间隔必须回落到 intervalMin（45 分钟），实际 ' + Math.round((schedule.nextWakeAt(monNight, s) - monNight) / 60000) + ' 分钟')

    // ⑤ 关掉 weekendAllDay：周六 15:00 立刻变回"不在窗口内"
    const off = sched({ ...s, weekendAllDay: false })
    assert.equal(schedule.inWindow(off, sat), false, 'weekendAllDay=false 时周六 15:00 必须不命中')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ d. 旧配置兼容 ══════════════════════════ */

test('旧配置兼容：只有 window:{start,end} 的文件 → windows 长度 1 且值正确；saveSchedule 后 windows 与 window 同时在且 window===windows[0]', async () => {
  const env = scheduleEnv('win-legacy')
  try {
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    schedule.unlock()

    // 只写旧字段，模拟上一版落盘的 schedule.json
    fs.writeFileSync(schedule.schedulePath(), JSON.stringify({ enabled: true, window: { start: '09:00', end: '12:00' }, intervalMin: 45, jitter: 0.2 }))
    const loaded = schedule.loadSchedule()
    assert.equal(Array.isArray(loaded.windows), true, 'windows 必须是数组')
    assert.equal(loaded.windows.length, 1, '旧文件的单时段必须被当成一个时段，实际 ' + loaded.windows.length + ' 个')
    assert.deepEqual(loaded.windows[0], { start: '09:00', end: '12:00' }, '时段值必须原样保留，实际 ' + JSON.stringify(loaded.windows[0]))
    assert.deepEqual(loaded.window, { start: '09:00', end: '12:00' }, '旧字段 window 也要给（恒等于 windows[0]）')

    // 保存之后再读盘：windows 与 window 必须同时在，且 window === windows[0]
    const saved = schedule.saveSchedule({ intervalMin: 30 })
    assert.equal(saved.ok, true, '保存必须成功，实际 ' + JSON.stringify(saved))
    const onDisk = JSON.parse(fs.readFileSync(schedule.schedulePath(), 'utf8'))
    assert.equal(Array.isArray(onDisk.windows), true, '落盘必须有 windows 数组')
    assert.equal(onDisk.windows.length, 1, '这次没改时段，windows 长度应保持 1')
    assert.deepEqual(onDisk.window, onDisk.windows[0], '落盘的 window 必须恒等于 windows[0]（旧读取方不会炸）')
    assert.equal(onDisk.intervalMin, 30, 'intervalMin 要真的落盘')

    // 多时段落盘：window 仍然只等于第一个
    const multi = schedule.saveSchedule({ windows: [{ start: '09:00', end: '12:00' }, { start: '20:00', end: '24:00' }] })
    assert.equal(multi.ok, true, '多时段保存必须成功，实际 ' + JSON.stringify(multi))
    const disk2 = JSON.parse(fs.readFileSync(schedule.schedulePath(), 'utf8'))
    assert.equal(disk2.windows.length, 2, '两个时段都要落盘')
    assert.deepEqual(disk2.window, disk2.windows[0], 'window 恒等于 windows[0]（不是最后一个）')
  } finally {
    env.restore()
  }
})
