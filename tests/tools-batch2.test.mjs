// tests/tools-batch2.test.mjs —— INTERFACE §13：第二批工具（15 → 24）
//
// 为什么这样测：
//   第二批加的不是"再多几个只读工具"，而是三个**新的写通道**（评论置顶 / 动态置顶 / 关注取关），
//   以及一个必须带 WBI 签名的读端点（user.info）。这三类各有各的翻车方式，所以分开测：
//     a. 名字与顺序 —— 只断「长度是 24」等于没测：名单错位会让模型看到错误的说明书，
//        所以逐名对比 TOOL_NAMES（顺序也算契约的一部分）。
//     b. 新写通道过闸 —— 假闸拒绝时必须 zero post/raw；放行时断言 gate 收到的 type/target
//        与 record 收到的一致（type 错了，账本就会把"关注"记成"点赞"）。
//     c. bili_follow 表单 —— fid/act/re_src 是 B站 的口径（act=1 关注、2 取关，不是布尔）；
//        mid 非纯数字必须在校验层就拒掉、一个请求都不发。
//     d. user.info 必须显式带 wbi:true —— 不带就会被 B站 回风控码（看起来像没权限）；
//        而 /x/relation/stat 失败时**不许编 0**：省略字段 + 一句说明，模型才知道是"没读到"。
//     e. image_upload —— 路径不存在要在读盘那一步就 bad-argument（零请求）；
//        正常路径要把 multipart 交给 client.raw，并透出 img_src。
//     f. 四个只读工具 —— 除了透出关键字段，还要证明它们**一次都没碰写闸**（读不占额度）。
//   全部零真实网络：假客户端只回答形状，不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { BVID, JCT, OWNER, cleanupTmp, repoUrl, sandboxEnv, tmpDir } from './helpers/harness.mjs'

const PLAYURL = {
  quality: 80,
  accept_quality: [80, 64],
  accept_description: ['1080P', '720P'],
  durl: [{ order: 1, length: 61, size: 1024, url: 'https://example.invalid/part1.m4s' }],
  dash: null,
}

/**
 * 假客户端：按路径回答，并把它收到的每一次调用原样留档。
 * get 的第三个参数（opts）也要记 —— 「user.info 必须带 wbi:true」只能靠它证明。
 */
function makeClient ({ answers = {}, raw = null } = {}) {
  const table = {
    '/x/space/wbi/acc/info': { code: 0, data: { mid: 9, name: 'UP甲', face: 'https://example.invalid/face.jpg', sign: '签名', level: 5, sex: '男' } },
    '/x/relation/stat': { code: 0, data: { follower: 12, following: 34 } },
    '/x/relation': { code: 0, data: { attribute: 6, be_relation: { attribute: 6 } } },
    '/x/player/wbi/playurl': { code: 0, data: PLAYURL },
    '/x/v2/reply/reply': {
      code: 0,
      data: {
        root: { rpid: 111, member: { mid: 9, uname: '楼主' }, content: { message: '主楼' }, like: 2, rcount: 1, ctime: 1700000000 },
        replies: [{ rpid: 222, member: { mid: 10, uname: '路人' }, content: { message: '楼中楼' }, like: 1, rcount: 0, ctime: 1700000000 }],
      },
    },
    '/x/polymer/web-dynamic/v1/detail': { code: 0, data: { item: { id_str: '555', type: 'DYNAMIC_TYPE_WORD', modules: { module_dynamic: { desc: { text: '动态正文' } } } } } },
    '/x/web-interface/view': { code: 0, data: { bvid: BVID, aid: 123, pages: [{ cid: 456, page: 1, part: 'P1', duration: 61 }] } },
    ...answers,
  }
  const client = {
    getCalls: [],
    postCalls: [],
    rawCalls: [],
    async get (requestPath, query, opts) {
      this.getCalls.push({ path: requestPath, query, opts })
      return table[requestPath] ?? { code: 0, data: {} }
    },
    async post (requestPath, form) {
      this.postCalls.push({ path: requestPath, form })
      return { code: 0, data: {} }
    },
    async raw (url, opts) {
      this.rawCalls.push({ url, opts })
      if (typeof raw === 'function') return raw(url, opts)
      return { code: 0, data: {} }
    },
    async nav () { return { code: 0, data: { mid: 1000001, isLogin: true, uname: '测试号' } } },
    cred () { return { sessdata: 'S', bili_jct: JCT } },
    state () { return { banned: false, banMinutesLeft: 0, banWhy: null, cacheEntries: 0 } },
  }
  return client
}

