// tests/tool-audit.test.mjs —— 工具层审计（makeTool.execute 里那一层）
//
// 为什么这样测：
//   这一层是「她（或任何 agent）在会话里直接调 bili_* 」的留痕点 —— 所有 25 个工具都从这里过，
//   所以它一旦漏记，等于公开动作没有痕迹。三条纪律必须分开钉：
//     ① 行的形状能对上（tool/source/ok/reason/why，by 有就给、拿不到就不出现）；
//     ② **脱敏**：凭据键整个不出现、对象值只写 [object]、超长文本被截且带省略号；
//     ③ **审计坏了不许影响工具**（审计是旁路，不是功能的一部分）。
//   另外钉一条反向的：**自主层**自己的审计行（带真实 why）不该出现 source 字段 ——
//   两套审计并存，但别混成一套（混了以后"这条是谁写的"就说不清了）。
//   全程假 client + 临时 self 目录，零真实网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

function auditEnv (tag) {
  const root = tmpDir(tag)
  const restoreSandbox = sandboxEnv(root)
  const restoreSelf = setEnv({ DSH_BILI_SELF_DIR: path.join(root, 'self') })
  fs.mkdirSync(path.join(root, 'self'), { recursive: true })
  return { root, selfDir: path.join(root, 'self'), restore () { restoreSelf(); restoreSandbox(); cleanupTmp() } }
}

/** 一套能跑通的假依赖（只读工具用；不发任何真实请求）。 */
function fakeDeps (selfDir) {
  const client = {
    async get (target) {
      if (target === '/x/web-interface/nav') return { code: 0, data: { mid: 1000001, isLogin: true, uname: '我' } }
      return { code: 0, data: {} }
    },
    async post () { return { code: 0, data: {} } },
    async raw () { return { code: 0, data: {} } },
    async nav () { return { code: 0, data: { mid: 1000001, isLogin: true } } },
    cred () { return { sessdata: 'S', bili_jct: '0123456789abcdef0123456789abcdef' } },
    state () { return { banned: false, banMinutesLeft: 0, banWhy: null, cacheEntries: 0 } },
  }
  return {
    client,
    config: { owner: { mid: 389989266, uname: '主人' }, risk: {}, paths: { stateDir: selfDir } },
    owner: { mid: 389989266, uname: '主人' },
    quota: { gate: () => ({ ok: true }), record: () => ({ ok: true }), status: () => ({}) },
    capabilities: { list: () => [], call: () => ({ ok: false, reason: 'capability-not-found' }) },
    log: () => {},
  }
}

async function toolsFor (selfDir) {
  const { buildTools } = await import(repoUrl('lib/tools/index.js'))
  const list = buildTools(fakeDeps(selfDir))
  return { list, byName: new Map(list.map((item) => [item.name, item])) }
}

/* ══════════════════════════ ① 行形状 ══════════════════════════ */

test('工具层审计：调一次 bili_* 就追加一条（tool/source/ok/reason/why），能拿到 agent.id 时 by 有值', async () => {
  const env = auditEnv('ta-shape')
  try {
    const audit = await import(repoUrl('lib/core/audit.js'))
    const { byName } = await toolsFor(env.selfDir)
    const status = byName.get('bili_status')

    const result = await status.execute({}, { agent: { id: 'agent-7' } })
    assert.equal(result.ok, true, '前提：这次调用本身要成功，实际 ' + JSON.stringify(result).slice(0, 160))

    const rows = audit.readAudit(20)
    assert.equal(rows.length, 1, '一次工具调用必须恰好留一行，实际 ' + rows.length)
    const row = rows[0]
    assert.equal(row.tool, 'bili_status', 'tool 必须是工具名，实际 ' + JSON.stringify(row.tool))
    assert.equal(row.source, 'tool', '工具层的行必须带 source:"tool"，实际 ' + JSON.stringify(row.source))
    assert.equal(row.why, '工具调用', '工具层的 why 固定是「工具调用」（真实 why 是自主层那套），实际 ' + JSON.stringify(row.why))
    assert.equal(row.ok, true, '成功时 ok 必须是 true')
    assert.ok('reason' in row, 'reason 字段必须存在（成功时为 null）')
    assert.equal(row.by, 'agent-7', '能拿到 agent.id 时 by 必须有值，实际 ' + JSON.stringify(row.by))
  } finally {
    env.restore()
  }
})

