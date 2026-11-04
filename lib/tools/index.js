// lib/tools/index.js —— 15 个给模型用的工具
//
// 这个文件只做三件事：把参数说清楚、把 api 结果说成人话、把能力缺失如实报出去。
// 业务判据一律不在这里（在 lib/api/*），否则同一条规则会有两份，改一处漏一处。
//
// 为什么 parameters / output.schema 都写成**标准 JSON Schema**（对象级 required 数组）：
//   INTERFACE §9 定的就是这个形状，ctx.tools.register 吃的是标准 JSON Schema；
//   宿主内部那套「属性级 required」是 defineTool 包装层的方言，用于它自己的 spec 对象。
//   直接吐标准形状 = 不需要任何转换层，也就没有「转换时漏掉一个 required」这种隐患。
//
// 为什么 output.render 返回 [{ type:'text', text }] 而不是裸字符串：
//   宿主对 render 的消费方式是「内容块数组」（已安装插件 dsh-voice-call / dsh-video 都是这个形状），
//   返回字符串会让工具结果在界面上变成空白。为了两边都不炸，render 同时接受两种调用方式：
//   render(result) 与 render(args, result)，并把纯文本版本挂在 output.renderText 上。
//
// 为什么每个 execute 外面还包一层 try/catch：
//   api 层已经保证「正常失败不抛」，但这里仍要兜住「实现 bug」这一类异常 ——
//   模型看到 { ok:false, human } 会换条路走，看到一段异常栈只会重试同一个工具。

import * as videoApi from '../api/video.js'
import * as commentApi from '../api/comment.js'
import * as dynamicApi from '../api/dynamic.js'
import * as messageApi from '../api/message.js'
import * as favoriteApi from '../api/favorite.js'
import * as relationApi from '../api/relation.js'
import * as userApi from '../api/user.js'
import { deepWatch } from '../core/deepwatch.js'
import { appendAudit } from '../core/audit.js'
import { appendLearning } from '../core/learning.js'

/** 顺序即 INTERFACE §9 的清单顺序。 */
export const TOOL_NAMES = [
  'bili_watch',
  'bili_video_info',
  'bili_search',
  'bili_comments',
  'bili_comment',
  'bili_reply',
  'bili_comment_del',
  'bili_dm',
  'bili_dm_inbox',
  'bili_dynamic',
  'bili_dynamic_edit',
  'bili_favorite',
  'bili_fav_list',
  'bili_like',
  'bili_status',
  // ↓ 第二批（INTERFACE §13.1），顺序照表
  'bili_replies',
  'bili_comment_top',
  'bili_dynamic_detail',
  'bili_dynamic_top',
  'bili_image_upload',
  'bili_playurl',
  'bili_user_info',
  'bili_relation',
  'bili_follow',
  // ↓ 第三批（AUTONOMY-PROMPT §24.1）：只读，"谁 @ 我了"
  'bili_at_me'
]

/** INTERFACE §2 的 reason 枚举：工具出口只允许这几个值，模型才能按固定分支处理。 */
const REASONS = [
  'bad-argument',
  'credential-missing',
  'owner-only',
  'quota-exceeded',
  'token-budget-exhausted',
  'capability-not-found',
  'bili-error',
  'network',
  'not-logged-in',
  'risk-control'
]

/** 15 个工具共用的结果信封（成功/失败都在同一个形状里）。 */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', description: 'true = 成功，data 里有结果；false = 失败，看 reason + human' },
    reason: { type: 'string', enum: REASONS, description: '失败原因枚举（成功时不出现）' },
    human: { type: 'string', description: '给人看的一句话：说清发生了什么、下一步该做什么' },
    code: { type: 'number', description: 'B站 返回的原始 code（有就带上，方便核对）' },
    detail: { type: 'object', description: '结构化补充（可用能力列表、携带的列表项等）' },
    data: { type: 'object', description: '成功时的结果本体，具体字段见该工具的描述' }
  },
  required: ['ok']
}

/* ────────────────────────── 小工具函数 ────────────────────────── */

function str (value) { return value === undefined || value === null ? '' : String(value).trim() }
function short (value) { return String(value === undefined || value === null ? '' : value).slice(0, 200) }
function num (value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback }
function clamp (value, min, max, fallback) {
  const n = Math.round(num(value, fallback))
  return Math.min(max, Math.max(min, n))
}

function objectSchema (properties, required, extra) {
  const out = { type: 'object', properties, additionalProperties: false }
  if (Array.isArray(required) && required.length > 0) out.required = required
  if (extra !== undefined && extra !== null && typeof extra === 'object') Object.assign(out, extra)
  return out
}

/* ────────────────────────── 参数片段（描述都说清「是什么 / 什么范围 / 不给会怎样」） ────────────────────────── */

const BVID = {
  type: 'string',
  pattern: '^BV[0-9A-Za-z]{10}$',
  description: '视频 BV 号，形如 BV1GJ411x7h7（BV + 10 位字母数字）。和 aid 二选一。'
}

const AID = {
  type: 'integer',
  minimum: 1,
  description: '视频 av 号（纯数字）。和 bvid 二选一；给不出 aid 就让工具用 bvid 换。'
}

const OID = {
  type: 'string',
  pattern: '^[0-9]+$',
  description: '评论区目标 id：视频是 aid（不是 BV 号），动态是它的 comment id。写评论/回复等工具给了 bvid 时会自动换成 aid；两个都给时以 oid 为准。'
}

const COMMENT_TYPE = {
  type: 'integer',
  enum: [1, 11, 17],
  minimum: 1,
  maximum: 17,
  default: 1,
  description: '评论区类型代码（B站 口径）：1=视频，11=图文动态，17=动态。默认 1。'
}

const AT_OWNER = {
  type: 'boolean',
  default: false,
  description: 'true = 在正文最前面自动补上「@主人昵称」（主人昵称取设置里的 owner.name；正文里已经有这个 @ 就不重复加）。这是「让主人收到提醒」的唯一手段。'
}

/* ────────────────────────── render 基建 ────────────────────────── */

function failText (result) {
  const reason = str(result === undefined || result === null ? '' : result.reason) || 'unknown'
  const human = str(result.human) || '没有给出原因'
  const code = result !== undefined && result !== null && result.code !== undefined ? '（code=' + result.code + '）' : ''
  return '✗ ' + human + '  [' + reason + ']' + code
}

function headText (result) {
  const data = result.data === undefined || result.data === null ? {} : result.data
  return data
}

/**
 * 把「纯文本渲染函数」包成宿主认的内容块数组，同时容忍两种调用形式：
 *   render(result)        —— lib/index.js 自己拼工具定义时的自然写法
 *   render(args, result)  —— 宿主那份 register 契约的调用方式
 */
function makeRender (textOf) {
  const plain = (first, second) => {
    const result = second === undefined ? first : second
    try {
      if (result === undefined || result === null) return '（没有结果）'
      if (result.ok !== true) return failText(result)
      const text = textOf(headText(result), result)
      return typeof text === 'string' && text !== '' ? text : '✓ 完成'
    } catch (error) {
      return '（渲染结果时出错了：' + short(error && error.message ? error.message : error) + '）'
    }
  }
  const render = (first, second) => [{ type: 'text', text: plain(first, second) }]
  render.text = plain
  return render
}

/**
 * 从 execute 的第二个参数里尽量捞出调用者身份（agent / sessionId / callId）。
 * 宿主不一定给：拿不到就返回空串，**不伪造**。
 */
function callerOf (execCtx) {
  if (execCtx === null || execCtx === undefined || typeof execCtx !== 'object') return ''
  for (const key of ['agent', 'agentId', 'sessionId', 'callId']) {
    const value = execCtx[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 64)
  }
  const nested = execCtx.agent
  if (nested !== null && typeof nested === 'object') {
    for (const key of ['id', 'name', 'sessionId']) {
      const value = nested[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 64)
    }
  }
  return ''
}

/** 审计里的参数脱敏：正文类截 120 字，凭据类**整个丢掉**（连长度都不留）。 */
function redactArgs (args) {
  const out = {}
  if (args === null || typeof args !== 'object') return out
  for (const [key, value] of Object.entries(args)) {
    if (/sessdata|cookie|token|jct|credential|password|secret/i.test(key)) continue
    if (typeof value === 'string') {
      out[key] = /message|text|content|body/i.test(key) ? value.slice(0, 120) : value.slice(0, 120)
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) { out[key] = value; continue }
    out[key] = '[object]'
  }
  return out
}

