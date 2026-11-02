# dsh-bili 内核接口契约

本文件是**装配契约**：所有实现层按这里的签名写，不要私自改签名。改契约 = 改这一份文件 + 通知其它模块。

## 0. 运行形态（硬约束）

- ESM，Node >= 20，2 空格缩进。
- **禁止**在 lib/ 下静态 import 任何 `@deepseek-ai/*` 包（宿主对 junction 路径不做 ESM 插桩，实测 ERR_MODULE_NOT_FOUND）。
- 插件入口导出：name / inject = ['tools'] / apply(ctx, config)。
- 对外服务：ctx.provide('bili', service)（老宿主退回 ctx.reflect.provide）。
- 源码里**不得出现** dsh-bili-whale / bili-whale / whale-src / whale-work 等字符串。
- 日志里**不得出现**凭据、cookie、响应正文。

## 1. 目录

    lib/vendor/{bili-api,traffic,cred,nodebin,paths,runtime,capture}.mjs   复制自鲸鱼实现，只改路径来源
    lib/core/config.js       配置读写（$DSH_HOME/dsh-bili.config.json）
    lib/core/credentials.js  凭据（~/.bili-ai/credentials.json，共享只读 + 设置页写入）
    lib/core/client.js       B站 HTTP 客户端（签名/缓存/退避/节流复用 vendor）
    lib/core/quota.js        配额闸（gate/record，共享 ~/.bili-ai/quota.json）
    lib/core/capabilities.js 能力注册表
    lib/api/{video,comment,dynamic,message,favorite,relation}.js
    lib/tools/index.js       15 个工具定义
    lib/settings-api.js      设置页后端路由
    lib/client.js            设置页（手写客户端模块，无构建链）
    lib/index.js             装配（只装配，零业务逻辑）

## 2. 统一错误形状（api/* 与 tools/* 都用它，正常失败不抛异常）

    { ok: true,  data: <JSON> }
    { ok: false, reason: <枚举>, human: '给人看的一句话', code?: <B站返回码>, detail?: {...} }

reason 枚举：bad-argument | credential-missing | owner-only | quota-exceeded | capability-not-found |
bili-error | network | not-logged-in | risk-control

human 必须是人话（复用 vendor/cred.mjs 的 explainCode）。

## 3. core/config.js

    export const CONFIG_PATH           // process.env.DSH_BILI_CONFIG || <DSH_HOME>/dsh-bili.config.json
    export const DEFAULTS              // { owner:{mid:389989266,name:'往生堂七七代堂主'},
                                       //   risk:{minGapMs:1500,readHourly:600,readDaily:3000,
                                       //         writeHourly:12,writeDaily:30,writeGapSec:120,dmGapSec:60},
                                       //   paths:{stateDir:''} }   // 空 = ~/.bili-ai
    export function loadConfig()       // 每次现读文件 + deep-merge DEFAULTS；文件坏 → 默认值，不抛
    export function saveConfig(patch)  // 原子写（tmp + rename），返回合并后的完整 config
    export function stateDir(config)   // → 绝对路径，默认 <HOME>/.bili-ai
    export function setConfigPathForTest(p)  // 测试用；传 undefined 复位

优先级：配置文件 > 插件 config（apply 第二参）> 默认。

## 4. core/credentials.js

    export const CRED_PATH                 // <HOME>/.bili-ai/credentials.json（与鲸鱼同一份，共享只读）
    export function loadCred()             // → { sessdata, bili_jct, buvid3 }（trim、容忍 BOM）
                                           //   缺文件抛 Error，消息带路径 + '去设置页粘贴'
    export function credStatus()           // → { present, hasSessdata, hasJct, hasBuvid3,
                                           //     jctLooksValid, missing: string[] }（永不回显值）
    export function saveCookie(text)       // 粘贴的 cookie 串 → 解析 → 原子写回；返回 credStatus()
    export function explainCode(code)      // → 人话（vendor/cred.mjs）
    export function requireForWrite(cred)  // → null | { ok:false, reason:'credential-missing', human }

## 5. core/client.js

    export function createClient(config)   // 每次现读 config（settings 改完立刻生效）
    // 返回：
    {
      async get(path, query = {}, opts = {})   // path = '/x/...'；query 自动编码
                                               // → B站响应 { code, message, data }，绝不抛网络异常
      async post(path, form = {}, opts = {})   // 自动加 csrf=bili_jct + 凭据 header
                                               // 凭据不全 → { code:-111, message:人话 }
      async raw(absoluteUrl, opts = {})        // opts = { method, json, form, query, binary }（json:false 等价 binary）
                                               // JSON 响应 → B站原始对象 { code, message, data }
                                               // 非 JSON 或 binary → { ok, status, buffer }
                                               // 必须能打 api.vc.bilibili.com 等非 api 主机
      async nav()                              // nav（10 分钟缓存由 vendor 负责）
      state()                                  // → { banned, banMinutesLeft, banWhy, cacheEntries }
      cred()                                   // → loadCred()（内部用，不打印）
    }

