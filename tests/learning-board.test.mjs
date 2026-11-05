// tests/learning-board.test.mjs —— 会话模式（board）下的学习结算（settleLearning）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

const NL = String.fromCharCode(10)
const BASE_METRICS = { energy: 60, mood: 55, curiosity: 50, affinity: 50, boredom: 30, confidence: 45 }

const KNOWLEDGE_SECTIONS = ['我大概懂了什么', '我最近的兴趣', '我改变过的看法']
const STYLE_SECTIONS = ['大家常怎么写', '什么样的评论会有人点赞', '我不该学的', '我自己的语气怎么接上去']
const NO_COPY = '不要照搬别人的句子'

const KNOWLEDGE_OK = ['## ' + KNOWLEDGE_SECTIONS[0], '- 分镜决定节奏', '', '## ' + KNOWLEDGE_SECTIONS[1], '动画、分镜', '', '## ' + KNOWLEDGE_SECTIONS[2], '暂无'].join(NL)
const STYLE_OK = ['## ' + STYLE_SECTIONS[0], '- 先复述细节再补感受', '', '## ' + STYLE_SECTIONS[1], '- 具体优先', '', '## ' + STYLE_SECTIONS[2], '- 别引战别复读', '', '## ' + STYLE_SECTIONS[3], '- 用短句讲我看到的那一点', '', NO_COPY].join(NL)

function boardEnv (tag) {
  const root = tmpDir(tag)
  const restoreSandbox = sandboxEnv(root)
  const restoreSelf = setEnv({ DSH_BILI_SELF_DIR: path.join(root, 'self') })
  fs.mkdirSync(path.join(root, 'self'), { recursive: true })
  return { root, selfDir: path.join(root, 'self'), cfgPath: path.join(root, 'cfg.json'), restore () { restoreSelf(); restoreSandbox(); cleanupTmp() } }
}

/** 假 llm：按调用序号返回文本；throwOn 指定第几次调用直接抛。 */
function fakeLlm (replies, throwOn = []) {
  return {
    calls: 0,
    async *stream () {
      const index = this.calls
      this.calls += 1
      if (throwOn.includes(index)) throw new Error('boom-llm')
      const reply = replies[Math.min(index, replies.length - 1)]
      yield { type: 'text-delta', text: reply }
      yield { type: 'finish', reason: { kind: 'ok' } }
    }
  }
}

/** 铺垫：N 条 learning + M 条 style 样本，两边 lastDistillAt 都是现在（靠新增条数触发）。 */
async function seedLearningAndStyle (env, learningCount = 8, styleCount = 40) {
  const learning = await import(repoUrl('lib/core/learning.js'))
  const style = await import(repoUrl('lib/core/style.js'))
  const state = await import(repoUrl('lib/core/state.js'))
  const now = new Date().toISOString()

  const learningRows = []
  for (let i = 0; i < learningCount; i += 1) {
    learningRows.push(JSON.stringify({ at: now, bvid: 'BVlearn' + String(i).padStart(4, '0'), title: '第 ' + i + ' 条', gist: '摘要 ' + i, tags: ['动画'] }))
  }
  fs.writeFileSync(learning.learningPath(), learningRows.join(NL) + NL)

  const styleRows = []
  for (let i = 0; i < styleCount; i += 1) {
    styleRows.push(JSON.stringify({ at: now, bvid: 'BVstyle' + String(i).padStart(4, '0'), text: '第 ' + i + ' 条评论样本，讲的是画面里的一个细节', like: i }))
  }
  fs.writeFileSync(style.samplesPath(), styleRows.join(NL) + NL)

  state.patchState({
    counters: {},
    silenceUntil: 0,
    metrics: { ...BASE_METRICS },
    learning: { count: learningCount, lastDistillAt: now, lastDistillOk: false, lastDistillCount: 0, topics: [] },
    style: { count: styleCount, lastDistillAt: now, lastDistillOk: false, lastDistillCount: 0 }
  })
  return { learning, style, state }
}

