// lib/api/user.js —— 用户信息（只读，但**必须 WBI 签名**）
//
// 为什么这个读端点要单独一个文件、还要显式传 opts：
//   /x/space/wbi/acc/info 属于 B站 的 wbi 系列：不带 w_rid/wts 会被直接拦掉，
//   返回的不是数据而是风控码 —— 看起来像「没权限」，其实是「没签名」。
//   而 client.get 的签名是**按需开启**的（opts.wbi === true），所以这一层必须显式传，
//   不能指望客户端自己猜哪个端点要签名。
//
// 为什么粉丝数/关注数要另打一次 /x/relation/stat：
//   acc/info 里**没有**这两个数（只有等级、签名、头像、昵称）。硬塞一个 0 进去就等于编数据，
//   所以这里再 best-effort 取一次 relation/stat：取不到就**省略这两个字段**，
//   让模型看到「没有」而不是看到一个假 0。

const RISK_CODES = new Set([-412, -352, -799, -509, -10403])

const CODE_HUMAN = {
  '-101': '账号未登录 / cookie 已失效，去设置页重新粘贴 SESSDATA',
  '-111': 'CSRF 校验失败：bili_jct 缺失，或和 SESSDATA 不是同一个账号',
  '-400': '请求参数不对（mid 写错？）',
  '-404': 'B站 说没有这个用户',
  '-509': '请求过于频繁，等一下再来',
  '-412': '被 B站 风控拦了（IP 级限流），要等几分钟',
  '-352': '被 B站 风控拦了，要等几分钟',
  '-799': '请求被风控拦下',
  '-10403': '请求被风控拦下',
  10031: '操作太快，退避一会儿',
  '-626': '这个账号不存在（或已注销）'
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

async function get (deps, path, query, opts) {
  const client = deps === undefined || deps === null ? undefined : deps.client
  if (client === undefined || client === null || typeof client.get !== 'function') {
    return fail('bad-argument', '内核没装配 B站 客户端（deps.client.get 缺失），这个工具现在用不了')
  }
  try {
    return unwrap(await client.get(path, query || {}, opts === undefined || opts === null ? {} : opts))
  } catch (error) {
    return fail('network', '和 B站 通信失败：' + short(error && error.message ? error.message : error))
  }
}

/**
 * 用户信息。
 * 端点：GET /x/space/wbi/acc/info（**必须** opts.wbi=true）+ 可选 GET /x/relation/stat
 * 返回只放真拿到的字段：缺 fans / following 就整段省略，不补 0。
 */
export async function info (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const mid = str(a.mid)
  if (mid === '') return fail('bad-argument', '要给 mid（用户的 UID，纯数字）')
  if (!/^[0-9]+$/.test(mid)) return fail('bad-argument', 'mid 必须是纯数字串（用户的 UID）：' + mid)

  const profile = await get(deps, '/x/space/wbi/acc/info', { mid }, { wbi: true })
  if (profile.ok !== true) return profile
  const d = profile.data === undefined || profile.data === null ? {} : profile.data

  const out = {
    mid: str(d.mid) || mid,
    name: str(d.name !== undefined ? d.name : d.uname),
    face: str(d.face),
    sign: str(d.sign),
    level: num(d.level, 0),
    url: 'https://space.bilibili.com/' + (str(d.mid) || mid)
  }
  if (d.sex !== undefined) out.sex = str(d.sex)

  // 粉丝/关注：acc/info 没有这两个数，best-effort 再取一次；失败就省略（不编 0）
  // ⚠️ 这个端点认的参数是 **vmid**，不是 fid（2026-11-01 真机：传 fid 会被回 -400「请求参数不对」，
  //    而 /x/relation 才是 fid）。两个近似端点参数名不通用，别照抄。
  const stat = await get(deps, '/x/relation/stat', { vmid: mid })
  if (stat.ok === true && stat.data !== undefined && stat.data !== null) {
    // 字段口径：follower = 粉丝数，following = TA 关注的人数（别认反）
    const s = stat.data
    if (s.follower !== undefined) out.fans = num(s.follower, 0)
    if (s.following !== undefined) out.following = num(s.following, 0)
  } else {
    out.statNote = '粉丝数/关注数没取到（' + short(stat.human || stat.reason) + '）—— 不是 0，是没读到'
  }
  return ok(out)
}
