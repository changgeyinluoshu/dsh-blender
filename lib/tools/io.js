/**
 * 进出 Blender 的数据通道：导出、导入、文件与撤销、以及万能脚本口。
 */
import { defineTool, renderJSON } from '../toolkit.js'
import { call } from './shared.js'

const OUTPUT = { schema: { type: 'object', additionalProperties: true }, render: renderJSON }

/** 各种导出格式的默认扩展名。 */
const EXPORT_EXT = {
  glb: '.glb',
  gltf: '.gltf',
  fbx: '.fbx',
  obj: '.obj',
  stl: '.stl',
  ply: '.ply',
  usd: '.usdz',
  usda: '.usda',
  blend: '.blend',
}

/** 创建数据进出类工具。 */
export function createIoTools(runtime) {
  return [
    defineTool({
      name: 'blender_export',
      description:
        'Export the scene (or just the selection) to a 3D file and return its path: glb/gltf for the web and game engines, ' +
        'fbx for Unity/Unreal, obj/stl for mesh pipelines and 3D printing, usdz for AR, blend for a Blender copy. ' +
        'Set selected_only=true to export only selected objects. Modifiers are baked into the exported mesh by default.',
      parameters: {
        format: { type: 'string', required: true, enum: Object.keys(EXPORT_EXT), description: 'Export format.' },
        filepath: { type: 'string', description: 'Target path or file name (default blender-outputs/<scene>.<ext>).' },
        selected_only: { type: 'boolean', description: 'Export only selected objects.' },
        apply_modifiers: { type: 'boolean', description: 'Bake modifiers into the exported mesh (default true).' },
        triangulate: { type: 'boolean', description: 'Triangulate faces on export (default false).' },
        y_up: { type: 'boolean', description: 'Convert to Y-up (glTF/FBX/OBJ convention, default true).' },
        scale: { type: 'number', description: 'Uniform export scale (default 1).' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const ext = EXPORT_EXT[args.format] ?? '.glb'
        const stem = args.filepath || (args.format === 'blend' ? 'scene' : `${args.format}-export`)
        const filepath = runtime.allocateFile(stem, ext)
        return call(runtime, 'export.file', { ...args, filepath }, exec, { timeoutMs: Math.max(runtime.get('timeoutMs'), 300000) })
      },
    }),

    defineTool({
      name: 'blender_import',
      description:
        'Import a 3D file into the scene (obj, fbx, stl, ply, glb/gltf, usd, dae, or a .blend file). ' +
        'Use absolute paths; relative paths resolve against the session working directory. Returns the imported object names.',
      parameters: {
        filepath: { type: 'string', required: true, description: 'Absolute path (or path relative to the working directory) of the file to import.' },
        format: { type: 'string', description: 'Force an importer (obj/fbx/stl/ply/gltf/usd/blend); by default the extension decides.' },
        location: { type: 'array', items: { type: 'number' }, description: 'Where to place the imported objects [x, y, z].' },
        scale: { type: 'number', description: 'Uniform import scale.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return call(runtime, 'import.file', args, exec, { timeoutMs: Math.max(runtime.get('timeoutMs'), 300000) })
      },
    }),

    defineTool({
      name: 'blender_file',
      description:
        'File and history control: undo/redo the last modelling step, save the current .blend (save_as writes to a new path), ' +
        'open another .blend, start a fresh file, or revert to the last saved state. ' +
        'action=open and action=new discard unsaved changes, so save first when the work matters.',
      parameters: {
        action: { type: 'string', required: true, enum: ['undo', 'redo', 'save', 'save_as', 'open', 'new', 'revert', 'info'], description: 'What to do.' },
        filepath: { type: 'string', description: 'Target file for save_as / open.' },
        steps: { type: 'integer', description: 'Undo/redo step count (default 1).' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return call(runtime, 'file.op', args, exec, { timeoutMs: Math.max(runtime.get('timeoutMs'), 300000) })
      },
    }),

    defineTool({
      name: 'blender_run_python',
      description:
        'Run a Python snippet inside Blender on the main thread — the escape hatch when no dedicated tool fits. ' +
        'The snippet runs with `bpy`, `bmesh`, `mathutils` and `math` available; assign a variable named `result` ' +
        '(JSON-serializable) to return structured data, and use print() for progress text. ' +
        'Keep snippets short and idempotent; wrap risky work in try/except and report what happened.',
      parameters: {
        code: { type: 'string', required: true, description: 'Python source to execute inside Blender.' },
        timeoutMs: { type: 'integer', description: 'Timeout hint for long-running snippets (default 120000).' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return call(runtime, 'python.exec', { code: args.code }, exec, {
          timeoutMs: Math.max(args.timeoutMs ?? 0, runtime.get('timeoutMs'), 120000),
        })
      },
    }),
  ]
}
