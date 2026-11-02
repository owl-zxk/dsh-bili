// tests/capabilities.test.mjs —— 用例 8/9：能力注册表与「能力缺失」（PROMPT §4.4）
//
// 为什么这样测：
//   §4 说内核「不需要知道扩展插件的存在」，这句话的可测形式是：注册表能把一个**完全陌生**
//   的能力挂进来、列出来、调通；而调用一个没人注册的能力时**绝不抛异常** —— 抛出去等于
//   让模型看到「工具崩了」，它会去重试同一个工具；返回 { ok:false, reason:'capability-not-found',
//   available:[…] } 才是可恢复的，模型能据此换条路。
//   用例 9 从模型视角测两处：① bili_watch(deep:true) 在 video.understand 未注册时返回结构化
//   错误（并带上 available 列表，不是静默降级成「只看标题」）；② 工具描述本身就能看出当前
//   不可用 —— 描述是模型唯一的说明书，描述骗人等于功能骗人。反向也测一次：注册之后，同一个
//   工具（同一批 deps）立刻就能深读，证明它真的走注册表，而不是写死了一条分支。
import test from 'node:test'
import assert from 'node:assert/strict'

import { BVID, OWNER, cleanupTmp, repoUrl, sandboxEnv, tmpDir } from './helpers/harness.mjs'

const root = tmpDir('cap')
const restoreEnv = sandboxEnv(root)

test('能力注册表：注册 → 列出 → 调用；未注册返回 capability-not-found 而不抛', async () => {
  try {
    const { createCapabilityRegistry } = await import(repoUrl('lib/core/capabilities.js'))
    const registry = createCapabilityRegistry({ log: () => {} })
    const added = []
    const off = registry.onAdded((list) => added.push(list.map((item) => item.id)))

    const dispose = registry.register({
      id: 'video.understand',
      kind: 'analyze',
      description: '理解视频内容并回答问题',
      async run (payload, ctx) {
        return { ok: true, data: { bvid: payload.bvid, via: ctx.id, sawSelf: ctx.has('video.understand') } }
      },
    })

    assert.deepEqual(registry.list(), [{ id: 'video.understand', kind: 'analyze', description: '理解视频内容并回答问题' }], 'list() 只暴露 id/kind/description')
    assert.equal(registry.has('video.understand'), true)
    assert.equal(added.length, 1, 'onAdded 必须在注册时被通知（工具描述靠它动态重算）')

    const called = await registry.call('video.understand', { bvid: BVID })
    assert.equal(called.ok, true, '已注册的能力必须能调到，实际 ' + JSON.stringify(called).slice(0, 200))
    assert.equal(called.data.bvid, BVID, 'payload 必须原样传给能力')
    assert.equal(called.data.via, 'video.understand', 'ctx 里要带上能力自己的 id')

    // 未注册：绝不抛，返回结构化错误 + 当前可用清单
    const missing = await registry.call('video.nothing_here', {})
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'capability-not-found')
    assert.deepEqual(missing.available, ['video.understand'], 'available 必须列出当前真正可用的能力 id，实际 ' + JSON.stringify(missing.available))
    assert.match(missing.human, /video\.nothing_here/, '人话里要说清缺的是哪个能力')
    await assert.doesNotReject(() => registry.call('nope.nope', {}), '调用未注册的能力绝不能抛异常')

    // 装配期错误要炸响：重复 id、坏 id、坏 kind、缺 run
    assert.throws(() => registry.register({ id: 'video.understand', kind: 'analyze', description: 'x', run: () => {} }), /重复/, '重复 id 必须抛（装配期错误）')
    assert.throws(() => registry.register({ id: 'BadId', kind: 'analyze', description: 'x', run: () => {} }), /id/, 'id 必须形如 <域>.<动作>')
    assert.throws(() => registry.register({ id: 'video.bad', kind: 'nonsense', description: 'x', run: () => {} }), /kind/, 'kind 必须在枚举里')
    assert.throws(() => registry.register({ id: 'video.bad', kind: 'fetch', description: 'x' }), /run/, '缺 run 必须抛')

    // 卸载之后又变回「不可用」，且 available 跟着变
    assert.equal(dispose(), true, 'register() 应当返回一个卸载函数')
    const afterUnregister = await registry.call('video.understand', {})
    assert.equal(afterUnregister.reason, 'capability-not-found')
    assert.deepEqual(afterUnregister.available, [])

    off()
    assert.equal(registry.unregister('video.understand'), false, '已经没了再 unregister 返回 false')
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})

