// 动作层：把"她想做什么"翻译成内核工具的调用 —— 这是唯一允许碰账号的地方，所以全部卡口在这。
//
// 六道闸，缺一不可（顺序就是执行顺序）：
//   ① 白名单：只认 §5 那 15 个工具，模型点名别的（例如 bili_comment_del）一律拒。
//   ② 总开关 / 通道开关：schedule.allows 关掉的通道，动作直接丢弃（skipped:channel-off）。
//   ③ 私信硬限制：bili_dm 的收件人由内核写死，本层**不接受**任何 mid/uid 参数，
//      带了就整条丢弃（skipped:owner-only）—— 这不是"过滤一下"，是需求里的硬限制。
//   ④ 预算：先读一次 bili_status；token 预算耗尽 / 风控熔断 → 这一轮所有写动作都不发。
//   ⑤ 配额：每日上限（schedule.caps）+ 每次醒来最多 K 条写（§3）——
//      两者都受**指标**折算（§14.3）：私信上限 × dmFactor，K 取 min(K, hints.maxWrites)。
//      通道开关也走 effectiveAllows(schedule.allows, metrics)：累了/没底气的日子她自己就会少说。
//   ⑥ 去重：同一段正文、同一个 bvid 不重复动作（指纹落在 state.json，跨热重载仍然有效）。
//
// 指标（§14）在这里**两个方向**都参与：进闸（effectiveAllows / behaviorHints）与出场
//   （每个动作之后 applyEvent：read/write-action + action-ok/fail，私信成功再加 dm-sent）。
//   这样"今天累了"不是一句台词，而是下一轮真的发不出去。
//
// 为什么每个动作都写审计：这个层会用主人的账号在公开场合说话。"没写审计的动作视为没发生"
//   —— 记不下来的发言，事后没人能复核，那就不该发。
import { createHash } from 'node:crypto'

import { appendAudit } from './audit.js'
import { readStatusBrief } from './brain.js'
import { loadSchedule, countsToday, bumpCount, silenceFor } from './schedule.js'
import { readState, patchState } from './state.js'
import { applyEvent, behaviorHints, effectiveAllows, effectiveCap, readMetrics } from './metrics.js'

/**
 * §5 白名单：她只能用这些工具（其余一律拒绝，即使模型要求）。
 *
 * 2026-11-01 两处调整（契约自相矛盾的修正）：
 *   · **加 bili_follow**：schedule.allows.follow / caps.follow 摆在那儿，而 follow 动作以前
 *     先撞白名单 —— 那个开关永远不会产生 channel-off，等于一个假开关。开关既然存在就得是真的。
 *   · **去掉 bili_image_upload**：它不产出公开内容（不过写通道的 token 预算），但传图是**请求额度**
 *     的消耗，自主层不该随手传 —— 需要图时由 bili_dynamic 内部替它传，路径还在。
 */
export // 只读工具（2026-11-02 补进白名单）：`bili_at_me` / `bili_dm_inbox` / `bili_fav_list`。
// 它们一直是只读，但白名单漏了 → 自主层（off 模式是默认）根本调不到「谁@我了」「收件箱」「收藏夹」。
const WHITELIST = [
  'bili_watch', 'bili_video_info', 'bili_search', 'bili_comments', 'bili_replies',
  'bili_user_info', 'bili_relation', 'bili_like', 'bili_favorite', 'bili_comment',
  'bili_reply', 'bili_dm', 'bili_dynamic', 'bili_follow', 'bili_status',
  // 第二批工具里的只读通道（2026-11-01 补）：取播放地址是纯读，与 bili_video_info 同级。
  // 它必须进白名单，否则"好奇低 → 不点开"这条规则会被白名单先拦下，
  // 永远看不到 low-curiosity 这个 reason（规则就变成假的）。
  'bili_playurl',
  // 三个纯只读通道（2026-11-02 用户批准补）：漏了它们，off 模式下她连「谁@我了」「收件箱」「收藏夹」都调不到。
  'bili_at_me', 'bili_dm_inbox', 'bili_fav_list',
]

