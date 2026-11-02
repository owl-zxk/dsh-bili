// 自主层的数据目录与"原子写"底座（她的一切都落在这里，绝不碰内核的配置与状态）。
//
// 为什么要单独一个目录（$DSH_HOME/dsh-bili-self/）：
//   内核自己的 config / 凭据 / 熔断 / 配额账本是**共享**的（另一个实现也在写），
//   而人设、记忆、日记、日程是"她"的私人物品 —— 混进共享目录既容易被别人写坏，
//   也会让一次误删同时带走账号状态。分开之后，删掉这个目录 = 重置她，账号毫发无损。
//
// 为什么这里自己实现一份 tmp+rename（而不是复用 config.js 的 writeJsonAtomic）：
//   那份是 JSON-only（内部 JSON.stringify），而这里要写的是 persona.md / diary/*.md
//   这类纯文本。**重试策略照抄它**（Windows 上 rename 覆盖被占用的目标会 EPERM/EBUSY，
//   必须短退避重试，见 config.js 里的注释与 2026-11-01 那次事故），
//   但不动 config.js（本轮边界：内核文件一个字节都不改）。
import fs from 'node:fs'
import path from 'node:path'

import { DSH_HOME } from '../vendor/paths.mjs'

const RETRY_ATTEMPTS = 8
const RETRY_BASE_MS = 10
const RETRY_MAX_MS = 200
const RETRY_BUDGET_MS = 1000
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOENT'])

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

let tmpSeq = 0

/** 她的数据目录：默认 $DSH_HOME/dsh-bili-self；$DSH_BILI_SELF_DIR 只给测试用（默认路径不变）。 */
export function selfDir () {
  const override = process.env.DSH_BILI_SELF_DIR
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim())
  return path.join(DSH_HOME, 'dsh-bili-self')
}

/** 建目录（幂等，失败返回 false —— 调用方自己决定降级方式，不在这里抛）。 */
export function ensureDir (dir = selfDir()) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/**
 * 原子写纯文本（tmp + rename，带 Windows 抖动重试）。
 * 失败时**保留 tmp** 并把错误抛出去（排障时能看到这一次到底要写什么）。
 */
export function writeTextAtomic (file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  tmpSeq = (tmpSeq + 1) % 1_000_000
  const tmp = `${file}.${process.pid}.${Date.now()}.${tmpSeq}.tmp`
  const body = String(text)
  try {
    fs.writeFileSync(tmp, body)
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 半个 tmp 删不掉不影响真正的错误 */ }
    throw error
  }
  let lastError = null
  const deadline = Date.now() + RETRY_BUDGET_MS
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(tmp, file)
      return file
    } catch (error) {
      lastError = error
    }
    if (!RETRYABLE.has(lastError?.code)) break
    if (attempt >= RETRY_ATTEMPTS) break
    if (lastError.code === 'ENOENT') {
      try { fs.writeFileSync(tmp, body) } catch { /* 写不回去就让原始错误冒出去 */ }
    }
    const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1))
    if (Date.now() + wait > deadline) break
    sleepSync(wait)
  }
  const wrapped = new Error(`原子写失败（${lastError?.code ?? 'unknown'}）：${file} —— 内容已留在 ${tmp}；原始错误：${lastError?.message ?? 'unknown'}`)
  wrapped.code = lastError?.code
  wrapped.cause = lastError
  wrapped.tmpPath = tmp
  throw wrapped
}

/** 追加一行（用于 jsonl）。写坏了只返回 false，绝不抛到调用方（日记/审计不该弄停她）。 */
export function appendLine (file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, String(line).replace(/\r?\n/g, ' ') + '\n')
    return true
  } catch {
    return false
  }
}

export function statePath () {
  return path.join(selfDir(), 'state.json')
}

/** 读 state.json；缺失/坏 → 空对象（她的状态丢了不该把插件弄停）。 */
export function readState () {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8').replace(/^\uFEFF/, ''))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 浅合并写回（state 的字段都是平铺的标量/小对象，不需要深合并语义）。 */
export function patchState (patch) {
  const next = { ...readState(), ...(patch !== null && typeof patch === 'object' ? patch : {}) }
  try {
    writeTextAtomic(statePath(), JSON.stringify(next, null, 2) + '\n')
  } catch {
    return next // 落盘失败不影响本次运行（内存里那份仍然有效）
  }
  return next
}
