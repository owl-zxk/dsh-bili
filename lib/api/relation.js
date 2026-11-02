// lib/api/relation.js —— 关注关系 + 点赞
//
// 为什么 like() 只认 bvid，不认「任意点赞目标」：
//   INTERFACE §8 把它定成 { bvid, action } —— 点赞是公开动作（会推给粉丝动态），
//   是 7 条写通道之一。把目标限定在视频，等于把这条通道的爆炸半径钉死在一种内容上。
//
// 点赞端点的事实状态（真机实测，2026-11-01）：
//   /x/web-interface/archive/like 认 **aid**（不是 BV 号）+ like，**like=1 点赞已在真机验证通过**。
//   取消点赞是 like=2 —— 文档（bilibili-API-collect docs/video/action.md）明写「1：点赞 / 2：取消赞」，
//   发 like=0 会被回 -400「请求参数不对」（2026-11-01 真机抓到的就是这个）。unlike 分支改完后待真机复验。
//   另一个坑：Cookie 里的 buvid3 必须存在且正常，否则这个端点更容易触发风控 ——
//   凭据缺 buvid3 时先去设置页补齐，不要把风控码当成参数错。

const RISK_CODES = new Set([-412, -352, -799, -509, -10403])

const CODE_HUMAN = {
  '-101': '账号未登录 / cookie 已失效，去设置页重新粘贴 SESSDATA',
  '-111': 'CSRF 校验失败：bili_jct 缺失，或和 SESSDATA 不是同一个账号',
  '-400': '请求参数不对',
  '-403': '权限不足',
  '-404': 'B站 说没有这条视频 / 这个用户',
  '-509': '请求过于频繁，等一下再来',
  '-412': '被 B站 风控拦了（IP 级限流），要等几分钟',
  '-352': '被 B站 风控拦了，要等几分钟',
  '-799': '请求被风控拦下',
  '-10403': '请求被风控拦下',
  10031: '操作太快，退避一会儿',
  65004: '取消点赞失败：本来就没点过（当前状态就是没赞，不用重试）',
  65006: '本来就是点赞状态（重复点赞，不是失败：别再重试）'
}

/** B站 /x/relation 的 attribute 码。 */
const ATTRIBUTE_HUMAN = {
  0: '没有关注关系',
  1: '悄悄关注（单向）',
  2: '已关注（单向）',
  3: '粉丝（对方关注你）',
  4: '可能是好友？',
  5: '互相关注？',
  6: '互相关注',
  7: '悄悄关注 + 对方关注你',
  128: '黑名单'
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

async function call (deps, verb, path, payload) {
  const client = deps === undefined || deps === null ? undefined : deps.client
  const method = verb === 'post' ? 'post' : 'get'
  if (client === undefined || client === null || typeof client[method] !== 'function') {
    return fail('bad-argument', '内核没装配 B站 客户端（deps.client.' + method + ' 缺失），这个工具现在用不了')
  }
  try {
    return unwrap(await client[method](path, payload || {}))
  } catch (error) {
    return fail('network', '和 B站 通信失败：' + short(error && error.message ? error.message : error))
  }
}

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
    deps.quota.record(deps.config, { type, target, note: str(note).slice(0, 40) })
  } catch (error) {
    const log = deps === undefined || deps === null ? undefined : deps.log
    if (log && typeof log.warn === 'function') log.warn('bili: 点赞已经成功，但配额记账失败：' + short(error && error.message ? error.message : error))
  }
}

/**
 * 关注 / 取关。端点：POST /x/relation/modify（表单 fid + act=1 关注 / 2 取关 + re_src=11；csrf 由 client.post 补）
 *
 * 为什么 act 是 1/2 而不是布尔：这是 B站 的口径，传 0 或 true 都会被回 -400。
 * 为什么 target 写 'mid:<mid>'：关注是一条**账号级**写动作，与「对某条内容点赞」区分开，
 * 配额账本里一眼能看出今天关注了谁（鲸鱼那本账也是这个习惯）。
 */