/**
 * 「探索类」工具：好奇低的时候不碰（persona.md §6：「只看热门，不搜索、不点开长视频」）。
 * 刷热门（bili_watch）不在其中 —— 那是"不费力地看一眼"，正是低好奇时该做的事。
 */
const EXPLORE_TOOLS = new Set(['bili_search', 'bili_playurl'])

/**
 * 「看视频」类工具（§18.1 / §20.2）。
 *
 * 为什么要在这里再列一次（autonomy 里也有一份）：计数必须发生在**动作真正执行成功**的地方，
 *   而模型的主动读动作只经过本文件的循环，不经过 ensureMinWatch。
 *   2026-11-01 真机缺陷：她自己主动 bili_watch 的那些**一条都没计数**，
 *   于是睡前汇报长期写着「看了 0 条视频」。
 *   去重说明：ensureMinWatch 是直接 runTool（不经过本循环），所以它自己 bump 的那一次不会双计。
 */
const READ_TOOLS = new Set(['bili_watch', 'bili_video_info', 'bili_playurl'])
/**
 * 自主层每轮深读条数的上限。**2026-11-02 用户明确要求放宽到 3**（原来夹到 1）。
 *
 * 保留原本的真机成本数据（别丢，这是判断依据）：
 *   · 一条深读 ≈ 2 万 token（抽帧视觉 + 转录后处理）；
 *   · 一晚 10 轮 × 3 条 ≈ 60 万 token，还要下最多 30 次视频（每次 ≤200MB）；
 *   · 实测 vision 调用会 TRANSPORT 失败（三条里栽一条），深读越多撞上的概率越高。
 * 用户的原话是"她每轮醒来都必须看视频，除了 token 之外不该有别的东西拦住" ——
 *   所以这里只留工具自身的上限（deepCount 1–3），不再额外夹到 1。
 */
const DEEP_MAX_PER_WAKE = 3

/** 写通道（撞 risk-control 时只冷却写，不静默整层）。与 autonomy 的 WRITE_TOOLS 保持同一份口径。 */
const WRITE_TOOLS_LOCAL = new Set(['bili_comment', 'bili_reply', 'bili_dm', 'bili_dynamic', 'bili_dynamic_edit', 'bili_favorite', 'bili_like', 'bili_follow', 'bili_comment_del', 'bili_comment_top', 'bili_dynamic_top'])

/**
 * 工具 → 通道（决定了它受哪个 allows / caps 管）。不在表里的都是只读。
 *
 * 为什么 comment_top / dynamic_top 也在表里（它们**不在**白名单）：防御性。
 *   这两个工具一旦哪天被加进白名单，没有这张表就会**绕过**通道开关与每日上限 ——
 *   置顶评论和置顶动态都是公开动作，性质与 comment/dynamic 一样。
 *   "现在进不来"不是理由，映射先摆对。
 */
export const CHANNEL_OF = {
  bili_comment: 'comment',
  bili_reply: 'reply',
  bili_dynamic: 'dynamic',
  bili_dm: 'dm',
  bili_like: 'like',
  bili_follow: 'follow',
  bili_comment_top: 'comment',
  bili_dynamic_top: 'dynamic',
}

/** 每次醒来最多几条写动作（§3）。 */
const MAX_WRITES_PER_WAKE = 2
/** 指纹上限（state.json 里只留最近这么多条）。 */
const FINGERPRINT_MAX = 200
/** 触发静默的风控信号。 */
const RISK_CODES = new Set([-412, -352, -799, -509, -10403])

const clip = (value, max) => String(value ?? '').slice(0, max)

