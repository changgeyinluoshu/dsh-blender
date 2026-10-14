/**
 * 把 Blender 插件打包成可直接安装的 zip（无第三方依赖，自己写 ZIP 容器）。
 *
 * 产物：dist/dsh_blender_bridge-<version>.zip
 * 用法：node scripts/pack-addon.mjs   （或 npm run pack:addon）
 *
 * zip 顶层就是 dsh_blender_bridge/，因此：
 *   • Blender 3.6–4.1：Preferences > Add-ons > Install from Disk… 选择该 zip；
 *   • Blender 4.2+    ：Extensions > Install from Disk… 同样可用（含 blender_manifest.toml）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const ADDON_NAME = 'dsh_blender_bridge'
const SOURCE = join(ROOT, 'addon', ADDON_NAME)
const DIST = join(ROOT, 'dist')

/** 递归列出要打包的文件（跳过缓存与隐藏文件）。 */
function walk(directory, base = directory) {
  const entries = []
  for (const name of readdirSync(directory).sort()) {
    if (name === '__pycache__' || name.startsWith('.')) continue
    const full = join(directory, name)
    const info = statSync(full)
    if (info.isDirectory()) entries.push(...walk(full, base))
    else if (!name.endsWith('.pyc')) entries.push({ full, relative: relative(base, full).split(sep()).join('/') })
  }
  return entries
}

/** 路径分隔符（写成函数是为了让打包结果在任何平台都用 / 作为条目分隔）。 */
function sep() {
  return process.platform === 'win32' ? '\\' : '/'
}

// ---------------------------------------------------------------- ZIP 容器

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff]
  return (crc ^ -1) >>> 0
}

/** DOS 时间戳（zip 格式要求）。 */
function dosDateTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  return { time, date: day }
}

/**
 * 生成一个 zip 缓冲区。
 * @param {Array<{name: string, data: Buffer}>} files 条目（name 使用 / 分隔）。
 * @returns {Buffer}
 */
export function createZip(files) {
  const chunks = []
  const central = []
  let offset = 0
  const now = dosDateTime(new Date())

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, 'utf8')
    const crc = crc32(file.data)
    const deflated = deflateRawSync(file.data, { level: 9 })
    const useDeflate = deflated.length < file.data.length
    const payload = useDeflate ? deflated : file.data
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(now.time, 10)
    local.writeUInt16LE(now.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuffer, payload)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(method, 10)
    dir.writeUInt16LE(now.time, 12)
    dir.writeUInt16LE(now.date, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(payload.length, 20)
    dir.writeUInt32LE(file.data.length, 24)
    dir.writeUInt16LE(nameBuffer.length, 28)
    dir.writeUInt16LE(0, 30)
    dir.writeUInt16LE(0, 32)
    dir.writeUInt16LE(0, 34)
    dir.writeUInt16LE(0, 36)
    dir.writeUInt32LE(0, 38)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, nameBuffer)

    offset += local.length + nameBuffer.length + payload.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuffer, end])
}

// ---------------------------------------------------------------- 主流程

export function packAddon() {
  if (!existsSync(SOURCE)) throw new Error(`add-on sources not found: ${SOURCE}`)
  const manifest = join(SOURCE, 'blender_manifest.toml')
  let version = '0.0.0'
  if (existsSync(manifest)) {
    const match = readFileSync(manifest, 'utf8').match(/^version\s*=\s*"([^"]+)"/m)
    if (match) version = match[1]
  }
  const files = walk(SOURCE).map((entry) => ({
    name: `${ADDON_NAME}/${entry.relative}`,
    data: readFileSync(entry.full),
  }))
  if (files.length === 0) throw new Error('no files to pack')
  mkdirSync(DIST, { recursive: true })
  const target = join(DIST, `${ADDON_NAME}-${version}.zip`)
  const zip = createZip(files)
  writeFileSync(target, zip)
  return { target, files, bytes: zip.length, version }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/pack-addon.mjs')) {
  const result = packAddon()
  console.log(`packed ${result.files.length} files -> ${relative(ROOT, result.target)} (${result.bytes} bytes)`)
  for (const file of result.files) console.log(`  ${file.name}`)
}
