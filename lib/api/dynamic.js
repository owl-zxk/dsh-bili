// lib/api/dynamic.js —— 动态域：读（流/详情）+ 写（发/编辑/传图/置顶）
//
// 为什么这个模块比别的 api 模块多一层 postJson：
//   /x/dynamic/feed/create/dyn 与 /x/dynamic/feed/edit/dyn 要的是 **application/json 正文**，
//   而且 create/dyn 还要求 csrf **同时出现在 query string**（鲸鱼实现的原注释：
//   2026-10-29 实测，只把 csrf 放 JSON body → 一律 code=-111，症状很怪：图片上传成功、发布却失败）。
//   INTERFACE §5 给的 post(path, form) 只会发表单编码、只把 csrf 放正文 —— 对这两个端点不够用。
//   所以这里走 raw(url, opts) 这条逃逸口，并把 opts 传成 { method:'POST', json, query }。
//   两种客户端形状都容忍（raw 直接回 B站 响应 / raw 回 { ok, status, json }），
//   因为这一层不该假定 core/client 的实现细节；raw 完全缺失时才退回 post（那条路径会被 B站 回 -111，
//   所以降级与否都不影响「闸门先过」这个顺序）。
//
// 为什么图片必须先 upload_bfs 再发：
//   create/dyn 的正文里没有图片字段，图片是 pics:[{img_src,img_width,img_height}]，
//   img_src 只能由 /x/dynamic/feed/draw/upload_bfs 换回来。所以 uploadImage() 是独立函数，
//   让模型可以先传图、拿到 URL、再决定发不发。（上传不算 7 条写通道之一：它不产出任何公开内容。）

import { readFile } from 'node:fs/promises'

const BASE = 'https://api.bilibili.com'
const RISK_CODES = new Set([-412, -352, -799, -509, -10403])

const CODE_HUMAN = {
  '-101': '账号未登录 / cookie 已失效，去设置页重新粘贴 SESSDATA',
  '-111': 'CSRF 校验失败：bili_jct 缺失，或和 SESSDATA 不是同一个账号',
  '-400': '请求参数不对',
  '-403': '权限不足（不是自己的动态）',
  '-404': 'B站 说没有这条动态（id 写错，或被删了）',
  '-509': '请求过于频繁，等一下再来',
  '-412': '被 B站 风控拦了（IP 级限流），要等几分钟',
  '-352': '被 B站 风控拦了，要等几分钟',
  '-799': '请求被风控拦下',
  '-10403': '请求被风控拦下',
  10031: '操作太快，退避一会儿',
  4125014: '图片尺寸太小/太大（B站 拒收）：换一张正常尺寸的图（实测 256×256 可以）',
  4101152: '动态不可见：可能已删除，或对方设了仅自己可见',
  4100001: '参数错误（动态 id 形状不对）',
  500404: '这条动态已经删除过了',
  500406: '这条动态不是这个账号的'
}

function ok (data) { return { ok: true, data } }

function fail (reason, human, extra) {
  const out = { ok: false, reason, human }
  if (extra && typeof extra === 'object') {
    if (extra.code !== undefined) out.code = extra.code
    if (extra.detail !== undefined) out.detail = extra.detail
  }
  return out
}

function short (value) { return String(value === undefined || value === null ? '' : value).slice(0, 160) }
function str (value) { return value === undefined || value === null ? '' : String(value).trim() }
function num (value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback }
function flat (value) { return str(value).replace(/\s+/g, ' ').trim() }

function humanOf (code) {
  const key = String(code)
  return CODE_HUMAN[key] || ('B站 返回 code=' + key + '（这个码不在已知表里，按接口错误处理）')
}

function unwrap (response) {
  if (response === undefined || response === null || typeof response !== 'object') {
    return fail('network', '和 B站 通信失败（没有拿到响应），稍后再试')
  }
  const code = typeof response.code === 'number' ? response.code : null
  if (code === 0) return ok(response.data)
  if (code === null) {
    return fail('network', '和 B站 通信失败（响应里没有 code），稍后再试', { detail: { message: short(response.message) } })
  }
  if (RISK_CODES.has(code)) {
    return fail('risk-control', humanOf(code) + ' —— 现在不要继续发请求，等熔断过去', { code })
  }
  return fail('bili-error', humanOf(code), { code, detail: { message: short(response.message) } })
}