/** 取工具（Map / 数组 / 普通对象）。 */
function toolOf (deps, name) {
  const bag = deps?.tools
  if (bag === null || bag === undefined) return null
  if (Array.isArray(bag)) return bag.find((t) => t?.name === name) ?? null
  if (typeof bag.get === 'function') return bag.get(name) ?? null
  if (typeof bag === 'object') return bag[name] ?? null
  return null
}

/** 去重指纹：正文/目标二选一，其余参数排序后哈希。 */
function fingerprintOf (tool, args) {
  const a = args !== null && typeof args === 'object' ? args : {}
  const material = [a.text, a.message, a.bvid, a.oid, a.dynId, a.mid, a.rpid].filter((v) => typeof v === 'string' && v !== '')
  const extra = Object.keys(a).filter((k) => !['text', 'message', 'bvid', 'oid', 'dynId', 'mid', 'rpid'].includes(k)).sort().map((k) => `${k}=${String(a[k])}`)
  const key = `${tool}|${material.join('|')}|${extra.join(',')}`
  return tool + ':' + createHash('sha1').update(key).digest('hex').slice(0, 16)
}

/** 我的评论（§23.2）最多留这么多条。 */
const MY_COMMENTS_MAX = 20

/**
 * 记一条"我发过的评论"：{ bvid, aid, rpid, at }。
 *
 * aid 是检查回复时必须的（bili_replies 要 oid = aid）；它不从评论接口来，
 *   所以这里额外用 bili_video_info 取**一次** —— 取不到就**不追踪这条**
 *   （宁可少回一条，也不要存一条永远查不了的死记录，那会每轮白花 3 次读请求）。
 */
async function rememberMyComment (deps, args, result) {
  const bvid = String(args?.bvid ?? '').trim()
  const rpid = String(result?.data?.rpid ?? result?.data?.rpId ?? '').trim()
  if (bvid === '' || rpid === '') return
  let aid = String(result?.data?.oid ?? result?.data?.aid ?? '').trim()
  if (aid === '') {
    const info = toolOf(deps, 'bili_video_info')
    if (info === null) return
    try {
      const out = await info.execute({ bvid }, {})
      if (out?.ok === true) aid = String(out.data?.aid ?? out.data?.avid ?? '').trim()
    } catch { /* 取不到 aid → 跳过追踪 */ }
  }
  if (aid === '') return
  const list = Array.isArray(readState().myComments) ? readState().myComments : []
  const entry = { bvid, aid, rpid, at: new Date().toISOString() }
  const next = [...list.filter((x) => String(x?.rpid ?? '') !== rpid), entry].slice(-MY_COMMENTS_MAX)
  try { patchState({ myComments: next }) } catch { /* 写不进去 → 下一轮查不到这条，不影响本轮 */ }
}

/** 从一次读动作里取"看的那个 bvid"：列表类取第一条，详情/播放地址类用参数里的。 */
function firstBvidOf (tool, args, result) {
  const direct = String(args?.bvid ?? '').trim()
  if (direct !== '') return direct
  const data = result?.data ?? {}
  const list = Array.isArray(data.items) ? data.items : (Array.isArray(data.list) ? data.list : [])
  const first = list[0]
  return String(first?.bvid ?? first?.bvId ?? '').trim()
}

/** 最近评论过的 bvid（§20.1，最多 100 个）。 */
const COMMENTED_MAX = 100
const commentedBvids = () => {
  const list = readState().commentedBvids
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []
}
function rememberCommentedBvid (bvid) {
  if (bvid === '') return
  const next = [...commentedBvids().filter((x) => x !== bvid), bvid].slice(-COMMENTED_MAX)
  try { patchState({ commentedBvids: next }) } catch { /* 落盘失败 → 下次可能重复评论，但不影响本次 */ }
}

const stateFingerprints = () => {
  const list = readState().fingerprints
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []
}

function rememberFingerprint (fp) {
  const next = [...stateFingerprints(), fp].slice(-FINGERPRINT_MAX)
  patchState({ fingerprints: next })
}

