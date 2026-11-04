// tests/learning.test.mjs —— 学习层（lib/core/learning.js + 两处挂钩 + wake-context）
//
// 为什么这样测：
//   学习层是「她到底有没有在长进」的唯一证据链：learning.jsonl（一行一条）→ distill 归纳成
//   knowledge.md（三节）→ wake-context.md 把「我最近在想什么 / 最近看过」交给下一轮的会话。
//   链上每一环都有各自的失效方式，所以分开钉：
//     · 写入：字段齐全、gist ≤200、tags ≤3、计数 +1；
//     · 去重与截断：同 bvid 24h 不重复；2000 行上限只留最近 1500；
//     · 归纳触发：新增 ≥8 条或距上次 >24h 才调模型（每轮最多一次）；
//     · 归纳失败：旧 knowledge.md 一个字节都不许动、审计留痕、不重试；
//     · 挂钩：只有真拿到摘要才记，失败/空摘要不记；学习层写坏了工具也得照常返回。
//   全部假 llm + 临时 self 目录，零真实网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

const NL = String.fromCharCode(10)
const BASE_METRICS = { energy: 60, mood: 55, curiosity: 50, affinity: 50, boredom: 30, confidence: 45 }

function learnEnv (tag) {
  const root = tmpDir(tag)
  const restoreSandbox = sandboxEnv(root)
  const restoreSelf = setEnv({ DSH_BILI_SELF_DIR: path.join(root, 'self') })
  fs.mkdirSync(path.join(root, 'self'), { recursive: true })
  return { root, selfDir: path.join(root, 'self'), restore () { restoreSelf(); restoreSandbox(); cleanupTmp() } }
}

async function seedState (patch = {}) {
  const { patchState } = await import(repoUrl('lib/core/state.js'))
  patchState({ counters: {}, silenceUntil: 0, metrics: { ...BASE_METRICS }, ...patch })
}

/** 假 llm：按调用序号返回文本，并记调用次数。 */
function fakeLlm (replies) {
  return {
    calls: 0,
    async *stream () {
      const index = this.calls
      this.calls += 1
      const reply = typeof replies === 'function' ? replies(index) : replies[Math.min(index, replies.length - 1)]
      yield { type: 'text-delta', text: reply }
      yield { type: 'finish', reason: { kind: 'ok' } }
    }
  }
}

const KNOWLEDGE_OK = [
  '## 我大概懂了什么',
  '- 分镜决定节奏',
  '- 三体动画的改编取舍',
  '',
  '## 我最近的兴趣',
  '动画、分镜',
  '',
  '## 我改变过的看法',
  '暂无',
].join(NL)

/* ══════════════════════════ 1. 写入形状 ══════════════════════════ */

