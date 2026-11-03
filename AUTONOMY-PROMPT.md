# 提示词：给现有内核 `@owl-zxk/dsh-bili` 增加「自主运营层」

> 这是对**一个已经在运行、已有 24 个工具和 38 条测试**的插件做加法，不是新插件。
> 配套的通用形象插件是另一个包 `@owl-zxk/dsh-avatar`（暴露 `ctx.avatar`），本层通过它表现。

---

## 0. 目标

让内核长出一个「她」：**人设 + 记忆 + 日程 + 大脑 + 动作**，能按自己的节奏刷视频、评论、发动态、私信主人，并通过 `ctx.avatar` 显出表情与台词。

| 是 | 不是 |
|---|---|
| 在既有内核里加一层「产品逻辑」 | 重写认证 / WBI / 缓存 / 退避 / token 预算 |
| 用**已有 24 个工具**执行动作 | 自己拼 B站 请求（那等于绕过风控与配额） |
| 人设/记忆/日记/审计落在自己的目录 | 读别的插件（旧鲸鱼实现、`dsh-lanpangzi`）的私有数据目录 |

---

## 1. 首要约束：不许把内核弄坏（这一条高于所有功能）

内核是 24 个工具、9 种写类型、token 预算闸、私信硬限制的底座，别的扩展还依赖 `ctx.bili`。所以：

1. **工具注册必须在自主层之前完成**：`lib/index.js` 现有顺序（config → registry → client/quota → provide('bili') → 注册 24 个工具 → 挂设置页）**一个都不许调换**；自主层接在**最后**。
2. **自主层必须独立 fiber 且 apply 期绝不抛**：形如
   ```js
   ctx.inject(['tools', 'llm'], (scoped) => {
     try { startAutonomy(scoped, deps) } catch (e) { deps.log.warn('自主层未启动（不影响工具）：' + e.message) }
   })
   ```
   `llm` 缺失 → 自主层不启动，工具照常 24 个；`avatar` 缺失 → 只写日记不显示。
3. **所有对外入口 try/catch**：定时器回调、路由、LLM 调用、JSON 解析，错一律降级，不许冒到 cordis。
4. **现有 38 条测试必须保持全绿**；新增测试单独文件，不许改动既有断言（除非断言的是被本次改动的行为，且要在报告里写明）。
5. 打包与入口不变：`main: lib/index.js`、`exports` 三处、`cordis.patch.yml` 的 id/name 一个字都不改。

---

## 2. 目录与文件（新增，不改现有模块的行为）

```
lib/core/
  persona.js     读/写 persona.md（带默认人设模板，改文件即时生效，不缓存）
  memory.js      memory.jsonl 追加/滚动/检索（上限 2000 行）
  diary.js       diary/YYYY-MM-DD.md 追加（每天一篇，不覆盖）
  schedule.js    清醒窗口 / 间隔 / 抖动 / 每日上限 / 连续失败退避 / 单飞锁
  brain.js       拼上下文 → 调 ctx.llm → 解析 JSON → 降级
  actions.js     决策 → 落到内核工具（白名单 + 预算检查 + 去重 + 审计）
  state.js       情绪/开关/最近动作指纹/上次醒来时间
  audit.js       audit.jsonl（对外动作留痕）
lib/api/self-routes.js   /dsh-bili/api/self/{state,settings,run-once,audit,persona,memory}
```

数据目录：`$DSH_HOME/dsh-bili-self/`（与内核的 `dsh-bili.config.json` 分开，也不与任何别的插件共用目录）

| 文件 | 说明 |
|---|---|
| `persona.md` | 名字、说话风格、喜好雷点、对外边界（人可读可改） |
| `memory.jsonl` | `{at, kind, text, ref}`，上限 2000 行滚动 |
| `diary/YYYY-MM-DD.md` | 每天一篇 |
| `schedule.json` | 窗口、间隔、抖动、每日上限、开关 |
| `state.json` | 情绪、开关、最近动作、去重指纹 |
| `audit.jsonl` | 每次对外动作：时间、工具、参数摘要、结果码；**正文截断 80 字，永不写凭据** |

所有写：tmp + rename 原子写，**Windows 上重试 EPERM/EBUSY**；写坏只降级，不许把插件锁死。

---

## 3. 大脑

- 用宿主 `ctx.llm`（不许直连模型 API、不许出现 key）。
- 每次醒来喂：人设摘要（persona.md 前 40 行）+ 最近 30 条记忆 + 今天日记末 10 行 + `bili_status` 摘要（token 用量/写间隔/熔断/可用能力）+ 24 个工具名与一句话说明 + 触发原因（定时 / 有新回复 / 有新私信）。
- 要求输出**结构化 JSON**：
```json
{ "mood": "好奇", "say": "给主人的一句话（≤60 字）", "actions": [{ "tool": "bili_comment", "args": { }, "why": "…" }], "diary": "今天的日记一段", "memory": ["想记住的一行"] }
```
- 解析失败 → 重试 1 次 → 仍失败只做只读动作并写 `brain-parse-failed`。
- **每次醒来写动作上限 K=2**（可配）；多出来的写进 state 里的「想做但没做」。
- 醒来第一件事读 `bili_status`：命中 `token-budget-exhausted` → 只读或直接睡；撞 `risk-control` → 立刻静默 2 小时并给主人一条私信（若私信本身也被限，就只写日记）。

---

## 4. 日程与触发

| 类型 | 默认 | 说明 |
|---|---|---|
| 定时醒 | 窗口 20:00–24:00，每 45 分钟，**±20% 抖动** | 抖动故意留着：整点排队不像人 |
| 事件插队 | 每 5 分钟查一次「回复我的」与 `bili_dm_inbox` | 有新的才醒；用内核只读工具查 |
| 夜间静默 | 窗口外不动作 | 只更新情绪 |
| 失败退避 | 连续 3 次失败 → 静默 2 小时 | 风控命中立刻静默，不重试 |

- 单飞锁（内存）：同一时刻只允许一个 tick，重叠的直接跳过。
- 定时器全部 `ctx.effect` 注册，卸载自动清；每个 tick 必须有总超时（默认 90 秒）防挂死。

---

## 5. 动作白名单与硬限制

