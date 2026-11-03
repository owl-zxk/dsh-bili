# dsh-bili 架构

> 本文讲**为什么这样分层**。签名与字段的权威定义在 [INTERFACE.md](INTERFACE.md)，本文与它冲突时以它为准。

## 1. 一句话

内核只做两件事：**把"怎么安全地跟 B站 说话"封装成一条路径**（认证 / 签名 / 缓存 / 退避 / 节流 / token 预算），
**把"说什么"交给能力注册表**。所以加一项内容能力不需要改内核，加一项账号能力才需要。

## 2. 分层（真实文件）

```text
lib/index.js                    装配：配置 → 注册表 → 客户端 / token 预算 / 闸门 → provide('bili') → 25 个工具 → 设置页(可选)
  ├─ lib/core/config.js         配置：三层合并、原子写、stateDir 解析
  ├─ lib/core/{schedule,actions,brain,persona,memory,diary,audit,state,autonomy}.js
  │                             自主层：日程 / 六道闸 / 大脑 / 人设 / 记忆 / 日记 / 审计 / 状态 / 指标 / 入口
  ├─ lib/core/credentials.js    凭据：共享只读 + saveCookie 写回 + 错误码人话
  ├─ lib/core/client.js         HTTP：GET 转 vendor/apiGet，POST 走 vendor/guardedFetch 并自补 csrf/熔断
  ├─ lib/core/quota.js          写通道闸：gate（预检）/ record（记账）/ status，共享 quota.json
  ├─ lib/core/tokenbudget.js    token 预算：读宿主用量账本 + 采样差分，状态在 token-budget.json
  ├─ lib/core/capabilities.js   能力注册表
  ├─ lib/api/*.js               业务读写：七个文件，统一 (deps, args) 两参（user.js 只读但需 WBI 签名）
  └─ lib/tools/index.js         25 个工具：JSON Schema + execute + render
lib/api/self-routes.js          「她」的设置页后端（/dsh-bili/api/self/*）
lib/vendor/*.mjs                复制来的底层实现（WBI 签名 / 请求守卫 / 凭据 / 路径 / 运行时 / 抓取）
```

**依赖方向是单向的**：`tools → api → core → vendor`。`core/config.js` 是最底层（连 fs 工具都放在那里，因为
配额账本、凭据与 token 采样状态都要原子写，三处各抄一遍迟早有一处忘记 tmp + rename）。`api/*` 与 `tools/*` 互相不知道对方存在，
只通过 `deps` 说话。

## 3. 装配顺序（`lib/index.js` 的八步，顺序本身是设计）

1. **配置**：`setPluginConfig(rawConfig)` 之后一律 `loadConfig()` 现读。设置在文件里，宿主不会因为文件变了重载插件，
   所以只能每次现读 —— 否则"改了没效果"。
2. **能力注册表 + 内核自带的四项能力**（`video.fetch` / `comment.fetch` / `dynamic.feed` / `account.status`）。
   这四条的 `run` 是闭包，**延迟取 deps**，所以可以在 client 造出来之前注册。
3. **客户端与闸门**：`createClient(readConfig)` 传的是函数不是对象 —— 每次请求都现读配置，设置改完立刻生效。token 预算与配额闸都从同一份现读配置里取 `budget` / `risk`。
4. **`ctx.provide('bili', service)`**（老宿主退回 `ctx.reflect.provide`）：对外只暴露一个服务对象。
5. **注册 25 个工具**：`buildTools(deps)` 的结果原样交给 `ctx.tools.register`，不再包一层。
6. **内核设置页路由（可选）**：`ctx.inject(['webServer'], …)` 里动态 `import('./settings-api.js')`，前缀 `/dsh-bili/api/kernel/*`，失败只记一条 warn。
7. **「她」的设置页路由（可选）**：另一个 `ctx.inject(['webServer'], …)` 里动态 `import('./api/self-routes.js')`，前缀 `/dsh-bili/api/self/*`。
   **注意**：后端是两套路由（`kernel` / `self`），但**侧栏只注册一个 `settings.section`**（id `bili`、order 9、label「B站账号」），
   页内用标签页切换 `BiliSection` / `SelfSection` —— 两页 ≠ 两个入口。

   **为什么标签切换是"卸载重挂"而不是"隐藏 + 缓存"**：`tab === "account" ? h(BiliSection) : h(SelfSection)` 每次只渲染一个，
   切走即卸载、切回时子组件走自己的 `useEffect` **重新拉一遍数据**。代价是未保存的草稿会丢；换来的是界面上永远不会出现
   "看着是旧值、其实底下已经变了"的表单 —— 设置页的每一次显示都来自当次请求，而不是上一次的缓存。
   为什么不与第 6 步合并成一次挂载：两个文件、两套前缀、两拨人维护，任何一个坏了都不该连累另一个 —— 所以各挂各的、各自只 warn。
8. **自主层启动（可选，且必须最后）**：`import('./core/autonomy.js')` 成功后 `start(scoped, deps, { llm: ctx.llm, tools })`，
   拿不到 `ctx.llm` 就只记一条 warn 直接返回。见 §8。

前七步一个字都没为第 8 步改动：自主层是**增量**，不是内核的依赖。

装配期**一个网络请求都不打**。任何"要先探一次接口"的设计都会让插件启动速度取决于 B站 的响应时间。

## 4. 请求路径

