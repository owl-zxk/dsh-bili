// 能力注册表：本包对外的唯一扩展点（"内核管怎么跟 B站 说话，扩展管说什么"）。
//
// 为什么要有它，而不是把功能都写进内核：
//   视频理解、表情包、直播这些能力各自需要的依赖（视觉模型 / ffmpeg / 直播间接口）
//   一旦进了内核，内核就得为它们的升级节奏负责，而且任何一项装不上都会拖垮整个插件。
//   注册表把这件事变成"谁有本事谁挂进来"，内核不需要知道对方存在。
//
// 为什么调用未注册的能力**绝不抛异常**：
//   模型看不到异常，只看得到工具返回值。抛出去的结果是"整个工具调用失败"，
//   模型不知道自己该换条路；返回 { ok:false, reason:'capability-not-found', available:[…] }
//   则等于当场告诉它"现在能用的只有这些" —— 这是可恢复的错误，不是崩溃。
//
// 为什么重复 id 要抛：
//   那是**装配期**错误（两个插件抢同一个 id，或者同一个插件注册两遍）。
//   装的时候炸响，比运行期悄悄用后者覆盖前者好得多 —— 后者会让"能力是谁提供的"变成谜。
//
// 为什么 onAdded 存在：工具描述要动态反映"现在有没有这个能力"。
//   能力是别的插件在 apply 之后才挂进来的，描述文本若在注册工具时就固定，
//   模型永远看到"不可用"（哪怕它已经可用）。所以描述里那段文字靠这个回调触发重算 / 记日志。
import { explainCode } from './credentials.js'

const ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
const KINDS = ['analyze', 'fetch', 'transform', 'decide']

/**
 * 建一个注册表。
 * @param {{log?: (message: string) => void}} [options] log 只会收到"谁挂了什么"，永远不含 payload
 */
export function createCapabilityRegistry (options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  /** @type {Map<string, {id: string, kind: string, description: string, run: Function, schema?: object}>} */
  const entries = new Map()
  const listeners = new Set()

  const safeLog = (message) => {
    try { log(message) } catch { /* 日志坏了不该影响注册 */ }
  }
  const notify = () => {
    for (const cb of [...listeners]) {
      try { cb(api.list()) } catch (error) { safeLog('能力变更回调抛错：' + String(error?.message ?? error)) }
    }
  }
  const ids = () => [...entries.keys()]

  function validate (def) {
    if (def === null || typeof def !== 'object') throw new Error('registerCapability: 能力定义必须是一个对象')
    const id = String(def.id ?? '').trim()
    if (!ID_PATTERN.test(id)) {
      throw new Error(`registerCapability: 能力 id 必须形如 <域>.<动作>（小写字母/数字/下划线），收到：${id === '' ? '(空)' : id}`)
    }
    const kind = String(def.kind ?? '').trim()
    if (!KINDS.includes(kind)) {
      throw new Error(`registerCapability: 能力 ${id} 的 kind 必须是 ${KINDS.join(' | ')} 之一，收到：${kind === '' ? '(空)' : kind}`)
    }
    if (typeof def.run !== 'function') throw new Error(`registerCapability: 能力 ${id} 缺少 run(payload, ctx) 函数`)
    const description = String(def.description ?? '').trim()
    if (description === '') throw new Error(`registerCapability: 能力 ${id} 必须有 description（工具描述要直接引用它）`)
    return { id, kind, description }
  }

  const api = {
    /** 注册一个能力。@returns {() => boolean} 卸下它的函数（插件卸载时用得上） */
    register (def) {
      const { id, kind, description } = validate(def)
      if (entries.has(id)) throw new Error(`registerCapability: 能力 id 重复：${id}（同一个 id 只能有一个提供者）`)
      entries.set(id, {
        id,
        kind,
        description,
        run: def.run,
        ...(def.schema !== null && typeof def.schema === 'object' ? { schema: def.schema } : {}),
      })
      safeLog(`能力已注册：${id}（${kind}）`)
      notify()
      return () => api.unregister(id)
    },

    /** 卸下一个能力。@returns {boolean} 之前是否存在 */
    unregister (id) {
      const existed = entries.delete(String(id ?? '').trim())
      if (existed) notify()
      return existed
    },

    /** 能力清单（工具描述与 bili_status 用）。 */
    list () {
      return [...entries.values()].map(({ id, kind, description }) => ({ id, kind, description }))
    },

    has (id) {
      return entries.has(String(id ?? '').trim())
    },

    /**
     * 调一个能力。**绝不抛**：
     *   · 没注册 → capability-not-found + available（模型据此换路）
     *   · 能力自己炸了 → bili-error + 人话（不把栈丢给模型）
     * @param {string} id
     * @param {object} [payload]
     * @param {{signal?: AbortSignal}} [callOptions]
     */
    async call (id, payload, callOptions = {}) {
      const key = String(id ?? '').trim()
      const entry = entries.get(key)
      if (entry === undefined) {
        return {
          ok: false,
          reason: 'capability-not-found',
          id: key,
          available: ids(),
          human: ids().length === 0
            ? `能力 ${key} 当前不可用：现在还没有任何扩展插件挂进来`
            : `能力 ${key} 当前不可用（没有插件注册它）；现在可用的是：${ids().join('、')}`,
        }
      }
      // ctx 只给"读"的能力：id / kind / 查询函数 / 取消信号。
      // 不给注册表的写入口 —— 能力 A 不该顺手把能力 B 卸掉。
      const ctx = {
        id: entry.id,
        kind: entry.kind,
        signal: callOptions?.signal,
        list: () => api.list(),
        has: (other) => api.has(other),
      }
      try {
        const value = await entry.run(payload ?? {}, ctx)
        return value === undefined ? { ok: true, data: null } : value
      } catch (error) {
        if (error?.name === 'AbortError') {
          return { ok: false, reason: 'network', id: key, human: `能力 ${key} 被取消（调用方中断了这次请求）` }
        }
        const code = error?.code
        const suffix = typeof code === 'number' || (typeof code === 'string' && /^-?\d+$/.test(code))
          ? `（${explainCode(code)}）`
          : ''
        return {
          ok: false,
          reason: 'bili-error',
          id: key,
          human: `能力 ${key} 执行失败：${String(error?.message ?? error).slice(0, 180)}${suffix}`,
        }
      }
    },

    /** 监听能力变化。@returns {() => void} 取消订阅 */
    onAdded (cb) {
      if (typeof cb !== 'function') throw new Error('onCapabilityAdded: 需要一个回调函数')
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },

    /** 只读快照（含 schema；工具描述动态生成用）。改它不会影响注册表。 */
    snapshot () {
      return [...entries.values()].map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        description: entry.description,
        ...(entry.schema === undefined ? {} : { schema: structuredClone(entry.schema) }),
      }))
    },
  }

  return api
}