function makeDeps (client, quota, extra = {}) {
  return {
    client,
    config: { owner: OWNER, risk: {}, paths: { stateDir: extra.stateDir ?? '.' } },
    owner: OWNER,
    log: () => {},
    quota,
    capabilities: extra.capabilities ?? null,
  }
}

const allowAll = () => ({ gate: () => ({ ok: true }), record: () => ({ ok: true }) })

test('工具名与顺序：25 个名字逐条等于 TOOL_NAMES，老的 15 个一个不少', async () => {
  const { buildTools, TOOL_NAMES } = await import(repoUrl('lib/tools/index.js'))
  const tools = buildTools(makeDeps(makeClient(), allowAll()))
  const names = tools.map((tool) => tool.name)

  assert.equal(TOOL_NAMES.length, 25, 'INTERFACE §13.1 + §24.1：一共 25 个工具')
  assert.deepEqual(names, TOOL_NAMES, 'buildTools(deps) 的工具名与顺序必须逐条等于 TOOL_NAMES')

  const BATCH2 = ['bili_replies', 'bili_comment_top', 'bili_dynamic_detail', 'bili_dynamic_top', 'bili_image_upload', 'bili_playurl', 'bili_user_info', 'bili_relation', 'bili_follow', 'bili_at_me']
  for (const name of BATCH2) assert.ok(names.includes(name), '第二批工具缺失：' + name)

  // 追加式扩展：老的 15 个必须还在（防止有人"替换"而不是"追加"）
  const OLD15 = ['bili_watch', 'bili_video_info', 'bili_search', 'bili_comments', 'bili_comment', 'bili_reply', 'bili_comment_del', 'bili_dm', 'bili_dm_inbox', 'bili_dynamic', 'bili_dynamic_edit', 'bili_favorite', 'bili_fav_list', 'bili_like', 'bili_status']
  for (const name of OLD15) assert.ok(names.includes(name), '第一批工具丢了：' + name)
})

