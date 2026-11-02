// tests/tools-e2e.test.mjs —— 用例 13：端到端（假客户端）跑一遍 15 个工具
//
// 为什么这样测：
//   单个模块的用例证明不了「装配起来还能用」。这条用例用一份**假客户端**（每个端点回一份形状
//   正确的假数据，一个字节都不出网）把 15 个工具各调一次，只断言两件事：
//     ① 结构完整：ok 是布尔；成功必带 data；失败必带枚举内的 reason + 非空 human
//        （INTERFACE §2 —— 模型就是按这两个字段分支的，缺一个它就只能瞎猜）；
//     ② 出口形状：output.render(result) 必须返回 [{ type:'text', text }]（返回裸字符串会让
//        工具结果在界面上变空白，INTERFACE §9 里专门写过这个坑）。
//   不在这里断言业务细节（那在各自的用例里）；需要真凭据/真账号的部分本来就不在这份假客户端里，
//   所以本用例**没有任何 skip** —— 凡是需要真实登录态的断言都不该写进端到端，那是「假绿」。
//   额外的价值在配额侧：真账本（core/quota.js）跑完之后应当正好多出 7 条记录（7 条写通道各 1 条），
//   少一条就是有通道没记账。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  BVID, JCT, OWNER, WBI_IMG,
  cleanupTmp, repoUrl, sandboxEnv, tmpDir,
} from './helpers/harness.mjs'

const REASONS = [
  'bad-argument', 'credential-missing', 'owner-only', 'quota-exceeded', 'capability-not-found',
  'bili-error', 'network', 'not-logged-in', 'risk-control',
]

