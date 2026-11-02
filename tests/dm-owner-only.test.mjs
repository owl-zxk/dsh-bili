// tests/dm-owner-only.test.mjs —— 用例 7：私信只能发给主人（PROMPT §6.3 硬限制）
//
// 为什么这样测：
//   这条限制的价值全在「无法绕过」，所以测的不是「happy path 能发」，而是三条绕过路径：
//     ① 参数绕过：send(deps, args) 的签名里没有 mid，args 里塞 mid/uid/receiver_id 也不该被采用 ——
//        断言表单里的 msg[receiver_id] 恒等于 deps.owner.mid，而且那些伪造值一个都没出现；
//     ② 配置绕过：owner.mid 为空时直接 reason:'owner-only'，一条请求都不发（不是「发给自己」）；
//     ③ 自我绕过：owner.mid 恰好等于当前 cookie 这个号时也要拒（B站 不允许给自己发私信）。
//   另外把工具参数表也钉住：只要 bili_dm 的 properties 里出现 mid/uid/receiver 这类字段，
//   模型就会以为它能指定收件人 —— 那是设计事故，必须在测试里炸响。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { JCT, OWNER, cleanupTmp, repoUrl, sandboxEnv, tmpDir } from './helpers/harness.mjs'

/** 假客户端：记录每一次 raw() 的完整参数（私信的收件人就在 opts.form 里）。 */
function makeDeps (owner, navMid = 1000001) {
  const captured = []
  const client = {
    async nav () { return { code: 0, data: { mid: navMid, uname: '测试号', isLogin: true } } },
    cred () { return { sessdata: 'S', bili_jct: JCT } },
    async raw (url, opts) {
      captured.push({ url, opts })
      return { code: 0, data: { msg_key: 'fake-key' } }
    },
    async get () { return { code: 0, data: {} } },
    async post () { return { code: 0, data: {} } },
    state () { return { banned: false, banMinutesLeft: 0, banWhy: null, cacheEntries: 0 } },
  }
  const config = { owner, risk: {} }
  const deps = {
    client,
    config,
    owner,
    log: () => {},
    quota: { gate: () => ({ ok: true }), record: () => ({ ok: true }) },
  }
  return { deps, captured }
}

test('私信限制：给非主人 mid 发 → 被拒；owner.mid 为空 → owner-only；签名里没有 mid 参数', async () => {
  const root = tmpDir('dm')
  const restoreEnv = sandboxEnv(root)
  try {
    const messageApi = await import(repoUrl('lib/api/message.js'))
    const { buildTools } = await import(repoUrl('lib/tools/index.js'))

    // ① 函数签名：只有 (deps, args) 两个参数，没有任何「收件人」形参
    assert.equal(messageApi.send.length, 2, 'send() 的签名必须是 (deps, args) 两个参数，实际 ' + messageApi.send.length + ' 个')

    // ② 工具参数表里不许出现任何「能指定收件人」的字段
    const { deps, captured } = makeDeps(OWNER)
    const dmTool = buildTools(deps).find((tool) => tool.name === 'bili_dm')
    assert.ok(dmTool !== undefined, 'bili_dm 工具必须存在')
    const properties = Object.keys((dmTool.parameters && dmTool.parameters.properties) || {})
    for (const forbidden of ['mid', 'uid', 'receiver', 'receiver_id', 'to']) {
      assert.equal(properties.includes(forbidden), false, 'bili_dm 的参数里不许有 ' + forbidden + '（收件人恒等于主人），实际参数：' + properties.join(','))
    }
    assert.match(dmTool.description, /只能发给主人|收件人是写死|owner\.mid/, '工具描述必须写明「私信只能发给主人」')

    // ③ 参数绕过：塞一堆 mid/uid/receiver，收件人必须还是主人
    const forged = {
      text: '给主人的一句话',
      mid: '999999',
      uid: '888888',
      receiver: '777777',
      receiver_id: '666666',
      to: '555555',
    }
    const sent = await messageApi.send(deps, forged)
    assert.equal(sent.ok, true, '主人配置正常时应当发得出去（假客户端回 code=0），实际 ' + JSON.stringify(sent).slice(0, 200))
    assert.equal(captured.length, 1, '应当正好发了一次 raw 请求')
    const form = captured[0].opts.form
    assert.equal(form['msg[receiver_id]'], String(OWNER.mid), '收件人必须是 owner.mid，实际 ' + form['msg[receiver_id]'])
    const serialized = JSON.stringify(form)
    for (const value of ['999999', '888888', '777777', '666666', '555555']) {
      assert.equal(serialized.includes(value), false, '伪造的 mid(' + value + ') 不许出现在请求里：' + serialized.slice(0, 300))
    }

    // ④ 配置绕过：owner.mid 为空 → owner-only，且一条请求都不发
    const empty = makeDeps({ mid: '', name: '未配置' })
    const refused = await messageApi.send(empty.deps, { text: '还是想发', mid: '999999' })
    assert.equal(refused.ok, false, 'owner.mid 为空时必须拒绝')
    assert.equal(refused.reason, 'owner-only', '原因必须是 owner-only（硬限制，不是参数错），实际 ' + refused.reason)
    assert.match(refused.human, /主人|owner\.mid/, '人话要说清「私信只发给主人」：' + refused.human)
    assert.equal(empty.captured.length, 0, 'owner.mid 为空时一条请求都不许发，实际 ' + empty.captured.length + ' 条')

    // ⑤ 自我绕过：owner.mid 就是当前号 → 也拒（B站 不允许给自己发私信）
    const self = makeDeps(OWNER, OWNER.mid)
    const selfRefused = await messageApi.send(self.deps, { text: '发给自己' })
    assert.equal(selfRefused.ok, false, 'owner.mid 等于当前账号时必须拒绝')
    assert.equal(selfRefused.reason, 'owner-only')
    assert.equal(self.captured.length, 0, '拒了就不许发请求，实际 ' + self.captured.length + ' 条')
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})
