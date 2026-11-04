# @owl-zxk/dsh-bili

B站**账号管理内核**：让 DSH agent 能以主人的 B站 账号身份安全地读和写。

> 一句话：**内核管「怎么安全地跟 B站 说话」，扩展管「说什么」。**
> 内容理解（看懂视频 / 写笔记 / 做表情包）不属于本插件 —— 它们通过能力注册表挂进来。

## 1. 这是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 账号内核：凭据、WBI 签名、风控（缓存 / 退避 / 节流）、token 预算闸 | 内容生产器 |
| 基础读：视频元信息、热门与排行、搜索、评论、动态流、收藏夹、收件箱 | 内容**理解**（那是 `dsh-video` 那一侧） |
| 基础写：评论、回复、动态、私信（**仅主人**）、收藏、点赞、关注 | 广告投放 / 直播 / 视频内容理解（见 §11） |
| 自主运营层「她」：人设、记忆、日记、日程、大脑（见 §8） | 一个包办一切的巨型插件 |
| 能力注册表：别的插件把能力挂进来，内核不需要知道对方存在 | 特权用户 / 绕过风控的通道 |

分两层：**内核**（25 个工具 / 9 种写类型 / token 预算闸，§6–§7）与**自主层「她」**（人设 / 记忆 / 日记 / 日程 / 大脑 / 动作，§8）。自主层只是**另一个调用者** —— 它只通过已注册工具动作，所以风控、token 预算、私信硬限制对它自动生效。

**25 个工具**见 §6；能力注册表见 §9 与 [docs/EXTENDING.md](docs/EXTENDING.md)；分层与请求路径见 [docs/ARCH.md](docs/ARCH.md)；装配契约见 [docs/INTERFACE.md](docs/INTERFACE.md)。

## 2. 当前状态（先读这一节）

- 本插件在**开发阶段没有装进 profile**（另一个同类实现正在真机上运行；两个插件同时挂写通道会重复评论 / 重复发帖）。
- 因此：**安装命令、真实加载、真实读写都未实测**；所有写通道只做过假客户端测试。
- 设置页（`/dsh-bili/api/kernel/*` 三条路由 + 手写客户端 section）已写好，宿主侧路由真机可用（200），但**设置界面没在真实 DSH 里渲染过**。签名与结构以 [docs/INTERFACE.md](docs/INTERFACE.md) 为准。
- 哪些说法是"测过了"、哪些是"看着对"、哪些是"没验"，全部标在 §11「已知限制」。本文其余部分请按那里的标注来读。

## 3. 安装

### 3.1 标准装法（未实测，见 §2）

```powershell
dsh plugin --profile desktop add "link:D:\DSH\deepseek harness\wokrspace\dsh-bili"
```

**引号不能去。** 本仓库路径里带空格（`deepseek harness`），不加引号会被拆成两个参数。

装上之后**重启 DSH**（插件的加载时机在宿主启动，不重启看不到工具）。

### 3.2 手动兜底

标准装法本质上是改两处，两处都要改（少一处 = "装上了但没工具"）：

1. `<DSH_HOME>/profiles/desktop/package.json` 的 `dependencies` 加一行：

   ```json
   "@owl-zxk/dsh-bili": "link:D:\\DSH\\deepseek harness\\wokrspace\\dsh-bili"
   ```

2. 同一个文件的 `dsh.profile.bundles` 数组里加一项：

   ```json
   "@owl-zxk/dsh-bili"
   ```

本机 `DSH_HOME` = `D:\DSH\dsh-home`，即文件在 `D:\DSH\dsh-home\profiles\desktop\package.json`。

### 3.3 `cordis.patch.yml` 的两条硬规矩

本包的 patch 长这样（`cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-bili
      name: '@owl-zxk/dsh-bili'
```

- **`id` 在全链只能出现一次**。同一个 id 被 insert 两次，宿主会拒绝整份 patch。
- **`name` 必须是完整包名 `@owl-zxk/dsh-bili`**，不能写短名 `dsh-bili`。本包是 scoped 包，模块入口在 `node_modules/@owl-zxk/dsh-bili`；短名会让宿主去 `node_modules/dsh-bili` 找，症状是**"装上了但一个工具都没有"**，日志里只有一句 module not found。

## 4. 凭据

### 4.1 文件与三个字段

`<HOME>/.bili-ai/credentials.json`（本机 `C:\Users\<你>\.bili-ai\credentials.json`），字段只有三个：

| 字段 | 用途 | 缺了会怎样 |
|---|---|---|
| `sessdata` | 登录态（cookie 里的 `SESSDATA`） | 读接口被当成未登录，写作废 |
| `bili_jct` | 写操作的 csrf token | 所有写操作回 `-111`；只读照常，所以"体检全绿"不代表能发东西 |
| `buvid3` | 设备标识（部分接口要） | 少数接口异常 |

- 这份文件与鲸鱼那套实现**共享同一份**（同一个 OS 用户一份登录态，与 DSH_HOME、与 profile 数量都无关）。共享是**故意**的：同一个账号不该有两份登录态。
- 读取统一 trim、容忍 BOM；`bili_jct` 还会校验形状（B站 目前是 32 位十六进制）。
- **永不回显、永不进日志**：所有对外文字只说"缺哪个 / 形状像不像"，不带值；`bili_status` 也只报布尔量。

### 4.2 怎么写入

写入只有一条通道：`lib/core/credentials.js` 的 `saveCookie(text)` —— 整段 cookie 头（`SESSDATA=...; bili_jct=...; buvid3=...`）或一段 JSON 都能解析，解析不出东西就**抛错且不落盘**（写空等于把主人真实登录态抹掉），成功则 tmp + rename 原子写回、顺带 `chmod 600`（Windows 上基本无效，best-effort）。

设置页就是这条路：后端 `lib/settings-api.js`、前端 `lib/client.js`（手写、无构建链），三条同源路由 —— `/dsh-bili/api/kernel/status`（只读状态，不碰网络）、`/dsh-bili/api/kernel/settings`（GET 读 / POST 写，POST 以外的非 GET 回 405）、`/dsh-bili/api/kernel/credential`（只收 POST，其它方法回 405）。

> **为什么路径里多一层 `kernel`**：`/dsh-bili/api/*` 这个前缀已被另一个 B站 插件占用（它注册了 `/dsh-bili/api/settings` 与 `/dsh-bili/api/status`；那个包的名字**故意不写在这里** —— 发布面静态扫描禁止出现它的包名，见 `docs/ARCH.md` 的解耦红线）。宿主对重复的 `(kind, path)` 会抛 `webserver: duplicate exact route`，而注册失败被当成「重复」吞掉 —— 结果是我们的路由**静默丢失**，请求落到对方 handler 上，症状是 401 空 body、无 content-type。迁到 `/dsh-bili/api/kernel/*` 后两个插件可共存，无论对方在不在。

粘贴 cookie 走上面那个 `saveCookie()`，**任何一条路由都不回显凭据值**；每条路由还都过 Host 信任栅栏（不受信任来源回 403）—— Web 端口是回环地址，但回环不等于可信，浏览器里任意标签页都能向 `127.0.0.1` 发请求。

设置页不可用时（宿主没有 `webServer`，`lib/index.js` 只记一条 warn、不挂路由）还有两条退路：

- 直接编辑上面那个 JSON 文件（三字段，值从浏览器 cookie 里抄，去掉两侧引号与空白）；
- 或在别的实现（鲸鱼那套）的设置页里粘贴 —— 同一个文件，两边立刻都能读到。

文件不存在或读不出来时，`bili_status` 会明确报"读不到 / 缺哪个"，不会拿 `undefined` 去发请求。

## 5. 共享状态文件

风控是**账号级**的，业务是**插件级**的。所以下面这些状态文件默认都落在同一个目录 `<HOME>/.bili-ai/`，**与鲸鱼那套实现共用**：

| 文件 | 谁写 | 内容 |
|---|---|---|
| `credentials.json` | 只经 `saveCookie()` | `sessdata` / `bili_jct` / `buvid3` |
| `api-cache.json` | `vendor/bili-api.mjs` 的 GET 路径 | 静态元信息的响应缓存（保留最近 400 条） |
| `api-ban.json` | 读路径与写路径**都写** | `{ until, why, at, streak }`，撞风控后的熔断时刻 |
| `traffic-state.json` | `vendor/traffic.mjs` 的请求守卫 | 间隔 / 冷却 / 相同写操作去重 / 412 后暂停的运行状态 |
| `api-requests.log` | `vendor/bili-api.mjs` | 每行 `时间 HIT/NET 路径`（不含 cookie、不含响应正文） |
| `quota.json` | `core/quota.js` | 内容账本 `{ log: [{ at, type, auto, share, target, note }] }` |
| `token-budget.json` | `core/tokenbudget.js` | token 采样状态 `{ hourKey, hourUsed, dayKey, dayBase, sampledTotal }` |

