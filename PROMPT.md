# 提示词：实现 DSH 插件 `@owl-zxk/dsh-bili` —— B站账号管理内核

> 把下面整段（从「# 任务」到末尾）交给一个编码代理即可。
> 文中所有路径、端点、风控参数均已在目标机器上实测确认，**不要重新探测**。

---

# 任务

实现一个 DSH 插件 `@owl-zxk/dsh-bili`，它是一个**B站账号管理内核**：
让 agent 能以主人的 B站账号身份读和写 —— 刷视频、评论并@主人、回复别人的评论、
**仅与主人私信**、发动态、收藏视频等。

**但不要试图把功能做全。** 本插件只负责「账号内核 + 基础读写能力」，
**其它能力（尤其是内容理解类）由独立插件实现**，通过本插件暴露的能力注册表挂进来。
例如「理解视频」由 `dsh-video` 提供。

最后有一节**候选插件清单**，列出已知的缺口，由你（人类）决定接下来开发哪个。

工作目录：`D:\DSH\deepseek harness\wokrspace\dsh-bili`

---

## 0. 定位与边界

| 是 | 不是 |
|---|---|
| B站账号的**认证内核**（凭据 / WBI 签名 / 风控 / 配额） | 内容生产器 |
| 基础读能力（视频信息、评论、动态流、收藏夹、搜索） | 内容**理解**（那是 `dsh-video`） |
| 基础写能力（评论、回复、动态、私信、收藏、点赞） | 人设 / 记忆（那是 `dsh-lanpangzi`） |
| 能力注册表（供别的插件挂进来） | 一个包办一切的巨型插件 |

**一句话：内核管「怎么安全地跟 B站说话」，扩展管「说什么」。**

---

## 1. ⚠️ 最重要的前提：复用实现，但**必须与 `dsh-bili-whale` 解耦**

`D:\DSH\dsh-home\whale-src\dsh-bili-whale\` 是一个**完整可用**的同类实现
（37 个命令脚本、约 7000 行、32 个端点已在真实账号上跑通）。
**它是你的基线，不是参考实现。**

### 1.1 复用的方式：**复制源码，不引用包**

把需要的文件**复制**进你的包，然后按新架构改写。

| 文件 | 行数 | 提供什么 | 为什么不能重写 |
|---|---|---|---|
| `tools/lib/bili-api.mjs` | 230 | **WBI 签名**（`signWbi` + MIXIN 表）+ **三层保护** | 见 §1.3 |
| `tools/lib/cred.mjs` | 85 | 凭据统一层 + **错误码人话翻译** | 少一个翻译就多一份困惑 |
| `tools/lib/quota-gate.mjs` | 35 | 写通道配额闸（`gate()` 发前 / `record()` 发后） | 漏挂一条写通道 = 裸奔 |
| `tools/lib/traffic.mjs` | 237 | 请求守卫（`guardedFetch`） | 风控的第一道闸 |

**重写 WBI 签名或退避逻辑是纯粹的退步。**

### 1.2 解耦红线（**违反即不合格**）

| 红线 | 具体要求 |
|---|---|
| ❌ 不引用旧包 | 新插件的源码里**不得出现** `dsh-bili-whale` 任何形式的 import / require / 动态路径拼接 |
| ❌ 不声明依赖 | `package.json` 的 `dependencies` / `peerDependencies` / `optionalDependencies` **都不得有** `dsh-bili-whale` |
| ❌ 不改旧插件 | **一个字节都不许改** `whale-src\dsh-bili-whale\` 下的任何文件（包括注释） |
| ❌ 不读旧插件的私有数据 | 不读 `DSH_HOME\whale-work\`、不读它的日记 / log / 状态文件 |
| ❌ 不注册冲突的全局钩子 | 不注册与旧插件相同的定时器 / 路由 / 全局事件（见 §1.5） |
| ✅ 复制即独立 | 复制过来的文件在**你的包里**自成一派，改坏了也不影响旧插件 |

**判定标准**：`dsh-bili-whale` 被卸载后，你的插件**功能完全不受影响**。
这条要有自动化测试（§9）。

### 1.3 `bili-api.mjs` 的三层保护（B站 412 是 IP 级限流，换接口救不了）

```
① 缓存  同一份元信息 24 小时内只问一次 B站
        只有「静态一点的元信息」可缓存：
          /x/web-interface/(wbi/)?view   ← 视频元信息
          /x/space/wbi/acc/info           ← 用户信息
        动态内容（评论/收件箱/动态流/点赞）绝不能缓存 ✓
        nav 只缓存 10 分钟（wbi 密钥会轮换）

