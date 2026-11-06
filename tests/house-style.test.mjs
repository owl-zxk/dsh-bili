// tests/house-style.test.mjs —— 「怎么像人一样说话」（用户反馈：她的评论太人机）
//
// 判据不是"代码里有这段文案"，而是三段可执行的分阶段行为：
//   样本 <20 条 → 模仿期（明确要求照着套句式）；
//   20–59 条   → 混搭期（借结构 + 自己的观察）；
//   ≥60 条     → 自己的语气（先自己写，再对照检查）。
// 同时钉住"像人"的硬要求（短 / 口语 / 只说一个点 / 具体名词 / 不要书面起手式）真的进了上下文，
// 以及 off 模式（brain 主导）里也有同一条规矩 —— 两条路都得治，否则换个模式就复发。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

function styleEnv (tag, sampleCount) {
  const root = tmpDir(tag)
  const restoreSandbox = sandboxEnv(root)
  const restoreSelf = setEnv({ DSH_BILI_SELF_DIR: path.join(root, 'self') })
  fs.mkdirSync(path.join(root, 'self'), { recursive: true })
  fs.writeFileSync(path.join(root, 'self', 'state.json'), JSON.stringify({
    counters: {},
    silenceUntil: 0,
    metrics: { energy: 80, mood: 55, curiosity: 50, affinity: 50, boredom: 20, confidence: 50 },
    style: { count: sampleCount, lastDistillAt: new Date().toISOString(), lastDistillOk: true, lastDistillCount: sampleCount },
    learning: { count: 0, lastDistillAt: new Date().toISOString(), lastDistillOk: true, lastDistillCount: 0, topics: [] },
  }))
  return { root, selfDir: path.join(root, 'self'), restore () { restoreSelf(); restoreSandbox(); cleanupTmp() } }
}

const fakeLlm = (text) => ({
  calls: 0,
  stream () {
    this.calls += 1
    return (async function * () {
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
})

async function runTickAndRead (env) {
  const autonomy = await import(repoUrl('lib/core/autonomy.js'))
  const schedule = await import(repoUrl('lib/core/schedule.js'))
  autonomy.stop()
  schedule.unlock()
  schedule.saveSchedule({
    enabled: true,
    windows: [{ start: '00:00', end: '24:00' }],
    allows: { read: true },
    minWatchPerWake: false,
    commentAfterWatch: false,
    bedtimeReport: false,
    replyToMentions: false,
  })
  const llm = fakeLlm(JSON.stringify({ mood: '平静', say: '', actions: [], diary: '', memory: [] }))
  await autonomy.runOnce('manual', { tools: new Map(), llm, log: () => {}, ctx: {} })
  return fs.readFileSync(path.join(env.selfDir, 'wake-context.md'), 'utf8')
}

test('像人一样说话：样本少时进模仿期，并要求照样本句式替换内容', async () => {
  const env = styleEnv('hs-copy', 5)
  try {
    const text = await runTickAndRead(env)
    assert.ok(text.includes('## 怎么像人一样说话'), '上下文里必须有这一节')
    assert.ok(text.includes('模仿期'), '样本 5 条应该进模仿期，实际片段：' + text.slice(0, 900))
    assert.ok(text.includes('别整句复制'), '模仿期要明确"可以很近但不能整句复制"')
  } finally { env.restore() }
})

test('像人一样说话：样本攒到 30 条进混搭期（借结构 + 自己的观察）', async () => {
  const env = styleEnv('hs-mix', 30)
  try {
    const text = await runTickAndRead(env)
    assert.ok(text.includes('混搭期'), '样本 30 条应该进混搭期')
    assert.ok(text.includes('自己的一个观察'), '混搭期必须要求加自己的观察')
  } finally { env.restore() }
})

test('像人一样说话：样本 ≥60 条转自己的语气', async () => {
  const env = styleEnv('hs-own', 80)
  try {
    const text = await runTickAndRead(env)
    assert.ok(text.includes('自己的语气'), '样本 80 条应该转自己的语气')
  } finally { env.restore() }
})

test('像人一样说话：硬要求（短/口语/只说一个点/具体名词/禁书面起手式）都在上下文里', async () => {
  const env = styleEnv('hs-rules', 10)
  try {
    const text = await runTickAndRead(env)
    for (const must of ['40 字以内', '口语', '只说一个点', '具体名词', '这条视频讲述了', '我大概搞懂了']) {
      assert.ok(text.includes(must), '缺少硬要求：' + must)
    }
  } finally { env.restore() }
})

test('像人一样说话：off 模式（brain）的 system 里也有同一条规矩', () => {
  // brain 的提示词是模板字符串，逐条拼在 system 里；直接对源码断言最省事，
  // 也足以防止"只改了会话模式那条路"这种半修。
  const src = fs.readFileSync(fileURLToPath(repoUrl('lib/core/brain.js')), 'utf8')
  assert.ok(src.includes('像人一样说话'), 'brain 的 system 里必须也有这条规矩')
  assert.ok(src.includes('40 字以内'), 'brain 里同样要写"短"')
  assert.ok(src.includes('具体的名词'), 'brain 里同样要写"用具体的名词"')
})