/** 配好这一轮的 tick 环境（日程 + 梗库 + 配置），返回 autonomy。 */
async function primeTick (env, options = {}) {
  const autonomy = await import(repoUrl('lib/core/autonomy.js'))
  const schedule = await import(repoUrl('lib/core/schedule.js'))
  const memes = await import(repoUrl('lib/core/memes.js'))
  const config = await import(repoUrl('lib/core/config.js'))
  autonomy.stop()
  schedule.unlock()
  schedule.saveSchedule({ enabled: true, windows: [{ start: '00:00', end: '24:00' }], allows: { read: true }, minWatchPerWake: false, commentAfterWatch: false, bedtimeReport: false, replyToMentions: false })
  fs.writeFileSync(memes.memesPath(), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'llm', stage: 'fresh', items: [], lastAttemptAt: '', lastMemeError: '' }))
  config.setConfigPathForTest(env.cfgPath)
  const cfg = {}
  if (options.sessionMode !== undefined) cfg.sessionMode = options.sessionMode
  if (options.cardId !== undefined) cfg.sessionCardId = options.cardId
  fs.writeFileSync(env.cfgPath, JSON.stringify(cfg))
  return autonomy
}

const readFileSafe = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }

/* ══════════════════════════ 1. board 模式也会归纳 ══════════════════════════ */

