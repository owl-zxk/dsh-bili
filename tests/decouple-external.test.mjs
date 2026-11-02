// tests/decouple-external.test.mjs —— 用例 16/17：解耦·不依赖旧包 / 不改旧插件（PROMPT §1.2）
//
// 为什么这样测：
//   ① 「不依赖旧包」的正确证法不是看 package.json（那只能证明没声明），而是**换一个没有旧包的
//      环境真跑一遍**。PROMPT §9 原话是「临时把 node_modules/dsh-bili-whale 移走，测试仍全绿」——
//      但本机 DSH 正在运行、node_modules 里可能有 junction，移动它等于同时在改运行中的宿主。
//      所以改成**复制**：把 lib/ + tests/ + package.json 复制到 os.tmpdir() 下的独立目录，
//      在那里跑整套测试。旧插件既没被移动、也没被删，而「没有它也能全绿」这个结论一样成立
//      （复制出来的目录里连 node_modules 都没有）。
//      递归保护：子进程里带 DSH_BILI_CHILD_RUN=1，本用例在子进程里直接 skip（否则无限递归，
//      那不是「全绿」而是跑不完）。这不是给失败找台阶 —— 子进程里跑的其它 19 条用例一条不少。
//   ② 「不改旧插件」：测试前后对 whale-src/dsh-bili-whale 取「文件清单 + mtime + size」快照并比对，
//      全程只 stat / readdir，不读内容、不写任何一个字节。快照在**本文件加载时**就取（before），
//      断言在用例末尾（after）—— 这覆盖了本文件自己的全部活动，以及并行跑着的其它用例的时间窗。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { REPO_ROOT, cleanupTmp, setEnv, tmpDir, walkFiles } from './helpers/harness.mjs'

const WHALE_DIR = process.env.DSH_BILI_WHALE_DIR || 'D:/DSH/dsh-home/whale-src/dsh-bili-whale'

function copyTree (from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(source, target)
    else if (entry.isFile()) fs.copyFileSync(source, target)
  }
}

/** 文件清单 + mtime + size 的快照（只读）。 */
function snapshotTree (dir) {
  const rows = []
  for (const file of walkFiles(dir)) {
    let stat
    try { stat = fs.statSync(file) } catch { continue }
    rows.push(path.relative(dir, file).split(path.sep).join('/') + ' ' + stat.size + ' ' + stat.mtimeMs)
  }
  return rows
}

const whaleBefore = fs.existsSync(WHALE_DIR) ? snapshotTree(WHALE_DIR) : null

test('解耦·不依赖旧包：复制到临时目录（没有 node_modules / 没有鲸鱼包）后整套测试仍全绿', { timeout: 600_000 }, (t) => {
  if (process.env.DSH_BILI_CHILD_RUN === '1') {
    t.skip('当前就在「复制出来的独立目录」里跑（递归保护：父用例已经验证过这件事）')
    return
  }
  const dest = tmpDir('standalone')
  try {
    for (const name of ['lib', 'tests']) copyTree(path.join(REPO_ROOT, name), path.join(dest, name))
    for (const name of ['package.json', 'cordis.patch.yml', 'README.md']) {
      const source = path.join(REPO_ROOT, name)
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dest, name))
    }

    // 前提：复制出来的目录里既没有 node_modules，也没有旧插件
    assert.equal(fs.existsSync(path.join(dest, 'node_modules')), false, '复制出来的目录里不该有 node_modules（有依赖就说明这个包还需要外部安装）')
    assert.equal(fs.existsSync(path.join(dest, 'node_modules', 'dsh-bili-whale')), false, '复制出来的目录里不许有旧插件')

    const testFiles = fs.readdirSync(path.join(dest, 'tests'))
      .filter((name) => name.endsWith('.test.mjs'))
      .sort()
      .map((name) => path.join('tests', name))
    assert.ok(testFiles.length >= 10, '复制过去的用例文件应当 ≥10，实际 ' + testFiles.length)

    const stateRoot = path.join(dest, '.state')
    const env = {
      ...process.env,
      DSH_BILI_CHILD_RUN: '1',
      DSH_BILI_STATE_DIR: stateRoot,
      DSH_BILI_CRED_PATH: path.join(stateRoot, 'credentials.json'),
      DSH_BILI_CONFIG: path.join(stateRoot, 'dsh-bili.config.json'),
      BILI_TRAFFIC_TEST: '1',
    }
    delete env.BILI_NO_CACHE
    delete env.NODE_TEST_CONTEXT

    const result = spawnSync(process.execPath, ['--test', ...testFiles], {
      cwd: dest,
      env,
      encoding: 'utf8',
      timeout: 540_000,
      windowsHide: true,
    })
    const output = String(result.stdout ?? '') + String(result.stderr ?? '')
    assert.equal(result.status, 0, '在没有旧包的环境里整套测试必须全绿（退出码 0），实际 ' + result.status + '\n' + output.split(/\r?\n/).slice(-40).join('\n'))
    assert.match(output, /# pass|pass \d+/, '应当能看到测试汇总行：\n' + output.split(/\r?\n/).slice(-15).join('\n'))
    assert.equal(/ERR_MODULE_NOT_FOUND/.test(output), false, '复制出来的目录里不许出现模块解析失败：\n' + output.slice(-2000))
  } finally {
    cleanupTmp()
  }
})

test('解耦·不改旧插件：whale-src/dsh-bili-whale 的文件清单 + mtime 前后一致', async (t) => {
  if (whaleBefore === null) {
    t.skip('本机没有旧插件目录（' + WHALE_DIR + '），无法做只读快照比对')
    return
  }
  assert.ok(whaleBefore.length > 100, '快照至少应当覆盖上百个文件（含 node_modules / .git），实际 ' + whaleBefore.length)

  // 本插件跑一点东西（真账本 + 假客户端），证明「本插件工作时不碰旧插件」
  const root = tmpDir('whale')
  const restoreEnv = setEnv({ DSH_BILI_STATE_DIR: root, BILI_NO_CACHE: undefined })
  try {
    const quotaModule = await import(pathToFileURL(path.join(REPO_ROOT, 'lib', 'core', 'quota.js')).href)
    const config = { owner: { mid: 1, name: 'x' }, risk: {}, paths: { stateDir: root } }
    quotaModule.record(config, { type: 'comment', target: 'oid:1', note: '解耦用例' })
    quotaModule.gate(config, { type: 'comment', target: 'oid:1' })
  } finally {
    restoreEnv()
    cleanupTmp()
  }

  const whaleAfter = snapshotTree(WHALE_DIR)
  const before = new Set(whaleBefore)
  const after = new Set(whaleAfter)
  const missing = whaleBefore.filter((row) => !after.has(row)).slice(0, 5)
  const added = whaleAfter.filter((row) => !before.has(row)).slice(0, 5)
  assert.deepEqual(
    { removedOrChanged: missing, addedOrChanged: added },
    { removedOrChanged: [], addedOrChanged: [] },
    '旧插件目录在测试前后必须完全一致（文件清单 + mtime + size）：\n少了/变了：' + missing.join('\n') + '\n多了/变了：' + added.join('\n')
  )
})