/**
 * 内核本地闸挡下的请求：raw 回 { ok:false, status:0, message:'写操作冷却中…' }，**没有 code**。
 * 为什么必须单独分流：把它报成 network 会让模型以为「网络抖动」→ 立刻重试 → 又撞一次闸。
 * 按 message 分两类：额度/间隔类 → quota-exceeded；熔断/风控类 → risk-control。原话保留在 human 里。
 */
const LOCAL_BLOCK = [
  { re: /冷却|预算|额度|上限|次数/, reason: 'quota-exceeded' },
  { re: /暂停|熔断|退避|风控/, reason: 'risk-control' }
]

function localBlockReason (message) {
  const text = str(message)
  if (text === '') return ''
  for (const rule of LOCAL_BLOCK) if (rule.re.test(text)) return rule.reason
  return ''
}

/** raw() 的返回可能是 B站 响应，也可能是 { ok, status, json }：两种都认，认不出再按 message 分流。 */
function unwrapRaw (out) {
  if (out === undefined || out === null || typeof out !== 'object') {
    return fail('network', '和 B站 通信失败（raw 没有返回东西），稍后再试')
  }
  if (typeof out.code === 'number') return unwrap(out)
  if (out.json !== undefined && out.json !== null && typeof out.json === 'object') return unwrap(out.json)
  if (out.data !== undefined && out.data !== null && typeof out.data === 'object' && typeof out.data.code === 'number') return unwrap(out.data)
  if (out.ok === true) return ok(out.data === undefined ? null : out.data)
  // 走到这里 = 没有 code 的失败：先看是不是内核本地闸（create / edit / setTop / uploadImage 共用这一条路径）
  const message = str(out.message)
  const blocked = localBlockReason(message)
  if (blocked !== '') {
    return fail(blocked, message + '（这是内核本地闸挡下的，不是网络问题 —— 等一会儿再发，别当作网络异常重试）', {
      detail: { status: num(out.status, 0) }
    })
  }
  return fail('network', '和 B站 通信失败（HTTP ' + str(out.status === undefined ? '?' : out.status) + '，没有拿到 JSON）' + (message === '' ? '' : '：' + message), {
    detail: { status: num(out.status, 0) }
  })
}

async function get (deps, path, query) {
  const client = deps === undefined || deps === null ? undefined : deps.client
  if (client === undefined || client === null || typeof client.get !== 'function') {
    return fail('bad-argument', '内核没装配 B站 客户端（deps.client.get 缺失），这个工具现在用不了')
  }
  try {
    return unwrap(await client.get(path, query || {}))
  } catch (error) {
    return fail('network', '和 B站 通信失败：' + short(error && error.message ? error.message : error))
  }
}

async function postJson (deps, path, body, query) {
  const client = deps === undefined || deps === null ? undefined : deps.client
  if (client === undefined || client === null) {
    return fail('bad-argument', '内核没装配 B站 客户端，写不了动态')
  }
  if (typeof client.raw === 'function') {
    try {
      return unwrapRaw(await client.raw(BASE + path, { method: 'POST', json: body, query: query || {} }))
    } catch (error) {
      return fail('network', '和 B站 通信失败：' + short(error && error.message ? error.message : error))
    }
  }
  if (typeof client.post === 'function') {
    // 降级路径：form 编码。create/dyn 走这条会被 B站 回 -111（见文件头注释），但顺序仍然正确。
    try {
      return unwrap(await client.post(path, Object.assign({}, query || {}, body || {})))
    } catch (error) {
      return fail('network', '和 B站 通信失败：' + short(error && error.message ? error.message : error))
    }
  }
  return fail('bad-argument', '客户端既没有 raw 也没有 post，动态发不出去')
}

