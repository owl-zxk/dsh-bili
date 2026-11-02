// File-backed capture works where Windows sandbox disallows anonymous pipes.
//
// 复制适配（唯一一处）：临时目录前缀从上一个插件的品牌名改成 'dsh-bili-capture-'。
//   逻辑一行未改；改的只是 tmp 目录名 —— 旧名字带着上一个插件的品牌，
//   日后有人 grep 本包源码时会被误判成"还在引用那个插件"，而它其实只是个目录名。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
export function execFileSync(file, args = [], options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bili-capture-'))
  const out = path.join(dir, 'stdout'), err = path.join(dir, 'stderr')
  const fds = []
  try {
    fds.push(fs.openSync(out, 'wx', 0o600), fs.openSync(err, 'wx', 0o600))
    const result = spawnSync(file, args, { ...options, timeout: options.timeout ?? 120000,
      windowsHide: true, stdio: ['ignore', ...fds] })
    for (const fd of fds.splice(0)) fs.closeSync(fd)
    const stdout = fs.readFileSync(out), stderr = fs.readFileSync(err)
    if (result.error || result.status !== 0) {
      const e = result.error ?? new Error(`子进程失败 (${result.status}): ${stderr.toString('utf8').slice(0, 1000)}`)
      Object.assign(e, { status: result.status, stdout, stderr }); throw e
    }
    return options.encoding ? stdout.toString(options.encoding) : stdout
  } finally {
    for (const fd of fds) fs.closeSync(fd)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