**内容账本与 token 采样状态都必须共享，这一条是硬要求。** 分开的后果很具体：内容账本分开记，同一个账号上的实际发送量就是两份之和（各自以为"今天才 30 条"，结果一起发）；`token-budget.json` 分开，"本小时已用"就变成两份互不知道的数，谁都可能先撞上去。

目录优先级（都能覆盖，默认值不动）：`config.paths.stateDir` > 环境变量 `DSH_BILI_STATE_DIR` > `<HOME>/.bili-ai`。写文件一律 tmp + rename 原子写（`quota.json` 另有 best-effort 的 `.lock`，等不到锁也照常干活——真正的正确性靠原子写，锁只把"两个进程同时读到同一份"的窗口压小）。

## 6. 25 个工具

写通道一栏：**过 gate**＝发之前 `gate()`（先查 token 预算，再查写间隔）、发成功之后 `record()`；`gate()` 不通过就**一条请求都不发**。闸门缺失时按"拒绝"处理（fail-closed），不是放行 —— 但这条只对写通道成立：**读通道不受 token 预算约束**（见 §7.4）。

有两条边界值得单独记住：`bili_comment_del` 是撤回动作（不过 gate、也不记账）；`bili_image_upload` 是**真实的 POST**（吃请求层额度、可能被去重），但**不产出公开内容**，所以同样不过写通道的 token 预算闸。

| 工具名 | 作用 | 关键参数 | 写通道 |
|---|---|---|---|
| `bili_watch` | 刷热门 / 分区排行 / 关注动态流，可对前几条做深读 | `source`(popular·ranking·feed) `limit`(1-20) `rid`(0-210) `deep` `deepCount`(1-3) `question` | 只读 |
| `bili_video_info` | 视频元信息：标题 / UP / 分区 / 时长 / 统计 / 分 P / 简介 | `bvid` 或 `aid`（二选一） | 只读 |
| `bili_search` | 搜视频 / 番剧 / 用户，可翻页换排序 | `keyword`(1-100) `type`(video·media_bangumi·bili_user) `page`(1-50) `order`(totalrank·click·pubdate·dm·stow) | 只读 |
| `bili_comments` | 读评论主楼，带作者 mid / 点赞数 / 内嵌楼中楼 | `bvid` 或 `oid` `type`(1·11·17) `page`(1-50) `withReplies` | 只读 |
| `bili_comment` | 发顶层评论，可在正文最前面自动 @主人 | `message`(1-1000) `bvid` 或 `oid` `atOwner` | **写 · 过 gate**（`comment`） |
| `bili_reply` | 回复楼中楼里的某条评论 | `root`+`rpid`+`message`（三个都必填）`bvid` 或 `oid` `atOwner` | **写 · 过 gate**（`reply`） |
| `bili_comment_del` | 删自己发的评论 | `rpid` + `bvid` 或 `oid` `type` | 写，但**不过 gate、也不记账**：撤回不占写额度 |
| `bili_dm` | 给主人发一条私信 | `text`(1-300)。**没有 `mid`/`uid` 参数**（见 §7） | **写 · 过 gate**（`dm`） |
| `bili_dm_inbox` | 读和主人的私信会话 | `limit`(1-50) `unreadOnly` | 只读 |
| `bili_dynamic` | 发一条动态，可带图（最多 9 张） | `text`(1-1000) `images`（本地绝对路径或已上传的 `img_src`） | **写 · 过 gate**（`dynamic`） |
| `bili_dynamic_edit` | 改一条已发动态的正文（原图原样保留） | `dynId` `text`(1-1000) | **写 · 过 gate**（`dynamic_edit`） |
| `bili_favorite` | 收藏 / 取消收藏（只动默认收藏夹） | `bvid` `add`(默认 true) | **写 · 过 gate**（`favorite`） |
| `bili_fav_list` | 列出收藏夹：media_id / 名字 / 条数 / 哪个是默认 | 无 | 只读 |
| `bili_like` | 点赞 / 取消点赞一条视频 | `bvid` `action`(like·unlike) | **写 · 过 gate**（`like`）· 端点未真机验证 |
| `bili_status` | 一屏汇总：登录态、凭据体检、熔断与缓存、token 预算余量（本小时 / 本天已用）、可用能力 id、主人配置 | 无 | 只读 |
| `bili_replies` | 拉某条评论下的整串楼中楼 | `oid` `root`（楼层根 rpid）`page`(1-50) | 只读 |
| `bili_comment_top` | 置顶 / 取消置顶一条评论 | `rpid` + `bvid` 或 `oid` `type` `action`(pin·unpin) | **写 · 过 gate**（`comment`） |
| `bili_dynamic_detail` | 单条动态详情 | `dynId` | 只读 |
| `bili_dynamic_top` | 置顶 / 取消置顶自己的一条动态 | `dynId` `action`(pin·unpin) | **写 · 过 gate**（`dynamic`） |
| `bili_image_upload` | 把本地图片传到 B站 图床，拿回 `img_src` | `path`（本地绝对路径，png/jpg） | 写（真实 POST，吃请求层额度），但**不过 gate**：不产出公开内容 |
| `bili_playurl` | 取播放直链（**带时效**，别缓存复用） | `bvid` `cid`?（不给用第一段）`qn`(1-120，默认 80) | 只读 |
| `bili_user_info` | 用户信息：昵称 / 头像 / 签名 / 等级 / 粉丝数 / 关注数 | `mid` | 只读 · **需 WBI 签名** |
| `bili_relation` | 关注关系：是否关注 / 互关 / 拉黑 | `mid` | 只读 |
| `bili_follow` | 关注 / 取关一个用户 | `mid` `action`(follow·unfollow) | **写 · 过 gate**（`relation`） |
| `bili_at_me` | 「@我的」消息列表（评论区/动态/视频里被 @ 到） | `limit`(1-10，默认 5) | 只读 |

所有工具的参数都是标准 JSON Schema，返回值都是同一个信封：`{ ok:true, data }` 或 `{ ok:false, reason, human, code?, detail? }`。`reason` 只取这十个之一：`bad-argument` `credential-missing` `owner-only` `quota-exceeded` `token-budget-exhausted` `capability-not-found` `bili-error` `network` `not-logged-in` `risk-control`。

## 7. 风控与 token 预算（这套东西是投资，不是装饰）

### 7.1 缓存：只缓存静态元信息

可缓存路径只有两条（`vendor/bili-api.mjs` 的 `CACHEABLE`）：

- `/x/web-interface/(wbi/)?view` —— 视频元信息
- `/x/space/wbi/acc/info` —— 用户信息

外加 `nav`（登录态 + WBI 密钥）单独一份，**只缓存 10 分钟**（密钥会轮换）。其余一律 TTL 24 小时，缓存最多保留 400 条。

**评论、动态流、收件箱、点赞这类会变的东西绝不缓存。** 缓存它们等于让 agent 对着三天前的评论做决定。

### 7.2 退避：撞到风控就熔断

- HTTP **412 / 429** → 熔断；接口层风控码 **-412 / -352 / -799 / -509 / -10403**（HTTP 200 也照样熔断）→ 熔断。
- 时长指数退避：`min(30, 5 × 2^(streak-1))` 分钟，即 **5 → 10 → 20 → 30 分钟**封顶。
- 熔断期间：能吃到旧缓存就吃（仅上面那两条静态路径，最多 7 天前的），吃不到就**明确失败并说清还要等几分钟**，不打网络。
- 熔断状态落在共享的 `api-ban.json`：一个撞 412，另一个也该退。读路径和写路径写的是同一份、同一套字段。

### 7.3 节流：不许贴脸连打

- 读：`vendor/bili-api.mjs` 里 300ms 地板间隔（串行队列，不是并发）。
- 写：走 `vendor/traffic.mjs` 的 `guardedFetch`（预算、冷却、相同写操作去重、412 后暂停），本包另外固定 300ms 地板，防止有人把配置改成 0 之后裸奔。
- 默认间隔 `risk.minGapMs` = 1500ms（守卫的最低地板是 500ms）。

### 7.4 token 预算：**只拦写通道**

额度以**花掉的 token** 为准，不再区分读写次数（2026-11-01 起）。

