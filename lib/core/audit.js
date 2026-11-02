// 审计：每一次**对外动作**留一行痕迹（audit.jsonl）。
//
// 为什么必须写：这个层会以主人的账号在公开场合说话。"没写审计的动作视为没发生"是它的
//   验收线 —— 事后能查、能复盘、能知道自己昨天到底发了什么，才有资格自动发言。
//
// 为什么正文截断 80 字 + 键名脱敏：
//   ① 审计是给人看的，80 字足够认出"这是哪条评论"；
//   ② 它同时是一份长期文件，长度必须可控；
//   ③ 凭据/令牌一旦进来就是永久泄漏（文件会被读、被备份、被贴进 issue）。
//      所以这里既按**键名**拦（cookie/sessdata/jct/token/csrf/password/authorization…），
//      也按**形状**拦一手（32 位十六进制 = bili_jct 的形状）。
import fs from 'node:fs'
import path from 'node:path'

import { selfDir } from './state.js'

/** 审计正文上限（字符）。 */
export const TEXT_MAX = 80
const SECRET_KEY = /(cookie|sessdata|sess|jct|csrf|token|secret|password|passwd|authorization|auth|api[-_]?key)/i
const LOOKS_LIKE_SECRET = /^[0-9a-f]{32}$|^[A-Za-z0-9_%]{60,}$/

export function auditPath () {
  return path.join(selfDir(), 'audit.jsonl')
}

const clip = (value) => (String(value).length > TEXT_MAX ? String(value).slice(0, TEXT_MAX) + '…' : String(value))

/** 参数摘要：键名脱敏 + 值截断。对象只展平一层（审计不是日志转储）。 */
function summarize (args) {
  if (args === null || typeof args !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(args)) {
    if (SECRET_KEY.test(key)) {
      out[key] = '***'
      continue
    }
    if (value !== null && typeof value === 'object') {
      out[key] = Array.isArray(value) ? `[array ${value.length}]` : '[object]'
      continue
    }
    const text = String(value ?? '')
    out[key] = LOOKS_LIKE_SECRET.test(text) ? '***' : clip(text)
  }
  return out
}

/**
 * 追加一条审计。
 * @param {{tool: string, args?: object, result?: any, why?: string}} entry
 */
export function appendAudit (entry) {
  const input = entry !== null && typeof entry === 'object' ? entry : {}
  const row = {
    at: new Date().toISOString(),
    tool: String(input.tool ?? 'unknown').slice(0, 64),
    why: clip(String(input.why ?? '')),
    args: summarize(input.args),
    ok: input.result !== null && typeof input.result === 'object' ? input.result.ok === true : null,
    reason: input.result !== null && typeof input.result === 'object' && input.result.reason !== undefined ? clip(input.result.reason) : null,
  }
  try {
    fs.mkdirSync(selfDir(), { recursive: true })
    fs.appendFileSync(auditPath(), JSON.stringify(row) + '\n')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 最近 n 条（新的在后）。 */
export function readAudit (n = 50) {
  const want = Math.max(1, Math.min(500, Math.round(Number(n) || 50)))
  try {
    const lines = fs.readFileSync(auditPath(), 'utf8').split('\n').filter((line) => line.trim() !== '')
    return lines.slice(Math.max(0, lines.length - want)).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}
