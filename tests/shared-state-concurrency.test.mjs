// tests/shared-state-concurrency.test.mjs —— 用例 18/19：共享状态·原子写 / 配额合并（PROMPT §1.4）
//
// 为什么这样测：
//   §1.4 说得很直白：配额账本**必须共享**，否则两个实现各写 30 条 = 实际 60 条，账号照样被风控。
//   而「共享」的工程含义只有两条，都必须用**两个真进程**（不是两个 async 函数 —— 同一进程里
//   根本不存在并发写同一个文件的窗口）来验证：
//     ① 原子写：并发写同一份 quota.json / api-ban.json，结果必须是**合法 JSON 的一整份**，
//        不能出现被截断的半个文件（所以写之前 re-read、写到 tmp 再 rename）；
//     ② 合并：两个进程各记 N 条，账本总数必须是 2N —— 少一条就说明有一方读到了旧文件、
//        把对方的记录覆盖掉了（这正是「各算各的」的物理表现）。
//   子进程用 node 直接跑一段小小的工作脚本（放在 os.tmpdir() 下的独立目录里），
//   它们 import 的是本仓库真实的 lib/core/quota.js / lib/core/config.js —— 测的是真实现，
//   不是测试里复刻的一份假账本逻辑。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { REPO_ROOT, cleanupTmp, readJson, tmpDir } from './helpers/harness.mjs'

const WORKER_SOURCE = `
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [repoRoot, stateDir, mode, count, tag] = process.argv.slice(2)
process.env.DSH_BILI_STATE_DIR = stateDir
const config = {
  owner: { mid: 1, name: 'worker' },
  risk: { writeHourly: 1000, writeDaily: 100000, writeGapSec: 30, dmGapSec: 0 },
  paths: { stateDir },
}
const rounds = Number(count)

if (mode === 'quota') {
  const { record } = await import(pathToFileURL(path.join(repoRoot, 'lib', 'core', 'quota.js')).href)
  for (let i = 0; i < rounds; i += 1) record(config, { type: tag, target: tag + ':' + i, note: '并发记账' })
} else {
  const { writeJsonAtomic } = await import(pathToFileURL(path.join(repoRoot, 'lib', 'core', 'config.js')).href)
  for (let i = 0; i < rounds; i += 1) {
    writeJsonAtomic(path.join(stateDir, 'api-ban.json'), {
      until: Date.now() + 60_000, why: 'HTTP 412', at: new Date().toISOString(), streak: i + 1,
    })
  }
}
process.stdout.write('ok')
`

/** 写一份工作脚本到临时目录，返回它的绝对路径。 */
function workerFile (dir) {
  const file = path.join(dir, 'worker.mjs')
  if (!fs.existsSync(file)) fs.writeFileSync(file, WORKER_SOURCE)
  return file
}

/** 起一个真子进程（两个同时起 = 真并发）。 */
function runWorker ({ file, stateDir, mode, count, tag }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, REPO_ROOT, stateDir, mode, String(count), tag], {
      env: { ...process.env, DSH_BILI_STATE_DIR: stateDir, BILI_TRAFFIC_TEST: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('共享状态·原子写：两个子进程同时写 quota.json / api-ban.json → 结果必须是合法 JSON', { timeout: 180_000 }, async () => {
  const dir = tmpDir('atomic')
  const stateDir = path.join(dir, 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  const file = workerFile(dir)
  try {
    const results = await Promise.all([
      runWorker({ file, stateDir, mode: 'quota', count: 12, tag: 'comment' }),
      runWorker({ file, stateDir, mode: 'quota', count: 12, tag: 'reply' }),
      runWorker({ file, stateDir, mode: 'ban', count: 60, tag: 'ban' }),
      runWorker({ file, stateDir, mode: 'ban', count: 60, tag: 'ban' }),
    ])
    for (const result of results) {
      assert.equal(result.code, 0, '子进程必须正常退出，实际 ' + result.code + '；stderr：' + result.stderr.slice(0, 800))
    }

    const quotaFile = path.join(stateDir, 'quota.json')
    const banFile = path.join(stateDir, 'api-ban.json')
    assert.ok(fs.existsSync(quotaFile), 'quota.json 必须被写出来')
    assert.ok(fs.existsSync(banFile), 'api-ban.json 必须被写出来')

    // 合法性：JSON.parse 成功 + 结构完整（半个文件会在这里炸）
    const quota = readJson(quotaFile)
    assert.ok(Array.isArray(quota.log), 'quota.json 必须是 { log: [...] }，实际 ' + JSON.stringify(quota).slice(0, 200))
    assert.ok(quota.log.length >= 20, '两个进程各写 12 条，账本至少要有 20 条（明显覆盖就说明丢了），实际 ' + quota.log.length)
    for (const entry of quota.log) {
      assert.equal(typeof entry.at, 'string', '每条记录都要有 at（既有账本格式）')
      assert.equal(typeof entry.type, 'string', '每条记录都要有 type（既有账本格式）')
    }

    const ban = readJson(banFile)
    assert.equal(typeof ban.until, 'number', 'api-ban.json 的 until 必须是数字，实际 ' + JSON.stringify(ban).slice(0, 200))
    assert.equal(typeof ban.why, 'string', 'api-ban.json 必须带 why（排障要看原因）')
    assert.ok(ban.until > Date.now() - 120_000, 'until 应当是一个合理的时间戳，实际 ' + ban.until)

    // 原子写的收尾：不许留下 .tmp 半成品，锁也要还回去
    const leftovers = fs.readdirSync(stateDir).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))
    assert.deepEqual(leftovers, [], '原子写不许留下 .tmp / .lock，实际 ' + leftovers.join(','))
  } finally {
    cleanupTmp()
  }
})

test('共享状态·配额合并：两个子进程各写 N=10 条 → quota.json 总条数 = 2N（不是 N）', { timeout: 180_000 }, async () => {
  const dir = tmpDir('merge')
  const stateDir = path.join(dir, 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  const file = workerFile(dir)
  const N = 10
  try {
    const results = await Promise.all([
      runWorker({ file, stateDir, mode: 'quota', count: N, tag: 'comment' }),
      runWorker({ file, stateDir, mode: 'quota', count: N, tag: 'comment' }),
    ])
    for (const result of results) {
      assert.equal(result.code, 0, '子进程必须正常退出，实际 ' + result.code + '；stderr：' + result.stderr.slice(0, 800))
    }
    const quota = readJson(path.join(stateDir, 'quota.json'))
    assert.equal(quota.log.length, 2 * N, '共享账本的总条数必须是 2N=' + (2 * N) + '（少一条就是有一方覆盖了另一方），实际 ' + quota.log.length)
    assert.equal(quota.log.filter((entry) => entry.type === 'comment').length, 2 * N, '两个进程记的都是 comment 类型')
  } finally {
    cleanupTmp()
  }
})
