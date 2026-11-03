// tests/at-me.test.mjs —— 第 25 个工具 bili_at_me（@我的）+ §24.2/24.3 的自主层判据
//
// 为什么这样测：
//   这一条同时踩两条边界，所以分两层测：
//     ① 工具层：形状（ok/count/items + data 里同名两份）、type 映射、坐标「解析不出就省略」、
//        正文 120 字截断、失败不抛、**绝不过写闸**、请求参数与 limit 夹取；
//     ② 自主层：新 @ → 回一条（坐标必须三件齐）、只解析出 oid → 宁可不回并写清原因、
//        开关关掉 → 连读都不读、评论回复必须 parent 指向她（不许在别人的对话里插嘴）、
//        以及 30 分钟节流把两条读通道一起挡住。
//   全部假客户端 / 假工具 + 临时 self 目录，零真实网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

const BASE_METRICS = { energy: 60, mood: 55, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 }

function atEnv (tag) {
  const root = tmpDir(tag)
  const restoreSandbox = sandboxEnv(root)
  const restoreSelf = setEnv({ DSH_BILI_SELF_DIR: path.join(root, 'self') })
  fs.mkdirSync(path.join(root, 'self'), { recursive: true })
  return { root, selfDir: path.join(root, 'self'), restore () { restoreSelf(); restoreSandbox(); cleanupTmp() } }
}

function tool (name, handler = () => ({ ok: true, data: {} })) {
  const t = { name, description: '桩', calls: [], async execute (args) { t.calls.push(args ?? {}); return handler(args ?? {}) } }
  return t
}

function fakeLlm (decision) {
  return { calls: 0, async *stream () { this.calls += 1; yield { type: 'text-delta', text: JSON.stringify(decision) }; yield { type: 'finish', reason: { kind: 'ok' } } } }
}

async function primeSchedule (over = {}) {
  const schedule = await import(repoUrl('lib/core/schedule.js'))
  schedule.unlock()
  const saved = schedule.saveSchedule({
    enabled: true, windows: [{ start: '00:00', end: '24:00' }],
    allows: { read: true, comment: true, dm: true, reply: true },
    minWatchPerWake: false, commentAfterWatch: false, bedtimeReport: false,
    ...over
  })
  assert.equal(saved.ok, true, '前提：日程必须写成功，实际 ' + JSON.stringify(saved))
  return schedule
}

async function seedState (patch = {}) {
  const { patchState } = await import(repoUrl('lib/core/state.js'))
  patchState({
    counters: {}, silenceUntil: 0, metrics: { ...BASE_METRICS },
    seenAtMeIds: [], seenReplyRpids: [], myComments: [], selfMid: '', lastReplyCheckAt: '', lastWatchedBvid: '', commentedBvids: [],
    ...patch
  })
}

/** 造 bili_at_me 的假客户端数据（按 §24.1 的真实字段形状）。 */
const LONG = 'x'.repeat(200)

/* ══════════════════════════ 1. 工具形状 / 类型映射 / 坐标省略 ══════════════════════════ */

test('bili_at_me 形状（按真机样本）：mid/uname/type/text/bvid/oid/root/rpid 全对，root_id=0 时 root 回落 source_id', async () => {
  const env = atEnv('at-shape')
  try {
    const { buildTools } = await import(repoUrl('lib/tools/index.js'))
    // 2026-11-02 真机样本（master）：作者在 item.user，业务字段在 item.item
    const MASTER = {
      id: 1193625643966466,
      user: { mid: 389989266, nickname: '往生堂七七代堂主' },
      at_time: 1793625657,
      item: {
        type: 'reply',
        business_id: 1,
        uri: 'https://www.bilibili.com/video/BV1CAnN6uEUN',
        subject_id: 117474385401104,
        root_id: 0,
        source_id: 319000417329,
        source_content: '@赛博友人 来学一下 ' + 'x'.repeat(200)
      }
    }
    const client = { async get () { return { code: 0, message: '0', data: { items: [MASTER] } } } }
    const quota = { gates: 0, records: 0, gate () { quota.gates += 1; return { ok: true } }, record () { quota.records += 1; return { ok: true } } }
    const deps = { client, config: { owner: { mid: 1 }, risk: {}, paths: { stateDir: env.selfDir } }, owner: { mid: 1 }, quota, log: () => {} }
    const tool25 = buildTools(deps).find((entry) => entry.name === 'bili_at_me')
    assert.ok(tool25 !== undefined, 'bili_at_me 必须存在（第 25 个工具）')

    const result = await tool25.execute({ limit: 10 }, {})
    assert.equal(result.ok, true, '正常响应应当成功，实际 ' + JSON.stringify(result).slice(0, 200))
    assert.equal(result.count, 1, '样本应当解析出 1 条，实际 ' + result.count)
    assert.equal(result.data.count, 1, 'data 里也要有同名 count')
    assert.equal(result.data.items.length, 1, 'data 里也要有同名 items')

    const one = result.items[0]
    assert.equal(one.id, '1193625643966466', 'id 必须透出（数字转字符串）')
    assert.equal(one.mid, '389989266', 'mid 必须来自 item.user.mid，实际 ' + JSON.stringify(one.mid))
    assert.equal(one.uname, '往生堂七七代堂主', 'uname 必须来自 item.user.nickname，实际 ' + JSON.stringify(one.uname))
    assert.equal(one.at, '1793625657', 'at_time 要原样透出（数字转字符串），实际 ' + JSON.stringify(one.at))
    assert.equal(one.type, 'comment', 'item.item.type=reply 必须映射成 comment，实际 ' + one.type)
    assert.ok(one.text.includes('@赛博友人'), '正文必须含 @赛博友人，实际 ' + JSON.stringify(one.text))
    assert.equal(one.text.length, 120, '正文必须截到 120 字，实际 ' + one.text.length)
    assert.equal(one.oid, '117474385401104', 'oid 必须来自 item.item.subject_id，实际 ' + JSON.stringify(one.oid))
    assert.equal(one.root, '319000417329', 'root_id=0 时 root 必须回落 source_id，实际 ' + JSON.stringify(one.root))
    assert.equal(one.rpid, '319000417329', 'rpid 必须来自 item.item.source_id，实际 ' + JSON.stringify(one.rpid))
    assert.equal(one.bvid, 'BV1CAnN6uEUN', 'bvid 必须从 uri 里抠出来，实际 ' + JSON.stringify(one.bvid))

    assert.equal(quota.gates, 0, 'bili_at_me 是只读，绝不许过写闸')
    assert.equal(quota.records, 0, 'bili_at_me 绝不许记账')
  } finally {
    env.restore()
  }
})

