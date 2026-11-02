# 写一个 dsh-bili 扩展

> 内核（`@owl-zxk/dsh-bili`）负责认证、风控、token 预算；**扩展负责"说什么"**。
> 本文讲怎么从外部把东西挂进内核，不需要改内核一行代码。

## 0. 两个方向

| 方向 | 谁调谁 | 典型用途 | 一句代码 |
|---|---|---|---|
| **A：扩展提供能力，内核调用** | 内核 → 扩展 | 内容理解、判定、转换（`video.understand` 就是这么挂的） | `ctx.bili.registerCapability(def)` |
| **B：扩展调用内核接口** | 扩展 → 内核 | 直接用带认证/风控的 HTTP 客户端、读主人配置、自己挂写通道闸 | `ctx.bili.getClient()` |

两边可以同时用：示例插件 `examples/dsh-bili-echo` 注册了一个能力（方向 A），又调了一次 `listCapabilities()`（方向 B）。

## 1. 前置：怎么拿到 `ctx.bili`

内核在 `apply` 阶段执行 `ctx.provide('bili', service)`。所以扩展要写的是：

```js
export const name = 'my-bili-extension'

// 空数组：本插件不依赖内核以外的服务，也不会因为内核没装而加载失败。
export const inject = []

export function apply (ctx) {
  ctx.inject(['bili'], (scoped) => {
    const bili = scoped.bili
    // 从这里开始用 bili
  })
}
```

**不要**写成插件导出的 `inject: ['bili']`：

```js
export const inject = ['bili']   // ✗ 不要这样
```

区别不是风格。`inject: ['bili']` 是"本插件声明依赖 bili"，宿主会等内核就绪才 apply 你的插件 —— 于是**加载顺序取决于谁先装**，
出问题时日志里看不出因果（"为什么我的插件没加载？"）。`ctx.inject(['bili'], cb)` 是"bili 出现时跑这一段"，
你自己的 apply 立刻完成，顺序可预测。

`ctx.bili` 的服务面（只有这些，别的都是内部实现）：

```js
{
  registerCapability(def),      // 挂能力 → 返回一个卸载函数
  listCapabilities(),           // → [{ id, kind, description }]
  callCapability(id, payload),  // 调别人的能力（含内核自带的四项）
  onCapabilityAdded(cb),        // 能力变化回调 → 返回 off()
  getClient(),                  // HTTP 客户端（见 §3）
  getQuota(),                   // 写通道闸：gate / record / status（gate 先查 token 预算，再查写间隔）
  getOwner(),                   // → { mid, name }
}
```

内核自带四项能力，可以直接 `callCapability` 它们：`video.fetch`（视频元信息）、`comment.fetch`（评论主楼）、
`dynamic.feed`（动态流）、`account.status`（账号现状）。

## 2. 方向 A：扩展注册能力，内核调用

### 2.1 内核怎么调你的

工具 `bili_watch` 的 `deep=true` 走的就是这条路：它对前 `deepCount` 条视频逐个调
`capabilities.call('video.understand', { bvid, question })`，把你的返回值原样塞进结果里。
**内核不知道你在哪、也不 import 你**。

### 2.2 能力定义

```js
ctx.inject(['bili'], (scoped) => {
  scoped.bili.registerCapability({
    id: 'video.understand',                    // 必须 <域>.<动作>，小写
    kind: 'analyze',                           // analyze | fetch | transform | decide
    description: '理解视频内容并回答问题',        // 必填：工具描述会直接引用它
    schema: { type: 'object', properties: { bvid: { type: 'string' }, question: { type: 'string' } } }, // 可选
    async run (payload, ctx) {
      // payload 由调用方给：bili_watch 给的是 { bvid, question }
      // ctx = { id, kind, signal, list, has } —— 只读，能看清单、能拿取消信号，不能改注册表
      const result = await myVideoUnderstanding(payload.bvid, payload.question, { signal: ctx.signal })
      return { ok: true, data: result }
    },
  })
})
```

### 2.3 注册时的校验（违反就**装配期抛错**）

| 规则 | 不满足时 |
|---|---|
| `id` 匹配 `/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/` | 抛。"video.Understand"、"understand"、"video.under-stand" 都不合法 |
| `kind` ∈ `analyze` `fetch` `transform` `decide` | 抛 |
| `run` 是函数 | 抛 |
| `description` 非空 | 抛（工具描述要引用它，空等于让模型看不见这个能力） |
| `id` 没被注册过 | 抛。**重复 id 是装配期错误**：两个插件抢同一个 id 时，装的时候炸响比运行期悄悄覆盖好 |

装配期抛错是**故意的**：错误应该在装的那一刻暴露，而不是等到模型调用它。

