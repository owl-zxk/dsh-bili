// tests/quota-gate.test.mjs —— 用例 5/6：7 条写通道逐条挂闸、配额超限不记账（PROMPT §6.1）
//
// 为什么这样测：
//   「漏挂一条写通道 = 裸奔」是旧实现踩过的最贵的坑，而漏挂这件事**只能逐条证明**：
//   所以这里不用「检查源码里有没有 gate(」这种静态手段（改个变量名就骗过去了），
//   而是给 7 条写通道每一条都塞一个**必然拒绝**的假闸，然后断言：
//     · 返回值是 { ok:false, reason:'quota-exceeded', human }（模型能看懂、能换路）；
//     · 假客户端上的 post / raw 调用数 = 0（一条请求都没发出去）；
//     · record 一次都没被调用（没发出去就不该占额度）。
//   闸门拒绝的位置也有讲究：收藏/点赞/动态要在「换 aid / 传图」这些附带请求**之前**就拒，
//   否则白打两次只读请求 —— 所以 favorite/like 连 get 都必须是 0（dynamic.edit 例外：
//   它必须先读一次 detail 才有「原来的图」可保留，那一读是设计，不是漏挂）。
//   用例 6 换成真闸（core/quota.js）+ 真账本文件，证明「超限 → 拒 → 账本条数不变」。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  BVID, JCT, OWNER, cleanupTmp, localDayKey, localHourKey, repoUrl, sandboxEnv, tmpDir,
  writeBudgetState, writeUsageLedger,
} from './helpers/harness.mjs'

/** 计数用的假客户端：只回答形状，不联网。 */
function countingClient () {
  return {
    getCalls: 0,
    postCalls: 0,
    rawCalls: 0,
    async get (requestPath) {
      this.getCalls += 1
      if (requestPath === '/x/web-interface/view') return { code: 0, data: { bvid: BVID, aid: 123, title: '假标题' } }
      if (requestPath === '/x/v3/fav/folder/created/list-all') return { code: 0, data: { list: [{ id: 7, title: '默认收藏夹', media_count: 1 }] } }
      return { code: 0, data: { item: { id_str: '555' }, items: [] } }
    },
    async post () { this.postCalls += 1; return { code: 0, data: { rpid_str: '999' } } },
    async raw () { this.rawCalls += 1; return { code: 0, data: { dyn_id_str: '555' } } },
    async nav () { return { code: 0, data: { mid: 1000001, isLogin: true } } },
    cred () { return { sessdata: 'S', bili_jct: JCT } },
    state () { return { banned: false, banMinutesLeft: 0, banWhy: null, cacheEntries: 0 } },
  }
}

