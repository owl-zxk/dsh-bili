/**
 * dsh-bili —— 评论风格学习（2026-11-02）：看别人怎么写，学着写，但**不抄**。
 *
 * 为什么单独一层：她读评论区一直只是"当内容参考"，第二天什么也没剩下。
 *   风格（句式/结构/什么会有人点赞）是可累积的本事；句子则是别人的，照搬只会显得假。
 *
 * 三条硬纪律：
 *   ① 采集是**纯数据**，绝不调模型；`distillStyle()` 是唯一调模型的地方（24h / 40 条最多一次）。
 *   ② 失败**不覆盖**旧 comment-style.md，只记审计并把 lastDistillAt 推进（失败不重试）。
 *   ③ 产物必须写明「不要照搬别人的句子」—— 学的是风格，不是把样本当候选评论。
 * 文件都在 self 目录（`$DSH_HOME/dsh-bili-self/`），不进仓库。
 */
import fs from 'node:fs'
import path from 'node:path'

import { appendAudit } from './audit.js'
import { patchState, readState, selfDir, writeTextAtomic } from './state.js'

const HOUR_MS = 3600 * 1000
const DEDUPE_MS = 24 * HOUR_MS
const PICK_MAX = 5            // 一次最多采 5 条（按点赞降序）
const LIKE_ORDER = (a, b) => b.like - a.like
const LEN_MIN = 8
const LEN_MAX = 120
const MAX_LINES = 600
const KEEP_LINES = 400
const DISTILL_MAX_ITEMS = 80
const DISTILL_AFTER_MS = 24 * HOUR_MS
const DISTILL_AFTER_COUNT = 40
const STYLE_MAX = 1500
const READ_SAMPLES = 3

/** 归纳产物的四节标题（固定，解析与展示都靠它）。 */
export const SECTIONS = [
  '大家常怎么写',
  '什么样的评论会有人点赞',
  '我不该学的',
  '我自己的语气怎么接上去',
]

/** 这句必须出现在产物里：学风格，不抄句子。 */
export const NO_COPY_RULE = '不要照搬别人的句子'

export function samplesPath () { return path.join(selfDir(), 'comment-style.jsonl') }
export function stylePath () { return path.join(selfDir(), 'comment-style.md') }

// 两种形状都认：已经过 api 层的（text 字符串）与 B站 原始形状（content.message）
const textOf = (row) => {
  const content = row?.content
  const raw = row?.text ?? (content !== null && typeof content === 'object' ? content.message : content)
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

function styleState () {
  const raw = readState()?.style
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    count: Number.isFinite(Number(value.count)) ? Number(value.count) : 0,
    lastDistillAt: typeof value.lastDistillAt === 'string' ? value.lastDistillAt : '',
    lastDistillOk: value.lastDistillOk === true,
    lastDistillCount: Number.isFinite(Number(value.lastDistillCount)) ? Number(value.lastDistillCount) : 0,
  }
}

export function readAll () {
  try {
    const text = fs.readFileSync(samplesPath(), 'utf8')
    const rows = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const row = JSON.parse(line)
        if (row !== null && typeof row === 'object') rows.push(row)
      } catch { /* 坏行跳过 */ }
    }
    return rows
  } catch {
    return []
  }
}

/** 纯表情 / 只有标点的正文（当样本没意义）。 */
function isEmojiOnly (text) {
  return !/[\u4e00-\u9fa5A-Za-z0-9]/.test(text)
}

/**
 * 从一次 bili_comments 的结果里挑样本并落盘。**纯数据，不调模型。**
 * @returns {{ok:boolean, reason?:string, added?:number}}
 */
export function recordSamples ({ bvid, comments, selfMid } = {}) {
  const list = Array.isArray(comments) ? comments : []
  if (list.length === 0) return { ok: false, reason: 'no-comments' }
  const id = String(bvid ?? '').trim()
  try {
    const rows = readAll()
    const now = Date.now()
    if (id !== '' && rows.some((row) => String(row.bvid ?? '') === id && now - Date.parse(String(row.at ?? '')) < DEDUPE_MS)) {
      return { ok: false, reason: 'duplicate' }
    }
    const self = String(selfMid ?? '').trim()
    const seen = new Map()
    for (const row of rows) {
      const text = textOf(row)
      seen.set(text, (seen.get(text) ?? 0) + 1)
    }
    const picked = []
    const taken = new Set()
    for (const one of [...list].sort(LIKE_ORDER)) {
      if (picked.length >= PICK_MAX) break
      const text = textOf(one)
      if (text === '') continue
      if (self !== '' && String(one?.mid ?? '') === self) continue       // 不采她自己
      if (text.length < LEN_MIN || text.length > LEN_MAX) continue
      if (isEmojiOnly(text)) continue
      if (taken.has(text)) continue                                      // 同一轮里重复只留一条
      const repeats = (seen.get(text) ?? 0) + (taken.has(text) ? 1 : 0)
      if (repeats > 2) continue                                          // 复读满街都是的句子不要
      taken.add(text)
      picked.push({ at: new Date(now).toISOString(), bvid: id, text, like: Number(one?.like ?? 0) || 0 })
    }
    if (picked.length === 0) return { ok: false, reason: 'no-usable-sample' }

    const next = [...rows, ...picked]
    const kept = next.length > MAX_LINES ? next.slice(next.length - KEEP_LINES) : next
    fs.mkdirSync(selfDir(), { recursive: true })
    writeTextAtomic(samplesPath(), kept.map((one) => JSON.stringify(one)).join('\n') + '\n')

    const state = styleState()
    patchState({ style: { ...state, count: state.count + picked.length } })
    return { ok: true, added: picked.length }
  } catch (error) {
    return { ok: false, reason: 'write-failed: ' + String(error?.message ?? error) }
  }
}

