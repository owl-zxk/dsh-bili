// tests/credentials-logs.test.mjs —— 用例 10/11/12：凭据、错误码人话、日志不含密（PROMPT §7）
//
// 为什么这样测：
//   §7 的三条规则都是「少一条就会把人困住」的那种：
//   ① 凭据粘贴出来的东西**常常带 BOM / 首尾空格 / 引号**。不 trim 的后果不是「报个错」，
//      而是拿 " SESSDATA" 这种带空格的值去发请求 —— B站 回 -101，人去查半天才发现是空格。
//      缺 bili_jct 时必须**说出缺的是它**（只读接口照样能用，所以「体检全绿但发不出去」最难查）。
//   ② 模型看到的必须是**人话**而不是裸错误码（-101/-111/12015），否则它只会原样重试。
//   ③ 日志里不能出现凭据 —— 这条只能靠「把本插件所有日志出口都接住，再在结果里搜」来证明：
//      所以用例 12 把 console.* 与 ctx.logger 全部改写成收集器，跑一遍装配 + 一批工具调用，
//      然后在**收集到的每一行**里搜 SESSDATA / bili_jct / cookie / 真实凭据值。
//      临时凭据文件全部落在 os.tmpdir() 下，绝不读用户真实的那一份。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  JCT, OWNER, WBI_IMG,
  cleanupTmp, fetchSpy, installFetch, jsonResponse, repoUrl, sandboxEnv, setEnv, tmpDir,
} from './helpers/harness.mjs'

const SECRET_SESSDATA = 'SESSDATA-SECRET-9f3a1c'
const SECRET_JCT = 'feedfacefeedfacefeedfacefeedface'
const SECRET_BUBVID = 'BUV-SECRET-77c1'