### 4.1 GET：`client.get(path, query)` → `vendor/bili-api.mjs` 的 `apiGet`

```text
cacheKey（在改写路径之前算：/x/web-interface/view 与 /wbi/view?...&w_rid=... 必须命中同一条）
  → 熔断中？→ 能吃到静态缓存就吃，吃不到返回 { code:-412, message:'约 N 分钟后恢复' }
  → 缓存命中且未过期？→ 直接返回 { ...data, _cached:true }
  → 需要 WBI 签名的路径（/x/web-interface/view → /wbi/view，/x/player/playurl → /wbi/playurl）
      → 先取 nav 的 wbi_img，再 signWbi
  → 300ms 节流（串行队列，不是并发）
  → fetch
  → HTTP 412/429 → 指数退避熔断（5/10/20/30 分钟）→ 写 api-ban.json → 尝试旧缓存
  → 接口层风控码 -412/-352/-799/-509/-10403 → 同样熔断
  → 命中日志：一行 `时间 HIT|NET 路径`（不含 cookie、不含正文）
```

### 4.1b GET 也可按需签名：`client.get(path, query, { wbi: true })`

有些读接口属于 wbi 系列 —— 典型是 `/x/space/wbi/acc/info`（用户信息）：**不带 `w_rid`/`wts` 会被直接拦，
返回的是风控码而不是数据**，看起来像"没权限"，其实是"没签名"。所以签名是**按需开启**的：
`opts.wbi === true` 时对这份 query 做 WBI 签名并把 `w_rid`/`wts` 拼进查询串（GET 没有 body）。
key 走与 POST 分支**同一个** `wbiImages()`：同一份 nav 10 分钟缓存，签一次和签十次都只打一次网络。
不传 `opts.wbi` 就照旧不签 —— 客户端不去猜哪个端点要签名。

### 4.2 POST：`client.post(path, form)` → `vendor/traffic.mjs` 的 `guardedFetch`

写路径必须自己写，因为 `apiGet` 只发 GET 且不带 csrf。本包补三件事：

1. **凭据不全就不发**：缺 `sessdata`/`bili_jct` 直接返回 `{ code:-111, message:人话 }`，省掉那一次注定失败的往返。
   csrf 永远取凭据里的值（即使调用方手滑传了一个，也以凭据为准）。
2. **撞到 412/429 或风控码 → 写同一份 `api-ban.json`**（字段形状 `until/why/at/streak` 与读路径完全一致）。
   风控是账号级的：写路径撞了，读路径也得立刻退，否则会出现"评论还在发、视频却读不了"的分裂状态。
3. **300ms 地板间隔**：守卫的 `minGapMs` 已经更大，这一层只是防止有人把间隔配成 0 之后裸奔。

守卫本身负责：读/写预算、冷却、相同写操作的去重、412 之后的平台暂停。预算与间隔每次请求都从配置现问。

### 4.3 `client.raw(absoluteUrl, opts)`：非 api 主机

私信在 `api.vc.bilibili.com`，头像在 `a1.bilibili.com`。`raw` 接绝对 URL，不拼 base，但**节流、熔断、凭据 header 一样要过**
（否则写通道等于绕过风控）。三种请求体各有用处：

| 选项 | 发出的东西 | 用在哪 |
|---|---|---|
| `{ json: {...} }` | `application/json` 正文，自动补 csrf | `/x/dynamic/feed/create/dyn`、`edit/dyn` |
| `{ form: {...} }` | form-urlencoded，自动补 csrf | 私信 `send_msg` |
| `{ form: FormData }` | multipart，**不许自己设 content-type** | 传图 `upload_bfs`（自己设 boundary 就没了） |
| `{ binary: true }` | 响应按二进制返回 `{ ok, status, buffer }` | 下载素材 |

响应形状：**是 JSON 就原样返回 B站 那个 `{ code, message, data }`**，不是 JSON 才返回 `{ ok, status, buffer }`。
包一层 `{ ok, status, data }` 会让每个端点各判一次"里面到底是哪一层"，包错一次就是"发成功却报网络失败"。

## 5. `deps`：`api/*` 与 `tools/*` 唯一看到的世界

```js
deps = { client, quota, capabilities, log,
         get config() { … },   // getter：每次现读
         get owner()  { … } }  // getter：同上
```

`config` / `owner` 是 **getter** 而不是字段：一旦被某个闭包捕获成普通字段，设置页改完之后那次调用用的还是旧值。
owner 默认 `{ mid: 389989266, name: '往生堂七七代堂主' }`，可改，但代码里不假定它永远不变。

## 6. 结果信封与 reason 枚举

```js
{ ok: true,  data: <JSON> }
{ ok: false, reason: <枚举>, human: '给人看的一句话', code?: <B站返回码>, detail?: {...} }
```

`reason` 只取十个值：`bad-argument` `credential-missing` `owner-only` `quota-exceeded` `token-budget-exhausted`
`capability-not-found` `bili-error` `network` `not-logged-in` `risk-control`。

**"正常失败不抛异常"是硬约定**：模型看得到工具返回值，看不到异常栈。抛异常等于告诉模型"工具崩了，重试吧"，
而 `{ ok:false, reason:'risk-control', human:'被风控拦了，等 5 分钟' }` 等于告诉它"换条路 / 等一会儿"。
所以 `api/*` 层自己吞掉网络异常并翻译成信封，`tools/*` 再兜一层以防实现 bug —— 那一层的 `reason` 是 `bili-error`，
并明确写"这是实现问题，别原样重试"。

