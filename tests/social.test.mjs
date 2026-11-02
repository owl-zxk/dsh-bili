// tests/social.test.mjs —— 看完就聊两句 + 睡前汇报（AUTONOMY-PROMPT §20）
//
// 为什么这样测：
//   这两件事都是「对外发言」，所以每一条都必须同时钉住「该发」和「不该发」：
//     · @主人 是让主人收到提醒的手段 —— 模型忘了给 atOwner 时内核要替它补，
//       但**模型显式说 false 时不许覆盖**；
//     · 同一个 bvid 不重复评论，而且命中时**不许消耗写间隔/额度**（它连闸都没过）；
//     · 睡前汇报只在「本窗口最后一次醒来」发，每个窗口最多一条；
//       DM 失败**不重试**、也不记 lastBedtimeReportAt（下次还会试）。
//   全部假 llm / 假工具 + 临时 self 目录，零真实网络；
//   时间相关的判定靠「窗口贴近当前时刻」构造，不睡真实时间。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { OWNER, cleanupTmp, localDayKey, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

const BASE_METRICS = { energy: 60, mood: 55, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 }
/** 换行（模板正文逐字符比较时用，避免把转义写进源码字符串里）。 */
const NL = String.fromCharCode(10)

function socialEnv (tag) {
  const root = tmpDir(tag)
  const restoreSandbox = sandboxEnv(root)
  const restoreSelf = setEnv({ DSH_BILI_SELF_DIR: path.join(root, 'self') })
  fs.mkdirSync(path.join(root, 'self'), { recursive: true })
  return { root, selfDir: path.join(root, 'self'), restore () { restoreSelf(); restoreSandbox(); cleanupTmp() } }
}

/** 假工具：记调用、按 handler 返回。 */
function tool (name, handler = () => ({ ok: true, data: {} })) {
  const t = { name, description: '桩', calls: [], async execute (args) { t.calls.push(args ?? {}); return handler(args ?? {}) } }
  return t
}

function fakeLlm (decision) {
  return { calls: 0, async *stream () { this.calls += 1; yield { type: 'text-delta', text: JSON.stringify(decision) }; yield { type: 'finish', reason: { kind: 'ok' } } } }
}

/** 空决策（这一轮模型什么都不想做）。 */
const emptyDecision = () => ({ mood: '平静', say: '', actions: [], diary: '', memory: [] })

async function primeSchedule (over = {}) {
  const schedule = await import(repoUrl('lib/core/schedule.js'))
  schedule.unlock()
  const saved = schedule.saveSchedule({ enabled: true, windows: [{ start: '00:00', end: '24:00' }], allows: { read: true, dm: true, comment: true }, minWatchPerWake: false, ...over })
  assert.equal(saved.ok, true, '前提：日程必须写成功，实际 ' + JSON.stringify(saved))
  return schedule
}

async function seedState (patch = {}) {
  const { patchState } = await import(repoUrl('lib/core/state.js'))
  patchState({ counters: {}, silenceUntil: 0, commentedBvids: [], lastBedtimeReportAt: '', metrics: { ...BASE_METRICS }, ...patch })
}

/** 假 quota：数一数闸与记账被调用了几次（用来证明「没消耗写额度」）。 */
function fakeQuota () {
  const q = { gates: [], records: [], gate (cfg, opts) { q.gates.push(opts ?? {}); return { ok: true } }, record (cfg, opts) { q.records.push(opts ?? {}); return { ok: true } } }
  return q
}

const clock = (minutes) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
}
const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() }

/* ══════════════════════════ a. 评论自动 @主人 ══════════════════════════ */