function fakeClient (dynId = '555') {
  const answers = {
    '/x/web-interface/nav': { code: 0, data: { isLogin: true, mid: 1000001, uname: '测试号', wbi_img: WBI_IMG } },
    '/x/web-interface/view': { code: 0, data: { bvid: BVID, aid: 123, title: '假视频标题', tname: '生活', duration: 61, pic: 'https://example.invalid/c.jpg', pubdate: 1700000000, owner: { mid: 9, name: 'UP甲' }, stat: { view: 10, danmaku: 1, reply: 2, favorite: 3, coin: 4, like: 5, share: 6 }, pages: [{ cid: 456, page: 1, part: 'P1', duration: 61 }] } },
    '/x/web-interface/popular': { code: 0, data: { list: [{ bvid: BVID, aid: 123, title: '热门第一条', pic: 'https://example.invalid/p.jpg', duration: 61, pubdate: 1700000000, owner: { mid: 9, name: 'UP甲' }, stat: { view: 100 } }] } },
    '/x/web-interface/ranking/v2': { code: 0, data: { list: [{ bvid: BVID, aid: 123, title: '排行第一条', owner: { mid: 9, name: 'UP甲' }, stat: { view: 200 } }] } },
    '/x/web-interface/wbi/search/type': { code: 0, data: { result: [{ bvid: BVID, aid: 123, title: '<em class="keyword">测试</em>标题', author: 'UP甲', mid: 9, play: 300, pubdate: 1700000000, description: '简介' }] } },
    '/x/v2/reply': { code: 0, data: { page: { count: 1 }, replies: [{ rpid: 111, member: { mid: 9, uname: '路人' }, content: { message: '主楼评论' }, like: 3, rcount: 0, ctime: 1700000000 }] } },
    '/x/v2/reply/reply': { code: 0, data: { replies: [] } },
    '/x/v2/reply/add': { code: 0, data: { rpid: 999, rpid_str: '999' } },
    '/x/v2/reply/del': { code: 0, data: {} },
    '/x/polymer/web-dynamic/v1/feed/all': { code: 0, data: { items: [{ id_str: '555', type: 'DYNAMIC_TYPE_WORD', modules: { module_author: { mid: 9, name: 'UP甲', pub_time: '2026-01-01 00:00' }, module_dynamic: { desc: { text: '一条动态' } } } }], has_more: false } },
    '/x/polymer/web-dynamic/v1/detail': { code: 0, data: { item: { id_str: dynId, type: 'DYNAMIC_TYPE_WORD', modules: { module_dynamic: { desc: { text: '旧正文' } } } } } },
    '/x/v3/fav/folder/created/list-all': { code: 0, data: { list: [{ id: 777, title: '默认收藏夹', media_count: 3 }] } },
    '/x/msgfeed/reply': { code: 0, data: { items: [] } },
    // §24.1 的端点：这里故意返回**真客户端的形状**（{code,data}，没有 ok 字段）——
    // 端到端只验"工具能跑、返回结构完整"，工具与客户端之间的形状契约由 tests/at-me.test.mjs 专门钉。
    '/x/msgfeed/atme': { code: 0, data: { items: [{ id: '9001', business: 'reply', at_time: '2026-11-01', item: { user: { mid: 9, nickname: 'UP甲' }, source_content: { content: '@你 来看这条' }, uri: 'bilibili://video/222' } }] } },
    // ↓ 第二批（INTERFACE §13.1）
    '/x/space/wbi/acc/info': { code: 0, data: { mid: 9, name: 'UP甲', face: 'https://example.invalid/face.jpg', sign: '签名', level: 5, sex: '男' } },
    '/x/relation/stat': { code: 0, data: { follower: 12, following: 34 } },
    '/x/relation': { code: 0, data: { attribute: 6, be_relation: { attribute: 6 } } },
    '/x/player/wbi/playurl': { code: 0, data: { quality: 80, accept_quality: [80, 64], accept_description: ['1080P', '720P'], durl: [{ order: 1, length: 61, size: 1024, url: 'https://example.invalid/v.m4s' }], dash: null } },
  }
  const calls = []
  const client = {
    calls,
    async get (requestPath, query) {
      calls.push({ method: 'GET', path: requestPath, query })
      return answers[requestPath] || { code: 0, data: {} }
    },
    async post (requestPath, form) {
      calls.push({ method: 'POST', path: requestPath, form })
      if (requestPath === '/x/v3/fav/resource/deal') return { code: 0, data: {} }
      if (requestPath === '/x/web-interface/archive/like') return { code: 0, data: {} }
      if (requestPath === '/x/relation/modify') return { code: 0, data: {} }
      if (requestPath === '/x/v2/reply/top') return { code: 0, data: {} }
      return { code: 0, data: { rpid: 999, rpid_str: '999' } }
    },
    async raw (url, opts) {
      calls.push({ method: 'RAW', url, opts })
      if (url.includes('send_msg')) return { code: 0, data: { msg_key: 'fake-key' } }
      if (url.includes('fetch_session_msgs')) {
        return { code: 0, data: { has_more: false, messages: [{ sender_uid: String(OWNER.mid), content: JSON.stringify({ content: '主人说的话' }), timestamp: 1700000000, msg_seqno: '1', msg_type: 1 }] } }
      }
      if (url.includes('create/dyn')) return { code: 0, data: { dyn_id_str: dynId } }
      if (url.includes('edit/dyn')) return { code: 0, data: {} }
      if (url.includes('space/set_top') || url.includes('space/rm_top')) return { code: 0, data: {} }
      if (url.includes('draw/upload_bfs')) return { code: 0, data: { image_url: 'https://example.invalid/up.png', image_width: 8, image_height: 6 } }
      return { code: 0, data: {} }
    },
    async nav () { calls.push({ method: 'NAV' }); return answers['/x/web-interface/nav'] },
    cred () { return { sessdata: 'SESSDATA-FIXTURE', bili_jct: JCT, buvid3: 'BUV-FIXTURE' } },
    state () { return { banned: false, banMinutesLeft: 0, banWhy: null, cacheEntries: 0 } },
  }
  return client
}