test('工具层审计：拿不到调用者身份时 by 字段**不出现**（不是空串，也不伪造）', async () => {
  const env = auditEnv('ta-no-by')
  try {
    const audit = await import(repoUrl('lib/core/audit.js'))
    const { byName } = await toolsFor(env.selfDir)
    const status = byName.get('bili_status')

    await status.execute({}, {})
    const rows = audit.readAudit(20)
    assert.equal(rows.length, 1, '仍然要留一行')
    assert.equal('by' in rows[0], false, '拿不到身份时不许出现 by 字段，实际 ' + JSON.stringify(rows[0].by))
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ ② 脱敏 ══════════════════════════ */

test('工具层审计脱敏：凭据键整个不出现、对象值写 [object]、超长文本被截且带省略号', async () => {
  const env = auditEnv('ta-redact')
  try {
    const audit = await import(repoUrl('lib/core/audit.js'))
    const { byName } = await toolsFor(env.selfDir)
    const status = byName.get('bili_status')

    const LONG = '这是一段很长的正文'.repeat(40)
    await status.execute({
      message: LONG,
      sessdata: 'SESSDATA-VALUE',
      cookie: 'COOKIE-VALUE',
      token: 'TOKEN-VALUE',
      bili_jct: 'JCT-VALUE',
      nested: { deep: true },
      num: 7,
      flag: false
    }, {})

    const rows = audit.readAudit(20)
    assert.equal(rows.length, 1)
    const args = rows[0].args
    for (const key of ['sessdata', 'cookie', 'token', 'bili_jct']) {
      assert.equal(key in args, false, '凭据键必须整个不出现：' + key + '，实际 args=' + JSON.stringify(args))
    }
    assert.equal(args.nested, '[object]', '对象值只许写 [object]，实际 ' + JSON.stringify(args.nested))
    // 注意：审计落盘时非对象值会被 String 化（audit.js 的 summarize 对每个值做 String(value)），
    // 所以数字/布尔读回来是字符串 '7' / 'false' —— 这是存储层的既有行为，不是丢字段。
    assert.equal(args.num, '7', '数字要被保留成字符串 7（summarize 会 String 化），实际 ' + JSON.stringify(args.num))
    assert.equal(args.flag, 'false', '布尔要被保留成字符串 false，实际 ' + JSON.stringify(args.flag))

    assert.equal(typeof args.message, 'string')
    assert.ok(args.message.length <= 81, '超长文本必须被截（≤80 字 + 省略号），实际长度 ' + args.message.length)
    assert.ok(args.message.endsWith('…'), '被截的文本必须以省略号结尾，实际 ' + JSON.stringify(args.message.slice(-3)))
    assert.notEqual(args.message, LONG, '不许原样写入超长正文')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ ③ 失败也落盘 ══════════════════════════ */

test('工具层审计：工具返回 ok:false 也照样落盘，行里 ok:false 且带 reason', async () => {
  const env = auditEnv('ta-fail')
  try {
    const audit = await import(repoUrl('lib/core/audit.js'))
    const { byName } = await toolsFor(env.selfDir)
    const comments = byName.get('bili_comments')

    const result = await comments.execute({}, {})   // 缺 oid → bad-argument，零网络
    assert.equal(result.ok, false, '前提：这次调用要失败，实际 ' + JSON.stringify(result).slice(0, 160))

    const rows = audit.readAudit(20)
    assert.equal(rows.length, 1, '失败也必须留一行（"没发生"和"没记"要分得开），实际 ' + rows.length)
    assert.equal(rows[0].ok, false, '行里 ok 必须是 false')
    assert.equal(rows[0].reason, result.reason, '行里的 reason 必须与工具返回一致，实际 ' + JSON.stringify(rows[0].reason))
    assert.ok(String(rows[0].reason).length > 0, 'reason 不许为空')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ ④ 审计坏了不影响工具 ══════════════════════════ */

test('审计写不进去时：工具仍返回正常结果、不抛（审计是旁路）', async () => {
  const env = auditEnv('ta-audit-broken')
  try {
    const audit = await import(repoUrl('lib/core/audit.js'))
    // 把 audit.jsonl 做成**目录**：appendFileSync 必然 EISDIR
    fs.mkdirSync(audit.auditPath(), { recursive: true })
    const { byName } = await toolsFor(env.selfDir)
    const status = byName.get('bili_status')

    let result = null
    await assert.doesNotReject(async () => { result = await status.execute({}, {}) }, '审计坏了绝不许把工具调用抛穿')
    assert.equal(result.ok, true, '工具结果必须照常返回成功，实际 ' + JSON.stringify(result).slice(0, 160))
    assert.equal(audit.readAudit(20).length, 0, '前提：这次真的写不进去（所以没有任何可读行）')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ ⑤ 自主层行不带 source ══════════════════════════ */

test('自主层写的审计行不出现 source 字段（两套审计并存，但不许混成一套）', async () => {
  const env = auditEnv('ta-autonomy-rows')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    const { patchState } = await import(repoUrl('lib/core/state.js'))
    const memes = await import(repoUrl('lib/core/memes.js'))

    autonomy.stop()
    schedule.unlock()
    schedule.saveSchedule({ enabled: true, windows: [{ start: '00:00', end: '24:00' }], allows: { read: true }, minWatchPerWake: false, commentAfterWatch: false, bedtimeReport: false })
    patchState({ counters: {}, silenceUntil: 0, metrics: { energy: 60, mood: 55, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 } })
    fs.writeFileSync(memes.memesPath(), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'llm', stage: 'fresh', items: [], lastAttemptAt: '', lastMemeError: '' }))

    const llm = { async *stream () { yield { type: 'text-delta', text: JSON.stringify({ mood: '平静', say: '', actions: [], diary: '', memory: [] }) }; yield { type: 'finish', reason: { kind: 'ok' } } } }
    await autonomy.runOnce('manual', { tools: new Map(), llm, log: () => {}, ctx: {} })

    const rows = audit.readAudit(20)
    assert.ok(rows.length > 0, '前提：这一轮必须真的写了审计行')
    for (const row of rows) {
      assert.equal('source' in row, false, '自主层的行不许出现 source 字段（那是工具层的标记），实际行：' + JSON.stringify(row).slice(0, 200))
      assert.equal(row.source, undefined, 'source 必须是 undefined')
    }
  } finally {
    env.restore()
  }
})