test('凭据：缺 bili_jct → 明确说缺；带 BOM / 首尾空格的凭据能正确解析', async () => {
  const root = tmpDir('cred')
  const restoreEnv = sandboxEnv(root)
  const credFile = path.join(root, 'credentials.json')
  try {
    const credentials = await import(repoUrl('lib/core/credentials.js'))

    // 带 BOM + 首尾空格 + 制表符：必须被 trim 干净
    fs.writeFileSync(credFile, '\uFEFF' + JSON.stringify({
      sessdata: '  ' + SECRET_SESSDATA + '  ',
      bili_jct: '\t' + SECRET_JCT + '\n',
      buvid3: ' ' + SECRET_BUBVID + ' ',
    }))
    const cred = credentials.loadCred()
    assert.equal(cred.sessdata, SECRET_SESSDATA, '带 BOM 的文件 + 首尾空格的 sessdata 必须解析成干净值')
    assert.equal(cred.bili_jct, SECRET_JCT, 'bili_jct 必须 trim（含制表符/换行）')
    assert.equal(cred.buvid3, SECRET_BUBVID, 'buvid3 必须 trim')

    const status = credentials.credStatus()
    assert.equal(status.present, true)
    assert.equal(status.hasJct, true)
    assert.equal(status.jctLooksValid, true, '32 位十六进制应当被认成合法形状')
    assert.deepEqual(status.missing, [], '三样都齐时 missing 必须为空，实际 ' + JSON.stringify(status.missing))
    assert.equal(JSON.stringify(status).includes(SECRET_JCT), false, 'credStatus() 绝不能回显 bili_jct 的值')

    // 缺 bili_jct：必须指出缺的是它，并且 human 里点名
    fs.writeFileSync(credFile, JSON.stringify({ sessdata: SECRET_SESSDATA, buvid3: SECRET_BUBVID }))
    const lacking = credentials.credStatus()
    assert.equal(lacking.hasJct, false, '缺 bili_jct 时 hasJct 必须是 false')
    assert.ok(lacking.missing.some((item) => item.startsWith('bili_jct')), 'missing 里必须点名 bili_jct，实际 ' + JSON.stringify(lacking.missing))
    const verdict = credentials.requireForWrite(credentials.loadCred())
    assert.equal(verdict.ok, false, '凭据不全时 requireForWrite 必须返回失败')
    assert.equal(verdict.reason, 'credential-missing')
    assert.match(verdict.human, /bili_jct/, '人话里必须说清缺的是 bili_jct：' + verdict.human)

    // 客户端在缺 jct 时一个请求都不发（省掉那次注定 -111 的往返），并给人话
    const { fetch, calls } = fetchSpy(() => jsonResponse({ code: 0, data: {} }))
    const restoreFetch = installFetch(fetch)
    try {
      const { createClient } = await import(repoUrl('lib/core/client.js'))
      const client = createClient(() => ({ owner: OWNER, risk: {}, paths: { stateDir: root } }))
      const refused = await client.post('/x/v2/reply/add', { oid: '1', message: '发不出去' })
      assert.equal(refused.code, -111, '缺 bili_jct 时 post 必须回 -111（与 B站 同形状），实际 ' + JSON.stringify(refused))
      assert.match(String(refused.message), /bili_jct/, 'message 必须说清缺 bili_jct：' + refused.message)
      assert.equal(calls.length, 0, '缺凭据时绝不许打网络，实际 ' + calls.length + ' 次')
    } finally {
      restoreFetch()
    }

    // 文件不存在：明确说「没有凭据文件」+ 路径 + 去设置页粘贴
    const restoreMissing = setEnv({ DSH_BILI_CRED_PATH: path.join(root, 'no-such-cred.json') })
    try {
      assert.throws(
        () => credentials.loadCred(),
        (error) => /没有凭据文件/.test(error.message) && /设置页/.test(error.message) && error.message.includes('no-such-cred.json'),
        '凭据文件缺失时必须给出「没有凭据文件 + 路径 + 去设置页粘贴」的明确错误'
      )
    } finally {
      restoreMissing()
    }
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})

test('错误码翻译：-101 / -111 / 12015 → 对应人话（不是裸码）', async () => {
  const root = tmpDir('codes')
  const restoreEnv = sandboxEnv(root)
  try {
    const credentials = await import(repoUrl('lib/core/credentials.js'))
    const { explainCode } = credentials

    assert.match(explainCode(-101), /未登录/, '-101 必须翻译成「账号未登录 / cookie 失效」：' + explainCode(-101))
    assert.match(explainCode(-111), /CSRF/, '-111 必须翻译成「CSRF 校验失败（bili_jct 缺失或不同账号）」：' + explainCode(-111))
    assert.match(explainCode(12015), /验证码/, '12015 必须翻译成「需要验证码」：' + explainCode(12015))
    for (const code of [-101, -111, 12015]) {
      assert.ok(explainCode(code).includes('code=' + code), '人话里要带上原始码，方便人搜：' + explainCode(code))
    }
    assert.match(explainCode(99999), /未知返回码/, '未知码也要有明确说法，不能返回 undefined')

    // api 层同样要把码翻成人话（模型看到的 human 来自这里）
    const video = await import(repoUrl('lib/api/video.js'))
    const makeDeps = (code) => ({ client: { async get () { return { code, message: '原始 message' } } } })
    const loggedOut = await video.info(makeDeps(-101), { bvid: 'BV1GJ411x7h7' })
    assert.equal(loggedOut.ok, false)
    assert.match(loggedOut.human, /未登录/, '-101 经 api 层出来必须是人话，实际 ' + loggedOut.human)
    const csrf = await video.info(makeDeps(-111), { bvid: 'BV1GJ411x7h7' })
    assert.match(csrf.human, /CSRF/, '-111 经 api 层出来必须是人话，实际 ' + csrf.human)
    const captcha = await video.info(makeDeps(12015), { bvid: 'BV1GJ411x7h7' })
    assert.match(captcha.human, /验证码/, '12015 经 api 层出来必须是人话，实际 ' + captcha.human)
  } finally {
    restoreEnv()
    cleanupTmp()
  }
})

test('日志不含密：console / logger 的所有输出里搜不到 SESSDATA / bili_jct / cookie 值', async () => {
  const root = tmpDir('logs')
  const restoreEnv = sandboxEnv(root)
  const credFile = path.join(root, 'credentials.json')
  const captured = []
  const originals = {}
  const record = (...parts) => { captured.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')) }

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level]
    console[level] = record
  }
  // 真实的容器里 logger 是宿主给的；这里用同一个收集器当 ctx.logger，保证「两条出口都接住」。
  const logger = { info: record, warn: record, debug: record, error: record }

  try {
    fs.writeFileSync(credFile, JSON.stringify({ sessdata: SECRET_SESSDATA, bili_jct: SECRET_JCT, buvid3: SECRET_BUBVID }))
    const { fetch, calls } = fetchSpy((url) => {
      if (url.pathname === '/x/web-interface/nav') {
        return jsonResponse({ code: 0, data: { isLogin: true, mid: 1000001, uname: '测试号', wbi_img: WBI_IMG } })
      }
      if (url.pathname === '/x/web-interface/wbi/view') {
        return jsonResponse({ code: 0, data: { bvid: 'BV1GJ411x7h7', aid: 123, title: '假标题' } })
      }
      if (url.pathname === '/x/v3/fav/folder/created/list-all') {
        return jsonResponse({ code: 0, data: { list: [{ id: 7, title: '默认收藏夹', media_count: 1 }] } })
      }
      return jsonResponse({ code: 0, data: { items: [], replies: [], list: [], messages: [], dyn_id_str: '555', rpid_str: '999' } })
    })
    const restoreFetch = installFetch(fetch)

    try {
      const plugin = await import(repoUrl('lib/index.js'))
      const services = {}
      const registered = []
      const ctx = {
        tools: { register: (tool) => { registered.push(tool) } },
        logger,
        provide: (name, service) => { services[name] = service },
        inject: () => {},
      }
      plugin.apply(ctx, {})
      assert.equal(registered.length, 25, '装配后应当注册 25 个工具（INTERFACE §13.1 + §24.1），实际 ' + registered.length)
      assert.ok(services.bili !== undefined, 'ctx.bili 必须被 provide 出来')

      // 跑一批会被模型真正调用的工具（读 + 写 + 状态），让日志出口有机会说话
      const runTool = async (name, args) => {
        const tool = registered.find((item) => item.name === name)
        assert.ok(tool !== undefined, '工具不存在：' + name)
        return tool.execute(args, {})
      }
      await runTool('bili_status', {})
      await runTool('bili_video_info', { bvid: 'BV1GJ411x7h7' })
      await runTool('bili_comment', { bvid: 'BV1GJ411x7h7', message: '一条评论' })
      await runTool('bili_dm', { text: '给主人一句话' })
      await runTool('bili_fav_list', {})
      await runTool('bili_like', { bvid: 'BV1GJ411x7h7' })
      assert.ok(calls.length > 0, '这一轮应当真的打到假 transport（否则日志用例是空的）')
    } finally {
      restoreFetch()
    }

    assert.ok(captured.length > 0, '必须先接住至少一条日志，否则本用例是空跑')
    assert.ok(captured.some((line) => line.includes('dsh-bili')), '装配日志应当在收集到的输出里（证明收集器确实在工作）')

    const haystack = captured.join('\n')
    for (const needle of [SECRET_SESSDATA, SECRET_JCT, SECRET_BUBVID, 'SESSDATA', 'bili_jct']) {
      assert.equal(haystack.toLowerCase().includes(needle.toLowerCase()), false, '日志里出现了凭据相关内容「' + needle + '」：\n' + haystack.slice(0, 800))
    }
    assert.equal(/cookie/i.test(haystack), false, '日志里出现了 cookie 字样：\n' + haystack.slice(0, 800))

    // 请求日志（共享状态目录里的 api-requests.log）同样不许含密
    const requestLog = path.join(root, 'api-requests.log')
    if (fs.existsSync(requestLog)) {
      const text = fs.readFileSync(requestLog, 'utf8')
      for (const needle of [SECRET_SESSDATA, SECRET_JCT, SECRET_BUBVID, 'SESSDATA', 'bili_jct', 'cookie']) {
        assert.equal(text.toLowerCase().includes(needle.toLowerCase()), false, 'api-requests.log 里出现了「' + needle + '」')
      }
    }
  } finally {
    for (const level of Object.keys(originals)) console[level] = originals[level]
    restoreEnv()
    cleanupTmp()
  }
})
