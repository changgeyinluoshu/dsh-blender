/**
 * 建模核心：编辑模式网格操作、修改器、布尔运算。
 */
import { defineTool, renderJSON } from '../toolkit.js'
import { call } from './shared.js'

const OUTPUT = { schema: { type: 'object', additionalProperties: true }, render: renderJSON }

/** 创建网格编辑类工具。 */
export function createMeshTools(runtime) {
  return [
    defineTool({
      name: 'blender_mesh_edit',
      description:
        'Direct mesh editing in Edit Mode on one object: extrude the selection along a vector, inset faces, bevel edges, ' +
        'subdivide, solidify (give thickness), merge vertices by distance, flip normals, or delete faces. ' +
        'This is how you turn primitives into real shapes. Most actions operate on everything selected inside the mesh ' +
        'unless select="none" is given, in which case only the pre-existing selection is used.',
      parameters: {
        name: { type: 'string', required: true, description: 'Mesh object to edit.' },
        action: {
          type: 'string',
          required: true,
          enum: ['extrude', 'inset', 'bevel', 'subdivide', 'solidify', 'merge_by_distance', 'flip_normals', 'delete_faces', 'smooth_vertices', 'decimate_unsubdivide', 'triangulate'],
          description: 'Edit operation.',
        },
        select: {
          type: 'string',
          enum: ['all', 'none'],
          description: 'Whether to select the whole mesh first (default all). Use none to act on the current mesh selection.',
        },
        move: { type: 'array', items: { type: 'number' }, description: 'Extrude translation [x, y, z] (default [0, 0, 1]).' },
        thickness: { type: 'number', description: 'Inset thickness, solidify thickness, or bevel width depending on action.' },
        depth: { type: 'number', description: 'Inset depth (positive pushes the face outward).' },
        width: { type: 'number', description: 'Bevel width (alias of thickness for action=bevel).' },
        segments: { type: 'integer', description: 'Bevel or subdivide segment count.' },
        cuts: { type: 'integer', description: 'Subdivision cuts (default 1).' },
        threshold: { type: 'number', description: 'Merge-by-distance threshold in metres (default 0.0001).' },
        angle_limit: { type: 'number', description: 'Bevel angle limit in degrees (default 30).' },
        smoothness: { type: 'number', description: 'Subdivide smoothness 0..1.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return call(runtime, 'mesh.edit', args, exec, { timeoutMs: Math.max(runtime.get('timeoutMs'), 120000) })
      },
    }),

    defineTool({
      name: 'blender_modifier',
      description:
        'Add, configure, apply, remove or list modifiers on an object — a non-destructive way to get smoother or more complex geometry. ' +
        'Supported types include SUBSURF, BEVEL, MIRROR, SOLIDIFY, ARRAY, BOOLEAN, SIMPLE_DEFORM, DECIMATE, REMESH, SCREW, WIREFRAME, CAST, EDGE_SPLIT, TRIANGULATE. ' +
        'props are written straight onto the modifier (e.g. { levels: 2, render_levels: 2 } for SUBSURF, { width: 0.02, segments: 3 } for BEVEL, ' +
        '{ count: 5, relative_offset_displace: [0, 0, 1] } for ARRAY). Set apply=true to bake it into the mesh immediately.',
      parameters: {
        action: { type: 'string', required: true, enum: ['add', 'apply', 'remove', 'clear', 'list'], description: 'Operation to perform.' },
        name: { type: 'string', description: 'Target object name (defaults to the active object).' },
        type: { type: 'string', description: 'Modifier type for action=add, e.g. SUBSURF.' },
        modifier: { type: 'string', description: 'Existing modifier name for apply/remove.' },
        props: { type: 'object', description: 'Modifier properties to set, e.g. { "levels": 2 }.' },
        apply: { type: 'boolean', description: 'With action=add, apply the modifier right away.' },
        index: { type: 'integer', description: 'Insertion index (default append at the end).' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return call(runtime, 'modifier.manage', args, exec, { timeoutMs: Math.max(runtime.get('timeoutMs'), 180000) })
      },
    }),

    defineTool({
      name: 'blender_boolean',
      description:
        'Boolean-combine two meshes: cut the cutter out of the target (DIFFERENCE), weld them (UNION) or keep only the overlap (INTERSECT). ' +
        'The cutter is hidden afterwards by default; apply=true bakes the result into the target mesh and deletes the cutter geometry from the scene. ' +
        'Make sure both objects overlap and have consistent normals (blender_mesh_edit action=flip_normals fixes inverted ones).',
      parameters: {
        target: { type: 'string', required: true, description: 'Object that receives the result.' },
        cutter: { type: 'string', required: true, description: 'Object used as the cutter.' },
        operation: { type: 'string', enum: ['DIFFERENCE', 'UNION', 'INTERSECT'], description: 'Boolean operation (default DIFFERENCE).' },
        apply: { type: 'boolean', description: 'Apply the modifier immediately (default true).' },
        solver: { type: 'string', enum: ['EXACT', 'FAST'], description: 'Solver (default EXACT).' },
        keep_cutter: { type: 'boolean', description: 'Keep the cutter object visible (default false: it is hidden, or deleted when apply=true).' },
        delete_cutter: { type: 'boolean', description: 'Delete the cutter object when apply=true (default true).' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return call(runtime, 'boolean.op', args, exec, { timeoutMs: Math.max(runtime.get('timeoutMs'), 180000) })
      },
    }),
  ]
}