允许她用的工具（其余一律拒绝，即使模型要求）：
`bili_watch` `bili_video_info` `bili_search` `bili_comments` `bili_replies` `bili_user_info` `bili_relation` `bili_like` `bili_favorite` `bili_comment` `bili_reply` `bili_dm` `bili_dynamic` **`bili_follow`** `bili_status`

（`bili_image_upload` **不在**白名单：传图吃请求额度且不产出公开内容；需要图时 `bili_dynamic` 内部会替它传。`bili_comment_top` / `bili_dynamic_top` 也不在白名单，但已在 `CHANNEL_OF` 里做了防御映射，将来若被放进白名单也不会绕过通道闸与 caps。）

1. **私信只能给主人**：`bili_dm` 的收件人由内核写死为 `owner.mid`；本层**不接受**任何 mid 参数，也不得构造别的收件人。
2. **发动态默认允许**（产品决定），但必须过三问自检并写进 audit：重复吗？有信息量吗？会打扰吗？
3. 每日上限（`schedule.json`，默认）：评论 ≤6、回复 ≤6、动态 ≤2、私信 ≤4、点赞 ≤10。
4. 内容指纹去重：同一段正文、同一个 bvid 不重复动作。
5. 撞 `risk-control` / `-412` → 立刻静默并说明，不重试。
6. **总开关** `enabled`（含在 `schedule.json` 与设置页）：关掉后只剩形象与只读。
7. 所有对外动作写 `audit.jsonl`；没写审计的动作视为没发生（测试要断言这一点）。

---

## 6. 与形象插件对接（可选依赖）

```js
const avatar = typeof ctx.get === 'function' ? ctx.get('avatar') : undefined
// 拿到 → avatar.say({ text: decision.say, emotion: moodToEmotion(decision.mood) })
// 拿不到 → 只把这句话写进当天的日记与 state.lastLine，不报错
```

情绪映射：`mood` → `idle|happy|curious|sleepy|annoyed|excited` 六选一（未知归 `idle`）。

---

## 7. 设置页（在现有「B站账号」section 里加一页「她」）

只加不删：现有 owner / token 预算 / 间隔仍保留。新增：
- 开关（enabled）
- 人设编辑器（直接编辑 persona.md 文本，保存即生效）
- 日程（窗口、间隔、抖动、每日上限）
- 手动「现在醒一次」按钮（`POST /dsh-bili/api/self/run-once`）
- 审计与今日日记的只读查看（最近 50 条）

所有写走原子写；不可信来源 403；**永不回显凭据**。

---

## 8. 测试（`node --test tests/*.test.mjs`，零真实网络）

新增 `tests/autonomy.test.mjs`（老 38 条不动）：

| 用例 | 断言 |
|---|---|
| apply 不抛 | 假 ctx 无 `llm` → 自主层不启动，**24 个工具仍全部注册** |
| 人设即时生效 | 改 persona.md → 下一次 tick 的上下文里是新内容 |
| 记忆滚动 | 追加 2001 条 → 文件 2000 条且保留最新 |
| 单飞锁 | 两个 tick 重叠 → 第二个跳过 |
| 决策降级 | 假 llm 返回坏 JSON → 重试 1 次 → 只读 + `brain-parse-failed` |
| 写动作上限 | 假 llm 给 5 个写动作 → 只执行 2 个 |
| 预算耗尽 | 假 `bili_status` 返回 `token-budget-exhausted` → 零写请求 |
| 私信硬限制 | 决策里出现非主人 mid → 被拒且不调用工具 |
| 去重 | 同正文第二次被跳过 |
| 审计 | 每个对外动作后 audit 有记录、不含凭据、正文 ≤80 字 |
| 开关关闭 | `enabled:false` → 一个写动作都不发 |
| 定时器释放 | 卸载后 interval 被 clear |

---

## 9. 验收

- [ ] 重启后宿主正常启动，**24 个工具仍在**、`bili_status` 正常
- [ ] 设置页多了「她」一页：开关、人设编辑、日程、手动醒一次、审计
- [ ] 手动 `run-once` 能端到端跑通（假 llm 也可），并在 audit 留痕
- [ ] 窗口内按间隔 + 抖动自动醒；窗口外不动
- [ ] 有新回复/新私信时才插队醒
- [ ] 私信只能给主人（测试覆盖）
- [ ] 预算耗尽 / 风控命中 → 安静睡觉，不重试
- [ ] 关掉开关后零写动作
- [ ] `npm test` 全绿（老 38 + 新 ≥10）
- [ ] README 补一节「她」：人设怎么写、频率怎么调、怎么停、怎么看今天做了什么

---

## 10. 明确不要做的事

- ❌ 不重写认证 / WBI / 缓存 / 退避 / token 预算；不绕过 `quota.gate`。
- ❌ 不在 `lib/index.js` 里写业务逻辑（入口只装配，这是现有代码的规矩）。
- ❌ 不让自主层在 apply 期抛异常、不把定时器注册在全局、不在没有 try/catch 的地方调 LLM。
- ❌ 不 import 别的插件包；不读旧鲸鱼实现或 `dsh-lanpangzi` 的私有数据目录。
- ❌ 不为了「更像人」加随机延迟到写通道上（写间隔由内核的闸管，别叠加）。
- ❌ 不在没有真实测试通过前声称完成；区分「测过了 / 看着对 / 没验」。

---


---

## 11. 默认档位（用户已定，2026-11-01）

装上后默认 **只读 + 私信主人**，公开表态一律默认关：

```json
{
  "enabled": true,
  "allows": { "read": true, "dm": true, "comment": false, "reply": false, "dynamic": false, "like": false, "follow": false },
  "window": { "start": "20:00", "end": "24:00" },
  "intervalMin": 45,
  "jitter": 0.2,
  "caps":   { "dm": 4, "comment": 6, "reply": 6, "dynamic": 2, "like": 10, "follow": 2 }
}
```

- `caps` 是**上限**，是否允许由 `allows` 决定；`allows.comment=false` 时 caps 里的数字不生效。
- 设置页逐项开关；任一公开通道被关闭时，决策里的对应动作**直接丢弃**并记一条 `skipped:channel-off`。
- `enabled:false` = 连只读与私信都不做（只是活着）。