test('评论自动 @主人：模型没给 atOwner → 内核补 true；关掉开关 → 不补；模型显式 false → 保持 false', async () => {
  const env = socialEnv('social-atowner')
  try {
    const actions = await import(repoUrl('lib/core/actions.js'))
    const schedule = await primeSchedule()
    await seedState()
    const comment = tool('bili_comment')
    const deps = { tools: new Map([['bili_comment', comment]]), log: () => {}, quota: fakeQuota() }

    // ① 默认（atOwnerOnComment 缺省 = 开）：模型只给 bvid+正文 → 实际调用 args 里必须有 atOwner:true
    assert.equal(schedule.loadSchedule().atOwnerOnComment, true, '前提：atOwnerOnComment 默认是开')
    const auto = await actions.runActions({ ok: true, actions: [{ tool: 'bili_comment', args: { bvid: 'BV1GJ411x7h1', message: '这条我来说两句' } }] }, deps)
    assert.equal(auto.executed.length, 1, '这条评论应当执行，实际跳过 ' + JSON.stringify(auto.skipped))
    assert.equal(comment.calls.length, 1)
    assert.equal(comment.calls[0].atOwner, true, '模型没给 atOwner 时内核必须补 true，实际 ' + JSON.stringify(comment.calls[0]))
    assert.equal(comment.calls[0].bvid, 'BV1GJ411x7h1', 'bvid 要原样传下去')
    assert.equal(comment.calls[0].message, '这条我来说两句', '正文不许被改')

    // ② 开关关掉：不许补 atOwner（键都不该出现）
    schedule.saveSchedule({ atOwnerOnComment: false })
    assert.equal(schedule.loadSchedule().atOwnerOnComment, false)
    const off = await actions.runActions({ ok: true, actions: [{ tool: 'bili_comment', args: { bvid: 'BV1GJ411x7h2', message: '不 @ 了' } }] }, deps)
    assert.equal(off.executed.length, 1)
    assert.equal(Object.prototype.hasOwnProperty.call(comment.calls[1], 'atOwner'), false, '开关关掉时不许出现 atOwner 键，实际 ' + JSON.stringify(comment.calls[1]))

    // ③ 模型显式给 false：不许被覆盖成 true
    schedule.saveSchedule({ atOwnerOnComment: true })
    const explicit = await actions.runActions({ ok: true, actions: [{ tool: 'bili_comment', args: { bvid: 'BV1GJ411x7h3', message: '我不想 @', atOwner: false } }] }, deps)
    assert.equal(explicit.executed.length, 1)
    assert.equal(comment.calls[2].atOwner, false, '模型显式 false 必须保持 false（不许覆盖），实际 ' + JSON.stringify(comment.calls[2]))
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ b. 同一 bvid 不重复评论 ══════════════════════════ */

test('同一 bvid 不重复评论：第二次 skipped=already-commented，且账本没新增（不消耗写间隔）', async () => {
  const env = socialEnv('social-already')
  try {
    const actions = await import(repoUrl('lib/core/actions.js'))
    const quotaModule = await import(repoUrl('lib/core/quota.js'))
    const capabilities = await import(repoUrl('lib/core/capabilities.js'))
    const { buildTools } = await import(repoUrl('lib/tools/index.js'))
    const schedule = await primeSchedule()
    await seedState()

    // 这一条要证明的是「命中 already-commented 时连闸都没过」，所以必须走真 api + 真账本：
    // 只有真闸才会记账，账本条目数（和最后一条的时间戳）才是写间隔的可观测证据。
    const config = { owner: OWNER, risk: {}, paths: { stateDir: env.selfDir } }
    const client = {
      async get (requestPath) {
        if (requestPath === '/x/web-interface/view') return { code: 0, data: { bvid: 'BV1GJ411x7h1', aid: 123, title: '假标题', pages: [{ cid: 1, page: 1, part: 'P1', duration: 1 }] } }
        return { code: 0, data: {} }
      },
      async post () { return { code: 0, data: { rpid: 999, rpid_str: '999' } } },
      async raw () { return { code: 0, data: {} } },
      async nav () { return { code: 0, data: { mid: 1000001, isLogin: true } } },
      cred () { return { sessdata: 'S', bili_jct: '0123456789abcdef0123456789abcdef' } },
      state () { return { banned: false, banMinutesLeft: 0, banWhy: null, cacheEntries: 0 } },
    }
    const innerDeps = {
      client, config, owner: OWNER, log: () => {},
      quota: { gate: quotaModule.gate, record: quotaModule.record, status: (c) => quotaModule.quotaStatus(c ?? config) },
      capabilities: capabilities.createCapabilityRegistry({ log: () => {} }),
    }
    const tools = buildTools(innerDeps)
    const deps = { tools: new Map(tools.map((item) => [item.name, item])), log: () => {}, config }
    const ledgerFile = quotaModule.quotaFile(config)
    const bvid = 'BV1GJ411x7h1'

    const first = await actions.runActions({ ok: true, actions: [{ tool: 'bili_comment', args: { bvid, message: '第一条' } }] }, deps)
    assert.equal(first.executed.length, 1, '第一次应当执行，实际跳过 ' + JSON.stringify(first.skipped))
    const firstLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
    assert.equal(firstLedger.log.length, 1, '正常写必须记账一次（这是对照基线）')
    assert.equal(firstLedger.log[0].type, 'comment', '账本条目的 type 必须是 comment')
    const lastAt = firstLedger.log[0].at

    const second = await actions.runActions({ ok: true, actions: [{ tool: 'bili_comment', args: { bvid, message: '第二条（同一个 bvid）' } }] }, deps)
    assert.deepEqual(second.skipped, [{ tool: 'bili_comment', why: 'already-commented' }], '同一 bvid 第二次必须记 already-commented，实际 ' + JSON.stringify(second.skipped))
    const secondLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
    assert.equal(secondLedger.log.length, 1, '命中去重时不许记账（记账 = 消耗了一次写间隔），实际 ' + secondLedger.log.length + ' 条')
    assert.equal(secondLedger.log[0].at, lastAt, '最后一条写的时间戳不许变（gap 的基准就是它）')
    assert.equal(schedule.countsToday().comment, 1, '今日评论计数也不许再涨，实际 ' + schedule.countsToday().comment)

    const third = await actions.runActions({ ok: true, actions: [{ tool: 'bili_comment', args: { bvid: 'BV1GJ411x7h9', message: '换一条' } }] }, deps)
    assert.equal(third.executed.length, 1, '不同 bvid 应当能发，实际跳过 ' + JSON.stringify(third.skipped))
  } finally {
    env.restore()
  }
})

test('commentedBvids 上限 100：塞 101 个之后再评论一条 → 只剩最近 100 个（最老的被挤掉）', async () => {
  const env = socialEnv('social-commented-cap')
  try {
    const actions = await import(repoUrl('lib/core/actions.js'))
    const { readState } = await import(repoUrl('lib/core/state.js'))
    await primeSchedule()
    const seeded = Array.from({ length: 101 }, (_, i) => 'BVseed' + String(i).padStart(4, '0'))
    await seedState({ commentedBvids: seeded })
    const comment = tool('bili_comment')
    const deps = { tools: new Map([['bili_comment', comment]]), log: () => {}, quota: fakeQuota() }

    const newBvid = 'BV1GJ411x7hF'
    const out = await actions.runActions({ ok: true, actions: [{ tool: 'bili_comment', args: { bvid: newBvid, message: '新的一条' } }] }, deps)
    assert.equal(out.executed.length, 1, '新 bvid 应当能发')
    const list = readState().commentedBvids
    assert.ok(Array.isArray(list), 'commentedBvids 必须是数组')
    assert.equal(list.length, 100, '最多保留 100 个，实际 ' + list.length)
    assert.equal(list.at(-1), newBvid, '最新那条必须在末尾（新的在后）')
    assert.equal(list.includes(seeded[0]), false, '最老的几条必须被挤掉，实际还在：' + seeded[0])
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ c-e. 睡前汇报 ══════════════════════════ */

/** 造一个「下一次醒来一定落在窗口外」的日程：窗口从现在-60min 到 +15min，间隔 45min。 */
/** 写一份「刚更新过」的梗库：让 shouldRefresh() 为 false。 */
function writeFreshMemes (memes, items = [{ meme: '旧梗甲', meaning: '含义甲', example: '', seen: 0, uses: [] }, { meme: '旧梗乙', meaning: '含义乙', example: '', seen: 1, uses: [] }]) {
  fs.writeFileSync(memes.memesPath(), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'llm', stage: 'fresh', items, lastAttemptAt: '', lastMemeError: '' }))
}

/** 写一份「40 天没更新」的梗库：让 shouldRefresh() 为 true。 */
function writeStaleMemes (memes) {
  const long = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString()
  fs.writeFileSync(memes.memesPath(), JSON.stringify({ updatedAt: long, source: 'llm', stage: 'stale', items: [{ meme: '过期梗', meaning: '旧的', example: '', seen: 0, uses: [] }], lastAttemptAt: '', lastMemeError: '' }))
  return long
}

/**
 * 造一个「下一次醒来一定落在窗口外」的日程：窗口从现在-60min 到 +15min，间隔 45min。
 * 注意：这里**顺便把梗库标成新鲜的**。timer 醒来时若 shouldRefresh() 为真（梗库 ≥30 天或从未刷新），
 *   autonomy 会额外异步发起一次 refreshMemes（§14.3），那一跳也会走 llm.stream。
 *   不预置的话，「llm 只被调 1 次」这类断言会被月更干扰 —— 那是月更的行为，不是汇报的。
 */
async function primeNearBedtime (over = {}) {
  const start = clock(nowMinutes() - 60)
  const end = clock(nowMinutes() + 15)
  const memes = await import(repoUrl('lib/core/memes.js'))
  writeFreshMemes(memes)   // 别让 timer 顺手触发月更（见上面的注释）
  return primeSchedule({ windows: [{ start, end }], intervalMin: 45, jitter: 0, ...over })
}

test('睡前汇报：下一次醒来落在窗口外 → 发一条 bili_dm（含计数与最后一句话），审计 report=true 且已记 lastBedtimeReportAt', async () => {
  const env = socialEnv('social-bedtime')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    const { readState } = await import(repoUrl('lib/core/state.js'))
    autonomy.stop()
    const schedule = await primeNearBedtime()
    assert.equal(schedule.inWindow(schedule.loadSchedule(), schedule.nextWakeAt(Date.now(), schedule.loadSchedule())), false, '前提：下一次醒来必须落在窗口外')
    await seedState({
      counters: { date: localDayKey(), counts: { read: 3, comment: 2, reply: 1, dynamic: 0, dm: 0, like: 0, follow: 0 } },
      lastLine: '今天好累，但挺开心',
      lastBedtimeReportAt: '',
    })

    const dm = tool('bili_dm')
    const deps = { tools: new Map([['bili_dm', dm]]), llm: fakeLlm(emptyDecision()), log: () => {}, ctx: {} }
    const result = await autonomy.runOnce('timer', deps)
    assert.equal(result.ok, true, '这一轮本身应当成功，实际 ' + JSON.stringify(result).slice(0, 200))

    assert.equal(dm.calls.length, 1, '睡前必须恰好发一条私信，实际 ' + dm.calls.length + ' 条')
    const text = String(dm.calls[0].text ?? '')
    assert.ok(text.includes('今天这会儿我做了这些：'), '汇报正文要用确定性模板，实际开头：' + text.slice(0, 60))
    assert.ok(text.includes('看了 3 条视频'), '要看今天的看片计数（3），实际：' + text)
    assert.ok(text.includes('说了 3 句（评论 2 条、回复 1 条、动态 0 条）'), '要报评论/回复/动态的计数，实际：' + text)
    assert.ok(text.includes('今天好累，但挺开心'), '要带上最后一句话，实际：' + text)
    assert.ok(text.includes('睡一会儿，醒来再说。'), '结尾要有那句固定的收尾')

    const reportRows = audit.readAudit(20).filter((row) => row.args?.report === 'true')
    assert.equal(reportRows.length, 1, '必须留一条 report 审计，实际 ' + reportRows.length)
    assert.equal(reportRows[0].tool, 'bili_dm', '审计的 tool 必须是 bili_dm')
    assert.equal(reportRows[0].why, '睡前汇报', '审计 why 必须是「睡前汇报」，实际 ' + reportRows[0].why)
    assert.ok(Number.isFinite(Date.parse(String(readState().lastBedtimeReportAt))), '成功后必须记 lastBedtimeReportAt，实际 ' + readState().lastBedtimeReportAt)
  } finally {
    env.restore()
  }
})

test('不该发·窗口内普通醒来：下一次醒来仍在窗口内 → 不发私信', async () => {
  const env = socialEnv('social-bedtime-inwindow')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    autonomy.stop()
    const schedule = await primeSchedule()
    assert.equal(schedule.inWindow(schedule.loadSchedule(), schedule.nextWakeAt(Date.now(), schedule.loadSchedule())), true, '前提：下一次醒来仍在窗口内')
    await seedState({ lastLine: '普通的一轮' })

    const dm = tool('bili_dm')
    const deps = { tools: new Map([['bili_dm', dm]]), llm: fakeLlm(emptyDecision()), log: () => {}, ctx: {} }
    const result = await autonomy.runOnce('timer', deps)
    assert.equal(result.ok, true)
    assert.equal(dm.calls.length, 0, '窗口内普通醒来不该发睡前汇报，实际 ' + dm.calls.length + ' 条')
  } finally {
    env.restore()
  }
})

test('不该发·配置关 与 同一窗口第二次：bedtimeReport=false 不发；已汇报过的同一个窗口再醒也不发', async () => {
  const env = socialEnv('social-bedtime-off')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    autonomy.stop()

    // ① 开关关掉：即使「下次在窗口外」也不发
    await primeNearBedtime({ bedtimeReport: false })
    await seedState({ lastLine: '关掉汇报的一轮' })
    const dmOff = tool('bili_dm')
    const depsOff = { tools: new Map([['bili_dm', dmOff]]), llm: fakeLlm(emptyDecision()), log: () => {}, ctx: {} }
    const off = await autonomy.runOnce('timer', depsOff)
    assert.equal(off.ok, true)
    assert.equal(dmOff.calls.length, 0, 'bedtimeReport=false 时一条都不该发，实际 ' + dmOff.calls.length + ' 条')

    // ② 同一个窗口第二次醒来：第一次发过之后，第二次不再发
    await primeNearBedtime({ bedtimeReport: true })
    await seedState({ lastLine: '第二窗口测试' })
    const dm = tool('bili_dm')
    const deps = { tools: new Map([['bili_dm', dm]]), llm: fakeLlm(emptyDecision()), log: () => {}, ctx: {} }
    const first = await autonomy.runOnce('timer', deps)
    assert.equal(first.ok, true)
    assert.equal(dm.calls.length, 1, '第一次（本窗口最后一次醒来）应当发一条')
    const second = await autonomy.runOnce('timer', deps)
    assert.equal(second.ok, true)
    assert.equal(dm.calls.length, 1, '同一个窗口第二次醒来不许再发，实际累计 ' + dm.calls.length + ' 条')
  } finally {
    env.restore()
  }
})

test('DM 失败：只尝试 1 次、不抛、不记 lastBedtimeReportAt（下次还会试）', async () => {
  const env = socialEnv('social-bedtime-fail')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    const { readState } = await import(repoUrl('lib/core/state.js'))
    autonomy.stop()
    await primeNearBedtime()
    await seedState({ lastLine: '失败的汇报' })

    const dm = tool('bili_dm', () => ({ ok: false, reason: 'bili-error', human: '发不出去（桩）' }))
    const deps = { tools: new Map([['bili_dm', dm]]), llm: fakeLlm(emptyDecision()), log: () => {}, ctx: {} }
    let result = null
    await assert.doesNotReject(async () => { result = await autonomy.runOnce('timer', deps) }, '汇报失败绝不许把 tick 抛穿')
    assert.equal(result.ok, true, '汇报失败不该影响这一轮本身')
    assert.equal(dm.calls.length, 1, '失败只尝试 1 次（不重试），实际 ' + dm.calls.length + ' 次')
    assert.equal(String(readState().lastBedtimeReportAt ?? ''), '', '失败不许记 lastBedtimeReportAt（下次还要试），实际 ' + JSON.stringify(readState().lastBedtimeReportAt))
    const rows = audit.readAudit(20).filter((row) => row.args?.report === 'true')
    assert.equal(rows.length, 1, '失败也要留一条 report 审计（事后能查「为什么没收到」），实际 ' + rows.length)
    assert.equal(rows[0].ok, false, '审计里要如实记失败（审计行是扁平形状：ok / reason 在顶层）')
  } finally {
    env.restore()
  }
})