test('type 映射与丢弃：reply→comment、dynamic、video、认不出→other；没有 id 的条目直接丢掉', async () => {
  const env = atEnv('at-type-map')
  try {
    const api = await import(repoUrl('lib/api/message.js'))
    const rows = [
      { id: 1, user: { mid: 9, nickname: 'A' }, item: { type: 'reply', source_content: 'r' } },
      { id: 2, user: { mid: 10, nickname: 'B' }, item: { type: 'dynamic', source_content: 'd' } },
      { id: 3, user: { mid: 11, nickname: 'C' }, item: { type: 'video', source_content: 'v' } },
      { id: 4, user: { mid: 12, nickname: 'D' }, item: { type: 'unknown_kind', source_content: 'u' } },
      { user: { mid: 13, nickname: '没有 id 的一条' }, item: { type: 'reply', source_content: 'x' } }
    ]
    const res = await api.atMe({ client: { async get () { return { code: 0, message: '0', data: { items: rows } } } } }, { limit: 10 })
    assert.equal(res.ok, true)
    assert.equal(res.count, 4, '没有 id 的那条必须被丢掉，实际 ' + res.count)
    const byId = new Map(res.items.map((one) => [one.id, one]))
    assert.equal(byId.get('1').type, 'comment', 'reply 必须映射成 comment')
    assert.equal(byId.get('2').type, 'dynamic', 'dynamic 必须映射成 dynamic')
    assert.equal(byId.get('3').type, 'video', 'video 必须映射成 video')
    assert.equal(byId.get('4').type, 'other', '认不出的必须落 other（绝不猜成 comment）')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 2. 与真客户端形状对接（契约） ══════════════════════════ */

test('bili_at_me 与真客户端对接：普通 B站 响应 {code:0,data} 必须解析成功（core/client.js 返回的就是这个形状）', async () => {
  const env = atEnv('at-real-shape')
  try {
    const { buildTools } = await import(repoUrl('lib/tools/index.js'))
    const client = {
      // core/client.js 的 get() 返回的是**B站 原样对象**（code/message/data），没有 ok 字段
      async get () {
        return { code: 0, message: '0', data: { items: [{ id: '9001', business: 'reply', item: { user: { mid: 9, nickname: 'UP甲' }, source_content: { content: '@你' }, uri: 'bilibili://video/222' }, subject_id: '222', root_id: '111', source_id: '333' }] } }
      }
    }
    const deps = { client, config: { owner: { mid: 1 }, risk: {}, paths: { stateDir: env.selfDir } }, owner: { mid: 1 }, quota: { gate: () => ({ ok: true }), record: () => ({ ok: true }) }, log: () => {} }
    const tool25 = buildTools(deps).find((item) => item.name === 'bili_at_me')
    const result = await tool25.execute({ limit: 5 }, {})
    assert.equal(result.ok, true, '真客户端回的 {code:0,data} 必须被当成成功（否则这个工具在真机上永远读不到 @），实际 ' + JSON.stringify(result).slice(0, 240))
    assert.equal(result.count, 1, '应当解析出 1 条，实际 ' + JSON.stringify(result.count))
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 3. 失败不抛 ══════════════════════════ */

test('bili_at_me 失败：风控/网络失败原样透出 reason，不抛、不过写闸', async () => {
  const env = atEnv('at-fail')
  try {
    const { buildTools } = await import(repoUrl('lib/tools/index.js'))
    let gateCalls = 0
    let recordCalls = 0
    const mk = (client) => buildTools({ client, config: { owner: { mid: 1 }, risk: {}, paths: { stateDir: env.selfDir } }, owner: { mid: 1 }, quota: { gate () { gateCalls += 1; throw new Error('不该过闸') }, record () { recordCalls += 1; throw new Error('不该记账') } }, log: () => {} }).find((item) => item.name === 'bili_at_me')

    const risky = mk({ async get () { return { ok: false, reason: 'risk-control', human: '被风控拦了', code: -412 } } })
    let out = null
    await assert.doesNotReject(async () => { out = await risky.execute({ limit: 5 }, {}) }, '风控失败绝不许抛')
    assert.equal(out.ok, false, '风控失败必须 ok:false')
    assert.equal(out.reason, 'risk-control', 'reason 必须原样透出，实际 ' + out.reason)

    const network = mk({ async get () { throw new Error('ECONNRESET') } })
    let net = null
    await assert.doesNotReject(async () => { net = await network.execute({ limit: 5 }, {}) }, '网络异常绝不许抛')
    assert.equal(net.ok, false, '网络异常必须 ok:false')
    assert.equal(net.reason, 'network', 'reason 必须是 network，实际 ' + net.reason)

    assert.equal(gateCalls, 0, '失败路径也不许过写闸')
    assert.equal(recordCalls, 0, '失败路径也不许记账')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 4. 请求参数与 limit 夹取 ══════════════════════════ */

test('bili_at_me 请求参数：platform=web / pn=1 / type=0；limit 0→5、11→10、3→3', async () => {
  const env = atEnv('at-params')
  try {
    const { buildTools } = await import(repoUrl('lib/tools/index.js'))
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: String(1000 + i), business: 'reply', item: { user: { mid: 9, nickname: 'UP' }, source_content: { content: '@你' } } }))
    const calls = []
    const client = { async get (target, query) { calls.push({ target, query }); return { code: 0, message: '0', data: { items: rows } } } }
    const deps = { client, config: { owner: { mid: 1 }, risk: {}, paths: { stateDir: env.selfDir } }, owner: { mid: 1 }, quota: { gate: () => ({ ok: true }), record: () => ({ ok: true }) }, log: () => {} }
    const tool25 = buildTools(deps).find((item) => item.name === 'bili_at_me')

    const wide = await tool25.execute({ limit: 11 }, {})
    assert.equal(calls[0].target, '/x/msgfeed/at', '端点必须是 /x/msgfeed/at（/atme 实测 404），实际 ' + calls[0].target)
    assert.equal(calls[0].query.platform, 'web', 'platform 必须是 web')
    assert.equal(calls[0].query.pn, 1, 'pn 必须是 1')
    assert.equal(calls[0].query.type, 0, 'type 必须是 0')
    assert.equal(wide.count, 10, 'limit=11 必须夹到 10，实际 ' + wide.count)

    const zero = await tool25.execute({ limit: 0 }, {})
    assert.equal(zero.count, 5, 'limit=0 时按默认 5 取（实现口径），实际 ' + zero.count)

    const three = await tool25.execute({ limit: 3 }, {})
    assert.equal(three.count, 3, 'limit=3 应当取 3 条，实际 ' + three.count)

    const none = await tool25.execute({}, {})
    assert.equal(none.count, 5, '不传 limit 时默认 5，实际 ' + none.count)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 5-9. 自主层 ══════════════════════════ */

/** 走一轮 tick（manual，避开窗口/meme 刷新）。 */
async function runTick (deps) {
  const autonomy = await import(repoUrl('lib/core/autonomy.js'))
  autonomy.stop()
  return autonomy.runOnce('manual', deps)
}

const emptyDecision = () => ({ mood: '平静', say: '来了来了', actions: [], diary: '', memory: [] })

test('新 @ 且坐标齐全 → 回 1 条 bili_reply（oid/root/rpid 正确）、seenAtMeIds 记下、第二轮不再回', async () => {
  const env = atEnv('at-reply')
  try {
    const { readState, patchState } = await import(repoUrl('lib/core/state.js'))
    await primeSchedule({
      allows: { read: true, reply: true, comment: true, dm: true }
    })
    await seedState()
    const atMe = tool('bili_at_me', () => ({ ok: true, items: [{ id: '9001', oid: '222', root: '111', rpid: '333', mid: '9', uname: 'UP甲', type: 'comment', text: '@你' }] }))
    const reply = tool('bili_reply', () => ({ ok: true, data: { rpid: 7001 } }))
    const REPLY = '是有点快，第三秒那个转场我也跟丢了一下'
    // 回复的正文来自 thought.reply（say 只用于私信），所以决策必须带 reply
    const deps = { tools: new Map([['bili_at_me', atMe], ['bili_reply', reply]]), llm: fakeLlm({ mood: '平静', say: '', reply: REPLY, actions: [], diary: '', memory: [] }), log: () => {}, ctx: {} }

    await runTick(deps)
    assert.equal(atMe.calls.length, 1, '第一轮应当查一次 @我，实际 ' + atMe.calls.length)
    assert.equal(atMe.calls[0].limit, 5, '查 @我 时 limit 应当是 MENTION_LIMIT(5)，实际 ' + JSON.stringify(atMe.calls[0]))
    assert.equal(reply.calls.length, 1, '坐标齐全时必须回一条，实际 ' + reply.calls.length)
    assert.deepEqual(
      { oid: reply.calls[0].oid, root: reply.calls[0].root, rpid: reply.calls[0].rpid },
      { oid: '222', root: '111', rpid: '333' },
      '回复坐标必须原样来自那条 @，实际 ' + JSON.stringify(reply.calls[0])
    )
    assert.equal(reply.calls[0].message, REPLY, '正文必须用这一轮的 reply（不是 say），实际 ' + JSON.stringify(reply.calls[0].message))
    assert.deepEqual(readState().seenAtMeIds, ['9001'], '必须把这条 @ 记进 seenAtMeIds，实际 ' + JSON.stringify(readState().seenAtMeIds))

    // 第二轮：清掉节流时间（否则 30 分钟窗口直接跳过），@我 会再查一次，但没有新条目 → 不许再回
    patchState({ lastReplyCheckAt: '' })
    await runTick(deps)
    assert.equal(atMe.calls.length, 2, '第二轮应当再查一次，实际 ' + atMe.calls.length)
    assert.equal(reply.calls.length, 1, '同一条 @ 第二轮不许再回，实际 ' + reply.calls.length)
  } finally {
    env.restore()
  }
})

test('只解析出 oid（缺 root/rpid）→ 不回，审计 why 含「坐标不全」且带 oid', async () => {
  const env = atEnv('at-incomplete')
  try {
    const audit = await import(repoUrl('lib/core/audit.js'))
    await primeSchedule({ allows: { read: true, reply: true, comment: true, dm: true } })
    await seedState()
    const atMe = tool('bili_at_me', () => ({ ok: true, items: [{ id: '9002', oid: '222', mid: '9', uname: 'UP甲', type: 'comment', text: '@你' }] }))
    const reply = tool('bili_reply', () => ({ ok: true, data: { rpid: 7002 } }))
    const REPLY = '是有点快，第三秒那个转场我也跟丢了一下'
    // 回复的正文来自 thought.reply（say 只用于私信），所以决策必须带 reply
    const deps = { tools: new Map([['bili_at_me', atMe], ['bili_reply', reply]]), llm: fakeLlm({ mood: '平静', say: '', reply: REPLY, actions: [], diary: '', memory: [] }), log: () => {}, ctx: {} }

    await runTick(deps)
    assert.equal(reply.calls.length, 0, '坐标不全时一条都不许回（宁可沉默，也不要发成顶层评论），实际 ' + reply.calls.length)
    const rows = audit.readAudit(50).filter((row) => row.args?.mentionFallback === 'true')
    assert.equal(rows.length, 1, '必须留一条说明为什么没回的审计，实际 ' + rows.length)
    assert.match(String(rows[0].why), /坐标不全/, '审计 why 要说清坐标不全，实际 ' + rows[0].why)
    assert.match(String(rows[0].why), /oid=222/, '审计里要带上是哪个 oid，实际 ' + rows[0].why)
    assert.equal(rows[0].ok, false, '这条审计是跳过，ok 必须 false')
  } finally {
    env.restore()
  }
})

test('replyToMentions=false → 连 bili_at_me 都不读（0 次）', async () => {
  const env = atEnv('at-off')
  try {
    await primeSchedule({ allows: { read: true, reply: true, comment: true, dm: true }, replyToMentions: false })
    await seedState()
    const atMe = tool('bili_at_me', () => ({ ok: true, items: [{ id: '9003', oid: '222', root: '111', rpid: '333' }] }))
    const reply = tool('bili_reply', () => ({ ok: true, data: {} }))
    const REPLY = '是有点快，第三秒那个转场我也跟丢了一下'
    // 回复的正文来自 thought.reply（say 只用于私信），所以决策必须带 reply
    const deps = { tools: new Map([['bili_at_me', atMe], ['bili_reply', reply]]), llm: fakeLlm({ mood: '平静', say: '', reply: REPLY, actions: [], diary: '', memory: [] }), log: () => {}, ctx: {} }

    await runTick(deps)
    assert.equal(atMe.calls.length, 0, '开关关掉时连读都不许读，实际 ' + atMe.calls.length + ' 次')
    assert.equal(reply.calls.length, 0, '也不许回')
  } finally {
    env.restore()
  }
})

test('评论回复判据：parent 指向别人 → 不回；parent 指向她的 rpid → 回一条', async () => {
  const env = atEnv('at-comment-parent')
  try {
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    await primeSchedule({ allows: { read: true, reply: true, comment: true, dm: true }, replyToMentions: false })
    await seedState({
      selfMid: '999',
      myComments: [{ rpid: '111', aid: '222', at: new Date().toISOString() }]
    })
    let rows = [{ rpid: '333', mid: '555', parent: '444', content: { message: '别人回别人' } }]
    const replies = tool('bili_replies', () => ({ ok: true, data: { replies: rows } }))
    const reply = tool('bili_reply', () => ({ ok: true, data: { rpid: 7003 } }))
    const REPLY = '你说的对，我这边也是这么想的'
    const deps = { tools: new Map([['bili_replies', replies], ['bili_reply', reply]]), llm: fakeLlm({ mood: '平静', say: '', reply: REPLY, actions: [], diary: '', memory: [] }), log: () => {}, ctx: {} }

    await runTick(deps)
    assert.equal(replies.calls.length, 1, '应当查一次楼中楼，实际 ' + replies.calls.length)
    assert.equal(reply.calls.length, 0, 'parent 指向别人的评论不许回（不许在别人的对话里插嘴），实际 ' + reply.calls.length)

    // 下一轮：parent 指向她（111）→ 必须回
    rows = [{ rpid: '334', mid: '555', parent: '111', content: { message: '你说的对' } }]
    patchState({ lastReplyCheckAt: '', seenReplyRpids: [] })
    await runTick(deps)
    assert.equal(reply.calls.length, 1, 'parent 指向她的 rpid 时必须回，实际 ' + reply.calls.length)
    assert.deepEqual(
      { oid: reply.calls[0].oid, root: reply.calls[0].root, rpid: reply.calls[0].rpid },
      { oid: '222', root: '111', rpid: '334' },
      '回复坐标必须来自她的那条评论与对方的回复，实际 ' + JSON.stringify(reply.calls[0])
    )
    assert.equal(reply.calls[0].message, REPLY, '回复正文必须用这一轮的 reply，实际 ' + JSON.stringify(reply.calls[0].message)
    )
  } finally {
    env.restore()
  }
})

test('30 分钟节流：距上次检查 5 分钟 → bili_at_me 与 bili_replies 都不被调', async () => {
  const env = atEnv('at-throttle')
  try {
    await primeSchedule({ allows: { read: true, reply: true, comment: true, dm: true } })
    await seedState({
      selfMid: '999',
      myComments: [{ rpid: '111', aid: '222', at: new Date().toISOString() }],
      lastReplyCheckAt: new Date(Date.now() - 5 * 60_000).toISOString()
    })
    const atMe = tool('bili_at_me', () => ({ ok: true, items: [{ id: '9004', oid: '222', root: '111', rpid: '333' }] }))
    const replies = tool('bili_replies', () => ({ ok: true, data: { replies: [{ rpid: '335', mid: '555', parent: '111', content: { message: '回你' } }] } }))
    const reply = tool('bili_reply', () => ({ ok: true, data: {} }))
    const deps = { tools: new Map([['bili_at_me', atMe], ['bili_replies', replies], ['bili_reply', reply]]), llm: fakeLlm(emptyDecision()), log: () => {}, ctx: {} }

    await runTick(deps)
    assert.equal(atMe.calls.length, 0, '30 分钟内不许再查 @我，实际 ' + atMe.calls.length)
    assert.equal(replies.calls.length, 0, '30 分钟内不许再查楼中楼，实际 ' + replies.calls.length)
    assert.equal(reply.calls.length, 0, '没查自然也不回')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 10-12. 信封与失败分类（-101 / -412 / 没有 code） ══════════════════════════ */

test('信封 {code:-101} → not-logged-in；自主层安静跳过：不抛、不崩 tick、不重复请求、不写 mentionCheck 审计', async () => {
  const env = atEnv('at-101')
  try {
    const api = await import(repoUrl('lib/api/message.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    // ① api 层：未登录必须单独翻成 not-logged-in（不是笼统的 bili-error）
    const res = await api.atMe({ client: { async get () { return { code: -101, message: '账号未登录' } } } }, { limit: 5 })
    assert.equal(res.ok, false, 'code=-101 必须 ok:false，实际 ' + JSON.stringify(res).slice(0, 160))
    assert.equal(res.reason, 'not-logged-in', 'reason 必须是 not-logged-in，实际 ' + res.reason)
    assert.equal(res.code, -101, '原始码要带上，实际 ' + JSON.stringify(res.code))

    // ② 自主层：拿到同一个 reason 时安静跳过（不抛、不回复、不刷审计、也不反复打请求）
    await primeSchedule({ allows: { read: true, reply: true, comment: true, dm: true } })
    await seedState()
    const atMe = tool('bili_at_me', () => ({ ok: false, reason: 'not-logged-in', human: '账号未登录，去设置页重贴 cookie' }))
    const reply = tool('bili_reply', () => ({ ok: true, data: {} }))
    const REPLY = '是有点快，第三秒那个转场我也跟丢了一下'
    // 回复的正文来自 thought.reply（say 只用于私信），所以决策必须带 reply
    const deps = { tools: new Map([['bili_at_me', atMe], ['bili_reply', reply]]), llm: fakeLlm({ mood: '平静', say: '', reply: REPLY, actions: [], diary: '', memory: [] }), log: () => {}, ctx: {} }

    let first = null
    await assert.doesNotReject(async () => { first = await runTick(deps) }, '未登录绝不许把 tick 抛穿')
    assert.equal(first.ok, true, '这一轮本身应当成功（读不到 @ 不算失败），实际 ' + JSON.stringify(first).slice(0, 160))
    assert.equal(reply.calls.length, 0, '读不到就不许回，实际 ' + reply.calls.length)
    assert.equal(audit.readAudit(50).filter((row) => row.args?.mentionCheck === 'true').length, 0, '没查成功不该写 mentionCheck 审计（否则每轮一条噪音）')

    // ③ 第二轮：节流窗口已在上一次检查时被打上，所以不该再打一次请求
    await runTick(deps)
    assert.equal(atMe.calls.length, 1, '失败也不许反复刷请求（30 分钟窗口照旧生效），实际累计 ' + atMe.calls.length + ' 次')
  } finally {
    env.restore()
  }
})

test('信封 {code:-412} → risk-control；自主层同样安静跳过', async () => {
  const env = atEnv('at-412')
  try {
    const api = await import(repoUrl('lib/api/message.js'))
    const res = await api.atMe({ client: { async get () { return { code: -412, message: '请求被拦截' } } } }, { limit: 5 })
    assert.equal(res.ok, false, 'code=-412 必须 ok:false')
    assert.equal(res.reason, 'risk-control', 'reason 必须是 risk-control，实际 ' + res.reason)

    await primeSchedule({ allows: { read: true, reply: true, comment: true, dm: true } })
    await seedState()
    const atMe = tool('bili_at_me', () => ({ ok: false, reason: 'risk-control', human: '风控中' }))
    const reply = tool('bili_reply', () => ({ ok: true, data: {} }))
    const REPLY = '是有点快，第三秒那个转场我也跟丢了一下'
    // 回复的正文来自 thought.reply（say 只用于私信），所以决策必须带 reply
    const deps = { tools: new Map([['bili_at_me', atMe], ['bili_reply', reply]]), llm: fakeLlm({ mood: '平静', say: '', reply: REPLY, actions: [], diary: '', memory: [] }), log: () => {}, ctx: {} }
    let out = null
    await assert.doesNotReject(async () => { out = await runTick(deps) }, '风控绝不许把 tick 抛穿')
    assert.equal(out.ok, true, '风控也只是一轮没读到 @，不该算这一轮失败')
    assert.equal(reply.calls.length, 0, '风控中一条都不许回')
  } finally {
    env.restore()
  }
})

test('响应里没有 code（{} / 只有 message / 数组）→ network：绝不静默当成成功', async () => {
  const env = atEnv('at-nocode')
  try {
    const api = await import(repoUrl('lib/api/message.js'))
    for (const pair of [['空对象', {}], ['只有 message', { message: '啥也没给' }], ['数组', []]]) {
      const label = pair[0]
      const response = pair[1]
      const res = await api.atMe({ client: { async get () { return response } } }, { limit: 5 })
      assert.equal(res.ok, false, label + ' 必须 ok:false（上游形状变了不许当成功），实际 ' + JSON.stringify(res).slice(0, 160))
      assert.equal(res.reason, 'network', label + ' 的 reason 必须是 network，实际 ' + res.reason)
      assert.match(String(res.human), /没有 code|没有拿到/, label + ' 的文案要说清信封不认识：' + res.human)
    }
    // 对照：{ok:true,data} 是 api 层**明确接受**的另一种信封（注释里写明），它不是错误路径
    const accepted = await api.atMe({ client: { async get () { return { ok: true, data: { items: [] } } } } }, { limit: 5 })
    assert.equal(accepted.ok, true, '已被摊平的 {ok:true,data} 是明确接受的形状，不该报错，实际 ' + JSON.stringify(accepted).slice(0, 160))
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 13. 端点常量（踩过一次的真机坑） ══════════════════════════ */

test('端点常量必须等于 /x/msgfeed/at：curl 实测 /atme 是 404、/at 才是 200', async () => {
  // 依据（2026-11-01 真机 curl 取证）：
  //   GET https://api.bilibili.com/x/msgfeed/atme  → HTTP 404（这个路径不存在）
  //   GET https://api.bilibili.com/x/msgfeed/at    → HTTP 200，返回 @我的 列表
  //   「atme」读起来更合理，但它就是错的 —— 这条用例专门为这种「顺手改回去」站岗。
  const env = atEnv('at-endpoint-pin')
  try {
    const api = await import(repoUrl('lib/api/message.js'))
    const calls = []
    const client = { async get (target, query) { calls.push({ target, query }); return { code: 0, message: '0', data: { items: [] } } } }
    await api.atMe({ client }, { limit: 5 })
    assert.equal(calls.length, 1, '应当恰好发一次读请求')
    assert.equal(calls[0].target, '/x/msgfeed/at', '运行时的请求路径必须是 /x/msgfeed/at（/atme 实测 404），实际 ' + calls[0].target)

    // 静态再钉一次常量本身：即使将来有别的代码路径绕开 atMe()，这一行也会红。
    // （源码注释里保留 /atme 404 的取证记录是对的，所以这里只比对常量的值，不做全文禁用。）
    const source = fs.readFileSync(new URL('../lib/api/message.js', import.meta.url), 'utf8')
    const matched = /const AT_ME_URL = '([^']+)'/.exec(source)
    assert.ok(matched !== null, '源码里必须能定位到 AT_ME_URL 常量')
    assert.equal(matched[1], '/x/msgfeed/at', 'AT_ME_URL 必须等于 /x/msgfeed/at，实际 ' + matched[1])
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 14-16. shapeAtMe 的边界（真机样本里最容易错的三处） ══════════════════════════ */

test('root_id 非 0：root 取 root_id、rpid 仍是 source_id（楼层根与目标不是同一个号）', async () => {
  const env = atEnv('at-root-nonzero')
  try {
    const api = await import(repoUrl('lib/api/message.js'))
    const row = {
      id: 2001,
      user: { mid: 389989266, nickname: '某人' },
      at_time: 1793625657,
      item: {
        type: 'reply',
        uri: 'https://www.bilibili.com/video/BV1CAnN6uEUN',
        subject_id: 117474385401104,
        root_id: 888888888,
        source_id: 319000417329,
        source_content: '@你 看这条'
      }
    }
    const res = await api.atMe({ client: { async get () { return { code: 0, message: '0', data: { items: [row] } } } } }, { limit: 5 })
    assert.equal(res.ok, true)
    const one = res.items[0]
    assert.equal(one.root, '888888888', 'root_id 非 0 时必须用它作楼层根，实际 ' + JSON.stringify(one.root))
    assert.equal(one.rpid, '319000417329', 'rpid 必须仍是 source_id（不是 root_id），实际 ' + JSON.stringify(one.rpid))
    assert.equal(one.oid, '117474385401104', 'oid 必须仍是 subject_id，实际 ' + JSON.stringify(one.oid))
    // 两个号必须不同 —— 混用会把回复发到别人的楼层上
    assert.notEqual(one.root, one.rpid, 'root 与 rpid 是两件不同的坐标，绝不能相等')
  } finally {
    env.restore()
  }
})

test('动态 @：item.item.type=dynamic → type=dynamic，oid 取 subject_id', async () => {
  const env = atEnv('at-dynamic')
  try {
    const api = await import(repoUrl('lib/api/message.js'))
    const row = {
      id: 2002,
      user: { mid: 389989266, nickname: '某人' },
      at_time: 1793625657,
      item: { type: 'dynamic', subject_id: 998877665544, source_content: '@你 看我的动态' }
    }
    const res = await api.atMe({ client: { async get () { return { code: 0, message: '0', data: { items: [row] } } } } }, { limit: 5 })
    assert.equal(res.ok, true)
    const one = res.items[0]
    assert.equal(one.type, 'dynamic', 'type 必须是 dynamic，实际 ' + one.type)
    assert.equal(one.oid, '998877665544', '动态的 oid 必须来自 subject_id，实际 ' + JSON.stringify(one.oid))
    assert.equal('bvid' in one, false, '动态没有 bvid，字段必须省略（不许编一个空串）')
  } finally {
    env.restore()
  }
})

test('缺字段：没有 user、没有 subject_id → mid/uname 为空串，oid/root/rpid 字段不出现，且不抛', async () => {
  const env = atEnv('at-missing')
  try {
    const api = await import(repoUrl('lib/api/message.js'))
    const row = { id: 2003, at_time: 1793625657, item: { type: 'reply', source_content: '@你 但什么都没有' } }
    let res = null
    await assert.doesNotReject(async () => { res = await api.atMe({ client: { async get () { return { code: 0, message: '0', data: { items: [row] } } } } }, { limit: 5 }) }, '缺字段绝不许抛')
    assert.equal(res.ok, true, '缺字段的一条仍应解析成功（能回不了就交给上层判坐标不全）')
    assert.equal(res.count, 1, '这一条有 id，不该被丢掉')
    const one = res.items[0]
    assert.equal(one.mid, '', '没有 user 时 mid 必须是空串，实际 ' + JSON.stringify(one.mid))
    assert.equal(one.uname, '', '没有 user 时 uname 必须是空串，实际 ' + JSON.stringify(one.uname))
    assert.equal('oid' in one, false, '没有 subject_id/uri 时 oid 字段必须省略（不是空串）')
    assert.equal('root' in one, false, '没有 root_id/source_id 时 root 字段必须省略')
    assert.equal('rpid' in one, false, '没有 source_id 时 rpid 字段必须省略')
    assert.equal('bvid' in one, false, '没有 uri 时 bvid 字段必须省略')

    // 极端退化：item 整个缺失也不许抛
    let bare = null
    await assert.doesNotReject(async () => { bare = await api.atMe({ client: { async get () { return { code: 0, message: '0', data: { items: [{ id: 2004 }] } } } } }, { limit: 5 }) }, '连 item 都没有时也不许抛')
    assert.equal(bare.count, 1, '只有 id 的一条仍应保留')
    assert.equal(bare.items[0].type, 'other', 'type 缺失时必须落 other，实际 ' + bare.items[0].type)
    assert.equal(bare.items[0].text, '', 'text 缺失时是空串（文字字段不省略，省略的是坐标）')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 17-18. 读 @ / 读视频提前到决策之前（结构改造） ══════════════════════════ */

/** 让 tick 里除"读 @ + 读视频"之外没有别的模型调用（梗库新鲜 + manual 触发 + 关掉其它兜底）。 */
async function primeForMention (over = {}) {
  await primeSchedule({ allows: { read: true, reply: true, comment: true, dm: true }, ...over })
  await seedState()
  const memes = await import(repoUrl('lib/core/memes.js'))
  fs.writeFileSync(memes.memesPath(), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'llm', stage: 'fresh', items: [], lastAttemptAt: '', lastMemeError: '' }))
}

test('同一次决策就带视频细节：模型只调 1 次，system 里同时有【有人 @ 我】/标题/bvid/正文，回复正文用了标题', async () => {
  const env = atEnv('at-mention-detail')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    autonomy.stop()
    await primeForMention()

    const BVID = 'BV1CAnN6uEUN'
    const TITLE = '大肥鱼教人类学'
    const order = []
    const atMe = tool('bili_at_me', () => ({
      ok: true,
      items: [{ id: '9001', oid: '222', root: '111', rpid: '333', bvid: BVID, uname: '某人', type: 'comment', text: '来学一下这条' }]
    }))
    const info = tool('bili_video_info', () => {
      order.push('video_info')
      return { ok: true, data: { title: TITLE, desc: '讲人类学的', duration: 612, owner: { name: 'UP甲' }, stat: { view: 123456 } } }
    })
    const reply = tool('bili_reply', () => { order.push('reply'); return { ok: true, data: { rpid: 7001 } } })

    // 抓 options.system：模型只该被调一次，且这一次就要看到视频细节
    const prompts = []
    const SAY = '看完「' + TITLE + '」了，这个比喻很妙'
    const llm = {
      calls: 0,
      async *stream (options) {
        this.calls += 1
        prompts.push(options ?? {})
        yield { type: 'text-delta', text: JSON.stringify({ mood: '好奇', say: '', reply: SAY, actions: [], diary: '', memory: [] }) }
        yield { type: 'finish', reason: { kind: 'ok' } }
      }
    }
    const deps = { tools: new Map([['bili_at_me', atMe], ['bili_video_info', info], ['bili_reply', reply]]), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('manual', deps)
    assert.equal(result.ok, true, '这一轮应当成功，实际 ' + JSON.stringify(result).slice(0, 200))
    assert.equal(llm.calls, 1, '读 @ 与读视频都不许额外调模型（同一次决策就够），实际 ' + llm.calls + ' 次')

    const system = String(prompts[0]?.system ?? '')
    assert.ok(system.includes('【有人 @ 我】'), 'system 里必须有【有人 @ 我】那一段')
    assert.ok(system.includes(TITLE), 'system 里必须有视频标题（否则模型只能空谈），实际缺失：' + TITLE)
    assert.ok(system.includes(BVID), 'system 里必须有 bvid，实际缺失：' + BVID)
    assert.ok(system.includes('来学一下这条'), 'system 里必须有那条 @ 的正文')

    assert.equal(reply.calls.length, 1, '应当回一条，实际 ' + reply.calls.length)
    assert.equal(reply.calls[0].message, SAY, '回复正文必须就是这次决策的 reply')
    assert.ok(String(reply.calls[0].message).includes(TITLE), 'reply 里带了标题，回复里就该有标题，实际 ' + JSON.stringify(reply.calls[0].message))
    assert.deepEqual({ oid: reply.calls[0].oid, root: reply.calls[0].root, rpid: reply.calls[0].rpid }, { oid: '222', root: '111', rpid: '333' }, '回复坐标必须来自那条 @')

    assert.deepEqual(order, ['video_info', 'reply'], '必须"先看视频、再回复"（顺序反了就说明细节拿不到），实际 ' + JSON.stringify(order))
    assert.equal(info.calls.length, 1, 'bili_video_info 只该被调一次，实际 ' + info.calls.length)
    assert.equal(info.calls[0].bvid, BVID, '读的就是那条 @ 带的 bvid，实际 ' + JSON.stringify(info.calls[0]))
  } finally {
    env.restore()
  }
})

test('没看成时"必须说明原因"：视频读失败也要把 bvid 与「没看成」写进 system，仍回 1 条，审计留 mentionError', async () => {
  const env = atEnv('at-mention-watch-fail')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    autonomy.stop()
    await primeForMention()

    const BVID = 'BV1CAnN6uEUN'
    const atMe = tool('bili_at_me', () => ({
      ok: true,
      items: [{ id: '9002', oid: '222', root: '111', rpid: '333', bvid: BVID, uname: '某人', type: 'comment', text: '看看这个' }]
    }))
    const info = tool('bili_video_info', () => ({ ok: false, reason: 'bili-error', human: '读不到' }))
    const reply = tool('bili_reply', () => ({ ok: true, data: { rpid: 7002 } }))

    const prompts = []
    const llm = {
      calls: 0,
      async *stream (options) {
        this.calls += 1
        prompts.push(options ?? {})
        yield { type: 'text-delta', text: JSON.stringify({ mood: '平静', say: '', reply: '这条我没看成（读不到详情），不过你的意思我收到了', actions: [], diary: '', memory: [] }) }
        yield { type: 'finish', reason: { kind: 'ok' } }
      }
    }
    const deps = { tools: new Map([['bili_at_me', atMe], ['bili_video_info', info], ['bili_reply', reply]]), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('manual', deps)
    assert.equal(result.ok, true, '视频读失败不该把这一轮算失败')
    assert.equal(llm.calls, 1, '仍然只许 1 次模型调用，实际 ' + llm.calls)

    const system = String(prompts[0]?.system ?? '')
    assert.ok(system.includes('没看成'), 'system 里必须写清「没看成」（模型才知道要解释原因）')
    assert.ok(system.includes(BVID), 'system 里必须带上没看成的 bvid，实际缺失：' + BVID)
    assert.ok(system.includes('【有人 @ 我】'), '仍然要有【有人 @ 我】那段')

    assert.equal(reply.calls.length, 1, '没看成也要回 1 条（说明原因，不是沉默），实际 ' + reply.calls.length)
    assert.equal(reply.calls[0].message, '这条我没看成（读不到详情），不过你的意思我收到了', '回复正文就是这次决策的 reply')

    const rows = audit.readAudit(50).filter((row) => row.args?.mentionError !== undefined && row.args.mentionError !== '')
    assert.equal(rows.length, 1, '必须留一条 mentionError 审计（事后能查"那天为什么没看成"），实际 ' + rows.length)
    assert.equal(rows[0].args.mentionBvid, BVID, '审计里要记是哪个 bvid，实际 ' + JSON.stringify(rows[0].args.mentionBvid))
    assert.equal(rows[0].ok, false, '这条审计是失败，ok 必须 false')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 19-20. 分频道文案：代码管频道，不管文风 ══════════════════════════ */

test('只有 say、没有 comment/reply：评论仍必须发 1 条（补写或兜底句），回复仍零调用', async () => {
  const env = atEnv('at-channel-say-only')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    autonomy.stop()
    // commentAfterWatch 打开，决策只给 say：2026-11-02 起「看完必须评论」，所以评论会走补写/兜底句发出；
    // 但**回复**仍然只认 reply —— 这条守的是「say 绝不许顶成公开文案」。
    await primeForMention({ commentAfterWatch: true })

    const BVID = 'BV1CAnN6uEUN'
    const atMe = tool('bili_at_me', () => ({
      ok: true,
      items: [{ id: '9101', oid: '222', root: '111', rpid: '333', bvid: BVID, uname: '某人', type: 'comment', text: '看看这个' }]
    }))
    const info = tool('bili_video_info', () => ({ ok: true, data: { title: '随便一个标题' } }))
    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid: BVID }] } }))
    const comment = tool('bili_comment', () => ({ ok: true, data: { rpid: 8001 } }))
    const reply = tool('bili_reply', () => ({ ok: true, data: { rpid: 8002 } }))

    // 第一次是决策，第二次是「补写评论」（repairComment 会再问模型一次，≤60 字）
    let llmCalls = 0
    const llm = {
      async *stream () {
        llmCalls += 1
        if (llmCalls === 1) {
          yield { type: 'text-delta', text: JSON.stringify({ mood: '平静', say: '我在刷关注列，还没看到什么特别的', actions: [{ tool: 'bili_watch', args: { limit: 3 } }], diary: '', memory: [] }) }
        } else {
          yield { type: 'text-delta', text: '这条海洋镜头拍得挺安静的' }
        }
        yield { type: 'finish', reason: { kind: 'ok' } }
      }
    }
    const deps = {
      tools: new Map([['bili_at_me', atMe], ['bili_video_info', info], ['bili_watch', watch], ['bili_comment', comment], ['bili_reply', reply]]),
      llm, log: () => {}, ctx: {}
    }

    const result = await autonomy.runOnce('manual', deps)
    assert.equal(result.ok, true, '这一轮本身应当成功')
    assert.equal(comment.calls.length, 1, '看完必须评论：只有 say 时也要发 1 条（走补写），实际 ' + comment.calls.length)
    assert.equal(comment.calls[0].message, '这条海洋镜头拍得挺安静的', '补写出来的那句话就是发出去的正文，实际 ' + JSON.stringify(comment.calls[0].message))
    assert.notEqual(comment.calls[0].message, '我在刷关注列，还没看到什么特别的', 'say 绝不许顶成公开评论')
    assert.equal(reply.calls.length, 0, '只有 say 时一条回复都不许发，实际 ' + reply.calls.length)

    const rows = audit.readAudit(50)
    const commentRows = rows.filter((row) => row.args?.commentFallback === 'true')
    const replyRows = rows.filter((row) => row.args?.mentionFallback === 'true')
    // 审计要能看出「这条是补写来的」（新规则下不再有「跳过」这一支）
    const repairRows = rows.filter((row) => row.args?.commentRepair === 'true')
    assert.equal(repairRows.length, 1, '补写成功必须留一条 commentRepair 审计，实际 ' + repairRows.length)
    assert.equal(rows.filter((row) => /跳过：没有可说的内容/.test(String(row.why))).length, 0, '新规则下不该再有「跳过：没有可说的内容」')
    assert.equal(replyRows.length, 1, '回复侧必须留一条跳过审计，实际 ' + replyRows.length)
    assert.match(String(replyRows[0].why), /跳过：没有可回的内容/, '回复侧 why 要写清没内容可回，实际 ' + replyRows[0].why)
  } finally {
    env.restore()
  }
})

test('决策带 comment（哪怕是状态自述）→ 原样发出：代码只管频道，不纠正文风', async () => {
  const env = atEnv('at-channel-verbatim')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    autonomy.stop()
    await primeForMention({ commentAfterWatch: true })

    const BVID = 'BV1CAnN6uEUN'
    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid: BVID }] } }))
    const comment = tool('bili_comment', () => ({ ok: true, data: { rpid: 8003 } }))
    // 内容是提示词该管的事：这里故意给一句"自述"式的 comment，内核必须一字不改地发出去
    const COMMENT = '我在刷关注列，看到这条还挺好'
    const llm = fakeLlm({ mood: '平静', say: '（私信里我才说这句）', comment: COMMENT, actions: [{ tool: 'bili_watch', args: { limit: 2 } }], diary: '', memory: [] })
    const deps = { tools: new Map([['bili_watch', watch], ['bili_comment', comment]]), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('manual', deps)
    assert.equal(result.ok, true, '这一轮应当成功')
    assert.equal(comment.calls.length, 1, '带了 comment 就该发一条，实际 ' + comment.calls.length)
    assert.equal(comment.calls[0].message, COMMENT, '代码不许改写内容（文风是提示词的事），实际 ' + JSON.stringify(comment.calls[0].message))
    assert.notEqual(comment.calls[0].message, '（私信里我才说这句）', 'say 绝不许顶成公开评论')
  } finally {
    env.restore()
  }
})