test('三个新写通道过闸：假闸拒绝 → zero post/raw；放行 → gate(type/target) 与 record 一致', async () => {
  const comment = await import(repoUrl('lib/api/comment.js'))
  const dynamic = await import(repoUrl('lib/api/dynamic.js'))
  const relation = await import(repoUrl('lib/api/relation.js'))

  const channels = [
    { name: 'comment.top', type: 'comment', target: 'oid:123', run: (deps) => comment.top(deps, { oid: '123', rpid: '999', action: 'pin' }), expect: (client) => client.postCalls[0] },
    { name: 'dynamic.setTop', type: 'dynamic', target: 'dynamic:555', run: (deps) => dynamic.setTop(deps, { dynId: '555', action: 'pin' }), expect: (client) => client.rawCalls[0] },
    { name: 'relation.modify', type: 'relation', target: 'mid:9', run: (deps) => relation.modify(deps, { mid: '9', action: 'follow' }), expect: (client) => client.postCalls[0] },
  ]

  for (const channel of channels) {
    // ① 闸门拒绝：一条写请求都不许发
    const refusedClient = makeClient()
    const refused = await channel.run(makeDeps(refusedClient, {
      gate: () => ({ ok: false, reason: 'quota-exceeded', human: '额度用完（测试桩）', detail: { window: 'gap' } }),
      record: () => { throw new Error(channel.name + ' 被拒时绝不许记账') },
    }))
    assert.equal(refused.ok, false, channel.name + ' 在闸门拒绝时必须失败')
    assert.equal(refused.reason, 'quota-exceeded', channel.name + ' 的 reason 必须是 quota-exceeded')
    assert.equal(refusedClient.postCalls.length + refusedClient.rawCalls.length, 0, channel.name + ' 被拒后不许发任何写请求')

    // ② 闸门放行：type/target 必须传对，且发成功才记账
    const client = makeClient()
    const gates = []
    const records = []
    const allowed = await channel.run(makeDeps(client, {
      gate: (passedConfig, options) => { gates.push({ config: passedConfig, ...options }); return { ok: true } },
      record: (passedConfig, options) => { records.push({ ...options }); return { ok: true } },
    }))
    assert.equal(allowed.ok, true, channel.name + ' 放行后应当成功，实际 ' + JSON.stringify(allowed).slice(0, 200))
    assert.equal(gates.length, 1, channel.name + ' 必须正好过一次闸，实际 ' + gates.length)
    assert.equal(gates[0].type, channel.type, channel.name + ' 过闸的 type 必须是 ' + channel.type + '，实际 ' + gates[0].type)
    assert.equal(gates[0].target, channel.target, channel.name + ' 过闸的 target 必须是 ' + channel.target + '，实际 ' + gates[0].target)
    assert.equal(records.length, 1, channel.name + ' 发成功必须记一笔账')
    assert.equal(records[0].type, channel.type, channel.name + ' 记账 type 必须与过闸一致')
    assert.equal(records[0].target, channel.target, channel.name + ' 记账 target 必须与过闸一致')
    assert.ok(channel.expect(client) !== undefined, channel.name + ' 放行后必须真的发出一次写请求')
  }
})

test('bili_follow 表单：fid/act=1|2/re_src=11；mid 非纯数字 → bad-argument 且零请求', async () => {
  const relation = await import(repoUrl('lib/api/relation.js'))
  const { buildTools } = await import(repoUrl('lib/tools/index.js'))

  // ① 关注
  const followClient = makeClient()
  const follow = await relation.modify(makeDeps(followClient, allowAll()), { mid: '9', action: 'follow' })
  assert.equal(follow.ok, true, '关注应当成功，实际 ' + JSON.stringify(follow).slice(0, 200))
  assert.equal(followClient.postCalls.length, 1, '关注应当发一次 post')
  assert.equal(followClient.postCalls[0].path, '/x/relation/modify', '端点必须是 /x/relation/modify')
  assert.deepEqual(followClient.postCalls[0].form, { fid: '9', act: 1, re_src: 11 }, '关注表单必须是 fid=<mid> + act=1 + re_src=11，实际 ' + JSON.stringify(followClient.postCalls[0].form))

  // ② 取关（act=2，不是 0、不是布尔）
  const unfollowClient = makeClient()
  const unfollow = await relation.modify(makeDeps(unfollowClient, allowAll()), { mid: '9', action: 'unfollow' })
  assert.equal(unfollow.ok, true)
  assert.deepEqual(unfollowClient.postCalls[0].form, { fid: '9', act: 2, re_src: 11 }, '取关表单必须是 act=2，实际 ' + JSON.stringify(unfollowClient.postCalls[0].form))

  // ③ 工具层：默认 action=follow，也要发出 act=1
  const toolClient = makeClient()
  const tool = buildTools(makeDeps(toolClient, allowAll())).find((item) => item.name === 'bili_follow')
  const viaTool = await tool.execute({ mid: '9' }, {})
  assert.equal(viaTool.ok, true, 'bili_follow 默认动作应当成功')
  assert.deepEqual(toolClient.postCalls[0].form, { fid: '9', act: 1, re_src: 11 }, 'bili_follow 默认 follow 的表单不对')

  // ④ mid 非纯数字：校验层就拒，一个请求都不发
  const badClient = makeClient()
  const bad = await relation.modify(makeDeps(badClient, allowAll()), { mid: 'abc', action: 'follow' })
  assert.equal(bad.ok, false, 'mid 非纯数字必须被拒')
  assert.equal(bad.reason, 'bad-argument', 'mid 非纯数字的 reason 必须是 bad-argument，实际 ' + bad.reason)
  assert.equal(badClient.postCalls.length, 0, 'mid 非法时不许发 post')
  assert.equal(badClient.rawCalls.length, 0, 'mid 非法时不许发 raw')
})