test('board 模式会归纳：task_board_run 恰 1 次、模型 2 次（distill + distillStyle）、两个产物文件都生成', async () => {
  const env = boardEnv('lb-board')
  try {
    const autonomy = await primeTick(env, { sessionMode: 'board', cardId: 'card-1' })
    const seeded = await seedLearningAndStyle(env)
    let boardCalls = 0
    const boardRun = { name: 'task_board_run', async execute () { boardCalls += 1; return { ok: true, data: { sessionId: 's-1' } } } }
    const llm = fakeLlm([KNOWLEDGE_OK, STYLE_OK])
    const deps = { tools: new Map([['task_board_run', boardRun]]), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('manual', deps)
    assert.equal(result.ok, true, '这一轮应当成功，实际 ' + JSON.stringify(result).slice(0, 200))
    assert.equal(result.mode, 'board', 'mode 必须是 board，实际 ' + JSON.stringify(result.mode))
    assert.equal(boardCalls, 1, 'task_board_run 必须恰被触发 1 次，实际 ' + boardCalls)
    assert.equal(llm.calls, 2, 'board 模式下模型应当被调 2 次（distill + distillStyle），实际 ' + llm.calls)

    const knowledge = readFileSafe(seeded.learning.knowledgePath())
    assert.notEqual(knowledge, '', 'knowledge.md 必须被生成（这就是那个 bug 的正面）')
    for (const section of KNOWLEDGE_SECTIONS) assert.ok(knowledge.includes('## ' + section), 'knowledge.md 缺这一节：' + section)
    const styleBody = readFileSafe(seeded.style.stylePath())
    assert.notEqual(styleBody, '', 'comment-style.md 必须被生成')
    for (const section of STYLE_SECTIONS) assert.ok(styleBody.includes('## ' + section), 'comment-style.md 缺这一节：' + section)
    assert.ok(styleBody.includes(NO_COPY), '风格产物里必须有「' + NO_COPY + '」')

    const st = seeded.state.readState()
    assert.ok(String(st.learning.lastDistillAt).length > 0, 'state.learning.lastDistillAt 不许再是空串')
    assert.ok(String(st.style.lastDistillAt).length > 0, 'state.style.lastDistillAt 不许再是空串')

    for (const key of ['ok', 'mode', 'executed', 'skipped']) assert.ok(key in result, '返回对象必须有字段 ' + key)
    assert.deepEqual(result.executed, [], 'board 模式下内核不执行动作')
    assert.deepEqual(result.skipped, [], 'board 模式下内核也不记跳过')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 2. 卡片失败也要归纳 ══════════════════════════ */

test('卡片失败也归纳：cardId 为空（no-card）与 task_board_run 抛错（threw）→ knowledge.md 仍生成、tick 仍 ok', async () => {
  const envNoCard = boardEnv('lb-board-nocard')
  try {
    const autonomy = await primeTick(envNoCard, { sessionMode: 'board', cardId: '' })
    const seeded = await seedLearningAndStyle(envNoCard)
    const llm = fakeLlm([KNOWLEDGE_OK, STYLE_OK])
    const deps = { tools: new Map(), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('manual', deps)
    assert.equal(result.ok, true, '没有卡片 ID 时这一轮仍要 ok')
    assert.equal(result.mode, 'board', '仍然走 board 分支')
    assert.notEqual(readFileSafe(seeded.learning.knowledgePath()), '', 'no-card 也必须归纳出 knowledge.md')
  } finally {
    envNoCard.restore()
  }

  const envThrew = boardEnv('lb-board-threw')
  try {
    const autonomy = await primeTick(envThrew, { sessionMode: 'board', cardId: 'card-1' })
    const seeded = await seedLearningAndStyle(envThrew)
    const boardRun = { name: 'task_board_run', async execute () { throw new Error('board exploded') } }
    const llm = fakeLlm([KNOWLEDGE_OK, STYLE_OK])
    const deps = { tools: new Map([['task_board_run', boardRun]]), llm, log: () => {}, ctx: {} }

    let result = null
    await assert.doesNotReject(async () => { result = await autonomy.runOnce('manual', deps) }, '卡片抛错不许把 tick 抛穿')
    assert.equal(result.ok, true, '卡片抛错后这一轮仍要 ok')
    assert.equal(result.mode, 'board', '仍然走 board 分支（不许退化成老路径）')
    assert.notEqual(readFileSafe(seeded.learning.knowledgePath()), '', 'threw 也必须归纳出 knowledge.md')
  } finally {
    envThrew.restore()
  }
})

/* ══════════════════════════ 3. off 模式回归 ══════════════════════════ */

test('off 模式回归：模型 3 次（1 decide + 2 归纳），两个产物都生成，返回形状不变', async () => {
  const env = boardEnv('lb-off')
  try {
    const autonomy = await primeTick(env, { sessionMode: 'off', cardId: '' })
    const seeded = await seedLearningAndStyle(env)
    const decision = JSON.stringify({ mood: '平静', say: '', comment: '看完了，挺好', actions: [], diary: '', memory: [] })
    const llm = fakeLlm([decision, KNOWLEDGE_OK, STYLE_OK])
    const deps = { tools: new Map(), llm, log: () => {}, ctx: {} }

    const result = await autonomy.runOnce('manual', deps)
    assert.equal(result.ok, true, 'off 模式这一轮应当成功')
    assert.equal(llm.calls, 3, 'off 模式模型应当被调 3 次（decide + distill + distillStyle），实际 ' + llm.calls)
    assert.notEqual(readFileSafe(seeded.learning.knowledgePath()), '', 'off 模式也要生成 knowledge.md')
    assert.notEqual(readFileSafe(seeded.style.stylePath()), '', 'off 模式也要生成 comment-style.md')
    for (const key of ['ok', 'mood', 'say', 'executed', 'skipped']) assert.ok(key in result, 'off 模式返回对象必须有字段 ' + key)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ 4. 归纳抛错不阻塞 ══════════════════════════ */

test('归纳抛错不阻塞：llm 直接 throw → tick 仍 ok:true、mode 仍是 board、不抛', async () => {
  const env = boardEnv('lb-board-llm-throws')
  try {
    const autonomy = await primeTick(env, { sessionMode: 'board', cardId: 'card-1' })
    await seedLearningAndStyle(env)
    const boardRun = { name: 'task_board_run', async execute () { return { ok: true, data: {} } } }
    const llm = fakeLlm([KNOWLEDGE_OK, STYLE_OK], [0, 1])
    const deps = { tools: new Map([['task_board_run', boardRun]]), llm, log: () => {}, ctx: {} }

    let result = null
    await assert.doesNotReject(async () => { result = await autonomy.runOnce('manual', deps) }, '归纳炸了绝不许把 tick 抛穿')
    assert.equal(result.ok, true, '归纳失败不影响这一轮的结果')
    assert.equal(result.mode, 'board', 'mode 仍是 board')
    assert.equal(llm.calls, 2, '两次归纳各试一次（不重试），实际 ' + llm.calls)
  } finally {
    env.restore()
  }
})
