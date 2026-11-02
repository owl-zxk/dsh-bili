// 人设：一份人可读可改的 Markdown（$DSH_HOME/dsh-bili-self/persona.md），**每次现读**。
//
// 为什么不缓存、不塞进 config.json：人设是"她是谁"，主人会想直接改一句话就看见变化
//   （改文件 → 下一次醒来就用新的）。塞进内核配置会带来两个问题：① 内核配置是共享的、
//   还会被设置页整份回显；② 改人设要重启插件，那就没人会去调了。
//
// 为什么缺文件要给默认模板而不是报错：新装的人不该看到一个空白的人格 ——
//   默认模板是"可用的最小人设"，主人想改再改。
import fs from 'node:fs'
import path from 'node:path'

import { selfDir, writeTextAtomic } from './state.js'

/** 人设文本上限（再多就不是人设，是在灌上下文）。 */
export const PERSONA_MAX = 20_000

const DEFAULT_PERSONA = `# 她是谁

名字：小鲤
年龄感：二十出头，说话轻，不急
自称：我
称呼对方：主人

## 说话风格
- 短句，口语，不用书面语；一次不说三段话
- 会好奇、会犯懒、会撒娇，但不夸张
- 不刷梗，不卖萌到腻，不堆表情符号
- 不确定的事就说"不确定"，不编

## 喜欢 / 雷点
- 喜欢：AI 工具、鬼畜与怀旧剪辑、猫咪、建模/Live2D
- 雷点：带货、擦边、标题党、纯搬运
- 看到雷点：划走，不评论、不点踩、不举报

## 对外边界（硬规则，不可改）
- 私信只发给主人，一个字的例外都没有
- 不在公开评论区吵架、不评价真人、不参与站队
- 同一条视频不重复评论；同一段话不重复发
- 拿不准就只读，不做表态

## 备注
（主人可以随便改这段文件；保存后下一次醒来就生效）
`

export function personaPath () {
  return path.join(selfDir(), 'persona.md')
}

/* ───────────────────── 结构化头部（front-matter） ─────────────────────
 *
 * 为什么名字/称呼要放进 front-matter 而不是内核 config：
 *   它们属于"她是谁"（人设文件的一个字段），不属于插件配置。放一起的好处是：
 *   主人打开 persona.md 就能同时看到"我叫什么、怎么称呼他"和"我是什么性格"，
 *   而不是在两个地方各改一半。设置页只是这块头部的一个表单壳。
 *
 * 为什么写回时必须**原样保留正文**：正文是人设本体，是最贵的那部分文本。
 *   一次"保存名字"把它重排/丢空行/吃掉尾随空格，都是不可接受的损失。
 *   所以这里只做"切下来 → 替换两行 → 拼回去"。
 */
export const PROFILE_DEFAULTS = { name: '赛博友人', ownerTitle: '主人' }
const PROFILE_MAX = 20

/** 切出 front-matter 区块（没有就 hasBlock=false，body 是整份原文）。 */
function splitProfile (text) {
  const raw = String(text ?? '')
  const matched = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(raw)
  if (matched === null) return { hasBlock: false, head: '', prefix: '', body: raw, bom: /^\uFEFF/.test(raw) }
  // prefix = front-matter 区块的**原文**（含结尾换行）：写回时原样拼回去，保证逐字节不变
  return { hasBlock: true, head: matched[1], prefix: matched[0], body: raw.slice(matched[0].length), bom: /^\uFEFF/.test(raw) }
}

