// tests/deepwatch-accuracy.test.mjs —— 深度理解的两个准确度开关
//
// 真机背景（2026-11-05，用户选了 C 方案）：
//   ① 原来 `detail` 写死 'standard'、从来不开 adaptive —— 均匀抽几帧，摘要只能写成
//      "开头…随后…后段…"的流水账；adaptive 才是"回头看一眼某个时间段"的唯一手段。
//   ② 缓存键只有 bvid：10 分钟内换个问题再问，拿回来的是**上一个问题的答案**，
//      而且带着 cached:true 看起来一切正常 —— 不报错，只悄悄变笨。
// 这里钉住：精度档真的传下去了；换问题不吃旧缓存；同问题仍复用缓存（省钱不能丢）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

function env (tag) {
  const root = tmpDir(tag)
  const restoreSandbox = sandboxEnv(root)
  const restoreSelf = setEnv({ DSH_BILI_SELF_DIR: path.join(root, 'self') })
  fs.mkdirSync(path.join(root, 'self'), { recursive: true })
  fs.writeFileSync(path.join(root, 'self', 'state.json'), JSON.stringify({ counters: {}, silenceUntil: 0, metrics: { energy: 80, mood: 55, curiosity: 50, affinity: 50, boredom: 20, confidence: 50 } }))
  return { root, selfDir: path.join(root, 'self'), restore () { restoreSelf(); restoreSandbox(); cleanupTmp() } }
}

function makeDeps (seen) {
  return {
    // 宿主工具口子：findVideoUnderstand 会走 ctx.get('tools').get('video_understand')
    ctx: {
      get: (name) => (name === 'tools'
        ? {
            get: (toolName) => (toolName === 'video_understand'
              ? {
                  execute: async (args) => {
                    seen.push(args)
                    return { ok: true, data: { summary: '这条在讲分镜', answer: '答案是分镜', scenes: 3, transcriptLines: 12, durationMs: 61000, model: 'x/y', failures: [] } }
                  },
                }
              : undefined)
          }
        : undefined),
    },
    api: {
      playurl: async () => ({ ok: true, data: { urls: [{ url: 'https://example.invalid/a.mp4', size: 1024 }] } }),
      videoInfo: async () => ({ ok: true, data: { duration: 61 } }),
    },
    downloadFile: async (url, file) => {
      fs.writeFileSync(file, 'x')
      return { ok: true, bytes: 1024 }
    },
  }
}

test('深度理解走 C 方案：detail=deep + adaptive + 轮数/额外帧封顶 + 中文转录', async () => {
  const e = env('dw-detail')
  try {
    const { deepWatch } = await import(repoUrl('lib/core/deepwatch.js'))
    const seen = []
    const r = await deepWatch({ bvid: 'BV1CAnN6uEUN', question: '这条讲了什么', deps: makeDeps(seen) })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(seen.length, 1, '应当只调一次 video_understand')
    const args = seen[0]
    assert.equal(args.detail, 'deep', '精度档必须是 deep（C 方案）')
    assert.equal(args.adaptive, true, '必须开自适应重采样')
    assert.equal(args.maxRounds, 3, '重采样轮数封顶 3')
    assert.equal(args.maxExtraFrames, 12, '额外帧总数封顶 12')
    assert.equal(args.lang, 'zh', '中文不要用 auto（会被误判成粤语/日文）')
    assert.equal(args.question, '这条讲了什么', '问题要原样传下去')
  } finally { e.restore() }
})

test('缓存按「bvid + 问题」区分：换个问题必须重新看，不能拿上一个问题的答案', async () => {
  const e = env('dw-cache-q')
  try {
    const { deepWatch } = await import(repoUrl('lib/core/deepwatch.js'))
    const seen = []
    const deps = makeDeps(seen)
    const first = await deepWatch({ bvid: 'BV1CAnN6uEUN', question: '这条讲了什么', deps })
    assert.equal(first.data.cached, false)
    const second = await deepWatch({ bvid: 'BV1CAnN6uEUN', question: '结尾发生了什么', deps })
    assert.equal(seen.length, 2, '换了问题就必须再调一次，不能吃旧缓存')
    assert.equal(second.data.cached, false, '换问题不应命中缓存')
  } finally { e.restore() }
})

test('缓存仍按「bvid + 同问题」复用：10 分钟内不重复下载（省钱那条不能丢）', async () => {
  const e = env('dw-cache-same')
  try {
    const { deepWatch } = await import(repoUrl('lib/core/deepwatch.js'))
    const seen = []
    const deps = makeDeps(seen)
    await deepWatch({ bvid: 'BV1CAnN6uEUN', question: '这条讲了什么', deps })
    const again = await deepWatch({ bvid: 'BV1CAnN6uEUN', question: '这条讲了什么', deps })
    assert.equal(seen.length, 1, '同一个问题不该重复调用')
    assert.equal(again.data.cached, true)
  } finally { e.restore() }
})
