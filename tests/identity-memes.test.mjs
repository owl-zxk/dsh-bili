// tests/identity-memes.test.mjs —— 身份字段（front-matter）与每月热梗库（§14.1 / §14.3 / §14.5）
//
// 为什么这样测：
//   ① 身份（名字 / 称呼主人）住在 persona.md 的 front-matter 里，而**正文是人设本体、是最贵的文本**。
//      所以"保存名字"这件事唯一的验收线是：头部变了、正文一个字节都没动。这里用正文的 sha256 钉死它。
//   ② 梗库是"每天最多试一次、失败保留旧列表、来源不许伪造"这三条的组合 —— 每一条单独写错都会
//      在真机上表现为"她天天玩同一个过气梗"或"梗库空了还不知道"，所以三条分别断言。
//   全部用临时 self 目录（DSH_BILI_SELF_DIR → os.tmpdir()），零真实网络（假 llm / 假 web_search）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

function memesEnv (tag) {
  const root = tmpDir(tag)
  const restoreSandbox = sandboxEnv(root)
  const restoreSelf = setEnv({ DSH_BILI_SELF_DIR: path.join(root, 'self') })
  fs.mkdirSync(path.join(root, 'self'), { recursive: true })
  return {
    root,
    selfDir: path.join(root, 'self'),
    restore () { restoreSelf(); restoreSandbox(); cleanupTmp() },
  }
}

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/
const bodyOf = (text) => String(text).replace(FRONT_MATTER, '')
const sha = (text) => createHash('sha256').update(String(text)).digest('hex')

/** 假 llm：一次调用吐一个 JSON 数组（协议与 brain 一致）。 */
function arrayLlm (items) {
  return {
    calls: 0,
    async *stream () {
      // eslint-disable-next-line no-plusplus
      this.calls += 1
      yield { type: 'text-delta', text: JSON.stringify(items) }
      yield { type: 'finish', reason: { kind: 'ok' } }
    },
  }
}

/* ══════════════════════════ a. profile front-matter ══════════════════════════ */

