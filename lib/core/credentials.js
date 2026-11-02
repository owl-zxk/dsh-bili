// 凭据层：读共享的 ~/.bili-ai/credentials.json（**只读**照旧），外加设置页那一条"写回"通道。
//
// 为什么读和写不是同一种待遇：
//   读是共享的 —— 同一个 OS 用户下所有实现共用一份登录态，谁都不该独占；
//   写只有一条入口（saveCookie），因为粘贴 cookie 是人类动作，必须能原子落盘，
//     而且**解析不出来就不许写**（见 saveCookie 的注释：写空等于把主人的登录态抹掉）。
//
// 为什么不在这里缓存凭据：
//   用户在设置页粘贴完 cookie，下一次工具调用就得能用。
//   vendor 的 loadCred() 本来就是读文件的，代价可以忽略，缓存只会制造"改了没生效"。
//
// 为什么错误信息里只有路径、没有值：
//   凭据进日志 = 泄漏。这里的每一句 human 都只说"缺哪个字段 / 格式不对"，
//   永远不带 sessdata / bili_jct / buvid3 的实际内容，也不带响应正文。
import fs from 'node:fs'

import { credentialsPath, credPath } from '../vendor/paths.mjs'
import {
  CODE_HINTS as VENDOR_CODE_HINTS,
  explainCode as vendorExplainCode,
  loadCred as vendorLoadCred,
  looksLikeJct,
  missingForWrite,
} from '../vendor/cred.mjs'
import { readJsonSafe, writeJsonAtomic } from './config.js'

/** 规范位置（<HOME>/.bili-ai/credentials.json）。实际读取走 credPath()（仅测试会不同）。 */
export const CRED_PATH = credentialsPath

/** 当前实际生效的凭据文件（设置页要显示"凭据在哪"，但不显示内容）。 */
export function credFile () {
  return credPath()
}

/** 读凭据（trim、容忍 BOM）。缺文件/坏 JSON 抛 Error，消息带路径 + '去设置页粘贴'。 */
export function loadCred () {
  return vendorLoadCred()
}

/** 错误码 → 人话（vendor/cred.mjs 的 CODE_HINTS，一个字都没重写）。 */
export function explainCode (code) {
  return vendorExplainCode(code)
}

/** 已知错误码表（只读副本，工具描述里要列给人看）。 */
export const CODE_HINTS = Object.freeze({ ...VENDOR_CODE_HINTS })

/**
 * 凭据体检 —— **永不回显值**，只回答"有没有 / 像不像 / 缺哪个"。
 * 为什么单独一个函数：模型和设置页都靠它决定"能不能写"，
 * 而直接 loadCred() 会让调用方不小心把凭据对象打印出来。
 */
export function credStatus () {
  let cred = null
  let broken = false
  try {
    cred = vendorLoadCred()
  } catch {
    broken = fs.existsSync(credPath())
  }
  const hasSessdata = Boolean(cred?.sessdata)
  const hasJct = Boolean(cred?.bili_jct)
  const hasBuvid3 = Boolean(cred?.buvid3)
  const missing = []
  if (!hasSessdata) missing.push('SESSDATA（登录态）')
  if (!hasJct) missing.push('bili_jct（写操作必须的 csrf token）')
  if (!hasBuvid3) missing.push('buvid3（部分接口要）')
  return {
    present: cred !== null,
    hasSessdata,
    hasJct,
    hasBuvid3,
    jctLooksValid: hasJct && looksLikeJct(cred.bili_jct),
    missing,
    path: credPath(),
    // 只说"文件坏了"，不带 JSON.parse 的原始消息 —— 那条消息会把文件里的一个字符带出来
    error: cred === null && broken ? '凭据文件存在但读不出来（不是合法 JSON？）→ 去设置页重新粘贴一次' : null,
  }
}

