// tests/run-once-lock.test.mjs —— 回归：锁内 canRunNow 把自己判成 busy（2026-11-01 真机事故）
//
// 为什么单独一个文件钉这一条：
//   这是"静默失效"型 bug —— 没有报错、没有异常，只是**所有定时醒来都变成 busy**。
//   真机上的表现是"她从来没有自己醒过"、lastSkip.reason 一直是 busy，而 manual 还能跑
//   （因为 manual 跳过 canRunNow），所以人很容易误判成"作息配错了"。
//   一条用例只能钉住一边，所以这里钉三边：
//     ① 语义：持锁时 canRunNow 默认 busy，但 ignoreLock 必须放行；
//     ② 端到端：runOnce('timer') 必须**真的执行**并留下 trigger=timer 的 wake 审计；
//     ③ 防修过头：外部真的占着锁时，runOnce('timer') 仍必须是 busy（不能一律放行）。
//   全部假 llm / 假工具 + 临时 self 目录，零真实网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { BVID, cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

function lockEnv (tag) {
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

/** 假工具：记调用。 */
function tool (name, data = {}) {
  const t = { name, description: '桩', calls: [], async execute (args) { t.calls.push(args ?? {}); return { ok: true, data } } }
  return t
}

/** 假 llm：一次调用给一个 JSON 决策（分片协议与 brain 一致）。 */
function fakeLlm (decision = { mood: '平静', say: '', actions: [], diary: '', memory: [] }) {
  return {
    calls: 0,
    async *stream () {
      this.calls += 1
      yield { type: 'text-delta', text: JSON.stringify(decision) }
      yield { type: 'finish', reason: { kind: 'ok' } }
    }
  }
}

const decorate = (obj, extra) => Object.assign(obj, extra)

/** 本地 HH:MM（用于构造"此刻一定不在里面"的窗口）。 */
const clock = (minutes) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
}
const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() }

/* ══════════════════════════ 1. 语义对照 ══════════════════════════ */

