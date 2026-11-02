// lib/api/comment.js —— 评论区：读（主楼/楼中楼）+ 写（发/回复/删/置顶）
//
// 为什么「发评论」和「回复评论」是两个函数，但端点其实只有一个（/x/v2/reply/add）：
//   坐标不一样。顶层评论只带 type+oid；回复必须同时带 root（楼层根）+ parent（要回的那条）。
//   合成一个函数就需要一堆「给了 A 没给 B」的分支，调用方迟早传半套参数进来。
//   拆开后，reply() 的 root/rpid 是必填，缺了就在这里拒掉，不会发出半条评论。
//
// 为什么回复不用 /x/v2/reply/reply 发：那个端点是**读**楼中楼的。
//   写回复走的是 reply/add 带 root+parent（PROMPT §2 的写清单里也只有 reply/add 这一条写）。
//
// 真机结论（2026-11-01）：/x/v2/reply/add **必须做 WBI 签名** —— 把 w_rid/wts 加到 URL query，
//   body 照旧 urlencoded。不签名的 add 会被回 code=-412「风控拦截」，而同一凭据同一时段
//   动态/私信/点赞/收藏都成功 —— 所以 -412 在这里的含义是「这次请求没签名」，
//   不是「账号被限流」，也不是 -111（csrf）或 -400（参数）。del / top 不签名（既有真机实现同样如此）。
//
// 为什么 @主人 是「拼前缀」而不是 at_name_to_mid 字段：
//   PROMPT §6.3 要的是「评论时能 @ 到主人」。issue #26 提出的 at_name_to_mid 在真机上
//   并不是收得到的必要条件 —— 主人实测纯文本 @ 每次都收得到（鲸鱼实现里的原注释：
//   2026-10-23 实测纯文本 @ 一次都没丢）。多传一个未验证字段只会多一个失败面。
//
// 写通道硬约束（INTERFACE §8）：comment.add 与 comment.reply 必须先过 deps.quota.gate，
//   发成功才 record。del / top 不在那 7 条写通道里（它们是撤回/管理自己的评论，不占发言额度）。

const RISK_CODES = new Set([-412, -352, -799, -509, -10403])