## 7. 三层约束（额度一层、平台安全带一层、记账一层）

| 层 | 状态文件 | 管什么 | 什么时候看 |
|---|---|---|---|
| token 预算（`core/tokenbudget.js`） | `token-budget.json` | **花掉多少 token**：`budget.tokenHourly` / `budget.tokenDaily`，口径 `input + output` | 发之前 `gate()` 的第一步，**只拦写通道** |
| 请求守卫（`vendor/traffic.mjs`） | `traffic-state.json` | 平台安全带：`minGapMs`、`writeGapSec`、`dmGapSec`、相同写操作去重、412 后暂停 | 每个请求发出时 |
| 内容账本（`lib/core/quota.js`） | `quota.json` | 发了**什么**：`{ at, type, target, note }` 的人可读流水 | 发成功之后 `record()` |

`quota.gate()` 的顺序是 **token 预算 → 写间隔**：任一不过就返回结构化失败，**不发请求也不记账**。
读通道完全不查 token 预算 —— 预算用尽时 `bili_status` 照样能回答"为什么发不出去"。

token 预算（`core/tokenbudget.js`）读宿主的用量账本 `<DSH_HOME>/dsh-usage/usage-ledger.json`（按天 / provider / model 记
`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` / `calls` / `cost`），只累加
`inputTokens + outputTokens`；日期键本地日优先、回落到 UTC 日。账本只有按天粒度，所以"今天已用"取当天合计，
"本小时已用"用**采样差分**：把两次采样之间当天合计的增量累加到当前小时桶。

`tokenStatus(config)` 回 `{ hour:{used,limit}, day:{used,limit}, source:'ledger'|'unavailable', sampledAt, file, stateFile }`。
三个采样规则是刻意的：**第一次采样只建基线**（不把当日整笔算进本小时）、**换小时重建基线**（上一小时的尾巴不搬过来）、
**跨天清零重算**。代价是"同一小时内进程重启"会把空档期的花费补记进本小时（最多一个采样间隔的量），而跨小时的空档
不进新桶但仍计入当天合计。预算是 `budget.tokenHourly` / `tokenDaily`，**必须 > 0 才生效**（写 0 回落默认）。

三条硬规矩：

- **只能更严**：预算通过 ≠ 守卫放行，调用方必须三层都过。
- **额度 fail-open，账本 fail-closed**：用量账本读不到 → 不拦，但状态标 `source:'unavailable'`（宿主没写账本不该把插件锁死）；而 `quota.json` 坏掉 → 状态未知 → 拒绝发送。
- **额度与安全带无关**：预算再宽也不放宽 `minGapMs` / `writeGapSec` / `dmGapSec` / 熔断 / 去重，预算用尽也不影响这几条继续拦。

## 8. 自主层「她」（内核之外的另一个调用者）

定位一句话：**她是内核的调用者，不是内核的一部分。** 内核不知道她存在，她也拿不到内核的私有通道。

### 8.1 三条隔离（为什么她能坏、内核不会坏）

| # | 隔离 | 实现 |
|---|---|---|
| ① | **动态 import** | `lib/index.js` 里 `import('./core/autonomy.js').then(...).catch(...)`。自主层是唯一会碰模型 / 定时器 / 外部文本的东西，它自己的模块哪怕语法坏了也**不该让内核加载失败** —— 静态 import 做不到 |
| ② | **`ctx.llm` 缺失就不启动** | `ctx.llm == null` → 记一条 warn 直接 return；**25 个工具照常** |
| ③ | **只把工具表交给它** | 交给它的只有 `Map<工具名, 工具定义>`（`new Map(tools.map(t => [t.name, t]))`）。它不 import `api/*`、不拼 B 站 请求、拿不到 `client` |

③ 是整件事的关键：因为动作只能走已注册工具，**内核的风控、token 预算、私信 owner-only 对她自动生效**，不需要为"人格"再写一遍规则。
反过来说，任何绕过工具表的"优化"（直接调 api、直接 fetch）都会一次性废掉这三层保护。

### 8.2 模块分工

```text
lib/core/autonomy.js   入口：start / stop / runOnce / wakeNow / snapshot；两条定时器（计划器 60s、事件 5min）
lib/core/schedule.js   日程：时段组 windows（1–6 段、可跨午夜）/ 周末全天 / 间隔 / 抖动 / 通道开关 / 每日上限 / 单飞锁 / 失败静默；inWindow·nextWindowStart·nextWakeAt
lib/core/actions.js    六道闸：白名单 → 通道开关 → owner-only → token 预算 → caps+每次醒来上限 → 内容指纹去重
lib/core/brain.js      大脑：ctx.llm.stream + 60s 软超时 + 严格 JSON 解析（解析失败重试 1 次）
lib/core/persona.js    人设：persona.md，每次现读；front-matter（name / ownerTitle）与正文分开写（只改头部两行）
lib/core/memes.js      热梗库：memes.json ≤40 条、≥30 天刷新、一天一次、来源三级如实标注、失败保留旧库标 stale
lib/core/memory.js     记忆：memory.jsonl，2000 行滚动
lib/core/diary.js      日记：diary/YYYY-MM-DD.md，只追加
lib/core/metrics.js    指标：六项 0–100、事件表、跨天恢复；effectiveAllows + behaviorHints（只收紧不放开）+ effectiveCap（null 不限 / 0 禁止 / 数字上限）
lib/core/audit.js      审计：audit.jsonl，正文截 80 字 + 键名脱敏
lib/core/state.js      state.json + 目录解析 + 原子写
lib/api/self-routes.js 设置页后端：8 条路由 /dsh-bili/api/self/{state,settings,persona,run-once,audit,profile,memes,meme-refresh}
```

