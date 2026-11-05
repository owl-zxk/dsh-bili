/**
 * dsh-bili —— 学习层（2026-11-02）：把"看过的视频"沉淀成会累积的知识。
 *
 * 为什么要有这一层：她以前看完只留下一条评论 + 几条记忆，第二天什么都不剩。
 *   记忆是"我做过什么"，知识是"我懂了什么" —— 后者才能让她越看越有眼光。
 *
 * 两条硬纪律：
 *   ① 写入是**纯数据**，绝不额外调模型（深读一次已经很贵了）；
 *   ② 只有 `distill()` 调模型，且 24 小时 / 新增 8 条才最多一次，失败不重试。
 * 文件都在 self 目录（`$DSH_HOME/dsh-bili-self/`），不进仓库。
 */
import fs from 'node:fs'
import path from 'node:path'

import { appendAudit } from './audit.js'
import { readMetrics } from './metrics.js'
import { loadSchedule } from './schedule.js'
import { patchState, readState, selfDir, writeTextAtomic } from './state.js'

const HOUR_MS = 3600 * 1000
const DEDUPE_MS = 24 * HOUR_MS      // 同一个 bvid 24 小时内不重复记
const MAX_LINES = 2000              // 文件上限
const KEEP_LINES = 1500             // 超过上限只留最近这么多行
const GIST_MAX = 200                // 一行里的一句话摘要
const DISTILL_MAX_ITEMS = 40        // 归纳最多看最近 40 条
const DISTILL_AFTER_MS = 24 * HOUR_MS
const DISTILL_AFTER_COUNT = 8       // 每 8 条最多归纳一次
const KNOWLEDGE_MAX = 2000          // knowledge.md 字数上限

/** 归纳产物的三节标题（固定，解析与展示都靠它）。 */
export const SECTIONS = ['我大概懂了什么', '我最近的兴趣', '我改变过的看法']

export function learningPath () { return path.join(selfDir(), 'learning.jsonl') }
export function knowledgePath () { return path.join(selfDir(), 'knowledge.md') }

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) : text
}