async function postRaw (deps, url, opts) {
  const client = deps === undefined || deps === null ? undefined : deps.client
  if (client === undefined || client === null || typeof client.raw !== 'function') {
    return fail('bad-argument', '客户端没有 raw()，这个端点发不出去')
  }
  try {
    return unwrapRaw(await client.raw(url, opts || {}))
  } catch (error) {
    return fail('network', '和 B站 通信失败：' + short(error && error.message ? error.message : error))
  }
}

/* ────────────── 写通道的配额闸 ────────────── */

function gateWrite (deps, type, target) {
  const quota = deps === undefined || deps === null ? undefined : deps.quota
  if (quota === undefined || quota === null || typeof quota.gate !== 'function' || typeof quota.record !== 'function') {
    return fail('quota-exceeded', '配额闸没装配（deps.quota 缺失）—— 写操作一律拒绝，这是硬约束不是可选项')
  }
  let verdict
  try {
    verdict = quota.gate(deps.config, { type, target })
  } catch (error) {
    return fail('quota-exceeded', '配额闸检查失败：' + short(error && error.message ? error.message : error) + ' —— 写操作一律拒绝')
  }
  if (verdict === undefined || verdict === null || verdict.ok !== true) {
    // reason 是**契约字段**，必须从源头透传：token 预算用尽回 'token-budget-exhausted'，
    // 写间隔/次数类才回 'quota-exceeded'。这里若统一改写成 quota-exceeded，
    // 模型就只能看到一个笼统的「配额超了」，没法区分「等 2 分钟」和「今天别写了」。
    const reason = verdict && typeof verdict.reason === 'string' && verdict.reason !== '' ? verdict.reason : 'quota-exceeded'
    const human = verdict && verdict.human ? String(verdict.human) : '额度用完了，或离上一次写太近，等一下再来'
    const detail = verdict && verdict.detail ? verdict.detail : undefined
    return fail(reason, human, detail === undefined ? undefined : { detail })
  }
  return null
}

function recordWrite (deps, type, target, note) {
  try {
    deps.quota.record(deps.config, { type, target, note: flat(note).slice(0, 40) })
  } catch (error) {
    const log = deps === undefined || deps === null ? undefined : deps.log
    if (log && typeof log.warn === 'function') log.warn('bili: 动态已经发出，但配额记账失败：' + short(error && error.message ? error.message : error))
  }
}

/* ────────────────────────────── 归一化 ────────────────────────────── */

function picsOf (major) {
  const m = major === undefined || major === null ? {} : major
  const opus = m.opus !== undefined && m.opus !== null ? m.opus : (m.draw !== undefined && m.draw !== null ? m.draw : {})
  const pics = Array.isArray(opus.pics) ? opus.pics : []
  return pics.map((p) => {
    const pic = p === undefined || p === null ? {} : p
    return { img_src: str(pic.url !== undefined ? pic.url : pic.src), img_width: num(pic.width, 0), img_height: num(pic.height, 0) }
  }).filter((p) => p.img_src !== '')
}

function itemShape (raw) {
  const item = raw === undefined || raw === null ? {} : raw
  const modules = item.modules === undefined || item.modules === null ? {} : item.modules
  const author = modules.module_author === undefined || modules.module_author === null ? {} : modules.module_author
  const dynamic = modules.module_dynamic === undefined || modules.module_dynamic === null ? {} : modules.module_dynamic
  const major = dynamic.major === undefined || dynamic.major === null ? {} : dynamic.major
  const desc = dynamic.desc === undefined || dynamic.desc === null ? {} : dynamic.desc
  const stat = modules.module_stat === undefined || modules.module_stat === null ? {} : modules.module_stat
  const comment = stat.comment === undefined || stat.comment === null ? {} : stat.comment
  const like = stat.like === undefined || stat.like === null ? {} : stat.like
  const id = str(item.id_str !== undefined && item.id_str !== null ? item.id_str : item.id)
  return {
    dynId: id,
    url: id === '' ? '' : 'https://t.bilibili.com/' + id,
    type: str(item.type),
    author: { mid: str(author.mid), name: str(author.name) },
    pubTime: str(author.pub_time),
    text: flat(desc.text !== undefined ? desc.text : (major.opus && major.opus.summary && major.opus.summary.text) || ''),
    pics: picsOf(major),
    stat: { comment: num(comment.count, 0), like: num(like.count, 0) }
  }
}