② 退避  撞到风控就熔断一段时间，不再硬闯
        HTTP 412 / 429 → 熔断
        接口层风控码 -412 / -352 / -799 / -509 / -10403 → 熔断
        退避时长：5 分钟起，指数退避，封顶 30 分钟

③ 节流  两次请求之间至少隔 300ms（贴脸连打正是被限流的典型特征）
```

### 1.4 状态文件：**风控共享，业务独立**

原则：**风控是账号级的，业务是插件级的。**

| 状态 | 共享？ | 位置 | 理由 |
|---|---|---|---|
| 凭据 | ✅ 共享**读** | `~/.bili-ai/credentials.json` | 同一个账号 |
| 熔断 / 退避 | ✅ 共享 | `~/.bili-ai/api-ban.json` | 一个撞 412，另一个也该退 —— 分开退 = 继续撞 |
| 请求缓存 | ✅ 共享 | `~/.bili-ai/api-cache.json` | 少打网络 = 少风险 |
| 请求日志 | ✅ 共享 | `~/.bili-ai/api-requests.log` | 一份日志才看得出真实请求数 |
| **配额账本** | ✅ **必须共享** | `~/.bili-ai/quota.json` | **否则两个插件各写 30 条 = 实际 60 条，账号照样被风控** |
| 素材 / 下载 / 笔记 | ❌ 独立 | 你的插件自己的 workdir | 避免互相删文件 |
| 缓存条目上限 | ⚠️ 共享时**放宽到 800** | 同上 | 两个插件的缓存条目会互相挤掉 |

⚠️ 共享状态文件时**只读不写**是不行的（熔断和配额必须写）。
正确做法：两边都走同一套「读-改-写」逻辑，**写之前重新读一遍**，
并且**用文件锁或原子写**避免两个插件同时写坏 JSON。

### 1.5 与旧插件共存

`dsh-bili-whale` **现在正在运行**（鲸鱼在用），所以：

- **不要同时挂载两个插件做同一件事** —— 会重复评论、重复发帖
- 开发阶段：新插件**不装进 profile**，只在开发目录里跑测试
- 要验证时：先把 whale 停掉，或者**只让新插件跑读操作**（写操作仍然只走 whale）
- 两个插件都写评论时：**同一条 bvid 只允许一方评论** —— 各自维护一份「已评论 bvid」清单放在**自己独立的**目录里，不要共用

### 1.6 `bili-api.mjs` 复制过来之后要改的两处

1. **`NODE_EXE` 的取法**：旧实现用 `tools/lib/nodebin.mjs`（因为 Electron 里 `process.execPath` 是主程序，不对）。
   复制时**连 `nodebin.mjs` 一起复制**，不要改成 `process.execPath`
2. **路径常量**：旧实现把 `~/.bili-ai/` 写死在 `bili-api.mjs` 里。
   复制后要**提到配置层**（可覆盖），但**默认值保持 `~/.bili-ai/` 不变**（见 §1.4 的共享策略）

排障开关：`BILI_NO_CACHE=1` 关掉缓存与熔断（强制走真网络）。
诊断入口：`apiState()` → `{ banned, banMinutesLeft, banWhy, cacheEntries }`

---

## 2. 已验证的 B站端点清单（32 个，全部真实跑通过）

```
读：
  /x/web-interface/nav                    登录态 + WBI 密钥
  /x/web-interface/view                   视频元信息（需 WBI 签名 → /wbi/view）
  /x/web-interface/popular                综合热门
  /x/web-interface/ranking/v2             分区排行
  /x/web-interface/wbi/search/type        搜索
  /x/player/playurl                       播放地址（需 WBI 签名 → /wbi/playurl）
  /x/player/wbi/v2                        播放信息 v2
  /x/v2/reply/main                        评论主楼
  /x/v2/reply/reply                       评论楼中楼
  /x/space/wbi/acc/info                   用户信息
  /x/relation                             关注关系
  /x/polymer/web-dynamic/v1/detail        动态详情
  /x/polymer/web-dynamic/v1/feed/all      动态流
  /x/msgfeed/                             私信收件箱
  /x/msgfeed/like                         私信点赞
  /x/emote/user/panel                     表情包面板
  /x/v3/fav/folder/created/list-all       收藏夹列表
  /x/subtitle/web/view                    字幕
  /x/tag/archive/tags                     标签

