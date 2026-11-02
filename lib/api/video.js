// lib/api/video.js —— 视频域：五个读端点 + 统一归一化
//
// 为什么归一化放在 api 层，而不是让 15 个工具各自挑字段：
//   B站 同一条视频在 popular / ranking / search / view 四个端点里的字段名与层级都不一样
//   （popular 的 list 项是 view 的裁剪版；search 的 title 里还焊着 <em class="keyword"> 高亮标签）。
//   工具层各挑一次，同一条视频在两个工具里就是两种形状，模型每次都得重新猜字段。
//   所以出口只认一种形状，工具层只负责「挑参数 + 拼人话」。
//
// 为什么每个函数都不抛异常：
//   INTERFACE §2 定的是「正常失败不抛异常」，宿主拿到的是 { ok:false, reason, human }。
//   一个 fetch 栈冒到模型面前，等于把「被风控拦了」说成「工具崩了」—— 模型会去重试，正好踩中 412。
//   所以三类失败（网络 / 风控码 / 普通接口码）都在 get() 里分流成人话。
//
// 为什么风险码单独一类：http 412 是 IP 级限流，换接口救不了（PROMPT §1.3）。
//   把它标成 risk-control，工具层才能告诉模型「现在别再发请求」，而不是「参数写错了」。

/** 风控码：撞上这些不是参数问题，是账号/IP 被限流，继续打只会更久。 */
const RISK_CODES = new Set([-412, -352, -799, -509, -10403])

