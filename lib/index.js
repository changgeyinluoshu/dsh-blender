/**
 * dsh-blender-studio — DSH（DeepSeek Harness）插件入口。
 *
 * 作用：把 Blender 变成 agent 可以真正操作的建模工具。插件在 DSH 侧注册一组
 * `blender_*` 工具，它们通过本地 TCP（NDJSON）与 Blender 内的
 * 「DSH Blender Bridge」插件通信；Blender 侧在主线程执行 bpy 命令。
 *
 * 设计约束（为了「从 GitHub 下载即可用」）：
 *   • 零 npm 依赖：不 import 任何第三方包，也不需要 pnpm install；
 *   • 配置可选：不配任何东西也能跑，配置来源见 runtime.js；
 *   • 只连回环地址：默认 127.0.0.1:9880，不对外暴露。
 */
import { createRuntime } from './runtime.js'
import { createSceneTools } from './tools/scene.js'
import { createMeshTools } from './tools/mesh.js'
import { createLookTools } from './tools/look.js'
import { createIoTools } from './tools/io.js'
import { createAdminTools } from './tools/admin.js'
import { probe } from './bridge.js'

/** cordis 插件名（cordis.patch.yml 的 name 字段引用它）。 */
export const name = 'blender-studio'

/** 依赖 DSH 的工具注册表就绪后再注册。 */
export const inject = ['tools']

/** 导出给验证脚本使用：不需要宿主也能构造工具表。 */
export function buildTools(config = {}) {
  const runtime = createRuntime(config)
  return {
    runtime,
    tools: [
      ...createSceneTools(runtime),
      ...createMeshTools(runtime),
      ...createLookTools(runtime),
      ...createIoTools(runtime),
      ...createAdminTools(runtime),
    ],
  }
}

/**
 * cordis 插件入口。
 * @param {object} ctx cordis 上下文（需要 tools 服务）。
 * @param {object} [config] cordis.patch.yml / DSH 设置页传入的配置。
 * @returns {object} 安装摘要（供验证脚本断言）。
 */
export function apply(ctx, config) {
  const resolved = config ?? ctx?.fiber?.config ?? {}
  const { runtime, tools } = buildTools(resolved)
  const log = (...parts) => {
    const message = parts.join(' ')
    if (typeof ctx?.logger?.info === 'function') ctx.logger.info(message)
    else console.log(`[blender-studio] ${message}`)
  }

  if (runtime.get('enabled') === false) {
    log('已在配置中禁用（enabled: false），未注册任何工具。')
    return { registered: [], runtime }
  }

  const registry = ctx?.tools ?? ctx?.get?.('tools')
  if (!registry || typeof registry.register !== 'function') {
    throw new Error('dsh-blender-studio: 缺少 tools 服务，无法注册 blender_* 工具。')
  }

  const disposers = []
  for (const tool of tools) {
    const dispose = registry.register(tool)
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 卸载期间的清理失败不应影响宿主 */
        }
      }
    })
  }

  const { host, port, outputDir } = { host: runtime.get('host'), port: runtime.get('port'), outputDir: runtime.outputDir() }
  log(`已注册 ${tools.length} 个工具，目标桥 ${host}:${port}，产物目录 ${outputDir}`)

  // 启动时做一次轻量探测，只写日志——Blender 没开是常态，绝不能因此让宿主起不来。
  probe({ host, port, timeoutMs: 1500 })
    .then((status) => {
      if (status.online) log(`已连接 Blender ${status.info?.blender ?? ''}（${status.info?.mode ?? '?'} 模式）`)
      else log('尚未检测到 Blender 桥。在 Blender 中启用「DSH Blender Bridge」插件，或运行 blender_configure action=launch。')
    })
    .catch(() => undefined)

  return { registered: tools.map((tool) => tool.name), runtime }
}
