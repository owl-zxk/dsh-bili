// tests/token-budget.test.mjs —— INTERFACE §11：额度按 token 计（2026-11-01 需求变更）
//
// 为什么这样测：
//   额度从「读写条数」改成「token」以后，真正会出错的地方不是"能不能拒绝"，而是四件更细的事，
//   每一件都单独一条用例（零真实网络、假客户端/假账本）：
//     a. **拦的是写，不是读** —— 读是本插件存在的前提（刷视频/看评论）。预算用尽时 7 条写通道
//        必须一条请求都不发，而 video.info / comments.list 仍要能取到数据（get 计数 > 0）；
//        顺手断言"读不记账"（quota.json 根本不出现）——读不该占任何额度。
//     b. **采样差分口径** —— 宿主账本只有按天粒度，小时桶靠差分：100→300→350 时
//        hour.used 必须是 0→200→250（首次只建基线），day.used 是 100→300→350。
//        这一条同时钉住「首次采样不许把当天整笔记进当前小时」（重启后无故停写是用户明确否掉的语义）。
//     c. **fail-open** —— 账本缺失/坏 JSON 时不许把插件锁死：source='unavailable'、gateToken 放行、
//        写通道真的能发出去。预算配成 1/1 也照样放行，这样"放行"只可能来自 fail-open，测不出来。
//     d. **跨小时/跨天重置** —— 换小时：桶归零并**从当前总量重建基线**（整点后的第一笔不会带着
//        上一小时的账；代价是"上次采样→整点"那一小段不进任何桶，这点在用例里写成注释，
//        免得以后有人当 bug 改掉）；换天：小时桶清零、基线归位到当天合计。
//        两条都直接构造历史状态文件，不依赖真实时间流逝（否则用例只能在整点跑）。
//     e. **reason 透传** —— 拒绝原因必须原样是 token-budget-exhausted：api 层 7 条写通道和
//        工具层 7 个写工具都不许把它折成 quota-exceeded（折了模型就分不清"额度"和"间隔"）。
//        另外钉住结果 schema 的 reason 枚举里确实多了这一项（§11.3 要求同步）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  BVID, JCT, OWNER,
  cleanupTmp, localDayKey, localHourKey, readJson, repoUrl, sandboxEnv, tmpDir,
  writeBudgetState, writeUsageLedger,
} from './helpers/harness.mjs'

/** 计数用假客户端：只回答形状，不出网。 */
function countingClient () {
  return {
    getCalls: 0,
    postCalls: 0,
    rawCalls: 0,
    async get (requestPath) {
      this.getCalls += 1
      if (requestPath === '/x/web-interface/view') {
        return { code: 0, data: { bvid: BVID, aid: 123, title: '假标题', pages: [{ cid: 456, page: 1, part: 'P1', duration: 1 }] } }
      }
      if (requestPath === '/x/v3/fav/folder/created/list-all') return { code: 0, data: { list: [{ id: 7, title: '默认收藏夹', media_count: 1 }] } }
      if (requestPath === '/x/v2/reply') return { code: 0, data: { page: { count: 1 }, replies: [{ rpid: 1, member: { mid: 2, uname: '路人' }, content: { message: '主楼' }, like: 1, rcount: 0, ctime: 1700000000 }] } }
      if (requestPath === '/x/polymer/web-dynamic/v1/detail') return { code: 0, data: { item: { id_str: '555', modules: { module_dynamic: { desc: { text: '旧正文' } } } } } }
      return { code: 0, data: { item: { id_str: '555' }, items: [], list: [] } }
    },
    async post () { this.postCalls += 1; return { code: 0, data: { rpid: 999, rpid_str: '999' } } },
    async raw () { this.rawCalls += 1; return { code: 0, data: { dyn_id_str: '555', msg_key: 'k' } } },
    async nav () { return { code: 0, data: { mid: 1000001, isLogin: true, uname: '测试号' } } },
    cred () { return { sessdata: 'S', bili_jct: JCT } },
    state () { return { banned: false, banMinutesLeft: 0, banWhy: null, cacheEntries: 0 } },
  }
}

function makeConfig (root, budget) {
  return { owner: OWNER, budget, risk: { writeGapSec: 120, dmGapSec: 0 }, paths: { stateDir: root } }
}