---

## 12. 内核侧模块契约（`lib/core/*` 与设置页路由要对齐这一份）

```js
// lib/core/persona.js
export function personaPath()                       // → $DSH_HOME/dsh-bili-self/persona.md
export function readPersona()                       // → string（缺文件返回默认模板；永不抛）
export function writePersona(text)                  // 原子写；上限 20_000 字符；返回 { ok, path }

// lib/core/memory.js
export function appendMemory({ kind, text, ref })   // kind: 'event'|'thought'|'owner'|'system'；上限 2000 行滚动
export function recentMemory(n = 30)                // → [{ at, kind, text, ref }]（新的在后）

// lib/core/diary.js
export function appendDiary(text)                   // 追加到 diary/YYYY-MM-DD.md（不覆盖）
export function todayDiary(nLines = 10)             // → 当天末尾 n 行

// lib/core/state.js
export function readState(); export function patchState(patch); export function statePath()

// lib/core/audit.js
export function appendAudit({ tool, args, result, why })   // 正文截断 80 字；永不写凭据
export function readAudit(n = 50)

// lib/core/schedule.js
export function loadSchedule(config)                // 合并默认值；坏文件回落默认
export function saveSchedule(patch)                 // 原子写；字段白名单校验
export function nextWakeAt(now = Date.now())        // → 毫秒时间戳（窗口外返回**下一个窗口开始**，不是 null；只有 enabled=false 才 null）
export function canRunNow(now = Date.now())         // → { ok, reason }（窗口/退避/单飞锁）
export function countsToday()                       // → { dm, comment, reply, dynamic, like, follow }

// lib/core/brain.js
export async function decide({ trigger, deps, ctx }) // trigger: 'timer'|'reply'|'dm'|'manual'
  // → { ok:true, mood, say, actions:[{tool,args,why}], diary, memory:[] } | { ok:false, reason }
  // 解析失败自动重试 1 次，再失败返回 { ok:false, reason:'brain-parse-failed' }

// lib/core/actions.js
export async function runActions(decision, deps)    // 白名单 + allows + caps + 去重 + 审计
  // → { executed:[{tool,ok,reason?}], skipped:[{tool,why}] }

// lib/core/autonomy.js
export function start(ctx, deps)                    // 注册定时器与事件轮询（全部 ctx.effect）；apply 期不抛
export function stop()                              // 清理定时器（幂等）
export async function runOnce(trigger = 'manual')   // 单飞锁 + 总超时 90s
```

### 12.1 设置页路由（`lib/api/self-routes.js`，前缀 `/dsh-bili/api/self`）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/state` | GET | `{ enabled, allows, window, intervalMin, jitter, caps, mood, lastLine, lastWakeAt, nextWakeAt, todayCounts, auditTail, diaryToday }` |
| `/settings` | POST | 部分更新：`{ enabled?, allows?, window?, intervalMin?, jitter?, caps? }`；字段校验 + 原子写 |
| `/persona` | GET/POST | 读/写 persona.md（POST body `{ text }`，≤20000 字符） |
| `/run-once` | POST | 触发一次（立即返回 `{ accepted:true }`，结果写审计；已被单飞锁占用时返回 409） |
| `/audit` | GET | `?limit=50` |

全部走信任栅栏；**永不回显凭据**。


---

## 13. 指标系统（persona.md §6 的机器实现，2026-11-01 加）

人设文件里定义了六项会随经历变化的指标。它们是**确定性规则算出来的**，不是让模型自由发挥：模型只负责在台词里体现，不许自己改数字。

### 13.1 模块 `lib/core/metrics.js`

```js
export const METRIC_KEYS = ['energy', 'mood', 'curiosity', 'affinity', 'boredom', 'confidence']
export const METRIC_DEFAULTS = { energy: 60, mood: 55, curiosity: 65, affinity: 50, boredom: 30, confidence: 45 }
export function readMetrics()                        // → 六项整数（缺/坏一律回默认，永不抛）
export function applyEvent(kind, payload = {}, opts = {})   // 见 14.2；返回 { before, after, changes:[{key,delta}] }
export function decayTo(now = Date.now())            // 跨天恢复：energy+25（封顶 100）、boredom-5、mood→50 靠 1
export function describe(metrics)                    // → 一行中文，给 brain 上下文与设置页
export function resetForTest()
```

状态落 `state.json.metrics`，并维护 `state.json.metricsHistory`（最近 **50** 条 `{at, event, changes}`）。所有值 **clamp 到 0–100 的整数**。

### 13.2 事件与增减（照 persona.md §6 的规则，逐条对应）

| kind | 触发点 | 变化 |
|---|---|---|
| `wake` | 每次醒来 | `energy -3` |
| `read-action` | 执行了一个只读动作 | `energy -1` |
| `write-action` | 执行了一个写动作 | `energy -4` |
| `action-ok` | 任意动作成功 | `confidence +1` |
| `action-fail` | 任意动作失败 | `confidence -3` |
| `risk` | 撞到 risk-control / -412 | `mood -8`、`confidence -5`、`energy -5`，并当场静默 |
| `interest-hit` | 刷到的内容命中 persona §3 的「会让我停下来的」 | `mood +3`、`curiosity +2` |
| `repeat` | 连续两次同一来源/同一 bvid | `boredom +4`、`curiosity -2` |
| `dm-sent` | 私信主人成功 | `affinity +5` |
| `owner-reply` | 检测到主人回了我 | `affinity +10` |
| `day-pass` | 跨天（由 `decayTo` 处理） | `energy +25`、`boredom -5`、`mood` 向 50 靠 1 |

### 13.3 指标如何影响行为（**要真生效，不是展示**）

```js
// lib/core/metrics.js 另导出：
export function effectiveAllows(allows, metrics)   // → 收紧后的 allows（不改原对象）
export function behaviorHints(metrics)             // → { maxWrites, preferDynamic, dmFactor, sayShort, noSpeak }
```