test('能力缺失：bili_watch(deep) 未注册 video.understand → 结构化错误；工具描述能看出当前不可用', async () => {
  try {
    const { createCapabilityRegistry } = await import(repoUrl('lib/core/capabilities.js'))
    const { buildTools } = await import(repoUrl('lib/tools/index.js'))

    const registry = createCapabilityRegistry({ log: () => {} })
    const client = {
      async get (requestPath) {
        if (requestPath === '/x/web-interface/popular') {
          return {
            code: 0,
            data: {
              list: [
                { bvid: BVID, aid: 123, title: '第一条', owner: { mid: 9, name: 'UP甲' }, stat: { view: 10 } },
                { bvid: 'BV1xx411c7mD', aid: 124, title: '第二条', owner: { mid: 9, name: 'UP甲' }, stat: { view: 20 } },
              ],
            },
          }
        }
        return { code: 0, data: {} }
      },
      async post () { return { code: 0, data: {} } },
      async raw () { return { code: 0, data: {} } },
      async nav () { return { code: 0, data: { mid: 1000001, isLogin: true } } },
      cred () { return { sessdata: 'S', bili_jct: '0123456789abcdef0123456789abcdef' } },
      state () { return { banned: false, banMinutesLeft: 0, banWhy: null, cacheEntries: 0 } },
    }
    const config = { owner: OWNER, risk: {}, paths: { stateDir: root } }
    const deps = {
      client,
      config,
      owner: OWNER,
      log: () => {},
      capabilities: registry,
      quota: { gate: () => ({ ok: true }), record: () => ({ ok: true }) },
    }

    const watch = buildTools(deps).find((tool) => tool.name === 'bili_watch')
    assert.ok(watch !== undefined, 'bili_watch 工具必须存在')

    // ① 描述里能看出「这个能力现在不可用」
    assert.match(watch.description, /capability-not-found/, '描述必须以模型能认的 reason 名说明能力缺失（实际：' + watch.description.slice(0, 120) + '…）')
    assert.match(watch.description, /不可用|没有插件注册/, '描述必须写明「当前不可用」的原因')

    // ② 真的调用：结构化错误，而不是静默降级成「只看标题」
    const outcome = await watch.execute({ source: 'popular', limit: 2, deep: true, deepCount: 1, question: '这期讲什么' })
    assert.equal(outcome.ok, false, 'deep=true 且能力未注册时必须失败，实际 ' + JSON.stringify(outcome).slice(0, 200))
    assert.equal(outcome.reason, 'capability-not-found', 'reason 必须是 capability-not-found（模型据此换路）')
    assert.ok(outcome.detail !== undefined && outcome.detail !== null, '必须带 detail（可用清单在里面）')
    assert.equal(outcome.detail.id, 'video.understand', 'detail.id 要说清缺的是哪个能力')
    assert.ok(Array.isArray(outcome.detail.available), 'detail.available 必须是数组')
    assert.match(outcome.human, /video\.understand/, '人话里要写出能力 id')
    assert.match(outcome.human, /可用能力/, '人话里要列出当前可用的能力（这里为空也要说「一个都没有」）：' + outcome.human)

    // ③ 反向验证：注册之后，同一批 deps 的同一个工具立刻能深读（证明它真的走注册表）
    registry.register({
      id: 'video.understand',
      kind: 'analyze',
      description: '理解视频内容并回答问题',
      async run (payload) { return { ok: true, data: { bvid: payload.bvid, answer: '讲的是猫咪' } } },
    })
    const deep = await watch.execute({ source: 'popular', limit: 2, deep: true, deepCount: 1 })
    assert.equal(deep.ok, true, '注册能力之后深读必须成功，实际 ' + JSON.stringify(deep).slice(0, 300))
    assert.equal(deep.data.deep.length, 1, 'deepCount=1 → 只深读 1 条')
    assert.equal(deep.data.deep[0].result.data.answer, '讲的是猫咪', '深读结果要原样带回来')
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})