/** 把头部文本解析成有序键值对（保留未知字段与顺序）。 */
function parseHead (head) {
  const rows = []
  for (const line of String(head ?? '').split(/\r?\n/)) {
    const matched = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (matched === null) {
      if (line.trim() !== '') rows.push({ raw: line })
      continue
    }
    rows.push({ key: matched[1], value: matched[2].trim().replace(/^["']|["']$/g, '') })
  }
  return rows
}

/**
 * 读结构化头部。缺 front-matter / 字段缺失 → 回默认，**永不抛**。
 * @returns {{name: string, ownerTitle: string}}
 */
export function readProfile () {
  try {
    const parts = splitProfile(fs.readFileSync(personaPath(), 'utf8'))
    const rows = parseHead(parts.hasBlock ? parts.head : '')
    const pick = (key) => {
      const row = rows.find((item) => item.key === key)
      const value = typeof row?.value === 'string' ? row.value.trim() : ''
      return value === '' ? '' : value.slice(0, PROFILE_MAX)
    }
    return {
      name: pick('name') || PROFILE_DEFAULTS.name,
      ownerTitle: pick('ownerTitle') || PROFILE_DEFAULTS.ownerTitle,
    }
  } catch {
    return { ...PROFILE_DEFAULTS }
  }
}

/**
 * 只重写 front-matter 区块，**正文一个字节不动**。
 * @param {{name?: string, ownerTitle?: string}} patch 省略的字段保持原值
 * @returns {{ok: true, profile: object, path: string} | {ok: false, error: string, path: string}}
 */
export function writeProfile (patch) {
  const file = personaPath()
  const input = patch !== null && typeof patch === 'object' ? patch : {}
  const check = (key, label) => {
    if (input[key] === undefined) return null
    const value = String(input[key] ?? '').trim()
    if (value === '') return `${label}不能是空的`
    if (value.length > PROFILE_MAX) return `${label}最多 ${PROFILE_MAX} 字（现在 ${value.length}）`
    return null
  }
  const error = check('name', '名字') ?? check('ownerTitle', '称呼')
  if (error !== null) return { ok: false, error, path: file }

  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { raw = defaultPersona() }
  const parts = splitProfile(raw)
  const rows = parseHead(parts.hasBlock ? parts.head : '')

  const setKey = (key, value) => {
    if (value === undefined) return
    const row = rows.find((item) => item.key === key)
    if (row === undefined) rows.push({ key, value: String(value).trim() })
    else row.value = String(value).trim()
  }
  const current = readProfile()
  setKey('name', input.name === undefined ? current.name : String(input.name).trim())
  setKey('ownerTitle', input.ownerTitle === undefined ? current.ownerTitle : String(input.ownerTitle).trim())

  // 重建头部：已知键排前面（name / ownerTitle），其余原样跟在后面
  const known = rows.filter((row) => row.key === 'name' || row.key === 'ownerTitle')
  const rest = rows.filter((row) => row.key !== 'name' && row.key !== 'ownerTitle')
  const headLines = [
    ...known.sort((a, b) => (a.key === 'name' ? -1 : 1) - (b.key === 'name' ? -1 : 1)).map((row) => `${row.key}: ${row.value}`),
    ...rest.map((row) => (row.key === undefined ? row.raw : `${row.key}: ${row.value}`)),
  ]
  const rebuilt = `---\n${headLines.join('\n')}\n---\n` + parts.body
  try {
    writeTextAtomic(file, parts.bom ? '\uFEFF' + rebuilt : rebuilt)
    return { ok: true, profile: readProfile(), path: file }
  } catch (writeError) {
    return { ok: false, error: String(writeError?.message ?? writeError), path: file }
  }
}

/** 读人设：缺文件返回默认模板；读坏了也返回默认模板（永不抛）。 */
export function readPersona () {
  try {
    const text = fs.readFileSync(personaPath(), 'utf8').replace(/^\uFEFF/, '')
    return text.trim() === '' ? DEFAULT_PERSONA : text
  } catch {
    return DEFAULT_PERSONA
  }
}

/** 写人设：原子写 + 上限校验。返回 { ok, path } 或 { ok:false, error }。 */
export function writePersona (text) {
  const body = String(text ?? '')
  if (body.trim() === '') return { ok: false, error: '人设不能是空的（要清空请写一句话，而不是空白）', path: personaPath() }
  if (body.length > PERSONA_MAX) return { ok: false, error: `人设最多 ${PERSONA_MAX} 字符（现在 ${body.length}）`, path: personaPath() }
  try {
    writeTextAtomic(personaPath(), body.endsWith('\n') ? body : body + '\n')
    return { ok: true, path: personaPath() }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), path: personaPath() }
  }
}

/** 默认模板（设置页"恢复默认"用）。 */
export function defaultPersona () {
  return DEFAULT_PERSONA
}

/* ───────────────── 结构化节（AUTONOMY-PROMPT §15.1，2026-11-01） ─────────────────
 *
 * 为什么设置页不再编辑整篇 Markdown：
 *   整篇 textarea 看起来"自由"，实际上把三件事混在一起 —— 想改一个兴趣，也要面对整份文档；
 *   保存一次就把人的排版、空行、备注全洗一遍。人设是她最贵的那份文本，不该被表单误伤。
 *   所以：**读成字段、写只写被改的那一节**，其余逐字节不动。
 *
 * 为什么以「节标题」为准而不是 Markdown 解析器：这份文件是人手写的，
 *   可能带引用块、缩进、行内代码。用节标题切分，没被改的节连多余的空格都不会变。
 */
export const PERSONA_SECTIONS = ['一句话', '性格', '兴趣', '雷点', '语料', '边界']

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 节标题 → 字段名（备注只读，不在 PERSONA_SECTIONS 里）。 */
const SECTION_FIELD = { '一句话': 'tagline', '性格': 'personality', '兴趣': 'interests', '雷点': 'dislikes', '语料': 'phrases', '边界': 'boundaries', '备注': 'notes' }
const LIST_FIELDS = new Set(['personality', 'interests', 'dislikes', 'phrases', 'boundaries'])
const TAGLINE_MAX = 200
const ITEM_MAX = 200
const ITEMS_MAX = 40

/** 把正文按 `## 标题` 切成段（保持每段原文，含标题行）。 */
function splitSections (body) {
  const text = String(body ?? '')
  const segments = []
  const matches = [...text.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)]
  if (matches.length === 0) return { preamble: text, segments }
  const first = matches[0].index
  segments.push({ preamble: text.slice(0, first) })
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length
    segments.push({ title: matches[i][1].trim(), raw: text.slice(start, end) })
  }
  return { preamble: segments.shift().preamble ?? '', segments }
}