test('配额闸：7 条写通道逐条挂闸（假闸拒绝 → 一条 post/raw 都不发）', async () => {
  const root = tmpDir('gate')
  const restoreEnv = sandboxEnv(root)
  try {
    const commentApi = await import(repoUrl('lib/api/comment.js'))
    const dynamicApi = await import(repoUrl('lib/api/dynamic.js'))
    const messageApi = await import(repoUrl('lib/api/message.js'))
    const favoriteApi = await import(repoUrl('lib/api/favorite.js'))
    const relationApi = await import(repoUrl('lib/api/relation.js'))

    const gateCalls = []
    let recordCalls = 0
    const client = countingClient()
    const config = { owner: OWNER, risk: {}, paths: { stateDir: root } }
    const deps = {
      client,
      config,
      owner: OWNER,
      log: () => {},
      quota: {
        // 假闸：永远拒绝。真闸的行为由用例 6 覆盖。
        gate: (passedConfig, options) => {
          gateCalls.push({ config: passedConfig, type: options && options.type, target: options && options.target })
          return { ok: false, reason: 'quota-exceeded', human: '额度用完了（测试桩）', detail: { used: 9, limit: 9, window: 'day' } }
        },
        record: () => { recordCalls += 1; return { ok: true } },
      },
    }

    const channels = [
      {
        name: 'comment.add',
        type: 'comment',
        run: () => commentApi.add(deps, { oid: '123', message: '测试评论' }),
        expectGets: 0,
      },
      {
        name: 'comment.reply',
        type: 'reply',
        run: () => commentApi.reply(deps, { oid: '123', root: '1', rpid: '2', message: '测试回复' }),
        expectGets: 0,
      },
      {
        name: 'dynamic.create',
        type: 'dynamic',
        run: () => dynamicApi.create(deps, { text: '测试动态' }),
        expectGets: 0,
      },
      {
        name: 'dynamic.edit',
        type: 'dynamic_edit',
        run: () => dynamicApi.edit(deps, { dynId: '555', text: '改过的动态' }),
        expectGets: 1, // 设计上先读 detail 把原图带上（全量覆盖），这一读不算漏挂
      },
      {
        name: 'message.send',
        type: 'dm',
        run: () => messageApi.send(deps, { text: '给主人的私信' }),
        expectGets: 0,
      },
      {
        name: 'favorite.deal',
        type: 'favorite',
        run: () => favoriteApi.deal(deps, { bvid: BVID }),
        expectGets: 0,
      },
      {
        name: 'relation.like',
        type: 'like',
        run: () => relationApi.like(deps, { bvid: BVID, action: 'like' }),
        expectGets: 0,
      },
    ]

    for (const channel of channels) {
      client.getCalls = 0
      client.postCalls = 0
      client.rawCalls = 0
      const result = await channel.run()
      assert.equal(result.ok, false, channel.name + ' 在闸门拒绝时必须返回 ok:false，实际 ' + JSON.stringify(result).slice(0, 200))
      assert.equal(result.reason, 'quota-exceeded', channel.name + ' 的失败原因必须是 quota-exceeded（模型靠这个分支换路）')
      assert.equal(typeof result.human, 'string', channel.name + ' 必须给人话（human）')
      assert.ok(result.human.length > 0, channel.name + ' 的 human 不能为空')
      assert.equal(client.postCalls, 0, channel.name + ' 闸门拒绝后绝不许发 post 请求，实际 ' + client.postCalls + ' 次')
      assert.equal(client.rawCalls, 0, channel.name + ' 闸门拒绝后绝不许发 raw 请求，实际 ' + client.rawCalls + ' 次')
      assert.equal(client.getCalls, channel.expectGets, channel.name + ' 的附带只读请求次数不对（实际 ' + client.getCalls + '，期望 ' + channel.expectGets + '）')
    }

    assert.equal(recordCalls, 0, '没发出去就绝不许记账（record 调用数必须是 0）')
    assert.deepEqual(
      gateCalls.map((call) => call.type),
      ['comment', 'reply', 'dynamic', 'dynamic_edit', 'dm', 'favorite', 'like'],
      '7 条写通道必须各自用正确的 type 过闸，实际顺序：' + JSON.stringify(gateCalls.map((call) => call.type))
    )
    for (const call of gateCalls) {
      assert.ok(call.config !== undefined && call.config !== null, call.type + ' 的 gate() 必须收到生效配置（否则闸门算的是默认预算）')
    }
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})

// 2026-11-01 需求变更（INTERFACE §11）：额度改成按 token 计，写次数配额（writeHourly /
// writeDaily）**已废弃**。所以这一条不再构造"账本里已有 30 条"，而是构造"用量账本里今天
// 已经花了多少 token"——判据换了，被拒时要验的东西（reason / 不发请求 / 不记账）没变。
test('配额超限：token 预算用尽（当天 / 本小时）→ 拒 → 不记账（quota.json 条数不变）', async () => {
  const root = tmpDir('quota-full')
  const restoreEnv = sandboxEnv(root)
  try {
    fs.mkdirSync(root, { recursive: true })
    const { gate, record, quotaFile } = await import(repoUrl('lib/core/quota.js'))
    const commentApi = await import(repoUrl('lib/api/comment.js'))
    const ledgerFile = path.join(root, 'usage-ledger.json')

    const config = {
      owner: OWNER,
      budget: { tokenHourly: 1000, tokenDaily: 2000 },
      risk: { writeGapSec: 120, dmGapSec: 0 },
      paths: { stateDir: root },
    }
    const file = quotaFile(config)
    const at = new Date().toISOString()
    // 预置两条历史记账（类型用 favorite：绕开 comment 的写间隔闸），用来断言"拒了就不许再加一条"。
    fs.writeFileSync(file, JSON.stringify({
      log: [
        { at, type: 'favorite', auto: false, share: false, target: 'BV:x', note: 'a' },
        { at, type: 'favorite', auto: false, share: false, target: 'BV:y', note: 'b' },
      ],
    }))

    // ① 当天窗口：账本当天合计 2500 ≥ tokenDaily 2000
    writeUsageLedger(ledgerFile, 2500)
    const dayVerdict = gate(config, { type: 'comment', target: 'oid:123' })
    assert.equal(dayVerdict.ok, false, 'tokenDaily 用满后 gate() 必须拒绝')
    assert.equal(dayVerdict.reason, 'token-budget-exhausted', '写次数配额已废弃（§11）；额度用尽必须是 token-budget-exhausted，实际 ' + dayVerdict.reason)
    assert.equal(dayVerdict.detail.window, 'day', '这一档拒的必须是「当天 token 预算」，实际 window=' + dayVerdict.detail.window)
    assert.equal(dayVerdict.detail.day.limit, 2000, '上限应来自 config.budget.tokenDaily')
    assert.equal(dayVerdict.detail.day.used, 2500, '已用应等于账本当天合计（input+output）')

    // ② 本小时窗口：把采样状态推到「本小时已花满」（小时桶是采样差分出来的，见 §11）
    writeBudgetState(root, {
      hourKey: localHourKey(), hourUsed: 1000, dayKey: localDayKey(), dayBase: 0, sampledTotal: 2500,
    })
    const hourVerdict = gate(config, { type: 'comment', target: 'oid:123' })
    assert.equal(hourVerdict.ok, false, 'tokenHourly 用满后 gate() 必须拒绝')
    assert.equal(hourVerdict.reason, 'token-budget-exhausted')
    assert.equal(hourVerdict.detail.window, 'hour', '小时桶先于天桶判定，实际 window=' + hourVerdict.detail.window)
    assert.equal(hourVerdict.detail.hour.limit, 1000, '上限应来自 config.budget.tokenHourly')
    assert.match(hourVerdict.human, /token/, '人话要说清是 token 预算：' + hourVerdict.human)
    assert.match(hourVerdict.human, /读通道仍可用/, '人话要说明读通道不受影响（§11 拦截范围只有写通道）')

    // ③ 真的走一次写通道：被拒 → 一条请求都不发、账本一条都不加
    const before = JSON.parse(fs.readFileSync(file, 'utf8')).log.length
    const client = countingClient()
    const deps = { client, config, owner: OWNER, log: () => {}, quota: { gate, record } }
    const result = await commentApi.add(deps, { oid: '123', message: '这条不该发出去' })

    assert.equal(result.ok, false, '预算用尽时写通道必须失败')
    assert.equal(result.reason, 'token-budget-exhausted', 'reason 必须原样透出 token-budget-exhausted（不许折成 quota-exceeded）')
    assert.equal(client.postCalls, 0, '预算用尽时一条请求都不许发，实际 post ' + client.postCalls + ' 次')
    assert.equal(client.rawCalls, 0, '预算用尽时一条 raw 也不许发，实际 ' + client.rawCalls + ' 次')
    const after = JSON.parse(fs.readFileSync(file, 'utf8')).log.length
    assert.equal(after, before, '闸门拒绝时绝不许记账：quota.json 条数必须不变（' + before + ' → ' + after + '）')
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})
