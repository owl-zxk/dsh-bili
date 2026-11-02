// tests/helpers/harness.mjs
// 为什么这样测：整套测试的第一条纪律是「零真实网络 + 零真实用户目录」。
//   所以这里只提供四样基础设施，不含任何断言：
//   ① 每个用例一个 os.tmpdir() 下的独立目录（结束时统一删除，绝不碰 ~/.bili-ai）；
//   ② 可计数的假 transport：把 globalThis.fetch 换掉，并配合 vendor 自己留的测试逃生口
//      （traffic.mjs: BILI_TRAFFIC_TEST=1 且 NODE_TEST_CONTEXT 存在时 guardedFetch 直接用
//       globalThis.fetch），于是 client/api 层一行都不用改就能被注入；
//   ③ 环境变量快照/还原：DSH_BILI_STATE_DIR / DSH_BILI_CRED_PATH / DSH_BILI_CONFIG
//      必须在 import lib 之前就指到临时目录（paths.mjs 在调用时读，但 bili-api.mjs 在
//      模块加载期就会取一次 stateDir()，所以顺序必须由用例自己保证 —— 因此每个用例都用
//      动态 import，不用静态 import）；
//   ④ 夹具：WBI 密钥对（两段各 32 字符，拼起来正好 64，见 vendor/bili-api.mjs 的 raw.length
//      检查）、一个形状合法的 bvid、一个 32 位十六进制的 bili_jct。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 仓库根目录（tests/helpers/ 往上两级）。 */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

/** 把仓库里的相对路径转成可 import 的 file URL —— 复制到临时目录后仍然指向「那一份」。 */
export function repoUrl (relative) {
  return pathToFileURL(path.join(REPO_ROOT, relative)).href
}

const tempDirs = []

/** 建一个临时目录（os.tmpdir() 下），登记到清理清单。 */
export function tmpDir (tag = 'case') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bili-test-' + tag + '-'))
  tempDirs.push(dir)
  return dir
}

/** 清理本进程建过的所有临时目录（after() 里调用）。 */
export function cleanupTmp () {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 上偶发占用，留着不影响断言 */ }
  }
}

/**
 * 设置环境变量并返回还原函数。值写 undefined = 删掉这个变量（用来清掉 BILI_NO_CACHE，
 * 否则缓存/熔断那两条用例会静默走「强制真网络」分支）。
 */
export function setEnv (vars) {
  const previous = {}
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = String(value)
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/**
 * 一个「沙盒环境」：状态目录 / 凭据 / 配置 / **token 用量账本**全部指到临时目录，
 * 并打开 vendor 的测试逃生口。
 *
 * 为什么必须把 DSH_BILI_USAGE_LEDGER 也指走：token 预算的判据来自宿主写的用量账本，
 * 默认路径是 $DSH_HOME/dsh-usage/usage-ledger.json —— **本机真实的那一份**。不指走的话，
 * 「写通道能发」「预算用尽要拒」这类断言会跟着宿主当前花了多少 token 飘，
 * 在别人机器上必紅。
 */
export function sandboxEnv (root) {
  return setEnv({
    DSH_BILI_STATE_DIR: root,
    DSH_BILI_CRED_PATH: path.join(root, 'credentials.json'),
    DSH_BILI_CONFIG: path.join(root, 'dsh-bili.config.json'),
    DSH_BILI_USAGE_LEDGER: path.join(root, 'usage-ledger.json'),
    BILI_TRAFFIC_TEST: '1',
    BILI_NO_CACHE: undefined,
  })
}

/** 账本里的「本地日」键（与 core/tokenbudget.js 的 localDay 同口径：sv-SE 的 YYYY-MM-DD）。 */
export function localDayKey (date = new Date()) {
  return date.toLocaleDateString('sv-SE')
}

/** 本地小时键（YYYY-MM-DDTHH，与 tokenbudget.js 的 localHourKey 同口径）。 */
export function localHourKey (date = new Date()) {
  return localDayKey(date) + 'T' + String(date.getHours()).padStart(2, '0')
}

/**
 * 写一份用量账本，让「当天合计」正好等于 total（input + output，不含 cache/reasoning —— 契约 §11）。
 * @returns {string} 账本文件路径
 */
export function writeUsageLedger (file, total, { day = localDayKey() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const half = Math.floor(total / 2)
  fs.writeFileSync(file, JSON.stringify({
    days: {
      [day]: {
        provider_a: { model_a: { inputTokens: half, outputTokens: 0 } },
        provider_b: { model_b: { inputTokens: 0, outputTokens: total - half } },
      },
    },
  }))
  return file
}

/** 写采样状态文件（<stateDir>/token-budget.json），用于构造「跨小时 / 跨天」这类历史现场。 */
export function writeBudgetState (stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true })
  const file = path.join(stateDir, 'token-budget.json')
  fs.writeFileSync(file, JSON.stringify(state))
  return file
}

/** 造一个 JSON 响应（真 Response，guardedFetch / apiGet 都要 .ok / .status / .text()）。 */
export function jsonResponse (body, init = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(text, {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

/**
 * 假 transport：handler(url, info) 返回 Response。
 * calls 里留下每一次「网络请求」的 url / method / headers / body —— 所有「打了几次网络」
 * 的断言都读这个数组，而不是读实现里的计数器。
 */
export function fetchSpy (handler) {
  const calls = []
  const fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : (input && input.url) || String(input)
    const url = new URL(raw)
    const method = String(init.method ?? (input && input.method) ?? 'GET').toUpperCase()
    const call = { url, href: url.href, path: url.pathname, method, headers: init.headers ?? {}, body: init.body }
    calls.push(call)
    return handler(url, call)
  }
  return { fetch, calls }
}

/** 装/卸 globalThis.fetch（每个用例 after() 里还原，避免污染同文件后面的用例）。 */
export function installFetch (fetchImpl) {
  const previous = globalThis.fetch
  globalThis.fetch = fetchImpl
  return () => { globalThis.fetch = previous }
}

/** 递归列出目录下所有文件（绝对路径）。读快照类用例用它；只读不写。 */
export function walkFiles (dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  return out.sort()
}

/** 读 JSON 文件；坏文件直接抛（用例就是来抓「写出半个 JSON」的）。 */
export function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/* ────────────────────────────── 夹具 ────────────────────────────── */

/** WBI 密钥对：两段各 32 字符（vendor 里 raw 必须是 64 字符）。 */
export const WBI_IMG = {
  img_url: 'https://i0.hdslb.com/bfs/wbi/' + 'a'.repeat(32) + '.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/' + 'b'.repeat(32) + '.png',
}

/** 形状合法的 BV 号（/^BV[0-9A-Za-z]{10}$/）。 */
export const BVID = 'BV1GJ411x7h7'

/** 32 位十六进制 —— 形状检查（looksLikeJct）认的就是这个。 */
export const JCT = '0123456789abcdef0123456789abcdef'

/** PROMPT §6.3 的实测主人值（与 core/config.js 的默认值一致）。 */
export const OWNER = { mid: 389989266, name: '往生堂七七代堂主' }

/** 一条「够用」的假凭据（写通道的形状检查能过）。 */
export function writeCredFile (file, extra = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ sessdata: 'SESSDATA-FIXTURE', bili_jct: JCT, buvid3: 'BUV-FIXTURE', ...extra }))
  return file
}
