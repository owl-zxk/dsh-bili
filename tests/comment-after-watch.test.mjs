// tests/comment-after-watch.test.mjs —— 看完必须评论并 @主人（AUTONOMY-PROMPT §22）
//
// 为什么这样测：
//   这条兜底会**用主人的账号在公开场合说话**，所以每一条都必须同时钉住「该补」和「不许乱补」：
//     · 看过视频但没评论 → 恰补一条，正文来自她自己的 say（去掉开头 @xx、压掉换行、≤120），
//       收件人风格沿用 atOwnerOnComment；
//     · 她自己评论过 / 关掉开关 / 通道关 / 同 bvid 已评论 / 写间隔未到 / 没有 bvid → 一条都不许发，
//       而且**要留下能解释原因的一条审计**（事后要能回答「那天她为什么没说话」）；
//     · 每轮最多一条（结构上就是单条 action，用例用「只被调用一次」钉住）。
//   全部假 llm / 假工具 + 临时 self 目录，零真实网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

const NL = String.fromCharCode(10)
const BASE_METRICS = { energy: 60, mood: 55, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 }

function cawEnv (tag) {
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
  const saved = schedule.saveSchedule({ enabled: true, windows: [{ start: '00:00', end: '24:00' }], allows: { read: true, comment: true, dm: true }, minWatchPerWake: false, ...over })
  assert.equal(saved.ok, true, '前提：日程必须写成功，实际 ' + JSON.stringify(saved))
  return schedule
}

async function seedState (patch = {}) {
  const { patchState } = await import(repoUrl('lib/core/state.js'))
  patchState({ counters: {}, silenceUntil: 0, metrics: { ...BASE_METRICS }, lastWatchedBvid: '', commentedBvids: [], lastLine: '', lastBedtimeReportAt: '', ...patch })
}

const auditRows = (audit) => audit.readAudit(50)
const fallbackRows = (audit) => auditRows(audit).filter((row) => row.args?.commentFallback === 'true')

/* ══════════════════════════ a. 看过 + 没评论 → 补一条 ══════════════════════════ */

test('看过+没评论：恰补一条评论（bvid 来自 lastWatchedBvid、atOwner 补 true、正文=她的 comment 去前缀压换行）', async () => {
  const env = cawEnv('caw-base')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    autonomy.stop()
    await primeSchedule()
    await seedState()

    const bvid = 'BV1GJ411x7h1'
    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid }] } }))
    const comment = tool('bili_comment', () => ({ ok: true, data: { rpid: 777 } }))
    const SAY = '@主人  这条真好' + NL + '我也想去看'
    // 频道已经分开：公开评论读 comment，say 只用于私信。这里只给 comment，say 故意留空。
    const llm = fakeLlm({ mood: '好奇', say: '', comment: SAY, actions: [{ tool: 'bili_watch', args: { limit: 3 }, why: '刷一下' }], diary: '', memory: [] })
    const deps = { tools: new Map([['bili_watch', watch], ['bili_comment', comment]]), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('manual', deps)
    assert.equal(result.ok, true, '这一轮应当成功，实际 ' + JSON.stringify(result).slice(0, 200))
    assert.equal(watch.calls.length, 1, '模型那次刷视频应当执行')
    assert.equal(comment.calls.length, 1, '看完没评论时必须恰补一条，实际 ' + comment.calls.length + ' 条')

    const args = comment.calls[0]
    assert.equal(args.bvid, bvid, 'bvid 必须来自刚看的那个视频（state.lastWatchedBvid），实际 ' + JSON.stringify(args.bvid))
    assert.equal(args.atOwner, true, 'atOwner 必须走 atOwnerOnComment（默认开 → 补 true），实际 ' + JSON.stringify(args.atOwner))
    assert.equal(args.message, '这条真好 我也想去看', '正文必须是她的 comment 去掉开头 @xx、换行压成空格，实际 ' + JSON.stringify(args.message))

    const rows = fallbackRows(audit)
    assert.equal(rows.length, 1, '必须留一条兜底审计，实际 ' + rows.length)
    assert.equal(rows[0].tool, 'bili_comment', '审计 tool 必须是 bili_comment')
    assert.equal(rows[0].why, '看完评论（兜底）', '审计 why 必须是「看完评论（兜底）」，实际 ' + rows[0].why)
    assert.equal(rows[0].ok, true, '发成功时审计 ok 必须是 true')
    assert.equal(rows[0].args.bvid, bvid, '审计里要记是给哪个视频评论的')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ b. 没有 comment → 不发（旧的固定兜底句已删除） ══════════════════════════ */

test('comment 为空：补写后照发 1 条（看完必须评论），say 仍不许顶上去', async () => {
  const env = cawEnv('caw-empty-comment')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    autonomy.stop()
    await primeSchedule()
    await seedState()

    const bvid = 'BV1GJ411x7h2'
    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid }] } }))
    const comment = tool('bili_comment', () => ({ ok: true, data: { rpid: 1 } }))
    // say 故意给一句状态自述：它只用于私信，绝不许被当成公开评论发出去。
    // 第二次模型调用是「补写评论」：它返回一句只谈内容的话。
    let llmCalls = 0
    const llm = {
      async *stream () {
        llmCalls += 1
        if (llmCalls === 1) {
          yield { type: 'text-delta', text: JSON.stringify({ mood: '平静', say: '我在刷关注列', actions: [{ tool: 'bili_watch', args: { limit: 2 } }], diary: '', memory: [] }) }
        } else {
          yield { type: 'text-delta', text: '这个转场接得很稳' }
        }
        yield { type: 'finish', reason: { kind: 'ok' } }
      }
    }
    const deps = { tools: new Map([['bili_watch', watch], ['bili_comment', comment]]), llm, log: () => {}, ctx: {} }

    await autonomy.runOnce('manual', deps)
    assert.equal(comment.calls.length, 1, '没有 comment 时要补写后发 1 条（看完必须评论），实际 ' + comment.calls.length + ' 条')
    assert.equal(comment.calls[0].message, '这个转场接得很稳', '发出去的必须是补写的那句，实际 ' + JSON.stringify(comment.calls[0].message))
    assert.notEqual(comment.calls[0].message, '我在刷关注列', 'say 绝不许顶成公开评论')
    const repairRows = audit.readAudit(50).filter((row) => row.args?.commentRepair === 'true')
    assert.equal(repairRows.length, 1, '补写成功必须留一条 commentRepair 审计，实际 ' + repairRows.length)
    assert.equal(repairRows[0].ok, true, '补写这条最终发出去了，审计 ok 必须是 true')
    assert.equal(audit.readAudit(50).filter((row) => /跳过：没有可说的内容/.test(String(row.why))).length, 0, '新规则下不该再写「跳过：没有可说的内容」')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ c. 她自己评论过 → 不补 ══════════════════════════ */

