// 记忆：一行一条 JSON（memory.jsonl），上限 2000 行滚动。
//
// 为什么是 jsonl 而不是一个 JSON 数组：她每醒一次就追加几条，而整份读-改-写在大文件上
//   既慢又容易在并发写的时候互相覆盖。jsonl 追加是原子的（单行 append），只有滚动时才重写。
// 为什么要滚动：记忆是喂给模型的上下文，无限长等于把上下文烧光；2000 行是"还记得住"和
//   "付得起"之间的折中（按每次取最近 30 条算，2000 行够几周的对话）。
import fs from 'node:fs'
import path from 'node:path'

import { selfDir, writeTextAtomic } from './state.js'

/** 记忆上限（行）。 */
export const MEMORY_MAX = 2000
const KINDS = new Set(['event', 'thought', 'owner', 'system'])

export function memoryPath () {
  return path.join(selfDir(), 'memory.jsonl')
}

function readLines () {
  try {
    return fs.readFileSync(memoryPath(), 'utf8').split('\n').filter((line) => line.trim() !== '')
  } catch {
    return []
  }
}

function parseLine (line) {
  try {
    const item = JSON.parse(line)
    if (item === null || typeof item !== 'object') return null
    return { at: String(item.at ?? ''), kind: String(item.kind ?? 'event'), text: String(item.text ?? ''), ref: item.ref === undefined ? null : item.ref }
  } catch {
    return null
  }
}

/**
 * 追加一条记忆并滚动到上限。
 * @param {{kind?: string, text: string, ref?: any}} entry
 */
export function appendMemory (entry) {
  const input = entry !== null && typeof entry === 'object' ? entry : {}
  const text = String(input.text ?? '').trim()
  if (text === '') return { ok: false, error: '记忆内容不能为空' }
  const kind = KINDS.has(String(input.kind)) ? String(input.kind) : 'event'
  const line = JSON.stringify({ at: new Date().toISOString(), kind, text: text.slice(0, 500), ref: input.ref ?? null })
  const lines = readLines()
  lines.push(line)
  const kept = lines.length > MEMORY_MAX ? lines.slice(lines.length - MEMORY_MAX) : lines
  // 只有真的滚动过才重写整份（否则一次 append 就够了，别每次都重写 2000 行）
  if (kept.length === lines.length) {
    try {
      fs.mkdirSync(selfDir(), { recursive: true })
      fs.appendFileSync(memoryPath(), line + '\n')
      return { ok: true, count: kept.length }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }
  try {
    writeTextAtomic(memoryPath(), kept.join('\n') + '\n')
    return { ok: true, count: kept.length }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 最近 n 条（新的在后）。读不出来返回空数组，永不抛。 */
export function recentMemory (n = 30) {
  const want = Math.max(1, Math.min(MEMORY_MAX, Math.round(Number(n) || 30)))
  const lines = readLines()
  return lines.slice(Math.max(0, lines.length - want)).map(parseLine).filter(Boolean)
}

/** 全部条数（设置页显示"记得多少"用）。 */
export function memoryCount () {
  return readLines().length
}
