// lib/api/message.js —— 私信域：只发主人 + 读主人会话
//
// ┌───────────────────────────────────────────────────────────────────────┐
// │ 这里是需求里的**硬限制**，不是配置项：                                  │
// │   · send(deps, { text }) 的收件人恒等于 deps.owner.mid                 │
// │   · 任何函数都**不接受** mid / uid / receiver 参数（传了也不看）        │
// │   · deps.owner.mid 为空 → { ok:false, reason:'owner-only' } 直接拒     │
// │ 为什么写死在代码里（PROMPT §6.3）：私信是 B站 风控最凶的接口（判营销/   │
// │ 骚扰）。一旦留一个 mid 参数，这条通道就从「把东西送到主人手里」变成      │
// │ 「群发工具」，而那种事只会在真机上以「账号被限」的形式暴露。             │
// │ 想改收件人？改设置里的 owner.mid，或者不要用这个工具。                   │
// └───────────────────────────────────────────────────────────────────────┘
//
// 为什么私信走 api.vc.bilibili.com 而不是 api.bilibili.com：
//   发消息在 api.vc.bilibili.com/web_im/v1/web_im/send_msg，
//   读会话在 api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs（要 WBI 签名）。
//   两个都不在 client.get/post 的默认主机上，所以走 raw(url, opts) 这条逃逸口，
//   并把完整 URL（含 query）交给客户端 —— 签名和节流仍然是客户端的事，这一层不碰。
//
// dev_id 为什么是「进程内固定」而不是持久化：
//   鲸鱼实现把 dev_id 存到 ~/.bili-ai/dev_id，因为「每发一条换一个设备」会被风控判成
//   同一个人在不同设备间高频切换。本插件不允许写 ~/.bili-ai（状态文件归 core 管），
//   所以退一步：进程内固定（同一进程里连着发几条不会被判成换设备），跨进程稳定性留给
//   core 提供 deviceId 之后再补。这是已知缺口，不是设计意图。

import crypto from 'node:crypto'

const SEND_URL = 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg'
const INBOX_URL = 'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs'
const MSGFEED_URL = '/x/msgfeed/reply'
const RISK_CODES = new Set([-412, -352, -799, -509, -10403])
/** 私信正文上限：鲸鱼实现在真机上按 300 字拦（超了就是刷屏形状）。 */
const TEXT_MAX = 300

const CODE_HUMAN = {
  '-101': '账号未登录 / cookie 已失效，去设置页重新粘贴 SESSDATA',
  '-111': 'CSRF 校验失败：bili_jct 缺失，或和 SESSDATA 不是同一个账号',
  '-400': '请求参数不对',
  '-403': '权限不足：和对方不是互关，或对方关了私信',
  '-509': '请求过于频繁，等一下再来',
  '-412': '被 B站 风控拦了（IP 级限流），要等几分钟',
  '-352': '被 B站 风控拦了，要等几分钟',
  '-799': '请求被风控拦下',
  '-10403': '请求被风控拦下',
  10031: '操作太快，退避一会儿',
  12015: '需要验证码：去浏览器手动过一次',
  12051: '对方不是好友 / 私信被限制（B站 要求互相关注）',
  21007: '对方不是好友 / 私信被限制（B站 要求互相关注）'
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

function unwrapRaw (out) {
  if (out === undefined || out === null || typeof out !== 'object') {
    return fail('network', '和 B站 通信失败（raw 没有返回东西），稍后再试')
  }
  if (typeof out.code === 'number') return unwrap(out)
  if (out.json !== undefined && out.json !== null && typeof out.json === 'object') return unwrap(out.json)
  if (out.data !== undefined && out.data !== null && typeof out.data === 'object' && typeof out.data.code === 'number') return unwrap(out.data)
  if (out.ok === true) return ok(out.data === undefined ? null : out.data)
  return fail('network', '和 B站 通信失败（HTTP ' + str(out.status === undefined ? '?' : out.status) + '，没有拿到 JSON）', {
    detail: { status: num(out.status, 0) }
  })
}

/* ────────────── 写通道的配额闸（dm） ────────────── */

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
    const human = verdict && verdict.human ? String(verdict.human) : '额度用完了，或离上一次私信太近，等一下再来'
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
    if (log && typeof log.warn === 'function') log.warn('bili: 私信已经发出，但配额记账失败：' + short(error && error.message ? error.message : error))
  }
}

/* ────────────── 收件人：唯一来源就是 owner ────────────── */

/** 主人 mid。**这是私信唯一的收件人来源**；arguments 里没有、也不接受任何 mid。 */
function ownerMid (deps) {
  if (deps === undefined || deps === null) return ''
  const owner = deps.owner !== undefined && deps.owner !== null ? deps.owner : (deps.config && deps.config.owner ? deps.config.owner : null)
  return owner === null ? '' : str(owner.mid)
}

