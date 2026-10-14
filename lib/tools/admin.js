/**
 * 安装与运维类工具：查看连接、改配置、启动 Blender、安装/更新 Blender 侧插件。
 */
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool, renderJSON } from '../toolkit.js'
import { probe } from '../bridge.js'
import { locateBlender, locateAddonDir, blenderVersion, BLENDER_INSTALL_HINT } from '../blender-locate.js'

const OUTPUT = { schema: { type: 'object', additionalProperties: true }, render: renderJSON }

/** 包内 Blender 插件源码目录。 */
function addonSourceDir() {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', 'addon', 'dsh_blender_bridge')
}

/** 递归复制 add-on（覆盖旧版本）。 */
function installAddon(target) {
  const source = addonSourceDir()
  if (!existsSync(source)) throw new Error(`包内缺少 Blender 插件源码：${source}`)
  mkdirSync(target, { recursive: true })
  cpSync(source, join(target, 'dsh_blender_bridge'), { recursive: true, force: true })
  return { source, target: join(target, 'dsh_blender_bridge') }
}

/** 创建安装/运维类工具。 */
export function createAdminTools(runtime) {
  return [
    defineTool({
      name: 'blender_configure',
      description:
        'Bridge administration: action=status shows the connection, paths and Blender add-on state; action=set changes host/port/token/' +
        'blenderPath/outputDir/timeoutMs and persists it; action=launch starts Blender (optionally opening a .blend) and waits for the bridge; ' +
        'action=install_addon copies the bundled Blender add-on into the user add-on folder; action=doctor explains why nothing connects.',
      parameters: {
        action: { type: 'string', required: true, enum: ['status', 'set', 'launch', 'install_addon', 'doctor'], description: 'Operation to perform.' },
        host: { type: 'string', description: 'Bridge host (default 127.0.0.1).' },
        port: { type: 'integer', description: 'Bridge TCP port (default 9880).' },
        token: { type: 'string', description: 'Optional shared token required by the Blender add-on.' },
        blenderPath: { type: 'string', description: 'Absolute path to the Blender executable (action=set).' },
        outputDir: { type: 'string', description: 'Where renders and exports are written (action=set).' },
        timeoutMs: { type: 'integer', description: 'Default command timeout in milliseconds.' },
        file: { type: 'string', description: 'For action=launch: a .blend file to open.' },
        wait_seconds: { type: 'integer', description: 'For action=launch: how long to wait for the bridge (default 45).' },
        enable: { type: 'boolean', description: 'For action=install_addon: also try to enable it via a headless Blender run.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const action = args.action
        if (action === 'set') {
          const patch = {}
          for (const key of ['host', 'port', 'token', 'blenderPath', 'outputDir', 'timeoutMs']) {
            if (args[key] !== undefined && args[key] !== '') patch[key] = args[key]
          }
          const saved = runtime.update(patch)
          return { updated: patch, config_file: saved.file, persisted: saved.persisted, warning: saved.warning, config: saved.settings }
        }

        if (action === 'install_addon') {
          const executable = locateBlender(runtime.get('blenderPath'))
          const version = executable ? blenderVersion(executable) : null
          const addonsDir = locateAddonDir(version)
          if (!addonsDir) {
            return {
              installed: false,
              reason: '找不到 Blender 用户插件目录：请先运行一次 Blender，或用 Blender 的「安装插件」对话框选择包内 addon/dsh_blender_bridge 目录。',
              addon_source: addonSourceDir(),
            }
          }
          const result = installAddon(addonsDir)
          let enabled = null
          if (args.enable && executable) {
            enabled = await tryEnableAddon(executable)
          }
          return {
            installed: true,
            addon_dir: result.target,
            addons_root: addonsDir,
            blender: executable,
            blender_version: version,
            enable: enabled ?? '在 Blender 中打开 编辑 > 偏好设置 > 插件，搜索 “DSH Blender Bridge” 并勾选启用（或重启 Blender）。',
          }
        }

        if (action === 'launch') {
          const executable = locateBlender(runtime.get('blenderPath'))
          if (!executable) return { launched: false, reason: BLENDER_INSTALL_HINT }
          const argv = args.file ? [resolve(args.file)] : []
          const child = spawn(executable, argv, { detached: true, stdio: 'ignore' })
          child.unref()
          const waitSeconds = Math.min(Math.max(args.wait_seconds ?? 45, 5), 300)
          const deadline = Date.now() + waitSeconds * 1000
          let status = { online: false }
          while (Date.now() < deadline) {
            status = await probe({ host: runtime.get('host'), port: runtime.get('port'), timeoutMs: 2000 })
            if (status.online) break
            await sleep(1000)
          }
          return {
            launched: true,
            executable,
            pid: child.pid,
            bridge_online: status.online,
            hint: status.online
              ? undefined
              : 'Blender 已启动，但桥未上线：请在 Blender 中启用「DSH Blender Bridge」插件（编辑 > 偏好设置 > 插件）。',
          }
        }

        // status / doctor
        const config = runtime.all()
        const executable = locateBlender(config.blenderPath)
        const version = executable ? blenderVersion(executable) : null
        const addonsDir = locateAddonDir(version)
        const installedTarget = addonsDir ? join(addonsDir, 'dsh_blender_bridge') : null
        const status = await probe({ host: config.host, port: config.port, timeoutMs: 3000 })
        const payload = {
          bridge_online: status.online,
          bridge: status.info ?? null,
          target: `${config.host}:${config.port}`,
          config,
          config_file: runtime.configFile(),
          output_dir: runtime.outputDir(),
          blender_executable: executable,
          blender_version: version,
          addon_installed: installedTarget ? existsSync(installedTarget) : false,
          addon_target: installedTarget,
          addon_source: addonSourceDir(),
        }
        if (action === 'status') return payload
        return { ...payload, diagnosis: await diagnose(payload) }
      },
    }),
  ]
}

/** 简单等待。 */
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** 用一次后台 Blender 运行启用插件并保存用户偏好。 */
async function tryEnableAddon(executable) {
  return new Promise((resolvePromise) => {
    const expr = "import addon_utils,bpy;addon_utils.enable('dsh_blender_bridge',default_set=True);bpy.ops.wm.save_userpref();print('DSH_ADDON_ENABLED')"
    const child = spawn(executable, ['--background', '--python-expr', expr], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      resolvePromise('启用超时，请在 Blender 界面手动勾选插件。')
    }, 90000)
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8') })
    child.on('close', () => {
      clearTimeout(timer)
      resolvePromise(output.includes('DSH_ADDON_ENABLED') ? '已在 Blender 用户偏好中启用。' : `自动启用未确认，请手动勾选。输出：${output.slice(-300)}`)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise(`自动启用失败：${error.message}`)
    })
  })
}

/** 为 doctor 生成可执行的诊断清单。 */
async function diagnose(payload) {
  const problems = []
  if (payload.bridge_online) {
    problems.push({ severity: 'ok', message: `桥已连通：Blender ${payload.bridge?.blender ?? '未知版本'}（${payload.bridge?.mode ?? '?'} 模式）。` })
  } else {
    if (!payload.blender_executable) problems.push({ severity: 'error', message: BLENDER_INSTALL_HINT })
    if (payload.addon_installed === false) {
      problems.push({ severity: 'error', message: '用户插件目录里没有 dsh_blender_bridge：运行 blender_configure action=install_addon 安装后再启用。' })
    } else {
      problems.push({ severity: 'warn', message: '插件文件已就位但桥未响应：确认 Blender 正在运行、插件已勾选、端口一致（3D 视图侧栏 DSH 面板可看到端口）。' })
    }
    problems.push({ severity: 'info', message: '也可以运行 blender_configure action=launch 让 DSH 直接拉起 Blender。' })
  }
  return problems
}
