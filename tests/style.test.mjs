// tests/style.test.mjs —— 评论风格层（lib/core/style.js + bili_comments 挂钩 + wake-context）
//
// 为什么这样测：
//   这一层决定"她学谁的腔调"。三条纪律必须分开钉，混在一起就守不住：
//     ① 采集要**挑**：她自己写的、纯表情、太短、满街复读的都不该进来（否则她会学会自己的口癖或复读机）；
//     ② 归纳要**只学风格不抄句子**：产物里必须有那句「不要照搬别人的句子」，缺了就算失败；
//     ③ 失败要**保旧**：归纳失败时旧 comment-style.md 一个字节都不许动，也不重试。
//   另外钉两条最容易悄悄坏掉的：采样的随机性（别永远学同几条）、以及挂钩坏了不许影响工具返回。
//   全部假 llm + 临时 self 目录，零真实网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

const NL = String.fromCharCode(10)
const SELF_MID = '389989266'
const BASE_METRICS = { energy: 60, mood: 55, curiosity: 50, affinity: 50, boredom: 30, confidence: 45 }

function styleEnv (tag) {
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

/** 造一条样本（默认合格）。 */
function sample (text, like, mid = '1000') {
  return { mid, like, text }
}

const SECTIONS = ['大家常怎么写', '什么样的评论会有人点赞', '我不该学的', '我自己的语气怎么接上去']
const NO_COPY = '不要照搬别人的句子'
const STYLE_OK = [
  '## ' + SECTIONS[0],
  '- 先复述一个具体细节，再补一句自己的感受',
  '- 用一个反差句收尾',
  '',
  '## ' + SECTIONS[1],
  '- 具体 > 抽象；有细节的评论更容易被点赞',
  '',
  '## ' + SECTIONS[2],
  '- 引战、复读、刷梗、无意义感叹都别学',
  '',
  '## ' + SECTIONS[3],
  '- 用我自己的语气接：短句、少形容词、讲我看到的那一点',
  '',
  NO_COPY,
].join(NL)

/** 攒够 n 条样本（每条一次不同的 bvid，避开 24h 去重）。 */
function fillSamples (style, n) {
  const rounds = Math.ceil(n / 5)
  let made = 0
  for (let r = 0; r < rounds && made < n; r += 1) {
    const comments = []
    for (let i = 0; i < 5 && made < n; i += 1) {
      made += 1
      comments.push(sample('这是第 ' + made + ' 条合格样本，讲的是画面里的一个细节', 100 + made))
    }
    const out = style.recordSamples({ bvid: 'BVfill' + String(r).padStart(3, '0'), comments })
    assert.equal(out.ok, true, '填样本应当成功，实际 ' + JSON.stringify(out))
  }
  return made
}

/* ══════════════════════════ 1. 采集过滤 ══════════════════════════ */

test('采集过滤：她自己 / 纯表情 / 太短 / 复读三次 → 都不采，只留合格且不含她自己', async () => {
  const env = styleEnv('style-filter')
  try {
    const style = await import(repoUrl('lib/core/style.js'))
    await seedState()

    const HER_TEXT = '这条我自己写的评论不该被当成样本学回来'
    const EMOJI = '😂😂😂😂😂😂😂😂'
    const SHORT = '好看'
    const REPEAT = '这句话到处都是，复读三遍就该丢掉了吧'
    const GOOD_A = '第三个转场那个镜头切得挺妙的，光也跟着压了一下'
    const GOOD_B = '旁白一开口我就想关了，太满了'

    const out = style.recordSamples({
      bvid: 'BV1CAnN6uEUN',
      selfMid: SELF_MID,
      comments: [
        sample(HER_TEXT, 999, SELF_MID),   // 她自己
        sample(EMOJI, 900),                // 纯表情
        sample(SHORT, 800),                // 太短
        sample(REPEAT, 700),
        sample(REPEAT, 690),
        sample(REPEAT, 680),
        sample(GOOD_A, 600),
        sample(GOOD_B, 500)
      ]
    })
    assert.equal(out.ok, true, '有合格样本时应当写入成功，实际 ' + JSON.stringify(out))
    const texts = style.readAll().map((row) => row.text)
    assert.equal(texts.includes(HER_TEXT), false, '她自己写的绝不许被采回来')
    assert.equal(texts.includes(EMOJI), false, '纯表情不该采')
    assert.equal(texts.includes(SHORT), false, '太短的（<8 字）不该采')
    // 同一轮里同一句出现多次 → 只留一条（去重）。「满街复读」的判定看的是历史里已经存了几次：
    // 实现是 repeats > 2 才丢，所以这一轮最多留一条；下一段再验证「已存过 3 次就不再采」。
    assert.ok(texts.filter((text) => text === REPEAT).length <= 1, '同一轮里同一句最多留一条，实际 ' + JSON.stringify(texts))

    // 历史里已经存过 3 次同一句 → 新的一次不再采
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
    const SPAM = '这句话真的到处都是，已经存过三次了还要再存吗'
    const seeded = [0, 1, 2].map((i) => JSON.stringify({ at: old, bvid: 'BVspam' + i, text: SPAM, like: i }))
    const current = fs.readFileSync(style.samplesPath(), 'utf8')
    fs.writeFileSync(style.samplesPath(), current + seeded.join(NL) + NL)
    const after = style.recordSamples({ bvid: 'BV1GJ411x7h9', comments: [sample(SPAM, 50), sample('这一条是新的合格样本，讲一个具体镜头', 40)], selfMid: SELF_MID })
    assert.equal(after.ok, true, '有新的合格样本时仍应写入成功')
    const afterTexts = style.readAll().map((row) => row.text)
    assert.equal(afterTexts.filter((text) => text === SPAM).length, 3, '复读已存 3 次的句子不许再采（仍是 3 条），实际 ' + afterTexts.filter((text) => text === SPAM).length)
    assert.equal(afterTexts.includes('这一条是新的合格样本，讲一个具体镜头'), true, '新的合格样本要照常采')
    assert.equal(texts.includes(GOOD_A), true, '合格样本必须采到')
    assert.equal(texts.includes(GOOD_B), true, '合格样本必须采到')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 2. 数量上限与点赞排序 ══════════════════════════ */

test('数量上限：8 条合格 → 只留 5 条，且按点赞降序取前 5', async () => {
  const env = styleEnv('style-pick')
  try {
    const style = await import(repoUrl('lib/core/style.js'))
    await seedState()

    const comments = []
    for (let i = 0; i < 8; i += 1) comments.push(sample('合格样本第 ' + i + ' 条：讲画面里的一个细节', (i + 1) * 100))
    const out = style.recordSamples({ bvid: 'BV1CAnN6uEUN', comments, selfMid: SELF_MID })
    assert.equal(out.ok, true)
    assert.equal(out.added, 5, '一次最多采 5 条，实际 ' + out.added)
    const rows = style.readAll()
    assert.equal(rows.length, 5, '文件里应当只有 5 条，实际 ' + rows.length)
    const likes = rows.map((row) => row.like)
    assert.deepEqual(likes, [800, 700, 600, 500, 400], '必须按点赞降序取前 5，实际 ' + JSON.stringify(likes))
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 3. 去重 ══════════════════════════ */

test('去重：同 bvid 24h 内第二次 → duplicate 且行数不变；换 bvid → 追加', async () => {
  const env = styleEnv('style-dedupe')
  try {
    const style = await import(repoUrl('lib/core/style.js'))
    await seedState()

    const first = style.recordSamples({ bvid: 'BV1CAnN6uEUN', comments: [sample('第一次采集的一条合格样本，讲镜头', 10)] })
    assert.equal(first.ok, true)
    const again = style.recordSamples({ bvid: 'BV1CAnN6uEUN', comments: [sample('同一条视频又刷一次，不该重复采', 20)] })
    assert.equal(again.ok, false, '同 bvid 24h 内不许重复采，实际 ' + JSON.stringify(again))
    assert.equal(again.reason, 'duplicate', 'reason 必须是 duplicate，实际 ' + again.reason)
    assert.equal(style.readAll().length, 1, '行数不许变，实际 ' + style.readAll().length)

    const other = style.recordSamples({ bvid: 'BV1GJ411x7h7', comments: [sample('换一条视频，这条合格可以采', 30)] })
    assert.equal(other.ok, true, '不同 bvid 应当能追加')
    assert.equal(style.readAll().length, 2, '应当有两行，实际 ' + style.readAll().length)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 4. 截断 ══════════════════════════ */

test('截断：样本文件超过 600 行 → 只保留最近 400 行', async () => {
  const env = styleEnv('style-trim')
  try {
    const style = await import(repoUrl('lib/core/style.js'))
    await seedState()

    const old = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
    const lines = []
    for (let i = 0; i < 600; i += 1) {
      lines.push(JSON.stringify({ at: old, bvid: 'BVold' + String(i).padStart(5, '0'), text: '旧样本第 ' + i + ' 条，讲的是镜头', like: i }))
    }
    fs.writeFileSync(style.samplesPath(), lines.join(NL) + NL)
    assert.equal(style.readAll().length, 600, '前提：先有 600 行')

    const out = style.recordSamples({ bvid: 'BV1CAnN6uEUN', comments: [sample('新采的一条合格样本，讲转场', 5)] })
    assert.equal(out.ok, true)
    const rows = style.readAll()
    assert.equal(rows.length, 400, '超过上限后只保留最近 400 行，实际 ' + rows.length)
    assert.match(String(rows[rows.length - 1].text), /新采的一条/, '最新那条必须在末尾')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 5. distillStyle 触发 ══════════════════════════ */

test('distillStyle 触发：新增 ≥40 → 模型恰 1 次、四节齐全、含「不要照搬别人的句子」；再调 → not-yet', async () => {
  const env = styleEnv('style-distill')
  try {
    const style = await import(repoUrl('lib/core/style.js'))
    const { readState } = await import(repoUrl('lib/core/state.js'))
    await seedState({ style: { count: 0, lastDistillAt: new Date().toISOString(), lastDistillOk: false, lastDistillCount: 0 } })

    fillSamples(style, 40)
    assert.equal(style.readAll().length, 40, '前提：攒够 40 条样本')

    const llm = fakeLlm([STYLE_OK])
    const first = await style.distillStyle({ deps: { llm } })
    assert.equal(first.ok, true, '新增 40 条应当触发归纳，实际 ' + JSON.stringify(first))
    assert.equal(llm.calls, 1, '归纳只该调一次模型，实际 ' + llm.calls)

    const body = fs.readFileSync(style.stylePath(), 'utf8')
    for (const section of SECTIONS) {
      assert.ok(body.includes('## ' + section), 'comment-style.md 必须有「' + section + '」这一节，实际：' + body.slice(0, 300))
    }
    assert.ok(body.includes(NO_COPY), '产物里必须有「' + NO_COPY + '」')
    assert.equal(readState().style.lastDistillOk, true, '成功后 lastDistillOk 必须是 true')

    const second = await style.distillStyle({ deps: { llm } })
    assert.equal(second.ok, false, '间隔未到且新增不足时不该再归纳')
    assert.equal(second.reason, 'not-yet', 'reason 必须是 not-yet，实际 ' + second.reason)
    assert.equal(llm.calls, 1, '第二次不许再调模型，实际 ' + llm.calls)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 6. distillStyle 失败保护 ══════════════════════════ */

test('distillStyle 失败：缺「不要照搬」/ 回废话 → 旧 comment-style.md 逐字节未变、审计留痕、不重试', async () => {
  // ① 四节齐全但缺那句硬约束
  {
    const env = styleEnv('style-fail-nocopy')
    try {
      const style = await import(repoUrl('lib/core/style.js'))
      const audit = await import(repoUrl('lib/core/audit.js'))
      const { readState } = await import(repoUrl('lib/core/state.js'))
      await seedState({ style: { count: 0, lastDistillAt: new Date().toISOString(), lastDistillOk: true, lastDistillCount: 0 } })

      const OLD = ['## ' + SECTIONS[0], '- 旧的结论', '', '## ' + SECTIONS[1], '- 旧的', '', '## ' + SECTIONS[2], '- 旧的', '', '## ' + SECTIONS[3], '- 旧的', NO_COPY].join(NL) + NL
      fs.writeFileSync(style.stylePath(), OLD)
      fillSamples(style, 40)

      const withoutRule = STYLE_OK.split(NO_COPY).join('')
      const llm = fakeLlm([withoutRule])
      const out = await style.distillStyle({ deps: { llm } })
      assert.equal(out.ok, false, '缺硬约束那句时必须判失败，实际 ' + JSON.stringify(out))
      assert.match(String(out.reason), /parse-failed/, 'reason 应当是 parse-failed，实际 ' + out.reason)
      assert.equal(fs.readFileSync(style.stylePath(), 'utf8'), OLD, '失败时旧 comment-style.md 必须一个字节都不动')
      assert.equal(readState().style.lastDistillOk, false, '失败后 lastDistillOk 必须是 false')
      const rows = audit.readAudit(50).filter((row) => row.tool === 'style')
      assert.equal(rows.length, 1, '失败要留一条审计，实际 ' + rows.length)
      assert.equal(rows[0].ok, false, '审计要如实记失败')

      const retry = await style.distillStyle({ deps: { llm } })
      assert.equal(retry.ok, false, '不重试')
      assert.equal(retry.reason, 'not-yet', '第二次必须直接 not-yet，实际 ' + retry.reason)
      assert.equal(llm.calls, 1, '不许重试烧 token，实际 ' + llm.calls)
    } finally {
      env.restore()
    }
  }

  // ② 模型直接回一句废话
  {
    const env = styleEnv('style-fail-garbage')
    try {
      const style = await import(repoUrl('lib/core/style.js'))
      await seedState({ style: { count: 0, lastDistillAt: new Date().toISOString(), lastDistillOk: true, lastDistillCount: 0 } })
      const OLD = '旧文件内容，不该被改动' + NL
      fs.writeFileSync(style.stylePath(), OLD)
      fillSamples(style, 40)

      const out = await style.distillStyle({ deps: { llm: fakeLlm(['我不想写四节，就这样']) } })
      assert.equal(out.ok, false, '回废话必须判失败')
      assert.equal(fs.readFileSync(style.stylePath(), 'utf8'), OLD, '旧文件逐字节不变')
    } finally {
      env.restore()
    }
  }
})

/* ══════════════════════════ 7. 挂钩（bili_comments） ══════════════════════════ */

function commentDeps (env, items) {
  const client = {
    async get (target) {
      if (target === '/x/web-interface/view') return { code: 0, message: '0', data: { bvid: 'BV1CAnN6uEUN', aid: 123, title: '三体动画分镜', pages: [{ cid: 1, page: 1, part: 'P1', duration: 300 }] } }
      if (target === '/x/v2/reply') return { code: 0, message: '0', data: { page: { count: items.length }, replies: items } }
      return { code: 0, message: '0', data: {} }
    },
    async post () { return { code: 0, data: {} } },
    cred () { return {} },
    state () { return {} }
  }
  return {
    client,
    config: { owner: { mid: Number(SELF_MID) }, risk: {}, paths: { stateDir: env.selfDir } },
    owner: { mid: Number(SELF_MID) },
    selfMid: SELF_MID,
    quota: { gate: () => ({ ok: true }), record: () => ({ ok: true }) },
    capabilities: { list: () => [], call: () => ({ ok: false }) },
    log: () => {}
  }
}

function replyRows (n) {
  const rows = []
  for (let i = 0; i < n; i += 1) {
    rows.push({ rpid: 900 + i, rpid_str: String(900 + i), mid: 2000 + i, like: 100 + i, content: { message: '第 ' + i + ' 条评论：这个镜头切得很妙，光也压住了' } })
  }
  return rows
}

async function runComments (env, items) {
  const { buildTools } = await import(repoUrl('lib/tools/index.js'))
  const tool = buildTools(commentDeps(env, items)).find((entry) => entry.name === 'bili_comments')
  return tool.execute({ bvid: 'BV1CAnN6uEUN' }, {})
}

test('挂钩：bili_comments 拿到 ≥3 条 → 采样本；<3 条 → 不采；采集写不进去 → 工具仍 ok:true', async () => {
  // ① ≥3 条：采集
  {
    const env = styleEnv('style-hook-ok')
    try {
      const style = await import(repoUrl('lib/core/style.js'))
      await seedState()
      const result = await runComments(env, replyRows(4))
      assert.equal(result.ok, true, '评论读取应当成功，实际 ' + JSON.stringify(result).slice(0, 200))
      assert.ok(style.readAll().length > 0, '拿到 ≥3 条就该采样本，实际 ' + style.readAll().length)
    } finally {
      env.restore()
    }
  }

  // ② <3 条：不采
  {
    const env = styleEnv('style-hook-few')
    try {
      const style = await import(repoUrl('lib/core/style.js'))
      await seedState()
      const result = await runComments(env, replyRows(2))
      assert.equal(result.ok, true, '两条评论也算读取成功')
      assert.equal(style.readAll().length, 0, '不足 3 条不该采，实际 ' + style.readAll().length)
    } finally {
      env.restore()
    }
  }

  // ③ 采集目录不可写：工具照常返回
  {
    const env = styleEnv('style-hook-broken')
    try {
      const style = await import(repoUrl('lib/core/style.js'))
      await seedState()
      fs.mkdirSync(style.samplesPath(), { recursive: true })   // 把 jsonl 做成目录 → 写入必失败
      let result = null
      await assert.doesNotReject(async () => { result = await runComments(env, replyRows(4)) }, '采集坏了绝不许把工具调用抛穿')
      assert.equal(result.ok, true, '工具仍必须返回成功，实际 ' + JSON.stringify(result).slice(0, 200))
      assert.equal(style.readAll().length, 0, '前提：确实一条也没采到')
    } finally {
      env.restore()
    }
  }
})

/* ══════════════════════════ 8. wake-context.md ══════════════════════════ */

test('wake-context.md：含「## 别人怎么评论的」；无样本写「还没攒到样本」；有样本时含四节与 3 条随机样本', async () => {
  const env = styleEnv('style-wake')
  try {
    const autonomy = await import(repoUrl('lib/core/autonomy.js'))
    const schedule = await import(repoUrl('lib/core/schedule.js'))
    const style = await import(repoUrl('lib/core/style.js'))
    const memes = await import(repoUrl('lib/core/memes.js'))
    autonomy.stop()
    schedule.unlock()
    schedule.saveSchedule({ enabled: true, windows: [{ start: '00:00', end: '24:00' }], allows: { read: true }, minWatchPerWake: false, commentAfterWatch: false, bedtimeReport: false, replyToMentions: false })
    await seedState()
    fs.writeFileSync(memes.memesPath(), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'llm', stage: 'fresh', items: [], lastAttemptAt: '', lastMemeError: '' }))

    const runTick = async () => {
      const llm = fakeLlm([JSON.stringify({ mood: '平静', say: '', actions: [], diary: '', memory: [] })])
      await autonomy.runOnce('manual', { tools: new Map(), llm, log: () => {}, ctx: {} })
      return fs.readFileSync(path.join(env.selfDir, 'wake-context.md'), 'utf8')
    }

    const first = await runTick()
    assert.ok(first.includes('## 别人怎么评论的'), '必须有「## 别人怎么评论的」，实际：' + first.slice(0, 400))
    assert.ok(first.includes('还没攒到样本'), '没有样本时要写「还没攒到样本」，实际：' + first.slice(0, 500))

    // 有样本 + 有归纳产物之后
    style.recordSamples({ bvid: 'BV1CAnN6uEUN', comments: [sample('这个镜头切得挺妙的，光也压住了', 10), sample('旁白一开口我就想关了，太满了', 9), sample('第三个转场我反复看了三遍', 8)] })
    fs.writeFileSync(style.stylePath(), ['## ' + SECTIONS[0], '- 先复述细节再补感受', NO_COPY].join(NL) + NL)

    const second = await runTick()
    assert.ok(second.includes('先复述细节再补感受'), '归纳产物要进上下文，实际：' + second.slice(0, 800))
    assert.ok(second.includes('- 例如：'), '有样本时应当列出例子，实际：' + second.slice(0, 900))
    const exampleLines = second.split(NL).filter((line) => line.startsWith('  · 「'))
    assert.equal(exampleLines.length, 3, '应当随机列 3 条样本，实际 ' + exampleLines.length)
    assert.equal(second.includes('还没攒到样本'), false, '有样本后不该再写「还没攒到样本」')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ a/b. 两条边界 ══════════════════════════ */

test('边界：readSamples 有随机性 —— 20 次调用至少出现 2 种组合', async () => {
  const env = styleEnv('style-random')
  try {
    const style = await import(repoUrl('lib/core/style.js'))
    await seedState()
    const comments = []
    for (let i = 0; i < 5; i += 1) comments.push(sample('随机样本第 ' + i + ' 条：讲画面里的一个细节', 100 + i))
    style.recordSamples({ bvid: 'BV1CAnN6uEUN', comments })

    const combos = new Set()
    for (let i = 0; i < 20; i += 1) {
      combos.add(JSON.stringify(style.readSamples(3).map((row) => row.text)))
    }
    assert.ok(combos.size >= 2, '随机取 3 条应当不是永远同一组，实际只有 ' + combos.size + ' 种')
    assert.equal(style.readSamples(3).length, 3, '一次取 3 条')
  } finally {
    env.restore()
  }
})

test('边界：老 state（没有 style 字段）→ 采集 / 读取 / 归纳都不抛', async () => {
  const env = styleEnv('style-old-state')
  try {
    const style = await import(repoUrl('lib/core/style.js'))
    const state = await import(repoUrl('lib/core/state.js'))
    fs.writeFileSync(state.statePath(), JSON.stringify({ counters: {}, silenceUntil: 0, metrics: { ...BASE_METRICS } }))

    let recorded = null
    await assert.doesNotReject(async () => {
      recorded = style.recordSamples({ bvid: 'BV1CAnN6uEUN', comments: [sample('老 state 下也能采的一条合格样本', 10)] })
    }, '老 state 下采集不许抛')
    assert.equal(recorded.ok, true, '老 state 下仍应采集成功')
    assert.equal(state.readState().style.count, 1, 'count 从 0 起算，实际 ' + JSON.stringify(state.readState().style))

    let samples = null
    await assert.doesNotReject(async () => { samples = style.readSamples(3) }, 'readSamples 不许抛')
    assert.equal(samples.length, 1)

    let out = null
    await assert.doesNotReject(async () => { out = await style.distillStyle({ deps: { llm: fakeLlm([STYLE_OK]) } }) }, 'distillStyle 不许抛')
    assert.equal(out.ok, true, '老 state 下 distillStyle 仍应能跑（lastDistillAt 空 → 立即触发），实际 ' + JSON.stringify(out))
  } finally {
    env.restore()
  }
})
