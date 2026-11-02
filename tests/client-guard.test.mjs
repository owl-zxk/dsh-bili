// tests/client-guard.test.mjs —— 用例 2/3/4：缓存、退避、节流（PROMPT §9）
//
// 为什么这样测：
//   §1.3 的三层保护（缓存 / 退避 / 节流）是「在不被 412 的前提下过日子」的全部依靠，
//   而它们的价值只能用**网络请求次数**来证明，不是靠返回值好看。所以：
//   · 缓存：假 transport 计数 —— 同一份 view 元信息第二次调用必须一次网络都不打；
//     而评论/动态流/收件箱属于「动态内容」，绝不能命中缓存（打到旧评论会让人以为没发出去）。
//   · 退避：一次 HTTP 412 之后，api-ban.json 必须落盘，随后**所有**请求都不许再打网络，
//     能吃到缓存就吃缓存，吃不到就明确说还要等几分钟（§6.2）。
//   · 节流：vendor/traffic.mjs 的 guard 支持注入 now/sleep，用它断言「两次请求间隔 ≥ minGapMs」，
//     并且真的不睡 —— 用例跑完的墙钟时间会证明这一点（否则整套测试会被人为拖慢 1.5s/次）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  BVID, JCT, OWNER, WBI_IMG,
  cleanupTmp, fetchSpy, installFetch, jsonResponse, readJson, repoUrl, sandboxEnv, tmpDir, writeCredFile,
} from './helpers/harness.mjs'

test('缓存：同一份 view 元信息只打一次网络；评论/动态流/收件箱绝不被缓存', async () => {
  const root = tmpDir('cache')
  const restoreEnv = sandboxEnv(root)
  writeCredFile(path.join(root, 'credentials.json'))

  const { fetch, calls } = fetchSpy((url) => {
    if (url.pathname === '/x/web-interface/nav') {
      return jsonResponse({ code: 0, data: { isLogin: true, mid: 1000001, uname: '测试号', wbi_img: WBI_IMG } })
    }
    if (url.pathname === '/x/web-interface/wbi/view') {
      return jsonResponse({ code: 0, data: { bvid: url.searchParams.get('bvid'), aid: 123, title: '缓存住的标题' } })
    }
    return jsonResponse({ code: 0, data: { path: url.pathname } })
  })
  const restoreFetch = installFetch(fetch)

  try {
    const { createClient } = await import(repoUrl('lib/core/client.js'))
    const config = { owner: OWNER, risk: {}, paths: { stateDir: root } }
    const client = createClient(() => config)

    // 第一次：nav（拿 wbi 密钥）+ view 各一次网络
    const firstView = await client.get('/x/web-interface/view', { bvid: BVID })
    assert.equal(firstView.code, 0, '第一次 view 必须成功（假 transport 已经给了 code=0）')
    assert.equal(firstView._cached, undefined, '第一次是真实网络，不该带 _cached')
    assert.equal(calls.length, 2, '第一次 view 应该是 2 次网络：nav + view，实际 ' + calls.length)

    // 第二次：同一份元信息，24h 内不该再打网络
    const secondView = await client.get('/x/web-interface/view', { bvid: BVID })
    assert.equal(calls.length, 2, '同一份 view 元信息第二次调用不许再打网络，实际累计 ' + calls.length + ' 次')
    assert.equal(secondView._cached, true, '第二次必须来自缓存（_cached=true）')
    assert.equal(secondView.data.title, '缓存住的标题')

    // 缓存是「按 key」的：换一条 bvid 必须真的去问一次（否则缓存会串号）
    await client.get('/x/web-interface/view', { bvid: 'BV1xx411c7mD' })
    assert.equal(calls.length, 3, '换 bvid 后应当多打一次网络（缓存键含查询参数），实际 ' + calls.length)

    // 动态内容绝不缓存：评论 / 动态流 / 收件箱，各调两次 = 各多打两次网络
    for (const [label, requestPath] of [
      ['评论', '/x/v2/reply'],
      ['动态流', '/x/polymer/web-dynamic/v1/feed/all'],
      ['收件箱', '/x/msgfeed/reply'],
    ]) {
      const before = calls.length
      await client.get(requestPath, { oid: '1' })
      await client.get(requestPath, { oid: '1' })
      assert.equal(calls.length, before + 2, label + '（' + requestPath + '）绝不能被缓存：两次调用必须是两次网络，实际新增 ' + (calls.length - before) + ' 次')
    }
  } finally {
    restoreFetch()
    restoreEnv()
  }
})