function makeTool (name, description, parameters, run, textOf) {
  if (!TOOL_NAMES.includes(name)) throw new Error('bili: 未登记的工具名 ' + name)
  const render = makeRender(textOf)
  return {
    name,
    description,
    parameters,
    output: { schema: RESULT_SCHEMA, render, renderText: render.text },
    async execute (args, execCtx) {
      const input = args === undefined || args === null ? {} : args
      const by = callerOf(execCtx)
      let result
      try {
        result = await run(input, execCtx)
      } catch (error) {
        result = {
          ok: false,
          reason: 'bili-error',
          human: '工具内部出错了：' + short(error && error.message ? error.message : error) + '。这是实现问题，不是 B站 拒了；不要原样重试。'
        }
      }
      // 工具层审计：她（或任何 agent）在会话里直接调 bili_* 也要留痕。
      // 为什么在这里而不是各 api 函数里：**所有 25 个工具都经过这里**，一处包住就不会漏；
      // 自主层自己那套审计（带 why）保持不动，两套并存：自主层的看 why，工具层的看 source:"tool"。
      try {
        appendAudit({
          tool: name,
          args: redactArgs(input),
          why: '工具调用',
          result: { ok: result !== null && result !== undefined && result.ok === true, reason: result?.reason },
          source: 'tool',
          ...(by === '' ? {} : { by }),
        })
      } catch (error) {
        // 审计写不进去绝不能影响工具结果：只 warn 一句
        try { console.warn('dsh-bili 工具层审计写不进去：' + short(error && error.message ? error.message : error)) } catch { /* 连 warn 都坏了就算了 */ }
      }
      return result
    }
  }
}

/* ────────────────────────── 公共：bvid → oid ────────────────────────── */

async function resolveOid (deps, args) {
  const direct = str(args.oid)
  if (direct !== '') return { oid: direct, bvid: str(args.bvid) }
  const bvid = str(args.bvid)
  if (bvid === '') return { error: { ok: false, reason: 'bad-argument', human: '要给 bvid 或 oid 之一：评论区是按 aid（纯数字）定位的，两个都没有就定位不到。' } }
  const detail = await videoApi.info(deps, { bvid })
  if (detail.ok !== true) return { error: detail }
  return { oid: String(detail.data.aid), bvid, title: detail.data.title }
}

function capabilityIds (deps) {
  const caps = deps === undefined || deps === null ? undefined : deps.capabilities
  if (caps === undefined || caps === null || typeof caps.list !== 'function') return []
  try {
    const list = caps.list()
    return Array.isArray(list) ? list.map((item) => str(item && item.id)).filter((id) => id !== '') : []
  } catch (error) {
    return []
  }
}

/* ────────────────────────── 1. bili_watch ────────────────────────── */

/**
 * 把一条深读结果摊成**统一形状**：`{ bvid, title, ok, reason?, human?, detail?, partial?, result, deep }`。
 *
 * 为什么 reason 必须提到顶层（2026-11-02 真机）：调用方（brain）只读条目顶层的 ok/reason，
 *   以前 reason 藏在 result.data.reason 里，它看到 ok:false 却不知道原因（too-long？网络？没能力？）。
 *
 * 为什么"有 failures 且没摘要"要算失败：
 *   真机上出现过 ok:true + summary:'' + 3 条 MODEL_STREAM_FAILED —— 她会以为自己看过了，
 *   然后说出没有依据的话。没看到内容就是没看到，宁可报失败也不要让她编。
 */
function normalizeDeepEntry (item, outcome) {
  const base = { bvid: str(item?.bvid), title: str(item?.title) }
  const ok = outcome !== null && outcome !== undefined && outcome.ok === true
  const data = outcome !== null && outcome !== undefined && outcome.data !== null && typeof outcome.data === 'object' ? outcome.data : {}
  if (!ok) {
    const reason = str(outcome?.reason) || 'unknown'
    return { ...base, ok: false, reason, human: str(outcome?.human), detail: outcome?.detail, result: outcome, deep: outcome }
  }
  const summary = str(data.summary) || str(data.answer)
  const failures = Array.isArray(data.failures) ? data.failures : []
  if (summary === '') {
    const reason = failures.length > 0 ? 'understand-failed' : 'empty-summary'
    const brief = failures.slice(0, 2).map((f) => [str(f?.stage), str(f?.reason)].filter((x) => x !== '').join(': ')).filter((x) => x !== '').join(' / ')
    return {
      ...base,
      ok: false,
      reason,
      human: reason === 'understand-failed'
        ? '视频没看成（' + (brief === '' ? '理解过程失败了' : brief) + '），这次没有摘要'
        : '视频理解没有返回任何摘要（模型没输出）',
      detail: failures.length > 0 ? { failures: failures.slice(0, 2) } : undefined,
      result: outcome,
      deep: outcome,
    }
  }
  // 有摘要但部分批次失败 → 仍算成功，只是标 partial（别把可用的摘要丢掉）
  return { ...base, ok: true, ...(failures.length > 0 ? { partial: true, detail: { failures: failures.slice(0, 2) } } : {}), result: outcome, deep: outcome }
}