/** 评论接口的码表（docs/comment-add.md 的官方表 + PROMPT §7 的翻译）。 */
const CODE_HUMAN = {
  '-101': '账号未登录 / cookie 已失效，去设置页重新粘贴 SESSDATA',
  '-102': '账号被封停，写不了',
  '-111': 'CSRF 校验失败：bili_jct 缺失，或和 SESSDATA 不是同一个账号',
  '-400': '请求参数不对',
  '-403': '权限不足（不是自己的评论，或没有管理权）',
  '-404': 'B站 说没有这个评论主体（oid/type 写错，或被删了）',
  '-509': '请求过于频繁，等一下再来',
  '-412': '被 B站 风控拦了（IP 级限流），要等几分钟',
  '-352': '被 B站 风控拦了，要等几分钟',
  '-799': '请求被风控拦下',
  '-10403': '请求被风控拦下',
  10031: '操作太快，退避一会儿',
  12001: '这个评论区已经有同一主题的评论了',
  12002: '评论区已关闭',
  12003: '禁止回复',
  12006: '没有该评论（可能已经被删了）',
  12009: '评论主体 type 不合法（视频是 1，动态常见 11 或 17）',
  12015: '需要评论验证码：去浏览器手动过一次，别继续硬发',
  12016: '内容含敏感信息，被拒',
  12022: '这条评论已经被删除了',
  12025: '评论字数超过上限（1000 字）',
  12029: '已经有置顶评论了，先取消旧的',
  12030: '只能置顶一级评论',
  12035: '这个账号被 UP 主列入评论黑名单',
  12051: '重复评论被判刷屏，停手',
  12052: '评论区已关闭'
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

/**
 * opts 会原样交给 client.post 的第三参（目前只有 { wbi: true } 一种用法）。
 * 为什么要这个参数：/x/v2/reply/add 必须对**整份表单**做 WBI 签名（w_rid + wts 加在 URL query 上），
 * 不签名的 add 在真机上被回 -412 风控拦截 —— 而 -412 看起来像「账号被限流」，
 * 其实只是这次请求没签名，别顺手去改参数或停手。
 */
async function post (deps, path, form, opts) {
  const client = deps === undefined || deps === null ? undefined : deps.client
  if (client === undefined || client === null || typeof client.post !== 'function') {
    return fail('bad-argument', '内核没装配 B站 客户端（deps.client.post 缺失），写不了评论')
  }
  try {
    return unwrap(await client.post(path, form || {}, opts === undefined || opts === null ? {} : opts))
  } catch (error) {
    return fail('network', '和 B站 通信失败：' + short(error && error.message ? error.message : error))
  }
}

/* ────────────── 写通道的配额闸（7 条里这里占 2 条） ────────────── */

/**
 * 闸门缺失也按「拒绝」处理：deps.quota 缺失时放行，等于把「漏挂一条写通道」变成默认行为，
 * 而那正是旧实现踩过的最贵的坑（PROMPT §6.1）。所以失败方向必须朝「不发」。
 */
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

/** 发成功才记账；记账本身失败不能把「已经发出去」说成失败（那会让模型重发一条）。 */
function recordWrite (deps, type, target, note) {
  try {
    deps.quota.record(deps.config, { type, target, note: flat(note).slice(0, 40) })
  } catch (error) {
    const log = deps === undefined || deps === null ? undefined : deps.log
    if (log && typeof log.warn === 'function') log.warn('bili: 写入已经成功，但配额记账失败：' + short(error && error.message ? error.message : error))
  }
}

/**
 * @主人：B站 评论区认的是纯文本 @昵称。
 * 已经在正文里出现过这个昵称就不再补 —— 补两次会变成「@主人 @主人」这种刷屏形状。
 */
function withOwnerAt (text, owner) {
  const name = str(owner && owner.name)
  if (name === '') return text
  const want = '@' + name
  if (text.includes(want)) return text
  return want + ' ' + text
}

function ownerOf (deps) {
  if (deps === undefined || deps === null) return {}
  if (deps.owner && (deps.owner.mid !== undefined || deps.owner.name !== undefined)) return deps.owner
  const fromConfig = deps.config && deps.config.owner ? deps.config.owner : null
  return fromConfig === null ? {} : fromConfig
}

/* ────────────────────────────── 读 ────────────────────────────── */

/** 一条评论的形状（主楼与楼中楼共用）。 */
function replyShape (raw) {
  const r = raw === undefined || raw === null ? {} : raw
  const member = r.member === undefined || r.member === null ? {} : r.member
  const content = r.content === undefined || r.content === null ? {} : r.content
  const out = {
    rpid: str(r.rpid_str !== undefined && r.rpid_str !== null ? r.rpid_str : r.rpid),
    mid: str(member.mid !== undefined ? member.mid : r.mid),
    user: str(member.uname),
    like: num(r.like, 0),
    replyCount: num(r.rcount, 0),
    time: iso(r.ctime),
    text: flat(content.message)
  }
  if (r.root !== undefined && r.root !== null) out.root = str(r.root_str !== undefined && r.root_str !== null ? r.root_str : r.root)
  if (r.parent !== undefined && r.parent !== null) out.parent = str(r.parent_str !== undefined && r.parent_str !== null ? r.parent_str : r.parent)
  if (Array.isArray(r.replies)) out.replies = r.replies.map(replyShape)
  return out
}

/**
 * 评论主楼。
 * 端点：GET /x/v2/reply（type=1 视频 / 11、17 动态；sort=2 热度序、0 时间序）
 * 注意 oid 必须是 **aid**（不是 BV）：所以调用方要么给 aid，要么先走 video.info 换一次。
 */
export async function list (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const oid = str(a.oid)
  if (oid === '') return fail('bad-argument', '要给 oid（视频是 aid，不是 BV 号）')
  const type = Math.round(num(a.type, 1))
  const page = Math.min(50, Math.max(1, Math.round(num(a.page, 1))))
  const ps = Math.min(50, Math.max(1, Math.round(num(a.ps, 20))))
  const sort = str(a.sort) === 'time' ? 0 : 2
  const result = await get(deps, '/x/v2/reply', { type, oid, sort, ps, pn: page })
  if (result.ok !== true) return result
  const data = result.data === undefined || result.data === null ? {} : result.data
  const pageInfo = data.page === undefined || data.page === null ? {} : data.page
  const withReplies = a.withReplies !== false
  const top = []
  if (Array.isArray(data.top)) for (const item of data.top) top.push(replyShape(item))
  if (data.upper && data.upper.top) top.push(replyShape(data.upper.top))
  const rows = Array.isArray(data.replies) ? data.replies : []
  const items = []
  const seen = new Set()
  for (const item of [...top, ...rows]) {
    const shaped = replyShape(item)
    if (shaped.rpid !== '' && seen.has(shaped.rpid)) continue
    if (shaped.rpid !== '') seen.add(shaped.rpid)
    // withReplies=false 时砍掉楼中楼，但保留条数（模型据此决定要不要再拉一次 replies）
    if (!withReplies && shaped.replies !== undefined) delete shaped.replies
    items.push(shaped)
  }
  return ok({
    oid,
    type,
    page,
    sort: sort === 2 ? 'hot' : 'time',
    total: num(pageInfo.count, items.length),
    count: items.length,
    items
  })
}

/** 楼中楼。端点：GET /x/v2/reply/reply（root = 楼层根评论 rpid） */
export async function replies (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const oid = str(a.oid)
  const root = str(a.root)
  if (oid === '' || root === '') return fail('bad-argument', '要给 oid 和 root（root 是楼层根评论的 rpid）')
  const type = Math.round(num(a.type, 1))
  const page = Math.min(50, Math.max(1, Math.round(num(a.page, 1))))
  const result = await get(deps, '/x/v2/reply/reply', { type, oid, root, pn: page, ps: 20 })
  if (result.ok !== true) return result
  const data = result.data === undefined || result.data === null ? {} : result.data
  const rows = Array.isArray(data.replies) ? data.replies : []
  return ok({
    oid,
    root,
    page,
    count: rows.length,
    rootComment: data.root ? replyShape(data.root) : null,
    items: rows.map(replyShape)
  })
}

/* ────────────────────────────── 写 ────────────────────────────── */

/** 发一条顶层评论。端点：POST /x/v2/reply/add（csrf 由 client.post 自动补） */
export async function add (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const oid = str(a.oid)
  if (oid === '') return fail('bad-argument', '要给 oid（视频是 aid，不是 BV 号）')
  const raw = str(a.message)
  if (raw === '') return fail('bad-argument', '要给 message：空评论发不出去')
  const type = Math.round(num(a.type, 1))
  const message = a.atOwner === true ? withOwnerAt(raw, ownerOf(deps)) : raw
  if (message.length > 1000) return fail('bad-argument', '评论正文 ' + message.length + ' 字，超过 B站 上限 1000')
  const target = 'oid:' + oid
  const blocked = gateWrite(deps, 'comment', target)
  if (blocked !== null) return blocked
  // { wbi: true }：reply/add 必须签名（不签名真机回 -412 风控拦截，不是 -111/-400）
  const result = await post(deps, '/x/v2/reply/add', { type, oid, message, plat: 1 }, { wbi: true })
  if (result.ok !== true) return result
  recordWrite(deps, 'comment', target, message)
  const data = result.data === undefined || result.data === null ? {} : result.data
  const rpid = str(data.rpid_str !== undefined && data.rpid_str !== null ? data.rpid_str : data.rpid)
  return ok({
    rpid,
    oid,
    type,
    atOwner: a.atOwner === true,
    message,
    url: 'https://www.bilibili.com/video/av' + oid + '#reply' + rpid,
    toast: str(data.success_toast)
  })
}

/** 回复楼里的一条评论。端点：POST /x/v2/reply/add（带 root + parent） */
export async function reply (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const oid = str(a.oid)
  const root = str(a.root)
  const rpid = str(a.rpid)
  if (oid === '') return fail('bad-argument', '要给 oid（视频是 aid，不是 BV 号）')
  if (root === '' || rpid === '') {
    return fail('bad-argument', '回复必须同时给 root（楼层根 rpid）和 rpid（要回的那条）—— 少一个就会发成顶层评论')
  }
  const raw = str(a.message)
  if (raw === '') return fail('bad-argument', '要给 message：空回复发不出去')
  const type = Math.round(num(a.type, 1))
  const message = a.atOwner === true ? withOwnerAt(raw, ownerOf(deps)) : raw
  if (message.length > 1000) return fail('bad-argument', '回复正文 ' + message.length + ' 字，超过 B站 上限 1000')
  const target = 'oid:' + oid
  const blocked = gateWrite(deps, 'reply', target)
  if (blocked !== null) return blocked
  // 回复走的是同一个 reply/add，签名要求一致
  const result = await post(deps, '/x/v2/reply/add', { type, oid, root, parent: rpid, message, plat: 1 }, { wbi: true })
  if (result.ok !== true) return result
  recordWrite(deps, 'reply', target, message)
  const data = result.data === undefined || result.data === null ? {} : result.data
  const newRpid = str(data.rpid_str !== undefined && data.rpid_str !== null ? data.rpid_str : data.rpid)
  return ok({
    rpid: newRpid,
    oid,
    type,
    root,
    parent: rpid,
    atOwner: a.atOwner === true,
    message,
    url: 'https://www.bilibili.com/video/av' + oid + '#reply' + newRpid
  })
}

/** 删自己发的一条评论。端点：POST /x/v2/reply/del（只能删自己的 / 自己管理下的） */
export async function del (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const oid = str(a.oid)
  const rpid = str(a.rpid)
  if (oid === '' || rpid === '') return fail('bad-argument', '要给 oid 和 rpid')
  const type = Math.round(num(a.type, 1))
  const result = await post(deps, '/x/v2/reply/del', { type, oid, rpid })
  if (result.ok !== true) return result
  return ok({ oid, rpid, type, deleted: true })
}

/**
 * 置顶 / 取消置顶。端点：POST /x/v2/reply/top（action 1 置顶，0 取消）
 * INTERFACE §13.1 把它定成写通道（gate type='comment'）：置顶会把一条评论钉到所有人眼前，
 * 是公开动作，所以要占 token 预算与写间隔。
 */
export async function top (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const oid = str(a.oid)
  const rpid = str(a.rpid)
  if (oid === '' || rpid === '') return fail('bad-argument', '要给 oid 和 rpid')
  const type = Math.round(num(a.type, 1))
  const action = str(a.action) === 'unset' || str(a.action) === 'unpin' || a.action === 0 || a.action === '0' ? 0 : 1
  const target = 'oid:' + oid
  const blocked = gateWrite(deps, 'comment', target)
  if (blocked !== null) return blocked
  const result = await post(deps, '/x/v2/reply/top', { type, oid, rpid, action })
  if (result.ok !== true) return result
  recordWrite(deps, 'comment', target, 'top ' + rpid + ' ' + (action === 1 ? 'pin' : 'unpin'))
  return ok({ oid, rpid, type, action: action === 1 ? 'set' : 'unset' })
}