GET 走 vendor/bili-api.mjs 的 apiGet（签名/缓存/退避/节流都在里面）；
POST 走 vendor/traffic.mjs 的 guardedFetch（节流 + 熔断），自己实现 412/429 → 熔断与 300ms 节流。
**缓存与熔断状态目录 = stateDir(config)**，默认 ~/.bili-ai（与鲸鱼共享）。

## 6. core/quota.js（共享账本，格式必须兼容既有文件）

    export const WRITE_TYPES = ['comment','reply','dynamic','dynamic_edit','danmaku','dm','favorite','like']
    export function gate(config, { type, target = '' })   // → { ok:true } | { ok:false, reason:'quota-exceeded', human, detail:{ used, limit, window } }
    export function record(config, { type, target = '', note = '' })   // 发送成功后记账；失败不记账
    export function quotaStatus(config)                   // → { hour:{used,limit}, day:{used,limit}, writeGapLeftSec, dmGapLeftSec }
    export function resetForTest()

账本文件：<stateDir>/quota.json，结构 { log: [{ at, type, auto:false, share:false, target, note }] }
（字段名必须与既有账本一致，否则两个插件各算各的）。
所有读写：先读最新文件 → 修改 → 原子写（tmp + rename）→ 文件锁（.lock，best-effort）。
窗口语义照既有实现：hourly/daily 按 at 时间滑窗计数；writeGapSec / dmGapSec 看最后一条同类记录。

## 7. core/capabilities.js

    export function createCapabilityRegistry({ log } = {})
    // 返回：
    {
      register(def),          // def = { id, kind, description, run, schema? }
                              // id 必须 /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/（<域>.<动作>）
                              // 重复 id → 抛 Error（装配期错误）
      unregister(id),         // → boolean
      list(),                 // → [{ id, kind, description }]
      has(id),
      async call(id, payload),// → 能力返回值；未注册 → { ok:false, reason:'capability-not-found', id, available:[...] }
      onAdded(cb),            // → off()
      snapshot()              // → 只读副本（工具描述动态生成用）
    }

kind 枚举：analyze | fetch | transform | decide。调用未注册能力**绝不抛异常**。

## 8. api/* 的签名（统一 (deps, args) 两参）

deps = { client, config, quota, capabilities, owner, log }

    video:     info(deps,{bvid|aid}), popular(deps,{ps,pn}), ranking(deps,{rid,type}),
               search(deps,{keyword,type,page,order}), playurl(deps,{bvid,cid,qn})
    comment:   list(deps,{oid,type,page,withReplies}), replies(deps,{oid,root,page}),
               add(deps,{oid,type,message,atOwner}), reply(deps,{oid,root,rpid,message,atOwner}),
               del(deps,{oid,type,rpid}), top(deps,{oid,type,rpid,action})
    dynamic:   feed(deps,{type,page}), detail(deps,{dynId}), create(deps,{text,images}),
               edit(deps,{dynId,text}), uploadImage(deps,{path}), setTop(deps,{dynId})
    message:   inbox(deps,{limit,unreadOnly}), send(deps,{text})   // 收件人写死 owner，不接受 mid 参数
    favorite:  folders(deps,{}), deal(deps,{bvid,add})
    relation:  relation(deps,{mid}), like(deps,{bvid,action})       // like 只认 bvid + like/unlike
                                                                        // 端点为实测外唯一未验证项：archive/like

**每条写通道**（comment.add / comment.reply / dynamic.create / dynamic.edit / message.send /
favorite.deal / relation.like）必须：gate() → 发 → 成功才 record()。漏一条 = 不合格。

## 9. tools/index.js

    export const TOOL_NAMES = [ ... 15 个名字 ... ]
    export function buildTools(deps) → [{ name, description, parameters, output:{schema,render}, execute(args, execCtx) }]

- parameters 是**标准 JSON Schema**（{ type:'object', properties:{...}, required:[...] }）。
- output.schema 也必须是标准 JSON Schema；output.render(result) 返回 **[{ type:'text', text }]**
  （已核实：dsh-video 的 renderResult 就是这个形状；返回裸字符串会让工具结果在界面上空白）。
- lib/index.js 把 output.render 原样交给 ctx.tools.register，不要再包一层。
- 工具名（15 个）：bili_watch bili_video_info bili_search bili_comments bili_comment bili_reply
  bili_comment_del bili_dm bili_dm_inbox bili_dynamic bili_dynamic_edit bili_favorite bili_fav_list
  bili_like bili_status
