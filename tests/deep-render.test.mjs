// tests/deep-render.test.mjs —— 深读结果的四种渲染（bili_watch 的 text/data.deep）
//
// 为什么单独测这层：
//   深读是唯一会"看起来成功但其实没读到"的地方 —— 模型拿到的只是一段文字，
//   所以「没看成」与「看成了但没结论」必须让人一眼分得开；把两者混成一句，
//   症状是她对一条没读成功的视频一本正经地胡说。
//   这里直接喂 data.deep 的四种形状给 render，不经过网络、也不经过能力注册表。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

function renderEnv (tag) {
  const root = tmpDir(tag)
  const restoreSandbox = sandboxEnv(root)
  const restoreSelf = setEnv({ DSH_BILI_SELF_DIR: path.join(root, 'self') })
  fs.mkdirSync(path.join(root, 'self'), { recursive: true })
  return { root, restore () { restoreSelf(); restoreSandbox(); cleanupTmp() } }
}

/** 拿 bili_watch 工具，把一份自定义 data 渲染成文字。 */
async function renderWatch (deep) {
  const { buildTools } = await import(repoUrl('lib/tools/index.js'))
  const deps = {
    client: { async get () { return { code: 0, data: {} } }, async post () { return { code: 0, data: {} } }, cred () { return {} }, state () { return {} } },
    config: { owner: { mid: 389989266 }, risk: {}, paths: { stateDir: tmpDir('dr-state') } },
    owner: { mid: 389989266 },
    quota: { gate: () => ({ ok: true }), record: () => ({ ok: true }) },
    capabilities: { list: () => [], call: () => ({ ok: false }) },
    log: () => {},
  }
  const watch = buildTools(deps).find((item) => item.name === 'bili_watch')
  const rendered = watch.output.render({ ok: true, data: { source: 'popular', count: 0, items: [], deep } })
  return rendered.map((chunk) => chunk.text).join('')
}

test('深读渲染：拿到 answer → 直接给答案，不说「没有文字结论」', async () => {
  const env = renderEnv('dr-answer')
  try {
    const text = await renderWatch([{ bvid: 'BV1CAnN6uEUN', ok: true, result: { data: { answer: '这个视频在跳舞' } } }])
    assert.ok(text.includes('这个视频在跳舞'), '必须把 answer 渲染出来，实际：' + text)
    assert.equal(text.includes('没有文字结论'), false, '有答案时不该出现「没有文字结论」，实际：' + text)
    assert.equal(text.includes('没看成'), false, '有答案时更不该说没看成，实际：' + text)
  } finally {
    env.restore()
  }
})

test('深读渲染：too-long → 写清「没看成（too-long）」', async () => {
  const env = renderEnv('dr-too-long')
  try {
    const text = await renderWatch([{ bvid: 'BV1CAnN6uEUN', ok: false, reason: 'too-long' }])
    assert.ok(text.includes('没看成（too-long）'), '必须写清没看成与原因 too-long，实际：' + text)
    assert.equal(text.includes('没有文字结论'), false, '失败路径不许含糊成「没有文字结论」，实际：' + text)
  } finally {
    env.restore()
  }
})

test('深读渲染：understand-failed + failures → 把第一个失败点（batch: MODEL_STREAM_FAILED）写出来', async () => {
  const env = renderEnv('dr-failed')
  try {
    const text = await renderWatch([{
      bvid: 'BV1CAnN6uEUN',
      ok: false,
      reason: 'understand-failed',
      detail: { failures: [{ stage: 'batch', reason: 'MODEL_STREAM_FAILED' }] }
    }])
    assert.ok(text.includes('没看成（understand-failed）'), '必须写清原因 understand-failed，实际：' + text)
    assert.ok(text.includes('batch: MODEL_STREAM_FAILED'), '必须带上第一个失败点的 stage: reason，实际：' + text)
  } finally {
    env.restore()
  }
})

test('深读渲染：partial（部分批次失败）→ 仍给摘要并标注「（部分批次失败）」', async () => {
  const env = renderEnv('dr-partial')
  try {
    const text = await renderWatch([{ bvid: 'BV1CAnN6uEUN', ok: true, partial: true, result: { data: { summary: '部分可用' } } }])
    assert.ok(text.includes('部分可用'), 'partial 也要把可用的摘要给出来，实际：' + text)
    assert.ok(text.includes('（部分批次失败）'), 'partial 必须显式标注，实际：' + text)
    assert.equal(text.includes('没看成'), false, 'partial 不是失败，不许说没看成，实际：' + text)
  } finally {
    env.restore()
  }
})

test('深读渲染：有 data 但结论字段为空 → 「理解了，但没有文字结论」，绝不写成「没看成」', async () => {
  const env = renderEnv('dr-empty')
  try {
    const text = await renderWatch([{ bvid: 'BV1CAnN6uEUN', ok: true, result: { data: {} } }])
    assert.ok(text.includes('理解了，但没有文字结论'), '空结论要说清"理解了但没结论"，实际：' + text)
    assert.equal(text.includes('没看成'), false, '它是成功路径，绝不许写成没看成，实际：' + text)
  } finally {
    env.restore()
  }
})