test('持锁时 canRunNow 默认 busy；带 { ignoreLock: true } 则放行', async () => {
  const env = lockEnv('lock-semantics')
  try {
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    schedule.unlock()
    const s = { enabled: true, windows: [{ start: '00:00', end: '24:00' }], intervalMin: 45, jitter: 0, weekendAllDay: false, weekendIntervalMin: 90 }
    patchState({ silenceUntil: 0 })

    // 拿锁之前：正常放行
    assert.equal(schedule.canRunNow(Date.now(), s).ok, true, '没别人占锁、窗口也覆盖时应当放行')

    // 自己占着锁：默认判 busy（这是给"外面的人"用的语义）
    assert.equal(schedule.tryLock(), true, '第一把锁必须拿到')
    try {
      const blocked = schedule.canRunNow(Date.now(), s)
      assert.equal(blocked.ok, false, '持锁时 canRunNow 默认必须拒')
      assert.equal(blocked.reason, 'busy', 'reason 必须是 busy，实际 ' + blocked.reason)

      // 锁内自问自答：必须能放行，否则所有定时醒来都会变成 busy（真机事故）
      const inside = schedule.canRunNow(Date.now(), s, { ignoreLock: true })
      assert.equal(inside.ok, true, '带 ignoreLock 时必须放行，实际 ' + JSON.stringify(inside))
      assert.equal(inside.reason, undefined, '放行时不该带 reason')
    } finally {
      schedule.unlock()
    }
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 2. 端到端回归（关键） ══════════════════════════ */

test('runOnce(timer) 在窗口内必须真的执行：executed 非空、留下 trigger=timer 的 wake 审计、lastSkip 不是 busy', async () => {
  const env = lockEnv('lock-timer')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    const { patchState, readState } = await import(repoUrl('lib/core/state.js'))
    autonomy.stop()
    schedule.unlock()
    patchState({ counters: {}, silenceUntil: 0 })
    // 窗口覆盖"现在"：00:00–24:00 全天，保证与运行时刻无关
    schedule.saveSchedule({ enabled: true, windows: [{ start: '00:00', end: '24:00' }], allows: { read: true } })

    const watch = tool('bili_watch', { count: 2, items: [] })
    const llm = fakeLlm({ mood: '平静', say: '看一眼热门', actions: [{ tool: 'bili_watch', args: { limit: 2 }, why: '刷一下' }], diary: '今天很安静', memory: [] })
    const deps = { tools: new Map([['bili_watch', watch]]), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('timer', deps)

    // 这条断言就是真机事故的正面：定时醒来什么都做不了时，这里会是 ok:false / reason:busy。
    // 报错里同时带上 state.lastSkip.reason —— 真机上人看到的就是"lastSkip 一直是 busy"。
    const skipAfter = readState().lastSkip
    assert.equal(
      result.ok,
      true,
      '定时醒来什么都没做（result.reason=' + String(result.reason) + '，lastSkip.reason=' + String(skipAfter?.reason ?? 'null') + '）'
    )
    assert.ok(Array.isArray(result.executed) && result.executed.length > 0, '定时醒来必须真的执行了动作，实际 executed=' + JSON.stringify(result.executed))
    assert.equal(watch.calls.length, 1, 'bili_watch 应当被真的调用一次，实际 ' + watch.calls.length + ' 次')

    const wake = audit.readAudit(20).filter((row) => row.tool === 'wake')
    assert.ok(wake.length >= 1, '必须留下一条 wake 审计，实际 ' + JSON.stringify(audit.readAudit(20)).slice(0, 200))
    assert.equal(wake.at(-1).args.trigger, 'timer', 'wake 审计里的 trigger 必须是 timer，实际 ' + JSON.stringify(wake.at(-1).args.trigger))

    const lastSkip = readState().lastSkip
    assert.notEqual(lastSkip?.reason, 'busy', '定时醒来绝不该因为自锁被记成 busy，实际 lastSkip=' + JSON.stringify(lastSkip))
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 3. 防修过头 ══════════════════════════ */

test('外部真的占着锁时 runOnce(timer) 仍然是 busy（ignoreLock 不许把并发放行）', async () => {
  const env = lockEnv('lock-real-busy')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    autonomy.stop()
    schedule.unlock()
    patchState({ counters: {}, silenceUntil: 0 })
    schedule.saveSchedule({ enabled: true, windows: [{ start: '00:00', end: '24:00' }], allows: { read: true } })

    const watch = tool('bili_watch', { count: 1, items: [] })
    const llm = fakeLlm({ mood: '平静', say: '', actions: [{ tool: 'bili_watch', args: { limit: 1 } }], diary: '', memory: [] })
    const deps = { tools: new Map([['bili_watch', watch]]), llm, log: () => {}, ctx: {} }

    assert.equal(schedule.tryLock(), true, '前提：模拟"另一个人正占着锁"')
    try {
      // canRunNow 这一层同样不许把"别人占着锁"放行：ignoreLock 是**锁内自问**的开关，
      // 不是全局免检。修"自锁"时最容易顺手把这里也一起放开。
      const direct = schedule.canRunNow(Date.now(), schedule.loadSchedule())
      assert.equal(direct.ok, false, '外部占着锁时，不带 ignoreLock 的 canRunNow 必须拒')
      assert.equal(direct.reason, 'busy', '外部占着锁时 reason 必须是 busy（真并发不能被放行），实际 ' + direct.reason)

      const result = await autonomy.runOnce('timer', deps)
      assert.equal(result.ok, false, '锁被外部占着时，第二次醒来必须失败')
      assert.equal(result.reason, 'busy', 'reason 必须是 busy（真并发不能被放行），实际 ' + result.reason)
      assert.equal(watch.calls.length, 0, '被 busy 挡下的那次不许调用任何工具，实际 ' + watch.calls.length + ' 次')
      assert.equal(llm.calls, 0, '被 busy 挡下的那次连模型都不该调，实际 ' + llm.calls + ' 次')
    } finally {
      schedule.unlock()
    }
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 4. manual 不受影响 ══════════════════════════ */

test('manual 在窗口外也能跑（既有行为回归）', async () => {
  const env = lockEnv('lock-manual')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    autonomy.stop()
    schedule.unlock()
    patchState({ counters: {}, silenceUntil: 0 })
    // 构造一个"此刻一定不在里面"的窗口：现在 +3 小时 ~ +4 小时
    const start = clock(nowMinutes() + 180)
    const end = clock(nowMinutes() + 240)
    schedule.saveSchedule({ enabled: true, windows: [{ start, end }] })
    const s = schedule.loadSchedule()
    assert.equal(schedule.inWindow(s, Date.now()), false, '前提：此刻应当不在窗口内（' + start + '–' + end + '）')

    const watch = tool('bili_watch', { count: 1, items: [] })
    const llm = fakeLlm({ mood: '平静', say: '', actions: [{ tool: 'bili_watch', args: { limit: 1 } }], diary: '', memory: [] })
    const deps = { tools: new Map([['bili_watch', watch]]), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('manual', deps)
    assert.equal(result.ok, true, 'manual 必须无视窗口（这是设置页"现在醒一次"的语义），实际 ' + JSON.stringify(result).slice(0, 200))
    assert.ok(result.executed.length > 0, 'manual 在窗口外也必须真的执行动作，实际 ' + JSON.stringify(result.executed))
    assert.equal(watch.calls.length, 1, 'manual 应当真的调用一次工具')

    // 对照：同样的窗口，timer 必须被 outside-window 挡下（否则"窗口"这个功能是假的）
    const blocked = await autonomy.runOnce('timer', deps)
    assert.equal(blocked.ok, false, '窗口外 timer 必须失败')
    assert.equal(blocked.reason, 'outside-window', '窗口外 timer 的 reason 必须是 outside-window，实际 ' + blocked.reason)
    assert.equal(watch.calls.length, 1, '被窗口挡下的 timer 不许再调用工具')
  } finally {
    env.restore()
  }
})