test('睡前汇报是确定性模板、不额外调模型：正文与 state 逐字符对得上，llm 只被调 1 次', async () => {
  const env = socialEnv('social-bedtime-template')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    autonomy.stop()
    await primeNearBedtime()
    await seedState({
      counters: { date: localDayKey(), counts: { read: 5, comment: 1, reply: 2, dynamic: 3, dm: 0, like: 0, follow: 0 } },
      lastLine: '今天看到一条特别好的剪辑',
      lastBedtimeReportAt: '',
    })
    // 梗库的「新鲜」由 primeNearBedtime() 预置 —— 这样「llm 只被调 1 次」才能归因到汇报本身
    // （汇报是确定性模板，不调模型）；否则 timer 会额外触发一次 §14.3 的月更调用。
    const memes = await import(repoUrl('lib/core/memes.js'))
    assert.equal(memes.shouldRefresh(Date.now()), false, '前提：梗库刚更新过，不该再触发月更')

    const dm = tool('bili_dm')
    const llm = fakeLlm(emptyDecision())
    const deps = { tools: new Map([['bili_dm', dm]]), llm, log: () => {}, ctx: {} }
    const result = await autonomy.runOnce('timer', deps)
    assert.equal(result.ok, true, '这一轮应当成功')
    // 先让出几轮事件循环：若有「迟到的」月更，它会在这一刻打到 llm 上（这正是要排除的）
    await waitFor(() => false, 40)
    assert.equal(llm.calls, 1, '汇报本身不许再调一次模型（模板是确定性的），实际 llm 被调 ' + llm.calls + ' 次')
    assert.equal(dm.calls.length, 1, '应当发了一条汇报')

    // 逐字符重建期望正文：计数来自 todayCounts、三个指标来自 readMetrics、最后一句来自 state.lastLine
    const counts = schedule.countsToday()
    const m = metrics.readMetrics()
    const said = counts.comment + counts.reply + counts.dynamic
    const expected = [
      '今天这会儿我做了这些：',
      '· 看了 ' + counts.read + ' 条视频（B 站热门/排行/关注）',
      '· 说了 ' + said + ' 句（评论 ' + counts.comment + ' 条、回复 ' + counts.reply + ' 条、动态 ' + counts.dynamic + ' 条）',
      '· 现在：精力 ' + m.energy + ' · 心情 ' + m.mood + ' · 倦怠 ' + m.boredom,
      '· 最后一句话：「今天看到一条特别好的剪辑」',
      '睡一会儿，醒来再说。',
    ].join(NL)
    assert.equal(String(dm.calls[0].text), expected, '汇报正文必须与确定性模板逐字符一致，实际：' + JSON.stringify(String(dm.calls[0].text)))
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ f. 月更只在定时醒来时发生（§14.3） ══════════════════════════ */

/** 等一个条件成立（有上限，不睡真实时间）。 */
async function waitFor (predicate, turns = 300) {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return true
    await new Promise((resolve) => setImmediate(resolve))
  }
  return predicate()
}

test('timer + 梗库过期：llm 被调 2 次（第 2 次是月更），梗库 updatedAt 变新且 source=llm', async () => {
  const env = socialEnv('social-regen-timer-stale')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const memes = await import(repoUrl('lib/core/memes.js'))
    autonomy.stop()
    await primeSchedule()   // 全天窗口：不涉及睡前汇报
    await seedState()
    const staleAt = writeStaleMemes(memes)
    assert.equal(memes.shouldRefresh(Date.now()), true, '前提：梗库必须是「该刷新」的状态')

    // 第 1 次调用给月更要的 JSON 数组，第 2 次给 brain 的决策对象。
    // 顺序是确定的：tick 先发起 refreshMemes（同步跑到第一次 await，即 llm 的第一次 next），
    // 之后才调 decide。所以用调用序号区分是安全的 —— 也正好能证明「第 2 次是刷新」。
    let calls = 0
    const llm = {
      async *stream () {
        calls += 1
        if (calls === 1) {
          yield { type: 'text-delta', text: JSON.stringify([{ meme: '新热梗', meaning: '刚火的', example: '' }, { meme: '另一个', meaning: '也火', example: '' }]) }
        } else {
          yield { type: 'text-delta', text: JSON.stringify(emptyDecision()) }
        }
        yield { type: 'finish', reason: { kind: 'ok' } }
      },
    }
    const dm = tool('bili_dm')
    const deps = { tools: new Map([['bili_dm', dm]]), llm, log: () => {}, ctx: {} }

    await autonomy.runOnce('timer', deps)
    const refreshed = await waitFor(() => memes.loadMemes().updatedAt !== staleAt)
    assert.equal(refreshed, true, 'timer 醒来必须真的把梗库刷新了（月更只在定时醒来时发生）')
    assert.equal(calls, 2, 'timer + 过期梗库应当是 2 次模型调用（决策 + 月更），实际 ' + calls + ' 次')
    const after = memes.loadMemes()
    assert.notEqual(after.updatedAt, staleAt, 'updatedAt 必须变新')
    assert.equal(after.source, 'llm', '没有 web_search 时来源必须如实写 llm，实际 ' + after.source)
    assert.equal(after.stage, 'fresh', '刷新成功后 stage 必须是 fresh')
    assert.equal(after.items.length, 2, '月更拿到的两条应当落盘，实际 ' + after.items.length)
  } finally {
    env.restore()
  }
})

