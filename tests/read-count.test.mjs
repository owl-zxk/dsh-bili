// tests/read-count.test.mjs —— read 计数的语义（§18 之后：主动读也计）
//
// 为什么单独测这个数：
//   「今天看了几条」是睡前汇报里的第一行，也是主人判断「她到底有没有在过日子」的唯一量化证据。
//   它最容易出的错是**双计**（兜底 + 动作各记一次 → 汇报里数字翻倍）与**漏计**
//   （读动作不计 → 汇报里永远是 0）。所以这里分开钉：主动读计 1、兜底只计 1、失败不计。
//   全部假工具 + 临时 self 目录，零真实网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { BVID, cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

const BASE_METRICS = { energy: 60, mood: 55, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 }

function readEnv (tag) {
  const root = tmpDir(tag)
  const restoreSandbox = sandboxEnv(root)
  const restoreSelf = setEnv({ DSH_BILI_SELF_DIR: path.join(root, 'self') })
  fs.mkdirSync(path.join(root, 'self'), { recursive: true })
  return { root, selfDir: path.join(root, 'self'), restore () { restoreSelf(); restoreSandbox(); cleanupTmp() } }
}

function tool (name, handler = () => ({ ok: true, data: {} })) {
  const t = { name, description: '桩', calls: [], async execute (args) { t.calls.push(args ?? {}); return handler(args ?? {}) } }
  return t
}

function fakeLlm (decision) {
  return { calls: 0, async *stream () { this.calls += 1; yield { type: 'text-delta', text: JSON.stringify(decision) }; yield { type: 'finish', reason: { kind: 'ok' } } } }
}

async function primeSchedule (over = {}) {
  const schedule = await import(repoUrl('lib/core/schedule.js'))
  schedule.unlock()
  const saved = schedule.saveSchedule({ enabled: true, windows: [{ start: '00:00', end: '24:00' }], allows: { read: true, comment: true, dm: true }, minWatchPerWake: false, ...over })
  assert.equal(saved.ok, true, '前提：日程必须写成功，实际 ' + JSON.stringify(saved))
  return schedule
}

async function seedState (patch = {}) {
  const { patchState } = await import(repoUrl('lib/core/state.js'))
  patchState({ counters: {}, silenceUntil: 0, metrics: { ...BASE_METRICS }, ...patch })
}

test('主动读计数：bili_watch 成功 +1、连续 3 次 = 3、读失败不计、写动作只加 comment 不动 read', async () => {
  const env = readEnv('read-active')
  try {
    const actions = await import(repoUrl('lib/core/actions.js'))
    const schedule = await primeSchedule()
    await seedState()
    const watch = tool('bili_watch', () => ({ ok: true, data: { count: 2, items: [{ bvid: BVID }] } }))
    const comment = tool('bili_comment', () => ({ ok: true, data: { rpid: 1 } }))
    const deps = { tools: new Map([['bili_watch', watch], ['bili_comment', comment]]), log: () => {} }
    const run = (list) => actions.runActions({ ok: true, actions: list }, deps)

    const first = await run([{ tool: 'bili_watch', args: { limit: 2 } }])
    assert.equal(first.executed.length, 1, '读动作应当执行')
    assert.equal(schedule.countsToday().read, 1, '模型主动读一次必须记 1 次，实际 ' + schedule.countsToday().read)

    await run([{ tool: 'bili_watch', args: { limit: 3 } }])
    await run([{ tool: 'bili_watch', args: { limit: 4 } }])
    assert.equal(schedule.countsToday().read, 3, '连续三次主动读必须累计到 3，实际 ' + schedule.countsToday().read)

    const failing = tool('bili_video_info', () => ({ ok: false, reason: 'bili-error', human: '挂了' }))
    const depsFail = { tools: new Map([['bili_video_info', failing]]), log: () => {} }
    const failed = await actions.runActions({ ok: true, actions: [{ tool: 'bili_video_info', args: { bvid: BVID } }] }, depsFail)
    assert.equal(failed.executed.length, 1, '失败的动作也会出现在 executed 里（带 ok:false）')
    assert.equal(schedule.countsToday().read, 3, '读失败绝不许计数，实际 ' + schedule.countsToday().read)

    const wrote = await run([{ tool: 'bili_comment', args: { bvid: BVID, message: '说一句' } }])
    assert.equal(wrote.executed.length, 1, '评论应当执行')
    const counts = schedule.countsToday()
    assert.equal(counts.comment, 1, '评论成功必须记 comment=1，实际 ' + counts.comment)
    assert.equal(counts.read, 3, '写动作不许把 read 也加一（read 只认只读通道），实际 ' + counts.read)
  } finally {
    env.restore()
  }
})

test('不双计：空动作触发 ensureMinWatch 兜底 → read 恰为 1（不是 2），且 bili_watch 只被调 1 次', async () => {
  const env = readEnv('read-fallback-once')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const schedule = await primeSchedule({ minWatchPerWake: true })
    autonomy.stop()
    await seedState()
    const memes = await import(repoUrl('lib/core/memes.js'))
    fs.writeFileSync(memes.memesPath(), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'llm', stage: 'fresh', items: [], lastAttemptAt: '', lastMemeError: '' }))

    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid: BVID }] } }))
    const info = tool('bili_video_info', () => ({ ok: true, data: { bvid: BVID } }))
    const llm = fakeLlm({ mood: '平静', say: '', actions: [], diary: '', memory: [] })
    const deps = { tools: new Map([['bili_watch', watch], ['bili_video_info', info]]), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('manual', deps)
    assert.equal(result.ok, true, '这一轮应当成功')
    assert.equal(watch.calls.length, 1, '兜底只该调一次 bili_watch，实际 ' + watch.calls.length + ' 次')
    assert.equal(info.calls.length, 1, '拿到列表后看一次详情，实际 ' + info.calls.length + ' 次')
    assert.equal(schedule.countsToday().read, 1, '兜底整轮只该记 1 次 read（不是 2：内部两个工具不各记一次），实际 ' + schedule.countsToday().read)
  } finally {
    env.restore()
  }
})
