/**
 * 运行时配置与文件落盘策略。
 *
 * 配置优先级（后者覆盖前者）：
 *   内置默认 → 持久化 JSON（blender_configure 写入）→ 环境变量 → cordis 配置。
 * 这样「下载即用」不需要任何配置，同时保留 profile/cordis.patch.yml 的覆盖能力。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, extname, basename } from 'node:path'

/** 内置默认值。 */
export const DEFAULTS = {
  enabled: true,
  host: '127.0.0.1',
  port: 9880,
  token: '',
  timeoutMs: 60000,
  blenderPath: '',
  outputDir: '',
  inlineImages: false,
}

/** 持久化配置目录（DSH 主目录，跨会话保留）。 */
export function configDir() {
  return process.env.DSH_HOME || process.env.DSH_PROFILE_DIR?.replace(/[\\/]profiles[\\/].*$/, '') || join(homedir(), '.dsh-beta')
}

/** 持久化配置文件路径。 */
export function configFile() {
  return join(configDir(), '.dsh-blender-studio.json')
}

function readPersisted() {
  try {
    const file = configFile()
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function fromEnv() {
  const env = {}
  if (process.env.DSH_BLENDER_HOST) env.host = process.env.DSH_BLENDER_HOST
  if (process.env.DSH_BLENDER_PORT) env.port = Number(process.env.DSH_BLENDER_PORT)
  if (process.env.DSH_BLENDER_TOKEN) env.token = process.env.DSH_BLENDER_TOKEN
  if (process.env.DSH_BLENDER_OUTPUT_DIR) env.outputDir = process.env.DSH_BLENDER_OUTPUT_DIR
  return env
}

function pick(value) {
  const out = {}
  for (const [key, item] of Object.entries(value ?? {})) {
    if (item === undefined || item === null || item === '') continue
    out[key] = item
  }
  return out
}

/**
 * 创建运行时对象。`apply(ctx)` 中已经解析过 cordis 配置，这里按优先级合并。
 * @param {object} cordisConfig cordis.patch.yml / 设置页传入的配置。
 * @returns {object} 运行时访问器。
 */
export function createRuntime(cordisConfig = {}) {
  const layers = [DEFAULTS, pick(readPersisted()), pick(fromEnv()), pick(cordisConfig)]
  const settings = Object.assign({}, ...layers)
  settings.port = Number(settings.port) || DEFAULTS.port
  settings.timeoutMs = Number(settings.timeoutMs) || DEFAULTS.timeoutMs
  settings.enabled = settings.enabled !== false

  return {
    /** 当前生效配置（只读副本）。 */
    all: () => ({ ...settings }),
    get: (key) => settings[key],
    /**
     * 写回持久化配置并立即生效。
     * 落盘失败（只读目录、沙箱限制）不阻断本次会话：配置仍在内存里生效，
     * 只是重启后丢失，返回值里会说明。
     */
    update(patch) {
      const persisted = pick(readPersisted())
      const next = { ...persisted, ...pick(patch) }
      const file = configFile()
      let persistedOk = true
      let warning
      try {
        mkdirSync(configDir(), { recursive: true })
        writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
      } catch (error) {
        persistedOk = false
        warning = `配置无法写入 ${file}（${error?.message ?? error}）：本次会话内仍然生效，但重启后会丢失。可用环境变量 DSH_BLENDER_HOST / DSH_BLENDER_PORT / DSH_BLENDER_OUTPUT_DIR 固定配置。`
      }
      Object.assign(settings, pick(patch))
      if (patch?.port !== undefined) settings.port = Number(settings.port) || DEFAULTS.port
      return { file, persisted: persistedOk, ...(warning ? { warning } : {}), settings: { ...settings } }
    },
    /** 解析产物目录：显式配置优先，否则落在会话工作区的 blender-outputs/。 */
    outputDir() {
      const dir = settings.outputDir ? resolve(settings.outputDir) : join(process.cwd(), 'blender-outputs')
      mkdirSync(dir, { recursive: true })
      return dir
    },
    /**
     * 生成一个不会被覆盖的产物路径。
     * @param {string} name 期望的文件名（可带或不带扩展名）。
     * @param {string} fallbackExt 缺省扩展名（含点，例如 ".png"）。
     * @returns {string} 绝对路径。
     */
    allocateFile(name, fallbackExt) {
      const dir = this.outputDir()
      const raw = (name && String(name).trim()) || 'blender'
      const safe = basename(raw).replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
      const ext = extname(safe) || fallbackExt
      const stem = extname(safe) ? safe.slice(0, -ext.length) : safe
      let candidate = join(dir, stem + ext)
      let index = 1
      while (existsSync(candidate)) {
        candidate = join(dir, `${stem}.${String(index).padStart(2, '0')}${ext}`)
        index += 1
      }
      return candidate
    },
    /** 列出产物目录里最近的产物文件（用于 fallback 展示）。 */
    recentFiles(limit = 20) {
      const dir = this.outputDir()
      try {
        return readdirSync(dir)
          .filter((name) => !name.startsWith('.'))
          .slice(-limit)
          .map((name) => join(dir, name))
      } catch {
        return []
      }
    },
    configFile,
  }
}