写：
  /x/v2/reply/add                         发评论
  /x/v2/reply/reply                       回复评论
  /x/v2/reply/del                         删评论
  /x/v2/reply/top                         置顶评论
  /x/v2/reply/hate                        点踩
  /x/v2/reply/report                      举报
  /x/v2/reply/action                      操作
  /x/v3/fav/resource/deal                 收藏 / 取消收藏
  /x/dynamic/feed/create/dyn             发动态
  /x/dynamic/feed/edit/dyn                编辑动态
  /x/dynamic/feed/draw/upload_bfs         动态图片上传
  /x/dynamic/feed/dyn/thumb               动态缩略图
  /x/dynamic/feed/space/rm_top            取消置顶
  /x/dynamic/feed/space/set_top           置顶动态
```

---

## 3. 架构：内核 + 能力注册表

```
lib/
  index.js            插件入口：装配内核 + 注册工具 + 暴露 ctx.bili
  core/
    client.js         B站 HTTP 客户端（复用 bili-api.mjs 的签名/缓存/退避/节流）
    credentials.js    凭据读写 + 错误码翻译（复用 cred.mjs）
    quota.js          配额闸（复用 quota-gate.mjs）
    capabilities.js   ★ 能力注册表（见 §4）
  api/
    video.js          视频元信息 / 热门 / 排行 / 搜索 / 播放地址
    comment.js        评论读 + 写（发/回复/删/置顶）
    dynamic.js        动态读写
    message.js        私信
    favorite.js       收藏夹
    relation.js       关注关系
  tools/
    index.js          注册给模型的工具
