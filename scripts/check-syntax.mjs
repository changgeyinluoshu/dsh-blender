/**
 * 语法自检：对所有 JS/MJS 文件跑 `node --check`（不执行代码，避免触发会自运行的测试脚本），
 * 并在有 python 时编译一遍 Blender 侧源码。
 *
 * 用法：node scripts/check-syntax.mjs   （npm run check）
 */
import { readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 递归收集需要检查的源码（跳过产物与缓存目录）。 */
function walk(directory) {
  const files = []
  for (const name of readdirSync(directory).sort()) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(directory, name)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else if (name.endsWith('.js') || name.endsWith('.mjs')) files.push(full)
  }
  return files
}

let failed = 0
const files = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'test'))]
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' })
  const label = file.slice(ROOT.length + 1)
  if (result.status === 0) {
    console.log('ok   ' + label)
  } else {
    failed += 1
    console.log('FAIL ' + label)
  }
}

const addonDir = join(ROOT, 'addon', 'dsh_blender_bridge')
const pyFiles = readdirSync(addonDir).filter((name) => name.endsWith('.py')).map((name) => join(addonDir, name))
const python = process.platform === 'win32' ? 'python' : 'python3'
const compiled = spawnSync(python, ['-m', 'py_compile', ...pyFiles], { stdio: 'ignore' })
if (compiled.error || compiled.status === null) {
  console.log('[!] python not available - skipped the add-on compile check')
} else if (compiled.status !== 0) {
  failed += 1
  console.log('FAIL add-on python compile')
} else {
  console.log('ok   addon python compile (' + pyFiles.length + ' files)')
}

console.log('')
console.log(failed === 0 ? 'syntax check passed (' + files.length + ' js files)' : 'syntax check failed: ' + failed)
process.exit(failed === 0 ? 0 : 1)