/** 7 条写通道在 api 层的调用（与 INTERFACE §8 一一对应）。 */
function writeChannels (mods, deps) {
  return [
    { name: 'comment.add', run: () => mods.comment.add(deps, { oid: '123', message: 'x' }) },
    { name: 'comment.reply', run: () => mods.comment.reply(deps, { oid: '123', root: '1', rpid: '2', message: 'x' }) },
    { name: 'dynamic.create', run: () => mods.dynamic.create(deps, { text: 'x' }) },
    { name: 'dynamic.edit', run: () => mods.dynamic.edit(deps, { dynId: '555', text: 'x' }) },
    { name: 'message.send', run: () => mods.message.send(deps, { text: 'x' }) },
    { name: 'favorite.deal', run: () => mods.favorite.deal(deps, { bvid: BVID }) },
    { name: 'relation.like', run: () => mods.relation.like(deps, { bvid: BVID, action: 'like' }) },
  ]
}

/** 7 个写工具在工具层的调用。 */
const WRITE_TOOL_CASES = [
  ['bili_comment', { bvid: BVID, message: 'x' }],
  ['bili_reply', { bvid: BVID, root: '1', rpid: '2', message: 'x' }],
  ['bili_dynamic', { text: 'x' }],
  ['bili_dynamic_edit', { dynId: '555', text: 'x' }],
  ['bili_favorite', { bvid: BVID }],
  ['bili_like', { bvid: BVID }],
  ['bili_dm', { text: 'x' }],
]

