// lib/core/deepwatch.js —— 真的"看懂"一条视频（AUTONOMY-PROMPT §25）
//
// 流程（已核实的事实，不再猜）：
//   bili_playurl({bvid, qn}) → 单文件 mp4 直链（不是 DASH，不用 ffmpeg 合流）
//   → 体积闸（>200MB 不下）→ 流式下载到 <tmp>/dsh-bili/<bvid>.mp4（带 Referer/UA，180 秒超时）
//   → 交给**宿主的** video_understand（它自己抽帧 + 转写）→ 整理成工具结果 → finally 删文件。
//
// 为什么把下载放在插件里、理解放在宿主里：
//   抽帧/转写/视觉模型是宿主已经有的能力（video_understand），重写一遍既重复又更容易出错；
//   而"下一条 B站 视频"是 B站 账号侧的事 —— 只有这里有 cookie、Referer 与限流知识。
//
// 三条硬规矩：
//   ① 体积闸在**下载之前**判（省流量也省时间）；
//   ② 宿主没有 video_understand → capability-not-found，**绝不伪造摘要**（没看就是没看）；
//   ③ 无论成功失败，临时文件都要删（finally）—— 磁盘不是垃圾桶。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readState, patchState } from './state.js'

/** 体积闸：超过这个大小就不下（§25.2）。 */
export const MAX_BYTES = 200 * 1024 * 1024
/**
 * 时长闸：超过 10 分钟的视频不看（2026-11-02 用户要求）。
 * 为什么是**下载之前**判：dsh-video 那侧处理不了 >10 分钟，下了也是白下 200MB。
 * 边界：正好 600 秒放行（<= 600 才算能看）。
 */
export const MAX_DURATION_SEC = 600
/** 下载超时（§25.2：180 秒）。 */
export const DOWNLOAD_TIMEOUT_MS = 180_000
/** 同一 bvid 的缓存窗口：10 分钟内不重复下载（§25.2）。 */
export const CACHE_TTL_MS = 10 * 60_000
/** B站 要求带 Referer，否则 CDN 直接 403。 */
const REFERER = 'https://www.bilibili.com/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const str = (v) => (v === undefined || v === null ? '' : String(v).trim())
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }

/** 临时目录：os.tmpdir()/dsh-bili（不存在就建）。 */
export function tempDir () {
  const dir = path.join(os.tmpdir(), 'dsh-bili')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 建不出来交给后面的写去暴露 */ }
  return dir
}

/** 该 bvid 的临时文件路径（下载完、理解完都会被删）。 */
export function tempPathOf (bvid) {
  return path.join(tempDir(), String(bvid).replace(/[^0-9A-Za-z_]/g, '') + '.mp4')
}

async function cleanup (file) {
  try { await fsp.rm(file, { force: true }) } catch { /* 删不掉就下次再说 */ }
}

/**
 * 找宿主的 video_understand。
 * 顺序：ctx.tools.get('video_understand') → 能力注册表 video.understand → null。
 * 为什么两处都试：宿主版本不同，工具可能挂在 tools 服务上，也可能只以能力形式注册。
 */
export function findVideoUnderstand (deps) {
  const ctx = deps === undefined || deps === null ? undefined : deps.ctx
  if (ctx !== undefined && ctx !== null && typeof ctx.get === 'function') {
    try {
      const tools = ctx.get('tools')
      if (tools !== undefined && tools !== null && typeof tools.get === 'function') {
        const tool = tools.get('video_understand')
        if (tool !== undefined && tool !== null && typeof tool.execute === 'function') return { kind: 'tool', run: (args) => tool.execute(args, {}) }
      }
    } catch { /* 拿不到就试能力注册表 */ }
  }
  const caps = deps === undefined || deps === null ? undefined : deps.capabilities
  if (caps !== undefined && caps !== null && typeof caps.call === 'function') {
    return { kind: 'capability', run: (args) => caps.call('video.understand', args) }
  }
  return null
}

/** 缓存：{ bvid: { at, summary, answer } }；超时或超过 20 条直接丢。 */
function cachedOf (bvid) {
  const cache = readState().deepWatchCache
  if (cache === null || typeof cache !== 'object') return null
  const hit = cache[bvid]
  if (hit === null || typeof hit !== 'object') return null
  const at = Date.parse(String(hit.at ?? ''))
  if (!Number.isFinite(at) || Date.now() - at > CACHE_TTL_MS) return null
  return hit
}