- 描述里必须写明：私信只能发给主人；视频理解能力未注册时当前不可用并列出可用能力 id。

## 10. lib/index.js（装配）

    export const name = 'dsh-bili'
    export const inject = ['tools']
    export function apply(ctx, rawConfig)

apply 顺序：config → registry（注册内核基础能力）→ client/quota → provide('bili') → 注册 15 个工具
→ ctx.inject(['webServer'], scoped => mountSettingsRoutes(scoped, { ctx, deps }))（可选，失败不影响工具）。


## 11. token 预算（2026-11-01 起，取代「读写次数配额」）

用户决定：**额度以花费的 token 为准，不再区分读写**。口径与规则如下（实现以本节为准）：

    config.budget = { tokenHourly: 1000000, tokenDaily: 8000000 }

- **计量口径**：`input + output`（**不含** cacheRead / cacheWrite / reasoning），单位 token。
- **数据来源**：`$DSH_HOME/dsh-usage/usage-ledger.json`（宿主写的用量账本，按天/provider/model 记 inputTokens/outputTokens/cost）。账本只有**按天**粒度，所以：
  - 「今天已用」直接取账本当天合计；
  - 「本小时已用」靠**采样差分**：每次检查时读账本当天合计，把与上次采样的差值累加到当前小时桶，状态存 `<stateDir>/token-budget.json`（原子写）。
- **窗口**：小时 + 天双窗；跨天自动重置（按账本的日期键）。
- **跨整点的边界语义（已裁决）**：换小时时 `hourUsed = 0` 并从「当前总量」重建基线 —— 上一次采样到整点之间花掉的那一段**不进任何小时桶**（采样本身有精度上限，不可能知道它落在哪一小时）。**这是可接受的**，因为「天」的判据直接取账本当天合计、**精确**，小时桶的少量漏记最多让限流晚一小时生效，总量仍被天窗口卡住。
- **拦截范围**：**只拦写通道**（`quota.gate()` 里调用）；读通道不检查。
- **fail-open**：账本读不到 / JSON 坏 / 路径不存在 → 不拦，但状态里标 `source:'unavailable'` 并在 `bili_status` 里显示 —— 不能因为宿主没写账本就把插件锁死。

### 11.1 新增模块 `lib/core/tokenbudget.js`

    export function tokenStatus(config)  // → { hour:{used,limit}, day:{used,limit}, source:'ledger'|'unavailable', sampledAt, file }
    export function gateToken(config)    // → { ok:true, status } | { ok:false, reason:'token-budget-exhausted', human, detail }
    export function resetForTest()

- `human` 形如：`本小时已花 1,043,200 token（上限 1,000,000）—— 写通道暂停，<HH:MM> 恢复；读通道仍可用`。
- 采样状态文件 `<stateDir>/token-budget.json`：`{ hourKey, hourUsed, dayKey, dayBase, sampledTotal }`。

### 11.2 旧字段的处置

- `risk.readHourly / readDaily / writeHourly / writeDaily`：**保留键位但不再参与判定**；DEFAULTS 里把它们的默认值设成哨兵 `DEPRECATED_COUNT_LIMIT = 10_000_000`（不是原来的 600/3000/12/30），这样即使 vendor 的 guard 仍在读这几个数字，也等于「不拦」；旧配置文件里的旧值照常合并、同样不参与判定。
- `risk.minGapMs / writeGapSec / dmGapSec`、412 熔断与写操作去重：**全部保留** —— 那是 B站 平台安全带，不是额度。
- `quota.gate()` 顺序：**token 预算 → 写间隔（gap）**；两者任一不过就拒，且都不记账。

### 11.3 错误码

`reason` 枚举新增 `token-budget-exhausted`；工具层（lib/tools/index.js）的 REASONS 与结果 schema 要同步加这一项。


## 13. 第二批工具（2026-11-01 第二批：把已有 api 开口 + 关注/取关与用户信息）

### 13.1 新增工具（15 → 25）