export async function modify (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const mid = str(a.mid)
  if (mid === '') return fail('bad-argument', '要给 mid（要关注/取关的用户 UID）')
  if (!/^[0-9]+$/.test(mid)) return fail('bad-argument', 'mid 必须是纯数字串（用户的 UID）：' + mid)
  const wanted = str(a.action) === 'unfollow' ? 'unfollow' : 'follow'
  const target = 'mid:' + mid
  const blocked = gateWrite(deps, 'relation', target)
  if (blocked !== null) return blocked
  const result = await call(deps, 'post', '/x/relation/modify', { fid: mid, act: wanted === 'follow' ? 1 : 2, re_src: 11 })
  if (result.ok !== true) return result
  recordWrite(deps, 'relation', target, wanted + ' ' + mid)
  return ok({ mid, action: wanted, url: 'https://space.bilibili.com/' + mid })
}

/**
 * 关注关系。端点：GET /x/relation?fid=<mid>
 * be_relation 是「对方怎么看你」，所以互关要两边都看（attribute 6 + be_relation）。
 */
export async function relation (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const mid = str(a.mid)
  if (mid === '') return fail('bad-argument', '要给 mid（对方的 UID）')
  const result = await call(deps, 'get', '/x/relation', { fid: mid })
  if (result.ok !== true) return result
  const data = result.data === undefined || result.data === null ? {} : result.data
  const attribute = num(data.attribute, 0)
  const be = data.be_relation === undefined || data.be_relation === null ? null : data.be_relation
  const beAttribute = be === null ? null : num(be.attribute, 0)
  const following = attribute === 2 || attribute === 6 || attribute === 7
  const followedBy = beAttribute === null ? null : (beAttribute === 2 || beAttribute === 6 || attribute === 6)
  return ok({
    mid,
    attribute,
    meaning: ATTRIBUTE_HUMAN[attribute] || ('attribute=' + attribute + '（未知码）'),
    beAttribute,
    following,
    followedBy,
    mutual: attribute === 6 || (following && followedBy === true),
    blocked: attribute === 128 || beAttribute === 128,
    url: 'https://space.bilibili.com/' + mid
  })
}

/**
 * 点赞 / 取消点赞一条视频。
 * 端点：POST /x/web-interface/archive/like（表单 aid=<数字 aid> + like=1 点赞 / **2 取消**；csrf 由 client.post 补）
 * aid 由 bvid 经 /x/web-interface/view 换一次 —— 这个端点认 aid，不认 BV 号。
 * like=1 已真机验证通过（2026-11-01）；like=2（取消）按官方文档取值，改完待复验。
 */
export async function like (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const bvid = str(a.bvid)
  if (bvid === '') return fail('bad-argument', '要给 bvid')
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
    return fail('bad-argument', 'bvid 形状不对（应当是 BV + 10 位字母数字，例如 BV1GJ411x7h7）：' + bvid)
  }
  const wanted = str(a.action) === 'unlike' ? 'unlike' : 'like'
  const target = 'BV:' + bvid
  // 闸门先过：额度不够时连换 aid 的那次只读查询都不做
  const blocked = gateWrite(deps, 'like', target)
  if (blocked !== null) return blocked
  const detail = await call(deps, 'get', '/x/web-interface/view', { bvid })
  if (detail.ok !== true) return detail
  const view = detail.data === undefined || detail.data === null ? {} : detail.data
  const aid = num(view.aid, 0)
  if (aid === 0) return fail('bili-error', 'B站 没回这条视频的 aid，点赞没法发（archive/like 认的是 aid，不是 BV 号）')
  // like 只有 1（点赞）和 2（取消）两个合法值：0 会被回 -400，别想当然用布尔语义
  const result = await call(deps, 'post', '/x/web-interface/archive/like', { aid: String(aid), like: wanted === 'like' ? 1 : 2 })
  if (result.ok !== true) return result
  recordWrite(deps, 'like', target, wanted + ' ' + bvid)
  return ok({ bvid, aid, action: wanted, url: 'https://www.bilibili.com/video/' + bvid })
}