test('bili_user_info：必须带 opts.wbi=true；relation/stat 失败时不编假 0', async () => {
  const user = await import(repoUrl('lib/api/user.js'))
  const { buildTools } = await import(repoUrl('lib/tools/index.js'))

  // ① 必须显式带 wbi:true（不带会被 B站 回风控码，看着像没权限）
  const client = makeClient()
  const info = await user.info(makeDeps(client, allowAll()), { mid: '9' })
  assert.equal(info.ok, true, '正常路径应当成功，实际 ' + JSON.stringify(info).slice(0, 200))
  const profileCall = client.getCalls.find((call) => call.path === '/x/space/wbi/acc/info')
  assert.ok(profileCall !== undefined, '必须打 /x/space/wbi/acc/info')
  assert.equal(profileCall.opts !== undefined && profileCall.opts.wbi, true, 'acc/info 必须带 opts.wbi=true，实际 ' + JSON.stringify(profileCall.opts))
  assert.equal(info.data.name, 'UP甲', '昵称要透出')
  assert.equal(info.data.level, 5, '等级要透出')
  assert.equal(info.data.fans, 12, 'relation/stat 成功时 fans 要透出')
  assert.equal(info.data.following, 34, 'relation/stat 成功时 following 要透出')

  // ② relation/stat 失败：不许补 0，字段整段省略 + 一句说明
  const failing = makeClient({ answers: { '/x/relation/stat': { code: -404, message: 'no such user' } } })
  const partial = await user.info(makeDeps(failing, allowAll()), { mid: '9' })
  assert.equal(partial.ok, true, '主信息拿到了就该成功（粉丝数只是附加信息）')
  assert.equal('fans' in partial.data, false, '粉丝数没取到时不许出现 fans 字段（编 0 会让模型当真），实际 ' + JSON.stringify(partial.data))
  assert.equal('following' in partial.data, false, '关注数没取到时不许出现 following 字段')
  assert.match(String(partial.data.statNote), /不是 0|没读到/, '必须写一句"不是 0，是没读到"：' + partial.data.statNote)

  // ③ 工具层也要带 wbi（bili_user_info 不能把 opts 丢掉）
  const toolClient = makeClient()
  const tool = buildTools(makeDeps(toolClient, allowAll())).find((item) => item.name === 'bili_user_info')
  const viaTool = await tool.execute({ mid: '9' }, {})
  assert.equal(viaTool.ok, true)
  const toolProfile = toolClient.getCalls.find((call) => call.path === '/x/space/wbi/acc/info')
  assert.equal(toolProfile.opts !== undefined && toolProfile.opts.wbi, true, 'bili_user_info 也必须带 wbi:true（工具层不能把 opts 丢掉）')
})