test('她自己评论过：同一轮里已有成功的 bili_comment → 不再兜底（只 1 次调用）', async () => {
  const env = cawEnv('caw-own-comment')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    autonomy.stop()
    await primeSchedule()
    await seedState()

    const bvid = 'BV1GJ411x7h3'
    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid }] } }))
    const comment = tool('bili_comment', () => ({ ok: true, data: { rpid: 2 } }))
    const llm = fakeLlm({
      mood: '好奇',
      say: '看完了',
      actions: [
        { tool: 'bili_watch', args: { limit: 2 } },
        { tool: 'bili_comment', args: { bvid, message: '她自己想说的那句' } },
      ],
      diary: '',
      memory: [],
    })
    const deps = { tools: new Map([['bili_watch', watch], ['bili_comment', comment]]), llm, log: () => {}, ctx: {} }

    await autonomy.runOnce('manual', deps)
    assert.equal(comment.calls.length, 1, '她自己评论过就不许再兜底，实际 ' + comment.calls.length + ' 次')
    assert.equal(comment.calls[0].message, '她自己想说的那句', '那一次必须是她的原话（不是兜底正文）')
    assert.equal(fallbackRows(audit).length, 0, '不兜底时不该有 commentFallback 审计，实际 ' + JSON.stringify(fallbackRows(audit)))
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ d. 三种「不该补」的闸 ══════════════════════════ */