/* ────────────────────────────── 读 ────────────────────────────── */

/**
 * 动态流。端点：GET /x/polymer/web-dynamic/v1/feed/all
 * type：all 全部 / video 视频 / article 专栏 / draw 图文
 */
export async function feed (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const allowed = ['all', 'video', 'article', 'draw']
  const type = allowed.includes(str(a.type)) ? str(a.type) : 'all'
  const page = Math.min(20, Math.max(1, Math.round(num(a.page, 1))))
  const result = await get(deps, '/x/polymer/web-dynamic/v1/feed/all', { type, page, timezone_offset: -480, features: 'itemOpusStyle' })
  if (result.ok !== true) return result
  const data = result.data === undefined || result.data === null ? {} : result.data
  const items = Array.isArray(data.items) ? data.items : []
  return ok({
    type,
    page,
    count: items.length,
    hasMore: data.has_more === true,
    items: items.map(itemShape).filter((item) => item.dynId !== '')
  })
}

/** 动态详情。端点：GET /x/polymer/web-dynamic/v1/detail */
export async function detail (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const dynId = str(a.dynId)
  if (dynId === '') return fail('bad-argument', '要给 dynId（动态 id，纯数字串）')
  const result = await get(deps, '/x/polymer/web-dynamic/v1/detail', { id: dynId, features: 'itemOpusStyle' })
  if (result.ok !== true) return result
  const data = result.data === undefined || result.data === null ? {} : result.data
  const item = data.item === undefined || data.item === null ? null : itemShape(data.item)
  return ok({ dynId, item })
}

/* ────────────────────────────── 写 ────────────────────────────── */

/**
 * 发一条动态。端点：POST /x/dynamic/feed/create/dyn
 * 正文上限 1000 字（B站 硬限）；带图时 scene=2，纯文字 scene=1。
 */
export async function create (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const text = str(a.text)
  if (text === '') return fail('bad-argument', '要给 text：空动态发不出去')
  if (text.length > 1000) return fail('bad-argument', '动态正文 ' + text.length + ' 字，超过 B站 上限 1000')

  // 闸门放在上传之前：额度不够时连图都不该传上去（传了就是一次白打的写请求）
  const target = 'dynamic'
  const blocked = gateWrite(deps, 'dynamic', target)
  if (blocked !== null) return blocked

  // images 允许两种形态：已经传好的 [{img_src,img_width,img_height}]，或本地图片路径（这里替你传）
  let pics = []
  const rawImages = Array.isArray(a.images) ? a.images : []
  if (rawImages.length > 9) return fail('bad-argument', '一条动态最多 9 张图，这次给了 ' + rawImages.length + ' 张')
  for (const entry of rawImages) {
    if (entry !== undefined && entry !== null && typeof entry === 'object' && str(entry.img_src) !== '') {
      pics.push({ img_src: str(entry.img_src), img_width: num(entry.img_width, 0), img_height: num(entry.img_height, 0) })
      continue
    }
    const path = str(entry)
    if (path === '') continue
    const uploaded = await uploadImage(deps, { path })
    if (uploaded.ok !== true) return uploaded
    pics.push(uploaded.data.pic)
  }

  const body = {
    dyn_req: {
      content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] },
      scene: pics.length > 0 ? 2 : 1,
      ...(pics.length > 0 ? { pics } : {}),
      meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } }
    }
  }
  const result = await postJson(deps, '/x/dynamic/feed/create/dyn', body, {})
  if (result.ok !== true) return result
  const data = result.data === undefined || result.data === null ? {} : result.data
  const dynId = str(data.dyn_id_str !== undefined && data.dyn_id_str !== null ? data.dyn_id_str : data.dyn_id)
  recordWrite(deps, 'dynamic', 'dynamic:' + dynId, text)
  return ok({ dynId, url: dynId === '' ? '' : 'https://t.bilibili.com/' + dynId, text, pics: pics.length })
}