```jsonc
"budget": { "tokenHourly": 1000000, "tokenDaily": 8000000 }
```

| 项 | 默认 | 含义 |
|---|---|---|
| `budget.tokenHourly` | 1,000,000 | 本小时可花的 token |
| `budget.tokenDaily` | 8,000,000 | 本天可花的 token |

- **口径**：`input + output`，**不含** cacheRead / cacheWrite / reasoning，单位 token。
- **数据来源**：`<DSH_HOME>/dsh-usage/usage-ledger.json`（宿主写的用量账本，按天 / provider / model 记 `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` / `calls` / `cost`；只累加 `inputTokens + outputTokens`）。日期键取**本地日**，本地日不存在而 UTC 日存在时用 UTC 日。测试可用环境变量 `DSH_BILI_USAGE_LEDGER` 指向临时账本。
- **小时用量靠采样差分**：账本只有**按天**粒度，所以"今天已用"直接取当天合计，"本小时已用"是把两次采样之间的差值累加到当前小时桶；采样状态存在 `<stateDir>/token-budget.json`（字段 `{ hourKey, hourUsed, dayKey, dayBase, sampledTotal }`，原子写），跨进程共享。**第一次采样只建基线**（当日合计不整笔算进本小时），换小时/跨天都把桶清零并重建基线 —— 所以"本小时已用"真的是本小时，不是"今天已用"。
- **预算值必须 > 0 才生效**：写 0 或非数字回落默认，防止手滑把闸门关掉。
- **只拦写通道**：在 `quota.gate()` 里查。读通道（刷视频、看评论、读私信、`bili_status` ……）一条都不查。
- **用尽时**返回 `reason=token-budget-exhausted`，`human` 写清什么时候恢复：小时窗到下一个整点，天窗到次日零点。实际文案（离线实测）是「本小时已花 1,043,200 token（上限 1,000,000）—— 写通道暂停，15:00 恢复；读通道仍可用」，`detail` 里带 `window` / `hour` / `day` / `source`。
- **fail-open**：账本读不到 / JSON 坏 / 路径不存在 → **不拦**，但状态里标 `source:'unavailable'`（`bili_status` 会显示这一项）。采样状态文件写不进去只降精度，同样不锁写通道 —— 不能因为宿主没写账本就把插件锁死。
- **跨天重置**跟随账本的日期键。

### 7.5 写通道：gate → 发 → record

五条代码路径（`api/comment.js`、`api/dynamic.js`、`api/message.js`、`api/favorite.js`、`api/relation.js`）用的是同一套写法：

1. `quota.gate(config, { type, target })` —— 顺序是 **token 预算 → 写间隔**，任一不过就返回结构化失败（`token-budget-exhausted` / `quota-exceeded`），**不发请求**，也**不记账**；
2. 发请求；
3. **只有发成功**才 `quota.record(config, { type, target, note })`；记账本身失败只记一条日志，绝不把"已经发出去"说成失败（那会让模型重发一条）。

过闸的八个 `type`：`comment` `reply` `dynamic` `dynamic_edit` `dm` `favorite` `like` `relation`（`WRITE_TYPES` 里还留了 `danmaku`，本期没有对应工具）。`relation` 是第二批新增的 —— 关注/取关会在账号上留下真实的公开关系变更，所以它和发评论同一套闸，而不是"顺手点一下"。

`quota.json` 仍然是**内容账本**（人能看到"今天到底发了什么"），和 token 预算不是同一件事：一个记"花了多少 token"，一个记"发了什么"。

### 7.6 平台安全带（与额度无关，一条都没放松）

| 项 | 默认 | 含义 |
|---|---|---|
| `risk.minGapMs` | 1500 | 两次请求的最小间隔 |
| `risk.writeGapSec` | 120 | 两次写之间最小间隔（最低 30，写不出更小的） |
| `risk.dmGapSec` | 60 | 两次私信之间最小间隔（允许 0） |
| 412 / 风控码 | — | 熔断 5→10→20→30 分钟（见 §7.2） |
| 相同写操作 | — | 守卫层去重，同一个动作不会连发两次 |

这些是 B站 平台风控的安全带，**和 token 额度无关**：预算再宽也不会放宽它们，预算用尽也照样拦。

**已废弃**：`risk.readHourly` / `risk.readDaily` / `risk.writeHourly` / `risk.writeDaily`。它们**仍在**配置默认值里（旧配置文件照常合并、不会炸），但**不再参与任何判定**，设置页也不再提供这四项 —— 额度只看 §7.4 的 token 预算。默认值本身被放到了 10,000,000（`DEPRECATED_COUNT_LIMIT`）作为第二道保险：vendor 的请求守卫里还留着一份按次数的读数，这个量级等于是"不拦"。

配置文件：`<DSH_HOME>/dsh-bili.config.json`（本机默认 `D:\DSH\dsh-home\dsh-bili.config.json`，可用环境变量 `DSH_BILI_CONFIG` 指走）。优先级：**内置默认 ← 插件配置（apply 第二参）← 配置文件**，后面的赢；文件坏了只影响它自己那一层，不抛。每次调用现读，所以改完立刻生效、不需要重启。

## 8. 「她」：自主运营层

内核之上还有一个人格化的调用者 —— **她**。她自己决定醒不醒、说不说话、说什么，但**动作用的是同一批工具**。

### 8.1 两层结构

| 层 | 有什么 | 负责 |
|---|---|---|
| 内核 | 25 个工具、9 种写类型、token 预算闸、风控安全带、私信硬限制 | 认证 / 节流 / 熔断 / 预算 |
| 自主层（她） | 人设、记忆、日记、日程、大脑、动作 | 自主层自己决定"说什么"；动作一律走已注册工具 |

关键点：**自主层是"另一个调用者"，不是特权用户**。它不 import `api/*`、不拼 B 站请求，只通过 `deps.tools`
里已注册的工具动作 —— 所以风控、token 预算、"私信只能发给主人"这些约束，对它**自动生效**，不需要另写一遍。

### 8.2 三条隔离

1. **动态 import**：`lib/core/autonomy.js` 是 `import()` 进来的。这个模块坏了也只记一条 warn，内核照常加载 —— 静态 import 做不到这一点。
2. **`ctx.llm` 缺失就不启动**：宿主没提供 llm → 自主层不启动，**25 个工具照常可用**。
3. **只把工具表交给它**：交给它的是"工具名 → 工具定义"的表，没有 api 层、没有 HTTP 客户端。

装配顺序（全在 `lib/index.js` 末尾，前面那几步一个字没动）：**工具注册 → 内核设置页路由（`/dsh-bili/api/kernel/*`）→ 「她」的设置页路由（`/dsh-bili/api/self/*`）→ 自主层启动**。这几个可选依赖各挂各的，任何一个失败只 warn 一条，工具不受影响。

### 8.3 数据目录

`<DSH_HOME>/dsh-bili-self/`（本机默认 `D:\DSH\dsh-home\dsh-bili-self`）：

| 文件 | 内容 | 规则 |
|---|---|---|
| `persona.md` | 人设 | 可编辑，**即时生效**（每次现读，不用重启）；开头是一小段 front-matter（`name` / `ownerTitle`），下面才是正文 |
| `memes.json` | 热梗库 | ≤**40** 条（`meme` / `meaning` / `example` / `seen`）；`updatedAt` 距今 **≥30 天**会被尝试刷新 |
| `memory.jsonl` | 记忆 | 一行一条，上限 **2000 行**滚动（超了从头丢） |
| `diary/YYYY-MM-DD.md` | 日记 | 只追加，一天一个文件 |
| `schedule.json` | 日程 | 窗口 / 间隔 / 抖动 / 上限 / 通道开关 / 模型路由 |
| `state.json` | 运行状态 | 当日计数、连续失败、静默截止时间、上次 LLM 失败、**六项指标 `metrics` 与 `metricsHistory`（最近 50 条）** |
| `audit.jsonl` | 审计 | 每个对外动作一行；正文**截 80 字**，键名脱敏（凭据永不落盘） |

### 8.4 默认档位：只读 + 私信主人

评论 / 回复 / 动态 / 点赞 / 关注**默认全关**。