test('退避：撞 412 → 熔断落盘；熔断期间吃缓存或明确失败，不再打网络', async () => {
  const root = tmpDir('ban')
  const restoreEnv = sandboxEnv(root)
  writeCredFile(path.join(root, 'credentials.json'))

  let blocked = false
  const { fetch, calls } = fetchSpy((url) => {
    if (url.pathname === '/x/web-interface/nav') {
      return jsonResponse({ code: 0, data: { isLogin: true, mid: 1000001, wbi_img: WBI_IMG } })
    }
    if (url.pathname === '/x/web-interface/wbi/view') {
      return jsonResponse({ code: 0, data: { bvid: BVID, aid: 123, title: '熔断前缓存到的标题' } })
    }
    if (blocked) return new Response('blocked by risk control', { status: 412 })
    return jsonResponse({ code: 0, data: { path: url.pathname } })
  })
  const restoreFetch = installFetch(fetch)

  try {
    const { createClient } = await import(repoUrl('lib/core/client.js'))
    const config = { owner: OWNER, risk: {}, paths: { stateDir: root } }
    const client = createClient(() => config)

    // 熔断前先缓存一份 view 元信息（nav + view = 2 次网络）
    const cached = await client.get('/x/web-interface/view', { bvid: BVID })
    assert.equal(cached.code, 0)
    assert.equal(calls.length, 2)

    // 撞风控：HTTP 412 → 熔断 5 分钟起
    blocked = true
    const hit = await client.get('/x/web-interface/popular', { ps: 1, pn: 1 })
    assert.equal(hit.code, -412, 'HTTP 412 必须变成结构化的 code=-412，而不是抛异常')
    assert.match(String(hit.message), /熔断|风控/, '412 的 message 要说清是风控熔断：' + hit.message)
    assert.equal(calls.length, 3, '412 这一次是网络请求，累计应为 3')

    const banFile = path.join(root, 'api-ban.json')
    assert.ok(fs.existsSync(banFile), '熔断状态必须落盘到 <stateDir>/api-ban.json（读路径与写路径共用同一份）')
    const ban = readJson(banFile)
    assert.ok(Number(ban.until) > Date.now(), 'api-ban.json 的 until 必须在未来：' + JSON.stringify(ban))
    assert.ok(Number(ban.streak) >= 1, '熔断要记 streak，指数退避才有依据')

    // 熔断期间：能吃缓存就吃（view 是 cacheable 的）
    const stale = await client.get('/x/web-interface/view', { bvid: BVID })
    assert.equal(stale._stale, true, '熔断期间同一份 view 元信息应当返回缓存（_stale=true）')
    assert.equal(stale.data.title, '熔断前缓存到的标题')
    assert.equal(calls.length, 3, '熔断期间吃缓存时绝不许再打网络，实际累计 ' + calls.length)

    // 熔断期间：吃不到缓存就明确失败，并说清还要等几分钟
    const refused = await client.get('/x/web-interface/ranking/v2', { rid: 0, type: 'all' })
    assert.equal(refused.code, -412, '吃不到缓存的路径在熔断期间必须明确失败（code=-412）')
    assert.match(String(refused.message), /\d+\s*分钟/, '失败信息必须说清还要等几分钟：' + refused.message)
    assert.equal(calls.length, 3, '熔断期间吃不到缓存也绝不许打网络，实际累计 ' + calls.length)

    // 排障入口要能看到熔断
    const state = client.state()
    assert.equal(state.banned, true, 'client.state().banned 必须为 true')
    assert.ok(state.banMinutesLeft >= 1 && state.banMinutesLeft <= 30, '退避时长应在 5–30 分钟区间，实际 ' + state.banMinutesLeft)
  } finally {
    restoreFetch()
    restoreEnv()
  }
})

test('节流：连续两次请求间隔 ≥ minGapMs（注入假 now/sleep，不真睡）', async () => {
  const root = tmpDir('throttle')
  const { createTrafficGuard } = await import(repoUrl('lib/vendor/traffic.mjs'))

  let clock = 1_000_000
  const now = () => clock
  const sleep = async (ms) => { clock += Math.max(0, ms) }
  const dispatchedAt = []
  const transport = async () => {
    dispatchedAt.push(now())
    return jsonResponse({ code: 0, data: {} })
  }
  const settings = () => ({
    minGapMs: 1500, readHourly: 1000, readDaily: 10000,
    writeHourly: 100, writeDaily: 1000, writeGapSec: 30, dmGapSec: 0,
  })
  const guard = createTrafficGuard({ directory: root, transport, settings, now, sleep })
  const headers = { cookie: 'SESSDATA=' + JCT }

  const wallStarted = Date.now()
  await guard.fetch('https://api.bilibili.com/x/web-interface/popular?ps=1', { headers })
  await guard.fetch('https://api.bilibili.com/x/web-interface/popular?ps=2', { headers })
  const wallElapsed = Date.now() - wallStarted

  assert.equal(dispatchedAt.length, 2, '两次请求都要真的到达 transport')
  const gap = dispatchedAt[1] - dispatchedAt[0]
  assert.ok(gap >= 1500, '两次请求之间的间隔必须 ≥ minGapMs(1500ms)，实际 ' + gap + 'ms')
  assert.ok(wallElapsed < 1000, '必须用注入的假 sleep：真实墙钟只花了 ' + wallElapsed + 'ms（真睡会 ≥1500ms）')

  cleanupTmp()
})