/**
 * 编辑一条已存在的动态。端点：POST /x/dynamic/feed/edit/dyn
 * 先读一次 detail 把当前图片原样带上 —— 不带就等于把图删了（编辑是全量覆盖）。
 */
export async function edit (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const dynId = str(a.dynId)
  const text = str(a.text)
  if (dynId === '') return fail('bad-argument', '要给 dynId')
  if (text === '') return fail('bad-argument', '要给 text：编辑成空正文会失败')
  if (text.length > 1000) return fail('bad-argument', '动态正文 ' + text.length + ' 字，超过 B站 上限 1000')

  const current = await detail(deps, { dynId })
  if (current.ok !== true) return current
  const pics = current.data.item !== null && current.data.item !== undefined ? current.data.item.pics : []

  const blocked = gateWrite(deps, 'dynamic_edit', 'dynamic:' + dynId)
  if (blocked !== null) return blocked

  const body = {
    dyn_id_str: dynId,
    dyn_req: {
      scene: pics.length > 0 ? 2 : 1,
      content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] },
      ...(pics.length > 0 ? { pics } : {}),
      meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } }
    }
  }
  const result = await postJson(deps, '/x/dynamic/feed/edit/dyn', body, { platform: 'web' })
  if (result.ok !== true) return result
  recordWrite(deps, 'dynamic_edit', 'dynamic:' + dynId, text)
  return ok({ dynId, url: 'https://t.bilibili.com/' + dynId, text, pics: pics.length })
}

/**
 * 上传一张图到 B站 的 CDN，换回 pics 需要的 { img_src, img_width, img_height }。
 * 端点：POST /x/dynamic/feed/draw/upload_bfs（multipart，字段名 file_up + category）
 * 不占写额度：它不产出公开内容，真正占额度的是 create/edit。
 */
export async function uploadImage (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const path = str(a.path)
  if (path === '') return fail('bad-argument', '要给 path（本地图片的绝对路径）')
  let buffer
  try {
    buffer = await readFile(path)
  } catch (error) {
    return fail('bad-argument', '读不到这张图：' + short(error && error.message ? error.message : error))
  }
  if (typeof FormData !== 'function' || typeof Blob !== 'function') {
    return fail('bili-error', '这个 Node 运行时没有 FormData/Blob（需要 Node 20+），传图用不了')
  }
  const form = new FormData()
  const name = path.split(/[\\/]/).pop() || 'image.png'
  form.append('file_up', new Blob([buffer], { type: 'image/png' }), name)
  form.append('category', 'daily')
  const result = await postRaw(deps, BASE + '/x/dynamic/feed/draw/upload_bfs', { method: 'POST', form })
  if (result.ok !== true) return result
  const data = result.data === undefined || result.data === null ? {} : result.data
  const pic = { img_src: str(data.image_url), img_width: num(data.image_width, 0), img_height: num(data.image_height, 0) }
  if (pic.img_src === '') return fail('bili-error', 'B站 说上传成功，但没回图片地址（image_url 为空）')
  return ok({ path, pic })
}

/**
 * 置顶 / 取消置顶动态。
 * 端点：POST /x/dynamic/feed/space/set_top（置顶）或 /x/dynamic/feed/space/rm_top（取消），正文 JSON，csrf 在 query
 * INTERFACE §13.1 把它定成写通道（gate type='dynamic'）。
 */
export async function setTop (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const dynId = str(a.dynId)
  if (dynId === '') return fail('bad-argument', '要给 dynId')
  const unpin = str(a.action) === 'unpin'
  const target = 'dynamic:' + dynId
  const blocked = gateWrite(deps, 'dynamic', target)
  if (blocked !== null) return blocked
  const path = unpin ? '/x/dynamic/feed/space/rm_top' : '/x/dynamic/feed/space/set_top'
  const result = await postJson(deps, path, { dyn_str: dynId }, {})
  if (result.ok !== true) return result
  recordWrite(deps, 'dynamic', target, (unpin ? 'unpin ' : 'pin ') + dynId)
  return ok({ dynId, top: !unpin, action: unpin ? 'unpin' : 'pin' })
}
