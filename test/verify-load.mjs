/**
 * 宿主加载验证：离线复现 DSH 加载本插件时的全部关键契约。
 *
 * 检查：
 *   1. 按包名解析入口 + 插件元信息（name / inject / apply）；
 *   2. 每个工具的 parameters / output.schema 都被 **DSH 官方** 的
 *      assertSupportedJsonSchema 接受（不是我们自己写的检查）；
 *   3. 在真实 cordis Context 里执行 apply，复刻 dsh-tools register() 的门槛；
 *   4. 断网（Blender 未运行）时工具的执行路径给出可操作提示，而不是崩溃。
 *
 * 用法：node test/verify-load.mjs
 */
import { register } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 验证期间把配置写到工作区内的临时目录，避免污染用户真实的 DSH 主目录。
const SANDBOX_HOME = join(dirname(fileURLToPath(import.meta.url)), '..', '.blender-e2e', 'config')
mkdirSync(SANDBOX_HOME, { recursive: true })
process.env.DSH_HOME = SANDBOX_HOME

register('./hooks.mjs', import.meta.url)

let failed = 0
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? '  ' + detail : ''}`)
}

// ---- 1. 入口与元信息 -------------------------------------------------------
const mod = await import('dsh-blender-studio')
check('包名可解析入口', mod.name === 'blender-studio', `name=${mod.name}`)
check('inject 声明 tools', JSON.stringify(mod.inject) === '["tools"]', JSON.stringify(mod.inject))
check('导出 apply 函数', typeof mod.apply === 'function')
check('导出 buildTools（验证/测试用）', typeof mod.buildTools === 'function')

// ---- 2. schema 通过 DSH 官方校验器 ----------------------------------------
const { assertSupportedJsonSchema } = await import('@deepseek-ai/dsh-tools')
const { tools } = mod.buildTools({ port: 9899 })
check('工具数量达到预期', tools.length >= 18, `${tools.length} 个工具`)

let schemaFailures = 0
for (const tool of tools) {
  try {
    assertSupportedJsonSchema(tool.parameters)
    assertSupportedJsonSchema(tool.output.schema)
  } catch (error) {
    schemaFailures += 1
    console.log(`    ✘ ${tool.name}: ${error.message}`)
  }
}
check('全部工具的 schema 被官方校验器接受', schemaFailures === 0)

const names = tools.map((tool) => tool.name)
check('工具名唯一', new Set(names).size === names.length)
check('工具名统一使用 blender_ 前缀', names.every((name) => name.startsWith('blender_')), names.slice(0, 3).join(', '))
check('每个工具都有描述与 execute', tools.every((tool) => tool.description?.length > 30 && typeof tool.execute === 'function'))
check('每个工具都声明 output.render', tools.every((tool) => typeof tool.output?.render === 'function'))

// ---- 3. 真实 cordis 上下文里注册 ------------------------------------------
const { Context } = await import('@deepseek-ai/cordis')
const root = new Context()
const registered = []
const disposers = []
root.provide('tools', {
  register(definition) {
    // 复刻 @deepseek-ai/dsh-tools 的 register() 门槛
    if (!definition.output || typeof definition.output.render !== 'function') {
      throw new TypeError(`tool "${definition.name}" must declare output { schema, render }`)
    }
    assertSupportedJsonSchema(definition.output.schema)
    if (definition.name === 'run_code') throw new Error('reserved name')
    registered.push(definition)
    const dispose = () => {
      const index = registered.indexOf(definition)
      if (index >= 0) registered.splice(index, 1)
    }
    disposers.push(dispose)
    return dispose
  },
})
const summary = mod.apply(root, { host: '127.0.0.1', port: 9899, timeoutMs: 5000 })
check('apply 返回注册清单', Array.isArray(summary.registered) && summary.registered.length === tools.length, `${summary.registered?.length} 个`)
check('registry 收到了全部工具', registered.length === tools.length)
check('注册顺序与工具表一致', registered.every((tool, index) => tool.name === tools[index].name))

// ---- 4. 离线行为 -----------------------------------------------------------
const admin = tools.find((tool) => tool.name === 'blender_configure')
const status = await admin.execute({ action: 'status' }, {})
check('离线时 status 仍返回诊断信息', status.bridge_online === false && typeof status.output_dir === 'string')

const doctor = await admin.execute({ action: 'doctor' }, {})
check('doctor 给出可执行的排查步骤', Array.isArray(doctor.diagnosis) && doctor.diagnosis.length > 0, doctor.diagnosis?.[0]?.message?.slice(0, 40))

const listTool = tools.find((tool) => tool.name === 'blender_list_objects')
let offlineError = ''
try {
  await listTool.execute({}, {})
} catch (error) {
  offlineError = error.message
}
check('离线调用建模工具时提示 Blender 未连接', offlineError.includes('Blender') && offlineError.includes('DSH Blender Bridge'), offlineError.slice(0, 48))

const configure = tools.find((tool) => tool.name === 'blender_configure')
const unknownPort = await configure.execute({ action: 'set', port: 9911 }, {})
check('配置写入持久化文件', unknownPort.config?.port === 9911 && unknownPort.persisted === true, unknownPort.config_file)
await configure.execute({ action: 'set', port: 9899 }, {})

// ---- 5. 结果渲染 -----------------------------------------------------------
const rendered = tools[0].output.render({}, { hello: 'world' })
check('render 返回内容块数组', Array.isArray(rendered) && rendered[0]?.type === 'text', JSON.stringify(rendered).slice(0, 40))

// ---- 6. 卸载 ---------------------------------------------------------------
for (const dispose of disposers) dispose()
check('disposer 能撤销注册（插件可热卸载）', registered.length === 0)

console.log('\n' + (failed === 0 ? '全部通过' : `失败 ${failed} 项`))
process.exit(failed === 0 ? 0 : 1)