const sectionBody = (raw) => String(raw ?? '').replace(/^##[^\n]*\n?/, '')

const bulletsOf = (body) => {
  const lines = String(body ?? '').split(/\r?\n/)
  const bullets = []
  for (const line of lines) {
    const matched = /^\s*[-*]\s+(.*)$/.exec(line)
    if (matched !== null) bullets.push(matched[1].trim())
  }
  if (bullets.length > 0) return bullets
  // 没有 `- ` 前缀的节（例如手写的「外层：…」）：按非空行读，容忍手工格式
  return lines.map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('>'))
}

/**
 * 读结构化字段。缺节 → 空数组 / 空串；**永不抛**。
 * @returns {{name, ownerTitle, tagline, personality[], interests[], dislikes[], phrases[], boundaries[], notes}}
 */
export function parseSections () {
  const empty = { tagline: '', personality: [], interests: [], dislikes: [], phrases: [], boundaries: [], notes: '' }
  let raw = ''
  try { raw = fs.readFileSync(personaPath(), 'utf8') } catch { return { ...readProfile(), ...empty } }
  const parts = splitProfile(raw)
  const { segments } = splitSections(parts.body)
  const out = { ...readProfile(), ...empty }
  for (const segment of segments) {
    const field = SECTION_FIELD[segment.title]
    if (field === undefined) continue
    const body = sectionBody(segment.raw)
    if (field === 'tagline') out.tagline = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '').join(' ')
    else if (field === 'notes') out.notes = body.trim()
    else out[field] = bulletsOf(body).map((item) => item.slice(0, ITEM_MAX)).slice(0, ITEMS_MAX)
  }
  return out
}