test('端到端（假客户端）：25 个工具各跑一次，返回结构完整', async () => {
  const root = tmpDir('e2e')
  const restoreEnv = sandboxEnv(root)
  try {
    const { buildTools, TOOL_NAMES } = await import(repoUrl('lib/tools/index.js'))
    const { createCapabilityRegistry } = await import(repoUrl('lib/core/capabilities.js'))

    // bili_image_upload 要读一个真实存在的本地文件（它读盘后走 multipart），所以先造一张假图。
    const imageFile = path.join(root, 'pic.png')
    fs.writeFileSync(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const config = { owner: OWNER, risk: {}, paths: { stateDir: root } }
    const client = fakeClient()
    // 这里**不用真闸**：真闸的写间隔（writeGapSec 最低 30 秒）会让同一 type 的第二次写被拒
    // （comment.add 与 comment_top 都是 'comment'，dynamic.create 与 dynamic_top 都是 'dynamic'），
    // 那是正确行为，但不是"25 个工具能不能跑通"要验的东西。真闸的拦截行为由
    // quota-gate / token-budget / tools-batch2 三处用例覆盖，这里只验"每条写都真的过了闸与记账"。
    const gateCalls = []
    const recordCalls = []
    const quota = {
      gate: (passedConfig, options) => {
        gateCalls.push({ config: passedConfig, type: options && options.type, target: options && options.target })
        return { ok: true }
      },
      record: (passedConfig, options) => {
        recordCalls.push({ type: options && options.type, target: options && options.target })
        return { ok: true }
      },
      status: () => ({ hour: { used: 0, limit: 0 }, day: { used: 0, limit: 0 }, writeGapLeftSec: 0, dmGapLeftSec: 0, entries: 0 }),
    }
    const deps = {
      client,
      config,
      owner: OWNER,
      log: () => {},
      capabilities: createCapabilityRegistry({ log: () => {} }),
      quota,
    }
    const tools = buildTools(deps)

    assert.equal(TOOL_NAMES.length, 25, 'INTERFACE §13.1 + §24.1：一共 25 个工具')
    assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES, 'buildTools(deps) 的顺序与 TOOL_NAMES 必须一致')

    const inputs = {
      bili_watch: { source: 'popular', limit: 3 },
      bili_video_info: { bvid: BVID },
      bili_search: { keyword: '测试' },
      bili_comments: { bvid: BVID },
      bili_comment: { bvid: BVID, message: '端到端的一条评论' },
      bili_reply: { bvid: BVID, root: '111', rpid: '112', message: '端到端的一条回复' },
      bili_comment_del: { bvid: BVID, rpid: '999' },
      bili_dm: { text: '端到端给主人的一句话' },
      bili_dm_inbox: { limit: 5 },
      bili_dynamic: { text: '端到端的一条动态' },
      bili_dynamic_edit: { dynId: '555', text: '端到端改过的正文' },
      bili_favorite: { bvid: BVID, add: true },
      bili_fav_list: {},
      bili_like: { bvid: BVID, action: 'like' },
      bili_status: {},
      // ↓ 第二批（INTERFACE §13.1）
      bili_replies: { oid: '123', root: '111' },
      bili_comment_top: { oid: '123', rpid: '999', action: 'pin' },
      bili_dynamic_detail: { dynId: '555' },
      bili_dynamic_top: { dynId: '555', action: 'pin' },
      bili_image_upload: { path: imageFile },
      bili_playurl: { bvid: BVID },
      bili_user_info: { mid: '9' },
      bili_relation: { mid: '9' },
      bili_follow: { mid: '9', action: 'follow' },
      bili_at_me: { limit: 3 },
    }

    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string', tool.name + ' 必须有描述')
      assert.ok(tool.description.length > 20, tool.name + ' 的描述要说清能做什么/不能做什么')
      assert.equal(tool.parameters.type, 'object', tool.name + ' 的 parameters 必须是标准 JSON Schema（type:object）')
      assert.equal(typeof tool.parameters.properties, 'object', tool.name + ' 的 parameters.properties 必须是对象')
      assert.ok(tool.output && tool.output.schema, tool.name + ' 必须给 output.schema')
      assert.equal(tool.output.schema.type, 'object', tool.name + ' 的 output.schema 也必须是标准 JSON Schema')
      assert.equal(typeof tool.output.render, 'function', tool.name + ' 必须给 output.render')

      const args = inputs[tool.name]
      assert.ok(args !== undefined, '用例必须给 ' + tool.name + ' 准备一份入参')
      const result = await tool.execute(args, {})

      assert.equal(typeof result, 'object', tool.name + ' 必须返回对象')
      assert.notEqual(result, null)
      assert.equal(typeof result.ok, 'boolean', tool.name + ' 的 ok 必须是布尔，实际 ' + JSON.stringify(result).slice(0, 200))
      if (result.ok === true) {
        assert.ok(result.data !== undefined && result.data !== null, tool.name + ' 成功时必须带 data')
        assert.equal(result.reason, undefined, tool.name + ' 成功时不该带 reason')
      } else {
        assert.ok(REASONS.includes(result.reason), tool.name + ' 失败时 reason 必须在枚举内（INTERFACE §2），实际 ' + result.reason)
        assert.equal(typeof result.human, 'string', tool.name + ' 失败时必须带 human')
        assert.ok(result.human.length > 0, tool.name + ' 的 human 不能为空')
      }

      const rendered = tool.output.render(result)
      assert.ok(Array.isArray(rendered) && rendered.length === 1, tool.name + ' 的 render 必须返回长度 1 的数组，实际 ' + JSON.stringify(rendered).slice(0, 120))
      assert.equal(rendered[0].type, 'text', tool.name + ' 的 render 必须返回 text 内容块')
      assert.equal(typeof rendered[0].text, 'string', tool.name + ' 的 render 必须给出文本')
      assert.ok(rendered[0].text.length > 0, tool.name + ' 的渲染文本不能是空串')
      if (result.ok === false) assert.match(rendered[0].text, /^✗/, tool.name + ' 失败时的渲染文本要以 ✗ 开头，实际：' + rendered[0].text.slice(0, 80))
    }

    // 写通道（老的 7 条 + 第二批的 comment_top / dynamic_top / follow）必须真的过闸并记账：
    // 一共 10 次 gate、10 次 record，且 type/target 对得上（漏挂一条 = 一次少记）。
    assert.equal(gateCalls.length, 10, '25 个工具里应当正好 10 次写闸（bili_at_me 是只读，不该过闸），实际 ' + gateCalls.length + '：' + JSON.stringify(gateCalls.map((call) => call.type)))
    assert.equal(recordCalls.length, 10, '10 次写都必须记账，实际 ' + recordCalls.length)
    assert.deepEqual(
      recordCalls.map((call) => call.type).sort(),
      ['comment', 'comment', 'dm', 'dynamic', 'dynamic', 'dynamic_edit', 'favorite', 'like', 'relation', 'reply'],
      '写通道的 type 必须与 INTERFACE §13.2 一致（关注/取关是 relation），实际 ' + JSON.stringify(recordCalls.map((call) => call.type).sort())
    )
    assert.deepEqual(
      gateCalls.map((call) => call.type).sort(),
      recordCalls.map((call) => call.type).sort(),
      '过了闸的 type 集合与记了账的 type 集合必须完全一致（有 gate 没 record = 挂了闸却没记账）'
    )
    for (const call of gateCalls) assert.ok(call.target !== undefined && call.target !== '', '每次过闸都要带 target：' + JSON.stringify(call))
    // 假 quota 不该在磁盘上留账本（真账本行为由 quota-gate / shared-state 用例覆盖）
    assert.equal(fs.existsSync(path.join(root, 'quota.json')), false, '这里用的是假 quota，不该真的写 quota.json')
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})