数据落在 `<DSH_HOME>/dsh-bili-self/`：**与内核的 `~/.bili-ai/` 分开**。内核那份是账号级的共享状态（凭据 / 熔断 / 预算），
这一份是她自己的（人设 / 记忆 / 日记 / 日程 / 状态 / 审计）。混在一起会让"删掉她"变成"删掉账号数据"。

### 8.3 一次 tick 的顺序

```text
计划器心跳（60s）→ 该醒了？
  → assess()：disabled / outside-window / backoff / busy / silenced（各有独立 reason，不合并成一个 false）
     · 窗口 = `windows` 任一时段命中（1–6 段，可跨午夜 `start > end`）+ 周末全天（`weekendAllDay` 且本地周六/周日）
     · 窗口外 nextWakeAt 取"最近的未来起点"；周末 00:00 也算一个起点
  → 顺带：shouldRefresh() 为真就尝试一次热梗库刷新（一天最多一次，只在定时醒来时做）
  → 组装上下文：身份（front-matter）+ 人设正文 + 最近记忆 + 今日日记尾部 + 本月梗（按 seen 升序取 12 条）+ 工具清单
  → brain.decide()：llm.stream → 解析 JSON（mood / say / meme / actions[] / diary / memory[]）
  → actions.execute()：逐条过六道闸，写动作受「每次醒来 ≤ 2 条」约束
  → 必留痕（无条件）：日记一行（决策 diary → 决策 say → 兜底句）/ lastLine 非空 / memory(kind:"thought") /
     审计一行（tool:'wake'，args 带 trigger、energy、mood、meme、say）/ state.json 计数
```

**`nextWakeAt` 的语义**：窗口外 → 下一个窗口开始时刻；窗口内 → 现在 + 间隔 ×（1 ± jitter）；**只有 `enabled:false` 才 `null`**。
（`schedule.js` 顶部第 11 行那段"窗口外返回 null"的注释是**旧注释**，实现已在 2026-11-01 改掉，以函数体为准。）

**失败只降级**：四类 LLM 失败（`llm-unavailable` / `llm-route-missing` / `llm-stream-failed` / `brain-parse-failed`）都只让这一轮"不说话"，
原因记进 `state.json` 的 `lastLlmFailure` 与审计；连续 3 次失败 → 静默 2 小时（风控命中走 `silenceFor`，不计入这条连败计数）。

### 8.4 白名单的语义

`WHITELIST`（`core/actions.js`，**16 个**）约束的是**大脑能提议的动作**，不是"她能做的全部事"。
名单里的 `bili_playurl`（取播放直链，纯只读）不是陪衬：低好奇时它要能被 `low-curiosity` 跳过，
所以它必须先过白名单 —— 否则会先被判成 `whitelist`，那条规则就永远看不到自己的 reason。
事件插队那条路自己调 `bili_dm_inbox`（只读、`limit` 3）判断有没有新私信 —— 那是触发逻辑，不是对外动作。

`CHANNEL_OF` 是工具 → 通道的映射；`bili_comment_top` / `bili_dynamic_top` **不在白名单里但在映射里**，这是防御性设计：
将来它们进白名单时，不会绕过通道开关与每日上限。

### 8.5 指标（`core/metrics.js`）：规则算数字，模型只负责说

```text
state.json.metrics          六项 0–100 整数：energy 60 / mood 55 / curiosity 65 / affinity 50 / boredom 30 / confidence 45
state.json.metricsHistory   最近 50 条变化（存差量 { at, event, changes }，不存全文）
state.json.metricsDay       "上一次跨天"的日期基线（不是"上次醒来"—— 一天可能醒很多次）
```

**为什么不让模型自己报情绪**：同一段经历两次跑出两个情绪，行为就不可复现，也没法和人设文件对齐；
"心情好就多说话"会变成一次幻觉。所以**规则算数字，模型只在台词里体现**，并且不许改这些值。

**事件表**（`EVENTS`，全部走 `applyEvent()`；精力的三项在 2026-11-01 §19 重平衡过）：
`wake` energy**−2** · `read-action` energy**0**（看不算消耗，事件仍在，只是增量是空的）· `write-action` energy**−3** ·
`action-ok` confidence+1 · `action-fail` confidence−3 · `risk` mood−8/confidence−5/energy−5（**并在同一处触发 2 小时静默**）·
`interest-hit` mood+3/curiosity+2 · `repeat` boredom+4/curiosity−2 · `dm-sent` affinity+5 · `owner-reply` affinity+10 ·
`day-pass` energy**+15**/boredom−5/mood 向 50 靠 1。