function ownerName (deps) {
  if (deps === undefined || deps === null) return ''
  const owner = deps.owner !== undefined && deps.owner !== null ? deps.owner : (deps.config && deps.config.owner ? deps.config.owner : null)
  return owner === null ? '' : str(owner.name)
}

/** 设备 ID：进程内固定（见文件头注释，跨进程稳定性是已知缺口）。 */
let DEV_ID = ''
function deviceId () {
  if (DEV_ID === '') DEV_ID = 'WEB-' + crypto.randomUUID().toUpperCase()
  return DEV_ID
}

async function selfMid (deps) {
  const client = deps === undefined || deps === null ? undefined : deps.client
  if (client === undefined || client === null || typeof client.nav !== 'function') return ''
  try {
    const nav = await client.nav()
    const data = nav && nav.data ? nav.data : {}
    return str(data.mid)
  } catch (error) {
    return ''
  }
}

/** csrf 由 core 的凭据层拿；拿不到就让客户端自己补（client.post 会补，raw 不一定）。 */
function jctOf (deps) {
  const client = deps === undefined || deps === null ? undefined : deps.client
  if (client === undefined || client === null || typeof client.cred !== 'function') return ''
  try {
    const cred = client.cred()
    return cred && cred.bili_jct ? String(cred.bili_jct).trim() : ''
  } catch (error) {
    return ''
  }
}

async function rawCall (deps, url, opts) {
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

/* ────────────────────────────── 写：只发主人 ────────────────────────────── */

/**
 * 给主人发一条私信。
 * 收件人 = deps.owner.mid，**没有参数能改它**（见文件头：需求硬限制）。
 * 端点：POST https://api.vc.bilibili.com/web_im/v1/web_im/send_msg
 */
export async function send (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const to = ownerMid(deps)
  if (to === '') {
    return fail('owner-only', '配置里的 owner.mid 是空的 —— 私信只发给主人，没配主人就不发（这不是可绕过的开关）')
  }
  const text = str(a.text)
  if (text === '') return fail('bad-argument', '要给 text：空私信发不出去')
  if (text.length > TEXT_MAX) {
    return fail('bad-argument', '私信 ' + text.length + ' 字，超过上限 ' + TEXT_MAX + ' 字（再长就是刷屏形状了）')
  }
  const target = 'dm:' + to
  const blocked = gateWrite(deps, 'dm', target)
  if (blocked !== null) return blocked

  const sender = await selfMid(deps)
  if (sender !== '' && sender === to) {
    return fail('owner-only', 'owner.mid 就是当前 cookie 这个号 —— B站 不允许给自己发私信；私信通道需要第二个号（或改用其它通知方式）')
  }
  const form = {
    'msg[sender_uid]': sender,
    'msg[receiver_id]': to,
    'msg[receiver_type]': 1,
    'msg[msg_type]': 1,
    'msg[msg_status]': 0,
    'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
    'msg[dev_id]': deviceId(),
    'msg[content]': JSON.stringify({ content: text })
  }
  const jct = jctOf(deps)
  if (jct !== '') form.csrf = jct
  const result = await rawCall(deps, SEND_URL, { method: 'POST', form })
  if (result.ok !== true) return result
  recordWrite(deps, 'dm', target, text)
  return ok({ to, toName: ownerName(deps), text, length: text.length })
}

/* ────────────────────────────── 读：主人会话 ────────────────────────────── */

/** 「上次读到哪」只记在内存里：本插件不写 ~/.bili-ai，unreadOnly 的含义因此是「本次会话里没读过的新消息」。 */
const LAST_SEEN = new Map()

function messageShape (raw, ownerId) {
  const row = raw === undefined || raw === null ? {} : raw
  const sender = str(row.sender_uid)
  let text = str(row.content)
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') text = str(parsed.content !== undefined ? parsed.content : parsed.text !== undefined ? parsed.text : text)
  } catch (error) { /* 不是 JSON 就按原文 */ }
  const ts = num(row.timestamp, 0)
  return {
    seq: str(row.msg_seqno),
    time: ts > 0 ? new Date(ts * 1000).toISOString() : '',
    from: sender === ownerId ? 'owner' : 'me',
    senderUid: sender,
    type: num(row.msg_type, 1),
    text
  }
}

/**
 * 读和主人的私信会话。
 * 端点：GET https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs（要 WBI 签名）
 * 拿不到时退一步读 /x/msgfeed/reply（「回复我的」），并在结果里明确写下 source —— 不静默换语义。
 */
