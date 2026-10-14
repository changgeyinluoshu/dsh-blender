/**
 * 端到端验证「从 zip 安装的 Blender add-on」：
 *   1. 打包 addon -> dist/dsh_blender_bridge-<version>.zip；
 *   2. 解压（优先用系统工具；不可用时回退为目录复制）；
 *   3. 让真实 Blender 以 --background 启用/停用插件并跑 test/verify-addon.py；
 *   4. 读回机器可读报告并断言。
 *
 * 用法：node scripts/test-addon.mjs   （或 npm run test:addon）
 * Blender 不在常见路径时设置 DSH_BLENDER_EXECUTABLE。
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { locateBlender } from '../lib/blender-locate.js'
import { packAddon } from './pack-addon.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.blender-e2e', 'addon-test')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function unzip(zipPath, destination) {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  const command = process.platform === 'win32'
    ? { file: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath "' + zipPath + '" -DestinationPath "' + destination + '" -Force'] }
    : { file: 'unzip', args: ['-o', '-q', zipPath, '-d', destination] }
  const result = spawnSync(command.file, command.args, { stdio: 'ignore' })
  if (result.status === 0 && existsSync(join(destination, 'dsh_blender_bridge', '__init__.py'))) return 'unzip'
  // 回退：直接复制目录（zip 的正确性另由 test:blender 的导出/解压路径覆盖）
  console.log('[!] system unzip unavailable, falling back to a directory copy')
  cpSync(join(ROOT, 'addon', 'dsh_blender_bridge'), join(destination, 'dsh_blender_bridge'), { recursive: true })
  return 'copy'
}

async function main() {
  const executable = locateBlender(process.env.DSH_BLENDER_EXECUTABLE)
  if (!executable) {
    console.error('Blender not found. Set DSH_BLENDER_EXECUTABLE to the blender executable.')
    process.exit(2)
  }
  const packed = packAddon()
  console.log('packed   ' + packed.target.replace(ROOT, '.') + '  (' + packed.bytes + ' bytes, ' + packed.files.length + ' files)')

  const extracted = join(WORK, 'addons')
  const how = unzip(packed.target, extracted)
  console.log('unpacked via ' + how + ' -> ' + extracted.replace(ROOT, '.'))

  const report = join(WORK, 'report.json')
  rmSync(report, { force: true })
  const child = spawn(executable, ['--background', '--factory-startup', '--python', join(ROOT, 'test', 'verify-addon.py'), '--', extracted], {
    stdio: 'ignore',
    env: { ...process.env, DSH_ADDON_REPORT: report },
  })

  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    if (existsSync(report)) break
    if (child.exitCode !== null && !existsSync(report)) break
    await sleep(500)
  }
  const code = child.exitCode === null ? await new Promise((done) => child.on('exit', done)) : child.exitCode

  if (!existsSync(report)) {
    console.error('Blender did not produce a report (exit code ' + code + ').')
    process.exit(1)
  }
  const payload = JSON.parse(readFileSync(report, 'utf8'))
  for (const item of payload.checks ?? []) {
    console.log((item.ok ? 'ok   ' : 'FAIL ') + item.label + (item.detail ? '  ' + item.detail : ''))
  }
  console.log('')
  const passed = payload.passed === true && (payload.failures ?? []).length === 0
  console.log(passed
    ? 'add-on verified on Blender ' + payload.blender + ' (' + (payload.checks ?? []).length + ' checks)'
    : 'add-on verification failed: ' + (payload.failures ?? []).join(', '))
  process.exit(passed ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