/** B站 码 → 人话。只收这个域真会遇到的码，不做穷举（穷举表一定会过期）。 */
const CODE_HUMAN = {
  '-101': '账号未登录 / cookie 已失效，去设置页重新粘贴 SESSDATA',
  '-111': 'CSRF 校验失败：bili_jct 缺失，或和 SESSDATA 不是同一个账号',
  '-400': '请求参数不对',
  '-404': 'B站 说没有这个内容（bvid/aid 写错，或被删了）',
  '-509': '请求过于频繁，等一下再来',
  '-412': '被 B站 风控拦了（IP 级限流），要等几分钟',
  '-352': '被 B站 风控拦了，要等几分钟',
  '-799': '请求被风控拦下',
  '-10403': '请求被风控拦下',
  10031: '操作太快，退避一会儿',
  12015: '需要验证码：去浏览器手动过一次'
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
function iso (seconds) { const n = Number(seconds); return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : '' }
function stripTags (value) { return str(value).replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&') }

function humanOf (code) {
  const key = String(code)
  return CODE_HUMAN[key] || ('B站 返回 code=' + key + '（这个码不在已知表里，按接口错误处理）')
}

/** B站 响应 → 统一形状。所有读端点共用，写通道也复用（收藏/关注这类写接口同样回 code）。 */
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

/** 唯一的出口：客户端缺失 / 抛异常 / 返回风控码，都在这里变成结构化失败。 */
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

/** 一条视频的详情形状（view）。 */
function videoShape (data) {
  const d = data === undefined || data === null || typeof data !== 'object' ? {} : data
  const owner = d.owner === undefined || d.owner === null ? {} : d.owner
  const stat = d.stat === undefined || d.stat === null ? {} : d.stat
  const bvid = str(d.bvid)
  return {
    bvid,
    aid: num(d.aid, 0),
    title: str(d.title),
    desc: str(d.desc).slice(0, 800),
    tname: str(d.tname),
    duration: num(d.duration, 0),
    cover: str(d.pic),
    pubdate: iso(d.pubdate),
    url: bvid ? 'https://www.bilibili.com/video/' + bvid : '',
    owner: { mid: str(owner.mid), name: str(owner.name) },
    stat: {
      view: num(stat.view, 0),
      danmaku: num(stat.danmaku, 0),
      reply: num(stat.reply, 0),
      favorite: num(stat.favorite, 0),
      coin: num(stat.coin, 0),
      like: num(stat.like, 0),
      share: num(stat.share, 0)
    },
    pages: Array.isArray(d.pages)
      ? d.pages.map((page) => {
        const p = page === undefined || page === null ? {} : page
        return { cid: num(p.cid, 0), page: num(p.page, 0), part: str(p.part), duration: num(p.duration, 0) }
      })
      : []
  }
}

/** 列表项形状（popular / ranking / feed 共用）。 */
function briefShape (data) {
  const d = data === undefined || data === null || typeof data !== 'object' ? {} : data
  const owner = d.owner === undefined || d.owner === null ? {} : d.owner
  const stat = d.stat === undefined || d.stat === null ? {} : d.stat
  const bvid = str(d.bvid)
  return {
    bvid,
    aid: num(d.aid, 0),
    title: stripTags(d.title),
    cover: str(d.pic),
    duration: num(d.duration, 0),
    pubdate: iso(d.pubdate),
    url: bvid ? 'https://www.bilibili.com/video/' + bvid : '',
    owner: { mid: str(owner.mid), name: str(owner.name) },
    stat: {
      view: num(stat.view ?? d.play, 0),
      danmaku: num(stat.danmaku ?? d.video_review, 0),
      reply: num(stat.reply, 0),
      like: num(stat.like, 0),
      coin: num(stat.coin, 0),
      favorite: num(stat.favorite ?? d.favorites, 0),
      share: num(stat.share, 0)
    }
  }
}

/**
 * 视频详情。
 * 端点：GET /x/web-interface/view（需 WBI 签名 —— 由 core/client 负责，这一层不碰签名）
 */
export async function info (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const bvid = str(a.bvid)
  const aid = str(a.aid)
  if (bvid === '' && aid === '') {
    return fail('bad-argument', '要给 bvid 或 aid 之一：只有其中一样才能定位一条视频')
  }
  if (bvid !== '' && !/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
    return fail('bad-argument', 'bvid 形状不对（应当是 BV + 10 位字母数字，例如 BV1GJ411x7h7）：' + bvid)
  }
  const result = await get(deps, '/x/web-interface/view', bvid !== '' ? { bvid } : { aid })
  return result.ok === true ? ok(videoShape(result.data)) : result
}

/** 综合热门。端点：GET /x/web-interface/popular */
export async function popular (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const ps = Math.min(50, Math.max(1, Math.round(num(a.ps, 20))))
  const pn = Math.max(1, Math.round(num(a.pn, 1)))
  const result = await get(deps, '/x/web-interface/popular', { ps, pn })
  if (result.ok !== true) return result
  const list = Array.isArray(result.data && result.data.list) ? result.data.list : []
  return ok({ ps, pn, count: list.length, items: list.map(briefShape) })
}

/** 分区排行。端点：GET /x/web-interface/ranking/v2（rid=0 为全站） */
export async function ranking (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const rid = Math.max(0, Math.round(num(a.rid, 0)))
  const type = str(a.type) === 'origin' ? 'origin' : 'all'
  const result = await get(deps, '/x/web-interface/ranking/v2', { rid, type })
  if (result.ok !== true) return result
  const list = Array.isArray(result.data && result.data.list) ? result.data.list : []
  return ok({ rid, type, count: list.length, items: list.map(briefShape) })
}

/**
 * 搜索。端点：GET /x/web-interface/wbi/search/type（需 WBI 签名）
 * order：totalrank 综合 / click 播放 / pubdate 最新 / dm 弹幕 / stow 收藏
 */
export async function search (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const keyword = str(a.keyword)
  if (keyword === '') return fail('bad-argument', '要给 keyword（搜什么）')
  const allowed = ['video', 'media_bangumi', 'bili_user']
  const searchType = allowed.includes(str(a.type)) ? str(a.type) : 'video'
  const page = Math.min(50, Math.max(1, Math.round(num(a.page, 1))))
  const orders = ['totalrank', 'click', 'pubdate', 'dm', 'stow']
  const order = orders.includes(str(a.order)) ? str(a.order) : 'totalrank'
  const result = await get(deps, '/x/web-interface/wbi/search/type', { search_type: searchType, keyword, page, order })
  if (result.ok !== true) return result
  const data = result.data === undefined || result.data === null ? {} : result.data
  const list = Array.isArray(data.result) ? data.result : (Array.isArray(data.results) ? data.results : [])
  const items = list.map((raw) => {
    const item = raw === undefined || raw === null ? {} : raw
    const base = briefShape({
      bvid: item.bvid,
      aid: item.aid,
      title: item.title,
      pic: item.pic,
      duration: 0,
      pubdate: item.pubdate,
      owner: { mid: item.mid, name: item.author },
      play: item.play,
      video_review: item.video_review,
      favorites: item.favorites
    })
    base.durationText = str(item.duration)
    base.description = stripTags(item.description).slice(0, 200)
    base.tag = stripTags(item.tag).slice(0, 120)
    return base
  })
  return ok({ keyword, type: searchType, page, order, count: items.length, items })
}

/**
 * 播放地址。端点：GET /x/player/wbi/playurl（PROMPT §2：必须走 wbi 版）
 * 不给 cid 时先查一次 view 拿分 P 第一段的 cid —— 这是 B站 的硬要求，猜不出来。
 */
export async function playurl (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const bvid = str(a.bvid)
  if (bvid === '') return fail('bad-argument', '要给 bvid：播放地址是按视频 + 分 P 取')
  let cid = Math.max(0, Math.round(num(a.cid, 0)))
  if (cid === 0) {
    const detail = await info(deps, { bvid })
    if (detail.ok !== true) return detail
    const pages = detail.data.pages
    cid = pages.length > 0 ? pages[0].cid : 0
    if (cid === 0) return fail('bili-error', '这条视频没有分 P 信息，拿不到 cid：请显式传 cid')
  }
  const qn = Math.max(1, Math.round(num(a.qn, 80)))
  const result = await get(deps, '/x/player/wbi/playurl', { bvid, cid, qn, fnval: 0, fourk: 1 })
  if (result.ok !== true) return result
  const data = result.data === undefined || result.data === null ? {} : result.data
  const durl = Array.isArray(data.durl) ? data.durl : []
  const dash = data.dash === undefined || data.dash === null ? null : data.dash
  return ok({
    bvid,
    cid,
    quality: num(data.quality, 0),
    acceptQuality: Array.isArray(data.accept_quality) ? data.accept_quality : [],
    acceptDescription: Array.isArray(data.accept_description) ? data.accept_description : [],
    urls: durl.map((part) => {
      const p = part === undefined || part === null ? {} : part
      return { order: num(p.order, 0), length: num(p.length, 0), size: num(p.size, 0), url: str(p.url) }
    }),
    dash: dash === null
      ? null
      : {
        video: Array.isArray(dash.video) ? dash.video.map((v) => ({ id: num(v && v.id, 0), bandwidth: num(v && v.bandwidth, 0), url: str(v && v.baseUrl) })) : [],
        audio: Array.isArray(dash.audio) ? dash.audio.map((v) => ({ id: num(v && v.id, 0), bandwidth: num(v && v.bandwidth, 0), url: str(v && v.baseUrl) })) : []
      }
  })
}
