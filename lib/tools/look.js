/**
 * 外观与出图：材质、相机取景、渲染预览、视口截图。
 */
import { defineTool, renderJSON } from '../toolkit.js'
import { call } from './shared.js'

const OUTPUT = { schema: { type: 'object', additionalProperties: true }, render: renderJSON }

/** 创建材质/渲染类工具。 */
export function createLookTools(runtime) {
  return [
    defineTool({
      name: 'blender_material',
      description:
        'Create and assign Principled BSDF materials, or inspect what exists. ' +
        'action=create builds a material (colour, metallic, roughness, emission, alpha); action=assign puts it on one or more objects; ' +
        'action=set edits an existing material; action=list reports every material with its base colour and users. ' +
        'Colors accept [r, g, b] / [r, g, b, a] in 0..1 or a hex string like "#ff8800".',
      parameters: {
        action: { type: 'string', required: true, enum: ['create', 'assign', 'set', 'list'], description: 'Operation to perform.' },
        name: { type: 'string', description: 'Material name (created when missing for assign).' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Objects to assign the material to (action=assign).' },
        color: { type: 'array', items: { type: 'number' }, description: 'Base colour as [r, g, b] or [r, g, b, a] in 0..1.' },
        hex: { type: 'string', description: 'Base colour as hex, e.g. "#ff8800".' },
        metallic: { type: 'number', description: 'Metallic 0..1.' },
        roughness: { type: 'number', description: 'Roughness 0..1.' },
        emission_strength: { type: 'number', description: 'Emission strength (0 disables).' },
        emission_color: { type: 'array', items: { type: 'number' }, description: 'Emission colour [r, g, b].' },
        alpha: { type: 'number', description: 'Alpha 0..1 (below 1 switches the material to blended transparency).' },
        transmission: { type: 'number', description: 'Transmission 0..1 for glass-like surfaces.' },
        ior: { type: 'number', description: 'Index of refraction (default 1.45).' },
        replace_all: { type: 'boolean', description: 'With action=assign, clear existing material slots first.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const { action, ...params } = args
        return call(runtime, `material.${action}`, params, exec)
      },
    }),

    defineTool({
      name: 'blender_render_view',
      description:
        'Render a PNG preview of the scene from a camera and return the file path (open it with the read_image tool to actually look at the model). ' +
        'When no camera exists one is created and aimed at the selection (or at everything) — set camera="auto" to always reframe. ' +
        'Use workbench for a fast grey preview, EEVEE for materials, CYCLES for quality (slow, CPU by default).',
      parameters: {
        filepath: { type: 'string', description: 'Output PNG path or bare file name (default blender-outputs/render.NN.png).' },
        camera: { type: 'string', description: 'Camera object name, or "auto" to create/reframe one (default: active scene camera).' },
        target: { type: 'array', items: { type: 'string' }, description: 'Objects the auto camera should frame (default: selection, else everything).' },
        resolution: { type: 'array', items: { type: 'integer' }, description: 'Pixel size [x, y] (default [960, 720]).' },
        resolution_percentage: { type: 'integer', description: 'Resolution percentage (default 100).' },
        engine: { type: 'string', enum: ['BLENDER_WORKBENCH', 'BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES'], description: 'Render engine for this render.' },
        samples: { type: 'integer', description: 'Sample count (Cycles/EEVEE).' },
        transparent: { type: 'boolean', description: 'Transparent film background.' },
        frame: { type: 'integer', description: 'Frame to render (default current).' },
        view: { type: 'string', enum: ['camera', 'viewport'], description: 'viewport renders the live 3D view (GUI only, falls back to camera in background).' },
        auto_light: { type: 'boolean', description: 'When the scene has no light at all, add a temporary sun for this render only (default true; removed afterwards).' },
        light_energy: { type: 'number', description: 'Energy of that temporary sun (default 4).' },
        world_strength: { type: 'number', description: 'Temporarily override the world background strength for a brighter preview.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const params = { ...args }
        if (!params.filepath) params.filepath = runtime.allocateFile('render', '.png')
        else params.filepath = runtime.allocateFile(params.filepath, '.png')
        const result = await call(runtime, 'render.image', params, exec, { timeoutMs: Math.max(runtime.get('timeoutMs'), 600000) })
        return { ...result, hint: 'Use the read_image tool on this path to inspect the render.' }
      },
    }),

    defineTool({
      name: 'blender_screenshot',
      description:
        'Grab a screenshot of the Blender window or a 3D viewport area (GUI sessions only) and save it as PNG. ' +
        'Handy to see exactly what the user sees, including overlays, gizmos and the current view angle. ' +
        'In background/headless Blender this reports why it is unavailable — use blender_render_view instead.',
      parameters: {
        filepath: { type: 'string', description: 'Output PNG path or file name.' },
        area: {
          type: 'string',
          enum: ['VIEW_3D', 'WINDOW', 'all'],
          description: 'Which area to capture: the first 3D viewport, the whole Blender window, or every 3D viewport.',
        },
        max_size: { type: 'integer', description: 'Optional longest-edge limit; larger shots are scaled down.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const params = { ...args }
        const name = params.filepath || (params.area === 'all' ? 'viewport' : 'screenshot')
        delete params.filepath
        const result = await call(runtime, 'view.screenshot', { ...params, filepath: runtime.allocateFile(name, '.png') }, exec, { timeoutMs: 120000 })
        return { ...result, hint: 'Use the read_image tool on this path to look at it.' }
      },
    }),
  ]
}