**重平衡的理由（写在 `EVENTS` 上方的注释里）**：旧参数下"看视频"和"醒来"都要付费，加速测（间隔 5 分钟）一小时就把
`energy` 从 60 打到 15；按正常节奏换算，一晚约 15 次醒来同样会在清晨前累瘫，而当时唯一的恢复是跨天 +25。
新表把成本压到"存在（−2）与发言（−3）"，看视频变成 0 —— **她的基本生活方式不该越看越累**。

`risk` 的行为后果写在 `metrics.js` 里而不是各调用方：**"指标变了 ⇒ 行为也跟着变"只留一处真相**。

**按小时恢复（`regenEnergy(now)`）**：

```text
基准点 base = max(state.lastWakeAt, state.lastRegenAt)     ← 幂等靠 lastRegenAt，而不是"每次调用加一点"
整小时数 hours = floor((now - base) / 1h)                  ← 不足 1 小时不结算，余数留在 lastRegenAt 里下次接着攒
逐小时取速率：for i in 0..hours-1: inWindow(base + i×1h) ? +3 : +6
    ← 每个小时片的**起点**各判一次，跨窗口边界的那几小时因此各按各的算
    ← schedule 读不出来时回落到统一 +3/h（保守，但不让精力永久卡死）
结果 = clamp(energy + Σ速率, 0, 100)                       ← 上限 100
落盘 = { metrics.energy, lastRegenAt: base + hours×1h }
```

为什么按 `lastWakeAt` 而不是"每次调用加一点"：醒来是稀疏事件，中间可能隔三小时；
只在 tick 里按次加，会让"她休息了三小时"和"她刚醒过"没有区别。`lastWakeAt` 缺失（首跑）→ 不恢复。

### 8.6 指标怎么接进闸与大脑

| 位置 | 用法 |
|---|---|
| `actions.js` | `effectiveAllows(schedule.allows, metrics)` 把通道开关**再收紧一层**（不改原对象，只作用这一次执行）；`behaviorHints(metrics).maxWrites` 决定本轮写动作上限（精疲力尽时 0）；`behaviorHints(metrics).noExplore` 让 `EXPLORE_TOOLS` 里的工具以 `low-curiosity` 被跳过；每日上限走 `effectiveCap(caps[channel], channel, hints)`（`null` 直通、只有设了私信上限才按 `dmFactor` 折算） |
| `actions.js`（评论专项） | ③a：`bili_comment` 先查 `state.commentedBvids`（保留最近 **100** 个 bvid）→ 命中就 `skipped:"already-commented"` 并 `continue`；这一步**在所有写闸之前**，所以一次注定被跳过的调用既不动 120 秒写间隔、也不调工具。随后若模型没给 `atOwner` 且 `schedule.atOwnerOnComment !== false`，自动补 `atOwner: true` |
| `actions.js`（出场） | 每个动作之后 `applyEvent('read-action' \| 'write-action')` + `applyEvent(ok ? 'action-ok' : 'action-fail')`；私信成功再加 `dm-sent`；指纹命中记 `repeat`；风控记 `risk` |
| `brain.js` | 把 `describe(metrics)` 与 `hintsText(behaviorHints())` 塞进上下文；要求模型在 JSON 里标 `interest: true`（决策级或动作级都认） |
| `autonomy.js`（回复检查） | 评论区与「@我的」共用 `state.lastReplyCheckAt` 的 **30 分钟节流窗**（`REPLY_CHECK_GAP_MS = 30 × 60_000`）→ 一晚约 6 次而不是 30 次。`ensureMentionReply()`：拉 `bili_at_me`（`limit` 3）→ 新 id 记入 `seenAtMeIds`（哪怕回不了）→ 坐标齐全才 `bili_reply`（每轮最多 1 条），只有 `oid` 就审计「坐标不全」并跳过。评论侧判据收紧成四条：`root === 她的 rpid` ∧ `parent === 她的 rpid` ∧ `mid !== selfMid` ∧ `rpid` 未见 —— **为什么要 `parent`**：只判 root 会把"楼里别人回别人"也当成回她；`parent` 才是"直接回我这条"的证据，别人之间的对话不该她插话。`selfMid` 缺失时先自愈查一次，否则会把自己的回复当成别人的新回复 |
| `autonomy.js`（看完必评） | tick 末尾 `ensureCommentAfterWatch()`：本轮看过视频（`bili_watch`/`bili_video_info` 成功）且没发出过评论 → 用 `state.lastWatchedBvid` 补一条（正文取 `thought.say` 去 @ 前缀、压空白、≤120 字，空则固定句"看完这条了，先记着。"），**每轮最多一条**。它走 `runActions()` 而不是直接 `runTool`：六道闸（allows / 指标 / 上限 / 写间隔 / bvid 去重 / token 预算）必须照旧生效，绕过等于开后门；被跳过时只补一条审计（`args.commentFallback`），不重试 |
| `autonomy.js`（睡前汇报） | tick 末尾 `maybeBedtimeReport()`：算出的下一次醒来落在窗口外 = 本窗口最后一次 → 用 `bedtimeTemplate` **确定性模板**拼一条私信（**不调模型**：省一次调用、内容可预测、汇报本身不该再花 token/精力），按窗口去重 + 30 分钟兜底，失败不重试也不记已发 |
| `autonomy.js` | tick 里的顺序是 **`decayTo(now)`（跨天）→ `regenEnergy(now)`（按小时恢复）→ `applyEvent('wake')`（扣 −2）**：先恢复再扣本次消耗，别把刚睡醒的人按"扣完才回血"算；`snapshot()` 返回 `metrics` 与 `behavior` |

