// 日记：一天一篇 diary/YYYY-MM-DD.md，只追加、绝不覆盖。
//
// 为什么按天分文件：日记是"这一天她过得怎么样"，翻起来要按天；而且追加到同一个小文件
//   比每天重写一份大 Markdown 安全得多（写坏一天不会毁掉全部）。
// 为什么带时间戳前缀：agent 事后复盘时，"几点做了什么"是最有用的信息，而 Markdown 里
//   单独一行 [HH:MM] 读起来也不碍事。
import fs from 'node:fs'
import path from 'node:path'

import { selfDir, writeTextAtomic } from './state.js'

const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE') // YYYY-MM-DD（本地）

export function diaryDir () {
  return path.join(selfDir(), 'diary')
}

export function diaryPath (day = dayKey()) {
  return path.join(diaryDir(), day + '.md')
}

/** 追加一段（多行按行加前缀）。写坏了只返回 false —— 日记写不进去不该让她停下来。 */
export function appendDiary (text) {
  const body = String(text ?? '').trim()
  if (body === '') return { ok: false, error: '日记内容不能为空' }
  const day = dayKey()
  const file = diaryPath(day)
  const stamp = new Date().toTimeString().slice(0, 5)
  const block = body.split(/\r?\n/).map((line) => `${stamp} ${line}`).join('\n')
  try {
    fs.mkdirSync(diaryDir(), { recursive: true })
    if (fs.existsSync(file)) {
      fs.appendFileSync(file, '\n' + block + '\n')
    } else {
      writeTextAtomic(file, `# ${day}\n\n` + block + '\n')
    }
    return { ok: true, path: file }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 当天末尾 n 行（给大脑当上下文）。 */
export function todayDiary (nLines = 10) {
  const want = Math.max(1, Math.round(Number(nLines) || 10))
  try {
    const lines = fs.readFileSync(diaryPath(), 'utf8').split('\n').filter((line) => line.trim() !== '')
    return lines.slice(Math.max(0, lines.length - want)).join('\n')
  } catch {
    return ''
  }
}

/** 最近的日记文件路径列表（新的在前；设置页"前几天写了什么"用）。 */
export function recentDiaryDays (limit = 7) {
  try {
    return fs.readdirSync(diaryDir()).filter((name) => name.endsWith('.md')).sort().reverse().slice(0, Math.max(1, limit))
  } catch {
    return []
  }
}