test('bili_image_upload：路径不存在 → bad-argument 且零请求；正常 → 返回 pic 的 img_src', async () => {
  const dynamic = await import(repoUrl('lib/api/dynamic.js'))
  const { buildTools } = await import(repoUrl('lib/tools/index.js'))
  const root = tmpDir('upload-2')
  const restoreEnv = sandboxEnv(root)
  try {
    const imageFile = path.join(root, 'pic.png')
    fs.writeFileSync(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    // ① 路径不存在：读盘那一步就拒，零请求
    const missingClient = makeClient()
    const missing = await dynamic.uploadImage(makeDeps(missingClient, allowAll(), { stateDir: root }), { path: path.join(root, 'nope.png') })
    assert.equal(missing.ok, false, '路径不存在必须失败')
    assert.equal(missing.reason, 'bad-argument', '路径不存在的 reason 必须是 bad-argument，实际 ' + missing.reason)
    assert.equal(missingClient.rawCalls.length, 0, '路径不存在时不许发 raw')
    assert.equal(missingClient.postCalls.length, 0, '路径不存在时不许发 post')

    // ② 正常：multipart 交给 client.raw，pic 要透出
    const uploadClient = makeClient({
      raw: () => ({ code: 0, data: { image_url: 'https://example.invalid/up.png', image_width: 8, image_height: 6 } }),
    })
    const uploaded = await dynamic.uploadImage(makeDeps(uploadClient, allowAll(), { stateDir: root }), { path: imageFile })
    assert.equal(uploaded.ok, true, '正常上传应当成功，实际 ' + JSON.stringify(uploaded).slice(0, 200))
    assert.equal(uploaded.data.pic.img_src, 'https://example.invalid/up.png', 'img_src 要透出')
    assert.equal(uploaded.data.pic.img_width, 8, 'img_width 要透出')
    assert.equal(uploaded.data.pic.img_height, 6, 'img_height 要透出')
    assert.equal(uploadClient.rawCalls.length, 1, '上传应当正好一次 raw')
    assert.match(uploadClient.rawCalls[0].url, /draw\/upload_bfs/, '上传端点必须是 /x/dynamic/feed/draw/upload_bfs')
    assert.equal(uploadClient.rawCalls[0].opts.method, 'POST', '上传必须用 POST')
    assert.ok(uploadClient.rawCalls[0].opts.form instanceof FormData, '上传体必须是 multipart（FormData），否则 boundary 没了会被回参数错误')

    // ③ 工具层：bili_image_upload 同样要把 pic 交回去
    const toolClient = makeClient({
      raw: () => ({ code: 0, data: { image_url: 'https://example.invalid/up2.png', image_width: 4, image_height: 3 } }),
    })
    const tool = buildTools(makeDeps(toolClient, allowAll(), { stateDir: root })).find((item) => item.name === 'bili_image_upload')
    const viaTool = await tool.execute({ path: imageFile }, {})
    assert.equal(viaTool.ok, true, 'bili_image_upload 应当成功')
    assert.equal(viaTool.data.pic.img_src, 'https://example.invalid/up2.png', '工具层也要把 img_src 交回去')
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})

test('四个只读工具：playurl / replies / dynamic_detail / relation 透出关键字段，且一次写闸都不碰', async () => {
  const client = makeClient()
  let gateCalls = 0
  const quota = {
    gate: () => { gateCalls += 1; return { ok: true } },
    record: () => { throw new Error('只读工具绝不该记账') },
  }
  const deps = makeDeps(client, quota)
  const { buildTools } = await import(repoUrl('lib/tools/index.js'))
  const tools = buildTools(deps)
  const call = async (name, args) => {
    const tool = tools.find((item) => item.name === name)
    assert.ok(tool !== undefined, '工具不存在：' + name)
    return tool.execute(args, {})
  }

  const playurl = await call('bili_playurl', { bvid: BVID })
  assert.equal(playurl.ok, true, 'bili_playurl 应当成功，实际 ' + JSON.stringify(playurl).slice(0, 200))
  assert.equal(playurl.data.quality, 80, '实际清晰度要透出')
  assert.equal(playurl.data.cid, 456, '不给 cid 时要先用 view 换到第一段的 cid')
  assert.equal(playurl.data.urls[0].url, 'https://example.invalid/part1.m4s', '片段地址要透出')

  const replies = await call('bili_replies', { oid: '123', root: '111' })
  assert.equal(replies.ok, true, 'bili_replies 应当成功，实际 ' + JSON.stringify(replies).slice(0, 200))
  assert.equal(replies.data.count, 1, '楼中楼条数要透出')
  assert.equal(replies.data.items[0].rpid, '222', '楼中楼 rpid 要透出')
  assert.equal(replies.data.rootComment.rpid, '111', '楼层根评论要透出')

  const detail = await call('bili_dynamic_detail', { dynId: '555' })
  assert.equal(detail.ok, true, 'bili_dynamic_detail 应当成功')
  assert.equal(detail.data.item.dynId, '555', '动态 id 要透出')
  assert.equal(detail.data.item.text, '动态正文', '动态正文要透出')

  const relation = await call('bili_relation', { mid: '9' })
  assert.equal(relation.ok, true, 'bili_relation 应当成功')
  assert.equal(relation.data.attribute, 6, 'attribute 要透出')
  assert.equal(relation.data.mutual, true, 'attribute=6 必须算互关')
  assert.equal(relation.data.url, 'https://space.bilibili.com/9', '主页地址要透出')

  assert.equal(gateCalls, 0, '四个只读工具一次都不许过写闸（读不占额度），实际 ' + gateCalls + ' 次')
})

test('bili_dynamic_top：unpin 走 rm_top、pin 走 set_top，gate/record 始终 type=dynamic、target=dynamic:<id>', async () => {
  const dynamic = await import(repoUrl('lib/api/dynamic.js'))
  const { buildTools } = await import(repoUrl('lib/tools/index.js'))

  for (const [action, expectPath] of [['pin', '/x/dynamic/feed/space/set_top'], ['unpin', '/x/dynamic/feed/space/rm_top']]) {
    const client = makeClient()
    const gates = []
    const records = []
    const deps = makeDeps(client, {
      gate: (passedConfig, options) => { gates.push(options); return { ok: true } },
      record: (passedConfig, options) => { records.push(options); return { ok: true } },
    })
    const tool = buildTools(deps).find((item) => item.name === 'bili_dynamic_top')
    const result = await tool.execute({ dynId: '555', action }, {})

    assert.equal(result.ok, true, 'action=' + action + ' 应当成功，实际 ' + JSON.stringify(result).slice(0, 200))
    assert.equal(client.rawCalls.length, 1, 'action=' + action + ' 应当正好一次 raw')
    assert.ok(client.rawCalls[0].url.includes(expectPath), 'action=' + action + ' 必须命中 ' + expectPath + '，实际 ' + client.rawCalls[0].url)
    // 置顶动态的正文是 JSON（走 raw），不是表单：退化成 post 就说明端点被写错了
    assert.equal(client.postCalls.length, 0, 'action=' + action + ' 走 raw(JSON)，不该退化成 post 表单')
    assert.equal(gates.length, 1, 'action=' + action + ' 必须正好过一次闸')
    assert.equal(gates[0].type, 'dynamic', 'action=' + action + ' 的 gate type 必须是 dynamic，实际 ' + gates[0].type)
    assert.equal(gates[0].target, 'dynamic:555', 'action=' + action + ' 的 gate target 必须是 dynamic:555，实际 ' + gates[0].target)
    assert.equal(records.length, 1, 'action=' + action + ' 发成功必须记账')
    assert.equal(records[0].type, 'dynamic', 'action=' + action + ' 的记账 type 必须是 dynamic')
    assert.equal(records[0].target, 'dynamic:555', 'action=' + action + ' 的记账 target 必须是 dynamic:555')
    assert.equal(result.data.action, action, '结果里的 action 必须原样回动作（' + action + '）')
  }

  // api 层直接调用也验一次：防止"工具层替它做映射"掩盖了 api 层没认 action
  const apiClient = makeClient()
  const direct = await dynamic.setTop(makeDeps(apiClient, allowAll()), { dynId: '777', action: 'unpin' })
  assert.equal(direct.ok, true, 'api 层 unpin 应当成功')
  assert.ok(apiClient.rawCalls[0].url.includes('/x/dynamic/feed/space/rm_top'), 'api 层 unpin 也必须命中 rm_top，实际 ' + apiClient.rawCalls[0].url)
})

test('bili_comment_top：pin→action=1、unpin→action=0，gate/record 的 type 始终 comment', async () => {
  const { buildTools } = await import(repoUrl('lib/tools/index.js'))

  for (const [action, expected] of [['pin', 1], ['unpin', 0]]) {
    const client = makeClient()
    const gates = []
    const records = []
    const deps = makeDeps(client, {
      gate: (passedConfig, options) => { gates.push(options); return { ok: true } },
      record: (passedConfig, options) => { records.push(options); return { ok: true } },
    })
    const tool = buildTools(deps).find((item) => item.name === 'bili_comment_top')
    const result = await tool.execute({ oid: '123', rpid: '999', action }, {})

    assert.equal(result.ok, true, 'action=' + action + ' 应当成功，实际 ' + JSON.stringify(result).slice(0, 200))
    assert.equal(client.postCalls.length, 1, 'action=' + action + ' 应当正好一次 post')
    assert.equal(client.postCalls[0].path, '/x/v2/reply/top', '置顶评论的端点必须是 /x/v2/reply/top')
    // B站 口径：action 1 = 置顶，0 = 取消。传 true/false 或 'unpin' 字面量都会被回 -400。
    assert.equal(client.postCalls[0].form.action, expected, 'action=' + action + ' 必须映射成 action=' + expected + '，实际 ' + JSON.stringify(client.postCalls[0].form))
    assert.equal(gates.length, 1, 'action=' + action + ' 必须正好过一次闸')
    assert.equal(gates[0].type, 'comment', 'action=' + action + ' 的 gate type 必须是 comment，实际 ' + gates[0].type)
    assert.equal(gates[0].target, 'oid:123', 'action=' + action + ' 的 gate target 必须是 oid:123')
    assert.equal(records.length, 1, 'action=' + action + ' 发成功必须记账')
    assert.equal(records[0].type, 'comment', 'action=' + action + ' 的记账 type 必须是 comment')
  }
})

test('bili_image_upload 不碰写闸：gate/record 一被调用就抛，上传仍成功且只走 raw(POST)', async () => {
  const { buildTools } = await import(repoUrl('lib/tools/index.js'))
  const root = tmpDir('upload-3')
  const restoreEnv = sandboxEnv(root)
  try {
    const imageFile = path.join(root, 'pic.png')
    fs.writeFileSync(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    let gateCalls = 0
    let recordCalls = 0
    const client = makeClient({
      raw: () => ({ code: 0, data: { image_url: 'https://example.invalid/up3.png', image_width: 8, image_height: 6 } }),
    })
    const deps = makeDeps(client, {
      // 上传不产出公开内容 → 按契约它不该过写通道的 token 预算闸，也不占记账额度。
      gate: () => { gateCalls += 1; throw new Error('图片上传不该过写闸') },
      record: () => { recordCalls += 1; throw new Error('图片上传不该记账') },
    }, { stateDir: root })

    const tool = buildTools(deps).find((item) => item.name === 'bili_image_upload')
    const result = await tool.execute({ path: imageFile }, {})

    assert.equal(result.ok, true, '上传应当成功（写闸桩即使会抛也不该被碰到），实际 ' + JSON.stringify(result).slice(0, 200))
    assert.equal(result.data.pic.img_src, 'https://example.invalid/up3.png', 'img_src 要透出')
    assert.equal(gateCalls, 0, '图片上传绝不许调用 quota.gate，实际调用 ' + gateCalls + ' 次')
    assert.equal(recordCalls, 0, '图片上传绝不许调用 quota.record，实际调用 ' + recordCalls + ' 次')
    assert.equal(client.rawCalls.length, 1, '上传应当正好一次 raw')
    assert.equal(client.rawCalls[0].opts.method, 'POST', '上传必须用 POST')
    assert.equal(client.postCalls.length, 0, '上传必须走 raw(multipart)，不该退化成 post 表单（会丢 boundary）')
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})