test('appendLearning：行含 at/bvid/title/gist/tags，gist ≤200、tags ≤3，state.learning.count +1', async () => {
  const env = learnEnv('learn-append')
  try {
    const learning = await import(repoUrl('lib/core/learning.js'))
    const { readState } = await import(repoUrl('lib/core/state.js'))
    await seedState()

    const LONG = 'x'.repeat(500)
    const out = learning.appendLearning({ bvid: 'BV1CAnN6uEUN', title: '三体动画的分镜怎么设计的', summary: LONG, question: '这段为什么这么剪' })
    assert.equal(out.ok, true, '写入应当成功，实际 ' + JSON.stringify(out))
    assert.equal(out.row.gist.length, 200, 'gist 必须截到 200 字，实际 ' + out.row.gist.length)
    assert.ok(out.row.tags.length <= 3, 'tags 最多 3 个，实际 ' + JSON.stringify(out.row.tags))
    assert.equal(typeof out.row.at, 'string', 'at 必须是 ISO 时间串')
    assert.equal(out.row.bvid, 'BV1CAnN6uEUN', 'bvid 原样保留')
    assert.equal(out.row.title, '三体动画的分镜怎么设计的', 'title 原样保留')

    const rows = learning.readAll()
    assert.equal(rows.length, 1, '文件里应当恰好一行，实际 ' + rows.length)
    for (const key of ['at', 'bvid', 'title', 'gist', 'tags']) {
      assert.ok(key in rows[0], '行里必须有字段 ' + key + '，实际 ' + JSON.stringify(rows[0]))
    }
    assert.equal(readState().learning.count, 1, 'state.learning.count 必须 +1，实际 ' + JSON.stringify(readState().learning))
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 2. 去重 ══════════════════════════ */

test('去重：同 bvid 24 小时内第二次不追加（行数不变）；不同 bvid 追加', async () => {
  const env = learnEnv('learn-dedupe')
  try {
    const learning = await import(repoUrl('lib/core/learning.js'))
    await seedState()

    const first = learning.appendLearning({ bvid: 'BV1CAnN6uEUN', title: 'A', summary: '讲了分镜' })
    assert.equal(first.ok, true)
    const again = learning.appendLearning({ bvid: 'BV1CAnN6uEUN', title: 'A', summary: '又刷到一次' })
    assert.equal(again.ok, false, '同 bvid 24h 内不许重复记，实际 ' + JSON.stringify(again))
    assert.equal(again.reason, 'duplicate', 'reason 必须是 duplicate，实际 ' + again.reason)
    assert.equal(learning.readAll().length, 1, '行数不许变，实际 ' + learning.readAll().length)

    const other = learning.appendLearning({ bvid: 'BV1GJ411x7h7', title: 'B', summary: '另一条' })
    assert.equal(other.ok, true, '不同 bvid 应当能追加')
    assert.equal(learning.readAll().length, 2, '应当有两行，实际 ' + learning.readAll().length)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 3. 截断 ══════════════════════════ */

test('截断：文件超过 2000 行只保留最近 1500 行', async () => {
  const env = learnEnv('learn-trim')
  try {
    const learning = await import(repoUrl('lib/core/learning.js'))
    await seedState()

    const old = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
    const lines = []
    for (let i = 0; i < 2000; i += 1) {
      lines.push(JSON.stringify({ at: old, bvid: 'BVold' + String(i).padStart(5, '0'), title: '旧条目 ' + i, gist: '旧摘要', tags: [] }))
    }
    fs.writeFileSync(learning.learningPath(), lines.join(NL) + NL)
    assert.equal(learning.readAll().length, 2000, '前提：先有 2000 行')

    const out = learning.appendLearning({ bvid: 'BV1CAnN6uEUN', title: '新的一条', summary: '新的摘要' })
    assert.equal(out.ok, true, '第 2001 条应当写成功')
    const rows = learning.readAll()
    assert.equal(rows.length, 1500, '超过上限后只保留最近 1500 行，实际 ' + rows.length)
    assert.equal(rows[rows.length - 1].bvid, 'BV1CAnN6uEUN', '最新那条必须在末尾')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 4. 归纳触发 ══════════════════════════ */

test('distill 触发：新增 ≥8 条 → 恰调 1 次模型并写出三节 knowledge.md；紧接着再调 → not-yet', async () => {
  const env = learnEnv('learn-distill')
  try {
    const learning = await import(repoUrl('lib/core/learning.js'))
    const { readState } = await import(repoUrl('lib/core/state.js'))
    await seedState({ learning: { count: 0, lastDistillAt: new Date().toISOString(), lastDistillCount: 0, lastDistillOk: false, topics: [] } })

    for (let i = 0; i < 8; i += 1) {
      const out = learning.appendLearning({ bvid: 'BVlearn' + String(i).padStart(4, '0'), title: '第 ' + i + ' 条', summary: '摘要 ' + i })
      assert.equal(out.ok, true)
    }

    const llm = fakeLlm([KNOWLEDGE_OK])
    const first = await learning.distill({ deps: { llm } })
    assert.equal(first.ok, true, '新增 8 条应当触发归纳，实际 ' + JSON.stringify(first))
    assert.equal(llm.calls, 1, '归纳只该调一次模型，实际 ' + llm.calls)

    const body = fs.readFileSync(learning.knowledgePath(), 'utf8')
    for (const section of learning.SECTIONS) {
      assert.ok(body.includes('## ' + section), 'knowledge.md 必须有「' + section + '」这一节，实际：' + body.slice(0, 200))
    }
    assert.equal(readState().learning.lastDistillOk, true, '成功后 lastDistillOk 必须是 true')

    const second = await learning.distill({ deps: { llm } })
    assert.equal(second.ok, false, '间隔未到且新增不足时不该再归纳')
    assert.equal(second.reason, 'not-yet', 'reason 必须是 not-yet，实际 ' + second.reason)
    assert.equal(llm.calls, 1, '第二次不许再调模型，实际 ' + llm.calls)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 5. 归纳失败保护 ══════════════════════════ */

test('distill 失败：旧 knowledge.md 字节不变、审计留痕、lastDistillOk=false、不重试', async () => {
  const env = learnEnv('learn-distill-fail')
  try {
    const learning = await import(repoUrl('lib/core/learning.js'))
    const audit = await import(repoUrl('lib/core/audit.js'))
    const { readState } = await import(repoUrl('lib/core/state.js'))
    await seedState({ learning: { count: 0, lastDistillAt: new Date().toISOString(), lastDistillCount: 0, lastDistillOk: true, topics: ['旧主题'] } })

    const OLD = ['## 我大概懂了什么', '- 旧结论', '', '## 我最近的兴趣', '旧主题', '', '## 我改变过的看法', '暂无'].join(NL) + NL
    fs.writeFileSync(learning.knowledgePath(), OLD)
    for (let i = 0; i < 8; i += 1) {
      learning.appendLearning({ bvid: 'BVfail' + String(i).padStart(4, '0'), title: '失败轮 ' + i, summary: '摘要 ' + i })
    }

    const llm = fakeLlm(['这不是三节，只是一句废话'])
    const out = await learning.distill({ deps: { llm } })
    assert.equal(out.ok, false, '模型返回垃圾时归纳必须失败，实际 ' + JSON.stringify(out))
    assert.match(String(out.reason), /parse-failed/, 'reason 应当是 parse-failed，实际 ' + out.reason)
    assert.equal(fs.readFileSync(learning.knowledgePath(), 'utf8'), OLD, '失败时旧 knowledge.md 必须一个字节都不动')
    assert.equal(readState().learning.lastDistillOk, false, '失败后 lastDistillOk 必须是 false')

    const rows = audit.readAudit(50).filter((row) => row.tool === 'learning')
    assert.equal(rows.length, 1, '失败要留一条审计，实际 ' + rows.length)
    assert.equal(rows[0].ok, false, '审计里要如实记失败')

    const retry = await learning.distill({ deps: { llm } })
    assert.equal(retry.ok, false, '不重试：紧接着再调仍是失败')
    assert.equal(retry.reason, 'not-yet', '第二次必须直接 not-yet（lastDistillAt 已推进），实际 ' + retry.reason)
    assert.equal(llm.calls, 1, '不许重试烧 token，实际模型被调 ' + llm.calls + ' 次')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 6. 挂钩（bili_watch 深读） ══════════════════════════ */

/** 造一个能跑通深读的 deps（宿主的 video_understand 完全由 viewer 决定）。 */
function deepDeps (env, viewer) {
  const bvid = 'BV1CAnN6uEUN'
  const client = {
    async get (target) {
      if (target === '/x/web-interface/popular') return { code: 0, message: '0', data: { list: [{ bvid, aid: 1, title: '三体动画分镜', duration: 300, owner: { mid: 9, name: 'UP' }, stat: { view: 1 } }] } }
      return { code: 0, message: '0', data: {} }
    },
    async post () { return { code: 0, data: {} } },
    cred () { return {} },
    state () { return {} }
  }
  return {
    client,
    config: { owner: { mid: 389989266 }, risk: {}, paths: { stateDir: env.selfDir } },
    owner: { mid: 389989266 },
    quota: { gate: () => ({ ok: true }), record: () => ({ ok: true }) },
    capabilities: { list: () => [], call: () => ({ ok: false }) },
    ctx: { get (name) { return name === 'tools' ? { get: (toolName) => (toolName === 'video_understand' ? { execute: viewer } : undefined) } : undefined } },
    api: {
      playurl: async () => ({ ok: true, data: { urls: [{ url: 'https://example.invalid/a.mp4', size: 1024 }] } }),
      videoInfo: async () => ({ ok: true, data: { duration: 300 } })
    },
    downloadFile: async () => ({ ok: true, bytes: 1024 }),
    log: () => {}
  }
}

async function runDeep (env, viewer) {
  const { buildTools } = await import(repoUrl('lib/tools/index.js'))
  const watch = buildTools(deepDeps(env, viewer)).find((item) => item.name === 'bili_watch')
  return watch.execute({ source: 'popular', limit: 5, maxDuration: 600, deep: true, deepCount: 1, question: '这段怎么剪的' }, {})
}

test('挂钩：深读成功且有摘要 → learning +1；understand-failed / empty-summary → 不追加', async () => {
  // ① 成功 + 有摘要
  {
    const env = learnEnv('learn-hook-ok')
    try {
      const learning = await import(repoUrl('lib/core/learning.js'))
      const { readState } = await import(repoUrl('lib/core/state.js'))
      await seedState()
      const result = await runDeep(env, async () => ({ ok: true, data: { summary: '分镜决定了这段的节奏' } }))
      assert.equal(result.ok, true, '深读成功时工具应当 ok，实际 ' + JSON.stringify(result).slice(0, 200))
      assert.equal(learning.readAll().length, 1, '深读成功且有摘要必须记一笔，实际 ' + learning.readAll().length)
      assert.equal(readState().learning.count, 1, 'count 也要 +1')
    } finally {
      env.restore()
    }
  }

  // ② understand-failed（ok:true 但没有摘要、带 failures）
  {
    const env = learnEnv('learn-hook-fail')
    try {
      const learning = await import(repoUrl('lib/core/learning.js'))
      await seedState()
      const result = await runDeep(env, async () => ({ ok: true, data: { failures: [{ stage: 'batch', reason: 'MODEL_STREAM_FAILED' }] } }))
      assert.equal(result.ok, true, '整体仍是成功（失败落在 deep 项里）')
      assert.equal(learning.readAll().length, 0, '没拿到摘要就不许记，实际 ' + learning.readAll().length)
    } finally {
      env.restore()
    }
  }

  // ③ empty-summary（ok:true 但没有任何摘要字段）
  {
    const env = learnEnv('learn-hook-empty')
    try {
      const learning = await import(repoUrl('lib/core/learning.js'))
      await seedState()
      await runDeep(env, async () => ({ ok: true, data: {} }))
      assert.equal(learning.readAll().length, 0, '空摘要不许记，实际 ' + learning.readAll().length)
    } finally {
      env.restore()
    }
  }
})

test('挂钩：learning 写入失败时工具照常返回（学习层是旁路，坏了不许影响深读结果）', async () => {
  const env = learnEnv('learn-hook-broken')
  try {
    const learning = await import(repoUrl('lib/core/learning.js'))
    await seedState()
    // 把 learning.jsonl 做成目录：写入必然失败
    fs.mkdirSync(learning.learningPath(), { recursive: true })

    let result = null
    await assert.doesNotReject(async () => {
      result = await runDeep(env, async () => ({ ok: true, data: { summary: '这条本该被记下来' } }))
    }, '学习层写坏了绝不许把工具调用抛穿')
    assert.equal(result.ok, true, '工具仍必须返回成功，实际 ' + JSON.stringify(result).slice(0, 200))
    assert.equal(result.data.deep[0].ok, true, '深读那条仍是成功的')
    assert.equal(learning.readAll().length, 0, '前提：确实一条也没写进去')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 7. wake-context.md ══════════════════════════ */

test('wake-context.md：含「我最近在想什么」与「最近看过」；没有 knowledge.md 时写「还没有积累」', async () => {
  const env = learnEnv('learn-wake-context')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const learning = await import(repoUrl('lib/core/learning.js'))
    const memes = await import(repoUrl('lib/core/memes.js'))
    autonomy.stop()
    schedule.unlock()
    schedule.saveSchedule({ enabled: true, windows: [{ start: '00:00', end: '24:00' }], allows: { read: true }, minWatchPerWake: false, commentAfterWatch: false, bedtimeReport: false, replyToMentions: false })
    await seedState()
    fs.writeFileSync(memes.memesPath(), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'llm', stage: 'fresh', items: [], lastAttemptAt: '', lastMemeError: '' }))

    // ① 还没有 knowledge.md、也没有 learning 记录
    const llm = fakeLlm([JSON.stringify({ mood: '平静', say: '', actions: [], diary: '', memory: [] })])
    await autonomy.runOnce('manual', { tools: new Map(), llm, log: () => {}, ctx: {} })
    const file = path.join(env.selfDir, 'wake-context.md')
    const first = fs.readFileSync(file, 'utf8')
    assert.ok(first.includes('## 我最近在想什么'), '必须有「## 我最近在想什么」，实际：' + first.slice(0, 300))
    assert.ok(first.includes('## 最近看过'), '必须有「## 最近看过」')
    assert.ok(first.includes('还没有积累'), '没有 knowledge.md 时要写「还没有积累」，实际：' + first.slice(0, 400))

    // ② 有积累之后：两节都要给内容
    learning.appendLearning({ bvid: 'BV1CAnN6uEUN', title: '三体动画分镜', summary: '分镜决定节奏' })
    fs.writeFileSync(learning.knowledgePath(), ['## 我大概懂了什么', '- 分镜决定节奏'].join(NL) + NL)
    const llm2 = fakeLlm([JSON.stringify({ mood: '平静', say: '', actions: [], diary: '', memory: [] })])
    await autonomy.runOnce('manual', { tools: new Map(), llm: llm2, log: () => {}, ctx: {} })
    const second = fs.readFileSync(file, 'utf8')
    assert.ok(second.includes('分镜决定节奏'), '知识正文要进上下文文件，实际：' + second.slice(0, 500))
    assert.ok(second.includes('三体动画分镜'), '最近看过要列出标题，实际：' + second.slice(0, 500))
    assert.equal(second.includes('还没有积累'), false, '有积累后不该再写「还没有积累」')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ a/b. 两条边界 ══════════════════════════ */

test('边界：老 state（没有 learning 字段）→ append / readRecent / distill 都不抛', async () => {
  const env = learnEnv('learn-old-state')
  try {
    const learning = await import(repoUrl('lib/core/learning.js'))
    const state = await import(repoUrl('lib/core/state.js'))
    // 直接写一份「老」state.json：只有 counters / metrics，没有 learning
    fs.writeFileSync(state.statePath(), JSON.stringify({ counters: {}, silenceUntil: 0, metrics: { ...BASE_METRICS } }))

    let appended = null
    await assert.doesNotReject(async () => {
      appended = learning.appendLearning({ bvid: 'BV1CAnN6uEUN', title: '老状态', summary: '也能记' })
    }, '老 state 下 append 不许抛')
    assert.equal(appended.ok, true, '老 state 下仍应写入成功')
    assert.equal(state.readState().learning.count, 1, 'count 从 0 起算，实际 ' + JSON.stringify(state.readState().learning))

    let recent = null
    await assert.doesNotReject(async () => { recent = learning.readRecent(3) }, 'readRecent 不许抛')
    assert.equal(recent.length, 1)

    let out = null
    await assert.doesNotReject(async () => { out = await learning.distill({ deps: { llm: fakeLlm([KNOWLEDGE_OK]) } }) }, 'distill 不许抛')
    assert.equal(out.ok, true, '老 state 下 distill 仍应能跑（lastDistillAt 空 → 立即触发），实际 ' + JSON.stringify(out))
  } finally {
    env.restore()
  }
})

test('边界：distill 后有新主题才 +1 好奇（同批主题不再加），且上限 100', async () => {
  const env = learnEnv('learn-curiosity')
  try {
    const learning = await import(repoUrl('lib/core/learning.js'))
    const metrics = await import(repoUrl('lib/core/metrics.js'))
    await seedState()
    for (let i = 0; i < 8; i += 1) learning.appendLearning({ bvid: 'BVcur' + String(i).padStart(4, '0'), title: '好奇 ' + i, summary: '摘要 ' + i })

    const first = await learning.distill({ deps: { llm: fakeLlm([KNOWLEDGE_OK]) }, force: true })
    assert.equal(first.ok, true, '第一次归纳应当成功')
    assert.equal(metrics.readMetrics().curiosity, 51, '有新主题 → 好奇 +1（50 → 51），实际 ' + metrics.readMetrics().curiosity)

    const second = await learning.distill({ deps: { llm: fakeLlm([KNOWLEDGE_OK]) }, force: true })
    assert.equal(second.ok, true, '第二次（force）也应当成功')
    assert.equal(metrics.readMetrics().curiosity, 51, '同一批主题不许再加，实际 ' + metrics.readMetrics().curiosity)

    // 上限：好奇已经 100 → 再出新主题也只到 100
    await seedState({ metrics: { ...BASE_METRICS, curiosity: 100 } })
    const third = await learning.distill({ deps: { llm: fakeLlm([KNOWLEDGE_OK.replace('动画、分镜', '宇宙、物理')]) }, force: true })
    assert.equal(third.ok, true, '第三次归纳应当成功')
    assert.equal(metrics.readMetrics().curiosity, 100, '好奇上限 100，实际 ' + metrics.readMetrics().curiosity)
  } finally {
    env.restore()
  }
})