| 工具 | 对应 api | 参数 | 写？ |
|---|---|---|---|
| `bili_replies` | `comment.replies` | oid, root, page | 读 |
| `bili_comment_top` | `comment.top` | bvid\|oid, type, rpid, action(pin\|unpin) | 写（gate type=`comment`） |
| `bili_dynamic_detail` | `dynamic.detail` | dynId | 读 |
| `bili_dynamic_top` | `dynamic.setTop` | dynId, action(pin\|unpin) | 写（gate type=`dynamic`） |
| `bili_image_upload` | `dynamic.uploadImage` | path | 不占写额度（无公开内容），但仍过请求层 |
| `bili_playurl` | `video.playurl` | bvid, cid?, qn? | 读 |
| `bili_user_info` | `user.info`（新增） | mid | 读（**需 WBI 签名**） |
| `bili_relation` | `relation.relation` | mid | 读 |
| `bili_follow` | `relation.modify`（新增） | mid, action(follow\|unfollow) | 写（gate type=**`relation`**） |
| `bili_at_me` | `message.atMe`（新增） | limit（1–10，默认 5） | 读（GET /x/msgfeed/at）**不过写闸** |

### 13.2 契约变更

1. **`core/quota.js` 的 `WRITE_TYPES` 增加 `'relation'`**（关注/取关是写动作：要过 token 预算 + 写间隔）。
2. **`core/client.js` 的 `get(path, query, opts)` 支持 `opts.wbi === true`**：对 query 做 WBI 签名并把 `w_rid`/`wts` 拼到 URL（与 post 的 wbi 分支同一套 key 来源与 10 分钟缓存）。用于 `/x/space/wbi/acc/info`。
3. 新增 `lib/api/user.js`：`info(deps,{mid})` → `/x/space/wbi/acc/info`（WBI），返回 mid/昵称/头像/签名/等级/粉丝数/关注数。
4. `lib/api/relation.js` 增加 `modify(deps,{mid,action})` → `POST /x/relation/modify`，表单 `fid=<mid>&act=1|2&re_src=11&csrf=…`（act=1 关注 / 2 取关）；成功后记 `record('relation', 'mid:<mid>')`。
5. `lib/api/dynamic.js` 的 `setTop` / `comment.top` 继续沿用各自的 gate type（`dynamic` / `comment`），不新增类型。

### 13.3 第三批：`bili_at_me`（@我的，第 25 个工具）

| 项 | 契约 |
|---|---|
| 端点 | `GET https://api.bilibili.com/x/msgfeed/at`，query **固定**为 `platform=web & build=0 & mobi_app=web & pn=1 & type=0`（**没有 `ps`**）。路径以实测为准：`/atme` 404，`/at` 有效（2026-11-02 curl 验证；同族 `reply`/`like` 均 200） |
| 参数 | `limit`：整数 **1–10**，默认 **5**；越界按 clamp（`<1`→1、`>10`→10） |
| `limit` 的作用面 | **只影响本地切片，不改变请求**：先拿整页（`data.items`），再 `rows.slice(0, limit)`。见下方「为什么本地切片」 |
| 返回 | `{ ok:true, count, items:[…], data:<原始 B站 data> }` |
| `items[]` | `{ id, mid, uname, at, type, text(≤120 字), oid?, root?, rpid?, bvid? }` |
| `type` 映射 | `reply`/`comment` → `comment`；`dynamic` → `dynamic`；`video`/`archive` → `video`；其余 → `other`（**认不出一律 other，不猜成 comment**） |
| 坐标 | `oid`/`root`/`rpid`/`bvid` 解析不出时**省略该字段**（绝不编造）；能从 `uri`（`bilibili://video/123` 之类）里抠出 `oid` |
| 失败 | 透出 `{ ok:false, reason, human, code? }`，**绝不抛**。`reason` 的映射：`-101` → `not-logged-in`（未登录/凭据失效）、`-412` / `-352` → `risk-control`（风控）、网络异常 → `network`、其它非 0 → `bili-error` |
| 实现位置 | 解析在 `lib/api/message.js` 的 `atMe(deps, { limit })`：工具层只做参数与文案。 |
| 写闸 | **不过写闸**：只读，不消耗 token 预算与写间隔；它仍走 `client` 的节流/熔断/缓存规则 |
| 调用方 | 自主层 `ensureMentionReply()` 直接调（**不在白名单**）；模型侧也能调，用于自查"谁 @ 了我" |

**为什么本地切片，而不是把 `limit` 传给端点**：这个端点只给一页，分页参数（`ps` 之类）不在它的稳定契约里 ——
多传一个 B站 不认的参数，最常见的结果是**静默返回默认页**（既不报错，也不按你想要的条数给），
那种"看起来生效、其实没生效"最难查。所以请求保持固定形状，`limit` 只做本地 `slice(0, limit)`：
条数完全由我们控制，读多少条与打几次网络解耦（一次请求拿整页，省一次往返也省一次风控暴露）。

## 12. 测试注入约定

所有网络访问必须能换成假客户端：createClient 内部只用 vendor/traffic.mjs 的 guardedFetch；
测试用 createTrafficGuard({ transport }) 或直接构造 deps.client 假对象。**测试绝不打真实网络**。