/** 私信硬限制：任何看起来像"收件人"的参数都不接受。 */
const RECIPIENT_KEYS = ['mid', 'uid', 'receiver', 'receiver_id', 'to', 'touid', 'target_mid', 'user_id']
function dmRecipientViolation (args) {
  if (args === null || typeof args !== 'object') return null
  for (const key of Object.keys(args)) {
    if (RECIPIENT_KEYS.includes(key)) return key
  }
  return null
}

/** 从一次工具返回里识别"要不要立刻静默"。 */
function riskFrom (result) {
  if (result === null || typeof result !== 'object') return null
  if (result.reason === 'risk-control') return 'risk-control'
  if (result.reason === 'token-budget-exhausted') return 'token-budget-exhausted'
  if (RISK_CODES.has(Number(result.code))) return 'risk-control'
  return null
}

/** 结果摘要（审计只存形状，不存正文）。 */
const resultBrief = (result) => (result !== null && typeof result === 'object'
  ? { ok: result.ok === true, reason: result.reason ?? null, code: result.code ?? null }
  : { ok: false, reason: 'no-result' })

/**
 * 执行一轮决策。
 * @param {{ok:boolean, actions?: Array<{tool:string,args?:object,why?:string}>}} decision
 * @param {{tools?: any, log?: Function, maxWritesPerWake?: number}} deps
 * @returns {Promise<{executed: Array<object>, skipped: Array<{tool:string, why:string}>}>}
 */