test('不该补：commentAfterWatch=false → 0 次；allows.comment=false → 0 次且 why 含 channel-off；同 bvid 已评论 → 0 次且 why 含 already-commented', async () => {
  const env = cawEnv('caw-gates')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    autonomy.stop()
    const bvid = 'BV1GJ411x7h4'
    // 决策必须带 comment：否则会先被「没有可说的内容」拦下，测不到通道/去重这些闸
    const decision = () => ({ mood: '平静', say: '', comment: '看完了，想说一句', actions: [{ tool: 'bili_watch', args: { limit: 2 } }], diary: '', memory: [] })
    const runCase = async (label) => {
      const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid }] } }))
      const comment = tool('bili_comment', () => ({ ok: true, data: { rpid: 3 } }))
      const deps = { tools: new Map([['bili_watch', watch], ['bili_comment', comment]]), llm: fakeLlm(decision()), log: () => {}, ctx: {} }
      const before = auditRows(audit).length
      const result = await autonomy.runOnce('manual', deps)
      assert.equal(result.ok, true, label + '：这一轮本身应当成功')
      return { calls: comment.calls.length, rows: auditRows(audit).slice(before) }
    }

    // ① 开关关掉：连审计都不该有（不是「跳过」，是没这条规则）
    await primeSchedule({ commentAfterWatch: false })
    await seedState()
    const off = await runCase('commentAfterWatch=false')
    assert.equal(off.calls, 0, 'commentAfterWatch=false 时一条都不许发，实际 ' + off.calls)
    assert.equal(off.rows.filter((row) => row.args?.commentFallback === 'true').length, 0, '关掉开关时不该有兜底审计')

    // ② 评论通道关：被 runActions 挡下，且要有一条说明 channel-off 的审计
    //    注意显式把 commentAfterWatch 打开 —— saveSchedule 是合并语义，上一步写进去的 false 会留着，
    //    否则这里的 0 次调用会被误读成「通道闸生效」，其实只是开关还关着。
    await primeSchedule({ allows: { comment: false }, commentAfterWatch: true })
    await seedState()
    const channelOff = await runCase('allows.comment=false')
    assert.equal(channelOff.calls, 0, 'allows.comment=false 时一条都不许发，实际 ' + channelOff.calls)
    const offRow = channelOff.rows.filter((row) => row.args?.commentFallback === 'true')
    assert.equal(offRow.length, 1, '被通道挡下时应当留一条兜底审计，实际 ' + offRow.length)
    assert.match(String(offRow[0].why), /channel-off/, '审计 why 要点名原因 channel-off，实际 ' + offRow[0].why)

    // ③ 同一个 bvid 已经评论过：去重挡下，审计要说 already-commented
    await primeSchedule({ allows: { comment: true }, commentAfterWatch: true })
    await seedState({ commentedBvids: [bvid] })
    const dup = await runCase('already-commented')
    assert.equal(dup.calls, 0, '同 bvid 已评论时一条都不许发，实际 ' + dup.calls)
    const dupRow = dup.rows.filter((row) => row.args?.commentFallback === 'true')
    assert.equal(dupRow.length, 1, '被去重挡下时应当留一条兜底审计，实际 ' + dupRow.length)
    assert.match(String(dupRow[0].why), /already-commented/, '审计 why 要点名原因 already-commented，实际 ' + dupRow[0].why)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ e. 发不出去：只尝试 1 次、审计 1 条 ok:false ══════════════════════════ */

test('发不出去（写间隔未到/闸拒绝）：只尝试 1 次、不重试、审计恰 1 条 ok:false', async () => {
  const env = cawEnv('caw-fail')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    autonomy.stop()
    await primeSchedule()
    await seedState()

    const bvid = 'BV1GJ411x7h5'
    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid }] } }))
    // 真机上「写间隔未到」长这样：闸拒绝 → commentApi 返回 reason=quota-exceeded → 工具 ok:false。
    // 这一层看到的形状与真闸一致（attempted 一次、失败一次），所以用桩注入同一形状。
    const comment = tool('bili_comment', () => ({ ok: false, reason: 'quota-exceeded', human: '上一条评论刚发出去，还要等 98 秒（间隔 120 秒）' }))
    const llm = fakeLlm({ mood: '平静', say: '', comment: '看完了说一句', actions: [{ tool: 'bili_watch', args: { limit: 2 } }], diary: '', memory: [] })
    const deps = { tools: new Map([['bili_watch', watch], ['bili_comment', comment]]), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('manual', deps)
    assert.equal(result.ok, true, '发不出去不该把这一轮算失败（兜底失败不阻塞）')
    assert.equal(comment.calls.length, 1, '发不出去时只许尝试 1 次（不重试），实际 ' + comment.calls.length + ' 次')
    const rows = fallbackRows(audit)
    assert.equal(rows.length, 1, '只许留一条兜底审计（actions 已经记过那次失败，不该再补一条），实际 ' + rows.length)
    assert.equal(rows[0].ok, false, '审计要如实记失败')
    assert.equal(rows[0].reason, 'quota-exceeded', '审计里要带上失败原因，实际 ' + rows[0].reason)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ f. 没有 bvid → 跳过并说明 ══════════════════════════ */

test('lastWatchedBvid 缺失（没看过视频）：0 次评论，审计 why 写「没有可看的视频」', async () => {
  const env = cawEnv('caw-no-bvid')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    autonomy.stop()
    await primeSchedule()
    await seedState()

    // 返回空列表 → actions 记不到 lastWatchedBvid（但这一轮确实"看过"了：bili_watch 成功）
    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [] } }))
    const comment = tool('bili_comment', () => ({ ok: true, data: { rpid: 4 } }))
    const llm = fakeLlm({ mood: '平静', say: '看完了', actions: [{ tool: 'bili_watch', args: { limit: 2 } }], diary: '', memory: [] })
    const deps = { tools: new Map([['bili_watch', watch], ['bili_comment', comment]]), llm, log: () => {}, ctx: {} }

    await autonomy.runOnce('manual', deps)
    assert.equal(comment.calls.length, 0, '没有 bvid 时一条都不许发，实际 ' + comment.calls.length)
    const rows = fallbackRows(audit)
    assert.equal(rows.length, 1, '必须留一条说明「没有 bvid」的审计，实际 ' + rows.length)
    // 2026-11-02 新文案：这一支的含义是「本轮没看过视频」，不是「bvid 解析失败」
    assert.match(String(rows[0].why), /没有可看的视频/, '审计 why 要写清没有可看的视频，实际 ' + rows[0].why)
    assert.equal(rows[0].ok, false, '这条审计是「跳过」，ok 必须是 false')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ f-i. 看完必须评论：补写 / 兜底 / 上限 / 闸 ══════════════════════════ */

