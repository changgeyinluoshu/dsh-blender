/**
 * 工具实现共用的调用与整形辅助。
 */
import { sendCommand } from '../bridge.js'

/**
 * 向 Blender 桥发送命令。
 * @param {object} runtime 运行时配置访问器。
 * @param {string} cmd 命令名（与 addon 侧一致）。
 * @param {object} params 命令参数。
 * @param {object} exec DSH 工具执行上下文（含 signal）。
 * @param {object} [options] 覆盖项（timeoutMs）。
 * @returns {Promise<any>} Blender 返回的 result。
 */
export function call(runtime, cmd, params, exec, options = {}) {
  const config = runtime.all()
  return sendCommand({
    host: config.host,
    port: config.port,
    token: config.token,
    cmd,
    params: params ?? {},
    timeoutMs: options.timeoutMs ?? config.timeoutMs,
    signal: exec?.signal,
  })
}

/** 把 Blender 的尺寸数组渲染成人类可读的一行。 */
export function dims(values) {
  if (!Array.isArray(values)) return '—'
  return values.map((value) => (typeof value === 'number' ? value.toFixed(3) : String(value))).join(' × ')
}

/** 把对象摘要压成单行文本，便于在列表里扫读。 */
export function objectLine(object) {
  const parts = [`${object.name} [${object.type}]`]
  if (Array.isArray(object.dimensions)) parts.push(`尺寸 ${dims(object.dimensions)}`)
  if (Array.isArray(object.location)) parts.push(`位置 (${object.location.map((v) => Number(v).toFixed(2)).join(', ')})`)
  if (typeof object.vertices === 'number') parts.push(`${object.vertices} 顶点/${object.polygons} 面`)
  if (Array.isArray(object.materials) && object.materials.length > 0) parts.push(`材质 ${object.materials.join(', ')}`)
  if (Array.isArray(object.modifiers) && object.modifiers.length > 0) parts.push(`修改器 ${object.modifiers.join(', ')}`)
  if (object.selected) parts.push('已选中')
  return parts.join(' · ')
}

/** 在线检查：不在线时给出可执行的修复提示。 */
export async function ensureOnline(runtime, exec) {
  const config = runtime.all()
  try {
    return await call(runtime, 'ping', {}, exec, { timeoutMs: 4000 })
  } catch (error) {
    const hint = `Blender 桥不可达（${config.host}:${config.port}）。` +
      '请在 Blender 中启用「DSH Blender Bridge」插件（编辑 > 偏好设置 > 插件），' +
      '或用 blender_configure action=launch 让 DSH 启动 Blender。' +
      `\n原始错误：${error?.message ?? error}`
    const wrapped = new Error(hint)
    wrapped.code = error?.code ?? 'BRIDGE_OFFLINE'
    throw wrapped
  }
}