export async function runActions (decision, deps = {}) {
  const executed = []
  const skipped = []
  const actions = Array.isArray(decision?.actions) ? decision.actions : []
  const schedule = loadSchedule()
  const metrics = readMetrics()
  const hints = behaviorHints(metrics)
  // 指标只能**收紧**：effectiveAllows 不改 schedule 本身，只在这一次执行里生效
  const allows = effectiveAllows(schedule.allows, metrics)
  const wakeBudget = Math.max(0, Math.round(Number(deps?.maxWritesPerWake ?? MAX_WRITES_PER_WAKE)))
  const maxWrites = Math.min(wakeBudget, hints.maxWrites)

  // ② 总开关：关掉就什么都不做（连只读也不该在这一层跑）
  if (!schedule.enabled) {
    for (const action of actions) skipped.push({ tool: String(action?.tool ?? '?'), why: 'disabled' })
    return { executed, skipped }
  }

  // ②a 精疲力尽的总闸（§14.3 第一档）：energy < 10 → **只拦写，不拦读**。
  //
  //   2026-11-02 用户明确要求："除了 token 之外不该有别的东西拦住她看视频"，
  //   所以这条闸不再"一条动作都不做"，而是：
  //     · energy < 10 → 读照常（看视频/看评论/看状态都行），**写一条都不发**（她累到不行还去发言 = 找风控）；
  //     · energy < 3  → 仍然只读，但**连"至少看一个视频"的兜底也跳过**（人都快没了，别再逼她）。
  //   这两个数字是 §14 定的阈值，**不引入新配置项**。
  //
  //   为什么"只拦写"必须由执行层兑现：runActions 只对写动作查 allows，只读动作本来就放行，
  //   所以"累到不发东西"这件事必须在这里判（2026-11-01 tests/metrics.test.mjs 抓到过一次）。
  //   注意：这里仍然在**读 bili_status 之前**，所以太累时连状态查询都不花。
  if (metrics.energy < 10) {
    try {
      appendAudit({ tool: 'wake', args: { trigger: 'energy-gate', energy: metrics.energy }, why: '今天太累了：只读不写', result: { ok: true, reason: 'energy-read-only' } })
    } catch { /* 审计写不进去也要继续 */ }
    try {
      patchState({ lastSkip: { at: new Date().toISOString(), reason: 'energy-read-only' } })
    } catch { /* 状态写不进去照样继续 */ }
  }

  // ②b 兴趣命中（§14.2 的 interest-hit）：**每次醒来最多应用一次**。
  //     判据只来自大脑，这一层不做任何启发式判断 —— "内容好不好看"不是代码能猜的。
  //     两个位置都认：决策级 `decision.interest`，或**单条动作上**的 `action.interest`
  //     （大脑完全可能把"这条让我停下来了"写在具体动作里；只认决策级会静默丢掉这个信号，
  //      真机上就是"心情永远不动"——2026-11-01 tests/metrics.test.mjs 抓到的那个差异）。
  //     无论出现几次，这一次 runActions 只应用一条。
  const wantsInterest = decision?.interest === true || actions.some((a) => a?.interest === true)
  let interestApplied = false
  if (wantsInterest) {
    try {
      applyEvent('interest-hit')
      interestApplied = true
    } catch { /* 指标写不进去不影响动作 */ }
  }

  // ④ 预算：先看一眼账号状态；预算耗尽 / 熔断中 → 这一轮零写请求
  let budgetBlock = null
  const brief = await readStatusBrief(deps)
  if (/token-budget-exhausted|risk-control|banned":true/.test(String(brief))) {
    budgetBlock = /token-budget-exhausted/.test(String(brief)) ? 'token-budget-exhausted' : 'risk-control'
  }

  let writes = 0
  const counts = countsToday()

  for (const action of actions) {
    const tool = String(action?.tool ?? '')
    const args = action?.args !== null && typeof action?.args === 'object' ? action.args : {}
    const why = clip(action?.why ?? '', 120)
    // 兜底动作：审计里标出来（commentFallback / dmFallback / replyFallback），
    // 事后能分清"她自己想说的"与"系统补的"
    const fallbackKind = typeof action?.fallbackKind === 'string'
      ? action.fallbackKind
      : (action?.fallback === true ? 'comment' : '')

    // ① 白名单
    if (!WHITELIST.includes(tool)) {
      skipped.push({ tool, why: 'whitelist' })
      continue
    }
    // ③ 私信硬限制（先查，避免任何"带 mid 的私信"被当成合法请求继续往下走）
    if (tool === 'bili_dm') {
      const bad = dmRecipientViolation(args)
      if (bad !== null) {
        skipped.push({ tool, why: 'owner-only' })
        appendAudit({ tool, args, why: why + '（携带收件人参数 ' + bad + '，已拒绝）', result: { ok: false, reason: 'owner-only' } })
        continue
      }
    }

    // ③a 评论：同一个 bvid 不重复评论（§20.1）。
    //     放在所有写闸**之前** —— 命中时要在"消耗写间隔"之前就返回，
    //     否则一次注定被跳过的调用也会把 gap 推走（那是把一个只读判定变成了一次写）。
    let finalArgs = args
    // ③a' 自主层的深读上限（§：每轮最多 1 条）。只改 bili_watch 且只改 deep=true 的那次调用；
    //    被夹住时把原值留在 args.deepCountRequested 里，事后能看"她想看几条、实际看几条"。
    if (tool === 'bili_watch' && args?.deep === true) {
      const requested = Number(args.deepCount) > 0 ? Math.round(Number(args.deepCount)) : 1
      const capped = Math.min(requested, DEEP_MAX_PER_WAKE)
      // 只有真的被夹住时才记 deepCountRequested（现在是 1–3 之间，工具本来也吃这个范围）
      if (capped !== requested) finalArgs = { ...args, deepCount: capped, deepCountRequested: requested }
      else finalArgs = { ...args, deepCount: capped }
    }
    if (tool === 'bili_comment') {
      const bvid = String(args?.bvid ?? '')
      if (bvid !== '' && commentedBvids().includes(bvid)) {
        skipped.push({ tool, why: 'already-commented' })
        continue
      }
      // 模型没显式给 atOwner 时自动补 true（§20.1；schedule.atOwnerOnComment 关掉就不补）
      if (args?.atOwner === undefined && schedule.atOwnerOnComment !== false) {
        finalArgs = { ...args, atOwner: true }
      }
    }

    // ③b 好奇太低：不探索（只刷热门）。放在通道判断之前 —— 这两个都是只读工具，
    //     走不到通道闸，只能在这里拦。
    if (hints.noExplore === true && EXPLORE_TOOLS.has(tool)) {
      skipped.push({ tool, why: 'low-curiosity' })
      continue
    }

    const channel = CHANNEL_OF[tool] ?? null
    if (channel !== null && metrics.energy < 10) {
      // 只拦写：读在 energy 低时照常（用户要求"看"不被别的闸拦住）
      skipped.push({ tool, why: 'energy-too-low' })
      continue
    }
    if (channel !== null) {
      // ② 通道开关（指标收紧后的版本）
      if (allows?.[channel] !== true) {
        skipped.push({ tool, why: 'channel-off' })
        continue
      }
      // ④ 预算耗尽 → 写动作一条都不发
      if (budgetBlock !== null) {
        skipped.push({ tool, why: budgetBlock })
        continue
      }
      // ④b 写冷却（§ 真机过激处置修复）：上一次写被 risk-control 拒后 10 分钟内不再试写。
      //    只拦写、不拦读、不拦 tick —— 一次写失败不该让她连看都不能看。
      const cooldownUntil = Date.parse(String(readState().writeCooldownUntil ?? ''))
      if (Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()) {
        skipped.push({ tool, why: 'write-cooldown' })
        continue
      }
      // ⑤ 每日上限（§17：null = 不限；0 = 禁止；数字 = 上限）。
      //    私信在上限存在时才按 dmFactor 折算 —— 没设上限就没什么可折的。
      //    计数照旧（bumpCount 在成功后执行），超了才拦；"观测"与"限制"是两件事。
      const cap = effectiveCap(schedule.caps?.[channel], channel, hints)
      if (cap !== null && (counts[channel] ?? 0) >= cap) {
        skipped.push({ tool, why: 'cap' })
        continue
      }
      // ⑤ 每次醒来的写动作预算
      if (writes >= maxWrites) {
        skipped.push({ tool, why: 'wake-budget' })
        continue
      }
    }

    // ⑥ 去重。命中 = §14.2 里的 repeat（"同一段正文/同一个 bvid 又来一次"）：
    //    这是唯一能确定"她在重复自己"的时刻，所以在这里记一次倦怠，而不是等模型自觉。
    const fp = fingerprintOf(tool, args)
    if (stateFingerprints().includes(fp)) {
      skipped.push({ tool, why: 'duplicate' })
      try { applyEvent('repeat') } catch { /* 指标写不进去不影响跳过 */ }
      continue
    }

    const target = toolOf(deps, tool)
    if (target === null || typeof target.execute !== 'function') {
      skipped.push({ tool, why: 'tool-unavailable' })
      continue
    }

    let result = null
    try {
      result = await target.execute(finalArgs, {})
    } catch (error) {
      result = { ok: false, reason: 'threw: ' + clip(error?.message ?? error, 80) }
    }

    const briefResult = resultBrief(result)
    // 审计参数：兜底标记（fallbackKind）或调用方给的 mark（用来区分 comment / commentRepair / commentFallback:"forced"）
    const mark = action?.mark !== null && typeof action?.mark === 'object' && !Array.isArray(action.mark) ? action.mark : null
    const auditArgs = mark !== null
      ? { ...finalArgs, ...mark }
      : (fallbackKind === '' ? finalArgs : { ...finalArgs, [fallbackKind + 'Fallback']: true })
    appendAudit({ tool, args: auditArgs, why, result: briefResult })
    executed.push({ tool, ok: briefResult.ok, reason: briefResult.reason ?? undefined })

    // 指标：先记"做了一件事"（消耗精力），再记成败（涨/掉自信），私信成功再加亲近。
    // 顺序有意义：energy 先掉，同一轮后续动作的行为提示才跟着变（例如最后一条被 maxWrites 挡）。
    try {
      applyEvent(channel !== null ? 'write-action' : 'read-action')
      applyEvent(briefResult.ok ? 'action-ok' : 'action-fail')
      if (tool === 'bili_dm' && briefResult.ok) applyEvent('dm-sent')
    } catch { /* 指标写不进去不影响动作结果 */ }

    // 读动作成功 → 记一次 read（与下面的写通道计数并列，互不影响）。
    //   read 不是写通道：它不进 CHANNEL_OF、不占写间隔、不受 caps 管，只进 todayCounts。
    if (channel === null && briefResult.ok && READ_TOOLS.has(tool)) {
      try { bumpCount('read') } catch { /* 计数写不进去不影响动作结果 */ }
      // 记住"最近看的那个视频"（§22.1）：下一轮的"看完必评论"兜底要用它定位 bvid
      const watched = firstBvidOf(tool, finalArgs, result)
      if (watched !== '') {
        try { patchState({ lastWatchedBvid: watched }) } catch { /* 落盘失败 → 兜底时可能找不到 bvid，会记 why 跳过 */ }
      }
    }

    if (channel !== null) {
      writes += 1
      if (briefResult.ok) {
        bumpCount(channel)
        counts[channel] = (counts[channel] ?? 0) + 1
        rememberFingerprint(fp)
        // 评论成功 → 记住这个 bvid（§20.1：同一个视频不重复评论，最近 100 个）
        if (tool === 'bili_comment') {
          rememberCommentedBvid(String(finalArgs?.bvid ?? ''))
          // §23.2：记下"我评论过哪条"，后续要靠它检查有没有人回复
          await rememberMyComment(deps, finalArgs, result)
        }
        if (tool === 'bili_dm') {
          // 私信成功 → 记一条 owner 类记忆（喂养"他今天找过我"的连续性）。文案用 ownerTitle，别写死。
          try {
            const { appendMemory } = await import('./memory.js')
            appendMemory({ kind: 'owner', text: clip(args.text ?? '', 200), ref: 'dm' })
          } catch { /* 记忆写不进去不影响动作结果 */ }
        }
      }
    }

    // 撞闸 → 停止这一轮的**后续动作**（重试只会把账号推得更深），但"停多久"要分级：
    //   2026-11-02 真机：一次 bili_reply 的 -412 直接让她整层静默 2 小时，
    //   连『看』和『跟你说话』都停了 —— 一次写失败不该升级成整层停机。
    const risk = riskFrom(result)
    if (risk !== null) {
      if (risk === 'token-budget-exhausted') {
        silenceFor(3600_000, 'token 预算耗尽') // 预算耗尽不是"被平台打了一下"，不动心情，只停手
      } else if (WRITE_TOOLS_LOCAL.has(tool)) {
        // 写通道被拒：只冷却写 10 分钟。
        // **不调 applyEvent('risk')** —— 它在 metrics 里会顺带 silenceFor(2h)，
        // 那正是这次要修的"一次写失败升级成整层停机"。
        try { patchState({ writeCooldownUntil: new Date(Date.now() + 10 * 60_000).toISOString() }) } catch { /* 写不进去 → 下一轮再判 */ }
      } else {
        // 读通道被拒 → 这才是"账号可能真被风控"的强信号
        try { applyEvent('risk') } catch { silenceFor(2 * 3600_000, '风控命中（risk-control）') }
      }
      for (const rest of actions.slice(actions.indexOf(action) + 1)) {
        skipped.push({ tool: String(rest?.tool ?? '?'), why: risk })
      }
      break
    }
  }

  void interestApplied
  return { executed, skipped }
}
