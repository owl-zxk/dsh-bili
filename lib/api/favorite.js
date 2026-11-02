// lib/api/favorite.js —— 收藏夹：列表 + 收藏/取消收藏
//
// 为什么收藏要「先查 aid，再查收藏夹 id，最后才 deal」：
//   /x/v3/fav/resource/deal 要的是 rid=aid 和一个 media_id（收藏夹 id），
//   而调用方手里只有一个 BV 号。三个信息里少一个都发不出去，而 B站 不会替你猜
//   （实测把 bvid 当成 rid 传 → code=-400，看起来像参数写错，实际是「口径不对」）。
//   所以这里把两次只读查询包进 deal()：调用方只管给 bvid + 加/取消。
//
// 为什么收藏也要过配额闸：
//   它是 7 条写通道之一（PROMPT §6.1 / INTERFACE §8）。收藏是"公开动作"——
//   会出现在粉丝动态里，风控把它算成写操作，所以它也占写额度。

const RISK_CODES = new Set([-412, -352, -799, -509, -10403])

const CODE_HUMAN = {
  '-101': '账号未登录 / cookie 已失效，去设置页重新粘贴 SESSDATA',
  '-111': 'CSRF 校验失败：bili_jct 缺失，或和 SESSDATA 不是同一个账号',
  '-400': '请求参数不对',
  '-403': '权限不足：这个收藏夹不是你的，或已满',
  '-404': 'B站 说没有这个收藏夹 / 这条视频',
  '-509': '请求过于频繁，等一下再来',
  '-412': '被 B站 风控拦了（IP 级限流），要等几分钟',
  '-352': '被 B站 风控拦了，要等几分钟',
  '-799': '请求被风控拦下',
  '-10403': '请求被风控拦下',
  10031: '操作太快，退避一会儿',
  11010: '收藏夹已满',
  11011: '不能收藏自己的视频',
  11201: '这个收藏夹已经收藏过这条视频了'
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
    if (log && typeof log.warn === 'function') log.warn('bili: 收藏已经成功，但配额记账失败：' + short(error && error.message ? error.message : error))
  }
}

/** 这个账号自己的 mid：收藏夹列表是按 up_mid 查的，必须是被登录的那个号。 */
async function selfMid (deps) {
  const client = deps === undefined || deps === null ? undefined : deps.client
  if (client !== undefined && client !== null && typeof client.nav === 'function') {
    try {
      const nav = await client.nav()
      const mid = str(nav && nav.data ? nav.data.mid : '')
      if (mid !== '') return mid
    } catch (error) { /* 落到 owner 兜底 */ }
  }
  const owner = deps === undefined || deps === null ? null : (deps.owner || (deps.config && deps.config.owner))
  return owner === null || owner === undefined ? '' : str(owner.mid)
}

function folderShape (raw) {
  const f = raw === undefined || raw === null ? {} : raw
  return {
    id: num(f.id !== undefined ? f.id : f.media_id, 0),
    title: str(f.title),
    mediaCount: num(f.media_count, 0),
    isDefault: /默认/.test(str(f.title))
  }
}

/** 收藏夹列表。端点：GET /x/v3/fav/folder/created/list-all（up_mid 是自己） */
export async function folders (deps) {
  const mid = await selfMid(deps)
  if (mid === '') return fail('bad-argument', '不知道这是哪个账号（nav 拿不到 mid，owner.mid 也是空的）')
  const result = await call(deps, 'get', '/x/v3/fav/folder/created/list-all', { up_mid: mid })
  if (result.ok !== true) return result
  const data = result.data === undefined || result.data === null ? {} : result.data
  const rows = Array.isArray(data.list) ? data.list : []
  const list = rows.map(folderShape)
  const fixed = list.map((item) => Object.assign({}, item, { url: 'https://space.bilibili.com/' + mid + '/favlist?fid=' + item.id }))
  return ok({ mid, count: fixed.length, defaultId: pickDefault(fixed).id, items: fixed })
}

/** 默认收藏夹：标题里有「默认」的那个，没有就取第一个（B站 一定会给每个号建一个默认夹）。 */
function pickDefault (list) {
  const hit = list.find((item) => item.isDefault === true) || list[0]
  return hit === undefined ? { id: 0, title: '' } : hit
}

/**
 * 收藏 / 取消收藏。
 * 端点：POST /x/v3/fav/resource/deal
 *   add=true  → add_media_ids=<默认收藏夹>，del_media_ids 空
 *   add=false → del_media_ids=<默认收藏夹>，add_media_ids 空
 */
export async function deal (deps, args) {
  const a = args === undefined || args === null ? {} : args
  const bvid = str(a.bvid)
  if (bvid === '') return fail('bad-argument', '要给 bvid')
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
    return fail('bad-argument', 'bvid 形状不对（应当是 BV + 10 位字母数字，例如 BV1GJ411x7h7）：' + bvid)
  }
  const add = a.add !== false

  // 闸门先过：额度不够时连「查 aid / 查收藏夹」这两步都不做（少两次白打的请求）
  const target = 'BV:' + bvid
  const blocked = gateWrite(deps, 'favorite', target)
  if (blocked !== null) return blocked

  const detail = await call(deps, 'get', '/x/web-interface/view', { bvid })
  if (detail.ok !== true) return detail
  const view = detail.data === undefined || detail.data === null ? {} : detail.data
  const aid = num(view.aid, 0)
  if (aid === 0) return fail('bili-error', 'B站 没回这条视频的 aid，收藏没法发（deal 要的是 aid，不是 BV 号）')

  const mid = await selfMid(deps)
  const folderList = await call(deps, 'get', '/x/v3/fav/folder/created/list-all', { up_mid: mid })
  if (folderList.ok !== true) return folderList
  const rows = Array.isArray(folderList.data && folderList.data.list) ? folderList.data.list.map(folderShape) : []
  const folder = pickDefault(rows)
  if (folder.id === 0) {
    return fail('bili-error', '这个号还没有任何收藏夹 —— 先在网页上收藏一次，B站 才会建出「默认收藏夹」')
  }

  const form = {
    rid: String(aid),
    type: '2',
    add_media_ids: add ? String(folder.id) : '',
    del_media_ids: add ? '' : String(folder.id)
  }
  const result = await call(deps, 'post', '/x/v3/fav/resource/deal', form)
  if (result.ok !== true) return result
  recordWrite(deps, 'favorite', target, (add ? '收藏 ' : '取消收藏 ') + bvid)
  return ok({
    bvid,
    aid,
    add,
    folder: { id: folder.id, title: folder.title },
    title: str(view.title),
    url: 'https://www.bilibili.com/video/' + bvid
  })
}
