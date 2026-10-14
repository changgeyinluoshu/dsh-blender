/**
 * 与 Blender 侧 DSH Blender Bridge 插件的通信层。
 *
 * 传输：TCP + NDJSON（每行一个 JSON 对象），只连回环地址。
 *   请求  {"id":1,"cmd":"scene.info","params":{},"token":""}
 *   成功  {"id":1,"ok":true,"result":{...}}
 *   失败  {"id":1,"ok":false,"error":{"message":"...","code":"...","traceback":"..."}}
 *
 * 每次请求新建一条连接：本地 TCP 建连成本可忽略，换来的是没有残留状态、
 * 不受 Blender 端重启影响。超时/中止都会销毁 socket，避免句柄泄漏。
 */
import net from 'node:net'

/** 稳定错误码。 */
export const BRIDGE_ERROR = {
  OFFLINE: 'BRIDGE_OFFLINE',
  TIMEOUT: 'BRIDGE_TIMEOUT',
  ABORTED: 'BRIDGE_ABORTED',
  PROTOCOL: 'BRIDGE_PROTOCOL',
  REMOTE: 'BRIDGE_REMOTE',
}

const OFFLINE_HINT =
  '无法连接 Blender 桥（默认 127.0.0.1:9880）。请确认：① Blender 正在运行；' +
  '② 已启用 DSH Blender Bridge 插件（编辑 > 偏好设置 > 插件，或 3D 视图侧栏 DSH 面板）；' +
  '③ 端口一致（blender_configure 可查看/修改）。也可用 blender_configure action=launch 让 DSH 拉起 Blender。'

/** 桥通信错误，携带稳定 code 与排错提示。 */
export class BridgeError extends Error {
  constructor(message, code, detail) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

let nextId = 1

/**
 * 发送一条命令并等待结果。
 * @param {object} options 目标与命令。
 * @returns {Promise<any>} Blender 侧返回的 result。
 */
export function sendCommand(options) {
  const {
    host = '127.0.0.1',
    port = 9880,
    cmd,
    params = {},
    token = '',
    timeoutMs = 30000,
    signal,
  } = options ?? {}
  if (!cmd) return Promise.reject(new BridgeError('sendCommand: cmd is required', BRIDGE_ERROR.PROTOCOL))
  const id = nextId++

  return new Promise((resolve, reject) => {
    let settled = false
    let buffer = ''
    const socket = net.createConnection({ host, port })
    socket.setNoDelay(true)

    const timer = setTimeout(() => {
      fail(new BridgeError(`Blender 桥在 ${timeoutMs} ms 内没有响应（命令 ${cmd}）。大模型/高采样渲染请调大超时。`, BRIDGE_ERROR.TIMEOUT))
    }, Math.max(1000, Number(timeoutMs) || 30000))

    const onAbort = () => fail(new BridgeError(`命令 ${cmd} 已被中止。`, BRIDGE_ERROR.ABORTED))

    function cleanup() {
      clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
      socket.removeAllListeners()
      socket.destroy()
    }

    function fail(error) {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    function succeed(value) {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    if (signal) {
      if (signal.aborted) return fail(new BridgeError(`命令 ${cmd} 已被中止。`, BRIDGE_ERROR.ABORTED))
      signal.addEventListener('abort', onAbort, { once: true })
    }

    socket.on('connect', () => {
      socket.write(JSON.stringify({ id, cmd, params, token }) + '\n')
    })

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) {
          let message
          try {
            message = JSON.parse(line)
          } catch (error) {
            return fail(new BridgeError(`Blender 桥返回了无法解析的数据：${line.slice(0, 200)}`, BRIDGE_ERROR.PROTOCOL))
          }
          if (message.id !== undefined && message.id !== id) {
            // 一个连接只发一条命令，id 不匹配说明对端状态错乱。
            return fail(new BridgeError('Blender 桥返回了不匹配的响应 id。', BRIDGE_ERROR.PROTOCOL))
          }
          if (message.ok === false || message.error) {
            const info = message.error ?? {}
            return fail(new BridgeError(
              `Blender 执行 ${cmd} 失败：${info.message ?? '未知错误'}`,
              BRIDGE_ERROR.REMOTE,
              { cmd, code: info.code, traceback: info.traceback },
            ))
          }
          return succeed(message.result)
        }
        index = buffer.indexOf('\n')
      }
    })

    socket.on('error', (error) => {
      if (error && (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH')) {
        return fail(new BridgeError(OFFLINE_HINT, BRIDGE_ERROR.OFFLINE, { host, port, code: error.code }))
      }
      if (error && error.code === 'ECONNRESET') {
        return fail(new BridgeError('与 Blender 的连接被重置：Blender 可能已退出或插件被禁用。', BRIDGE_ERROR.OFFLINE, { host, port }))
      }
      fail(new BridgeError(`连接 Blender 桥失败：${error?.message ?? error}`, BRIDGE_ERROR.OFFLINE, { host, port }))
    })

    socket.on('close', () => {
      if (!settled) fail(new BridgeError('Blender 桥在返回结果前关闭了连接。', BRIDGE_ERROR.PROTOCOL, { cmd }))
    })
  })
}

/**
 * 轻量连通性探测（不会抛错）。
 * @param {object} options host/port/timeoutMs。
 * @returns {Promise<{online: boolean, info?: any, error?: string}>}
 */
export async function probe(options = {}) {
  try {
    const info = await sendCommand({ ...options, cmd: 'ping', params: {}, timeoutMs: options.timeoutMs ?? 2500 })
    return { online: true, info }
  } catch (error) {
    return { online: false, error: error instanceof Error ? error.message : String(error), code: error?.code }
  }
}
