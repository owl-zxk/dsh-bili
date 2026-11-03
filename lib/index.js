// 插件入口 —— **只装配，零业务逻辑**。
//
// 为什么这里一行业务逻辑都不许有：
//   入口是"加一项能力时唯一不用改的文件"。一旦在这里写管线，第二项能力就会复制一遍，
//   而所有事故也会集中在这一个文件里。所以它只按固定顺序做五件事：
//     配置 → 能力注册表（先注册内核自带的四项）→ 客户端/配额 → 暴露 ctx.bili → 注册工具 → 挂设置页路由
//
// 为什么这里一个宿主私有包（schemastery / dsh-tools / dsh-llm 那一族）的静态 import 都没有
// —— 宿主实测的坑，不是风格偏好：
//   宿主给插件的 ESM 解析插桩没有覆盖到 workspace 路径，写上之后日志里就是
//       failed to import: ERR_MODULE_NOT_FOUND: Cannot find package '<宿主包名>'
//   也就是说"能加载"的前提之一就是装配层零宿主静态依赖。
//   （因此本文件也不打印那个作用域前缀，免得静态扫描把它当成真的依赖。）
//   本文件因此只用 node: 内置模块 + 本包自己的文件（工具定义由 ./tools/index.js 提供）。
//
// 为什么把 client 建在能力注册之后（而不是顺手先建）：
//   能力的 run 闭包要用到 deps，而 deps 里装着 client —— 先注册、后建、闭包延迟取值，
//   顺序就与"装配期"解耦了。装配期任何一步都不该触发网络。
//
// 为什么 provide 要留一条 ctx.reflect.provide 的退路：
//   老版本 cordis 只暴露 ctx.reflect.provide（Service 基类内部走的也是这条）。
//   没有它，插件在旧宿主上会"加载成功但 ctx.bili 不存在"，症状比直接报错难查得多。
import { createCapabilityRegistry } from './core/capabilities.js'
import { createClient } from './core/client.js'
import { loadConfig, setPluginConfig } from './core/config.js'
import { credStatus } from './core/credentials.js'
import { WRITE_TYPES, gate, quotaStatus, record } from './core/quota.js'
// 这四份由并行的实现者提供（契约 INTERFACE §8 的签名）。装配层只做转接，不写业务。
import * as commentApi from './api/comment.js'
import * as dynamicApi from './api/dynamic.js'
import * as videoApi from './api/video.js'
import { buildTools } from './tools/index.js'

/** Cordis 插件名（也是 profile 里那一行的 id / cordis.patch.yml 的 id）。 */
export const name = 'dsh-bili'

/** 只声明 tools：webServer 是可选依赖，用 ctx.inject 现取，缺了不影响工具。 */
export const inject = ['tools']

/**
 * 日志：只有一处出口，且**永远只接字符串**。
 * 为什么不让调用方直接 ctx.logger.*：那样迟早有人把整个凭据对象 / B站响应丢进去。
 * @param {object} ctx
 */
function createLog (ctx) {
  const logger = ctx?.logger
  const emit = (level) => (message) => {
    try {
      const line = typeof message === 'string' ? message : String(message)
      if (logger !== null && typeof logger === 'object' && typeof logger[level] === 'function') logger[level](line)
      else if (logger !== null && typeof logger === 'object' && typeof logger.info === 'function') logger.info(line)
    } catch { /* 日志坏了不该影响插件 */ }
  }
  const log = emit('info')
  log.info = emit('info')
  log.warn = emit('warn')
  log.debug = emit('debug')
  log.error = emit('error')
  return log
}

/**
 * 配额门面：既接受契约的 gate(config, opts)，也接受 api 层更顺手的 gate(opts)。
 * 为什么不强求一种：契约把 config 摆在第一个参数，而 api/* 拿到 deps 时手边本来就有 config，
 * 两边各写一遍"config 从哪来"就是分叉的起点；这里用现读配置兜住第二种写法。
 */