function watchTool (deps) {
  const parameters = objectSchema({
    source: {
      type: 'string',
      enum: ['popular', 'recommend', 'ranking', 'feed'],
      default: 'popular',
      description: '从哪儿刷：popular=综合热门（默认），recommend=推荐流（B站 按你的口味推的，不全是热门），ranking=分区排行榜，feed=我关注的动态流（返回的是动态卡片，不是视频信息）。'
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 20,
      default: 5,
      description: '这次看几条（1-20，默认 5）。热门/排行一次最多取 20 条，多了只会多打一次网络。'
    },
    rid: {
      type: 'integer',
      minimum: 0,
      maximum: 210,
      default: 0,
      description: '仅 source=ranking 时有用：分区号（0=全站，1=动画，4=游戏，36=科技…）。默认 0。'
    },
    maxDuration: {
      type: 'integer',
      minimum: 1,
      description: '只要时长 ≤ 这个值的视频（秒）；推荐流长视频多，深读时建议给 600。时长字段缺失的条目会保留（不因为缺字段就丢掉）。'
    },
    deep: {
      type: 'boolean',
      default: false,
      description: 'true = 对前 deepCount 条视频做「内容深读」：**会真的把视频下载到本地**（体积上限 200MB、时长上限 10 分钟），再交给一个能看懂视频的插件（dsh-video 注册的 video.understand）抽帧+转写，最后返回摘要。'
        + '超限时不是 capability-not-found：体积超限返回 bad-argument、时长超过 10 分钟返回 too-long（文案会说清换条短的）。'
        + '宿主没有这类插件时才返回 capability-not-found 并列出当前可用能力 id —— 绝不静默降级成「只看标题」。'
    },
    deepCount: {
      type: 'integer',
      minimum: 1,
      maximum: 3,
      default: 1,
      description: 'deep=true 时深读几条（1-3，默认 1）。每条都是一次视觉模型调用，钱和时间都按条数走。'
    },
    question: {
      type: 'string',
      maxLength: 500,
      description: '深读时想问的问题（例如「这期主讲什么」「值不值得看」）。不给就只做整体理解。'
    }
  }, [])

  async function run (args) {
    const source = ['popular', 'recommend', 'ranking', 'feed'].includes(str(args.source)) ? str(args.source) : 'popular'
    const limit = clamp(args.limit, 1, 20, 5)
    // 注意：不能用 clamp（它会把缺省值夹到 min=1，"不传"就变成"只要 ≤1 秒"）
    const rawMax = Number(args.maxDuration)
    const maxDuration = Number.isFinite(rawMax) && rawMax >= 1 ? Math.min(86400, Math.round(rawMax)) : 0
    const keepByDuration = (one) => {
      if (maxDuration <= 0) return true
      const d = Number(one?.duration ?? 0)
      // 时长缺失/为 0（取不到）→ 保留：宁可让它可能 too-long，也不要凭空丢掉一条
      return !Number.isFinite(d) || d <= 0 ? true : d <= maxDuration
    }
    if (source === 'feed') {
      const feed = await dynamicApi.feed(deps, { type: 'video', page: 1 })
      if (feed.ok !== true) return feed
      const items = feed.data.items.filter(keepByDuration).slice(0, limit)
      return { ok: true, data: { source, count: items.length, items, deep: [], ...(maxDuration > 0 ? { maxDuration } : {}) } }
    }
    const listed = source === 'ranking'
      ? await videoApi.ranking(deps, { rid: clamp(args.rid, 0, 210, 0), type: 'all' })
      : source === 'recommend'
        ? await videoApi.recommend(deps, { ps: Math.min(30, Math.max(limit, 20)) })
        : await videoApi.popular(deps, { ps: Math.max(limit, 20), pn: 1 })
    if (listed.ok !== true) return listed
    // 按时长过滤（推荐流里绝大多数 >600 秒，深读会全部 too-long —— 让她先筛掉看不完的）
    const items = listed.data.items.filter(keepByDuration).slice(0, limit)
    if (maxDuration > 0 && items.length === 0) {
      return {
        ok: true,
        data: {
          source,
          maxDuration,
          count: 0,
          items: [],
          deep: [],
          note: '这个来源没有 ≤' + maxDuration + ' 秒的视频，换来源或放宽 maxDuration',
        },
      }
    }
    const deep = []
    if (args.deep === true) {
      // 深读现在走"真的看懂"（§25）：playurl → 体积闸 → 下载 → 宿主 video_understand → 删文件。
      // 以前这里是调能力注册表的 video.understand（它拿不到本地文件，等于没有真的看）。
      const question = str(args.question)
      const wanted = clamp(args.deepCount, 1, 3, 1)
      const targets = items.filter((item) => str(item.bvid) !== '').slice(0, wanted)
      if (targets.length === 0) {
        return { ok: false, reason: 'bad-argument', human: '这条来源里没有可深读的视频（feed 给的是动态卡片，没有 bvid）—— 换成 source=popular / ranking / recommend。' }
      }
      // deepWatch 需要一条 playurl 通道（B站 直链只有插件这一侧知道怎么取）
      const deepDeps = {
        ...deps,
        // 允许注入 playurl / videoInfo（测试或替换实现用）；默认走本插件的 api 层。
        // ctx 由 {...deps} 带进来 —— deepWatch 优先用宿主的 video_understand 工具。
        api: {
          playurl: typeof deps?.api?.playurl === 'function' ? deps.api.playurl : (a) => videoApi.playurl(deps, a),
          videoInfo: typeof deps?.api?.videoInfo === 'function' ? deps.api.videoInfo : (a) => videoApi.info(deps, a),
        },
        // 测试/部署可以注入自己的下载器（默认是流式 fetch + 超时）
        downloadFile: deps?.downloadFile,
      }
      for (const item of targets) {
        let outcome
        try {
          // 列表项自带 duration（秒）→ 时长闸在下载前就能判，省一次 video_info
          outcome = await deepWatch({ bvid: item.bvid, question, deps: deepDeps, duration: item.duration })
        } catch (error) {
          // 单条失败只挂在这条上，**不影响整批**（§25.2 第 2 条）
          outcome = { ok: false, reason: 'network', human: '深读出错：' + short(error && error.message ? error.message : error) }
        }
        // 兼容旧契约：如果部署里确实有一个"直接吃 bvid"的 video.understand 能力（老插件），
        // 在真下载这条路走不通时回落到它 —— 它返回的是它自己的结论，不是我们编的摘要。
        if (outcome?.ok !== true && (str(outcome?.reason) === 'network' || str(outcome?.reason) === 'capability-not-found')) {
          const caps = deps === undefined || deps === null ? undefined : deps.capabilities
          if (caps !== undefined && caps !== null && typeof caps.call === 'function') {
            try {
              const viaCap = await caps.call('video.understand', { bvid: item.bvid, question })
              if (viaCap !== undefined && viaCap !== null && viaCap.ok === true) outcome = { ...viaCap, via: 'capability' }
            } catch { /* 回落失败就保留原错误 */ }
          }
        }
        const entry = normalizeDeepEntry(item, outcome)
        deep.push(entry)
        // 学到了就记一笔（学习层是纯数据写入，不额外调模型；失败只 warn，绝不影响工具结果）
        if (entry.ok === true) {
          const summary = str(entry.result?.data?.summary) || str(entry.result?.data?.answer)
          if (summary !== '') {
            try { appendLearning({ bvid: item.bvid, title: item.title, summary, question }) } catch (error) {
              try { console.warn('dsh-bili 学习记录写不进去：' + short(error && error.message ? error.message : error)) } catch { /* 忽略 */ }
            }
          }
        }
      }
      // 能力**整体缺失**是全局问题，不是"某一条视频运气不好"：这时仍然返回结构化的
      // capability-not-found（保持 §24 之前的对外语义），而不是让调用方从每条里自己拼。
      if (deep.length > 0 && deep.every((x) => x.ok === false && str(x.deep?.reason) === 'capability-not-found')) {
        const available = capabilityIds(deps)
        return {
          ok: false,
          reason: 'capability-not-found',
          human: '深读要用的 video_understand 现在用不了（宿主的工具与 video.understand 能力都没拿到）。当前可用能力：'
            + (available.length === 0 ? '（一个都没有）' : available.join(', '))
            + '。要么去掉 deep 只看标题，要么先把这个能力装上。',
          detail: { id: 'video.understand', available, items: items.map((item) => ({ bvid: item.bvid, title: item.title })) }
        }
      }
    }
    return { ok: true, data: { source, count: items.length, items, deep } }
  }

  function text (data) {
    const lines = ['刷到 ' + data.count + ' 条（' + data.source + '）']
    for (const item of data.items) {
      if (item.bvid !== undefined && item.bvid !== '') {
        lines.push('· ' + item.bvid + ' ' + (item.title || '(无标题)') + '  @' + (item.owner && item.owner.name ? item.owner.name : '?') + '  播放 ' + (item.stat ? item.stat.view : 0))
      } else {
        lines.push('· ' + (item.author && item.author.name ? item.author.name : '?') + '：' + short(item.text))
        if (item.url) lines.push('  ' + item.url)
      }
    }
    for (const item of data.deep) {
      const r = item.result === undefined || item.result === null ? {} : item.result
      if (item.ok === false) {
        // 没看成就要说清原因，而不是含糊地说"没有文字结论"
        const reason = str(item.reason) || str(r.reason) || 'unknown'
        const failure = Array.isArray(item.detail?.failures) && item.detail.failures.length > 0 ? item.detail.failures[0] : null
        const tail = failure === null ? '' : '（' + str(failure.stage) + ': ' + str(failure.reason) + '）'
        lines.push('深读 ' + item.bvid + '：没看成（' + reason + '）' + tail)
        continue
      }
      // 真实结构是 result.data.answer / .summary（以前读 result.answer → 永远 undefined）
      const answer = str(r?.data?.answer) || str(r?.data?.summary) || str(r?.answer) || str(item.summary)
      if (answer === '') {
        lines.push('深读 ' + item.bvid + '：（理解了，但没有文字结论）')
        continue
      }
      lines.push('深读 ' + item.bvid + '：' + short(answer) + (item.partial === true ? '（部分批次失败）' : ''))
    }
    return lines.join('\n')
  }

  return makeTool(
    'bili_watch',
    '刷 B站：按来源拉一批视频（综合热门 / 分区排行 / 关注动态流），可选对前几条做「内容深读」。'
      + '能做什么：读列表、控制看几条（limit 1-20）、要不要深读（deep + deepCount + question）。'
      + '深读会**真的下载**那条视频到本地（体积上限 200MB、时长上限 10 分钟），再交给一个能看懂视频的插件'
      + '（dsh-video 注册的 video.understand）抽帧 + 转写，最后返回摘要。'
      + '超限时不是 capability-not-found：体积超限返回 bad-argument、时长超过 10 分钟返回 too-long（换条短的）；'
      + '宿主没有这类插件（video.understand 不可用 / 没有插件注册它）时才返回 capability-not-found 并列出当前可用能力 id —— 绝不会静默降级成「只看标题」骗你说读过了。'
      + '不能做什么：不能点赞/收藏/评论（那要另外的工具）。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 2. bili_video_info ────────────────────────── */

function videoInfoTool (deps) {
  const parameters = objectSchema({ bvid: BVID, aid: AID }, [], {
    anyOf: [{ required: ['bvid'] }, { required: ['aid'] }]
  })
  async function run (args) {
    return videoApi.info(deps, { bvid: args.bvid, aid: args.aid })
  }
  function text (data) {
    const stat = data.stat || {}
    const lines = [
      (data.title || '(无标题)') + '  [' + data.bvid + ' / av' + data.aid + ']',
      'UP：' + (data.owner && data.owner.name ? data.owner.name : '?') + '（mid ' + (data.owner ? data.owner.mid : '?') + '）  分区：' + (data.tname || '?'),
      '时长 ' + data.duration + 's  发布 ' + (data.pubdate || '?'),
      '播放 ' + stat.view + ' · 弹幕 ' + stat.danmaku + ' · 评论 ' + stat.reply + ' · 点赞 ' + stat.like + ' · 投币 ' + stat.coin + ' · 收藏 ' + stat.favorite + ' · 分享 ' + stat.share,
      data.url
    ]
    if (data.desc) lines.push('简介：' + short(data.desc))
    if (Array.isArray(data.pages) && data.pages.length > 1) lines.push('分 P ' + data.pages.length + ' 段，第一段 cid=' + data.pages[0].cid)
    return lines.join('\n')
  }
  return makeTool(
    'bili_video_info',
    '取一条视频的元信息：标题、UP、分区、时长、发布时间、播放/点赞/收藏等统计、分 P 列表（含每段 cid）、简介。'
      + '能做什么：给 bvid 或 aid 就能查（二选一）。'
      + '不能做什么：不读评论、不下字幕、不判断内容好坏（内容理解是 video.understand 能力的事）。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 3. bili_search ────────────────────────── */

function searchTool (deps) {
  const parameters = objectSchema({
    keyword: { type: 'string', minLength: 1, maxLength: 100, description: '搜索关键词。必填。' },
    type: {
      type: 'string',
      enum: ['video', 'media_bangumi', 'bili_user'],
      default: 'video',
      description: '搜什么：video=视频（默认），media_bangumi=番剧，bili_user=用户。'
    },
    page: { type: 'integer', minimum: 1, maximum: 50, default: 1, description: '页码（1-50，默认 1）。一页 20 条左右。' },
    order: {
      type: 'string',
      enum: ['totalrank', 'click', 'pubdate', 'dm', 'stow'],
      default: 'totalrank',
      description: '排序：totalrank=综合（默认），click=播放多，pubdate=最新，dm=弹幕多，stow=收藏多。'
    }
  }, ['keyword'])
  async function run (args) {
    return videoApi.search(deps, { keyword: args.keyword, type: args.type, page: args.page, order: args.order })
  }
  function text (data) {
    const lines = ['搜「' + data.keyword + '」第 ' + data.page + ' 页（' + data.type + '/' + data.order + '）：' + data.count + ' 条']
    for (const item of data.items) {
      const title = str(item.title) || '(无标题)'
      lines.push('· ' + (item.bvid || item.url || '(无 id)') + ' ' + title + '  @' + (item.owner && item.owner.name ? item.owner.name : '?') + '  播放 ' + (item.stat ? item.stat.view : 0))
      if (item.description) lines.push('  ' + short(item.description))
    }
    if (data.count === 0) lines.push('（接口正常，但这一页没有结果）')
    return lines.join('\n')
  }
  return makeTool(
    'bili_search',
    '搜 B站（WBI 签名的 /x/web-interface/wbi/search/type）：能按关键词搜视频/番剧/用户，可翻页、可换排序。'
      + '能做什么：拿 bvid / UP / 播放量 / 简介，作为「先找再细看」的入口。'
      + '不能做什么：不做语义搜索、不保证排序稳定（那是 B站 的算法）；返回的 title 已经去掉高亮标签。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 4. bili_comments ────────────────────────── */

function commentsTool (deps) {
  const parameters = objectSchema({
    bvid: BVID,
    oid: OID,
    type: COMMENT_TYPE,
    page: { type: 'integer', minimum: 1, maximum: 50, default: 1, description: '页码（1-50，默认 1）。' },
    withReplies: {
      type: 'boolean',
      default: true,
      description: 'true（默认）= 带上每条评论已经内嵌的前几条楼中楼；false = 只留 replyCount，正文更短、更省上下文。'
    }
  }, [], { anyOf: [{ required: ['bvid'] }, { required: ['oid'] }] })
  async function run (args) {
    const target = await resolveOid(deps, args)
    if (target.error !== undefined) return target.error
    const listed = await commentApi.list(deps, {
      oid: target.oid,
      type: args.type,
      page: args.page,
      withReplies: args.withReplies !== false
    })
    if (listed.ok !== true) return listed
    return { ok: true, data: Object.assign({}, listed.data, { bvid: target.bvid, title: target.title === undefined ? '' : target.title }) }
  }
  function text (data) {
    const lines = ['评论 ' + data.count + ' 条 / 共约 ' + data.total + '（oid ' + data.oid + '，' + data.sort + '，第 ' + data.page + ' 页）' + (data.title ? '：' + data.title : '')]
    for (const item of data.items) {
      lines.push('· rpid=' + item.rpid + ' ♥' + item.like + ' ' + (item.user || '匿名') + '（mid ' + item.mid + '）' + (item.time ? ' ' + item.time : ''))
      lines.push('  ' + short(item.text))
      if (Array.isArray(item.replies) && item.replies.length > 0) {
        for (const sub of item.replies) lines.push('    └ ' + (sub.user || '?') + '：' + short(sub.text) + '（rpid=' + sub.rpid + '）')
        if (item.replyCount > item.replies.length) lines.push('    └ 还有 ' + (item.replyCount - item.replies.length) + ' 条（用 bili_comments 的 oid+root 再拉）')
      }
    }
    if (data.count === 0) lines.push('（这一页没有评论：可能关了评论区，或页码超了）')
    return lines.join('\n')
  }
  return makeTool(
    'bili_comments',
    '读一条视频/动态的评论区主楼（热评序），每条评论带 rpid、作者 mid、点赞数、正文，以及内嵌的前几条楼中楼。'
      + '能做什么：给 bvid（内部自动换成 aid）或 oid 就能读，可翻页、可关掉楼中楼省上下文。'
      + '不能做什么：不写评论（用 bili_comment / bili_reply）、不删评论、不判断评论真假；拉整串楼中楼要再用 oid+root 拉一次。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 5. bili_comment ────────────────────────── */

/** 正文取值的统一入口：message 优先，content / text / body 作为别名（真机踩过：模型写 content）。 */
function pickMessage (args) {
  const a = args === undefined || args === null ? {} : args
  for (const key of ['message', 'content', 'text', 'body']) {
    const value = typeof a[key] === 'string' ? a[key].trim() : ''
    if (value !== '') return value
  }
  return ''
}

function commentTool (deps) {
  const parameters = objectSchema({
    bvid: BVID,
    oid: OID,
    type: COMMENT_TYPE,
    message: { type: 'string', minLength: 1, maxLength: 1000, description: '评论正文（1-1000 字，B站 硬限）。表情写 B站 表情码 [码名]，emoji 直接写。必填。' },
    // 别名：模型经常把正文写成 content / text / body（真机 2026-11-02 就是这么 bad-argument 的）。
    // 只靠提示词治不住"每次换一个词"，所以 schema 接受、run 里归一成 message。
    content: { type: 'string', maxLength: 1000, description: '正文别名（等同 message，兼容模型的叫法）。' },
    text: { type: 'string', maxLength: 1000, description: '正文别名（等同 message）。' },
    body: { type: 'string', maxLength: 1000, description: '正文别名（等同 message）。' },
    atOwner: AT_OWNER
  }, [], { anyOf: [{ required: ['bvid'] }, { required: ['oid'] }] })
  async function run (args) {
    const target = await resolveOid(deps, args)
    if (target.error !== undefined) return target.error
    // 显式 message 优先；否则依次取 content / text / body（顺序固定，别让模型猜）
    const message = pickMessage(args)
    if (message === '') {
      return { ok: false, reason: 'bad-argument', human: '要给正文：用 message 字段（content / text / body 也认，但别空着）' }
    }
    const added = await commentApi.add(deps, {
      oid: target.oid,
      type: args.type,
      message,
      atOwner: args.atOwner === true
    })
    if (added.ok !== true) return added
    return { ok: true, data: Object.assign({}, added.data, { bvid: target.bvid, title: target.title === undefined ? '' : target.title }) }
  }
  function text (data) {
    return '✓ 评论已发出 rpid=' + data.rpid + (data.atOwner ? '（已 @主人）' : '') + '\n  ' + short(data.message) + '\n  ' + data.url
  }
  return makeTool(
    'bili_comment',
    '发一条顶层评论（POST /x/v2/reply/add），可选在正文最前面自动 @主人 —— 这是让主人收到提醒的手段。'
      + '能做什么：给 bvid 或 oid + 正文就能发；atOwner=true 自动补 @主人昵称（正文里已有就不重复加）。'
      + '写操作：先过 token 预算闸（按本次会话已花 token 计，不分读写），再过写间隔；预算用尽时返回 reason=token-budget-exhausted，读通道仍可用，闸不放行就一条请求都不发。'
      + '不能做什么：不能给别人发私信（私信只能发给主人，见 bili_dm）、不能在一条里带图、不能一次发多条。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 6. bili_reply ────────────────────────── */

function replyTool (deps) {
  const parameters = objectSchema({
    bvid: BVID,
    oid: OID,
    type: COMMENT_TYPE,
    root: { type: 'string', pattern: '^[0-9]+$', description: '楼层根评论的 rpid（主楼那一条）。必填 —— 缺了就会发成顶层评论。' },
    rpid: { type: 'string', pattern: '^[0-9]+$', description: '要回复的那条评论的 rpid（就是楼中楼里那一行的 rpid）。必填。' },
    message: { type: 'string', minLength: 1, maxLength: 1000, description: '回复正文（1-1000 字）。必填。' },
    atOwner: AT_OWNER
  }, ['root', 'rpid', 'message'], { anyOf: [{ required: ['bvid'] }, { required: ['oid'] }] })
  async function run (args) {
    const target = await resolveOid(deps, args)
    if (target.error !== undefined) return target.error
    const sent = await commentApi.reply(deps, {
      oid: target.oid,
      type: args.type,
      root: args.root,
      rpid: args.rpid,
      message: args.message,
      atOwner: args.atOwner === true
    })
    if (sent.ok !== true) return sent
    return { ok: true, data: Object.assign({}, sent.data, { bvid: target.bvid }) }
  }
  function text (data) {
    return '✓ 已回复 rpid=' + data.rpid + '（root=' + data.root + ' parent=' + data.parent + '）' + (data.atOwner ? '（已 @主人）' : '')
      + '\n  ' + short(data.message) + '\n  ' + data.url
  }
  return makeTool(
    'bili_reply',
    '回复评论区里的一条评论（POST /x/v2/reply/add 带 root+parent 坐标）。'
      + '能做什么：给 bvid/oid + root（楼层根 rpid）+ rpid（要回的那条）+ 正文就能回；可选自动 @主人。'
      + 'root 和 rpid 都必填 —— 少一个就会发成顶层评论，那是另一个动作，所以宁可拒掉也不猜。'
      + '写操作：先过 token 预算闸（不分读写），再过写间隔；预算用尽时返回 reason=token-budget-exhausted，读通道仍可用，闸不放行就一条请求都不发。'
      + '不能做什么：不能回复站内私信（私信只能发给主人）、不能一次回多条。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 7. bili_comment_del ────────────────────────── */

function commentDelTool (deps) {
  const parameters = objectSchema({
    bvid: BVID,
    oid: OID,
    type: COMMENT_TYPE,
    rpid: { type: 'string', pattern: '^[0-9]+$', description: '要删的评论 rpid（只能删自己的，或自己管理的评论区下的）。必填。' }
  }, ['rpid'], { anyOf: [{ required: ['bvid'] }, { required: ['oid'] }] })
  async function run (args) {
    const target = await resolveOid(deps, args)
    if (target.error !== undefined) return target.error
    return commentApi.del(deps, { oid: target.oid, type: args.type, rpid: args.rpid })
  }
  function text (data) {
    return '✓ 已删除 rpid=' + data.rpid + '（oid ' + data.oid + '）'
  }
  return makeTool(
    'bili_comment_del',
    '删掉自己发的一条评论（POST /x/v2/reply/del）。只能删自己的，或自己管理的评论区里的。'
      + '能做什么：给 bvid/oid + rpid 就能删。'
      + '不能做什么：删不了别人的评论（会回 -403）；这一步不过写通道的 token 预算闸（它是撤回，不是发言），但仍然会打真实请求。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 8. bili_dm ────────────────────────── */

function dmTool (deps) {
  // 注意：这里**没有** mid/uid/receiver 参数，而且永远不会加。
  // 收件人恒等于 deps.owner.mid —— 需求硬限制（PROMPT §6.3），不是配置。
  const parameters = objectSchema({
    text: { type: 'string', minLength: 1, maxLength: 300, description: '私信正文（1-300 字）。必填。收件人固定是主人，没有也不接受任何 mid/uid 参数。' }
  }, ['text'])
  async function run (args) {
    return messageApi.send(deps, { text: args.text })
  }
  function text (data) {
    return '✓ 已发给主人 ' + (data.toName || '') + '（mid ' + data.to + '）· ' + data.length + ' 字\n  ' + short(data.text)
  }
  return makeTool(
    'bili_dm',
    '给主人发一条站内私信（api.vc.bilibili.com web_im/send_msg）。'
      + '⚠️ 收件人是写死的：只能发给主人（设置里的 owner.mid），参数里没有 mid/uid，传了也不会被采用 ——'
      + '这是需求里的硬限制，不是可配置项。owner.mid 为空时直接返回 reason=owner-only，一条请求都不发。'
      + '能做什么：正文 1-300 字，发前先过 token 预算闸（按已花 token 计，不分读写）与私信间隔（dmGapSec）；预算用尽时返回 reason=token-budget-exhausted，读通道仍可用。'
      + '不能做什么：不能发给任何其他人、不能群发、不能带附件、不能发给自己（B站 不允许）。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 9. bili_dm_inbox ────────────────────────── */

function dmInboxTool (deps) {
  const parameters = objectSchema({
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: '读最近多少条（1-50，默认 20）。' },
    unreadOnly: {
      type: 'boolean',
      default: false,
      description: 'true = 只留「本次会话里还没读过」的消息（本插件不写状态文件，所以「已读」只活在当前进程里，重启就会全算成没读）。'
    }
  }, [])
  async function run (args) {
    return messageApi.inbox(deps, { limit: args.limit, unreadOnly: args.unreadOnly === true })
  }
  function text (data) {
    const lines = ['和主人的会话（' + (data.talkerName || '?') + ' / mid ' + data.talker + '）：' + data.count + ' 条 · 来源 ' + data.source]
    if (data.note) lines.push('⚠️ ' + data.note)
    for (const item of data.items) {
      lines.push('· ' + (item.time || '?') + ' ' + (item.from === 'owner' ? '主人' : '我') + '：' + short(item.text))
    }
    if (data.count === 0) lines.push('（没有新消息）')
    return lines.join('\n')
  }
  return makeTool(
    'bili_dm_inbox',
    '读和主人的私信会话（api.vc.bilibili.com fetch_session_msgs）。'
      + '能做什么：读最近 N 条，标出每条是主人发的还是我发的。'
      + '不能做什么：读不了别人的会话（私信通道只认主人）；私信接口读不通时会退一步读「回复我的」通知，'
      + '并在结果的 source/note 里写明换了语义，不会假装那是私信正文。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 10. bili_dynamic ────────────────────────── */

function dynamicTool (deps) {
  const parameters = objectSchema({
    text: { type: 'string', minLength: 1, maxLength: 1000, description: '动态正文（1-1000 字，B站 硬限）。必填。' },
    images: {
      type: 'array',
      maxItems: 9,
      items: { type: 'string' },
      description: '最多 9 张图。每项可以是本地图片绝对路径（工具会先上传到 B站 CDN 再发），也可以是已经上传好的 img_src 网址。默认不发图。'
    }
  }, ['text'])
  async function run (args) {
    return dynamicApi.create(deps, { text: args.text, images: Array.isArray(args.images) ? args.images : [] })
  }
  function text (data) {
    return '✓ 动态已发布 dynId=' + data.dynId + (data.pics > 0 ? '（带 ' + data.pics + ' 张图）' : '') + '\n  ' + data.url + '\n  ' + short(data.text)
  }
  return makeTool(
    'bili_dynamic',
    '发一条动态（POST /x/dynamic/feed/create/dyn，带图时先 POST upload_bfs 换 CDN 地址）。'
      + '能做什么：正文 1-1000 字，最多 9 张图。'
      + '写操作：先过 token 预算闸（不分读写），再过写间隔；预算用尽时返回 reason=token-budget-exhausted，读通道仍可用；闸不放行就一张图都不传、一条请求都不发。'
      + '不能做什么：不能发视频、不能发专栏、不能定时发、不能删动态（删除没做，因为它是另一个写通道，不在本期清单里）。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 11. bili_dynamic_edit ────────────────────────── */

function dynamicEditTool (deps) {
  const parameters = objectSchema({
    dynId: { type: 'string', pattern: '^[0-9]+$', description: '要编辑的动态 id（纯数字串）。必填。' },
    text: { type: 'string', minLength: 1, maxLength: 1000, description: '新的正文（1-1000 字）。必填。原来的图会被原样保留（编辑是全量覆盖，所以工具先读一次详情把图带上）。' }
  }, ['dynId', 'text'])
  async function run (args) {
    return dynamicApi.edit(deps, { dynId: args.dynId, text: args.text })
  }
  function text (data) {
    return '✓ 动态已改 dynId=' + data.dynId + (data.pics > 0 ? '（保留 ' + data.pics + ' 张图）' : '') + '\n  ' + data.url + '\n  ' + short(data.text)
  }
  return makeTool(
    'bili_dynamic_edit',
    '改一条已发动态的正文（POST /x/dynamic/feed/edit/dyn）。'
      + '能做什么：给 dynId + 新正文。工具会先读一次详情，把原来的图片原样带上，避免把图弄丢。'
      + '写操作：先过 token 预算闸（不分读写），再过写间隔；预算用尽时返回 reason=token-budget-exhausted，读通道仍可用，闸不放行就不发。'
      + '不能做什么：改不了别人发的动态、改不了图片（只能保留或全丢，加图要用 bili_dynamic 重发）。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 12. bili_favorite ────────────────────────── */

function favoriteTool (deps) {
  const parameters = objectSchema({
    bvid: BVID,
    add: { type: 'boolean', default: true, description: 'true（默认）= 收进默认收藏夹；false = 从默认收藏夹取消收藏。' }
  }, ['bvid'])
  async function run (args) {
    return favoriteApi.deal(deps, { bvid: args.bvid, add: args.add !== false })
  }
  function text (data) {
    return (data.add ? '✓ 已收藏 ' : '✓ 已取消收藏 ') + data.bvid + '「' + short(data.title) + '」→ 收藏夹「' + data.folder.title + '」（media_id ' + data.folder.id + '）'
  }
  return makeTool(
    'bili_favorite',
    '收藏 / 取消收藏一条视频（POST /x/v3/fav/resource/deal）。'
      + '能做什么：给 bvid + add（默认 true 收藏、false 取消）就能动默认收藏夹；收藏夹 id 由工具自己查。'
      + '写操作：先过 token 预算闸（不分读写），再过写间隔；预算用尽时返回 reason=token-budget-exhausted，读通道仍可用，闸不放行就不发。'
      + '不能做什么：只能动「默认收藏夹」（标题里带「默认」的那个），不能指定别的收藏夹、不能建收藏夹、不能移出单条历史记录。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 13. bili_fav_list ────────────────────────── */

function favListTool (deps) {
  const parameters = objectSchema({}, [])
  async function run () {
    return favoriteApi.folders(deps)
  }
  function text (data) {
    const lines = ['收藏夹 ' + data.count + ' 个（up_mid ' + data.mid + '，默认 media_id ' + data.defaultId + '）']
    for (const item of data.items) lines.push('· ' + item.id + '  ' + item.title + '  ' + item.mediaCount + ' 条' + (item.isDefault ? '  ← 默认' : ''))
    if (data.count === 0) lines.push('（这个号还没有任何收藏夹）')
    return lines.join('\n')
  }
  return makeTool(
    'bili_fav_list',
    '列出这个账号的收藏夹（GET /x/v3/fav/folder/created/list-all）：media_id、名字、里面有多少条、哪个是默认。'
      + '能做什么：只读，不需要参数。'
      + '不能做什么：不列收藏夹里的具体视频（本期没做这个读端点）、不改收藏夹、不建收藏夹。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 14. bili_like ────────────────────────── */

function likeTool (deps) {
  const parameters = objectSchema({
    bvid: BVID,
    action: {
      type: 'string',
      enum: ['like', 'unlike'],
      default: 'like',
      description: 'like（默认）= 点赞；unlike = 取消点赞。'
    }
  }, ['bvid'])
  async function run (args) {
    return relationApi.like(deps, { bvid: args.bvid, action: args.action })
  }
  function text (data) {
    return (data.action === 'like' ? '✓ 已点赞 ' : '✓ 已取消点赞 ') + data.bvid + '（av' + data.aid + '）  ' + data.url
  }
  return makeTool(
    'bili_like',
    '给一条视频点赞 / 取消点赞（POST /x/web-interface/archive/like，表单 aid + like=1|0）。'
      + '能做什么：只认 bvid + action（like/unlike），不能指定别的目标类型；aid 由工具用 bvid 查 view 换出来。'
      + '写操作：先过 token 预算闸（不分读写），再过写间隔；预算用尽时返回 reason=token-budget-exhausted，读通道仍可用，闸不放行就不发。'
      + '⚠️ 这是 7 条写通道里**唯一没在真机验证过**的一条（参考实现里没有点赞视频的写通道）——'
      + '它失败时优先怀疑端点本身，而不是先怀疑参数。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 15. bili_status ────────────────────────── */

/** token 数说成人话：>= 1 万就说「万」，免得一屏 7 位数看不出量级。 */
function tokenText (value) {
  const n = num(value, 0)
  if (n < 10000) return String(Math.round(n))
  const wan = Math.round((n / 10000) * 10) / 10
  return String(wan).replace(/\.0$/, '') + ' 万'
}

/**
 * quota 状态 → 只留「token 用量」这一种口径（INTERFACE §11：额度按花费 token 计，不分读写）。
 * 内核 tokenStatus() 直接回 { hour, day, source, sampledAt, file }，也接受包一层 tokens 的形状；
 * 两种都认，认不出 token 口径就回 tokens:null（bili_status 会显示「来源：不可用」，而不是瞎报写次数）。
 * 写次数（旧的 writeHourly/writeDaily）已废弃：拿到旧形状时只标注「已废弃」，不再当成额度展示。
 */
function quotaView (status) {
  const raw = status !== undefined && status !== null && typeof status === 'object' ? status : {}
  const box = raw.tokens !== undefined && raw.tokens !== null && typeof raw.tokens === 'object' ? raw.tokens : null
  const source = box !== null ? box : null
  const window = (value) => {
    const w = value !== undefined && value !== null && typeof value === 'object' ? value : {}
    return { used: num(w.used, 0), limit: num(w.limit, 0) }
  }
  const looksToken = box !== null || raw.source !== undefined || raw.sampledAt !== undefined || raw.file !== undefined
  const view = {
    tokens: looksToken
      ? {
        hour: window(source === null ? raw.hour : source.hour),
        day: window(source === null ? raw.day : source.day),
        source: str((source === null ? raw.source : source.source)) || 'unavailable'
      }
      : null,
    writeGapLeftSec: num(raw.writeGapLeftSec, 0),
    dmGapLeftSec: num(raw.dmGapLeftSec, 0),
    legacyCountsDeprecated: false,
    note: ''
  }
  // 旧形状（只有写次数窗口、没有 token 来源）→ 明确标注废弃，别让模型以为次数还是额度
  if (view.tokens === null && (raw.hour !== undefined || raw.day !== undefined)) view.legacyCountsDeprecated = true
  return view
}

function statusTool (deps) {
  const parameters = objectSchema({}, [])
  async function run () {
    const client = deps === undefined || deps === null ? undefined : deps.client
    const owner = deps === undefined || deps === null ? {} : (deps.owner || (deps.config && deps.config.owner) || {})
    const out = {
      owner: { mid: str(owner.mid), name: str(owner.name) },
      client: { available: client !== undefined && client !== null, banned: false, banMinutesLeft: 0, banWhy: '', cacheEntries: 0 },
      login: { ok: false, mid: '', uname: '', note: '' },
      quota: null,
      credential: { present: false, hasSessdata: false, hasJct: false, jctLooksValid: false, note: '' },
      capabilities: capabilityIds(deps),
      config: {}
    }
    // 凭据状态：只报「有没有 / 形状像不像」，绝不回显任何值（PROMPT §7）。
    // 为什么看 jct 形状而不只看「有没有」：截断/粘错的 bili_jct 一样会被 B站 回 -111，
    // 而只读接口照常工作 —— 那种状态下「登录看着正常但发不出东西」最难查。
    if (client !== undefined && client !== null && typeof client.cred === 'function') {
      try {
        const cred = client.cred() || {}
        const jct = str(cred.bili_jct)
        out.credential.present = true
        out.credential.hasSessdata = str(cred.sessdata) !== ''
        out.credential.hasJct = jct !== ''
        out.credential.jctLooksValid = /^[0-9a-f]{32}$/i.test(jct)
        if (!out.credential.hasSessdata) out.credential.note = '缺 SESSDATA：读接口会被当成未登录'
        else if (!out.credential.hasJct) out.credential.note = '缺 bili_jct：所有写操作会被 B站 回 -111'
        else if (!out.credential.jctLooksValid) out.credential.note = 'B站 的 bili_jct 目前是 32 位十六进制 → 写操作大概率 -111，回设置页重粘一次'
      } catch (error) {
        out.credential.present = false
        out.credential.note = '凭据文件读不到：' + short(error && error.message ? error.message : error)
      }
    } else {
      out.credential.note = '客户端没有暴露 cred()，凭据状态未知'
    }
    if (client !== undefined && client !== null && typeof client.state === 'function') {
      try {
        const state = client.state() || {}
        out.client.banned = state.banned === true
        out.client.banMinutesLeft = num(state.banMinutesLeft, 0)
        out.client.banWhy = str(state.banWhy)
        out.client.cacheEntries = num(state.cacheEntries, 0)
      } catch (error) {
        out.client.note = 'client.state() 抛了异常：' + short(error && error.message ? error.message : error)
      }
    }
    if (client !== undefined && client !== null && typeof client.nav === 'function') {
      try {
        const nav = await client.nav()
        const data = nav && nav.data ? nav.data : {}
        out.login = {
          ok: nav !== undefined && nav !== null && nav.code === 0 && data.isLogin !== false,
          mid: str(data.mid),
          uname: str(data.uname),
          note: nav !== undefined && nav !== null && nav.code !== 0 ? 'nav code=' + nav.code + ' ' + short(nav.message) : ''
        }
      } catch (error) {
        out.login = { ok: false, mid: '', uname: '', note: 'nav() 抛了异常：' + short(error && error.message ? error.message : error) }
      }
    } else {
      out.login.note = '客户端没有 nav()'
    }
    const quota = deps === undefined || deps === null ? undefined : deps.quota
    if (quota !== undefined && quota !== null) {
      const read = typeof quota.status === 'function' ? quota.status : (typeof quota.quotaStatus === 'function' ? quota.quotaStatus : null)
      if (read !== null) {
        try {
          out.quota = quotaView(read.call(quota, deps.config))
        } catch (error) {
          out.quota = { tokens: null, note: '读用量状态失败：' + short(error && error.message ? error.message : error) }
        }
      } else {
        out.quota = { tokens: null, note: '配额模块没有暴露状态查询（只有 gate/record）' }
      }
    } else {
      out.quota = { tokens: null, note: '配额模块没装配' }
    }
    const config = deps === undefined || deps === null ? {} : deps.config
    if (config !== undefined && config !== null && typeof config === 'object') {
      out.config = {
        risk: config.risk === undefined || config.risk === null ? {} : config.risk,
        paths: config.paths === undefined || config.paths === null ? {} : config.paths
      }
    }
    return { ok: true, data: out }
  }
  function text (data) {
    const lines = ['B站 账号：' + (data.login.ok ? (data.login.uname || '?') + '（mid ' + data.login.mid + '）' : '未登录 / 未知')]
    if (data.login.note) lines.push('  登录说明：' + data.login.note)
    lines.push('主人：' + (data.owner.name || '?') + '（mid ' + (data.owner.mid || '未配置') + '）')
    const credential = data.credential === undefined || data.credential === null ? {} : data.credential
    lines.push('凭据：' + (credential.present ? '已读到' : '读不到')
      + ' · SESSDATA ' + (credential.hasSessdata ? '有' : '缺')
      + ' · bili_jct ' + (credential.hasJct ? (credential.jctLooksValid ? '有且形状合法' : '有但形状不像') : '缺')
      + (credential.note ? '（' + credential.note + '）' : ''))
    lines.push('风控：' + (data.client.banned ? '熔断中，还要等 ' + data.client.banMinutesLeft + ' 分钟（' + (data.client.banWhy || '原因未记录') + '）' : '没有熔断') + ' · 缓存条目 ' + data.client.cacheEntries)
    const quota = data.quota === null || data.quota === undefined ? {} : data.quota
    const tokens = quota.tokens === undefined || quota.tokens === null ? null : quota.tokens
    if (tokens === null) {
      lines.push('token 用量：来源：不可用' + (quota.note ? '（' + quota.note + '）' : '') + ' —— 读不到用量账本时不拦写（INTERFACE §11 fail-open）')
    } else {
      const hour = tokens.hour === undefined ? {} : tokens.hour
      const day = tokens.day === undefined ? {} : tokens.day
      const source = tokens.source === 'ledger' ? '账本' : (tokens.source === 'unavailable' ? '不可用' : (tokens.source || '未知'))
      lines.push('token 用量：本小时 ' + tokenText(hour.used) + ' / ' + tokenText(hour.limit)
        + ' · 今天 ' + tokenText(day.used) + ' / ' + tokenText(day.limit) + '（来源：' + source + '）')
      lines.push('写间隔：距上次写还有 ' + num(quota.writeGapLeftSec, 0) + 's · 距上次私信还有 ' + num(quota.dmGapLeftSec, 0) + 's')
    }
    if (quota.legacyCountsDeprecated === true) lines.push('写次数配额：已废弃，不再作为额度（只保留写间隔与 token 预算）')
    lines.push('可用能力：' + (data.capabilities.length === 0 ? '（一个都没有 —— 内容理解类能力要另外的插件注册）' : data.capabilities.join(', ')))
    lines.push('客户端：' + (data.client.available ? '可用' : '没装配（工具会直接报错）'))
    return lines.join('\n')
  }
  return makeTool(
    'bili_status',
    '账号状态一屏汇总：登录态（nav）、凭据状态（有没有 SESSDATA / bili_jct，jct 形状像不像）、风控熔断状态与缓存条目（client.state）、token 用量（本小时/今天 已用与上限，来源账本）、写间隔余量、可用能力 id 列表、主人配置。'
      + '能做什么：只读、无参数。看不清「为什么发不出去」时先看这个 —— 熔断中还是配额满了，一眼就分得开。'
      + '不能做什么：不改任何配置、不重置配额、不重登（这些在设置页做）。'
      + '如果「可用能力」是空的，说明 video.understand 这类内容理解能力还没有插件注册，bili_watch 的 deep 就用不了。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 16. bili_replies ────────────────────────── */

function repliesTool (deps) {
  const parameters = objectSchema({
    oid: OID,
    root: { type: 'string', pattern: '^[0-9]+$', description: '楼层根评论的 rpid（主楼那一条）。必填 —— 楼中楼是挂在它下面的。' },
    page: { type: 'integer', minimum: 1, maximum: 50, default: 1, description: '页码（1-50，默认 1）。一页 20 条。' }
  }, ['oid', 'root'])
  async function run (args) {
    return commentApi.replies(deps, { oid: args.oid, root: args.root, page: args.page })
  }
  function text (data) {
    const lines = ['楼中楼 ' + data.count + ' 条（oid ' + data.oid + ' / root ' + data.root + ' / 第 ' + data.page + ' 页）']
    if (data.rootComment !== null && data.rootComment !== undefined) lines.push('主楼：' + short(data.rootComment.text))
    for (const item of data.items) {
      lines.push('· rpid=' + item.rpid + ' ♥' + item.like + ' ' + (item.user || '匿名') + '（mid ' + item.mid + '）')
      lines.push('  ' + short(item.text))
    }
    if (data.count === 0) lines.push('（这一层没有更多回复）')
    return lines.join('\n')
  }
  return makeTool(
    'bili_replies',
    '读一层楼中楼（GET /x/v2/reply/reply）：给主楼 rpid，把挂在它下面的回复按页拉出来，每条带 rpid / 作者 mid / 点赞 / 正文。'
      + '能做什么：只读，配合 bili_comments 用 —— bili_comments 只内嵌前几条，整串要来这里拉。'
      + '不能做什么：不改不删不回复（回复用 bili_reply）；不会自动翻完所有页，要自己加 page。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 17. bili_comment_top ────────────────────────── */

function commentTopTool (deps) {
  const parameters = objectSchema({
    bvid: BVID,
    oid: OID,
    type: COMMENT_TYPE,
    rpid: { type: 'string', pattern: '^[0-9]+$', description: '要置顶/取消置顶的评论 rpid。必填。' },
    action: {
      type: 'string',
      enum: ['pin', 'unpin'],
      default: 'pin',
      description: 'pin（默认）= 设为置顶；unpin = 取消置顶。'
    }
  }, ['rpid'], { anyOf: [{ required: ['bvid'] }, { required: ['oid'] }] })
  async function run (args) {
    const target = await resolveOid(deps, args)
    if (target.error !== undefined) return target.error
    return commentApi.top(deps, { oid: target.oid, type: args.type, rpid: args.rpid, action: args.action })
  }
  function text (data) {
    return (data.action === 'set' ? '✓ 已置顶 rpid=' : '✓ 已取消置顶 rpid=') + data.rpid + '（oid ' + data.oid + '）'
  }
  return makeTool(
    'bili_comment_top',
    '置顶 / 取消置顶一条评论（POST /x/v2/reply/top，action=1 置顶、0 取消）。'
      + '能做什么：给 bvid/oid + rpid + action（pin/unpin）。只能置顶一级评论、且只能在自己管理的评论区里。'
      + '写操作：先过 token 预算闸（不分读写），再过写间隔；预算用尽时返回 reason=token-budget-exhausted，读通道仍可用，闸不放行就不发。'
      + '不能做什么：置顶不了别人的一级评论之外的层级（会回 12030）、一个评论区同时只能有一条置顶（已有会回 12029）。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 18. bili_dynamic_detail ────────────────────────── */

function dynamicDetailTool (deps) {
  const parameters = objectSchema({
    dynId: { type: 'string', pattern: '^[0-9]+$', description: '动态 id（纯数字串）。必填。' }
  }, ['dynId'])
  async function run (args) {
    return dynamicApi.detail(deps, { dynId: args.dynId })
  }
  function text (data) {
    const item = data.item === null || data.item === undefined ? {} : data.item
    const lines = ['动态 ' + data.dynId + (item.author ? '  @' + item.author.name + '（mid ' + item.author.mid + '）' : '')]
    if (item.pubTime) lines.push('时间：' + item.pubTime)
    if (item.text) lines.push('正文：' + short(item.text))
    const pics = Array.isArray(item.pics) ? item.pics : []
    if (pics.length > 0) lines.push('图 ' + pics.length + ' 张')
    if (item.stat !== undefined && item.stat !== null) lines.push('评论 ' + item.stat.comment + ' · 点赞 ' + item.stat.like)
    if (item.url) lines.push(item.url)
    return lines.join('\n')
  }
  return makeTool(
    'bili_dynamic_detail',
    '读一条动态的详情（GET /x/polymer/web-dynamic/v1/detail）：作者、时间、正文、图片、评论/点赞数、链接。'
      + '能做什么：只读，给 dynId 就行；bili_dynamic_edit 也用这条数据保住原图。'
      + '不能做什么：不读评论列表（动态的评论区用 bili_comments 的 oid+type=11/17）、不改不删。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 19. bili_dynamic_top ────────────────────────── */

function dynamicTopTool (deps) {
  const parameters = objectSchema({
    dynId: { type: 'string', pattern: '^[0-9]+$', description: '要置顶/取消置顶的动态 id。必填。' },
    action: {
      type: 'string',
      enum: ['pin', 'unpin'],
      default: 'pin',
      description: 'pin（默认）= 置顶到个人空间；unpin = 取消置顶（走 rm_top 端点）。'
    }
  }, ['dynId'])
  async function run (args) {
    return dynamicApi.setTop(deps, { dynId: args.dynId, action: args.action })
  }
  function text (data) {
    return (data.action === 'unpin' ? '✓ 已取消置顶动态 ' : '✓ 已置顶动态 ') + data.dynId
  }
  return makeTool(
    'bili_dynamic_top',
    '置顶 / 取消置顶一条自己发的动态（set_top / rm_top，正文 JSON、csrf 在 query）。'
      + '能做什么：给 dynId + action（pin/unpin）。'
      + '写操作：先过 token 预算闸（不分读写），再过写间隔；预算用尽时返回 reason=token-budget-exhausted，读通道仍可用，闸不放行就不发。'
      + '不能做什么：置顶不了别人的动态；一条动态被置顶期间要换人得先 unpin。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 20. bili_image_upload ────────────────────────── */

function imageUploadTool (deps) {
  const parameters = objectSchema({
    path: { type: 'string', minLength: 1, description: '本地图片的绝对路径（png/jpg）。必填。工具会读盘后上传，不下载任何东西。' }
  }, ['path'])
  async function run (args) {
    return dynamicApi.uploadImage(deps, { path: args.path })
  }
  function text (data) {
    const pic = data.pic === undefined || data.pic === null ? {} : data.pic
    return '✓ 已上传：' + pic.img_src + '（' + pic.img_width + 'x' + pic.img_height + '）\n  可以把它作为 bili_dynamic 的 images 项传进去'
  }
  return makeTool(
    'bili_image_upload',
    '把一张本地图片传到 B站 图床（POST /x/dynamic/feed/draw/upload_bfs，multipart，字段 file_up + category=daily），拿回 img_src。'
      + '能做什么：给本地绝对路径，返回 { img_src, img_width, img_height }；bili_dynamic 的 images 也可以直接给路径，它会替你调这里。'
      + '上传到 B站 图床，会消耗请求额度（但不过写通道的 token 预算闸：它不产出公开内容）。'
      + '不能做什么：不下载、不压缩、不裁剪；尺寸太离谱会被 B站 拒（code=4125014）；路径不存在会直接 bad-argument 且零请求。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 21. bili_playurl ────────────────────────── */

function playurlTool (deps) {
  const parameters = objectSchema({
    bvid: BVID,
    cid: { type: 'integer', minimum: 1, description: '分 P 的 cid。不给就用第一段（工具会先查一次 view 取 cid）。' },
    qn: { type: 'integer', minimum: 1, maximum: 120, default: 80, description: '清晰度代码（80=1080P，64=720P，32=480P，默认 80）。实际给到什么看账号权限。' }
  }, ['bvid'])
  async function run (args) {
    return videoApi.playurl(deps, { bvid: args.bvid, cid: args.cid, qn: args.qn })
  }
  function text (data) {
    const urls = Array.isArray(data.urls) ? data.urls : []
    const lines = ['播放地址：' + data.bvid + ' cid=' + data.cid + ' 实际清晰度 ' + data.quality
      + '（可接受 ' + (Array.isArray(data.acceptDescription) ? data.acceptDescription.join(' / ') : '?') + '）']
    for (const u of urls) lines.push('· 片段 ' + u.order + '  ' + (u.size ? Math.round(u.size / 1048576) + 'MB  ' : '') + u.url)
    if (data.dash !== null && data.dash !== undefined) {
      lines.push('DASH：视频 ' + (data.dash.video ? data.dash.video.length : 0) + ' 轨 / 音频 ' + (data.dash.audio ? data.dash.audio.length : 0) + ' 轨')
    }
    lines.push('⚠️ 这些是带时效的直链（过期就 403），别缓存、别跨会话复用。')
    return lines.join('\n')
  }
  return makeTool(
    'bili_playurl',
    '取一条视频的播放地址（GET /x/player/wbi/playurl，WBI 签名由客户端负责）。'
      + '能做什么：给 bvid（可选 cid / qn），返回直链与清晰度列表；不给 cid 时自动用第一段。'
      + '返回的是带时效的直链，别缓存复用 —— 过期会被 403，重取一次即可。'
      + '不能做什么：不下载、不转码、不解码 DASH（只把轨列出来）；不保证拿到 1080P 以上（那看账号权限）。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 22. bili_user_info ────────────────────────── */

function userInfoTool (deps) {
  const parameters = objectSchema({
    mid: { type: 'string', pattern: '^[0-9]+$', description: '用户 UID（纯数字串，例如 389989266）。必填。' }
  }, ['mid'])
  async function run (args) {
    return userApi.info(deps, { mid: args.mid })
  }
  function text (data) {
    const lines = [(data.name || '(无名)') + '（mid ' + data.mid + '）' + (data.level ? '  Lv' + data.level : '')]
    if (data.sign) lines.push('签名：' + short(data.sign))
    if (data.fans !== undefined) lines.push('粉丝 ' + data.fans + ' · 关注 ' + (data.following === undefined ? '?' : data.following))
    if (data.statNote) lines.push('（' + data.statNote + '）')
    if (data.face) lines.push('头像：' + data.face)
    lines.push(data.url)
    return lines.join('\n')
  }
  return makeTool(
    'bili_user_info',
    '取一个用户的空间资料（GET /x/space/wbi/acc/info，**必须 WBI 签名**，客户端已按 opts.wbi=true 处理）。'
      + '能做什么：给 mid 拿昵称 / 头像 / 签名 / 等级 / 粉丝数 / 关注数 / 空间链接。'
      + '字段缺失就省略（粉丝数取不到时会明说「没读到」，不会给一个假的 0）。'
      + '不能做什么：不读 TA 的投稿列表、不读动态、不改任何东西。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 23. bili_relation ────────────────────────── */

function relationTool (deps) {
  const parameters = objectSchema({
    mid: { type: 'string', pattern: '^[0-9]+$', description: '对方 UID（纯数字串）。必填。' }
  }, ['mid'])
  async function run (args) {
    return relationApi.relation(deps, { mid: args.mid })
  }
  function text (data) {
    const lines = ['和 mid ' + data.mid + ' 的关系：' + data.meaning + '（attribute=' + data.attribute + '）']
    lines.push('我关注 TA：' + (data.following ? '是' : '否') + ' · TA 关注我：' + (data.followedBy === null ? '未知' : (data.followedBy ? '是' : '否')) + ' · 互关：' + (data.mutual ? '是' : '否'))
    if (data.blocked) lines.push('⚠️ 存在拉黑关系，先查双方黑名单')
    lines.push(data.url)
    return lines.join('\n')
  }
  return makeTool(
    'bili_relation',
    '查和某个用户的关系（GET /x/relation?fid=<mid>）：单向关注 / 互关 / 拉黑都在 attribute 里。'
      + '能做什么：只读，给 mid；能判断「能不能发私信」的前置条件（B站 要求互关）之一。'
      + '不能做什么：不关注也不取关（用 bili_follow）、不读对方主页内容。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 24. bili_follow ────────────────────────── */

function followTool (deps) {
  const parameters = objectSchema({
    mid: { type: 'string', pattern: '^[0-9]+$', description: '要关注 / 取关的用户 UID（纯数字串）。必填。' },
    action: {
      type: 'string',
      enum: ['follow', 'unfollow'],
      default: 'follow',
      description: 'follow（默认）= 关注；unfollow = 取消关注。'
    }
  }, ['mid'])
  async function run (args) {
    return relationApi.modify(deps, { mid: args.mid, action: args.action })
  }
  function text (data) {
    return (data.action === 'unfollow' ? '✓ 已取关 mid ' : '✓ 已关注 mid ') + data.mid + '\n  ' + data.url
  }
  return makeTool(
    'bili_follow',
    '关注 / 取关一个用户（POST /x/relation/modify，表单 fid + act=1 关注 / 2 取关 + re_src=11）。'
      + '能做什么：给 mid + action（follow/unfollow）。'
      + '写操作：先过 token 预算闸（不分读写），再过写间隔；预算用尽时返回 reason=token-budget-exhausted，读通道仍可用，闸不放行就不发。'
      + '不能做什么：不能关注自己（B站 会回错）、不能批量关注、不能顺手发私信（私信只能发给主人，见 bili_dm）。',
    parameters,
    run,
    text
  )
}

/* ────────────────────────── 装配 ────────────────────────── */

/* ────────────────────────── 25. bili_at_me ────────────────────────── */

// 逻辑全在 lib/api/message.js 的 atMe()：信封（code→ok）与形状解析都属于 api 层。
// 工具层只留参数说明与文本渲染 —— 真机那次 100% 失败，正是因为工具层自己判断了信封。
function atMeTool (deps) {
  const parameters = objectSchema({
    limit: { type: 'integer', minimum: 1, maximum: 10, default: 5, description: '要几条（1-10，默认 5）。' }
  })
  async function run (args) {
    return messageApi.atMe(deps, { limit: args === undefined || args === null ? 5 : args.limit })
  }
  function text (data) {
    if (data.count === 0) return '（没有新的 @）'
    const lines = ['@我的 ' + data.count + ' 条']
    for (const item of data.items) {
      lines.push('· id=' + item.id + ' ' + (item.uname || '某人') + '（mid ' + (item.mid || '?') + '）' + (item.at === '' ? '' : ' ' + item.at))
      lines.push('  ' + short(item.text))
    }
    return lines.join(String.fromCharCode(10))
  }
  return makeTool(
    'bili_at_me',
    '读「谁 @ 我了」（GET /x/msgfeed/at）：每条带 id / 作者 mid 与昵称 / 时间 / 类型（comment·dynamic·video·other）/ 正文前 120 字，'
      + '以及能解析出来的 oid / root / rpid / bvid（解析不出的字段会省略，不会编）。'
      + '能做什么：只读，用来判断有人 @ 我该不该回。不能做什么：不回、不删、不标记已读；一次只读一页（1-10 条）。',
    parameters,
    run,
    text
  )
}

/**
 * 造 25 个工具（第一批 15 + 第二批 9 + 第三批 1）。deps = { client, config, quota, capabilities, owner, log }（INTERFACE §8）。
 * 这里**不查 deps 完不完整**：缺哪块由各 api 函数在自己那一步报结构化失败，
 * 装配期就抛异常会让整个插件装不上，而「配额没装配」这种情况恰恰应该只让写通道失效。
 */
export function buildTools (deps) {
  const d = deps === undefined || deps === null ? {} : deps
  return [
    watchTool(d),
    videoInfoTool(d),
    searchTool(d),
    commentsTool(d),
    commentTool(d),
    replyTool(d),
    commentDelTool(d),
    dmTool(d),
    dmInboxTool(d),
    dynamicTool(d),
    dynamicEditTool(d),
    favoriteTool(d),
    favListTool(d),
    likeTool(d),
    statusTool(d),
    repliesTool(d),
    commentTopTool(d),
    dynamicDetailTool(d),
    dynamicTopTool(d),
    imageUploadTool(d),
    playurlTool(d),
    userInfoTool(d),
    relationTool(d),
    followTool(d),
    atMeTool(d)
  ]
}
