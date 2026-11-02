// tests/persona-sections.test.mjs —— 结构化人设读写（§15）：parseSections / writeSections
//
// 为什么这样测：
//   人设是她最贵的那份文本，而"按节保存"的全部价值在于**没被改的节一个字节都不动**。
//   只比整份文件的哈希是不够的：把"性格"和"兴趣"两节内容互换，整份哈希也会变，
//   但那是内容错了而不是字节变了 —— 所以这里按 `## 标题` 切开，逐节比较原文。
//   另外三条容易做错的细节：列表项不带 `- ` 前缀（读出来要干净）、渲染的节末尾要有空行
//   （否则两节贴在一起）、以及超限时必须**拒绝而不是截断**（截断＝用户以为存上了）。
//   全部在 os.tmpdir() 的临时 self 目录里做，零真实网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { cleanupTmp, repoUrl, sandboxEnv, setEnv, tmpDir } from './helpers/harness.mjs'

function personaEnv (tag) {
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

/** 切 front-matter（保留 body 用于按节比较）。 */
const bodyOf = (text) => String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')

/** 按 `## 标题` 切段：返回 { preamble, sections: { 标题: 该段原文 } }，用于"逐节逐字节"比较。 */
function splitOf (text) {
  const body = bodyOf(text)
  const matches = [...body.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)]
  const out = { preamble: matches.length === 0 ? body : body.slice(0, matches[0].index), sections: {} }
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length
    out.sections[matches[i][1].trim()] = body.slice(start, end)
  }
  return out
}

/** 一份"像人写的"结构化人设（与 defaultPersona 的旧模板不同：这里是 §15 的六节格式）。 */
const STRUCTURED = [
  '---',
  'name: 小鲤',
  'ownerTitle: 饲主',
  '---',
  '第一段前言行（不属于任何节）。',
  '',
  '## 一句话',
  '',
  '爱看鬼畜的大学生',
  '',
  '## 性格',
  '',
  '- 短句，口语',
  '- 会好奇，也会犯懒',
  '',
  '## 兴趣',
  '',
  '- 猫咪',
  '- 建模 / Live2D',
  '',
  '## 雷点',
  '',
  '- 带货',
  '',
  '## 语料',
  '',
  '- 好耶',
  '',
  '## 边界',
  '',
  '- 私信只发主人',
  '',
  '## 备注',
  '',
  '这里是备注正文。',
  '',
].join('\n')

test('parseSections：六个字段 + notes + name/ownerTitle 都对，列表项不带「- 」前缀', async () => {
  const env = personaEnv('sections-parse')
  try {
    const persona = await import(repoUrl('lib/core/persona.js'))
    // 在"真 persona 的副本"上验：把一份完整的人设写进临时目录再解析
    persona.writePersona(STRUCTURED)

    const parsed = persona.parseSections()
    assert.equal(parsed.name, '小鲤', 'front-matter 的 name 要一起读出来')
    assert.equal(parsed.ownerTitle, '饲主', 'front-matter 的 ownerTitle 要一起读出来')
    assert.equal(parsed.tagline, '爱看鬼畜的大学生', '一句话（tagline）要读成一行文本，实际 ' + JSON.stringify(parsed.tagline))
    assert.deepEqual(parsed.personality, ['短句，口语', '会好奇，也会犯懒'], '性格要读成数组，实际 ' + JSON.stringify(parsed.personality))
    assert.deepEqual(parsed.interests, ['猫咪', '建模 / Live2D'], '兴趣要读成数组，实际 ' + JSON.stringify(parsed.interests))
    assert.deepEqual(parsed.dislikes, ['带货'], '雷点要读成数组')
    assert.deepEqual(parsed.phrases, ['好耶'], '语料要读成数组')
    assert.deepEqual(parsed.boundaries, ['私信只发主人'], '边界要读成数组')
    assert.equal(parsed.notes, '这里是备注正文。', '备注（只读）要读出来，实际 ' + JSON.stringify(parsed.notes))

    for (const key of ['personality', 'interests', 'dislikes', 'phrases', 'boundaries']) {
      for (const item of parsed[key]) {
        assert.equal(String(item).startsWith('- '), false, key + ' 的列表项不许带「- 」前缀，实际 ' + JSON.stringify(item))
        assert.equal(String(item).startsWith('-'), false, key + ' 的列表项不许带短横线，实际 ' + JSON.stringify(item))
      }
    }
  } finally {
    env.restore()
  }
})

test('writeSections：changed 只含被改的键，其余节逐字节不变（按 ## 切开逐节比，不是整份哈希）', async () => {
  const env = personaEnv('sections-write-one')
  try {
    const persona = await import(repoUrl('lib/core/persona.js'))
    persona.writePersona(STRUCTURED)
    const before = splitOf(fs.readFileSync(persona.personaPath(), 'utf8'))

    const result = persona.writeSections({ interests: ['猫咖', '鬼畜剪辑'] })
    assert.equal(result.ok, true, '改写一节必须成功，实际 ' + JSON.stringify(result))
    assert.deepEqual(result.changed, ['interests'], 'changed 只许含 interests，实际 ' + JSON.stringify(result.changed))

    const after = splitOf(fs.readFileSync(persona.personaPath(), 'utf8'))
    assert.equal(after.preamble, before.preamble, '节外前言必须逐字节不变')
    assert.equal(after.sections['兴趣'], '## 兴趣\n\n- 猫咖\n- 鬼畜剪辑\n\n', '兴趣节要换成新内容（含结尾空行），实际 ' + JSON.stringify(after.sections['兴趣']))
    for (const title of ['一句话', '性格', '雷点', '语料', '边界', '备注']) {
      assert.equal(after.sections[title], before.sections[title], title + ' 这一节必须逐字节不变（哪怕只差一个空行也不行）')
    }
    assert.deepEqual(Object.keys(after.sections), Object.keys(before.sections), '节的顺序与数量都不许变')
  } finally {
    env.restore()
  }
})