test('补写成功：comment 空 → 再问一次模型（≤60 字），发的就是补写那句，审计带 commentRepair:"true"', async () => {
  const env = cawEnv('caw-repair-ok')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    autonomy.stop()
    await primeSchedule()
    await seedState()

    const bvid = 'BV1GJ411x7h6'
    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid }] } }))
    const info = tool('bili_video_info', () => ({ ok: true, data: { title: '海洋镜头合集', desc: '安静的海' } }))
    const comment = tool('bili_comment', () => ({ ok: true, data: { rpid: 9 } }))

    const prompts = []
    let calls = 0
    const llm = {
      async *stream (options) {
        calls += 1
        prompts.push(options ?? {})
        if (calls === 1) {
          yield { type: 'text-delta', text: JSON.stringify({ mood: '平静', say: '我在刷关注列', actions: [{ tool: 'bili_watch', args: { limit: 2 } }], diary: '', memory: [] }) }
        } else {
          yield { type: 'text-delta', text: '这条海洋镜头拍得挺安静的' }
        }
        yield { type: 'finish', reason: { kind: 'ok' } }
      }
    }
    const deps = { tools: new Map([['bili_watch', watch], ['bili_video_info', info], ['bili_comment', comment]]), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('manual', deps)
    assert.equal(result.ok, true, '这一轮应当成功')
    assert.equal(calls, 2, '一决策 + 一补写，模型总调用 2 次，实际 ' + calls)
    assert.equal(comment.calls.length, 1, '补写成功后必须发 1 条，实际 ' + comment.calls.length)
    assert.equal(comment.calls[0].message, '这条海洋镜头拍得挺安静的', '发出去的必须是补写那句，实际 ' + JSON.stringify(comment.calls[0].message))
    // 补写那次请求里该带上视频信息（否则模型只能瞎猜）
    // 协议与 brain 一致：提示词在 messages[0].content[0].text 里（content 是 block 数组，不是字符串）
    const repairPrompt = String(prompts[1]?.messages?.[0]?.content?.[0]?.text ?? '')
    assert.ok(repairPrompt.includes('海洋镜头合集') || repairPrompt.includes(bvid), '补写请求里要带上标题或 bvid，实际：' + repairPrompt.slice(0, 200))

    const rows = audit.readAudit(50)
    assert.equal(rows.filter((row) => row.args?.commentRepair === 'true').length, 1, '审计要能看出这条是补写来的')
    assert.equal(rows.filter((row) => /跳过/.test(String(row.why)) && row.tool === 'bili_comment').length, 0, '补写成功不该有"跳过"审计')
  } finally {
    env.restore()
  }
})