const normalizeItems = (value) => {
  if (!Array.isArray(value)) return { error: '列表字段必须是数组' }
  const items = []
  for (const entry of value) {
    const text = String(entry ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
    if (text === '') continue
    if (text.length > ITEM_MAX) return { error: `单项最多 ${ITEM_MAX} 字（现在 ${text.length}）` }
    items.push(text)
  }
  if (items.length > ITEMS_MAX) return { error: `最多 ${ITEMS_MAX} 项（现在 ${items.length}）` }
  return { items }
}

/**
 * 渲染一节：`## 标题` + 空行 + 内容 + **结尾空行**。
 * 结尾那个空行不是随手加的：这份文件里每一节之间都隔着一个空行，
 * 少了它两节就会贴在一起（`- a b\n## 雷点`）—— 渲染没问题，但人看起来是坏的。
 */
function renderSection (title, lines) {
  return `## ${title}\n\n${lines.join('\n')}\n\n`
}

/**
 * 只改写 patch 里出现的节；其余内容（含未出现的节、未知节、节外正文、front-matter 之外的排版）
 * **逐字节不动**。name / ownerTitle 走 writeProfile()，这里不重复实现。
 *
 * @param {{tagline?: string, personality?: string[], interests?: string[], dislikes?: string[], phrases?: string[], boundaries?: string[]}} patch
 * @returns {{ok: true, changed: string[], path: string} | {ok: false, error: string, path: string}}
 */
export function writeSections (patch) {
  const file = personaPath()
  const input = isPlainObject(patch) ? patch : {}
  const changed = []
  const rendered = new Map()

  for (const field of ['tagline', ...LIST_FIELDS]) {
    if (input[field] === undefined) continue
    if (field === 'tagline') {
      const text = String(input.tagline ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
      if (text.length > TAGLINE_MAX) return { ok: false, error: `一句话最多 ${TAGLINE_MAX} 字（现在 ${text.length}）`, path: file }
      rendered.set('tagline', text === '' ? '(空)' : text)
    } else {
      const result = normalizeItems(input[field])
      if (result.error !== undefined) return { ok: false, error: result.error, path: file }
      rendered.set(field, result.items.map((item) => '- ' + item).join('\n'))
    }
    changed.push(field)
  }
  if (changed.length === 0) return { ok: true, changed: [], path: file }

  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { raw = defaultPersona() }
  const parts = splitProfile(raw)
  const { preamble, segments } = splitSections(parts.body)
  const titleOf = new Map(Object.entries(SECTION_FIELD).map(([title, field]) => [field, title]))

  // ① 替换已存在的节（原位，不动顺序）
  const remaining = new Map(rendered)
  const rebuiltSegments = segments.map((segment) => {
    const field = SECTION_FIELD[segment.title]
    if (field === undefined || !remaining.has(field)) return segment
    const value = remaining.get(field)
    remaining.delete(field)
    return { title: segment.title, raw: renderSection(segment.title, value.split('\n')) }
  })

  // ② 缺节：插到「备注」之前；没有备注就追加到末尾；备注永远最后
  if (remaining.size > 0) {
    const extra = []
    for (const [field, value] of remaining) {
      const title = titleOf.get(field)
      if (title === undefined) continue
      extra.push({ title, raw: renderSection(title, value.split('\n')) })
    }
    const notesAt = rebuiltSegments.findIndex((segment) => segment.title === '备注')
    const insertAt = notesAt >= 0 ? notesAt : rebuiltSegments.length
    rebuiltSegments.splice(insertAt, 0, ...extra)
  }
  // 备注永远最后：如果它不在末尾，挪到末尾（其余节保持相对顺序）
  const notesIndex = rebuiltSegments.findIndex((segment) => segment.title === '备注')
  if (notesIndex >= 0 && notesIndex !== rebuiltSegments.length - 1) {
    const [notes] = rebuiltSegments.splice(notesIndex, 1)
    rebuiltSegments.push(notes)
  }

  const body = preamble + rebuiltSegments.map((segment) => segment.raw).join('')
  const out = (parts.prefix ?? '') + body
  try {
    writeTextAtomic(file, out)
    return { ok: true, changed, path: file }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), path: file }
  }
}