test('writeSections 规范化：首尾空格 / 空项 / 换行都规整，落盘是「- 猫」「- a b」，节尾带空行', async () => {
  const env = personaEnv('sections-normalize')
  try {
    const persona = await import(repoUrl('lib/core/persona.js'))
    persona.writePersona(STRUCTURED)

    const result = persona.writeSections({ interests: ['  猫  ', '', '  a\nb ', '\t'] })
    assert.equal(result.ok, true, '规范化后应当成功，实际 ' + JSON.stringify(result))

    const raw = fs.readFileSync(persona.personaPath(), 'utf8')
    const sections = splitOf(raw).sections
    // 空项被丢掉、首尾空格被吃掉、项内换行被压成空格
    assert.equal(sections['兴趣'], '## 兴趣\n\n- 猫\n- a b\n\n', '规范化后的兴趣节不对，实际 ' + JSON.stringify(sections['兴趣']))
    // 结尾空行必须在：否则下一节的标题会贴上来
    assert.match(raw, /- a b\n\n## 雷点/, '兴趣节结尾必须有空行（下一节不许贴行），实际：' + JSON.stringify(raw.slice(raw.indexOf('## 兴趣'), raw.indexOf('## 雷点') + 6)))
    // 解析回来也要是干净的
    assert.deepEqual(persona.parseSections().interests, ['猫', 'a b'], '解析回来的项应当是「猫」「a b」')
  } finally {
    env.restore()
  }
})

test('writeSections 上限：41 项 / 单项 201 字 / tagline 201 字 → ok:false 且文件字节不变', async () => {
  const env = personaEnv('sections-limits')
  try {
    const persona = await import(repoUrl('lib/core/persona.js'))
    persona.writePersona(STRUCTURED)
    const baseline = fs.readFileSync(persona.personaPath(), 'utf8')

    const cases = [
      ['41 项', { interests: Array.from({ length: 41 }, (_, i) => '项' + i) }, /40/],
      ['单项 201 字', { interests: ['x'.repeat(201)] }, /200/],
      ['tagline 201 字', { tagline: 'y'.repeat(201) }, /200/],
    ]
    for (const [label, patch, pattern] of cases) {
      const result = persona.writeSections(patch)
      assert.equal(result.ok, false, label + ' 必须被拒（不许静默截断），实际 ' + JSON.stringify(result))
      assert.match(String(result.error), pattern, label + ' 的文案要说清上限：' + result.error)
      assert.equal(fs.readFileSync(persona.personaPath(), 'utf8'), baseline, label + ' 被拒后 persona.md 必须原样不动')
    }

    // 边界值本身要能通过
    assert.equal(persona.writeSections({ interests: Array.from({ length: 40 }, (_, i) => '项' + i) }).ok, true, '40 项应当可以')
    assert.equal(persona.writeSections({ interests: ['x'.repeat(200)] }).ok, true, '单项 200 字应当可以')
    assert.equal(persona.writeSections({ tagline: 'y'.repeat(200) }).ok, true, 'tagline 200 字应当可以')
  } finally {
    env.restore()
  }
})

test('writeSections 缺节：新节追加到「## 备注」之前，备注仍在最后', async () => {
  const env = personaEnv('sections-insert')
  try {
    const persona = await import(repoUrl('lib/core/persona.js'))
    // 一份**没有「兴趣」节**的人设，但带备注
    const withoutInterests = STRUCTURED.replace(/## 兴趣[\s\S]*?(?=## 雷点)/, '')
    persona.writePersona(withoutInterests)
    assert.equal(splitOf(fs.readFileSync(persona.personaPath(), 'utf8')).sections['兴趣'], undefined, '前提：文件里确实没有兴趣节')

    const result = persona.writeSections({ interests: ['新兴趣一', '新兴趣二'] })
    assert.equal(result.ok, true, '补一节必须成功，实际 ' + JSON.stringify(result))
    assert.deepEqual(result.changed, ['interests'])

    const titles = Object.keys(splitOf(fs.readFileSync(persona.personaPath(), 'utf8')).sections)
    assert.equal(titles.at(-1), '备注', '备注必须仍然在最后，实际顺序 ' + JSON.stringify(titles))
    const at = titles.indexOf('兴趣')
    assert.ok(at >= 0, '兴趣节要被补出来，实际顺序 ' + JSON.stringify(titles))
    assert.equal(titles[at + 1], '备注', '新节要插在「备注」之前，实际顺序 ' + JSON.stringify(titles))
    assert.deepEqual(persona.parseSections().interests, ['新兴趣一', '新兴趣二'], '补出来的节要能解析回去')
  } finally {
    env.restore()
  }
})