test('补写失败：模型第二次抛错 → 仍发兜底句「看完了，先记一句。」，审计 commentFallback:"forced"', async () => {
  const env = cawEnv('caw-repair-fail')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    autonomy.stop()
    await primeSchedule()
    await seedState()

    const bvid = 'BV1GJ411x7h7'
    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid }] } }))
    const info = tool('bili_video_info', () => ({ ok: true, data: { title: '某条视频' } }))
    const comment = tool('bili_comment', () => ({ ok: true, data: { rpid: 10 } }))

    let calls = 0
    const llm = {
      async *stream () {
        calls += 1
        if (calls === 2) throw new Error('boom-repair')
        yield { type: 'text-delta', text: JSON.stringify({ mood: '平静', say: '刷一下', actions: [{ tool: 'bili_watch', args: { limit: 2 } }], diary: '', memory: [] }) }
        yield { type: 'finish', reason: { kind: 'ok' } }
      }
    }
    const deps = { tools: new Map([['bili_watch', watch], ['bili_video_info', info], ['bili_comment', comment]]), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('manual', deps)
    assert.equal(result.ok, true, '补写失败不许把这一轮弄挂')
    assert.equal(comment.calls.length, 1, '补写失败也要发 1 条（宁可短），实际 ' + comment.calls.length)
    assert.equal(comment.calls[0].message, '看完了，先记一句。', '补写失败必须用兜底句，实际 ' + JSON.stringify(comment.calls[0].message))

    const forcedRows = audit.readAudit(50).filter((row) => row.args?.commentFallback === 'forced')
    assert.equal(forcedRows.length, 1, '审计要能看出这条是强制兜底句，实际 ' + forcedRows.length + '：' + JSON.stringify(audit.readAudit(50).map((row) => row.args?.commentFallback)))
  } finally {
    env.restore()
  }
})

test('补写次数上限：一轮里两条待评也只补写一次 → 模型总调用 2 次、只发 1 条评论', async () => {
  const env = cawEnv('caw-repair-once')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    autonomy.stop()
    await primeSchedule()
    await seedState()

    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid: 'BV1GJ411x7h8' }] } }))
    const info = tool('bili_video_info', () => ({ ok: true, data: { title: '两个条目' } }))
    const comment = tool('bili_comment', () => ({ ok: true, data: { rpid: 11 } }))

    let calls = 0
    const llm = {
      async *stream () {
        calls += 1
        if (calls === 1) {
          // 两条只看动作（模拟"这轮刷到两条"），comment 一律为空
          yield { type: 'text-delta', text: JSON.stringify({ mood: '平静', say: '', actions: [{ tool: 'bili_watch', args: { limit: 2 } }, { tool: 'bili_watch', args: { limit: 3 } }], diary: '', memory: [] }) }
        } else {
          yield { type: 'text-delta', text: '两条都挺好看的' }
        }
        yield { type: 'finish', reason: { kind: 'ok' } }
      }
    }
    const deps = { tools: new Map([['bili_watch', watch], ['bili_video_info', info], ['bili_comment', comment]]), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('manual', deps)
    assert.equal(result.ok, true, '这一轮应当成功')
    assert.equal(calls, 2, '补写每轮最多一次：模型总调用必须是 2（1 决策 + 1 补写），实际 ' + calls)
    assert.equal(comment.calls.length, 1, '一轮只发 1 条评论，实际 ' + comment.calls.length)
  } finally {
    env.restore()
  }
})

test('写闸不绕：「必须评论」也不许跳过闸 —— 写间隔未到就只尝试 1 次并如实记失败', async () => {
  const env = cawEnv('caw-forced-but-gated')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    autonomy.stop()
    await primeSchedule()
    await seedState()

    const bvid = 'BV1GJ411x7h9'
    const watch = tool('bili_watch', () => ({ ok: true, data: { items: [{ bvid }] } }))
    const // 写间隔未到：真闸拒绝 → commentApi 返回 quota-exceeded
      comment = tool('bili_comment', () => ({ ok: false, reason: 'quota-exceeded', human: '上一条刚发出去，还要等 98 秒' }))
    const decision = { mood: '好奇', say: '', comment: '这条我想说两句', actions: [{ tool: 'bili_watch', args: { limit: 2 } }], diary: '', memory: [] }
    const deps = { tools: new Map([['bili_watch', watch], ['bili_comment', comment]]), llm: fakeLlm(decision), log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('manual', deps)
    assert.equal(result.ok, true, '闸拒绝不该把这一轮弄挂')
    assert.equal(comment.calls.length, 1, '闸拒绝时只许尝试 1 次（不重试、不绕），实际 ' + comment.calls.length)
    const rows = audit.readAudit(50).filter((row) => row.tool === 'bili_comment')
    assert.equal(rows.length, 1, '失败也只记一条审计，实际 ' + rows.length)
    assert.equal(rows[0].ok, false, '审计要如实记失败')
    assert.equal(rows[0].reason, 'quota-exceeded', 'reason 要原样透出，实际 ' + JSON.stringify(rows[0].reason))
  } finally {
    env.restore()
  }
})