function createQuota (readConfig) {
  // 判定"第一个参数是配置还是选项"：配置一定有 risk / paths / owner 三者之一，选项一定有 type / target。
  const isConfigLike = (value) => value !== null && typeof value === 'object' &&
    (value.risk !== undefined || value.paths !== undefined || value.owner !== undefined)
  const withLive = (fn) => (first, second) => {
    if (second !== undefined) return fn(first, second ?? {})   // 契约写法：fn(config, opts)
    if (isConfigLike(first)) return fn(first, {})              // 只给了 config：别把 config 当 opts 丢掉
    return fn(readConfig(), first ?? {})                      // 只给了 opts：用现读的配置
  }
  const status = withLive(quotaStatus)
  return {
    gate: withLive(gate),
    record: withLive(record),
    status,
    // 别名：bili_status 认 quota.status 或 quota.quotaStatus 任一，给上免得它以为"没有状态查询"
    quotaStatus: status,
    WRITE_TYPES,
  }
}

/**
 * 装配。
 * @param {object} ctx cordis 上下文（inject: ['tools'] 已保证 ctx.tools 可用）
 * @param {object} [rawConfig] profile 里这一行的插件配置（优先级低于配置文件，高于内置默认）
 */
export function apply (ctx, rawConfig) {
  if (ctx === null || typeof ctx !== 'object' || ctx.tools === null || typeof ctx.tools !== 'object' || typeof ctx.tools.register !== 'function') {
    // 宁可在这里炸响，也别静默装上一个没有工具的插件（那种插件看起来"装好了"，模型却什么都没有）
    throw new Error('dsh-bili: ctx.tools 不可用。inject 里必须有 tools')
  }

  const log = createLog(ctx)

  // ① 配置：插件配置进 config 层，之后一律用 readConfig() 现读（设置页改完立刻生效）
  setPluginConfig(rawConfig)
  const readConfig = () => loadConfig()

  // ② 能力注册表 + 内核自带的四项基础能力
  const registry = createCapabilityRegistry({ log })
  let deps
  const whenReady = () => {
    if (deps === undefined) throw new Error('内核还没装配完（能力被过早调用）')
    return deps
  }

  registry.register({
    id: 'video.fetch',
    kind: 'fetch',
    description: '按 bvid 或 aid 取视频元信息：标题、UP 主、时长、分 P、播放/点赞/收藏数',
    async run (payload) {
      return videoApi.info(whenReady(), payload ?? {})
    },
  })
  registry.register({
    id: 'comment.fetch',
    kind: 'fetch',
    description: '取一条视频/动态下的评论主楼，可选带楼中楼',
    async run (payload) {
      return commentApi.list(whenReady(), payload ?? {})
    },
  })
  registry.register({
    id: 'dynamic.feed',
    kind: 'fetch',
    description: '取关注/推荐的动态流',
    async run (payload) {
      return dynamicApi.feed(whenReady(), payload ?? {})
    },
  })
  registry.register({
    id: 'account.status',
    kind: 'fetch',
    description: '账号现状：登录态、风控熔断还要等几分钟、缓存条目数、配额余量、凭据齐不齐',
    async run () {
      const { client } = whenReady()
      const nav = await client.nav()
      const quota = quotaStatus(readConfig())
      const traffic = client.state()
      const credentials = credStatus()
      return {
        ok: true,
        data: {
          // 只挑"能给人看"的字段：nav.data 里的密钥/设备信息一概不回传
          signedIn: Number(nav?.code) === 0 && nav?.data?.isLogin === true,
          navCode: Number(nav?.code ?? -1),
          navMessage: typeof nav?.message === 'string' ? nav.message : '',
          credentials,
          traffic,
          quota,
        },
      }
    },
  })

  // ③ 客户端与配额（readConfig 传下去 = 每次现读，不缓存）
  const client = createClient(readConfig)
  const quota = createQuota(readConfig)

  /**
   * deps 是 api/* 与 tools/* 唯一看到的世界（INTERFACE §8）。
   * config / owner 用 getter：设置页改完立刻生效，而且不会有人缓存到一半旧的。
   */
  // ctx 也放进去：deepWatch 需要**直接调宿主的 video_understand 工具**（比能力注册表更直接）。
  // 注意 ctx.tools.get(name) 省略 scope 就是全局视图 —— 这是有意的：
  //   本插件要看的是"宿主上全局注册了哪些工具"，不是自己 scoped 的那几个。
  deps = { client, quota, capabilities: registry, log, ctx }
  Object.defineProperty(deps, 'config', { get: readConfig, enumerable: true })
  Object.defineProperty(deps, 'owner', { get: () => readConfig().owner, enumerable: true })

  // ④ 对外服务：别的插件这样用（不需要 import 本包，也不知道它装在哪）
  //      ctx.inject(['bili'], (scoped) => scoped.bili.registerCapability({ ... }))
  //    注意不要写成 inject: ['bili'] —— 那会让对方等本包就绪才 apply，顺序不可控。
  const service = {
    registerCapability: (def) => registry.register(def),
    listCapabilities: () => registry.list(),
    callCapability: (id, payload) => registry.call(id, payload),
    onCapabilityAdded: (cb) => registry.onAdded(cb),
    getClient: () => client,
    getQuota: () => quota,
    getOwner: () => readConfig().owner,
  }
  if (typeof ctx.provide === 'function') {
    ctx.provide('bili', service)
  } else if (ctx.reflect !== null && typeof ctx.reflect === 'object' && typeof ctx.reflect.provide === 'function') {
    // 老版本 cordis 只暴露 ctx.reflect.provide
    ctx.reflect.provide('bili', service)
  } else {
    throw new Error('dsh-bili: 这个宿主既没有 ctx.provide 也没有 ctx.reflect.provide，无法暴露 ctx.bili')
  }

  // ⑤ 工具：定义在 ./tools/index.js，这里逐个交给宿主（工具名/描述/JSON Schema 全在那边）
  const tools = buildTools(deps)
  if (!Array.isArray(tools)) throw new Error('dsh-bili: buildTools(deps) 必须返回工具数组')
  for (const tool of tools) ctx.tools.register(tool)
  log.info(`dsh-bili 已装配：${registry.list().length} 个能力、${tools.length} 个工具`)

  // ⑥ 设置页后端（**可选**：webServer 不在 inject 里，缺了只是没有界面，工具照常可用）
  //    必须挂在 scoped 上：cordis 卸载这个 fiber 时会连带释放路由，
  //    而宿主对重复的 (kind, path) 会直接 throw（热更新时旧 fiber 还没 dispose，新的就 apply）。
  //
  //    为什么把动态 import **提前到 apply 阶段发起**：
  //      设置页模块的加载（读盘 + 解析 + 它自己 import 一串 core）是整个挂载链路里唯一一段
  //      非确定性的耗时。提前发起之后，inject 回调里 await 到的已经是一个已解决的 promise，
  //      注册动作就紧贴着回调同步执行 —— 少一段"回调已跑、路由还没注册"的空窗。
  //      （排障时确认过：宿主**不会**因为"晚注册"而拒绝请求；会吃掉路由的是下面 warn 那件事。）
  const settingsModule = import('./settings-api.js').catch((error) => {
    log.warn('设置页模块加载失败（不影响工具）：' + String(error?.message ?? error))
    return null
  })
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], async (scoped) => {
      try {
        const mod = await settingsModule
        if (mod === null || mod === undefined) return
        if (typeof mod.mountSettingsRoutes !== 'function') {
          log.warn('settings-api.js 没有导出 mountSettingsRoutes，设置页未挂载（工具不受影响）')
          return
        }
        const registered = await mod.mountSettingsRoutes(scoped, { ctx, deps })
        // 三条路由的目标数量是设置页契约（status / settings / credential）。
        // 少了任何一条就要**喊出来**：宿主的重复注册检查（"duplicate exact route"）会让
        // 后注册的一方**被静默丢弃**，而 mountSettingsRoutes 只吞这一种错误 ——
        // 于是症状变成"路由看起来挂上了，请求却落到别人的 handler 上"（本机实测：401 空 body，
        // 来自宿主 authorization 的 requestRejection，因为同一路径被另一个插件先注册了）。
        // 不在这里说清楚，下一次还是要在 HTTP 状态码里猜半天。
        const expected = 3
        if (!Array.isArray(registered) || registered.length < expected) {
          const got = Array.isArray(registered) ? registered.join(' ') : String(registered)
          log.warn(
            `设置页只挂上 ${Array.isArray(registered) ? registered.length : 0}/${expected} 条路由（已挂：${got === '' ? '无' : got}）。` +
            '缺的那几条几乎总是**同一 exact 路径已被别的插件注册**（宿主的重复注册检查把我们的注册丢弃了），' +
            '此时请求会落到对方的 handler 上 —— 典型症状是返回 401/403 且响应体为空、没有 content-type。' +
            '排查办法：确认是否有另一个插件占用了同一个 URL 前缀（例如同时装着的老插件），或给设置页换一个不冲突的路径前缀。'
          )
        }
      } catch (error) {
        // 可选依赖失败只记一条日志：设置页坏了不该把工具一起拖下水
        log.warn('设置页路由未挂载（不影响工具）：' + String(error?.message ?? error))
      }
    })
  }

  // ⑦ 「她」的设置页后端（/dsh-bili/api/self/*，五条路由）—— 同样是**可选依赖**。
  //    为什么不和 ⑥ 合成一次挂载：那是两个文件、两套前缀、两拨人维护；
  //    任何一个坏了都不该连累另一个，所以各挂各的、各自只 warn。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], async (scoped) => {
      try {
        const mod = await import('./api/self-routes.js')
        const mount = mod.mountSelfRoutes ?? mod.mountRoutes
        if (typeof mount === 'function') await mount(scoped, { ctx, deps })
      } catch (error) {
        log.warn('「她」路由未挂载（不影响工具）：' + String(error?.message ?? error))
      }
    })
  }

  // ⑧ 自主层（"她"）—— **接在最后**，前面的装配顺序一个字没动（AUTONOMY-PROMPT §1 的硬约束）。
  //
  // 三条隔离：
  //   ① **动态 import**：自主层是本插件里唯一会碰模型 / 定时器 / 外部文本的东西。
  //      它自己的模块哪怕语法或依赖坏了，也不该让内核加载失败 —— 静态 import 做不到这一点。
  //   ② **llm 用"可选注入"拿，不去读 ctx.llm**（2026-11-01 真机修正）：
  //      本插件顶层 inject 只有 ['tools']，cordis 里**没有 inject 的服务在 ctx 上就是 undefined**。
  //      真机第一次醒来就是 llm-unavailable —— 宿主明明有 llm（dsh-video 就在用），我们却读不到。
  //      但也不能把 'llm' 加进顶层 inject：那会让整个插件等 llm 就绪才 apply，llm 一缺连 24 个工具
  //      都加载不了，违反"自主层不影响内核"。所以用**嵌套的可选注入**：llm 在就带着 scoped.llm 跑，
  //      不在就什么都不发生（工具照常）。
  //   ③ **只把工具表交给它**：它不 import api/*、不拼 B站 请求，所以内核的风控 / token 预算 /
  //      私信硬限制对它自动生效 —— 它是"另一个调用者"，不是特权用户。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolScope) => {
      const toolIndex = new Map(tools.map((tool) => [tool.name, tool]))
      ctx.inject(['llm'], (llmScope) => {
        import('./core/autonomy.js')
          .then((mod) => {
            const llm = llmScope?.llm ?? ctx.llm
            if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
              log.warn('自主层未启动（不影响工具）：宿主没有提供带 stream() 的 llm')
              return
            }
            if (typeof mod.start !== 'function') {
              log.warn('自主层未启动（不影响工具）：autonomy.js 没有导出 start')
              return
            }
            mod.start(toolScope, deps, { logger: log.warn ?? log, llm, tools: toolIndex })
          })
          .catch((error) => {
            // 可选依赖失败只记一条日志：自主层坏了不该把工具一起拖下水
            log.warn('自主层未启动（不影响工具）：' + String(error?.message ?? error))
          })
      })
    })
  }
}
