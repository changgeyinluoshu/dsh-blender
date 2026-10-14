/**
 * 真实 Blender 端到端测试（不依赖 DSH 宿主）。
 *
 * 做三件事：
 *   1. 用 `blender --background` 加载 addon 的 headless 桥；
 *   2. 走真实 TCP 协议发一串建模命令，拼一张桌子（桌面 + 四条腿 + 布尔 + 倒角 + 材质）；
 *   3. 断言对象/几何/文件都真的产出，并导出 GLB、渲染一张 PNG。
 *
 * 用法：node test/e2e-blender.mjs [--port 9899] [--keep]
 * Blender 不在常见路径时，设置 DSH_BLENDER_EXECUTABLE。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { locateBlender } from '../lib/blender-locate.js'
import { sendCommand } from '../lib/bridge.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const HEADLESS = join(PLUGIN_ROOT, 'addon', 'dsh_blender_bridge', 'dsh_headless.py')
const OUT_DIR = join(PLUGIN_ROOT, '.blender-e2e')

const argv = process.argv.slice(2)
const port = Number(argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : 9899)
const keep = argv.includes('--keep')

let failures = 0
const results = []
function check(label, ok, detail = '') {
  if (!ok) failures += 1
  results.push(`${ok ? '✔' : '✘'} ${label}${detail ? '  ' + detail : ''}`)
  console.log(results[results.length - 1])
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function startBlender(executable) {
  // 不用管道捕获输出：受限沙箱里 spawn 的 piped stdio 会被拒绝（EPERM），
  // 而且 Blender 的日志对「是否就绪」并不权威——就绪文件 + ping 才是判据。
  const readyFile = join(OUT_DIR, `bridge-${port}.json`)
  if (existsSync(readyFile)) rmSync(readyFile)
  const child = spawn(
    executable,
    ['--background', '--factory-startup', '--python', HEADLESS, '--', '--port', String(port), '--ready-file', readyFile],
    { stdio: 'ignore' },
  )
  const ready = (async () => {
    const deadline = Date.now() + 180000
    while (Date.now() < deadline) {
      if (existsSync(readyFile)) {
        try {
          return JSON.parse(readFileSync(readyFile, 'utf8'))
        } catch {
          /* 文件正在写入，稍后再试 */
        }
      }
      if (child.exitCode !== null) throw new Error(`Blender 提前退出（code=${child.exitCode}）`)
      await sleep(500)
    }
    throw new Error('Blender 桥在 180s 内没有就绪（可用 --keep 观察进程）。')
  })()
  return { child, ready }
}