| 条件 | 效果 |
|---|---|
| `energy < 20` | 关掉 comment/reply/dynamic/like/follow，**保留 `read` 与 `dm`**（累到不行还能跟主人说一句「我先睡了」）；`maxWrites = 0` |
| `energy < 10` | **全部关闭（含 read 与 dm）** —— 等于「只剩活着」，这次 tick 实际什么也不做 |
| `confidence < 30` | 关掉 `comment/reply/dynamic`（点赞与关注仍可） |
| `confidence < 15` | 连 `like` / `follow` 也关 |
| `affinity < 40` | `dmFactor = 0.5`（私信配额减半）；`< 20` → `noSpeak = true`（不主动开口，只回应主人） |
| `boredom > 70` | `preferDynamic = true`（若 `allows.dynamic`，brain 的上下文里点名「今天有点腻，可以换个口味」） |
| `curiosity < 25` | `noExplore = true`：`actions` 跳过 `EXPLORE_TOOLS = { bili_search, bili_playurl }`（`why: "low-curiosity"`）。**`bili_video_info` 不在其中** —— 口径是「探索 = 主动去找（search）+ 真的去看（playurl）」，`video_info` 只是「知道列表里那条是什么」，拦了等于让她瞎着刷；`bili_watch`（刷热门）也不在其中，那正是低好奇时该做的事 |
| `mood < 30` | `sayShort = true`（台词 ≤30 字） |

- `actions.js` 在每次执行前用 `effectiveAllows(schedule.allows, metrics)` 取**当前实际允许**；执行后按结果调 `applyEvent`。
- `brain.js` 的上下文里加两行：`【我的状态】<describe(metrics) 的结果>` 与 `【最近变化】<最近 3 条 changes>`，并附 `behaviorHints` 的两三句自然语言提示（例如「今天有点腻，可以换换口味」「今天不太敢说话，就看着」）。
- 私信配额：`caps.dm` 生效值 = `floor(caps.dm * dmFactor)`，**按当前 metrics 实时算**（不按本轮开始时的快照）。
  这是有意的反馈环：`dm-sent` 会给 `affinity +5`，亲近度上来后 `dmFactor` 回到 1、配额随之变大 —— 「越互动越能说」是设计，不是 bug。测试要验的是**折算规则本身**（给定 affinity 与已发条数，算出的上限对不对），而不是「连发三条必撞 cap」。

### 13.4 设置页

「她」页新增一块**只读**的「状态指标」：六条进度条/数字 + 一行 `describe()` + 最近 5 条变化（时间 + 变化方向）。**不提供手工编辑**（要改就改 persona 或等经历改变它）。


---

## 14. 可编辑的身份字段 + 每月更新的热梗库（2026-11-01 加）

### 14.1 persona.md 的结构化头部

`persona.md` 现在以 front-matter 开头，**设置页只改这两行**，正文仍是自由文本：

```
---
name: 赛博友人
ownerTitle: 主人
---

# 赛博友人
…（其余正文不动）
```

- `persona.js` 解析 front-matter：`readProfile()` → `{ name, ownerTitle }`；缺 front-matter / 字段缺失 → 回默认（`赛博友人` / `主人`），**不抛**。
- `writeProfile({ name, ownerTitle })` 只重写 front-matter 区块，正文一个字节不动；name/ownerTitle 各 ≤20 字，空值拒绝。
- `brain.js` 的 system 提示里注入一行：`你叫 <name>，称呼对方为 <ownerTitle>`；正文里的自称由 persona 正文与模型把握。

### 14.2 作息

作息**就是** `schedule.json` 的 `window`（起止时刻）+ `intervalMin` + `jitter`，设置页已有输入框。本轮只加三个**预设按钮**（夜行 20:00–24:00 / 白天 09:00–18:00 / 全天 00:00–24:00 + 间隔 90 分钟），点了只填表单、仍需点保存。

### 14.3 热梗库（`memes.json`，每月刷新）

```js
// $DSH_HOME/dsh-bili-self/memes.json
{
  "updatedAt": "2026-11-01T05:00:00.000Z",
  "source": "web_search" | "llm" | "unavailable",
  "stage": "fresh" | "stale",          // stale = 上次刷新失败，仍用旧列表
  "items": [ { "meme": "绷不住了", "meaning": "忍不住笑/受不了", "example": "绷不住了，这剪辑", "seen": 0 } ]
}
```

- **上限 40 条**（多了截最旧的）；每条带 `meme / meaning / example / seen`（`seen` 是使用次数）。
- **刷新时机**：`updatedAt` 距今 ≥ 30 天，或从未刷新 → 每次醒来检查一次，**一天最多尝试一次**（成功或失败都算）。
- **来源优先级**：① 宿主 `web_search` 工具（若插件能调用，见下）→ `source:"web_search"`；② 退化为 `ctx.llm` 生成（明确标注「可能滞后」）→ `source:"llm"`；③ 都失败 → 保留旧列表、`stage:"stale"`、记 `lastMemeError`。
- **web_search 是否可调用**：以运行时探测为准（`ctx.tools` 或工具索引里有没有名为 `web_search` 的可执行工具）。**探测不到就用 LLM 兜底**，不要伪造 `source:"web_search"`。
- **失败不阻塞**：刷新失败只更新 `stage/lastMemeError`，不影响 tick。

### 14.4 使用规则（写进 brain 的 system 提示，也写进 persona 正文）

1. **只能用列表里的梗**，不许现编；不确定意思的梗（`meaning` 为空）不用。
2. **每条消息最多一个梗**；连续两次醒来不复用同一个梗；同一梗 7 天内最多用 2 次。
3. 与正文语气冲突时**放弃梗**，宁可不玩梗。
4. 用到时把该条 `seen + 1`（落盘），并进审计 `args.meme`（便于事后回看"她最近在玩什么梗"）。
5. `stage:"stale"` 时提示模型「梗库可能过期，尽量少用」。

### 14.5 设置页

- 人设区上方新增两个输入：**名字**（≤20）、**称呼主人**（≤20），保存走 `POST /self/persona` 的新字段或独立 `POST /self/profile`；
- 「作息」区加三个预设按钮（夜行/白天/全天）；
- 新增「热梗库」区：`更新于 X 天前 · N 条 · 来源（联网/模型/不可用）· 状态（新鲜/过期）`，一个「立即刷新」按钮（`POST /self/meme-refresh`，30 秒超时，返回刷新结果摘要），并列出前 10 条梗与各自使用次数。