/**
 * 把"粘贴进来的一大串"解析成三个字段。
 * 支持两种粘法：整段 cookie 头（SESSDATA=…; bili_jct=…; buvid3=…），
 * 或者一段 JSON（{"sessdata":"…","bili_jct":"…"}）。
 * 键名大小写不敏感、值两侧的引号/空白都吃掉 —— 从浏览器复制出来经常带这些。
 */
function parseCookieInput (text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').trim()
  if (raw === '') return {}
  const pick = (obj) => {
    const out = {}
    for (const [key, value] of Object.entries(obj ?? {})) {
      const k = String(key).trim().toLowerCase()
      const v = String(value ?? '').trim().replace(/^["']|["']$/g, '')
      if (k === 'sessdata') out.sessdata = v
      else if (k === 'bili_jct') out.bili_jct = v
      else if (k === 'buvid3') out.buvid3 = v
    }
    return out
  }
  if (raw.startsWith('{')) {
    try {
      return pick(JSON.parse(raw))
    } catch {
      return {}
    }
  }
  const pairs = {}
  for (const part of raw.split(/[;\n\r]+/)) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    const key = part.slice(0, at).trim()
    if (key !== '') pairs[key] = part.slice(at + 1)
  }
  return pick(pairs)
}

/**
 * 粘贴的 cookie 串 → 解析 → 原子写回。返回 credStatus()。
 *
 * 为什么解析不出东西时**抛错不落盘**：
 *   写空文件 = 把主人真实的登录态抹掉，而且症状要到下一次写操作才暴露（code=-101）。
 *   宁可这次保存失败，也不能悄悄清空。
 *
 * 为什么合并而不是覆盖：凭据文件可能还有别的字段（别的实现加的），
 *   本包不认识它们，但那不该由本包决定删掉。
 */
export function saveCookie (text) {
  const parsed = parseCookieInput(text)
  const found = ['sessdata', 'bili_jct', 'buvid3'].filter((key) => typeof parsed[key] === 'string' && parsed[key] !== '')
  if (found.length === 0) {
    throw new Error('没从粘贴内容里认出 SESSDATA / bili_jct / buvid3 —— 已保持原凭据不变。请整段复制 cookie 头再试')
  }
  const file = credPath()
  const current = readJsonSafe(file, {})
  const next = { ...(current !== null && typeof current === 'object' ? current : {}), ...parsed }
  writeJsonAtomic(file, next)
  try { fs.chmodSync(file, 0o600) } catch { /* Windows 上 chmod 基本无效，best-effort */ }
  return credStatus()
}

/**
 * 写操作前的统一检查。
 * @returns {null | { ok: false, reason: 'credential-missing', human: string }} null = 可以继续
 *
 * 为什么把 jct 的格式也一起查：B站 回 code=-111 时只会说"CSRF 校验失败"，
 * 而真实原因常常是"复制 bili_jct 时少了几位"。在这里先说清楚，比让它去撞一次 B站 好。
 * ⚠️ 本地**无法**验证 sessdata 与 bili_jct 是否属于同一账号（只有 B站 知道），
 *    所以这里只做"在不在 / 像不像"，真正的账号一致性只能靠一次写请求的返回码。
 */
export function requireForWrite (cred) {
  let value = cred
  if (value === undefined || value === null) {
    try { value = vendorLoadCred() } catch { value = {} }
  }
  const missing = missingForWrite(value)
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'credential-missing',
      human: `凭据不完整：缺 ${missing.join('、')}\n  去设置页粘贴一次完整 cookie（SESSDATA 与 bili_jct 要同时重抄）再发`,
    }
  }
  if (!looksLikeJct(value.bili_jct)) {
    return {
      ok: false,
      reason: 'credential-missing',
      human: 'bili_jct 格式不对（B站 目前是 32 位十六进制）—— 多半是复制时截断了；只读接口还能用，所以"体检全绿"不代表能发东西',
    }
  }
  return null
}
