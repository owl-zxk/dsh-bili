// tests/decouple-static.test.mjs —— 用例 14/15：解耦·无引用 / 无依赖（PROMPT §1.2 红线）
//
// 为什么这样测：
//   §1.2 的判定标准是「对方被卸载后，本插件功能完全不受影响」。这条标准有两条必要（不充分）
//   的静态证据，而且要抓的是**所有变体**：dsh-bili-whale / bili-whale / whale-src /
//   whale-work / whale-diary / whale-log / whale-session —— 源码里出现任何一个，
//   都意味着这个包还连着对方（哪怕只是拼个路径）。
//   扫描范围（有意排除，理由留在这里而不是只写在报告里）：
//     · docs/：红线的**说明文档** —— 它本来就在解释"为什么不能引用旧实现"，要求它不出现旧包名
//       等于要求把红线解释删掉；
//     · tests/：用例 17 必须写出旧插件的绝对路径，才能取到只读快照；
//     二者都不进入发布物的代码面。
//     · node_modules（第三方）、PROMPT.md（需求原文，本来就在命名旧实现）。
//   README.md **在扫描范围内**：发布物上的散文同样算发布面 —— 它曾经因为写了旧包名被这条用例
//   抓住，改说法之后才变绿。所以"它改好看了就顺手排除"是不允许的，下面用断言把范围钉死。
//   为了不出现「因为没扫到东西所以全绿」，用例里还断言扫到的文件数 ≥ 10。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { REPO_ROOT, walkFiles } from './helpers/harness.mjs'

const FORBIDDEN = [
  'dsh-bili-whale',
  'bili-whale',
  'whale-src',
  'whale-work',
  'whale-diary',
  'whale-log',
  'whale-session',
  'whale-listen',
  'whale-memory',
]

const EXCLUDED_DIRS = ['node_modules', 'docs', 'tests', '.git']
const EXCLUDED_FILES = ['PROMPT.md']

function scannedFiles () {
  const all = walkFiles(REPO_ROOT)
  return all.filter((file) => {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/')
    if (EXCLUDED_DIRS.some((dir) => rel === dir || rel.startsWith(dir + '/'))) return false
    if (EXCLUDED_FILES.includes(path.basename(file))) return false
    return /\.(js|mjs|cjs|json|yml|yaml|md)$/i.test(file)
  })
}

test('解耦·无引用：本仓库发布面上的源码不出现鲸鱼包名 / whale 路径串', () => {
  const files = scannedFiles()
  const relatives = files.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))

  // 扫描范围本身也要被断言：范围一旦被悄悄改窄（例如"README 改好看了，把它排除掉吧"），
  // 这条用例就从「守住红线」退化成「守住一个不痛不痒的子集」，而且退化时没有任何输出。
  assert.ok(files.length >= 10, '必须真的扫到源码文件（≥10），实际 ' + files.length + '（否则本用例是空跑）')
  assert.ok(relatives.includes('README.md'), 'README.md 必须在扫描范围内（发布物散文也算发布面），实际扫到：' + relatives.join(','))
  assert.ok(relatives.includes('package.json'), 'package.json 必须在扫描范围内')
  assert.ok(relatives.some((rel) => rel.startsWith('lib/')), 'lib/ 下的源码必须在扫描范围内')
  for (const excluded of ['docs/', 'tests/', 'node_modules/']) {
    assert.equal(relatives.some((rel) => rel.startsWith(excluded)), false, excluded + ' 应当被排除（理由见文件头注释），实际却扫到了它')
  }
  assert.equal(relatives.includes('PROMPT.md'), false, 'PROMPT.md 是需求原文（本来就在命名旧实现），应当排除')

  const hits = []
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/')
    const text = fs.readFileSync(file, 'utf8')
    const lowered = text.toLowerCase()
    for (const needle of FORBIDDEN) {
      if (lowered.includes(needle)) {
        const line = text.split(/\r?\n/).findIndex((row) => row.toLowerCase().includes(needle)) + 1
        hits.push(rel + ':' + line + ' 命中 ' + needle)
      }
    }
  }
  assert.deepEqual(hits, [], '解耦红线（§1.2）：源码里不许出现旧插件名 / 私有路径。命中项：\n' + hits.join('\n'))
})

test('解耦·无依赖：package.json 三处依赖里都没有鲸鱼包名', () => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
  const pkg = JSON.parse(raw)
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field]
    if (deps === undefined || deps === null) continue
    const offenders = Object.keys(deps).filter((name) => FORBIDDEN.some((needle) => name.toLowerCase().includes(needle)))
    assert.deepEqual(offenders, [], 'package.json 的 ' + field + ' 里不许有鲸鱼包：' + offenders.join(','))
  }
  // 整份文本都不能出现旧包名（防止藏在 scripts / dsh 字段里）
  for (const needle of FORBIDDEN) {
    assert.equal(raw.toLowerCase().includes(needle), false, 'package.json 文本里出现了「' + needle + '」')
  }
})