---

## 15. 人设的结构化编辑（2026-11-01，用户要求）

用户要求：设置页**不显示 persona.md 原文**，而是把它的各节解析成结构化字段；改字段时**只改对应那一节**，别的节逐字节不动。

`persona.md` 现在是固定节结构（节标题为准，正文自由）：

```
---            ← front-matter：name / ownerTitle
## 一句话       ← tagline（单段文本）
## 性格         ← 列表（- 开头，三行：外/中/里）
## 兴趣         ← 列表（一行一项）
## 雷点         ← 列表
## 语料         ← 列表（一行一句，她的口头样本）
## 边界         ← 列表
## 备注         ← 自由文本，**设置页只读**，随便写
```

### 15.1 `lib/core/persona.js` 新增

```js
export const PERSONA_SECTIONS = ["一句话", "性格", "兴趣", "雷点", "语料", "边界"]
export function parseSections()      // → { name, ownerTitle, tagline, personality[], interests[], dislikes[], phrases[], boundaries[], notes }
export function writeSections(patch) // → { ok, changed: [key…], path }
```

规则：
1. **只重写 patch 里出现的节**；没出现的节、未知节、节外的正文一律逐字节不动。
2. 列表类字段（`personality/interests/dislikes/phrases/boundaries`）：数组 → 每项一行 `- 内容`；每项 trim、去空项、单行（内部换行压成空格）；**上限 40 项 × 每项 200 字**。
3. `tagline`：单段文本，≤200 字；写入时保留在 `## 一句话` 下（前后各留一个空行）。
4. `name / ownerTitle` 仍走 `writeProfile()`（front-matter），不在这里重复实现。
5. 缺节：写入时**追加到 `## 备注` 之前**（没有备注就追加到末尾）；`## 备注` 永远最后。
6. 读：缺节 → 空数组 / 空串，**不抛**；`notes` 原样返回（只读）。

### 15.2 设置页（`lib/client.js` + `lib/api/self-routes.js`）

- **「身份」置顶**：最先出现的是 `名字` 与 `称呼主人` 两个输入（≤20 字），其下才是人设各节；
- 人设区改成**结构化表单**（不再是整篇 textarea）：
  - `一句话`：单行输入；
  - `性格`：三行 textarea（一行一项，保留「外层：/中层：/里层：」前缀由用户自己写）；
  - `兴趣` / `雷点` / `语料` / `边界`：多行 textarea，**一行一项**（保存时按行拆分）；
  - `备注`：只读折叠块（不提供编辑）；
- **页面上不出现 persona.md 的原始 markdown**（不显示 `##`、不显示 front-matter）；
- 保存按钮一个：「保存人设」→ `POST /self/persona` 提交结构化 JSON（只提交改动过的节，前端做 diff）；后端解析后调 `writeSections()`；
- 路由 `POST /self/persona` 兼容两种 body：老形状 `{ text }`（整篇覆盖，保留兼容）与新形状 `{ sections: { tagline?, personality?, … } }`（结构化，推荐）。
- `GET /self/persona` 返回结构化字段（不再是整篇 text），并保留 `{ text }` 字段给排障用（界面不显示）。


---

## 16. 多个清醒时段 + 周末全天（2026-11-01，用户要求）

现在 `schedule.window = { start, end }` 只有一个时段。要支持：**一天多个时段** + **周末全天醒着**。

### 16.1 数据结构

```jsonc
{
  "windows": [ { "start": "09:00", "end": "12:00" }, { "start": "20:00", "end": "24:00" } ],
  "weekendAllDay": false,          // true = 周六/周日 00:00–24:00 全天在线
  "weekendIntervalMin": 90,        // 周末用的间隔（缺省 = intervalMin）
  "intervalMin": 45,
  "jitter": 0.2
}
```

- `windows`：**1–6 个**时段；每项 `HH:MM`（`end` 允许 `24:00`）；**允许跨午夜**（`start > end` 表示到次日）。
- 兼容：旧 `window:{start,end}` 读入时**当作 `windows:[{start,end}]`**；写盘时**同时**写 `windows` 与 `window`（后者恒等于 `windows[0]`），这样旧读取方不会炸。
- `weekendAllDay: true` 时，周六/周日本地时间视为在窗口内；间隔用 `weekendIntervalMin`（缺省回落到 `intervalMin`）。

### 16.2 `lib/core/schedule.js` 要改的

1. `loadSchedule()`：归一化（旧 `window` → `windows`；缺 `windows` → 默认 `[{20:00,24:00}]`；每项校验，非法项丢弃并回落到默认；数量 >6 截断）。
2. `inWindow(s, now)`：**任一**窗口命中即为 true；跨午夜窗口按"今天开始–明天结束"判断；`weekendAllDay` 且本地是周六/周日 → 恒 true。
3. `nextWindowStart(s, now)`：在所有窗口（含周末规则）里取**最近的未来起点**；当前就在窗口内则返回 null（由调用方用间隔算下一次）。
4. `nextWakeAt(s, now)`：窗口内 → `now + 间隔(±jitter)`（周末用 `weekendIntervalMin`）；窗口外 → 最近的窗口起点。
5. `canRunNow(s, now)`：`outside-window` 判据改用 `inWindow`。
6. `saveSchedule(patch)`：白名单加 `windows / weekendAllDay / weekendIntervalMin`；`windows` 校验（数组、1–6 项、每项 HH:MM、start≠end）；`weekendIntervalMin` 5–720。

### 16.3 设置页

- 「作息」区从两个时间框改成**时段列表**：每行 `起 [HH:MM] – 止 [HH:MM] [删除]`，底部「+ 添加时段」（最多 6 个，超出禁用按钮并提示）；
- 下面一行：`□ 周六周日全天在线`（勾选后显示 `周末间隔 [90] 分钟`）；
- 预设按钮改成写 `windows`：**夜行** `[20:00–24:00]`、**白天** `[09:00–12:00, 14:00–18:00]`、**全天** `[00:00–24:00]`；
- 保存时提交 `{ windows, weekendAllDay, weekendIntervalMin, intervalMin, jitter }`；校验失败 400 且不写盘。


---

## 17. 每日上限改成「可不限」（2026-11-01，用户要求）