/** 从标题+摘要里抽关键词（≤3）：中文取 2-4 字片段、英文取单词，按出现次数排。 */
function keywords (text) {
  const raw = String(text ?? '')
  const counts = new Map()
  const bump = (word) => {
    const w = word.trim()
    if (w.length < 2) return
    if (/^(这个|那个|什么|怎么|然后|因为|所以|就是|可以|没有|一个|我们|他们|自己|视频|感觉)$/.test(w)) return
    counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  for (const word of raw.match(/[A-Za-z][A-Za-z0-9]{1,20}/g) ?? []) bump(word.toLowerCase())
  // 中文：按标点/空白切开，再取每段里最长的 2-4 字连续汉字串候选
  for (const piece of raw.split(/[^\u4e00-\u9fa5A-Za-z0-9]+/)) {
    if (piece === '') continue
    for (let size = 4; size >= 2; size -= 1) {
      for (let i = 0; i + size <= piece.length; i += 1) {
        const part = piece.slice(i, i + size)
        if (/^[\u4e00-\u9fa5]+$/.test(part)) bump(part)
      }
    }
  }
  // 去重叠：n-gram 会把「分镜」「讲了分镜」「了分镜怎」都算成候选。
  //   先按出现次数、再按长度排，已选中的词只要互相包含就丢掉 —— 否则标签会是一堆碎片。
  const ranked = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
  //   重叠判定用"字符重合比例 ≥ 一半"，因为「三体动画」和「体动画分」互不包含却是同一段话
  const overlap = (a, b) => {
    const shared = [...new Set(a)].filter((ch) => b.includes(ch)).length
    return shared / Math.max(1, Math.min(a.length, b.length)) >= 0.5
  }
  const picked = []
  for (const [word] of ranked) {
    if (picked.some((one) => one.includes(word) || word.includes(one) || overlap(one, word))) continue
    picked.push(word)
    if (picked.length >= 3) break
  }
  return picked
}

/** 读出全部行（坏行跳过，不抛）。 */
export function readAll () {
  try {
    const text = fs.readFileSync(learningPath(), 'utf8')
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

function learningState () {
  const raw = readState()?.learning
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    count: Number.isFinite(Number(value.count)) ? Number(value.count) : 0,
    lastDistillAt: typeof value.lastDistillAt === 'string' ? value.lastDistillAt : '',
    lastDistillOk: value.lastDistillOk === true,
    lastDistillCount: Number.isFinite(Number(value.lastDistillCount)) ? Number(value.lastDistillCount) : 0,
    topics: Array.isArray(value.topics) ? value.topics.filter((t) => typeof t === 'string') : [],
  }
}

/**
 * 追加一条"我学到了什么"。**纯数据，不调模型。**
 * @returns {{ok:boolean, reason?:string, row?:object}}
 */
export function appendLearning ({ bvid, title, summary, question }) {
  const id = String(bvid ?? '').trim()
  const gistSource = clip(summary, GIST_MAX) || clip(question, GIST_MAX)
  if (id === '' || gistSource === '') return { ok: false, reason: 'bad-argument' }
  try {
    const rows = readAll()
    // 去重：同一个 bvid 24 小时内不重复记（一晚反复刷到同一条很正常）
    const now = Date.now()
    const dup = rows.some((row) => String(row.bvid ?? '') === id && now - Date.parse(String(row.at ?? '')) < DEDUPE_MS)
    if (dup) return { ok: false, reason: 'duplicate' }

    const row = {
      at: new Date(now).toISOString(),
      bvid: id,
      title: clip(title, 120),
      gist: clip(summary, GIST_MAX),
      tags: keywords(clip(title, 120) + ' ' + clip(summary, 400)),
    }
    const next = [...rows, row]
    const kept = next.length > MAX_LINES ? next.slice(next.length - KEEP_LINES) : next
    fs.mkdirSync(selfDir(), { recursive: true })
    // 整写（重写文件）：行数上限与去重都需要看到全文，追加写做不到裁剪
    writeTextAtomic(learningPath(), kept.map((one) => JSON.stringify(one)).join('\n') + '\n')

    const state = learningState()
    patchState({ learning: { ...state, count: state.count + 1 } })
    return { ok: true, row }
  } catch (error) {
    return { ok: false, reason: 'write-failed: ' + String(error?.message ?? error) }
  }
}

/** 最近 n 条（新的在后）。 */
export function readRecent (n = 3) {
  const want = Math.max(1, Math.min(50, Math.round(Number(n) || 3)))
  return readAll().slice(-want)
}

/** knowledge.md 的正文（最多 max 字）。没有文件返回空串。 */
export function readKnowledge (max = 800) {
  try {
    const text = fs.readFileSync(knowledgePath(), 'utf8').trim()
    return text.length > max ? text.slice(0, max) : text
  } catch {
    return ''
  }
}

/** 从归纳产物里抠出「兴趣」那一节的主题词（≤8 个）。 */
function topicsOf (body) {
  // 不能只按 `^## ` 切：模型写成 `**我最近的兴趣**` / `### …` 时那是空结果，
  // 而"兴趣"是好奇 +1 的依据 —— 切错就等于这个能力悄悄失效。
  const lines = String(body).split('\n')
  const isHeading = (line) => SECTIONS.some((name) => line.includes(name))
  const start = lines.findIndex((line) => line.includes(SECTIONS[1]))
  if (start < 0) return []
  const rest = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isHeading(lines[i])) break
    rest.push(lines[i])
  }
  const line = rest.join(' ')
  return line
    .split(/[、,，\/\\|\s]+/)
    .map((word) => word.replace(/^[-*\d.．)）\s]+/, '').trim())
    .filter((word) => word !== '' && word.length <= 12)
    .slice(0, 8)
}

/**
 * 归纳调用要用的模型路由。
 *
 * 为什么必须显式取：真机上（2026-11-05）`learning`/`style` 两个归纳每轮都失败，
 * 审计里是 `llm-empty (error)`、`rawLen: 0` —— 因为这两处调用**没带 provider/model**，
 * 宿主没有默认路由，流直接以 error 结束；而 `brain` 一直是带着 schedule 里的路由调的。
 */