| 项 | 默认 |
|---|---|
| `enabled` | `true` |
| 开启的通道 | `read` + `dm`（其余六个键 false） |
| 清醒时段 `windows` | `[{ 20:00–24:00 }]`（**1–6 个**，可跨午夜） |
| 周末全天 `weekendAllDay` | `false`（打开 = 周六周日 00:00–24:00 一直在线） |
| 间隔 | 45 分钟，抖动 ±20%；周末用 `weekendIntervalMin`（默认回落到 `intervalMin`） |
| 每次醒来写动作上限 | 2 条 |
| 每日上限 `caps` | `{ dm: null, comment: null, reply: null, dynamic: 2, like: null, follow: null }` —— **只有发动态仍限每天 2 条**，其余默认不限 |
| 事件插队 | 每 5 分钟读一次私信（`limit` 3），有新消息就插一次队 |
| 计划器心跳 | 每分钟看一次"是不是该醒了" |

**每日上限的三种取值**（`caps.<通道>`）：

| 值 | 含义 |
|---|---|
| `null` | **不限**（默认值就是它，除了 `dynamic`） |
| 数字（0–1000） | 每天最多这么多条 |
| `0` | **禁止**这个通道 |

`null` 与 `0` 是两回事，**不能拿 0 当"不限"的哨兵**：`0` 是"这条通道关死"，`null` 是"不设上限"。
计数照旧记录（`todayCounts` 一直在涨），只是**超过不拦** —— 观测与限制是两件事，取消上限不等于不看数。

**`nextWakeAt` 的口径**：窗口外返回**最近的未来时段起点**（例如 15:00 查、时段 `20:00–24:00` → 当天 20:00；周六且开了周末全天 → 周六 00:00 也算一个起点），窗口内返回"现在 + 间隔 ×（1 ± 20%）"；**只有 `enabled:false` 才返回 `null`**。返回具体时刻是为了让定时器直接睡到点，不必每分钟自己再问一次（也就没有整夜的空转醒来）。

### 8.5 六项指标：她会变，而且是规则算出来的

六项 0–100 的整数（改完即 clamp），落在 `state.json.metrics`；`metricsHistory` 只留最近 **50 条**变化（存**差量**，不存全文）。

| 指标 | 默认 | 含义 |
|---|---|---|
| `energy` 精力 | 60 | 今天还能不能动 |
| `mood` 心情 | 55 | 今天顺不顺 |
| `curiosity` 好奇 | 65 | 想不想深挖 |
| `affinity` 亲近 | 50 | 跟主人有多近 |
| `boredom` 倦怠 | 30 | 是不是腻了 |
| `confidence` 自信 | 45 | 敢不敢说 |

事件表（固定规则，**模型不许自己改这些数字**）：

| 事件 | 变化 |
|---|---|
| 醒来 `wake` | energy **−2** |
| 只读动作 `read-action` | energy **0（看不算消耗）** |
| 写动作 `write-action` | energy **−3** |
| 动作成功 `action-ok` | confidence +1 |
| 动作失败 `action-fail` | confidence −3 |
| 撞风控 `risk` | mood −8 · confidence −5 · energy −5，并**当场静默 2 小时** |
| 兴趣命中 `interest-hit` | mood +3 · curiosity +2 |
| 重复 `repeat` | boredom +4 · curiosity −2 |
| 私信发出 `dm-sent` | affinity +5 |
| 主人回复 `owner-reply` | affinity +10 |
| 跨天 `day-pass` | energy **+15** · boredom −5 · mood **向 50 靠 1** |

**精力还会按小时自己恢复**（`regenEnergy`）：从上次结算点起按**整小时**结算，**每一小时的起点各判一次在不在窗口内** ——
窗口内（醒着没事干）+3/h、窗口外（睡着）+6/h，封顶 100。所以"19:00–21:00 跨进 20:00 窗口"这段是按各自小时拆开算的，
不是整段用一个速率。不足 1 小时不结算、余数留着下次接着攒；`state.lastRegenAt` 记"已经结算到哪一刻"，
同一时刻反复调用不会叠加（`added` 直接为 0）。

**为什么"看不算消耗"**：看视频是她的基本生活方式，不该越看越累 —— 旧参数（醒来 −3 / 只读 −1 / 写 −4）下，加速测
（5 分钟一次醒来）一小时就把 `energy` 从 60 打到 15；换算到正常节奏（一晚约 15 次醒来）同样会在清晨前累瘫，然后整晚不说话，
而当时唯一的恢复是跨天 +25。改成"醒来 −2、看 0、写 −3 + 按小时恢复"之后，**只有醒来与发言付钱**。

**指标真的会改变行为（代码强制，不是提示词）**：

| 条件 | 效果 |
|---|---|
| `energy < 20` | 只关公开通道（`comment` / `reply` / `dynamic` / `like` / `follow`），**保留 `read` + `dm`** |
| `energy < 10` | 全关（连 `read` 与 `dm` 也关）—— 语义上等价于 `enabled:false` |
| `confidence < 30` | 关 `comment` / `reply` / `dynamic`（`like` 仍在） |
| `confidence < 15` | 连 `like` / `follow` 也关 |
| `affinity < 40` | 私信配额 ×0.5 |
| `affinity < 20` | 不主动开口（`noSpeak`） |
| `boredom > 70` | 优先换口味（`preferDynamic`：有权限时先考虑发动态） |
| `mood < 30` | 台词 ≤30 字（`sayShort`） |
| `curiosity < 25` | 不探索（`noExplore`）：跳过 `bili_search` / `bili_playurl`，原因记 `low-curiosity`（`bili_watch` 不受影响） |

这些全在 `core/metrics.js` 的 `effectiveAllows()` / `behaviorHints()` 里，而且**指标只能收紧、不能放开**：
它不改 `schedule.allows` 本身，只在这一次执行里生效。

`curiosity` 有硬闸，但它关的是**探索**而不是**说话**：阈值 `CURIOSITY_EXPLORE_MIN = 25`，低于它 `behaviorHints.noExplore = true`，
执行时把 `EXPLORE_TOOLS`（`bili_search`、`bili_playurl`）跳过，跳过原因是 `low-curiosity`，并在上下文里多一句
「今天不太想探索，热门刷两眼就行。」

**`bili_watch` 故意不在 `EXPLORE_TOOLS` 里**：低好奇的时候"刷两眼热门"正是她该做的事 —— 把刷也关掉，等于把无聊判成了瘫痪。
同样地，`bili_playurl` **必须**在白名单里：否则低好奇时它先被白名单拦掉（`why: "whitelist"`），`low-curiosity` 这个原因
永远看不到，那条规则就成了假的。

**`interest` 从哪来**：大脑在决策 JSON 里标 `interest: true`（**决策级或单条动作级都认**），一次醒来最多记一条 `interest-hit`。
判据是"这次刷到的内容真的命中人设第三节的『会让我停下来的』"—— 不确定就不置。

指标含义与人设规则写在 `$DSH_HOME/dsh-bili-self/persona.md` 的**第六节**（可编辑、**即时生效、不用重启**）。
那里是给人读的版本，代码口径以本节为准。

### 8.6 六道闸（按顺序）

| # | 闸 | 管什么 |
|---|---|---|
| 1 | **白名单**（16 个工具，见 §8.7） | 大脑只能提议名单里的动作 |
| 2 | **私信 owner-only** | `bili_dm` 的收件人恒等于 `owner.mid`；`args` 里只要带了收件人参数就整条拒掉（先于通道开关判，硬限制不该排在配置后面） |
| 3 | **通道开关** `schedule.allows` | `comment` / `reply` / `dynamic` / `like` / `follow` 默认关；**六项指标还能把它收得更紧**（`effectiveAllows`，见 §8.5） |
| 4 | **token 预算** | 写通道照样过 `gate()`：预算用尽 → `token-budget-exhausted`，这一轮写动作一条都不发 |
| 5 | **每日上限 + 每次醒来上限** | `effectiveCap(caps.<通道>)`：`null` 直通（不限）、`0` 禁止、数字按上限；私信**只有设了上限**才按 `dmFactor` 折算（4 × 0.5 = 2；`null` × 0.5 还是不限）。外加每次醒来最多 2 条写 |
| 6 | **内容指纹去重** | 同一条内容不会连发两次 |

每个**真正对外执行**的动作都往 `audit.jsonl` 写一行；被闸拦下的也留在审计/状态里，所以"她今天为什么没说话"是能查的。

> 白名单约束的是**大脑提议的动作**。事件插队那条路自己调 `bili_dm_inbox`（只读、`limit` 3）判断有没有新消息 —— 那是触发逻辑，不是对外动作。

### 8.7 白名单（16 个）

`bili_watch` `bili_video_info` `bili_search` `bili_comments` `bili_replies` `bili_user_info` `bili_relation`
`bili_like` `bili_favorite` `bili_comment` `bili_reply` `bili_dm` `bili_dynamic` `bili_follow` `bili_status` `bili_playurl`