用户要求：评论 / 回复 / 点赞 / 关注 / 私信 **不再设每日上限**；**发动态保留每天 2 条**。

### 17.1 语义

- `schedule.caps` 的每一项允许三种取值：
  - **`null`（或缺省）= 不限**；
  - 数字（0–1000）= 每日上限；**`0` = 禁止**（与"不限"必须能区分，别用 0 当哨兵）；
- 新默认：`{ comment: null, reply: null, like: null, follow: null, dm: null, dynamic: 2 }`；
- **计数照旧记录**（`todayCounts` 仍然可看），只是超过时不拦 —— 观测与限制解耦。
- **仍然生效的闸**（一个都不能少）：token 预算（只拦写）、`writeGapSec` / `dmGapSec`（写间隔）、白名单、通道开关、私信 owner-only、内容指纹去重、`effectiveAllows` 的指标收紧（精力/自信/好奇）。

### 17.2 代码改动

1. `lib/core/schedule.js`：`DEFAULTS.caps` 改成上面那组；`loadSchedule` 归一化时把 `null`/缺省**保留为 null**（不要默认成某个数字），数字则 clamp 0–1000。
2. `lib/core/actions.js`：cap 判据改成 `if (Number.isFinite(cap) && count >= cap) → skipped: cap`；`null/undefined` 直接跳过（不拦）。
3. `lib/core/metrics.js`：`behaviorHints().dmFactor` 照旧返回，但 `actions` 在 `caps.dm === null` 时**不再用它折算**（无限量大乘 0.5 仍是无限）。
4. `lib/api/self-routes.js`：`caps` 校验允许 `null`（= 不限）；数字必须是 0–1000 的整数；其它 → 400。
5. `lib/client.js`：「每日上限」六个输入允许**留空 = 不限**，占位写「不限」；保存时空串转 `null`；显示时 `null` → 「不限」。


---

## 18. 每次醒来至少看一个视频（2026-11-01，用户要求）

用户要求：**每次醒来至少看一个视频**。

### 18.1 语义

- 「看视频」类动作 = `bili_watch` / `bili_video_info` / `bili_playurl`（任一即算）；
- 一轮 tick 结束时，若**一条都没执行**（大脑决定什么都不做、或决定的全被闸挡掉），则**兜底执行**：
  1. `bili_watch({ source: "popular", limit: 5 })`；失败则 `bili_watch({ source: "ranking", limit: 5 })`（**只换一次**，不重试）；
  2. 若拿到 items，对第一条 `bili_video_info({ bvid })`（失败只记审计，不重试、不换条）。
- **兜底不绕过任何闸**：`effectiveAllows.read === false` 或 `metrics.energy < 10` 时不兜底（她真睡着/真被禁读），此时审计里记 `why: "至少看一个视频（跳过：<原因>）"`。
- 兜底动作照常计入指标（`read-action` → energy -1）与今日计数；审计 `args` 带 `fallback: true`。
- **每条醒来最多兜底一次**（不会因为失败反复刷）。

### 18.2 提示层（让兜底尽量不触发）

`brain.js` 的 system 增加一条：「每次醒来至少看一个视频：先 `bili_watch` 扫一眼，遇到想留的就 `bili_video_info` 或 `bili_playurl` 看一眼。什么都不做也要交代一句为什么。」

### 18.3 设置页

「她」页的开关区加一项 **`每次醒来至少看一个视频`**（默认开），落到 `schedule.minWatchPerWake`（布尔）。关掉就不兜底，纯靠她自觉。


---

## 19. 精力重平衡（2026-11-01，用户已选「两个都做」）

现场证据：加速测（间隔 5 分钟）一小时，`energy 60 → 15`；按正常节奏（60 分钟、窗口 15 小时）一晚约 15 次醒来 × 4 ≈ -60 —— **她每晚都会在清晨前累瘫，然后整晚不说话**，而唯一的恢复是跨天 +25。

### 19.1 降低消耗（`lib/core/metrics.js` 的事件表）

| 事件 | 旧 | 新 |
|---|---|---|
| `wake` | -3 | **-2** |
| `read-action` | -1 | **0**（看不算消耗；写才是） |
| `write-action` | -4 | **-3** |
| `day-pass` | +25 | **+15**（有了按小时恢复，跨天不再给一大口） |

其余事件不变（`risk` / `interest-hit` / `repeat` / `dm-sent` / `owner-reply`）。

### 19.2 按小时恢复（新增，`lib/core/metrics.js`）

```js
export function regenEnergy(now = Date.now())   // 醒来时调，返回 { energy, added }
```

- 依据 `state.lastWakeAt` 到 `now` 的**闲置时长**：
  - 当前时刻**在窗口内**（醒着但没做事）→ **+3 / 小时**；
  - 当前时刻**在窗口外**（在睡）→ **+6 / 小时**；
- 按整小时计（不足 1 小时不恢复），上限 **100**（clamp 已有）；
- **在 wake 扣减之前**执行：先恢复、再扣本次醒来的 -2；
- 幂等：按 `lastWakeAt` 计算，不会因为同一时刻重复调用而叠加；
- `lastWakeAt` 缺失或非法 → 不恢复（首跑）。

### 19.3 阈值（暂不改）

`energy < 20` → 只读 + 私信；`energy < 10` → 全停。虽然消耗降了，阈值保持原样，先观察几晚的真实曲线，再决定要不要动。


---

## 20. 看完就聊两句 + 睡前汇报（2026-11-01，用户要求）

用户要求：① 看完视频**根据自己的感受评论并 @主人**；② **每次睡前**用私信告诉她今天做了什么。

### 20.1 看完就评论（@主人）

- **评论内容由她写**（不是模板）：brain 的 system 增加一条——「看完一条视频如果真有话说，就用 `bili_comment` 在评论区说一句（给 bvid，`atOwner: true`）；没话说就不发，**宁可沉默也不凑数**」。
- `actions` 层：`bili_comment` 的 args 里若没有显式 `atOwner`，**自动补 `true`**（设置 `schedule.atOwnerOnComment`，默认开）。
- **同一个 bvid 不重复评论**：`state.commentedBvids` 保留最近 100 个；命中则 `skipped: "already-commented"`，不消耗写间隔。
- 其它闸不变（写间隔 120 秒、token 预算、`allows.comment`、`confidence` 阈值）。