test('timer + 梗库新鲜：只调 1 次模型（不触发月更）', async () => {
  const env = socialEnv('social-regen-timer-fresh')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const memes = await import(repoUrl('lib/core/memes.js'))
    autonomy.stop()
    await primeSchedule()
    await seedState()
    writeFreshMemes(memes)
    assert.equal(memes.shouldRefresh(Date.now()), false, '前提：梗库刚更新过')

    const llm = fakeLlm(emptyDecision())
    const deps = { tools: new Map([['bili_dm', tool('bili_dm')]]), llm, log: () => {}, ctx: {} }
    await autonomy.runOnce('timer', deps)
    assert.equal(llm.calls, 1, '梗库新鲜时 timer 醒来只该有 1 次模型调用（决策），实际 ' + llm.calls + ' 次')
  } finally {
    env.restore()
  }
})

test('manual + 梗库过期：只调 1 次模型（月更只在定时醒来时发生，manual 不刷）', async () => {
  const env = socialEnv('social-regen-manual-stale')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const memes = await import(repoUrl('lib/core/memes.js'))
    autonomy.stop()
    await primeSchedule()
    await seedState()
    const staleAt = writeStaleMemes(memes)
    assert.equal(memes.shouldRefresh(Date.now()), true, '前提：梗库是「该刷新」的状态')

    const llm = fakeLlm(emptyDecision())
    const deps = { tools: new Map([['bili_dm', tool('bili_dm')]]), llm, log: () => {}, ctx: {} }
    await autonomy.runOnce('manual', deps)
    assert.equal(llm.calls, 1, 'manual 醒来只该有 1 次模型调用（决策），实际 ' + llm.calls + ' 次')
    // 再等几轮事件循环，确认没有「迟到的」刷新把它改掉
    await waitFor(() => false, 30)
    assert.equal(memes.loadMemes().updatedAt, staleAt, 'manual 不许触发月更（updatedAt 不该变）')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ g. 汇报里的「看了 N 条」必须等于 todayCounts.read ══════════════════════════ */

test('汇报与计数一致：正文里的「看了 N 条」等于当时的 todayCounts().read（从正文抠数字比，不写死）', async () => {
  const env = socialEnv('social-report-count')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    autonomy.stop()
    await primeNearBedtime()
    await seedState({
      counters: { date: localDayKey(), counts: { read: 4, comment: 1, reply: 0, dynamic: 0, dm: 0, like: 0, follow: 0 } },
      lastLine: '看了几个视频',
      lastBedtimeReportAt: '',
    })

    const dm = tool('bili_dm')
    const deps = { tools: new Map([['bili_dm', dm]]), llm: fakeLlm(emptyDecision()), log: () => {}, ctx: {} }
    const result = await autonomy.runOnce('timer', deps)
    assert.equal(result.ok, true, '这一轮应当成功')
    assert.equal(dm.calls.length, 1, '应当发一条睡前汇报')

    const text = String(dm.calls[0].text ?? '')
    const matched = /看了 (\d+) 条视频/.exec(text)
    assert.ok(matched !== null, '正文里必须能找到「看了 N 条视频」，实际：' + text)
    const shown = Number(matched[1])
    const actual = schedule.countsToday().read
    assert.equal(shown, actual, '汇报里的看片数必须等于当时的 todayCounts().read（shown=' + shown + '，counts=' + actual + '）')
    assert.equal(actual, 4, '这一轮没有执行任何读动作，计数应当仍是种下的 4，实际 ' + actual)
  } finally {
    env.restore()
  }
})