不在名单里的 9 个（25 − 16）：`bili_comment_del`、`bili_dm_inbox`、`bili_dynamic_edit`、`bili_dynamic_detail`、
`bili_fav_list`、`bili_comment_top`、`bili_dynamic_top`、`bili_image_upload`、`bili_at_me`。

`bili_at_me` 不在白名单不是遗漏：它由自主层"检查 @我"那条链路**直接调用**（和事件插队读 `bili_dm_inbox` 一样），
是触发逻辑而不是让大脑提议的动作。

其中 `bili_image_upload` 是刻意不给她用的：传图会吃请求额度、又不产出公开内容；需要配图时由 `bili_dynamic` 内部替她传，
路径还在她手里。`bili_dm_inbox` 不进白名单也不影响事件插队 —— 那条路是触发逻辑，自己读一次（见 §8.6 的注）。

其中 `bili_comment_top` / `bili_dynamic_top` 虽然**进不了**白名单，但**已经做好通道映射**（`comment` / `dynamic`）——
将来哪天被加进白名单，它们不会绕过通道开关与每日上限。

### 8.8 大脑

```js
await ctx.llm.stream({ system, messages, provider, model, signal })   // provider/model 可省 → 用宿主默认路由
```

- **60 秒软超时**：超时按 `llm-stream-failed` 处理，不把一次 tick 拖死。
- **四类失败可区分**：`llm-unavailable`（宿主没有 `stream()`）、`llm-route-missing`（`provider/model` 填错）、`llm-stream-failed`（流失败 / 超时）、`brain-parse-failed`（模型输出解析不出来，重试 1 次后放弃）。
- **只降级不抛**：失败只让这一轮变成"不说话"，并把原因记进 `state.json` 与审计 —— 内核和工具完全不受影响。

### 8.9 设置页、手动与停用

设置侧栏里**只有一个入口「B站账号」**（`settings.section` 只注册一次，id `bili`、order 9）；进去之后顶部是两个**标签页**：
**「账号」**（内核：凭据 / token 预算 / 间隔）与 **「她」**（自主层），各自独立一整页，默认显示「账号」。

⚠️ **切标签 = 子组件重新挂载**：两个标签不是"常驻 + 隐藏"，切换时未保存的草稿会丢弃（这也是它不做状态缓存的原因 ——
宁可让你重填，也不让你在一个"看着还在、其实是被缓存的旧数据"的表单里点保存）。要留就先把当前页保存掉。

「她」这一页有**八条**同源路由（`/dsh-bili/api/self/*`）：
`state` / `settings` / `persona` / `run-once` / `audit` / `profile` / `memes` / `meme-refresh`。
连同内核那三条（`/dsh-bili/api/kernel/*`），本插件一共 **11 条**同源路由。

- **总开关**：关掉之后她不再自己醒（tick 返回 `disabled`），只剩人设展示与只读能力。
- **开关区一共 8 个开关**（默认只有 `dmEveryWake` 是关的）：

| 开关 | 默认 | 管什么 |
|---|---|---|
| `minWatchPerWake` | 开 | 每次醒来至少看一个视频 |
| `atOwnerOnComment` | 开 | 发评论时自动 @主人 |
| `bedtimeReport` | 开 | 睡前私信汇报 |
| `commentAfterWatch` | 开 | 看完视频兜底补一条评论（见 §8.10） |
| `replyToDm` | 开 | 回主人的私信 |
| `replyToComments` | 开 | 回评论区里"直接回她"的那条 |
| `replyToMentions` | 开 | 回「@我的」里坐标齐全的那条 |
| `dmEveryWake` | **关** | 每次醒来都发一条私信（可能一晚十几条，默认不开） |

- **几个复选框的具体含义**：
  - **评论自动 @ 主人**（`atOwnerOnComment`）：开着时模型没显式给 `atOwner` 也会补 `true`（见 §8.10）；
  - **睡前汇报**（`bedtimeReport`）：关掉就不发那条"今天做了什么"的私信；
  - **看完必须评论**（`commentAfterWatch`）：关掉就不再做"看完兜底补一条评论"，只剩模型自己决定要不要说。
  后端按**布尔**校验，传非布尔值直接 400。
- **状态指标（只读）**：`GET /dsh-bili/api/self/state` 返回 `metrics`（六项数值）、`behavior`（含 `noExplore` 这类行为提示）
  与 `metricsRecent`（最近 **5 条**变化）。前端「她」页有对应的只读块：六行数值 + 摘要 + 最近变化，**没有任何输入框**。
  这些数字刻意不给手工编辑 —— 要改就改人设，或者等经历把它改掉。`core/metrics.js` 缺失时 `/state` 仍回 200，
  但带 `available:false`（界面据此禁用按钮，而不是报错）。
- **七个通道开关**：`read` + 六个对外通道。
- **身份**：两个输入框只改 `persona.md` 头部的 `name` / `ownerTitle`（各 ≤**20** 字，空值拒绝），**正文一个字节不动**；
  缺 front-matter 时回默认 `赛博友人` / `主人`。
- **作息**：**时段列表**（可增删，1–6 段、每段 `HH:MM`、允许跨午夜与 `24:00`）+「周六周日全天在线」复选框（勾上才出现「周末间隔」）+
  间隔与抖动；三个预设（夜行 / 白天 / 全天）**只填表单、不自动保存**（见 §8.10）。
- **每日上限：界面上只有「发动态」一个输入**（占位 `2`，留空 = 不限、填 `0` = 禁止）。
  区间里两行说明写得很直白：
  **「其余动作（评论 / 回复 / 点赞 / 关注 / 私信）不设上限；如需限制，可编辑 `schedule.json` 的 `caps`。」**
  与 **「上限只是自控；真正拦住高频的是 token 预算与两次写之间的间隔（120 秒）。」**
  保存时**只提交 `caps.dynamic`**（后端是部分更新，其余五项保持原值 `null` = 不限）—— 界面简化不会把已有配置写坏。
  要限制其余五项仍然可以：直接改 `schedule.json` 的 `caps`（`null` 不限 / `0` 禁止 / 0–1000 数字），内核照旧执行。
- **模型路由**：留空 = 宿主默认。
- **热梗库**区块：更新于几天前 · 几条 · 来源 · 状态，外加「立即刷新」与**前 10 条**梗（见 §8.10）。
- **人设编辑**、**"现在醒一次"**、**审计与今日日记**查看。
- 手动叫醒：`POST /dsh-bili/api/self/run-once`。

### 8.10 身份、作息、热梗库与「醒了必留痕」

#### 身份（可改，但只改头部两行）

`persona.md` 是 front-matter + 正文：

```markdown
---
name: 小桃
ownerTitle: 主人
---

# 赛博友人
…
```

- 设置页的两个输入（`POST /dsh-bili/api/self/profile`）**只重写头部那两行**，正文**逐字节不动**（有测试用"带连续空行 + 行尾空格"的正文钉死这一点）。
- 各 ≤**20** 字；空值直接拒绝（不会把名字清成空）。
- 文件没有 front-matter / 字段缺失 → 回默认 `赛博友人` / `主人`，**不抛**。
- 头部里除了这两个键之外的行原样保留，只把 `name` / `ownerTitle` 排到最前。

#### 作息 = `schedule.json` 的**时段组** + 周末 + 间隔/抖动

一天可以有**多个清醒时段**，不再是"一个窗口"：

```jsonc
{
  "windows": [ { "start": "09:00", "end": "12:00" }, { "start": "14:00", "end": "18:00" } ],
  "weekendAllDay": false,
  "weekendIntervalMin": 90,
  "intervalMin": 45,
  "jitter": 0.2
}
```

| 字段 | 规则 |
|---|---|
| `windows` | **1–6 个**时段；每项 `{start,end}` 都是 `HH:MM`（`end` 允许 `24:00`）；**允许跨午夜**：`start > end` 表示"到今天 end 为止/次日"；只有 `start === end` 才非法 |
| `weekendAllDay` | 布尔。`true` 时本地周六/周日 **00:00–24:00 全天在线** |
| `weekendIntervalMin` | **5–720** 分钟；缺省回落到 `intervalMin`（周末用它当醒来间隔） |
| 兼容 | 旧文件里的 `window:{start,end}` 读入时当**单项数组**；写盘时 `windows` 与 `window` **同时写**，`window` 恒等于 `windows[0]` |

判定口径：

- **在不在窗口**：任一时段命中即在线（`inWindow`）；跨午夜按"今天开始 → 明天结束"算。开了 `weekendAllDay` 且当天是周末 → 直接算在线。
- **下一个起点**：`nextWindowStart` 取**最近的未来起点**；已经在窗口内则返回 `null`（没有"起点"可言）。
- **下一次醒来**：窗口内 = 现在 + 间隔 ×（1 ± jitter）；窗口外 = 最近起点。