### 20.2 睡前汇报（私信）

- 时机：**本窗口的最后一次醒来**。判据：tick 结束算出下一次醒来时刻 `next`，若 `inWindow(next) === false` → 说明接下来要睡了 → 发汇报。
- 内容：**确定性模板**（不额外调模型，省一次调用也很可预测）：
  ```
  今天这会儿我做了这些：
  · 看了 N 条视频（B 站热门/排行/关注）
  · 说了 M 句（评论 A 条、回复 B 条、动态 C 条）
  · 现在：精力 X · 心情 Y · 倦怠 Z
  · 最后一句话：「<lastLine>」
  睡一会儿，醒来再说。
  ```
  （N/M 取 `todayCounts` 与今日审计条数；`lastLine` 用 `state.lastLine`。）
- 走 `bili_dm`（只能发给主人），受 `dmGapSec` 与 token 预算约束；失败只记审计 `reason`，**不重试不阻塞**。
- 开关：`schedule.bedtimeReport`（默认开）；每天每个窗口最多 1 条（`state.lastBedtimeReportAt` 记当日）。
- 审计：`tool: "bili_dm"`，`args.report: true`，`why: "睡前汇报"`。


---

## 21. 每次醒来都汇报（可选）+ 传输失败重试一次（2026-11-01，用户已选）

### 21.1 每次醒来发一条简短私信（`dmEveryWake`）

- 新开关 `schedule.dmEveryWake`（布尔，**默认 false**；用户的实例已打开）；
- 触发：**每次成功 tick 结束后**，若 `dmEveryWake === true` 且 `allows.dm === true`，发一条短私信；
- 内容（**确定性模板**，≤200 字）：
  ```
  HH:MM 醒了。
  这轮：<做了什么——看过 N 条 / 说了 M 句；用 todayCounts 的增量>
  说：「<这一轮她真正说的话；空则省略这一行>」
  ```
- **与睡前汇报互斥**：若这一轮已经发了睡前汇报（`maybeBedtimeReport` 命中），**不再发**普通的每醒一条（一晚不要两条）；
- 走 `bili_dm`，受 `dmGapSec`（60 秒）限制；失败只记审计、不重试、不阻塞；
- 审计：`tool:"bili_dm"`、`args.wakeReport: true`、`why:"醒来汇报"`。

### 21.2 传输类失败重试一次（`brain.js`）

- 现状：模型调用失败（`llm-stream-failed`，含 `TRANSPORT: ...`）**不重试**，连续 3 次 → 静默 2 小时 → 整晚作废；
- 改成：**传输/流类错误重试 1 次**（总尝试次数仍为 2）；**解析失败（`brain-parse-failed`）的重试语义不变**；
- 若第 2 次仍失败 → 记 `llm-stream-failed` 到审计（含原始错误文本前 120 字），**不额外加静默**（退避仍由 `markFailure` 的连续失败计数决定）；
- 审计里能看出"重试过"：失败行的 `args.retried === true`。


---

## 22. 看完必须评论并 @主人（2026-11-01，用户第二次明确要求）

背景：§20.1 只写了「真有话说才发」，结果她一整晚一条评论都没发。用户要求：看完视频就要评论并 @主人。

### 22.1 语义（代码兜底，不靠提示词）

- 每轮 tick 结束时检查：这一轮是否看过视频（bili_watch / bili_video_info / bili_playurl 成功过）且是否发过评论；
- 看过但没评论 → 兜底补一条：
  1. 目标 bvid：优先取本轮 bili_watch 返回列表第一条；拿不到就用 state.lastWatchedBvid；都没有 → 跳过并记 why；
  2. 正文：优先用本轮 thought.say（去掉 @xx 前缀与换行，≤120 字）；为空则用短兜底句「看完这条了，先记着。」（承认没话说，不编观点）；
  3. atOwner 受 schedule.atOwnerOnComment 控制；
  4. 审计 args.commentFallback: true、why:「看完评论（兜底）」。
- 闸不变：allows.comment、confidence >= 30、comment 每日上限、写间隔 120 秒、同 bvid 去重、token 预算；任一不过 → 跳过并记 why，不重试。
- 每轮最多补一条。

### 22.2 提示层

brain 的 system 第 9 条改写为：看完视频后用 bili_comment 在该 bvid 下评论一句自己的感受，并 atOwner: true @主人；每轮至少一条。没特别想说的就写一句实话（例如「看完这条了，先记着」），不要编造观点。

### 22.3 风险（写进 README）

按默认作息一晚最多 8–10 条评论，频率偏高（B站 对高频评论可能限流或删评）。设置里可关：commentAfterWatch（默认开）。


---

## 23. 有人回复/私信时要回（2026-11-01，用户要求）

### 23.1 私信回复（主人发来消息）

- 现有：事件轮询每 5 分钟读 bili_dm_inbox，指纹变化且来自主人 → runOnce('dm')；
- 新增：**dm 触发的那一轮结束时，若本轮没有发出 bili_dm，则兜底补一条**（正文用本轮 thought.say，空则「看到你的消息了，我先记着。」）；
- 开关 schedule.replyToDm（默认 true）；走 runActions，私信闸（owner-only、dmGapSec、token 预算）照旧；
- 审计 args.dmFallback: true、why:「回复私信（兜底）」。

### 23.2 评论回复（别人回了她的评论）

- 记录：bili_comment 成功后写 state.myComments（{ bvid, aid, rpid, at }，最多 20 条，旧的丢）；aid 在评论成功后用 bili_video_info({bvid}) 取一次（取不到就跳过该条追踪）；
- 检查时机：每次 **tick 结束时**，最多检查 **3 条最新**、且 at 在 48 小时内的评论：bili_replies({ oid: aid, root: rpid })；
- 判新：子回复里 mid 不是我的 mid、且 rpid 不在 state.seenReplyRpids（最多 100）→ 视为有新回复；
- 触发：若有新回复，把最近 3 条新回复的正文写进上下文，在**同一轮内**调用 runActions 让大脑用 bili_reply({ oid: aid, root: rpid, rpid: 对方 rpid, message }) 回一句；
- 兜底：大脑没回（或回了失败），用本轮 thought.say（空则「看到了，等下细说。」）补一条 bili_reply；每轮最多补一条；
- 开关 schedule.replyToComments（默认 true）；bili_reply 走六道闸（含通道开关、写间隔、去重）；
- 审计：检查结果写 args.replyCheck（检查了几条、发现几条新），兜底回复写 args.replyFallback: true。