export async function inbox (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const to = ownerMid(deps)
  if (to === '') return fail('owner-only', '配置里的 owner.mid 是空白的 —— 不知道该读哪个会话（私信通道只认主人）')
  const limit = Math.min(50, Math.max(1, Math.round(num(a.limit, 20))))
  const url = INBOX_URL + '?' + new URLSearchParams({ talker_id: to, session_type: '1', size: String(limit), begin_seqno: '0' }).toString()
  const result = await rawCall(deps, url, { method: 'GET' })

  if (result.ok === true) {
    const data = result.data === undefined || result.data === null ? {} : result.data
    const rows = Array.isArray(data.messages) ? data.messages : []
    const all = rows.map((row) => messageShape(row, to))
    const key = 'dm:' + to
    const lastSeen = LAST_SEEN.get(key) || 0
    const items = a.unreadOnly === true ? all.filter((item) => item.time !== '' && Date.parse(item.time) > lastSeen) : all
    const newest = all.reduce((acc, item) => {
      const at = item.time === '' ? 0 : Date.parse(item.time)
      return at > acc ? at : acc
    }, lastSeen)
    LAST_SEEN.set(key, newest)
    return ok({ source: 'dm', talker: to, talkerName: ownerName(deps), count: items.length, hasMore: data.has_more === true, items })
  }

  // 私信接口不可用（签名/权限/风控）→ 退一步读「回复我的」，语义写在 source 里，不假装是私信
  const client = deps === undefined || deps === null ? undefined : deps.client
  if (client !== undefined && client !== null && typeof client.get === 'function') {
    try {
      const fallback = unwrap(await client.get(MSGFEED_URL, { platform: 'web', build: 0, mobi_app: 'web' }))
      if (fallback.ok === true) {
        const data = fallback.data === undefined || fallback.data === null ? {} : fallback.data
        const rows = Array.isArray(data.items) ? data.items.slice(0, limit) : []
        return ok({
          source: 'msgfeed-reply',
          talker: to,
          talkerName: ownerName(deps),
          note: '私信接口这次没读通（' + (result.human || result.reason) + '），下面给的是「回复我的」通知，不是私信正文',
          count: rows.length,
          hasMore: false,
          items: rows.map((row) => {
            const item = row === undefined || row === null ? {} : row
            return {
              seq: str(item.id),
              time: num(item.reply_time, 0) > 0 ? new Date(num(item.reply_time, 0) * 1000).toISOString() : '',
              from: 'other',
              senderUid: str(item.user && item.user.mid),
              type: 1,
              text: str(item.item && item.item.source_content !== undefined ? item.item.source_content : '')
            }
          })
        })
      }
    } catch (error) { /* 兜底失败就报原始失败 */ }
  }
  return result
}

/* ────────────── 「谁 @ 我了」（AUTONOMY-PROMPT §24.1 / 真机信封修复） ────────────── */

// 端点取证（2026-11-02，curl 实测）：
//   GET /x/msgfeed/atme → HTTP 404（这个路径不存在）
//   GET /x/msgfeed/at → HTTP 200 {"code":-101,"message":"账号未登录"}（存在，只是要登录）
//   GET /x/msgfeed/reply | /x/msgfeed/like → 200（同族，证明确实是 msgfeed 命名空间）
// 别再"觉得 atme 更合理"改回去 —— 上面三行是真机跑出来的，不是推测。
const AT_ME_URL = '/x/msgfeed/at'

/** 端点里的 business/type 原文映射；认不出的一律 other（绝不猜成 comment）。 */
function atMeTypeOf (raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).toLowerCase()
  if (text === '') return 'other'
  if (text.includes('reply') || text.includes('comment')) return 'comment'
  if (text.includes('dynamic')) return 'dynamic'
  if (text.includes('video') || text.includes('archive')) return 'video'
  return 'other'
}

/** 从一堆候选里挑第一个"是数字串且不是 0"的 id；都没有就返回空串（**不编**）。 */
function firstId () {
  for (let i = 0; i < arguments.length; i += 1) {
    const text = str(arguments[i])
    if (/^[0-9]+$/.test(text) && text !== '0') return text
  }
  return ''
}

/** 从 uri（bilibili://video/123、…/dynamic/456）里抠 oid，抠不到返回空串。 */
function oidFromUri (uri) {
  const matched = /(?:video|dynamic|opus|av|ov)[^0-9]*([0-9]{3,})/i.exec(str(uri))
  return matched === null ? '' : matched[1]
}

