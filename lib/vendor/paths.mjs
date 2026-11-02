/**
 * 统一的路径解析（DSH home / 用户主目录 / 共享状态目录）。
 *
 * 这个文件是**复制**（不是依赖）来的，来源是实现参考里的 tools/lib/paths.mjs；
 * 复制即独立：对方插件被卸载，本包一个功能都不受影响（解耦红线）。
 * 复制之后只做了三处适配，每一处都写在这里，避免以后有人"顺手还原"：
 *
 * ① 删掉 configPath（以及它背后那个"用环境变量指向配置文件"的覆盖）。
 *    旧实现里它是**那个插件**自己的配置文件位置（$DSH_HOME/<它自己的名字>.config.json）。
 *    本包的配置归 core/config.js 管（$DSH_HOME/dsh-bili.config.json）；
 *    照抄过来等于两个插件共用一份配置，谁写谁坏。
 *
 * ② 新增 stateDir()：默认 <HOME>/.bili-ai，可用 $DSH_BILI_STATE_DIR 覆盖。
 *    旧实现把 ~/.bili-ai 在 bili-api.mjs / traffic.mjs 里各硬拼了三遍。
 *    风控状态（api-ban.json / api-cache.json / api-requests.log / traffic-state.json）
 *    与配额账本（quota.json）**必须共享**同一个目录，所以默认值原样保持 ~/.bili-ai ✓；
 *    但测试期禁止往真实 ~/.bili-ai 写替身，于是留一个环境变量把整套状态挪到临时目录。
 *    环境变量在**调用时**读（不是模块加载时），同一个进程里改了就生效。
 *
 * ③ 新增 credPath()：默认仍是 <HOME>/.bili-ai/credentials.json，可用 $DSH_BILI_CRED_PATH 覆盖。
 *    理由同 ②：凭据是共享只读的，默认值不能变；但"设置页保存 cookie"必须能在临时目录里测，
 *    否则一次测试就会覆盖主人真实的登录态 ✗（只有测试会设这个变量）。
 *
 * 保留不动：HOME 的解析顺序（USERPROFILE 优先于 HOME）、DSH_HOME 的解析顺序、
 *   dshPath / homePath 的语义 —— 宿主半边与工具链必须看到同一个 home，
 *   否则两边各读一份配置，症状是"设置页改了没效果"。
 */
import os from 'node:os'
import path from 'node:path'

/** 用户主目录（Windows 优先 USERPROFILE，保持与原实现一致）。 */
export const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.'

/** DSH home：与宿主侧完全一致的解析顺序。 */
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

/** 拼一个位于 DSH home 下的路径。 */
export const dshPath = (...parts) => path.join(DSH_HOME, ...parts)

/** 拼一个位于用户主目录下的路径（.bili-ai 等凭据/状态目录用）。 */
export const homePath = (...parts) => path.join(HOME, ...parts)

/**
 * 共享状态目录（缓存 / 熔断 / 请求日志 / 配额账本都落在这里）。
 * 见上面 ②：默认 ~/.bili-ai —— 与同一账号下的其它实现共用一份，是**故意**的。
 */
export function stateDir() {
  const override = process.env.DSH_BILI_STATE_DIR
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim())
  return homePath('.bili-ai')
}

/** 凭据文件：每个操作系统用户一份，与 DSH_HOME 无关（多个 profile 共用同一份登录态）。 */
export const credentialsPath = homePath('.bili-ai', 'credentials.json')

/** 实际生效的凭据文件（见上面 ③：只有测试会覆盖它）。 */
export function credPath() {
  const override = process.env.DSH_BILI_CRED_PATH
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim())
  return credentialsPath
}