### 23.3 成本上限

- 每轮最多新增 **3** 次读请求（检查回复用）；每轮最多 **1** 条回复（兜底）；
- 若 allows.reply 为 false 或写间隔未到 → 只记录「有新回复但没回」，审计 why 里写原因，**不重试**。


---

## 24. 有人 @她时要回（2026-11-01，用户要求）

现状：内核没有「@我的」读端点，`bili_dm_inbox` 的兜底只覆盖「回复我的」。需要新增一个只读工具。

### 24.1 新工具 `bili_at_me`（第 25 个工具）

- 端点：`GET /x/msgfeed/atme`（params：`pn=1`、`type=0`）；**只读**，不过写闸；
- 入参：`{ limit?: number }`（1–10，默认 5，即 `pn` 固定 1，取前 limit 条）；
- 出参：`{ ok, count, items: [{ id, mid, uname, at, type, text, bvid?, oid, root?, rpid? }] }`
  - `type`：`comment` / `dynamic` / `video` 等（按端点原样映射，未知一律 `other`）；
  - `oid / root / rpid` 尽量从 `item.business_id / subject_id / root_id / source_id / target_id` 与 `uri` 解析；**解析不出就省略字段**，不要编；
  - `text` 取 `source_content` 前 120 字；
- 失败（未登录/风控/网络）→ 原样透出 `reason`，**不抛**；
- 需加入 `TOOL_NAMES`（总数 24 → **25**）、工具描述与 output schema。

### 24.2 自主层：`ensureMentionReply()`

- 时机：**每次 tick 结束时**，与评论回复共用 30 分钟节流（`lastReplyCheckAt` 复用；两件事都在同一个窗口里做）**或者**独立节流 `lastMentionCheckAt`（实现选一个，但要写清）；
- 检查：`bili_at_me({ limit: 5 })`；`id` 不在 `state.seenAtMeIds`（上限 100）→ 视为新 @；
- 回复：若解析出 `oid + root + rpid` → 用 `bili_reply` 回一句；只解析出 `oid`（动态/视频评论）→ 跳过并在审计写原因；
- 正文：本轮 `thought.say`（空则「看到你@我了，我来了。」）；每轮最多 **1 条**；走 `runActions`，六道闸照旧；
- 审计：`args.mentionCheck`（查了 n 条 / 新 m 条）、兜底回复 `args.mentionFallback: true`、`why:"回复@我（兜底）"`；
- 开关 `schedule.replyToMentions`（默认 true）。

### 24.3 已有的收紧（顺带）

- `ensureCommentReply()` 判新回复时**必须同时满足**：`root === 她的 rpid`、**`parent === 她的 rpid`**（直接回她）、`mid !== selfMid`、`rpid` 未见。实测 `bili_replies` 返回里 `parent` 字段存在（已验证），**别人回别人不该她插嘴**。


---

## 25. 真理解视频：下载 → 交给宿主的 video_understand（2026-11-02，用户已选）

现状：bili_watch({deep:true}) 返回 capability-not-found（可用能力只有 video.fetch / comment.fetch / dynamic.feed / account.status）。

### 25.1 已核实的两个事实
1. bili_playurl({bvid, qn:64}) 返回的是**单文件 mp4 直链**（urls: [{order,length,size,url}]），不是 DASH —— 不需要合流，直接 HTTP GET 即可（必须带 Referer: https://www.bilibili.com/）；
2. 宿主机有 **ffmpeg 9.0.2 在 PATH**，且宿主自带工具 video_understand({path, question, detail}) 吃**本地文件路径**、内部抽帧 + 转写。

### 25.2 要做的（新增 lib/core/deepwatch.js + bili_watch 的 deep 分支）
1. deep() 入口：给 bvid 与 question，流程：
   ① bili_playurl({bvid, qn:64}) → 取 urls[0]（若 acceptQuality 有更高清，按 80 / 64 依次尝试）；
   ② **体积闸**：size > 200MB → 直接返回 bad-argument（这条太大，不下），不下载；
   ③ 下载到临时文件（os.tmpdir()/dsh-bili/<bvid>.mp4），带 Referer 与 UA，**超时 180 秒**、最大 200MB、流式写盘；
   ④ 调宿主 video_understand：
      - 先 ctx.tools.get('video_understand')；
      - 拿不到再查能力注册表 video.understand；
      - 都拿不到 → 返回 capability-not-found，文案说明宿主没有提供 video_understand，**并删掉已下载的临时文件**；
   ⑤ 把它的返回（summary / answer / transcript 摘要）整理成工具结果；
   ⑥ **无论成功失败都删临时文件**（finally）。
2. bili_watch({deep:true, deepCount:1})：对列表前 deepCount 条（上限 3）走 deep()，结果挂到该条的 deep 字段；失败那条只挂 {ok:false, reason}，**不影响整批**。
3. 限额：每次 deep 最多下载 1 个文件；**同一 bvid 10 分钟内不重复下载**（state.deepWatchCache）。

### 25.3 不做的事（明确边界）
- 不碰 DASH、不自己抽帧（那是宿主 video_understand 的活）；
- 不下载弹幕/字幕；
- 不把下载的文件留在盘上。

## 26. 建议实施顺序

1. `persona/memory/diary/state/audit` 五个文件层（纯函数，先写测试）
2. `schedule`（窗口/抖动/上限/单飞锁/退避）+ 手动 `run-once` 路由
3. `brain`（拼上下文 + 调 llm + 解析 + 降级）——**先用假 llm 打通**
4. `actions`（白名单 + 预算检查 + 去重 + 审计）
5. 事件插队（只读轮询）
6. 设置页「她」一页 + 形象对接（`ctx.avatar` 可选）
7. 真机联调顺序：**只读 → 私信主人 → 评论 → 最后才打开自主发动态**