/**
 * 把一条 @ 通知摊平成上层能用的形状。字段解析不出就**省略**（不编）。
 *
 * 真实结构（2026-11-02 真机取证：主人 @ 她的一条评论，GET /x/msgfeed/at 的 code:0 响应）：
 *   item.id                       —— 这条 @ 通知的 id
 *   item.user.mid / .nickname     —— 谁 @ 的我（**注意在 user 里，不在顶层**）
 *   item.at_time                  —— 秒级时间戳
 *   item.item.type                —— "reply" / "dynamic" / "video" …（**不是 item.business**）
 *   item.item.source_content      —— @ 我的那句正文
 *   item.item.uri                 —— 视频链接，bvid 从这里抠
 *   item.item.subject_id          —— 视频 @ 时是 aid；动态 @ 时是 dyn id
 *   item.item.root_id / source_id —— root_id 为 0 时用 source_id 当楼层根（顶层评论）
 * 教训：第一版按顶层 item.mid / item.business 解析，真机上 mid/uname/type/text 全空、type 错成 other。
 */
function shapeAtMe (item) {
  if (item === null || typeof item !== 'object') return null
  const id = firstId(item.id, item.id_str)
  if (id === '') return null
  const body = item.item === undefined || item.item === null ? {} : item.item
  const user = item.user === undefined || item.user === null ? {} : item.user
  const uri = str(body.uri)
  const at = str(item.at_time)
  const sourceContent = str(body.source_content)
  const out = {
    id,
    mid: firstId(user.mid, user.uid),
    uname: str(user.nickname === undefined ? user.uname : user.nickname).slice(0, 40),
    at,
    type: atMeTypeOf(body.type),
    text: sourceContent.slice(0, 120)
  }
  const oid = firstId(body.subject_id, body.oid, oidFromUri(uri))
  if (oid !== '') out.oid = oid
  // root_id 为 0 表示这条评论是顶层评论：此时楼层根就是它自己（source_id）
  const root = firstId(body.root_id, body.rootId)
  const sourceId = firstId(body.source_id)
  const resolvedRoot = root !== '' ? root : sourceId
  if (resolvedRoot !== '') out.root = resolvedRoot
  if (sourceId !== '') out.rpid = sourceId
  const bvid = /(BV[0-9A-Za-z]{10})/.exec(uri)
  if (bvid !== null) out.bvid = bvid[1]
  return out
}

/**
 * 读「谁 @ 我了」。端点：GET /x/msgfeed/at（pn=1、type=0；见 AT_ME_URL 处的 curl 取证）。
 *
 * 为什么必须在 api 层（2026-11-01 真机 bug）：
 *   client.get() 返回的是 B站 **原始响应** {code, message, data}，**没有 ok 字段**；
 *   工具层若直接 `if (result.ok !== true) 失败`，真机上 100% 失败且静默 ——
 *   ensureMentionReply 看到 ok!==true 就跳过，「@我必回」一次都不会发生。
 *   信封的 code→ok 翻译只在 api 层做，与同文件其它读端点一致。
 */
export async function atMe (deps, args) {
  const a = args === undefined || args === null ? {} : args
  // limit：0 / 负数 / 非数字 → 默认 5；>10 → 夹到 10；其余按给定值
  const rawLimit = num(a.limit, 0)
  const limit = rawLimit > 0 ? Math.min(10, Math.round(rawLimit)) : 5
  const client = deps === undefined || deps === null ? undefined : deps.client
  if (client === undefined || client === null || typeof client.get !== 'function') {
    return fail('credential-missing', '读不了「@我的」：客户端没有装配')
  }
  let response = null
  try {
    response = await client.get(AT_ME_URL, { platform: 'web', build: 0, mobi_app: 'web', pn: 1, type: 0 })
  } catch (error) {
    return fail('network', '读「@我的」时网络出错：' + short(error && error.message ? error.message : error))
  }
  // 两种信封都接受：
  //   ① 真机 core/client.js 的原始响应 { code, message, data }（正常路径）；
  //   ② 已经被外层摊平成 { ok:true, data } 的形状（测试替身 / 未来同构客户端）——
  //      统一折成 ① 再交给 unwrap，翻译逻辑只有一处。
  const normalized = (typeof response?.code !== 'number' && response?.ok === true)
    ? { code: 0, data: response.data === undefined ? {} : response.data }
    : response
  // -101（未登录）要单独翻成 not-logged-in：通用 unwrap 只按风控码分类，
  //   而"没登录"和"接口报错"对上层是两种处理（前者要去设置页重贴 cookie）。
  const code = typeof normalized?.code === 'number' ? normalized.code : null
  if (code === -101) return fail('not-logged-in', humanOf(code), { code })
  const unwrapped = unwrap(normalized)
  if (unwrapped.ok !== true) return unwrapped
  const data = unwrapped.data === undefined || unwrapped.data === null ? {} : unwrapped.data
  const rows = Array.isArray(data.items) ? data.items : []
  const items = rows.slice(0, limit).map(shapeAtMe).filter((x) => x !== null)
  // ok/count/items 是契约形状；data 里同名字段是为了和别的工具一致（上层两处都能读）
  return { ok: true, count: items.length, items, data: { count: items.length, items } }
}
