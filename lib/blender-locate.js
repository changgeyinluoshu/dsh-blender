/**
 * 跨平台定位 Blender 可执行文件。
 *
 * 只做「读」操作：环境变量 → 配置 → PATH → 常见安装目录。
 * 找不到时返回 null，由调用方给出安装提示，绝不猜测执行。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** 平台默认安装位置与可执行文件名。 */
const CANDIDATE_DIRS = {
  win32: [
    'C:\\Program Files\\Blender Foundation',
    'C:\\Program Files (x86)\\Blender Foundation',
    'D:\\Program Files\\Blender Foundation',
    'D:\\Blender',
    'D:\\steam\\steamapps\\common\\Blender',
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender',
    'D:\\SteamLibrary\\steamapps\\common\\Blender',
  ],
  darwin: ['/Applications', '/Applications/Blender.app/Contents/MacOS'],
  linux: ['/usr/bin', '/usr/local/bin', '/snap/bin', '/var/lib/flatpak/exports/bin', '/opt/blender'],
}

const EXE_NAME = { win32: 'blender.exe', darwin: 'Blender', linux: 'blender' }

/** 在 PATH 中查找（Windows 用 where，其余用 which）。 */
function fromPath() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const output = execFileSync(cmd, ['blender'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
    const first = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    if (first && existsSync(first)) return first
  } catch {
    /* 未安装或不在 PATH */
  }
  return null
}

/** 在候选目录中递归（深度 2）寻找可执行文件，优先版本号最大的目录。 */
function fromCandidateDirs() {
  const exe = EXE_NAME[process.platform] ?? 'blender'
  for (const dir of CANDIDATE_DIRS[process.platform] ?? []) {
    if (!existsSync(dir)) continue
    const direct = join(dir, exe)
    if (existsSync(direct) && statSync(direct).isFile()) return direct
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    // 目录名通常带版本号（Blender 4.2、Blender 5.2 LTS），按名称倒序取最新。
    entries.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
    for (const entry of entries) {
      const nested = join(dir, entry.name, exe)
      if (existsSync(nested) && statSync(nested).isFile()) return nested
      const macNested = join(dir, entry.name, 'Contents', 'MacOS', 'Blender')
      if (existsSync(macNested) && statSync(macNested).isFile()) return macNested
    }
  }
  return null
}

/**
 * 定位 Blender。顺序：显式路径 → 环境变量 → PATH → 常见目录。
 * @param {string} [explicit] 配置中显式指定的路径。
 * @returns {string|null} 可执行文件绝对路径。
 */
export function locateBlender(explicit) {
  for (const candidate of [explicit, process.env.DSH_BLENDER_EXECUTABLE, process.env.BLENDER_EXECUTABLE]) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return fromPath() ?? fromCandidateDirs()
}

/** 供 agent 阅读的安装提示。 */
export const BLENDER_INSTALL_HINT =
  '未找到 Blender 可执行文件。请安装 Blender（https://www.blender.org/download/），' +
  '或用 blender_configure action=set 指定 blenderPath，' +
  '或设置环境变量 DSH_BLENDER_EXECUTABLE 指向 blender 可执行文件。'

/**
 * 读取 Blender 版本号（形如 "5.2.2 LTS"）。失败返回 null。
 * @param {string} executable Blender 可执行文件路径。
 * @returns {string|null}
 */
export function blenderVersion(executable) {
  if (!executable) return null
  try {
    const output = execFileSync(executable, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 })
    const match = output.match(/Blender\s+([0-9][^\r\n]*)/)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

/**
 * 定位 Blender 的用户级 add-on 目录（用于自动安装桥插件）。
 * @param {string} [version] 形如 "5.2.2 LTS" 的版本号；缺省时取最新的版本目录。
 * @returns {string|null} `…/scripts/addons` 目录（可能尚不存在）。
 */
export function locateAddonDir(version) {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const roots = process.platform === 'win32'
    ? [join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Blender Foundation', 'Blender')]
    : process.platform === 'darwin'
      ? [join(home, 'Library', 'Application Support', 'Blender')]
      : [join(home, '.config', 'blender'), join(home, '.var', 'app', 'org.blender.Blender', 'config', 'blender')]
  const major = version ? version.trim().split(/\s+/)[0].split('.').slice(0, 2).join('.') : null
  for (const root of roots) {
    if (!existsSync(root)) continue
    let versions = []
    try {
      versions = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      continue
    }
    if (versions.length === 0) continue
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    const chosen = major && versions.includes(major) ? major : versions[0]
    return join(root, chosen, 'scripts', 'addons')
  }
  return null
}