`registerCapability` 返回一个卸载函数（`() => boolean`）。插件被卸载/热更新时调它，否则旧 fiber 的能力还留在表里。

### 2.4 返回什么

推荐和内核自身一致的信封：

```js
{ ok: true,  data: <任意 JSON> }
{ ok: false, reason: 'bili-error', human: '一句人话' }
```

`run` 返回 `undefined` 会被内核规范成 `{ ok: true, data: null }`；返回别的形状会**原样**传回调用方
（内核不猜你的语义）。`run` 里**抛异常**会被内核包成：

```js
{ ok: false, reason: 'bili-error', id: 'video.understand', human: '能力 video.understand 执行失败：<消息>（<错误码人话>）' }
```

也就是说抛异常不会让工具崩掉，但会丢掉你自己的结构化字段 —— 想精确表达"我这边缺依赖"就自己返回信封。

### 2.5 能力缺失时是什么形状（内核侧，不用你实现）

调一个没人注册的能力**绝不抛**：

```js
{
  ok: false,
  reason: 'capability-not-found',
  id: 'video.understand',
  available: ['video.fetch', 'comment.fetch', 'dynamic.feed', 'account.status'],
  human: '能力 video.understand 当前不可用（没有插件注册它）；现在可用的是：video.fetch、…',
}
```

`bili_watch` 把这个形状原样透给模型，并附带它已经拉到的视频列表 —— 模型据此可以"去掉 deep 只看标题"，
而不是以为工具坏了去重试。这也是为什么工具描述里必须写清"能力缺失时会发生什么"。

### 2.6 想让工具描述反映能力变化

能力是别的插件在 apply 之后才挂进来的。如果你的能力会改变某个工具的行为，用：

```js
const off = ctx.bili.onCapabilityAdded((list) => {
  // list = [{ id, kind, description }, ...]
})
```

内核自己也在用这条回调（记日志 / 重算描述文本）。回调抛错不会连累注册表。

## 3. 方向 B：扩展调用内核接口

### 3.1 HTTP 客户端

```js
ctx.inject(['bili'], async (scoped) => {
  const client = scoped.bili.getClient()

  // GET：自动带凭据 header，走 WBI 签名 / 缓存 / 退避 / 节流；返回 B站 原始对象
  const res = await client.get('/x/web-interface/view', { bvid: 'BV1GJ411x7h7' })
  // res = { code: 0, message: '0', data: {...} }；网络失败也给同形状 { code: -1, message }

  // POST：自动补 csrf=bili_jct，凭据不全直接不发
  await client.post('/x/v2/reply/add', { type: 1, oid: '123', message: '…' })

  // GET 也能按需 WBI 签名：wbi 系列接口（如 /x/space/wbi/acc/info）不签名会被当成风控拦掉
  await client.get('/x/space/wbi/acc/info', { mid: '389989266' }, { wbi: true })

  // 绝对 URL（非 api.bilibili.com 主机）：私信、头像、CDN
  await client.raw('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', { method: 'POST', form: { … } })

  // 只读状态
  client.state()   // → { banned, banMinutesLeft, banWhy, cacheEntries }
  client.cred()    // → 凭据对象。**别打印它**
  await client.nav()
})
```

`raw` 的请求体三选一：`{ json }`（JSON 正文）、`{ form }`（form-urlencoded）、`{ form: FormData }`（multipart，
不要自己设 content-type，否则 boundary 没了）。响应要二进制就加 `{ binary: true }`。

`get` 的第三个参数目前只认一件事：`{ wbi: true }` —— 对这份 query 做 WBI 签名，把 `w_rid`/`wts` 拼进查询串（key 与 POST 分支同一份 nav 10 分钟缓存，签多少次都只打一次网络）。**签名按需开启**：客户端不去猜哪个端点要签名，所以 wbi 系列接口（`/x/space/wbi/acc/info` 这类）必须自己传。取不到签名 key 时它**结构化失败且一个业务请求都不发**，绝不退回未签名请求 —— 否则你只会拿到一个 `-412` 去猜原因。

### 3.2 ⚠️ 客户端**不带任何闸门**

`getClient()` 只保证"认证 / 签名 / 缓存 / 退避 / 节流"，**既不查 token 预算，也不查写间隔**。内核自己的写通道之所以安全，
是因为 `api/*.js` 里每条都写了 `gate() → 发 → record()`。你要写就自己挂：

```js
const quota = ctx.bili.getQuota()
const verdict = quota.gate({ type: 'comment', target: 'oid:123' })   // 不需要传 config：内核用现读的配置
if (verdict.ok !== true) return verdict                                // 直接返回它的结构化失败，见下
// …发请求…
quota.record({ type: 'comment', target: 'oid:123', note: '来自 my-extension' })
```