```

---

## 4. ★ 能力注册表（**这是可扩展性的核心**）

内核对外暴露 `ctx.bili`，别的插件可以往里挂能力 —— 这就是「不同功能由其它插件实现」的机制。

### 4.1 内核暴露的接口

```js
// ctx.bili
{
  // 注册一个能力（其它插件调用）
  registerCapability(def),      // def: { id, kind, description, run, schema? }
  listCapabilities(),            // → [{ id, kind, description }]
  callCapability(id, payload),   // → 调别的插件的能力

  // 内核自己用
  getClient(),                   // → 带签名/缓存/退避/节流的 HTTP 客户端
  getQuota(),                    // → 配额闸
  getOwner(),                    // → 主人信息
}
```

### 4.2 能力定义

```js
{
  id: 'video.understand',        // 命名规范：<域>.<动作>
  kind: 'analyze',               // analyze | fetch | transform | decide
  description: '理解视频内容并回答问题',
  schema: { /* 可选：入参 JSON Schema */ },
  async run(payload, ctx) {
    // payload 由内核提供：{ bvid, question, signal }
    // 返回任意 JSON
  },
}
```

### 4.3 两个方向都要支持

**方向 A：扩展插件提供能力，内核调用**

```js
// dsh-video 插件里：
ctx.bili.registerCapability({
  id: 'video.understand',
  kind: 'analyze',
  description: '理解视频内容并回答问题',
  async run({ bvid, question }) {
    // 调 dsh-video 的实现
  },
})
```
内核的 `video_understand` 工具因此自动获得「理解视频」能力 —— **内核不需要知道 dsh-video 的存在**。

**方向 B：扩展插件调用内核能力**

```js
// 任意插件里：
await ctx.bili.getClient().apiGet('https://api.bilibili.com/x/web-interface/view?bvid=…')
```
内核的认证、风控、配额对所有调用者统一生效。

### 4.4 能力缺失时的行为

内核调一个还没人注册的能力时：
- **返回结构化错误**：`{ ok: false, reason: 'capability-not-found', id, available: [...] }`
- **不要抛异常**，不要静默返回空
- 工具描述里要写清「当前不可用」的原因，让模型知道自己该换条路

### 4.5 能力发现的时机

- 内核在 `apply` 阶段**先注册自己的基础能力**
- 其它插件在 `ctx.inject(['bili'], ...)` 里注册 —— **不要用 `inject: ['bili']`**（那会让插件等服务就绪才 apply，顺序不可控）
- 内核提供 `ctx.bili.onCapabilityAdded(cb)`，让工具描述能动态反映可用能力

---

## 5. 核心能力清单（**这些必须做全**）

| # | 能力 | 工具名 | 端点 | 备注 |
|---|---|---|---|---|
| 1 | 刷视频 | `bili_watch` | popular / ranking / feed | 要能控制刷几条、要不要深读 |
| 2 | 视频信息 | `bili_video_info` | view | |
| 3 | 搜索 | `bili_search` | wbi/search/type | |
| 4 | 看评论 | `bili_comments` | reply/main + reply/reply | 要带楼中楼 |
| 5 | 发评论（可@主人） | `bili_comment` | reply/add | **@主人要有明确的 mention 参数** |
| 6 | 回复别人的评论 | `bili_reply` | reply/reply | 必须带 `parent` 的 oid/rpid |
| 7 | 删自己的评论 | `bili_comment_del` | reply/del | |
| 8 | 私信（**仅主人**） | `bili_dm` | msgfeed | 见 §6.3 —— 硬限制 |
| 9 | 读私信 | `bili_dm_inbox` | msgfeed | |
| 10 | 发动态 | `bili_dynamic` | dynamic/feed/create/dyn | 支持带图 |
| 11 | 编辑动态 | `bili_dynamic_edit` | dynamic/feed/edit/dyn | |
| 12 | 收藏视频 | `bili_favorite` | fav/resource/deal | 支持取消收藏 |
| 13 | 收藏夹列表 | `bili_fav_list` | fav/folder/created/list-all | |
| 14 | 点赞 | `bili_like` | （沿用现有实现） | |
| 15 | 账号状态 | `bili_status` | nav + apiState() | 登录态、缓存、熔断、配额余量 |

**每个工具都要有完整的 JSON Schema**（参数、枚举、说明），模型才知道怎么用。

---

## 6. 风控与配额（**硬要求，不是可选项**）

### 6.1 配额（沿用现有配置，实测值）

```jsonc
"risk": {
  "minGapMs": 1500,      // 两次动作最小间隔
  "readHourly": 600,     // 每小时读上限
  "readDaily": 3000,     // 每天读上限
  "writeHourly": 12,     // 每小时写上限
  "writeDaily": 30,      // 每天写上限
  "writeGapSec": 120,    // 两次写之间最小间隔
  "dmGapSec": 60         // 两次私信之间最小间隔
}
```

**每条写通道（评论 / 回复 / 动态 / 编辑动态 / 弹幕 / 私信 / 收藏）都必须过闸**：
发之前 `gate()`，发成功之后 `record()`。**漏挂一条 = 裸奔** —— 这正是旧实现踩过的坑。

### 6.2 熔断

撞到风控（HTTP 412/429 或风控码）就熔断，指数退避 5min → 30min。
熔断期间：**能吃缓存就吃缓存，吃不到就明确失败并说清还要等几分钟**。

### 6.3 「仅可以和主人私信」是硬限制

- 主人：`mid = 389989266`，name `往生堂七七代堂主`
- **只允许给主人发私信**，收件人必须是主人本人
- 读取私信收件箱**可以**（要看主人发给她的消息），但**回复只能回主人**
- 这个限制要在代码里写死 + 在工具描述里写明 + 有测试覆盖
- 不允许通过参数传入任意 mid 绕过

### 6.4 主人配置可改

`owner.mid` / `owner.name` 走 settings，**默认上面那组值**，但代码逻辑不能假定它永远不变。

---

## 7. 凭据与安全

### 凭据文件

`~/.bili-ai/` 下的 JSON，字段：

| 字段 | 用途 |
|---|---|
| `sessdata` | 登录态 |
| `bili_jct` | 写操作的 csrf token |
| `buvid3` | 设备标识（部分接口要） |

**规则**：
- 读取时统一 trim（粘贴常带空格/换行），容忍 BOM
- 缺哪个字段就**明确说缺哪个**，不要拿 `undefined` 去发请求
- **凭据、cookie、响应正文一律不进日志**
- 写操作前检查 `bili_jct` 与 `sessdata` 是否属于同一账号

### 错误码翻译（照 `cred.mjs` 的做法）

| 码 | 人话 |
|---|---|
| `-101` | 账号未登录 / cookie 失效 |
| `-111` | CSRF 校验失败（`bili_jct` 缺失或与 `sessdata` 不是同一账号） |
| `12015` | 操作过于频繁 |
| `10031` | 账号被风控 |
| `12051` | 私信对方不是好友 / 被限制 |
| `-352` | 风控拦截 |

**模型看到的是人话，不是裸错误码。**

---

## 8. 目录与实现要求

### `package.json`

```jsonc
{
  "name": "@owl-zxk/dsh-bili",
  "version": "0.1.0",
  "description": "B站账号管理内核：让 DSH agent 能以主人的 B站账号安全地读和写。",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "files": ["lib", "tools", "assets", "cordis.patch.yml", "README.md", "docs"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "inject": [], "platform": "web" } },
  "scripts": { "build": "node scripts/build-client.mjs", "test": "node --test tests/*.test.mjs" },
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/owl-zxk/dsh-bili.git" },
  "homepage": "https://github.com/owl-zxk/dsh-bili#readme",
  "bugs": { "url": "https://github.com/owl-zxk/dsh-bili/issues" }
}
```

> ⚠️ **必须用 scope**。裸名 `dsh-bilibili` 和 `dsh-video` 都已被同一个人（`dushaobindoudou`）抢注 ——
> 像是专门抢 DSH 插件名。裸名 `dsh-bili` 目前还空着，但 scope 更稳，且不受占位保护限制。

### `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-bili
      name: dsh-bili