function routeOf () {
  try {
    const schedule = loadSchedule()
    return {
      provider: String(schedule?.llmProvider ?? ''),
      model: String(schedule?.llmModel ?? ''),
    }
  } catch {
    return { provider: '', model: '' }
  }
}

/**
 * 把一次 llm.stream 的文本拼回来，并把 finish 原因带出来。
 *
 * 为什么要带 finish：真机上出现过"两秒返回、正文空、三节全缺"的失败 —— 只看
 * `body` 分不出「模型没说话」和「模型说了但标题不对」，而这两种修法完全相反。
 */
async function askModel (llm, { system, user, route }) {
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') throw Object.assign(new Error('llm 不可用'), { code: 'llm-unavailable' })
  let deltas = ''
  const blocks = []
  let finish = ''
  // 必须带上路由：真机上不带 provider/model 的调用会让宿主直接 finish=error、正文为空，
  // 而 brain 一直是带着 schedule.llmProvider/llmModel 调的 —— 这里漏了就会"每轮归纳都失败"。
  const options = { system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }] }
  if (typeof route?.provider === 'string' && route.provider.trim() !== '') options.provider = route.provider.trim()
  if (typeof route?.model === 'string' && route.model.trim() !== '') options.model = route.model.trim()
  for await (const chunk of llm.stream(options)) {
    if (chunk?.type === 'block-end') {
      if (chunk?.block?.type === 'text' && typeof chunk.block.text === 'string') blocks.push(chunk.block.text)
      continue
    }
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') deltas += chunk.text
    if (chunk?.type === 'finish') {
      const reason = chunk?.reason ?? chunk?.finish ?? null
      const kind = typeof reason === 'string' ? reason : String(reason?.kind ?? reason?.code ?? '')
      const detail = typeof reason === 'object' && reason !== null ? String(reason.message ?? reason.detail ?? '') : ''
      finish = detail === '' ? kind : kind + ': ' + detail.slice(0, 120)
    }
  }
  return { text: blocks.length > 0 ? blocks.join('') : deltas, finish }
}

/**
 * 小节标题是否出现（宽容匹配）。
 *
 * 模型经常把 `## 我大概懂了什么` 写成 `**我大概懂了什么**`、`### …` 或 `1. …`；
 * 原来的 `body.includes('## ' + name)` 会把这类正确产物判成失败（真机就是这样）。
 * 去标点后比对，仍然要求**名字出现**，不放宽"必须写这三节"的语义。
 */