**只收紧、不放开** 是这套设计的安全边界：`effectiveAllows` 返回的是副本，指标再低也不会把主人关掉的通道打开；
指标高也不会解锁 —— `schedule.allows` 才是那个必须被明确打开的闸。

阈值：`energy<20`（关公开通道、留 read+dm）、`energy<10`（全关）、`confidence<30`（关 comment/reply/dynamic）、
`confidence<15`（再关 like/follow）、`affinity<40`（私信配额 ×0.5）、`affinity<20`（不主动开口）、`boredom>70`（优先换口味）、
`mood<30`（台词 ≤30 字）。`curiosity<25`（`CURIOSITY_EXPLORE_MIN`）→ `noExplore`：跳过 `EXPLORE_TOOLS`
（`bili_search` / `bili_playurl`），`why` 记 `low-curiosity`，并给上下文加一句"今天不太想探索，热门刷两眼就行"。
`bili_watch` **不在** `EXPLORE_TOOLS` 里 —— 低好奇时刷两眼热门正是该做的事。

### 8.7 身份、热梗库与「醒了必留痕」

**身份**：`persona.md` 的第一件事是 front-matter（`--- name / ownerTitle ---`）。
`writeProfile()` 只重写这一段、把 `name`/`ownerTitle` 提到最前，**正文一个字节不动**（测试用带连续空行与行尾空格的正文钉死它）；
两个字段各 ≤20 字、空值拒绝，缺 front-matter 回默认 `赛博友人`/`主人`。
放在文件里而不是 config 里：名字是"她是谁"的一部分，跟着人设走才不会出现"人设改了名字没改"。

**热梗库**（`core/memes.js`，`memes.json`）：

| 维度 | 取值 | 为什么 |
|---|---|---|
| 容量 | ≤40 条 | 梗库要塞进 system 提示，无界就等于把上下文挤爆 |
| 刷新 | `updatedAt` ≥30 天 | 热梗过期比没有更糟 |
| 频率 | 一天最多一次（记 `lastAttemptAt`） | 失败也别连环重试，那会烧 token |
| 来源 | `web_search` → `llm` → `unavailable` | **如实标注，不许冒充**：搜索拿到原料但结构仍靠模型，两者都成才算 `web_search` |
| 失败 | 保留旧列表 + `stage:'stale'` + `lastMemeError` | 空库 = 她彻底不会玩梗，比过期更差 |
| 进上下文 | `pickForPrompt(12)`：`meaning` 非空 + 按 `seen` 升序 | 少用过的先上，避免总是同一个梗 |

刷新只在**定时醒来**时尝试（`shouldRefresh()`）；设置页的「立即刷新」是手动旁路（30 秒超时、并发 409）。

**用梗规矩**写在两层：`brain.js` 的 system 段落（A–D 四条）+ `persona.md` 正文。但**拦住行为的是内核**：

| 规矩 | 强制层 | 实现 |
|---|---|---|
| 只能用库里的、`meaning` 为空的不用 | **代码** | `pickForPrompt()` 只列库内条目并滤掉空 meaning |
| 同梗 **7 天内 ≤2 次** | **代码** | `MEME_COOLDOWN_MS = 7×24h` + `MEME_MAX_USES_IN_WINDOW = 2`；`pickForPrompt()` 先滤 `usesInWindow() >= 2` 的条目 |
| `seen` 记账 + 审计 `args.meme` | **代码** | `bumpSeen()`：`seen+1`、`uses.push(nowISO)`、`slice(-MEME_USES_KEPT)`（10 条） |
| 一条消息最多一个梗、不连用 | **提示层** | 内核没有"消息里有几个梗"的概念，无法在代码里判 |
| 拿不准就不用、与语气冲突就放弃 | **提示层** | 同上 |

窗口是**滚动**的（只留最近 10 条时间戳），`seen` 是累计值；全库都在冷却里时 `pickForPrompt()` 返回 `[]` ——
brain 的提示里没有梗可列，她这轮自然不玩梗，**不拿超限的梗凑数**。刷新梗库时**保留 `uses`**，否则每月换库等于集体免一次冷却。

**醒了必留痕**：醒来是大概率什么都不发生的，但"什么都没发生"不等于"不存在"（否则日记整天空白、设置页"上一句"空着像坏了、
事后查不出她醒没醒）。所以 `autonomy.js` 在 tick 末尾**无条件**落四样：日记一行、`lastLine`、`memory(kind:"thought")`、审计一行。
台词来源优先级：决策 `diary` → 决策 `say` → `fallbackLine()`（四组 × 3 句：窗口外 / 太累 / 腻了 / 其它，按 metrics 算索引）。

**路由**：self 层 8 条（`state`/`settings`/`persona`/`run-once`/`audit`/`profile`/`memes`/`meme-refresh`），
内核层 3 条（`kernel/{status,settings,credential}`），共 **11 条**同源路由。

### 8.8 作息模型：`windows` + 周末全天

一天不再是"一个窗口"，而是**一组时段**（`schedule.json`）：