`gate()` 查两件事，顺序是 **token 预算 → 写间隔**：

- 预算用尽 → `{ ok:false, reason:'token-budget-exhausted', human }`，`human` 里写着什么时候恢复（小时窗到下一个整点，
  天窗到次日零点），`detail` 里带 `window` / `hour` / `day` / `source`；
- 写间隔没到 → `{ ok:false, reason:'quota-exceeded', human }`。

**预算只约束写通道**：纯读的扩展（查询、抓元信息、看评论）不会被 token 预算挡，也不必调 `gate()`。

`type` 必须在 `WRITE_TYPES` 里（`comment` `reply` `dynamic` `dynamic_edit` `danmaku` `dm` `favorite` `like`），
否则 `gate()` 返回 `bad-argument`。**宁可什么都不写，也不要绕过闸** —— 那正是把账号推进风控、把 token 预算烧穿的最短路径。

另外：预算的数据源是宿主账本 `<DSH_HOME>/dsh-usage/usage-ledger.json`，读不到时 **fail-open**（不拦、状态标 `source:'unavailable'`）—— 所以"闸门放行"不等于"账本一定读到了"。

### 3.3 主人信息

```js
const owner = ctx.bili.getOwner()   // → { mid: 389989266, name: '往生堂七七代堂主' }（每次现读配置）
```

私信收件人**恒等于** `owner.mid`，没有参数能改 —— 想给主人发通知就老老实实走 `bili_dm` 这条工具，
或自己调 `POST /web_im/v1/web_im/send_msg` 且把收件人写成 `owner.mid`。

## 4. 可运行的示例：`examples/dsh-bili-echo`

```text
examples/dsh-bili-echo/
  package.json       @owl-zxk/dsh-bili-echo（示例，不装进 profile）
  cordis.patch.yml   - insert: [{ id: dsh-bili-echo, name: '@owl-zxk/dsh-bili-echo' }]
  lib/index.js       export name / export inject = [] / apply(ctx)
```

`apply` 做两件事，**零真实网络**：

1. 方向 A：`scoped.bili.registerCapability({ id:'echo.ping', kind:'transform', description:'回声：原样返回 payload', async run(payload){ return { ok:true, data: payload } } })`；
2. 方向 B：注册完立刻 `scoped.bili.listCapabilities()`，把**数量与 id 列表**写进日志（只查内存里的清单，不打任何端点）。

### 4.1 自测（不需要宿主，也不需要凭据）

```powershell
cd examples\dsh-bili-echo
node --check lib/index.js
```

再用一个假 ctx 直接 `import()` 它，验证"能 apply、能力真的进了注册表"：

```js
// 假 ctx：记录日志 + 立刻执行 inject 回调（宿主真实行为：bili 服务出现时才跑）
const logs = []
const registered = []
const fakeBili = {
  registerCapability: (def) => { registered.push(def); return () => true },
  listCapabilities: () => registered.map(({ id, kind, description }) => ({ id, kind, description })),
  getClient: () => ({}),
  getQuota: () => ({}),
  getOwner: () => ({ mid: '389989266', name: '示例' }),
}
const ctx = {
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m) },
  inject: (deps, cb) => cb({ bili: fakeBili }),
}
const mod = await import('./lib/index.js')
mod.apply(ctx)
console.log(mod.name, mod.inject)        // dsh-bili-echo []
console.log(registered.map((d) => d.id)) // [ 'echo.ping' ]
console.log(logs)                        // 三行日志
```

同样的形状也能验证内核一侧。注意 `ctx.bili` **不是注册表本身**，而是 `lib/index.js` 造的一层门面
（`registerCapability` → 注册表的 `register`），所以要套一层：

```js
const { createCapabilityRegistry } = await import('<仓库>/lib/core/capabilities.js')
const registry = createCapabilityRegistry()
const service = {
  registerCapability: (def) => registry.register(def),
  listCapabilities: () => registry.list(),
  callCapability: (id, payload) => registry.call(id, payload),
  onCapabilityAdded: (cb) => registry.onAdded(cb),
  getClient: () => ({}), getQuota: () => ({}), getOwner: () => ({ mid: '389989266', name: '示例' }),
}
mod.apply({ logger: console, inject: (deps, cb) => cb({ bili: service }) })
```

之后 `registry.call('echo.ping', { hi: 1 })` 返回 `{ ok: true, data: { hi: 1 } }`；`registry.call('video.understand')`
返回 `reason: 'capability-not-found'` 而**不是抛异常**。（把注册表直接当 `ctx.bili` 传进去会抛
`registerCapability is not a function` —— 少一层门面就不是同一个对象。）