设置页给了三个预设（**只填表单，不保存** —— 还要点「保存设置」才落盘；点完会提示"已填入「夜行」预设…"）：

| 预设 | `windows` | `intervalMin` |
|---|---|---|
| 夜行 | `[20:00–24:00]` | 45 |
| 白天 | `[09:00–12:00, 14:00–18:00]`（**两段**：午休也歇着） | 60 |
| 全天 | `[00:00–24:00]` | 90 |

时段列表在界面上是**可增删的**（`+` 添加 / 删到至少留 1 个，上限 6 个），另有「周六周日全天在线」复选框，勾上后才出现「周末间隔」输入框。

#### 看完会真的说话：评论并 @ 你

- **每轮至少一条**：brain 的 system 第 9 条要求"看完视频后用 `bili_comment` 在该 bvid 下说一句并 `atOwner: true`；
  没特别想说的就写一句实话（例如「看完这条了，先记着」），**不要编造观点**；同一个视频已经评论过就别再发"。
  也就是说：**"没话说就不发"已经不是 2026-11-01 之前那条规则了** —— 现在由**代码兜底**保证至少一条（见下）。
- **代码兜底（§22）**：每轮 tick 结束时，如果**这一轮看过视频**（`bili_watch` / `bili_video_info` 成功）且**没发出过评论**，
  `ensureCommentAfterWatch()` 会补一条：
  - `bvid` 取 `state.lastWatchedBvid`（`actions` 在观看成功后写的）；没有可用 bvid → 只记审计、跳过；
  - 正文优先用这一轮她自己的 `thought.say`（去掉开头连续 @、压掉换行与多余空格、**≤120 字**）；空则用固定句「**看完这条了，先记着。**」；
  - `atOwner` 仍受 `atOwnerOnComment` 控制；审计记 `args.commentFallback: true`、`why: '看完评论（兜底）'`（被闸挡下时 why 里带原因）；
  - **每轮最多补一条**，失败/被跳过不重试。
  - 关键：兜底走的是 `runActions()`，所以**六道闸一条都没绕** —— `allows.comment` / 指标收紧（confidence） / 每日上限 /
    写间隔 120 秒 / 同 bvid 去重 / token 预算都照旧生效。绕过去等于开后门，这条是设计红线。
- 动作层：`bili_comment` 若模型**没显式给** `atOwner`，且 `schedule.atOwnerOnComment !== false`（默认 `true`）→ **自动补 `atOwner: true`**。
  于是评论正文前面会带上「@主人昵称」—— 这是"她会主动叫你"的机制；关掉这个开关，评论就变成"不叫人"的普通评论。
- **同一个 bvid 不会重复评论**：`state.commentedBvids` 保留最近 **100** 个；命中 → `skipped: "already-commented"`。
  这条判断**在所有写闸之前**（不消耗 120 秒写间隔，连工具都不调）。去重键是 **bvid**，不是正文 —— 同一个评论区刷屏跟措辞无关。

#### 回别人：评论区与「@我的」

两条回复链路共用**一个 30 分钟节流窗**（`state.lastReplyCheckAt`，`REPLY_CHECK_GAP_MS`）：所以一晚大约查 **6 次**回复机会，而不是每次醒来都查 30 次。
每轮最多回一条。

**① 评论区回复（`replyToComments`）** —— 判据被收紧了，四条全满足才回：

| 条件 | 为什么 |
|---|---|
| `root === 她的 rpid` | 必须是挂在她那条楼层下面的回复 |
| `parent === 她的 rpid` | **必须是"直接回她"**（回她这条），不是回楼里别人的话 |
| `mid !== selfMid` | 她自己的回复不算"别人回我" |
| `rpid` 没见过 | 同一楼层的回复不重复回 |

第三条里 `selfMid` 有自愈：不知道自己的 mid 时会**先查一次再判**，否则会把"自己的回复"当成别人新回复去回。

**② 「@我的」（`replyToMentions`）** —— `bili_at_me` 拿到的每条 @ 会：

- 坐标齐全（`oid` + `root` + `rpid` 都有）→ 用 `bili_reply` 回一句（每轮最多 1 条）；
- **只解析出 `oid`（缺 root/rpid）→ 不回**，审计写「坐标不全」并带上三个值 —— 宁可不回，也不发成一条顶层评论；
- 新 @ 一律记为"看过了"（`state.seenAtMeIds`），哪怕这条回不了，否则每轮都会把同一条翻出来。

#### 睡前汇报

本窗口**最后一次醒来**（算出来的下一次醒来落在窗口外）时，用**确定性模板**（不调模型）拼一条私信发给主人：

```text
今天这会儿我做了这些：
· 看了 N 条视频（B 站热门/排行/关注）
· 说了 M 句（评论 a 条、回复 b 条、动态 c 条）
· 现在：精力 X · 心情 Y · 倦怠 Z
· 最后一句话：「…」        ← 本轮 say → 上一轮 lastLine → 两者都空则整行省略
睡一会儿，醒来再说。
```

- 审计记 `tool: 'bili_dm'`、`args.report: true`、`why: '睡前汇报'`。
- 去重：**每个窗口最多一条**（按窗口起点比较）+ **30 分钟兜底**；私信通道关着就不发。
- 失败**不重试、不阻塞、也不记已发**（下一次还会再试）。
- **为什么不调模型**：省一次调用、内容可预测（数字全来自 `todayCounts` 与 metrics），而且汇报本身不该再花 token / 精力。

#### 热梗库（`memes.json`）

| 项 | 规则 |
|---|---|
| 容量 | ≤**40** 条，每条 `{ meme, meaning, example, seen }` |
| 刷新周期 | `updatedAt` 距今 **≥30 天** |
| 频率上限 | **一天最多尝试一次**（成功失败都记 `lastAttemptAt`） |
| 来源 | 三级如实标注：`web_search` → `llm` → `unavailable`（**不许冒充**） |
| 失败 | 保留旧列表，只把 `stage` 标 `stale` 并记 `lastMemeError` —— 绝不写空库 |
| 触发时机 | **只在定时醒来时尝试**，不在设置页被动刷新 |
| 界面 | `GET /dsh-bili/api/self/memes`：更新于几天前 · 几条 · 来源 · 状态，+「立即刷新」+ 前 10 条 |

`POST /dsh-bili/api/self/meme-refresh` 是手动刷新：**30 秒超时**，同一次没跑完再点回 **409**。
刷新进上下文的是**按 `seen` 升序取的 12 条**（`pickForPrompt`），`meaning` 为空的梗不参与。

#### 用梗规矩

规矩写在**两处**：`brain.js` 的 system 段落（A–D 四条）与 `persona.md` 正文（改人设不会把规矩弄丢）。
但真正拦得住的是内核，不是提示词 —— 逐条分清楚：

| 规矩 | 谁在管 |
|---|---|
| 只能用库里的梗；`meaning` 为空的不用 | **代码**：`pickForPrompt()` 先滤掉空 meaning，进提示的只有库里的 |
| 同一个梗 **7 天内 ≤2 次** | **代码**：`MEME_COOLDOWN_MS = 7 天` + `MEME_MAX_USES_IN_WINDOW = 2`；`pickForPrompt()` **先滤掉窗口内用满 2 次的梗** |
| `seen` 记账 + 审计 `args.meme` | **代码**：`bumpSeen()` 做 `seen+1`、往 `uses` 追加时间戳、裁到最近 **10** 条（`MEME_USES_KEPT`）；梗名进 `audit.args.meme` |
| 一条消息**最多一个梗**、不连用 | **提示层**：内核没有"这条消息里有几个梗"的概念，只能靠模型守 |
| 拿不准意思就不用；与语气冲突就放弃梗 | **提示层**（同上） |

几个落地细节：

- `uses` 是**滚动窗口**（只留最近 10 条时间戳），不是自然周；每条梗的 `seen` 仍是**累计**计数。
- 窗口内用满 2 次的梗**根本不会出现在提示里**；一条不剩时 `pickForPrompt()` 返回空数组 —— 她这轮自然就不玩梗，
  **绝不拿超限的梗凑数**。
- 刷新梗库时**保留 `uses` 历史**，否则每月换库等于给所有梗免一次冷却。

#### 醒了必留痕

每一轮醒来**无条件**留下四样东西 —— "醒了但什么也没做"是常态，不是不存在：