| 字段 | 校验 | 语义 |
|---|---|---|
| `windows` | **1–6** 个；每项 `{start,end}`，`HH:MM`，`end` 允许 `24:00`；**只有 `start === end` 非法** | 任一时段命中即在线；`start > end` = 跨午夜（"今天 start 之后或明天 end 之前"） |
| `weekendAllDay` | 布尔 | `true` → 本地周六/周日 `00:00–24:00` 全天在线 |
| `weekendIntervalMin` | **5–720** 分钟 | 周末的醒来间隔；缺省回落 `intervalMin`（`DEFAULTS.weekendIntervalMin` 是 90，只在连 `intervalMin` 都没有时兜底） |
| `window` | 旧字段 | **写盘时恒等于 `windows[0]`**；读入时若文件只有它，就当单项数组 |

三个判断函数分工明确：

```text
inWindow(s, now)         → 周末全天命中 || windows 任一段命中（跨午夜单独一支）
nextWindowStart(s, now)  → 已在窗口内 = null；否则在 [今天, +2 天] 的每个 start 里取最近的未来时刻
                           （开了周末全天时，"周六 00:00" 也参与比较）
nextWakeAt(now, s)       → enabled=false → null；窗口外 → nextWindowStart；窗口内 → now + intervalMs(±jitter)
intervalMs(s, now)       → 周末且 weekendAllDay → weekendIntervalMin，否则 intervalMin
```

**兼容策略为什么这样定**：`normalizeWindows` 判断"谁是真实时段"时**看文件本身**而不是合并结果 ——
因为 `DEFAULTS` 里现在也有 `windows`，合并之后 `merged.windows` 永远非空，旧文件（只写了 `window`）就会被默认值悄悄盖掉。
所以优先级是：文件里的 `windows`（>1 段时） > 文件里的 `window` > 默认。

设置页的三个预设只是**填表单**（`applyPreset`），不保存：夜行 `[20:00–24:00]`/45、白天 `[09:00–12:00, 14:00–18:00]`/60、全天 `[00:00–24:00]`/90。

**时区**：周末判断走本机时区的 `getDay()`；跨午夜时段在周末边界上按"醒来时刻所在的日期"算 ——
周五 23:00–02:00 这段，周六凌晨那半截算周末，周五深夜那半截不算。

### 8.9 每日上限：`null` / `0` / 数字，三件事

`schedule.caps` 的每一项只有三种取值，而且 `null` 与 `0` **必须能区分**：

| 值 | 含义 | 落地 |
|---|---|---|
| `null`（或缺省） | **不限** | `effectiveCap` 直接返回 `null`，闸直接放行 |
| `0` | **禁止**该通道 | `effectiveCap` 返回 0，`counts >= 0` 恒真 → 每次都拦 |
| 数字 0–1000 | 每天最多这么多条 | 超过才拦 |

默认值只有一处设了数字：

```js
caps: { dm: null, comment: null, reply: null, dynamic: 2, like: null, follow: null }
```

**`effectiveCap(cap, channel, hints)` 的四条规则**：

1. `cap == null` → 返回 `null`（不限，直通）；
2. 非有限数字 → 返回 `null`（坏值按"不限"处理，**绝不静默变成禁止**）；
3. 非 `dm` 通道 → 原样返回数字；
4. `dm` 通道 → `floor(cap × dmFactor)`，**但只有设了上限才折**：`dmFactor` 是"相近度低就把私信配额压一半"，
   而"不限 × 0.5 仍然是不限" —— 所以 `null` 不进这一步。设了 4 且 `affinity<40` → 实际 2。

**观测与限制解耦**：`bumpCount` 在任何情况下都记账，`todayCounts` 一直涨；上限只决定"超了拦不拦"。
取消上限 ≠ 不看数 —— 设置页仍然显示今天各通道发了几条。

**旧配置兼容**：文件里 `caps` 还是数字（`6` / `4` 那一代）就照旧按数字拦；显式 `null` 是"取消上限"（与"不改"不同）；
`undefined` 才回落默认；坏值回落默认，不会静默变禁止。

**设置页只暴露「发动态」一个输入**（占位 `2`；留空 = `null` 不限、填 `0` 禁止）。这是**刻意的不对称**，不是漏做：

- 五个通道（`dm` / `comment` / `reply` / `like` / `follow`）默认 `null` = 不限，界面上不再给入口；
  区块里明写「其余动作不设上限；如需限制，可编辑 `schedule.json` 的 `caps`」。
- **能力没删**：`core/schedule.js` 的 `normalizeCap` / `saveSchedule` 与 `self-routes` 的校验仍然完整支持五项 `null`/`0`/0–1000，
  手工改 `schedule.json` 照样生效。
- **保存时只提交 `caps.dynamic`**：后端本来就是部分更新，没提交的键保持原值 —— 界面简化不该把用户已经配好的上限写坏。
- 第二行说明「上限只是自控；真正拦住高频的是 token 预算与两次写之间的间隔（120 秒）」保留在区块底部。

### 8.10 会话模式（2026-11-03）

`sessionMode: "board"` 时 `tick()` 的路径改变：

```
decayTo → regenEnergy → wake → 状态闸 → checkMentions（只读，写进上下文）
  → writeWakeContext() → task_board_run({taskId, rerun:true}) → return
```

- **不再经过 `brain.decide` 与 `runActions`**：整段跳过，内核不与她的会话抢方向盘；
- 触发用 `ctx.tools.get('task_board_run')`（与 `deepwatch` 取 `video_understand` 同一条已验证的路）；
- 三种失败只记审计不阻塞：`no-card` / `tool-missing` / 抛错；
- 上下文文件是**唯一的单向通道**（内核 → 她）；她不需要回传，因为活是她自己干的。

