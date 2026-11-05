// tests/distill-parse.test.mjs —— 归纳的"解析宽容度 + 空返回诊断"
//
// 真机证据（2026-11-05）：board 模式下 learning 已有 11 条，distill 每轮跑、每轮失败，
//   reason 恒为「parse-failed: 缺少 我大概懂了什么、我最近的兴趣、我改变过的看法」——
//   **三节全部缺失**，说明模型要么没说话，要么没用 `## ` 写标题。
//   原来的检查是 `body.includes('## ' + name)`：
//     · 模型写成 `**我大概懂了什么**` → 判失败（这是错的，内容是对的）；
//     · 模型一个字都没说 → 也报"缺三节"（这是错的，该报"没拿到话"）。
//   所以这里钉两件事：宽容匹配标题、空正文单独报 llm-empty 且**不推进时间**（下轮该再试）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { cleanupTmp, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'
import { distill } from '../lib/core/learning.js'
import { distillStyle } from '../lib/core/style.js'

const NL = String.fromCharCode(10)

function env (tag) {
  const root = tmpDir(tag)
  const restoreSandbox = sandboxEnv(root)
  const restoreSelf = setEnv({ DSH_BILI_SELF_DIR: path.join(root, 'self') })
  fs.mkdirSync(path.join(root, 'self'), { recursive: true })
  return { root, selfDir: path.join(root, 'self'), restore () { restoreSelf(); restoreSandbox(); cleanupTmp() } }
}

function seedLearning (selfDir, count) {
  const rows = []
  for (let i = 0; i < count; i += 1) {
    rows.push(JSON.stringify({ at: new Date().toISOString(), bvid: 'BV1' + i, title: '第' + i + '条', gist: '摘要' + i, tags: ['分镜'] }))
  }
  fs.writeFileSync(path.join(selfDir, 'learning.jsonl'), rows.join(NL) + NL)
}

const streamOf = (text) => async function * () {
  if (text !== '') yield { type: 'text-delta', text }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

test('归纳解析：模型把标题写成加粗（**标题**）也算成功 —— 真机就是这里判错的', async () => {
  const e = env('dp-bold')
  try {
    seedLearning(e.selfDir, 9)
    const body = ['**我大概懂了什么**', '- 三体动画的分镜先用大字卡交代信息', '**我最近的兴趣**', '分镜、三体动画', '**我改变过的看法**', '暂无'].join(NL)
    const r = await distill({ deps: { llm: { stream: () => streamOf(body)() } }, force: true })
    assert.equal(r.ok, true, '加粗标题必须被认出来')
    assert.deepEqual(r.topics, ['分镜', '三体动画'], '兴趣主题词要从加粗小节里抠出来')
    assert.match(fs.readFileSync(path.join(e.selfDir, 'knowledge.md'), 'utf8'), /三体动画的分镜/, '正文要落盘')
  } finally { e.restore() }
})

test('归纳解析：一个字都没返回 → 报 llm-empty，且**不推进** lastDistillAt（下轮还要再试）', async () => {
  const e = env('dp-empty')
  try {
    seedLearning(e.selfDir, 9)
    const r = await distill({ deps: { llm: { stream: () => streamOf('')() } }, force: true })
    assert.equal(r.ok, false)
    assert.match(r.reason, /^llm-empty/)
    assert.equal(fs.existsSync(path.join(e.selfDir, 'knowledge.md')), false, '没拿到话就不该写文件')
    // 空返回时连 state 都不该被写（没推进时间 = 下轮还会重试），所以文件缺失本身就是合格状态
    const statePath = path.join(e.selfDir, 'state.json')
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {}
    assert.equal(state.learning?.lastDistillAt ?? '', '', '空返回不推进时间，否则要等 24 小时才重试')
  } finally { e.restore() }
})

test('归纳失败时把模型原文写进审计（≤200 字），下次不用再猜', async () => {
  const e = env('dp-audit')
  try {
    seedLearning(e.selfDir, 9)
    const r = await distill({ deps: { llm: { stream: () => streamOf('好的，我来总结一下：')() } }, force: true })
    assert.equal(r.ok, false)
    assert.match(r.reason, /^parse-failed/)
    const audit = fs.readFileSync(path.join(e.selfDir, 'audit.jsonl'), 'utf8')
    assert.match(audit, /snippet/, '审计里要有模型原文片段')
    assert.match(audit, /好的，我来总结一下/, '片段内容要是模型真说的话')
  } finally { e.restore() }
})

test('风格归纳同样容忍加粗标题', async () => {
  const e = env('dp-style')
  try {
    const rows = []
    for (let i = 0; i < 40; i += 1) rows.push(JSON.stringify({ at: new Date().toISOString(), bvid: 'BV2' + i, text: '样本正文' + i + '号', like: i }))
    fs.writeFileSync(path.join(e.selfDir, 'comment-style.jsonl'), rows.join(NL) + NL)
    const body = [
      '**大家常怎么写**', '先接一句具体的话再抖包袱',
      '**什么样的评论会有人点赞**', '说一件具体的事，不评价抽象的好',
      '**我不该学的**', '引战、复读、刷梗',
      '**我自己的语气怎么接上去**', '用短句，带一点自嘲',
      '不要照搬别人的句子',
    ].join(NL)
    const r = await distillStyle({ deps: { llm: { stream: () => streamOf(body)() } }, force: true })
    assert.equal(r.ok, true)
    assert.match(fs.readFileSync(path.join(e.selfDir, 'comment-style.md'), 'utf8'), /不评价抽象的好/)
  } finally { e.restore() }
})