function hasSection (body, name) {
  const norm = (value) => String(value).replace(/[#*`~\s]/g, '')
  return norm(body).includes(norm(name))
}

/**
 * 把最近的 learning 归纳成 knowledge.md。
 *
 * 触发：`force` 或 `lastDistillAt` 距今 > 24h 或 新增 ≥ 8 条。
 * 失败（没 LLM / 解析不出三节）→ **不覆盖旧文件**，只记一条失败审计，并把 lastDistillAt 推进（失败不重试）。
 * @returns {{ok:boolean, reason?:string, topics?:string[]}}
 */
export async function distill ({ deps, force } = {}) {
  const all = readAll()
  const state = learningState()
  if (all.length === 0) return { ok: false, reason: 'empty' }

  const lastAt = Date.parse(state.lastDistillAt)
  const sinceAt = Number.isFinite(lastAt) ? Date.now() - lastAt : Infinity
  const added = Math.max(0, all.length - state.lastDistillCount)
  if (force !== true && sinceAt < DISTILL_AFTER_MS && added < DISTILL_AFTER_COUNT) return { ok: false, reason: 'not-yet' }

  const taken = all.slice(-DISTILL_MAX_ITEMS)
  const list = taken.map((row, i) => (i + 1) + '. [' + (row.tags ?? []).join('/') + '] ' + (row.title ?? '') + '：' + (row.gist ?? '')).join('\n')
  const user = [
    '下面是我最近看过的视频和一句话摘要：',
    list,
    '',
    '请把它们归纳成我的"知识"，严格用这三节（Markdown，二级标题，不要多写别的节）：',
    '## ' + SECTIONS[0],
    '（3-6 条，每条一句话，写我大概搞懂了什么）',
    '## ' + SECTIONS[1],
    '（2-4 个主题词，用、隔开）',
    '## ' + SECTIONS[2],
    '（0-2 条，写「以前觉得…现在觉得…」；没有就写「暂无」）',
    '总字数不超过 ' + KNOWLEDGE_MAX + ' 字。',
  ].join('\n')

  let body = ''
  let failure = ''
  let finish = ''
  try {
    const reply = await askModel(deps?.llm, {
      system: '你替一个爱看 B站 的人整理她的知识笔记：只写她真的看到过的东西，不编。',
      user,
      route: routeOf(),
    })
    body = String(reply?.text ?? '').trim()
    finish = String(reply?.finish ?? '')
  } catch (error) {
    failure = 'llm-failed: ' + String(error?.message ?? error)
  }

  // 空正文与"标题不对"必须分开报：前者是模型没说话，后者是格式没对上，修法相反。
  if (failure === '' && body === '') failure = 'llm-empty' + (finish === '' ? '' : ' (' + finish + ')')
  const missing = failure === '' ? SECTIONS.filter((name) => !hasSection(body, name)) : []
  if (failure === '' && missing.length > 0) failure = 'parse-failed: 缺少 ' + missing.join('、')
  if (failure !== '') {
    // 失败**不覆盖**旧 knowledge.md。
    // 但 llm-empty 不推进 lastDistillAt —— 那是"这次没拿到话"，下轮该再试；
    // 只有"拿到了但格式不对 / 真报错"才推进，避免拿着错格式反复烧 token。
    if (!failure.startsWith('llm-empty')) {
      patchState({ learning: { ...state, lastDistillAt: new Date().toISOString(), lastDistillOk: false, lastDistillCount: all.length } })
    }
    // 把模型原文前 200 字写进审计：下次失败时能直接看它到底写了什么，不用再猜。
    try { appendAudit({ tool: 'learning', args: { distill: true, items: taken.length, rawLen: body.length, finish, snippet: body.slice(0, 200) }, why: '归纳失败（旧 knowledge.md 未改动）', result: { ok: false, reason: failure } }) } catch { /* 审计写不进去不影响 */ }
    return { ok: false, reason: failure }
  }

  const text = body.length > KNOWLEDGE_MAX ? body.slice(0, KNOWLEDGE_MAX) : body
  const topics = topicsOf(text)
  try {
    fs.mkdirSync(selfDir(), { recursive: true })
    writeTextAtomic(knowledgePath(), text.endsWith('\n') ? text : text + '\n')
  } catch (error) {
    patchState({ learning: { ...state, lastDistillAt: new Date().toISOString(), lastDistillOk: false, lastDistillCount: all.length } })
    return { ok: false, reason: 'write-failed: ' + String(error?.message ?? error) }
  }

  // 新主题 → 好奇 +1（上限 100）。只加一次，不按条数累加。
  const fresh = topics.filter((topic) => !state.topics.includes(topic))
  const metrics = readMetrics()
  const curiosity = fresh.length > 0 ? Math.min(100, Number(metrics.curiosity ?? 0) + 1) : metrics.curiosity
  patchState({
    learning: { ...state, lastDistillAt: new Date().toISOString(), lastDistillOk: true, lastDistillCount: all.length, topics },
    ...(fresh.length > 0 ? { metrics: { ...metrics, curiosity } } : {}),
  })
  try { appendAudit({ tool: 'learning', args: { distill: true, items: taken.length, topics: topics.join('、') }, why: '归纳完成（' + (fresh.length > 0 ? '新增主题 +1 好奇' : '没有新主题') + '）', result: { ok: true } }) } catch { /* 忽略 */ }
  return { ok: true, topics, curiosity }
}