## 9. 共享状态与并发

`<HOME>/.bili-ai/` 下的七份文件同时被本插件和另一个同账号实现读写（凭据 / 缓存 / 熔断 / 请求守卫状态 / 请求日志 / 内容账本 / token 采样状态），所以：

- 写一律 **tmp + rename**（同目录内的 rename 才是原子的；跨盘会退化成复制）。见 `core/config.js` 的 `writeJsonAtomic`。
- `quota.json` 另有 best-effort 的 `.lock`（最长等 2 秒，等不到就照常干活；陈旧锁超过 10 秒直接接管）。
  锁只把"两个进程同时读到同一份 log"的窗口压小，正确性靠原子写。
- 读一律**容忍未知字段**：别的实现加的字段原样留着，本模块只追加自己的条目，从不重写别人的。
- `quota.json` 坏掉 → fail-closed（见 §7），不是退默认值；`token-budget.json` 坏掉则退回"重新采样"（它只是采样缓存，真值在宿主账本里）。

## 10. 与另一个同类实现的边界

参考实现（37 个命令、约 7000 行、32 个端点真机跑通）只提供**源码复制的初始材料**，本包不引用它：

| 红线 | 现状 |
|---|---|
| 不 import / 不 require 它 | `lib/` 下静态扫描无 `dsh-bili-whale` / `bili-whale` / `whale-src` / `whale-work`（grep 实测为空） |
| 不声明为依赖 | `package.json` 只有本包自己的字段，没有任何 peer/optional 依赖指向它 |
| 不改它 | 本仓库不碰它的目录 |
| 不读它的私有数据 | 不碰它的 work / 日记 / log / 会话目录 |
| 复制即独立 | `lib/vendor/*.mjs` 只做三处适配（路径来源、状态目录、凭据路径），它被卸载本包功能不受影响 |

两条**共享**是故意保留的：`credentials.json`（同一个号一份登录态）、`api-ban.json` / `api-cache.json` /
`traffic-state.json` / `api-requests.log` / `quota.json`（风控与配额是账号级的，分开就是两个计数器）。

业务状态**不共享**：本包不写"已评论过哪条 bvid"这类清单，也不写"私信读到哪"（`unreadOnly` 只活在进程内存里）。

## 11. 结构性缺口（代码位置已确认）

| 缺口 | 表现 |
|---|---|
| 设置页未在真机点过 | `lib/settings-api.js`（路由 + 信任栅栏）与 `lib/client.js`（手写客户端）都在，但宿主界面里的完整链路只按代码读过 |
| 测试覆盖不全 | `tests/` 下已有 `node:test` 用例（`npm test`），但契约 §9 的用例尚未齐 |
| 写通道没有真实写入记录 | 全部只做过假客户端测试，真机上一次真实写入都还没做 |
| 自主层没有真机跑过一整轮 | `autonomy.js` 的两条定时器、`brain` 的四类失败、六道闸的拦截都只在离线环境验过 |
| 事件插队只查私信 | 每 5 分钟读一次 `bili_dm_inbox`；"回复我的"没有对应只读工具，评论区 @ 不会触发插队 |
| 私信 `dev_id` 是进程内随机 UUID | 重启后换一个，跨进程稳定性未解决 |
| `bili_like` 端点未真机验证 | 见 README §11 |

## 12. 想加东西时改哪儿

| 想加的东西 | 改哪儿 | 要不要改内核 |
|---|---|---|
| 内容理解（看懂视频、写笔记、做表情包） | **不改本包**：写一个扩展插件，`registerCapability` 挂进来 | 不要 |
| 新的 B站 读写能力（例如弹幕、直播间） | `lib/api/<域>.js` + `lib/tools/index.js` 加一个工具 + 若是写通道必须挂 `gate()/record()` | 要 |
| 新的写通道类型 | `core/quota.js` 的 `WRITE_TYPES`（第二批已经加过 `relation`） | 要 |
| 让「她」能用一个新工具 | `core/actions.js` 的 `WHITELIST` + `CHANNEL_OF`（只读工具也要进白名单）+ `core/schedule.js` 的 `caps` | 要 |
| 改指标阈值 / 事件增减 | `core/metrics.js`（`EVENTS` / `effectiveAllows` / `behaviorHints`）+ `persona.md` 第六节（给人看的那份要同步） | 要 |
| 改热梗库容量 / 刷新周期 / 来源策略 | `core/memes.js`（`MEMES_MAX` / `REFRESH_AFTER_MS` / 三级来源分支） | 要 |
| 改"必留痕"的内容 | `core/autonomy.js` 的 tick 末尾（日记 / lastLine / memory / 审计四样） | 要 |
| 新的 wbi 读接口 | `lib/api/<域>.js` 里调 `client.get(path, query, { wbi: true })` | 要（新 api 文件） |
| 改 token 额度 | `dsh-bili.config.json` 的 `budget.tokenHourly` / `budget.tokenDaily`（不是改代码） | 不要 |
| 改平台安全带 | `dsh-bili.config.json` 的 `risk.minGapMs` / `writeGapSec` / `dmGapSec` | 不要 |
| 换状态目录 | `paths.stateDir` 或环境变量 `DSH_BILI_STATE_DIR` | 不要 |