async function main() {
  const executable = locateBlender()
  if (!executable) {
    console.error('未找到 Blender，可设置 DSH_BLENDER_EXECUTABLE 后重试。')
    process.exit(2)
  }
  console.log(`Blender: ${executable}`)
  mkdirSync(OUT_DIR, { recursive: true })
  const blender = startBlender(executable)
  let passed = false
  try {
    const bridgeInfo = await blender.ready
    check('headless 桥启动并报告就绪', bridgeInfo.port === port, `pid=${bridgeInfo.pid} blender=${bridgeInfo.blender} commands=${bridgeInfo.commands}`)
    // 不重试：建模命令有副作用，重试会掩盖真实失败并叠加效果
    const call = (cmd, params, timeoutMs = 120000) => sendCommand({ host: '127.0.0.1', port, cmd, params, timeoutMs })

    const ping = await call('ping', {})
    check('ping 返回 Blender 版本', typeof ping.blender === 'string' && ping.blender.length > 0, ping.blender)
    check('ping 报告 background 模式', ping.mode === 'background', ping.mode)

    const listed = await call('commands.list', {})
    check('命令注册表已装配', listed.count >= 25, `${listed.count} 个命令`)

    await call('scene.reset', {})
    const cube = await call('object.create', { kind: 'cube', name: 'TableTop', size: 2.0, location: [0, 0, 1.0], scale: [1, 1, 0.06] })
    check('创建桌面（cube）', cube.created?.name === 'TableTop' && cube.created.vertices === 8, JSON.stringify(cube.created?.dimensions))

    for (const [index, [x, y]] of [[-0.85, -0.85], [0.85, -0.85], [-0.85, 0.85], [0.85, 0.85]].entries()) {
      await call('object.create', { kind: 'cylinder', name: `Leg${index}`, radius: 0.07, depth: 1.0, segments: 16, location: [x, y, 0.5] })
    }
    const legs = await call('object.list', { filter: 'Leg' })
    check('创建四条桌腿', legs.total === 4, `${legs.total} 条`)

    const joined = await call('object.ops', { action: 'join', names: ['Leg0', 'Leg1', 'Leg2', 'Leg3'] })
    check('join 把四条腿合并成一个对象', joined.joined_into === 'Leg0', joined.joined_into)

    const renamed = await call('object.ops', { action: 'rename', name: 'Leg0', new_name: 'Legs' })
    check('rename 生效', renamed.new_name === 'Legs', renamed.new_name)

    await call('object.create', { kind: 'cylinder', name: 'Hole', radius: 0.3, depth: 3, segments: 24, location: [0, 0, 1] })
    const boolean = await call('boolean.op', { target: 'TableTop', cutter: 'Hole', operation: 'DIFFERENCE', apply: true })
    check('布尔 DIFFERENCE 改了拓扑并删掉 cutter', boolean.after && boolean.after.vertices > boolean.before.vertices && boolean.cutter_state === 'deleted', boolean.before.vertices + ' → ' + boolean.after.vertices + ' 顶点')

    const bevel = await call('modifier.manage', { action: 'add', name: 'Legs', type: 'BEVEL', props: { width: 0.005, segments: 2 }, apply: true })
    check('BEVEL 修改器添加并应用', bevel.applied === true && bevel.stats?.vertices > 0, `${bevel.stats?.vertices} 顶点`)

    const material = await call('material.create', { name: 'OakWood', hex: '#8b5a2b', roughness: 0.55, metallic: 0.05 })
    check('创建材质（hex 解析）', material.material?.base_color?.[0] > 0.4, JSON.stringify(material.material?.base_color))
    const assign = await call('material.assign', { name: 'OakWood', names: ['TableTop', 'Legs'] })
    check('材质指派到对象', (assign.assigned ?? []).length === 2, (assign.assigned ?? []).join(', '))

    const python = await call('python.exec', { code: "import bpy\nresult = {'objects': len(bpy.data.objects), 'materials': len(bpy.data.materials)}\nprint('hello from blender')" })
    check('python.exec 返回 stdout 与 result', python.result?.objects >= 2 && python.stdout.includes('hello from blender'), JSON.stringify(python.result))

    const summary = await call('scene.info', { with_objects: true })
    check('scene.info 汇总计数一致', summary.counts.objects === 2 && summary.counts.polygons > 20, JSON.stringify(summary.counts))

    const glbPath = join(OUT_DIR, 'table.glb')
    const exported = await call('export.file', { format: 'glb', filepath: glbPath, apply_modifiers: true }, 180000)
    const glbHeader = existsSync(glbPath) ? readFileSync(glbPath).subarray(0, 4).toString('utf8') : ''
    check('导出 GLB 且文件头正确', exported.bytes > 1000 && glbHeader === 'glTF', `${exported.bytes} 字节, magic=${glbHeader}`)

    const stlPath = join(OUT_DIR, 'table.stl')
    const stl = await call('export.file', { format: 'stl', filepath: stlPath, selected_only: false }, 120000)
    check('导出 STL', stl.bytes > 500, `${stl.bytes} 字节`)

    const pngPath = join(OUT_DIR, 'preview.png')
    const render = await call('render.image', { filepath: pngPath, engine: 'CYCLES', samples: 8, resolution: [320, 240], camera: 'auto' }, 300000)
    const pngSize = existsSync(pngPath) ? statSync(pngPath).size : 0
    const pngMagic = existsSync(pngPath) ? readFileSync(pngPath).subarray(1, 4).toString('utf8') : ''
    check('相机自动取景并渲染 PNG', pngSize > 2000 && pngMagic === 'PNG', `${pngSize} 字节, ${render.seconds}s`)

    const shape = await call('object.create', { kind: 'monkey', name: 'Suzanne', location: [0, 0, 2] })
    check('创建 Suzanne 猴头', shape.created?.polygons > 400, `${shape.created?.polygons} 面`)

    const shot = await call('view.screenshot', { filepath: join(OUT_DIR, 'shot.png') }).catch((error) => ({ error: error.message }))
    check('后台模式截图给出明确提示（而不是崩掉）', typeof shot.error === 'string' && shot.error.includes('后台'), shot.error?.slice(0, 60))

    const del = await call('object.delete', { names: ['Suzanne'] })
    check('删除对象', del.deleted?.[0] === 'Suzanne', (del.deleted ?? []).join(', '))

    passed = failures === 0
  } catch (error) {
    check(`测试异常：${error?.message ?? error}`, false)
  } finally {
    if (!keep) {
      blender.child.kill()
      await sleep(500)
    } else {
      console.log('（--keep：Blender 仍在运行，端口', port, '）')
    }
  }
  console.log('\n' + (passed ? `全部通过（${results.length} 项）` : `失败 ${failures} 项 / 共 ${results.length} 项`))
  process.exit(passed ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