```
**同一个 id 只能出现一次。** 装法：`dsh plugin --profile desktop add "link:<路径>"`

### 代码风格（照本机既有约定）

- ESM，2 空格缩进
- **文件头注释写清楚「为什么这样写」，不是写「做了什么」**
  —— 本机既有实现（`bili-api.mjs`、`whale-listen.mjs`、`ffx.mjs`）都是这个风格，把踩过的坑记在注释里
- 写 `.ps1` 必须带 UTF-8 BOM；写 `.json` / `.jsonl` **不能**带 BOM
- 改完跑一次语法检查（`node --check`）

---

## 9. 测试

`node --test tests/*.test.mjs`。**测试绝不打真实网络** —— 用假客户端注入。

| 用例 | 断言 |
|---|---|
| WBI 签名 | 同样的参数产出同样的 `w_rid`；缺 `wbi_img` 时抛明确错误 |
| 缓存 | 同一份 view 元信息 24h 内只打一次网络；**评论/动态流绝不被缓存** |
| 退避 | 撞到 412 → 熔断；熔断期间返回缓存或明确失败，**不再打网络** |
| 节流 | 连续两次请求间隔 ≥ 300ms |
| 配额闸 | **每条写通道都挂上了闸**（逐条断言，别漏） |
| 配额超限 | 超 `writeDaily` → 拒绝，且**不记账** |
| 私信限制 | 给非主人 mid 发私信 → **被拒绝** |
| 能力注册表 | 注册 → 列出 → 调用；调用未注册的能力返回 `capability-not-found` 而非抛异常 |
| 能力缺失 | 工具描述里能看出该能力当前不可用 |
| 凭据 | 缺 `bili_jct` → 明确说缺；带 BOM / 带空格的凭据能正确解析 |
| 错误码翻译 | `-101` / `-111` / `12015` → 对应人话 |
| 日志不含密 | 日志里搜不到 `SESSDATA` / `bili_jct` / cookie 值 |
| 端到端（可跳过） | 用假客户端跑一次完整流程，断言结构完整 |
| **解耦·无引用** | 静态扫描新插件全部源码：**不出现** `dsh-bili-whale`（含 `whale-src`、`bili-whale` 等变体） |
| **解耦·无依赖** | `package.json` 的三处依赖里**都没有** `dsh-bili-whale` |
| **解耦·不依赖旧包** | 临时把 `node_modules/dsh-bili-whale` 移走，**测试仍全绿** |
| **解耦·不改旧插件** | 测试前后对比 `whale-src\dsh-bili-whale\` 的文件清单 + mtime，**必须完全一致** |
| **解耦·不读旧数据** | 源码里不出现 `whale-work`、`whale-diary`、`whale-log`、`whale-session` 等旧插件私有路径 |
| **共享状态·原子写** | 两个进程同时写 `api-ban.json` / `quota.json` → **不产生损坏的 JSON**（并发测试） |
| **共享状态·配额合并** | 两个插件各写 N 条 → **共享配额账本里的总数是 2N**，不是 N |

**端到端测试要能跳过**：没有可用凭据时 `t.skip()`，不要让 CI 红。

---

## 10. 验收标准

- [ ] `dsh plugin --profile desktop add "link:<路径>"` 能装上，DSH 启动不崩
- [ ] §5 的 15 个工具全部出现在模型里，参数说明清楚
- [ ] `ctx.bili.listCapabilities()` 能列出内核自己的基础能力
- [ ] **写一个示例扩展插件**（哪怕是测试用的），注册一个假能力，验证内核能调到它
- [ ] 调用未注册能力返回结构化错误，不抛异常
- [ ] **每条写通道都过了配额闸**（逐条核对）
- [ ] 私信只能发给主人，测试覆盖
- [ ] 日志里搜不到任何凭据
- [ ] `npm test` 全绿
- [ ] `package.json` 三个仓库字段齐全，`cordis.patch.yml` 的 id 只出现一次
- [ ] README 写清：这是内核、怎么配凭据、怎么写扩展插件
- [ ] **解耦验收**：把 `dsh-bili-whale` 从 `node_modules` 移走，**你的插件全部功能仍正常**（真跑一次 `bili_status`）
- [ ] **未改旧插件**：`whale-src\dsh-bili-whale\` 的 `git status` 干净（它本身是 git 仓库，可直接核对）
- [ ] **配额确实共享**：两个插件的写入都记到同一份 `quota.json` 上

---

## 11. ★ 候选插件清单（**你来决定做哪些**）

内核做完之后，下面这些是**已知缺口**。每一项都可以做成独立插件，通过 §4 的注册表挂进来 —— **不需要改内核一行代码**。

| 候选插件 | 补的能力 | 依赖 | 现状 |
|---|---|---|---|
| **`dsh-video`** | **理解视频内容**（抽帧+视觉模型+转录） | ffmpeg、视觉模型 | ⬜ 提示词已写好（在 `wokrspace\dsh-video\PROMPT.md`） |
| `dsh-bili-video-note` | 看懂视频后**自动写笔记/摘要**，可发动态 | `dsh-video` | ⬜ 空白 |
| `dsh-bili-sticker` | 做表情包/贴纸并上传（B站唯一能带图的原生口子） | `dsh-video` 的生图能力 | ⬜ 空白（旧实现有 `x/emote/package/add` 探针） |
| `dsh-bili-live` | **直播间**弹幕/舰长/送礼 | 直播接口（**完全没碰过**） | ⬜ 全新 |
| `dsh-bili-analytics` | 涨粉、播放量、收藏数的时间序列与看板 | 只读端点 | ⬜ 空白 |
| `dsh-bili-reply-policy` | 回复质量评估、敏感词过滤、重复回复拦截 | LLM | ⬜ 空白 |
| `dsh-bili-media` | 视频下载管理 + 本地素材库（沿用 `debrief.mjs`） | ffmpeg | ⬜ 旧实现里有，可独立出来 |
| `dsh-bili-voice` | 用 IndexTTS / edge-tts 给动态和评论配语音 | IndexTTS-1.5（已下载） | ⬜ 空白 |

**已有的、**不必**再做的**（内核已覆盖或已有成熟实现）：

| 能力 | 在哪 |
|---|---|
| 弹幕 | 旧实现 `danmaku.mjs`（252 行）+ `danmaku-await.mjs`（384 行） |
| 字幕提取 | 旧实现 `subtitles.mjs` |
| 音频转录 | 旧实现 `tools/lib/whisper.mjs`（126 行） |
| AI 写分享文案 | 旧实现 `ai-share.mjs` |
| 夜间调度 | 旧实现 `night-plan.mjs`（116 行）—— 但**调度更适合留在 `dsh-lanpangzi` 那层** |

---

## 12. 明确不要做的事

- ❌ **不要重写 WBI 签名、缓存、退避、配额闸** —— 复制 `dsh-bili-whale` 的那四个文件（见 §1.1）
- ❌ **不要 import / require / 依赖 `dsh-bili-whale`** —— 复制源码，不引用包（§1.2）
- ❌ **不要改 `whale-src\dsh-bili-whale\` 里的任何文件** —— 那是鲸鱼正在用的运行环境
- ❌ **不要读旧插件的私有数据**（`whale-work` / 日记 / log / 会话文件）
- ❌ **不要在日志里打印凭据、cookie、响应正文**
- ❌ **不要让私信能发给主人以外的任何人** —— 这是需求里的硬限制
- ❌ **不要把风控状态分成两份** —— 熔断、缓存、**配额账本**必须共享（§1.4）
- ❌ **不要漏挂任何一条写通道的配额闸** —— 旧实现最贵的教训
- ❌ **不要在插件里硬编码主人的 mid** —— 走 settings，但默认给实测值
- ❌ **不要试图把所有功能做全** —— 缺口列在 §11，由人决定
- ❌ **不要在没有真实测试通过前声称"已完成"** —— 区分「测过了」/「看着对」/「没验」
