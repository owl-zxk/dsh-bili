// 示例扩展：向 dsh-bili 内核注册一个能力（方向 A），再调一次内核接口（方向 B）。
//
// 为什么用 ctx.inject(['bili'], scoped => …) 而不是 export const inject = ['bili']：
//   inject: ['bili'] 是"本插件声明依赖 bili"，宿主会等内核就绪才 apply 本插件 ——
//   于是加载顺序取决于谁先装，出问题（"我的插件怎么没加载"）时日志里看不出因果。
//   ctx.inject 的写法是"bili 出现时跑这一段"：本插件自己的 apply 立刻完成，
//   内核缺席也不会让本插件加载失败。顺序因此可预测。
//
// 为什么能力返回 { ok:true, data } 而不是裸 payload：
//   内核按同一套信封读能力返回值（lib/core/capabilities.js 的 call）。
//   裸数据也能跑，但调用方就没法用 ok 分辨"能力成功了"和"能力自己失败了"。
//
// 为什么这里零真实网络：
//   示例要能在没凭据、没联网的机器上跑通，否则它只证明"网络是好的"，证明不了契约成立。
export const name = 'dsh-bili-echo'

/** 空数组：本示例不依赖内核以外的服务，也不该因为内核没装而加载失败。 */
export const inject = []

/**
 * 日志只有一个出口，且**永远只接字符串**：
 * 一旦让调用方直接 ctx.logger.info(payload)，迟早就有人把凭据或整份响应丢进去。
 * @param {object} ctx
 */
function createLog (ctx) {
  const logger = ctx === null || ctx === undefined ? null : ctx.logger
  const emit = (level) => (message) => {
    const line = typeof message === 'string' ? message : String(message)
    try {
      if (logger !== null && typeof logger === 'object' && typeof logger[level] === 'function') logger[level](line)
      else if (logger !== null && typeof logger === 'object' && typeof logger.info === 'function') logger.info(line)
      else console.log('[dsh-bili-echo] ' + line)
    } catch { /* 日志坏了不该影响插件 */ }
  }
  const log = emit('info')
  log.warn = emit('warn')
  log.error = emit('error')
  return log
}

/** 能力本体：回声 —— 原样返回 payload。这是方向 A 的最小可验证形状。 */
const ECHO_CAPABILITY = {
  id: 'echo.ping',
  kind: 'transform',
  description: '回声：原样返回 payload',
  async run (payload) {
    return { ok: true, data: payload }
  }
}

export function apply (ctx) {
  const log = createLog(ctx)
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.inject !== 'function') {
    log.warn('这个宿主没有 ctx.inject，示例不注册任何能力（工具不受影响）')
    return
  }
  log('已加载，等内核的 bili 服务出现')

  ctx.inject(['bili'], (scoped) => {
    const bili = scoped === null || scoped === undefined ? null : scoped.bili
    // 方法级检查而不是只查对象：宿主给的可能是一个空壳（内核版本偏旧时），
    // 那时直接调 registerCapability 会抛在 inject 回调里，异常没人接，看起来像插件崩了。
    if (bili === null || typeof bili !== 'object' || typeof bili.registerCapability !== 'function' || typeof bili.listCapabilities !== 'function') {
      log.warn('bili 服务不可用或不完整（内核没装 / 版本偏旧），跳过注册')
      return
    }

    // 方向 A：扩展提供能力，内核调用。内核不知道这个插件存在。
    bili.registerCapability(ECHO_CAPABILITY)
    log('能力已注册：echo.ping（transform）')

    // 方向 B：扩展调内核接口。只查内存里的清单，不打任何端点。
    const list = bili.listCapabilities()
    const ids = list.map((item) => (item === null || item === undefined ? '' : String(item.id))).filter((id) => id !== '')
    log('内核当前可用能力 ' + ids.length + ' 个：' + (ids.length === 0 ? '（一个都没有）' : ids.join('、')))
    if (typeof bili.getClient !== 'function') log.warn('内核没有暴露 getClient（版本可能偏旧）')
  })
}