| 痕迹 | 内容 |
|---|---|
| 日记一行 | 优先用决策里的 `diary`；其次用决策的 `say`；都没有就用**兜底句** |
| `lastLine` | **永不为空**（设置页"上一句"不会空着像坏了） |
| 记忆一条 | `memory(kind:"thought")` |
| 审计一行 | `tool: 'wake'`，`args` 带 `trigger` / `energy` / `mood` / `meme` / `say` |

兜底句按 **四组** 分：窗口外 / 太累（`energy<20`）/ 腻了（`boredom>70`）/ 其它，**每组 3 句**，
用 metrics 的数值算索引挑一句 —— 同一档位不同状态会落到不同句子，看起来不像复读。

---

### 8.11 会话模式：让她自己在会话里开车（2026-11-03，真机验证）

默认（`sessionMode: "off"`）她每一步都由内核一次性问模型（`brain.decide`）再执行。
打开会话模式后，改成**她自己在一个常驻会话里想、自己调工具**：

```
tick → 写 wake-context.md（时间/指标/未处理 @/上次看了什么）
     → task_board_run({ taskId: <卡片>, rerun: true })
     → 内核不再 decide、不再调任何写工具（避免两个司机）
```

| 设置项 | 值 | 说明 |
|---|---|---|
| `sessionMode` | `off` / `board` | `board` 才触发任务板卡片 |
| `sessionCardId` | 卡片 id | 任务板里必须有一张开了 **reuseSession** 的卡；**工作区在卡上指定** |

前提与边界：
- 卡片要由人确认一次权限（`workspace-write` 高于会话默认时 `permissionPending` 会挡住运行）；
- 她与会话里调同一批工具，**所有闸（token 预算、写间隔、通道上限、@主人、10 分钟/200MB 深读）仍在工具层生效**；
- 内核只负责定时叫醒她、写上下文、更新指标；
- 真机验证（2026-11-03）：她自己在会话里刷热门/排行、挑一条深读、看楼中楼、回私信；撞到 120 秒写间隔时**自己 sleep 111 秒后重试**。

### 8.12 审计的两个来源

`audit.jsonl` 里有两套行，靠 `source` 区分：

| 来源 | 形状 | 谁写的 |
|---|---|---|
| 自主层 | `{ tool, why:<真实理由>, args, ok, reason }` | 内核每一轮 |
| 工具层 | `{ tool, why:"工具调用", args, ok, reason, source:"tool", by? }` | **每次 `bili_*` 调用**（任何 agent） |

工具层的 `by` 目前是 **callId**（宿主执行上下文只给了这个），能证明「某次调用发生过」，但**不能按会话聚合**。
按会话追查请看会话记录（`$DSH_HOME/sessions/<workspace>/<session>/session.v4.jsonl.zstd`）。

### 8.13 学习层：看过的视频会变成知识（2026-11-03）

她每深读一条（且有摘要）就往 `$DSH_HOME/dsh-bili-self/learning.jsonl` 追加一行：

```json
{"at":"…","bvid":"BV1xx","title":"…","gist":"<摘要前 200 字>","tags":["分镜","三体动画"]}
```

规则：**同 bvid 24 小时内不重复记**；文件超 2000 行只留最近 1500 行；没摘要（`understand-failed` / `empty-summary`）不记。

攒到 **8 条** 或跨过 **24 小时** 归纳一次（一次模型调用，最多取最近 40 条），产出 `knowledge.md` 三节：

```
## 我大概懂了什么（3-6 条）
## 我最近的兴趣（2-4 个主题词）
## 我改变过的看法（0-2 条：以前觉得…现在觉得…）
```

下一轮 `wake-context.md` 会带上「## 我最近在想什么」（knowledge.md 前 800 字）与「## 最近看过」（最近 3 条）。
有新主题时 `curiosity` +1（上限 100）。

**归纳失败绝不覆盖旧文件** —— 一次失败的模型调用不该把她积累的东西清空；失败只记审计、不重试。

## 9. 扩展：两种方向

内核对外只暴露一个东西：`ctx.bili`。

```js
{
  registerCapability(def),      // 挂能力：{ id, kind, description, run, schema? }
  listCapabilities(),           // → [{ id, kind, description }]
  callCapability(id, payload),  // 调别人的能力
  onCapabilityAdded(cb),        // → off()
  getClient(),                  // 带认证 / 签名 / 缓存 / 退避 / 节流的 HTTP 客户端
  getQuota(),                   // 写通道闸（gate / record / status；gate 先查 token 预算，再查写间隔）
  getOwner(),                   // 主人信息
}
```

- **方向 A（扩展 → 内核调用）**：扩展注册能力，内核调。典型例子 `video.understand`：`bili_watch` 的 `deep=true` 就是通过它实现的，内核不需要知道 `dsh-video` 存在。
- **方向 B（扩展 → 内核接口）**：扩展调 `ctx.bili.getClient()` 直接打 B站，认证、风控、节流统一生效（注意它**不带闸门**：既不查 token 预算也不查写间隔；写操作请自己 `getQuota().gate()` / `record()`，或干脆别写）。

注册必须写在 `ctx.inject(['bili'], scoped => ...)` 里，**不要**写成插件导出的 `inject: ['bili']`（那会让你的插件等内核就绪才 apply，顺序不可控）。

调一个还没人注册的能力不会抛异常，返回：

```js
{ ok: false, reason: 'capability-not-found', id: 'video.understand', available: ['video.fetch', ...], human: '…' }
```

完整写法、校验规则（id 必须 `<域>.<动作>`、`kind` 四选一、重复 id 装配期就抛）和可运行的示例见 **[docs/EXTENDING.md](docs/EXTENDING.md)**，示例插件在 [`examples/dsh-bili-echo/`](examples/dsh-bili-echo/)。

## 10. 排障

| 症状 | 先看哪 |
|---|---|
| 模型里一个工具都没有 | `cordis.patch.yml` 的 `name` 是不是完整包名；profile 的 `dependencies` 与 `dsh.profile.bundles` 是不是都改了 |
| 发不出去，读一切正常 | `bili_status`：`bili_jct` 缺了 / 形状不像（回 `-111`）、**token 预算用尽**（`token-budget-exhausted`，看它给的恢复时间）、写间隔还没到、还是熔断中 |
| 想确认到底打了几次网络 | `<HOME>/.bili-ai/api-requests.log`（`NET` 行是真实请求，`HIT` 行是缓存命中） |
| 要强制走真网络 / 关掉缓存与熔断 | 环境变量 `BILI_NO_CACHE=1` |
| 熔断多久恢复 | `bili_status` 的"风控"一行，或 `client.state()` → `{ banned, banMinutesLeft, banWhy, cacheEntries }` |
| 深读报 `capability-not-found` | 没有插件注册 `video.understand`；返回里带了当前可用能力 id 列表 |

## 11. 已知限制（**没验的都写在这里**）