### 4.2 为什么不装进 profile

示例的用途是证明契约成立，不是提供功能。装进 profile 就多一份会在真机上跑的东西，而真机上已经有同类实现
在跑写通道（README §2）。要看它被真实加载的样子时再加，装法与内核相同（`dsh plugin --profile desktop add "link:<路径>"`，引号别去）。

## 5. 和「她」（自主运营层）的关系

内核之上还有一层人格化的调用者「她」（见 README §8、ARCH §8）。写扩展时只需要记住七条：

1. **她只吃工具表**：`start(ctx, deps, { tools })` 拿到的是"工具名 → 工具定义"的表。你自己注册的**能力**（方向 A）
   不会直接变成她的动作 —— 但会被内核工具间接用到（例如 `bili_watch` 的 `deep=true` 用的就是 `video.understand`）。
2. **白名单是内核里的常量**（`core/actions.js` 的 `WHITELIST`，16 个）：扩展不能扩白名单，也别指望"注册个能力就进名单"。
   要让她能用某个动作，得在内核那边改白名单 + 通道映射 —— 那是内核的事，不是扩展的事。
3. **风控与预算对她同样生效**：她走的是同一批工具，所以你不需要为"被自动调用"另做任何限流；反过来说，
   你的能力如果自己打网络（不经过 `ctx.bili.getClient()`），就绕过了内核的节流与熔断 —— 那部分责任在你。
4. **她的六项指标（精力 / 心情 / 好奇 / 亲近 / 倦怠 / 自信）由内核规则算，不经过能力注册表**：你的能力只改变"她刷到什么"，
   改不了阈值（`energy<20` 关公开通道、`curiosity<25` 不探索这类判定写在 `core/metrics.js`）。**但你可以影响她刷到什么，
   从而间接改变指标**：内容不同 → 命不命中兴趣不同 → `interest-hit` / `repeat` 不同 → 六项数字就慢慢不一样了。
   这是唯一正当的影响路径；直接改 `state.json` 里的数字不在此列（下一次事件就会把它算回去，而且审计里看不出因果）。
5. **她的作息完全是她自己的**（`schedule.json` 的 `windows` / `weekendAllDay` / 间隔）：几个清醒时段、周末是否全天、多久醒一次，
   都在自主层的日程里，**不在能力注册表里**，扩展改不了 —— 你能改的是"她醒着的时候读到什么"。
6. **六项每日上限只约束她自己**：`caps` 写在她那条执行路径里（`actions.js` 的闸），扩展直接调内核工具或 `getClient()`
   不受它约束；但也别指望"绕开上限"就等于能随便写 —— token 预算与写间隔要你自己 `getQuota().gate()` 才会拦到你。
7. **热梗库刷新会去借宿主的 `web_search` 工具**（找不到就退到 `llm`，再不行标 `unavailable`）：这条链路是内核自己找宿主工具，
   扩展插不进去；你也可以理解成"她的世界里有网络搜索，但不是通过能力注册表拿到的"。

## 6. 五个常见错误

| 错误 | 症状 | 改法 |
|---|---|---|
| 写成 `export const inject = ['bili']` | 加载顺序不可控，内核缺失时你的插件干脆不加载 | 用 `ctx.inject(['bili'], scoped => …)` |
| 能力 id 用大写或单段（`Echo.Ping`、`echo`） | 装配期抛错 | `<域>.<动作>`，全小写，如 `echo.ping` |
| 在 `run` 里抛异常表达失败 | 内核包成 `bili-error`，你的结构化字段全丢，模型不知道该怎么办 | 自己返回 `{ ok:false, reason, human }` |
| 返回裸字符串 / 裸数组 | 能用，但调用方没法用 `ok` 分辨成功，也无法带 `reason` | 统一信封 `{ ok:true, data }` |
| 在装配期打网络（`apply` 里 await 一个端点） | 启动速度取决于 B站 响应；断网时插件像坏了 | 装配期只注册，网络操作留到 `run` / 工具执行时 |

## 7. 清单

- [ ] `export const name` 有，且和 `cordis.patch.yml` 的 `name` 指向的包名一致
- [ ] `cordis.patch.yml`：`- insert: [{ id: <短 id>, name: '@scope/包名' }]`，**`id` 全链唯一、`name` 写完整包名**
- [ ] 能力 id 合法、`kind` 四选一、`description` 是人能读的一句话
- [ ] `run` 不抛异常表达失败；返回值用 `{ ok, data }` / `{ ok:false, reason, human }`
- [ ] 有写操作的话：自己挂 `gate()` / `record()`
- [ ] 装配期零网络
- [ ] 日志里不出现凭据、cookie、响应正文
- [ ] `node --check lib/index.js` 通过