test('profile front-matter：缺头部回默认且不抛；只换头（正文哈希不变）；≤20 字、空值被拒', async () => {
  const env = memesEnv('id-profile')
  try {
    const persona = await import(repoUrl('lib/core/persona.js'))

    // ① 没有 persona 文件 → 默认值，且绝不抛
    assert.doesNotThrow(() => persona.readProfile(), '没有文件时 readProfile 不许抛')
    assert.deepEqual(persona.readProfile(), { name: '赛博友人', ownerTitle: '主人' }, '缺文件必须回默认身份')

    // ② 有正文但没有 front-matter → 还是默认（不能把正文第一行当名字）
    // 故意带**连续空行**与**行尾空格**：这是人手工编辑出来的真实形状。
    // 如果实现用 trim/重排的方式"顺手规整"正文，哈希就会变 —— 那正是要抓的事。
    const BODY = '# 我就是我\n\n\n不喜欢被叫"助手"。   \n（这句后面带三个空格）\n'
    persona.writePersona(BODY)
    assert.deepEqual(persona.readProfile(), { name: '赛博友人', ownerTitle: '主人' }, '缺 front-matter 时必须回默认，实际 ' + JSON.stringify(persona.readProfile()))

    // ③ 写身份：只换头部，正文一个字节不动（用 sha256 钉死）
    const beforeBody = bodyOf(fs.readFileSync(persona.personaPath(), 'utf8'))
    const beforeHash = sha(beforeBody)
    const saved = persona.writeProfile({ name: '小鲤', ownerTitle: '饲主' })
    assert.equal(saved.ok, true, '合法身份必须保存成功，实际 ' + JSON.stringify(saved))
    const afterRaw = fs.readFileSync(persona.personaPath(), 'utf8')
    assert.match(afterRaw, /^---\nname: 小鲤\n/, '头部第一行必须是新的 name，实际 ' + afterRaw.split('\n').slice(0, 3).join(' / '))
    assert.match(afterRaw, /ownerTitle: 饲主/)
    assert.equal(sha(bodyOf(afterRaw)), beforeHash, '保存身份绝不能改正文（哈希必须一致）')
    assert.deepEqual(persona.readProfile(), { name: '小鲤', ownerTitle: '饲主' }, '写完要能读回')

    // ④ 上限 20 字：20 可以、21 拒绝
    assert.equal(persona.writeProfile({ name: 'x'.repeat(20) }).ok, true, '20 字应当可以')
    const tooLong = persona.writeProfile({ name: 'x'.repeat(21) })
    assert.equal(tooLong.ok, false, '21 字必须拒绝')
    assert.match(String(tooLong.error), /20/, '文案要说清上限是 20：' + tooLong.error)

    // ⑤ 空值 / 全空白 → 拒绝（否则界面上会变成"她没名字"）
    for (const bad of ['', '   ', '\t']) {
      const rejected = persona.writeProfile({ name: bad })
      assert.equal(rejected.ok, false, JSON.stringify(bad) + ' 必须拒绝')
      assert.match(String(rejected.error), /不能是空/, '文案要说清不能为空：' + rejected.error)
    }
    // 拒绝之后文件也不能被动过
    assert.equal(persona.readProfile().name, 'x'.repeat(20), '被拒的写入不许改动已有身份')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ c1. 梗库刷新（两种来源） ══════════════════════════ */

test('梗库刷新：首次该刷；web_search 有素材 → source=web_search；只有 llm → source=llm；条目 ≤40、updatedAt 更新', async () => {
  const env = memesEnv('memes-sources')
  try {
    const memes = await import(repoUrl('lib/core/memes.js'))
    memes.resetForTest()
    assert.equal(memes.shouldRefresh(), true, '从没刷新过时必须认为"该刷"')

    const ITEMS = [
      { meme: '尊嘟假嘟', meaning: '真的假的', example: '尊嘟假嘟？' },
      { meme: 'city不city', meaning: '洋气吗', example: '' },
      { meme: '水灵灵地', meaning: '很自然地（反讽）', example: '' },
    ]

    // ① 有宿主 web_search：来源必须是 web_search（它是"真的联网了"的证据）
    const search = { name: 'web_search', calls: 0, async execute () { search.calls += 1; return { ok: true, content: '素材：尊嘟假嘟 / city不city / 水灵灵地' } } }
    const llmWithSearch = arrayLlm(ITEMS)
    const viaSearch = await memes.refreshMemes({ llm: llmWithSearch, tools: new Map([['web_search', search]]) })
    assert.equal(viaSearch.ok, true, '有素材 + 有效 JSON 时必须成功，实际 ' + JSON.stringify(viaSearch))
    assert.equal(viaSearch.source, 'web_search', '来源必须如实写 web_search，实际 ' + viaSearch.source)
    assert.equal(search.calls, 1, '有 web_search 时应当真的用一次')
    assert.equal(llmWithSearch.calls, 1, '结构化仍然要模型做一次')
    const afterSearch = memes.loadMemes()
    assert.ok(Number.isFinite(Date.parse(afterSearch.updatedAt)), 'updatedAt 必须是可解析的时间戳，实际 ' + afterSearch.updatedAt)
    assert.equal(afterSearch.stage, 'fresh', '成功之后 stage 必须是 fresh')
    assert.equal(afterSearch.items.length, ITEMS.length, '条数必须与模型给的一致，实际 ' + afterSearch.items.length)
    assert.ok(afterSearch.items.length <= memes.MEMES_MAX, '梗库上限 ' + memes.MEMES_MAX + ' 条')
    assert.equal(memes.shouldRefresh(), false, '刚刷新过就不该再认为"该刷"')

    // ② 没有 web_search：退到模型自己的知识，来源如实写 llm
    memes.resetForTest()
    const llmOnly = arrayLlm(ITEMS.slice(0, 2))
    const viaLlm = await memes.refreshMemes({ llm: llmOnly, tools: new Map() })
    assert.equal(viaLlm.ok, true, '只有 llm 时也能刷新成功，实际 ' + JSON.stringify(viaLlm))
    assert.equal(viaLlm.source, 'llm', '没有联网就必须写 llm，绝不能冒充 web_search，实际 ' + viaLlm.source)
    assert.equal(memes.loadMemes().items.length, 2)

    // ③ 超过 40 条也要截到上限
    memes.resetForTest()
    const many = Array.from({ length: 60 }, (_, i) => ({ meme: '梗' + i, meaning: '含义' + i, example: '' }))
    const capped = await memes.refreshMemes({ llm: arrayLlm(many), tools: new Map() })
    assert.equal(capped.ok, true)
    assert.equal(memes.loadMemes().items.length, memes.MEMES_MAX, '无论模型给多少，落盘都不能超过 ' + memes.MEMES_MAX + ' 条，实际 ' + memes.loadMemes().items.length)
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ c2. 梗库刷新（失败与日限） ══════════════════════════ */

test('梗库刷新失败：两条来源都没有 → ok:false / stage=stale / 旧列表保留；一天只能一次 → daily-limit', async () => {
  const env = memesEnv('memes-fail')
  try {
    const memes = await import(repoUrl('lib/core/memes.js'))
    memes.resetForTest()

    // 先铺一份"历史梗库"（模拟上个月抓到的），失败时它必须原样留着
    const OLD = [{ meme: '老梗', meaning: '旧的', example: '', seen: 3 }]
    fs.writeFileSync(memes.memesPath(), JSON.stringify({
      updatedAt: '2026-01-01T00:00:00.000Z', source: 'llm', stage: 'fresh', items: OLD, lastAttemptAt: '', lastMemeError: '',
    }))

    // ① 既没有 web_search 也没有 llm → 失败，但旧列表保留、只标 stale
    const failed = await memes.refreshMemes({ tools: new Map() })
    assert.equal(failed.ok, false, '两条来源都没有时必须失败，实际 ' + JSON.stringify(failed))
    assert.equal(failed.stage, 'stale', '失败要把 stage 标成 stale，实际 ' + failed.stage)
    assert.ok(typeof failed.error === 'string' && failed.error !== '', '失败要带原因，实际 ' + JSON.stringify(failed.error))
    const afterFail = memes.loadMemes()
    assert.equal(afterFail.items.length, 1, '失败绝不许清空旧列表，实际 ' + afterFail.items.length + ' 条')
    assert.equal(afterFail.items[0].meme, '老梗', '旧列表内容必须原样保留')
    assert.equal(afterFail.items[0].seen, 3, '连使用次数也不许被清掉')
    assert.equal(afterFail.stage, 'stale', '落盘的 stage 也必须是 stale')
    assert.ok(String(afterFail.lastMemeError).length > 0, '失败原因要落盘（设置页要能显示）')

    // ② 一天只能尝试一次：第二次直接 daily-limit，不再烧一次模型/联网
    assert.equal(memes.attemptedToday(), true, '刚试过就必须认为"今天已经试过"')
    const againLlm = arrayLlm([{ meme: '新梗', meaning: '新的', example: '' }])
    const limited = await memes.refreshMemes({ llm: againLlm, tools: new Map() })
    assert.equal(limited.ok, false, '同一天第二次必须被拦，实际 ' + JSON.stringify(limited))
    assert.equal(limited.reason, 'daily-limit', 'reason 必须是 daily-limit，实际 ' + limited.reason)
    assert.equal(againLlm.calls, 0, '被日限拦下时一次模型都不许调，实际 ' + againLlm.calls + ' 次')
    assert.equal(memes.loadMemes().items[0].meme, '老梗', '被拦也不能动旧列表')
  } finally {
    env.restore()
  }
})

/* ══════════════════════════ d. 梗冷却（7 天窗 / 最多用 2 次） ══════════════════════════
 *
 * 为什么要有这一层：seen 只说明"历史上用过几次"，不能说明"最近还新鲜吗"。
 *   没有时间窗的话，一个上个月被反复用的梗会一直排在"用得少"那一档里被反复挑出来 ——
 *   冷却是"别一直玩同一个过时梗"的唯一实现方式，所以它必须是**代码级**的，不能靠提示词。
 *   这里全部用相对当前时间构造 uses，避免用例依赖真实日期。
 */

const HOUR = 3600 * 1000
const DAY = 24 * HOUR

/** 造一份梗库文件（直接写盘，绕过刷新流程 —— 本组用例只关心"读 + 挑"）。 */
function writeMemesFile (memes, items, extra = {}) {
  fs.writeFileSync(memes.memesPath(), JSON.stringify({
    updatedAt: new Date().toISOString(),
    source: 'llm',
    stage: 'fresh',
    items,
    lastAttemptAt: '',
    lastMemeError: '',
    ...extra,
  }))
}

test('梗冷却·常量：MEME_COOLDOWN_MS 是 7 天、MEME_MAX_USES_IN_WINDOW 是 2', async () => {
  const env = memesEnv('memes-const')
  try {
    const memes = await import(repoUrl('lib/core/memes.js'))
    assert.equal(memes.MEME_COOLDOWN_MS, 7 * 24 * 3600 * 1000, '冷却窗口常量必须是 7 天（毫秒），实际 ' + String(memes.MEME_COOLDOWN_MS))
    assert.equal(memes.MEME_MAX_USES_IN_WINDOW, 2, '窗口内允许使用的次数上限必须是 2，实际 ' + String(memes.MEME_MAX_USES_IN_WINDOW))
  } finally {
    env.restore()
  }
})

test('梗冷却·pickForPrompt：窗口内用了 2 次 → 不挑；只用 1 次 → 挑；2 次但都在 8 天前 → 挑', async () => {
  const env = memesEnv('memes-cooldown-pick')
  try {
    const memes = await import(repoUrl('lib/core/memes.js'))
    const now = Date.now()
    const iso = (ms) => new Date(ms).toISOString()
    writeMemesFile(memes, [
      { meme: '用满两次', meaning: '不该再出现', example: '', seen: 2, uses: [iso(now - 1 * HOUR), iso(now - 2 * HOUR)] },
      { meme: '只用一次', meaning: '还能用', example: '', seen: 1, uses: [iso(now - 1 * HOUR)] },
      { meme: '八天前用满', meaning: '已经冷了', example: '', seen: 2, uses: [iso(now - 8 * DAY), iso(now - 9 * DAY)] },
      { meme: '从没用过', meaning: '当然能用', example: '', seen: 0, uses: [] },
    ])

    const picked = memes.pickForPrompt(12).map((item) => item.meme)
    assert.equal(picked.includes('用满两次'), false, '7 天内已经用了 2 次的梗不许再被挑出来，实际 ' + JSON.stringify(picked))
    assert.equal(picked.includes('只用一次'), true, '只用了 1 次的梗应当还在（没到上限），实际 ' + JSON.stringify(picked))
    assert.equal(picked.includes('八天前用满'), true, '两次都在 8 天前 → 已经出了冷却窗，应当重新可用，实际 ' + JSON.stringify(picked))
    assert.equal(picked.includes('从没用过'), true, '没用过的梗当然可用')
  } finally {
    env.restore()
  }
})

test('梗冷却·全部超限：pickForPrompt 返回 []，且 brain 上下文里不出现那几条梗（也不报错）', async () => {
  const env = memesEnv('memes-cooldown-all')
  try {
    const memes = await import(repoUrl('lib/core/memes.js'))
    const { decide } = await import(repoUrl('lib/core/brain.js'))
    const now = Date.now()
    const iso = (ms) => new Date(ms).toISOString()
    const ITEMS = [
      { meme: '过时梗甲', meaning: '甲', example: '', seen: 2, uses: [iso(now - HOUR), iso(now - 2 * HOUR)] },
      { meme: '过时梗乙', meaning: '乙', example: '', seen: 3, uses: [iso(now - HOUR), iso(now - 3 * HOUR)] },
      { meme: '过时梗丙', meaning: '丙', example: '', seen: 2, uses: [iso(now - 5 * HOUR), iso(now - 6 * HOUR)] },
    ]
    writeMemesFile(memes, ITEMS)

    assert.deepEqual(memes.pickForPrompt(12), [], '全部都在冷却里时 pickForPrompt 必须返回空数组，实际 ' + JSON.stringify(memes.pickForPrompt(12).map((x) => x.meme)))

    let system = ''
    const llm = {
      async *stream (options) {
        system = String(options.system ?? '')
        yield { type: 'text-delta', text: JSON.stringify({ mood: '平静', say: '', actions: [], diary: '', memory: [] }) }
        yield { type: 'finish', reason: { kind: 'ok' } }
      },
    }
    const result = await decide({ trigger: 'manual', deps: { tools: new Map() }, llm })
    assert.equal(result.ok, true, '没有可用梗不该让决策失败，实际 ' + JSON.stringify(result).slice(0, 160))
    for (const item of ITEMS) {
      assert.equal(system.includes(item.meme), false, '冷却中的梗不许出现在上下文里：' + item.meme)
    }
    assert.match(system, /还没有可用的梗库内容|今天先不玩梗/, '没有可用梗时上下文要明说"先不玩梗"')
  } finally {
    env.restore()
  }
})

test('梗冷却·bumpSeen：连调 12 次 → uses 只留最近 10 条、seen = 12', async () => {
  const env = memesEnv('memes-uses-cap')
  try {
    const memes = await import(repoUrl('lib/core/memes.js'))
    writeMemesFile(memes, [{ meme: '被反复用', meaning: '含义', example: '', seen: 0, uses: [] }])

    for (let i = 0; i < 12; i += 1) {
      const result = memes.bumpSeen('被反复用')
      assert.equal(result.ok, true, '第 ' + (i + 1) + ' 次记账必须成功，实际 ' + JSON.stringify(result))
    }
    const item = memes.loadMemes().items.find((entry) => entry.meme === '被反复用')
    assert.ok(item !== undefined, '条目还在')
    assert.equal(item.seen, 12, 'seen 必须累计到 12（它是历史总数），实际 ' + item.seen)
    assert.ok(Array.isArray(item.uses), 'uses 必须是数组（冷却靠它算时间窗），实际 ' + JSON.stringify(item.uses))
    assert.equal(item.uses.length, 10, 'uses 只留最近 10 条（防止条目无限长），实际 ' + item.uses.length)
    const times = item.uses.map((at) => Date.parse(at))
    assert.equal(times.every((t) => Number.isFinite(t)), true, 'uses 里每条都必须是可解析的时间戳，实际 ' + JSON.stringify(item.uses))
    assert.ok(Date.now() - times.at(-1) < 60_000, '最后一条应当是"刚才"（新的在后），实际 ' + item.uses.at(-1))
  } finally {
    env.restore()
  }
})

test('梗冷却·旧格式兼容：只有 seen、没有 uses 的 memes.json 仍然能读、能 pick、能记账', async () => {
  const env = memesEnv('memes-legacy')
  try {
    const memes = await import(repoUrl('lib/core/memes.js'))
    writeMemesFile(memes, [
      { meme: '老数据梗', meaning: '旧格式里没有 uses', example: '', seen: 5 },
      { meme: '另一条老梗', meaning: '同上', example: '', seen: 0 },
    ])

    assert.doesNotThrow(() => memes.loadMemes(), '读旧格式不许抛')
    const loaded = memes.loadMemes()
    assert.equal(loaded.items.length, 2, '旧格式条目必须照常读出来，实际 ' + loaded.items.length)
    assert.equal(loaded.items[0].seen, 5, 'seen 要保留')

    assert.doesNotThrow(() => memes.pickForPrompt(12), '挑梗不许抛')
    const picked = memes.pickForPrompt(12).map((item) => item.meme)
    assert.equal(picked.includes('老数据梗'), true, '旧格式条目（无 uses）应当视为"没在冷却里"，实际 ' + JSON.stringify(picked))

    const bumped = memes.bumpSeen('老数据梗')
    assert.equal(bumped.ok, true, '旧格式条目也要能记账（记账时补出 uses），实际 ' + JSON.stringify(bumped))
    const after = memes.loadMemes().items.find((item) => item.meme === '老数据梗')
    assert.equal(after.seen, 6, '旧数据 seen 5 → 6')
    assert.ok(Array.isArray(after.uses) && after.uses.length === 1, '记账之后要补出 1 条 uses，实际 ' + JSON.stringify(after.uses))
  } finally {
    env.restore()
  }
})