1. **`bili_like` 的端点没在真机验证**：`POST /x/web-interface/archive/like`（表单 `aid` + `like=1|0`）。参考实现里没有点赞视频的写通道，所以它失败时优先怀疑端点，而不是先怀疑参数。
2. **两条私信接口没在真机验证**：`POST https://api.vc.bilibili.com/web_im/v1/web_im/send_msg`、`GET https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs`（后者读不通时会退一步读 `/x/msgfeed/reply`，并在结果的 `source`/`note` 里写明换了语义）。
3. **所有写通道只做过假客户端测试**，没有一条在真实账号上跑过。
4. **本插件在开发阶段未装进 profile** —— 上面 §3 的安装命令与"DSH 启动不崩"都**未实测**。
5. **设置页没在真机点过**：`lib/settings-api.js`（三条路由 + 信任栅栏）与 `lib/client.js`（手写 React、无构建链）都在仓库里，但"打开设置页 → 粘贴 → 保存 → 下一次工具调用立刻生效"这条链路只按代码读过。
6. **测试覆盖不完整**：`tests/` 下已有基于 `node:test` 的用例（跑 `npm test`），但契约 §9 那一串（评论绝不缓存、412 熔断后不再打网络、逐条写通道挂闸、超限拒绝且不记账、非主人私信被拒、日志不含密、解耦静态扫描、共享账本并发原子写……）尚未齐 —— 所以 `npm test` 全绿**不等于**这些规则都被覆盖。
7. **凭据的账号一致性本地无法校验**：`sessdata` 与 `bili_jct` 是否属于同一个号，只有 B站 知道；本地只能查"在不在 / 形状像不像"，真正的结论来自一次写请求的返回码。
8. **私信的 `dev_id` 是进程内随机 UUID**（每次重启都不同）。跨进程稳定性是已知缺口。
9. **收藏只能动默认收藏夹**（标题里带"默认"的那个）：不能指定别的收藏夹、不能建收藏夹。
10. **`unreadOnly` 只活在当前进程**：本插件不往 `~/.bili-ai` 写"读到哪"的状态，重启就全算没读。
11. **`bili_comment_del` 既不预检也不记账**（撤回类动作不占写额度，也不计入任何额度统计）。`lib/api/comment.js` 里另有 `top()`（置顶评论），本期**没有**对应工具。
12. 缓存里"旧数据"最多能撑 7 天，且只对可缓存的静态路径生效；其余路径在熔断期间会直接失败。
13. **`bili_user_info` 依赖 `/x/space/wbi/acc/info`**：这条 wbi 系列接口除了签名，B站 还可能要求额外的风控参数（如 `dm_img_*` 那一族）—— 真机未验。看到它回风控码（而不是 `-404`）时，先怀疑这里，而不是先怀疑 mid。
14. **关注/取关会在账号上留下公开的关系变更**：对方会收到通知，取关也一样；这不是可回滚的本地状态。所以 `bili_follow` 过的是写通道闸（token 预算 + 写间隔），没有"悄悄试一下"的模式。
15. **事件插队只查私信**：每 5 分钟那次读的是私信会话（`bili_dm_inbox`）。"回复我的"没有对应的只读工具，所以评论区的 @ / 回复不会触发插队 —— 她要么在窗口里醒来时读到，要么就错过。
16. **`bili_comment_top` / `bili_dynamic_top` 不在白名单里，但已做好通道映射**（`comment` / `dynamic`）：现在她调不动这两个工具；将来加进白名单时，它们不会绕过通道开关与每日上限。
17. **本期不做**：广告投放、直播（弹幕/舰长/送礼）、视频内容理解。前两项是独立插件的位置；"看懂视频"由能力注册表里的 `video.understand` 提供，内核不实现。
18. **旧格式梗库（`memes.json` 里没有 `uses`）第一次被使用前不受冷却约束**：读文件时 `uses` 缺失按空数组处理（兼容、不抛、也不会把老梗永久封死），
所以升级后的第一轮里，一个"其实昨天刚用过"的梗仍可能被选中一次；它被用完之后 `uses` 就有了，7 天窗口从那时起才真正生效。
19. **热梗库从没在真机上刷新过**：刷新要联网（先 `web_search`、再 `llm`），本轮零网络，所以我只核了 `shouldRefresh` / 一天一次 / 失败保留旧库这些分支的代码，没看过一次真实刷新。首次刷新前 `memes.json` 可能不存在，此时上下文里会明说"这个月还没有可用的梗库内容 —— 今天先不玩梗"。
20. **周末全天用的是本地时区的星期几**：「周六/周日」按本机时区的 `getDay()` 判断，不认客机时区也不认账本时区；
跨午夜时段在周末边界上按"**醒来时刻所在的日期**"判定是不是周末（所以周五 23:00–02:00 这段，周六凌晨那半截算周末，周五深夜那半截不算）。
21. **取消每日上限后，真正约束频率的不是"每天几条"**：默认 `caps` 六项里五项是 `null`（不限），所以别把"没被上限拦"当成"不会太频繁" ——
实际拦住高频的是 **token 预算**（写通道要过 `gate()`）与**两次写之间的间隔**（`writeGapSec` 120 秒 / `dmGapSec` 60 秒），
外加每次醒来最多 2 条写。计数仍然在涨（`todayCounts`），只是超了不拦，所以"今天发了多少"依旧可观测。
22. **睡眠跨窗口边界的恢复按小时拆分归属**：`regenEnergy` 是**逐小时**取速率的（每小时起点各判一次在不在窗口内），
所以 19:00–21:00 这段（窗口 20:00 开始）结算出来是"19 点按窗口外 +6、20 点按窗口内 +3"，不是整段按醒来时刻算。
边界上的实际效果因此取决于**小时切片**而不是"她几点醒"；如果 `schedule` 读不出来（文件坏了），会回落到统一的窗口内速率 +3/h ——
保守但不会让精力永久卡死。
23. **动态/视频正文里的 @ 回不了**：`bili_at_me` 能列出那些 @（`type` 会是 `dynamic` / `video`），但它们**没有 `root`/`rpid` 坐标** ——
   能回的只有评论区里的 @。所以她在动态正文/视频简介里被 @ 时，只会记账到审计，不会回话。
24. **一晚会发不少评论，而且每条都 @ 你（这是真实风险）**：`commentAfterWatch` 默认开，每轮看过视频就至少一条；
   按默认节奏（窗口 20:00–24:00、45 分钟一次）一晚大约 **8–10 条**公开评论，每条都 @主人。B站 对高频评论**可能限流甚至删评**，
   而删评会让"她说过的话"凭空消失（审计里还有记录，站上没有了）。**要刹车就把 `caps.comment` 设成 3–5**（改 `schedule.json`，
   界面上现在只有"发动态"一个输入），或者直接关掉 `commentAfterWatch`。
25. **评论发出去就撤不回来**：自主层**没有** `bili_comment_del` 的权限（它不在白名单里），所以"她评论错了"只能由人手动去删 ——
这也是为什么去重键是 bvid、并且 system 里反复强调"没话说就不发"。
26. **睡前汇报的计数取自 `todayCounts`**（当天累计），**跨午夜会归零**：23:50 那次汇报说"今天看了 12 条"，
00:10 那次可能只剩 0–1 条。数字没错，只是"今天"换了。
27. **token 预算的四个边界**：① 预算用尽只停写通道，`bili_status` 这类读通道照常可用；② 小时用量是采样差分出来的，**同一小时内**进程重启，空档期花掉的 token 会补记进本小时（最多一个采样间隔的量），而**跨小时/跨天**会重建基线、空档期不进新桶 —— 那部分仍然计入当天合计，所以天窗不会漏；③ 跨天重置跟随账本的日期键（本地日优先，回落到 UTC 日），不是本地零点起算的独立计数器；④ 账本缺失时 fail-open（不拦，状态标 `source:'unavailable'`），所以"没拦住"不等于"花得起"。

## 12. 目录

```text
lib/index.js              装配（只装配，零业务逻辑）
lib/core/config.js        配置读写 + 原子写
lib/core/credentials.js   凭据（共享只读 + saveCookie 写回）
lib/core/client.js        B站 HTTP 客户端（GET 走签名/缓存/退避/节流，POST 走守卫 + 自补 csrf）
lib/core/quota.js         写通道闸（gate / record / status，共享 quota.json）
lib/core/tokenbudget.js   token 预算（采样差分，状态在 token-budget.json）
lib/core/capabilities.js  能力注册表
lib/api/{video,comment,dynamic,message,favorite,relation,user}.js   业务读写（user.js 只读但需 WBI 签名）
lib/tools/index.js        25 个工具定义（TOOL_NAMES / buildTools）
lib/core/autonomy.js      自主层入口（start / stop / runOnce / snapshot，自身坏了不影响内核）
lib/core/{schedule,actions,brain,persona,memory,diary,audit,state}.js   自主层：日程 / 六道闸 / 大脑 / 人设 / 记忆 / 日记 / 审计 / 状态
lib/api/self-routes.js    「她」的设置页后端（/dsh-bili/api/self/{state,settings,persona,run-once,audit}）
lib/settings-api.js       设置页后端（/dsh-bili/api/kernel/{status,settings,credential} + 信任栅栏）
lib/client.js             设置页前端（手写、无构建链）
lib/vendor/*.mjs          从参考实现复制来的底层（WBI 签名、请求守卫、凭据、路径），复制即独立
tests/*.test.mjs          node:test 用例（npm test）
docs/INTERFACE.md         装配契约（签名以此为准）
docs/ARCH.md              分层、请求路径、共享状态与并发
docs/EXTENDING.md         写一个扩展插件
examples/dsh-bili-echo/   可加载的示例扩展（不装进 profile）
```

## 13. 开发

```powershell
node --check lib/index.js         # 语法检查（ESM）
node --check lib/tools/index.js
npm test                          # node --test tests/*.test.mjs
```

本包是 ESM，Node >= 20。宿主给插件的 ESM 解析插桩**没有覆盖 workspace 路径**，所以 `lib/` 里不许静态 import 任何宿主私有包（`@deepseek-ai/*` 那一族），入口层零宿主静态依赖 —— 这是"能加载"的前提，不是风格偏好。

## 14. License

MIT