/** 随机取 n 条样本（别总是同几条 —— 总是同几条会让她只学会一种句式）。 */
export function readSamples (n = READ_SAMPLES) {
  const want = Math.max(1, Math.min(10, Math.round(Number(n) || READ_SAMPLES)))
  const rows = readAll()
  if (rows.length === 0) return []
  const pool = [...rows]
  const out = []
  while (out.length < want && pool.length > 0) {
    const index = Math.floor(Math.random() * pool.length)
    out.push(pool.splice(index, 1)[0])
  }
  return out
}

/** comment-style.md 的正文（最多 max 字）。没有文件返回空串。 */
export function readStyle (max = 1000) {
  try {
    const text = fs.readFileSync(stylePath(), 'utf8').trim()
    return text.length > max ? text.slice(0, max) : text
  } catch {
    return ''
  }
}

async function askModel (llm, { system, user }) {
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') throw Object.assign(new Error('llm 不可用'), { code: 'llm-unavailable' })
  let deltas = ''
  const blocks = []
  for await (const chunk of llm.stream({ system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }] })) {
    if (chunk?.type === 'block-end') {
      if (chunk?.block?.type === 'text' && typeof chunk.block.text === 'string') blocks.push(chunk.block.text)
      continue
    }
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') deltas += chunk.text
  }
  return blocks.length > 0 ? blocks.join('') : deltas
}

/**
 * 把样本归纳成"怎么写评论"的笔记。
 * 触发：force 或 >24h 或 新增 ≥40 条；最多用最近 80 条；产物 ≤1500 字、四节固定。
 * 失败：不覆盖旧文件、记一条失败审计、lastDistillAt 照常推进（失败不重试）。
 */
export async function distillStyle ({ deps, force } = {}) {
  const all = readAll()
  const state = styleState()
  if (all.length === 0) return { ok: false, reason: 'empty' }

  const lastAt = Date.parse(state.lastDistillAt)
  const sinceAt = Number.isFinite(lastAt) ? Date.now() - lastAt : Infinity
  const added = Math.max(0, all.length - state.lastDistillCount)
  if (force !== true && sinceAt < DISTILL_AFTER_MS && added < DISTILL_AFTER_COUNT) return { ok: false, reason: 'not-yet' }

  const taken = all.slice(-DISTILL_MAX_ITEMS)
  const list = taken.map((row, i) => (i + 1) + '. [赞 ' + (row.like ?? 0) + '] ' + row.text).join('\n')
  const user = [
    '下面是 B站 评论区的真实样本（含点赞数）：',
    list,
    '',
    '请归纳"评论怎么写"的笔记，严格用这四节（Markdown 二级标题，不要多写别的节）：',
    '## ' + SECTIONS[0],
    '（3-5 种句式/结构，每种一句说明）',
    '## ' + SECTIONS[1],
    '（从高赞样本里归纳 2-4 条共性）',
    '## ' + SECTIONS[2],
    '（引战、复读、刷梗、无意义感叹，各一句为什么）',
    '## ' + SECTIONS[3],
    '（1-2 句，写"我"该用什么语气去接）',
    '必须包含这一句：' + NO_COPY_RULE + '。总字数不超过 ' + STYLE_MAX + ' 字。',
  ].join('\n')

  let body = ''
  let failure = ''
  try {
    body = String(await askModel(deps?.llm, {
      system: '你替一个爱看 B站 的人整理"怎么写评论"的笔记：只归纳风格，不抄句子。',
      user,
    }) ?? '').trim()
  } catch (error) {
    failure = 'llm-failed: ' + String(error?.message ?? error)
  }

  const missing = failure === '' ? [...SECTIONS.filter((name) => !body.includes('## ' + name)), ...(body.includes(NO_COPY_RULE) ? [] : ['硬约束那句'])] : SECTIONS
  if (failure === '' && missing.length > 0) failure = 'parse-failed: 缺少 ' + missing.join('、')
  if (failure !== '') {
    patchState({ style: { ...state, lastDistillAt: new Date().toISOString(), lastDistillOk: false, lastDistillCount: all.length } })
    try { appendAudit({ tool: 'style', args: { distill: true, items: taken.length }, why: '评论风格归纳失败（旧 comment-style.md 未改动）', result: { ok: false, reason: failure } }) } catch { /* 忽略 */ }
    return { ok: false, reason: failure }
  }

  const text = body.length > STYLE_MAX ? body.slice(0, STYLE_MAX) : body
  try {
    fs.mkdirSync(selfDir(), { recursive: true })
    writeTextAtomic(stylePath(), text.endsWith('\n') ? text : text + '\n')
  } catch (error) {
    patchState({ style: { ...state, lastDistillAt: new Date().toISOString(), lastDistillOk: false, lastDistillCount: all.length } })
    return { ok: false, reason: 'write-failed: ' + String(error?.message ?? error) }
  }

  patchState({ style: { ...state, lastDistillAt: new Date().toISOString(), lastDistillOk: true, lastDistillCount: all.length } })
  try { appendAudit({ tool: 'style', args: { distill: true, items: taken.length }, why: '评论风格归纳完成', result: { ok: true } }) } catch { /* 忽略 */ }
  return { ok: true }
}