function rememberCache (bvid, payload) {
  const cache = readState().deepWatchCache
  const next = { ...(cache !== null && typeof cache === 'object' ? cache : {}), [bvid]: { at: new Date().toISOString(), ...payload } }
  const keys = Object.keys(next).slice(-20) // 只留最近 20 条，别让 state 无限长
  const trimmed = Object.fromEntries(keys.map((k) => [k, next[k]]))
  try { patchState({ deepWatchCache: trimmed }) } catch { /* 写不进去 → 下次再下，不影响本次 */ }
}

/** 默认下载器：流式写盘 + 超时 + 体积上限（测试里可以被 deps.downloadFile 替换）。 */
async function defaultDownload (url, file, { timeoutMs = DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { Referer: REFERER, 'User-Agent': UA, Range: 'bytes=0-' },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (response.ok !== true) return { ok: false, reason: 'network', human: '下载失败：HTTP ' + response.status }
    const declared = num(response.headers.get('content-length'), 0)
    if (declared > maxBytes) return { ok: false, reason: 'bad-argument', human: '这条视频太大（' + Math.round(declared / 1048576) + 'MB），不下' }
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const handle = await fsp.open(file, 'w')
    let written = 0
    try {
      for await (const chunk of response.body) {
        written += chunk.length
        if (written > maxBytes) {
          return { ok: false, reason: 'bad-argument', human: '下载超过 ' + Math.round(maxBytes / 1048576) + 'MB，已中止' }
        }
        await handle.write(chunk)
      }
    } finally {
      await handle.close()
    }
    return { ok: true, bytes: written, file }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return { ok: false, reason: 'network', human: aborted ? '下载超时（180 秒）' : '下载中断：' + String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 把 video_understand 的返回压成一句能给她看的摘要（不编内容，只取它给的字段）。 */
function summarize (out) {
  const data = out !== null && typeof out === 'object' && out.data !== null && typeof out.data === 'object' ? out.data : (out ?? {})
  const answer = str(data.answer ?? out?.answer)
  const sum = str(data.summary ?? out?.summary)
  const scenes = Array.isArray(data.scenes) ? data.scenes.length : 0
  const transcript = Array.isArray(data.transcript) ? data.transcript.length : 0
  return {
    summary: sum === '' ? answer : sum,
    answer: answer === '' ? sum : answer,
    scenes,
    transcriptLines: transcript,
    durationMs: num(data.durationMs, 0),
    model: str(data.model),
    failures: Array.isArray(data.failures) ? data.failures.slice(0, 3) : [],
  }
}

/**
 * 真的看懂一条视频。
 * @param {{bvid: string, question?: string, deps?: object, qn?: number}} input
 * @returns {Promise<{ok: boolean, reason?: string, human?: string, data?: object}>}
 */
export async function deepWatch ({ bvid, question = '', deps, qn, duration } = {}) {
  const id = str(bvid)
  if (id === '') return { ok: false, reason: 'bad-argument', human: 'deepWatch 需要 bvid' }

  // ① 缓存：10 分钟内同一个 bvid 不重复下载
  const hit = cachedOf(id)
  if (hit !== null) {
    return { ok: true, data: { bvid: id, cached: true, ...(hit.result ?? {}) } }
  }

  // ② 宿主有没有理解能力（先查，避免白下载一个几百 MB 的文件）
  const viewer = findVideoUnderstand(deps)
  if (viewer === null) {
    return {
      ok: false,
      reason: 'capability-not-found',
      human: '宿主没有提供 video_understand（也没有 video.understand 能力），所以没法真的看懂 —— 不伪造摘要。',
      detail: { bvid: id, available: typeof deps?.capabilities?.ids === 'function' ? deps.capabilities.ids() : [] },
    }
  }

  // ②b 走能力注册表这条时先看"注册了没有"：ids 里没有 video.understand 就直接说没能力，
  //     不要白下载一个几百 MB 的文件再发现调不通（真机上这一步能省一整次下载）。
  if (viewer.kind === 'capability') {
    // 注册表对外暴露的是 list()（返回 [{id,…}]），不是 ids()
    const caps = deps.capabilities
    const listed = typeof caps?.list === 'function' ? caps.list() : null
    const ids = Array.isArray(listed) ? listed.map((x) => String(x?.id ?? '')).filter((x) => x !== '') : null
    if (Array.isArray(ids) && !ids.includes('video.understand')) {
      return {
        ok: false,
        reason: 'capability-not-found',
        human: '能力注册表里没有 video.understand（当前可用：' + (ids.length === 0 ? '一个都没有' : ids.join(', ')) + '）—— 不下载、也不伪造摘要。',
        detail: { bvid: id, available: ids },
      }
    }
  }

  // ②c 时长闸（下载**之前**）：调用方带了 duration 就直接判；没带就用 video_info 取一次。
  let seconds = Number.isFinite(Number(duration)) ? Number(duration) : null
  if (seconds === null && typeof deps?.api?.videoInfo === 'function') {
    try {
      const info = await deps.api.videoInfo({ bvid: id })
      if (info?.ok === true) seconds = Number.isFinite(Number(info.data?.duration)) ? Number(info.data.duration) : null
    } catch { /* 取不到时长就不拦（宁可试一次，也不要因为信息缺失就不看） */ }
  }
  if (seconds !== null && seconds > MAX_DURATION_SEC) {
    const minutes = Math.ceil(seconds / 60) // 601 秒 → "11 分钟"：别四舍五入成 10 与上限撞车
    return {
      ok: false,
      reason: 'too-long',
      human: `这条 ${minutes} 分钟，超过 ${MAX_DURATION_SEC / 60} 分钟我处理不了，换条短的`,
      detail: { bvid: id, duration: seconds, limit: MAX_DURATION_SEC },
    }
  }

  // ③ playurl → 直链（qn 依次尝试）
  const playurl = deps?.api?.playurl ?? deps?.playurl
  if (typeof playurl !== 'function') return { ok: false, reason: 'capability-not-found', human: '没有 playurl 通道，取不到视频直链' }
  let picked = null
  for (const quality of [qn, 80, 64].filter((q) => Number.isFinite(Number(q)))) {
    const out = await playurl({ bvid: id, qn: Number(quality) })
    if (out?.ok !== true) continue
    const list = Array.isArray(out.data?.urls) ? out.data.urls : []
    if (list.length > 0) { picked = list[0]; break }
  }
  if (picked === null) return { ok: false, reason: 'network', human: '取不到播放直链（playurl 失败或返回空）' }

  // ④ 体积闸：在下载**之前**判
  const size = num(picked.size, 0)
  if (size > MAX_BYTES) {
    return {
      ok: false,
      reason: 'bad-argument',
      human: '这条视频太大（' + Math.round(size / 1048576) + 'MB > 200MB），不下也不看 —— 换条短的，或调大上限（bili_watch 的 deep 只对 ≤200MB 生效）',
      detail: { bvid: id, size, limit: MAX_BYTES },
    }
  }

  // ⑤ 下载 → 理解 → 无论成败都删文件
  const file = tempPathOf(id)
  const downloader = typeof deps?.downloadFile === 'function' ? deps.downloadFile : defaultDownload
  try {
    const got = await downloader(str(picked.url), file, { timeoutMs: DOWNLOAD_TIMEOUT_MS, maxBytes: MAX_BYTES })
    if (got === null || got.ok !== true) {
      return { ok: false, reason: str(got?.reason) || 'network', human: str(got?.human) || '下载失败', detail: { bvid: id } }
    }
    const understood = await viewer.run({ path: file, question: str(question), detail: 'standard' })
    const failed = understood === null || typeof understood !== 'object' || understood.ok === false
    if (failed) {
      return {
        ok: false,
        reason: str(understood?.reason) || 'capability-not-found',
        human: str(understood?.human) || 'video_understand 没有返回结果',
        detail: { bvid: id, kind: viewer.kind },
      }
    }
    const brief = summarize(understood)
    rememberCache(id, { result: { ...brief, bytes: num(got.bytes, 0) } })
    return { ok: true, data: { bvid: id, cached: false, bytes: num(got.bytes, 0), kind: viewer.kind, ...brief } }
  } catch (error) {
    return { ok: false, reason: 'network', human: '深读出错：' + String(error?.message ?? error), detail: { bvid: id } }
  } finally {
    await cleanup(file)
  }
}
