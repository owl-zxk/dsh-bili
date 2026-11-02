// 复制适配：逻辑一字未改（只加了这段注释）。
//   为什么必须连它一起复制：Electron 里 process.execPath 是 DSH 主程序，不是 node ✗
//   —— 用它去 spawn 子进程会启动第二个 DSH（实测），所以 node 的绝对路径要靠 runtime.mjs 探测。
//   现在本包没有子进程调用，但 api/tools 层一旦需要（例如上传图片、转码）就必须走它。
import { DSH_HOME } from './paths.mjs'
import { resolveRuntime } from './runtime.mjs'
const runtime = resolveRuntime(DSH_HOME, { allowCurrent: true })
export const NODE_EXE = runtime.file
export const NODE_ENV = runtime.env
// Also propagate to existing callers which inherit the tool process environment.
if (runtime.env.ELECTRON_RUN_AS_NODE === '1') process.env.ELECTRON_RUN_AS_NODE = '1'
export const isRealNode = (p = NODE_EXE) => p === NODE_EXE
