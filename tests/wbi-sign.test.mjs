// tests/wbi-sign.test.mjs —— 用例 1：WBI 签名（PROMPT §9 第一行）
//
// 为什么这样测：
//   WBI 签名是「同参数必同签名」的纯函数（vendor/bili-api.mjs: signWbi），签名一错，
//   所有需要 wbi 的读接口都会回 -412/-403，而这种错最难查 —— 所以这里只钉两条性质：
//     ① 同样的参数 + 同样的时间 → 一模一样的 w_rid（否则缓存键永远命中不了，见
//        apiGet 里 cacheKey 那段注释：缓存键必须排除 wts/w_rid 才可能有命中）；
//     ② 缺 wbi_img（或密钥长度不是 64）→ 抛明确错误，而不是拿空密钥签出一串假签名去撞 B站。
//   不测具体 md5 值：那等于把实现抄一遍，而实现是复制过来的、已真机验证过的基线。
import test from 'node:test'
import assert from 'node:assert/strict'

import { tmpDir, setEnv, repoUrl, WBI_IMG, cleanupTmp } from './helpers/harness.mjs'

// 先沙盒化再 import：bili-api.mjs 在模块加载期就会取一次 stateDir()。
const root = tmpDir('wbi')
const restoreEnv = setEnv({ DSH_BILI_STATE_DIR: root, BILI_NO_CACHE: undefined })
const { signWbi } = await import(repoUrl('lib/vendor/bili-api.mjs'))

test('WBI 签名：同参数两次签名 w_rid 相同；缺 wbi_img 抛明确错误', () => {
  const params = { bvid: 'BV1GJ411x7h7', foo: "a!b(c)*d'", n: 7 }
  const now = 1_700_000_000_000

  const first = signWbi(params, WBI_IMG, now)
  const second = signWbi(params, WBI_IMG, now)

  // ① 同参同签
  assert.equal(first, second, '同样的参数与同样的时间必须签出同一个 query（含 w_rid）')
  assert.match(first, /w_rid=[0-9a-f]{32}/, 'w_rid 必须是 32 位十六进制 md5')
  assert.match(first, /wts=1700000000/, 'wts 是秒级时间戳，由 now 决定')

  // 参数顺序不该影响结果（key 排序才可能命中缓存）
  const reordered = signWbi({ n: 7, foo: "a!b(c)*d'", bvid: 'BV1GJ411x7h7' }, WBI_IMG, now)
  assert.equal(reordered, first, '参数书写顺序不同但内容相同时，签名必须一致')

  // 时间变了签名必须跟着变（否则 B站 侧的时间窗口校验会挂）
  assert.notEqual(signWbi(params, WBI_IMG, now + 1000), first, 'wts 不同 → 签名必须不同')

  // ② 缺 wbi_img（含只有一半密钥）→ 明确错误
  assert.throws(
    () => signWbi(params, undefined, now),
    (error) => /WBI/.test(error.message) && /密钥/.test(error.message),
    '缺 wbi_img 时必须抛「WBI 签名密钥缺失」这种明确错误，不能静默签出空密钥'
  )
  assert.throws(
    () => signWbi(params, { img_url: WBI_IMG.img_url }, now),
    (error) => /WBI/.test(error.message),
    '只有 img_url 没有 sub_url 时，raw 长度不是 64，同样必须抛'
  )
})

test.after(() => { restoreEnv(); cleanupTmp() })