test('token 预算只拦写通道：7 条写通道被拒且一条请求不发，video.info / comments.list 仍能读到数据', async () => {
  const root = tmpDir('tb-write-only')
  const restoreEnv = sandboxEnv(root)
  try {
    const { gate, record, quotaFile } = await import(repoUrl('lib/core/quota.js'))
    const mods = {
      comment: await import(repoUrl('lib/api/comment.js')),
      dynamic: await import(repoUrl('lib/api/dynamic.js')),
      message: await import(repoUrl('lib/api/message.js')),
      favorite: await import(repoUrl('lib/api/favorite.js')),
      relation: await import(repoUrl('lib/api/relation.js')),
      video: await import(repoUrl('lib/api/video.js')),
    }
    // 当天已花 5000 > tokenDaily 500 → 写通道一定被拒；tokenHourly 也给小值，两档都满。
    writeUsageLedger(path.join(root, 'usage-ledger.json'), 5000)
    const config = makeConfig(root, { tokenHourly: 10, tokenDaily: 500 })
    const client = countingClient()
    const deps = { client, config, owner: OWNER, log: () => {}, quota: { gate, record } }

    for (const channel of writeChannels(mods, deps)) {
      client.postCalls = 0
      client.rawCalls = 0
      const result = await channel.run()
      assert.equal(result.ok, false, channel.name + ' 在 token 预算用尽时必须失败')
      assert.equal(result.reason, 'token-budget-exhausted', channel.name + ' 的 reason 必须是 token-budget-exhausted，实际 ' + result.reason)
      assert.equal(client.postCalls, 0, channel.name + ' 被拒后不许发 post，实际 ' + client.postCalls + ' 次')
      assert.equal(client.rawCalls, 0, channel.name + ' 被拒后不许发 raw，实际 ' + client.rawCalls + ' 次')
    }

    // 读通道不受影响：同一份 deps（同一个预算、同一份已耗尽的账本）照样要能读到数据
    const before = client.getCalls
    const info = await mods.video.info(deps, { bvid: BVID })
    assert.equal(info.ok, true, '读通道（video.info）不该被 token 预算拦，实际 ' + JSON.stringify(info).slice(0, 200))
    assert.equal(info.data.title, '假标题')
    const list = await mods.comment.list(deps, { oid: '123' })
    assert.equal(list.ok, true, '读通道（comments.list）不该被 token 预算拦，实际 ' + JSON.stringify(list).slice(0, 200))
    assert.equal(list.data.count, 1)
    assert.equal(client.getCalls, before + 2, '两次读必须真的打到 client.get（否则"读还能用"是空话）')

    // 读不记账：账本里一条都不许有（读不占额度）
    assert.equal(fs.existsSync(quotaFile(config)), false, '读通道绝不许记账（quota.json 不该被创建）')
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})

test('token 采样差分：账本当天合计 100→300→350 → hour.used=0→200→250，day.used=100→300→350', async () => {
  const root = tmpDir('tb-sample')
  const restoreEnv = sandboxEnv(root)
  try {
    const { tokenStatus } = await import(repoUrl('lib/core/tokenbudget.js'))
    const config = makeConfig(root, { tokenHourly: 10_000_000, tokenDaily: 80_000_000 })
    const ledgerFile = path.join(root, 'usage-ledger.json')

    writeUsageLedger(ledgerFile, 100)
    const first = tokenStatus(config)
    assert.equal(first.source, 'ledger', '账本可读时 source 必须是 ledger')
    assert.equal(first.day.used, 100, 'day.used 直接取账本当天合计，实际 ' + first.day.used)
    assert.equal(first.hour.used, 0, '首次采样只建基线：hour.used 必须从 0 起算（裁决后的口径），实际 ' + first.hour.used)

    writeUsageLedger(ledgerFile, 300)
    const second = tokenStatus(config)
    assert.equal(second.day.used, 300)
    assert.equal(second.hour.used, 200, '第二次采样：小时桶 = 300 - 100 = 200，实际 ' + second.hour.used)

    writeUsageLedger(ledgerFile, 350)
    const third = tokenStatus(config)
    assert.equal(third.day.used, 350)
    assert.equal(third.hour.used, 250, '第三次采样：小时桶 = 200 + (350 - 300) = 250，实际 ' + third.hour.used)

    // 采样状态文件的形状是契约的一部分（§11.1：{ hourKey, hourUsed, dayKey, dayBase, sampledTotal }）
    const state = readJson(path.join(root, 'token-budget.json'))
    assert.equal(state.hourKey, localHourKey())
    assert.equal(state.dayKey, localDayKey())
    assert.equal(state.hourUsed, 250)
    assert.equal(state.sampledTotal, 350, 'sampledTotal 必须跟着账本走，否则下一次差分就算错')
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})

test('fail-open：账本不存在 / 坏 JSON → source=unavailable、gateToken 放行、写通道不被拦', async () => {
  const root = tmpDir('tb-failopen')
  const restoreEnv = sandboxEnv(root)
  try {
    const { tokenStatus, gateToken } = await import(repoUrl('lib/core/tokenbudget.js'))
    const { gate, record } = await import(repoUrl('lib/core/quota.js'))
    const commentApi = await import(repoUrl('lib/api/comment.js'))
    const ledgerFile = path.join(root, 'usage-ledger.json')
    // 预算配成 1/1：只要账本能读，写通道必被拦 —— 于是"能发出去"只可能来自 fail-open。
    const config = makeConfig(root, { tokenHourly: 1, tokenDaily: 1 })

    // ① 账本不存在
    assert.equal(fs.existsSync(ledgerFile), false)
    const missing = tokenStatus(config)
    assert.equal(missing.source, 'unavailable', '账本缺失时 source 必须是 unavailable，实际 ' + missing.source)
    assert.equal(missing.hour.used, 0)
    assert.equal(missing.day.used, 0)
    assert.equal(gateToken(config).ok, true, '账本缺失时必须放行（fail-open），不许把插件锁死')

    // ② 账本是坏 JSON
    fs.writeFileSync(ledgerFile, '{ this is not json')
    const broken = tokenStatus(config)
    assert.equal(broken.source, 'unavailable', '坏 JSON 时 source 也必须是 unavailable，实际 ' + broken.source)
    assert.equal(gateToken(config).ok, true, '坏账本也必须放行（fail-open）')

    // ③ 写通道真的能发（一条请求、一次记账）
    const client = countingClient()
    const deps = { client, config, owner: OWNER, log: () => {}, quota: { gate, record } }
    const sent = await commentApi.add(deps, { oid: '123', message: 'fail-open 下应当能发出去' })
    assert.equal(sent.ok, true, 'fail-open 时写通道不该被拦，实际 ' + JSON.stringify(sent).slice(0, 200))
    assert.equal(client.postCalls, 1, '放行就该真的发出一次 post，实际 ' + client.postCalls + ' 次')
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})

test('跨小时 / 跨天重置：换小时归零并重建采样基线；换天小时桶清零且基线归位', async () => {
  const root = tmpDir('tb-rollover')
  const restoreEnv = sandboxEnv(root)
  try {
    const { tokenStatus } = await import(repoUrl('lib/core/tokenbudget.js'))
    const config = makeConfig(root, { tokenHourly: 10_000_000, tokenDaily: 80_000_000 })
    const ledgerFile = path.join(root, 'usage-ledger.json')
    const day = localDayKey()
    const staleHour = '1999-12-31T23'   // 一定不是当前小时

    // ① 换小时：桶归零，并且**从当前总量重新建基线**（sampledTotal ← 账本当天合计）。
    //    代价写清楚：上一次采样到整点之间花掉的那一段不会进任何桶 —— 这是有意为之，
    //    换来的是「整点后的第一笔不会带着上一小时的账」。若将来改成"保留基线、把差值搬进新桶"，
    //    这条断言会变红，那是需要重新裁决的语义变化，不是随手改的数字。
    writeBudgetState(root, { hourKey: staleHour, hourUsed: 900, dayKey: day, dayBase: 0, sampledTotal: 200 })
    writeUsageLedger(ledgerFile, 300)
    const nextHour = tokenStatus(config)
    assert.equal(nextHour.hour.used, 0, '换小时后小时桶必须归零（并重建基线），实际 ' + nextHour.hour.used)
    assert.equal(nextHour.day.used, 300, '天桶仍取账本当天合计，实际 ' + nextHour.day.used)
    const afterHour = readJson(path.join(root, 'token-budget.json'))
    assert.equal(afterHour.hourKey, localHourKey(), '状态文件的小时键必须被推进到当前小时')
    assert.equal(afterHour.sampledTotal, 300, '换小时要重建基线：sampledTotal 必须跟到当前总量，否则下一小时的第一笔会把上一小时的尾巴算进来')

    // ② 换天：小时桶清零、采样基线归位到当天合计 → 昨天/更早的花费不计入今天的小时桶
    writeBudgetState(root, { hourKey: staleHour, hourUsed: 900, dayKey: '2000-01-01', dayBase: 0, sampledTotal: 200 })
    writeUsageLedger(ledgerFile, 300)
    const nextDay = tokenStatus(config)
    assert.equal(nextDay.hour.used, 0, '跨天后小时桶必须清零（基线归位），实际 ' + nextDay.hour.used)
    assert.equal(nextDay.day.used, 300, '跨天后天桶取账本当天合计，实际 ' + nextDay.day.used)
    const afterDay = readJson(path.join(root, 'token-budget.json'))
    assert.equal(afterDay.dayKey, day, '状态文件的天键必须被推进到今天')
    assert.equal(afterDay.hourUsed, 0)
    assert.equal(afterDay.sampledTotal, 300)
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})

test('reason 透传：quota 返回 token-budget-exhausted → 7 条写通道与 7 个写工具都原样透出', async () => {
  const root = tmpDir('tb-reason')
  const restoreEnv = sandboxEnv(root)
  try {
    const mods = {
      comment: await import(repoUrl('lib/api/comment.js')),
      dynamic: await import(repoUrl('lib/api/dynamic.js')),
      message: await import(repoUrl('lib/api/message.js')),
      favorite: await import(repoUrl('lib/api/favorite.js')),
      relation: await import(repoUrl('lib/api/relation.js')),
    }
    const { buildTools } = await import(repoUrl('lib/tools/index.js'))
    const { createCapabilityRegistry } = await import(repoUrl('lib/core/capabilities.js'))
    const refused = {
      ok: false,
      reason: 'token-budget-exhausted',
      human: '本小时 token 用完（测试桩）',
      detail: { window: 'hour' },
    }
    const quota = { gate: () => refused, record: () => ({ ok: true }) }
    const client = countingClient()
    const config = makeConfig(root, { tokenHourly: 1000, tokenDaily: 8000 })
    const deps = {
      client, config, owner: OWNER, log: () => {}, quota,
      capabilities: createCapabilityRegistry({ log: () => {} }),
    }

    // api 层：7 条写通道
    for (const channel of writeChannels(mods, deps)) {
      client.postCalls = 0
      client.rawCalls = 0
      const result = await channel.run()
      assert.equal(result.ok, false, channel.name + ' 必须失败')
      assert.equal(result.reason, 'token-budget-exhausted', channel.name + ' 必须原样透出 token-budget-exhausted（不许折成 quota-exceeded），实际 ' + result.reason)
      assert.equal(client.postCalls + client.rawCalls, 0, channel.name + ' 被拒后不许发任何写请求')
    }

    // 工具层：7 个写工具
    const tools = buildTools(deps)
    for (const [name, args] of WRITE_TOOL_CASES) {
      const tool = tools.find((item) => item.name === name)
      assert.ok(tool !== undefined, '工具不存在：' + name)
      const result = await tool.execute(args, {})
      assert.equal(result.ok, false, name + ' 必须失败')
      assert.equal(result.reason, 'token-budget-exhausted', name + ' 的 reason 必须是 token-budget-exhausted，实际 ' + result.reason)
      const enumValues = tool.output.schema.properties.reason.enum
      assert.ok(enumValues.includes('token-budget-exhausted'), name + ' 的 result schema 的 reason 枚举必须包含 token-budget-exhausted（§11.3）')
      const rendered = tool.output.render(result)
      assert.match(rendered[0].text, /token-budget-exhausted/, name + ' 的渲染文本也要带上 reason，方便模型认')
    }
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})
