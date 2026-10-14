/**
 * 场景与对象类工具：连接状态、创建、选择、变换、复制、删除、对象运算。
 */
import { defineTool, renderJSON } from '../toolkit.js'
import { call, objectLine, ensureOnline } from './shared.js'

const OUTPUT = { schema: { type: 'object', additionalProperties: true }, render: renderJSON }

const VEC3 = { type: 'array', items: { type: 'number' }, description: 'XYZ 三元组' }

/** 创建场景/对象类工具。 */
export function createSceneTools(runtime) {
  return [
    defineTool({
      name: 'blender_status',
      description:
        'Connect to the running Blender and report bridge health plus scene summary: Blender version, current .blend file, ' +
        'render engine, unit settings, 3D cursor, object counts and (optionally) the full object list. ' +
        'Call this first — every other blender_* tool assumes this bridge is reachable.',
      parameters: {
        detail: {
          type: 'string',
          enum: ['summary', 'objects'],
          description: 'summary (default) reports counts only; objects also lists every object in the scene.',
        },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const ping = await ensureOnline(runtime, exec)
        const scene = await call(runtime, 'scene.info', { with_objects: args.detail === 'objects' }, exec)
        return {
          online: true,
          bridge: { version: ping.bridge, mode: ping.mode, port: runtime.get('port'), host: runtime.get('host') },
          blender: { version: ping.blender, executable: ping.executable ?? null },
          file: scene.file,
          is_dirty: scene.is_dirty,
          scene: scene.scene,
          engine: scene.engine,
          units: scene.units,
          cursor: scene.cursor,
          counts: scene.counts,
          selected: scene.selected,
          active: scene.active,
          collections: scene.collections,
          ...(Array.isArray(scene.objects) ? { objects: scene.objects.map(objectLine) } : {}),
        }
      },
    }),

    defineTool({
      name: 'blender_create_primitive',
      description:
        'Add a primitive mesh (or empty/camera/light) to the scene. This is the main building block for modelling: ' +
        'create a cube, sphere, cylinder, cone, torus, plane, grid, circle or Suzanne monkey and optionally position, ' +
        'rotate and scale it in one call. Returns the created object with its dimensions and topology counts.',
      parameters: {
        kind: {
          type: 'string',
          required: true,
          enum: ['cube', 'sphere', 'ico_sphere', 'cylinder', 'cone', 'torus', 'plane', 'grid', 'circle', 'monkey', 'empty', 'camera', 'light'],
          description: 'Primitive type. Defaults to a cube at the origin when in doubt.',
        },
        name: { type: 'string', description: 'Object name (defaults to the primitive name, e.g. Cube).' },
        location: { ...VEC3, description: 'World location [x, y, z], default [0, 0, 0].' },
        rotation: { ...VEC3, description: 'Rotation in DEGREES [x, y, z].' },
        scale: { ...VEC3, description: 'Scale [x, y, z], default [1, 1, 1].' },
        size: { type: 'number', description: 'Cube/plane/grid edge size in metres (cube default 2).' },
        radius: { type: 'number', description: 'Radius for sphere/cylinder/cone/circle/torus.' },
        depth: { type: 'number', description: 'Depth for cylinder/cone.' },
        segments: { type: 'integer', description: 'Segments for cylinder/cone/sphere/circle/torus (e.g. 32).' },
        ring_count: { type: 'integer', description: 'Ring count for torus/sphere.' },
        subdivisions: { type: 'integer', description: 'Subdivisions for ico_sphere (default 2).' },
        size_x: { type: 'number', description: 'Grid X extent.' },
        size_y: { type: 'number', description: 'Grid Y extent.' },
        x_subdivisions: { type: 'integer', description: 'Grid X subdivisions.' },
        y_subdivisions: { type: 'integer', description: 'Grid Y subdivisions.' },
        light_type: { type: 'string', enum: ['POINT', 'SUN', 'SPOT', 'AREA'], description: 'Light type when kind=light.' },
        energy: { type: 'number', description: 'Light power in watts when kind=light.' },
        collection: { type: 'string', description: 'Target collection name (created when missing).' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return call(runtime, 'object.create', args, exec)
      },
    }),

    defineTool({
      name: 'blender_list_objects',
      description:
        'List objects in the scene with type, location, dimensions, topology counts, materials, modifiers and selection state. ' +
        'Use it to inspect what exists before editing, or to measure a model (dimensions are world-space bounding box sizes in metres).',
      parameters: {
        filter: { type: 'string', description: 'Case-insensitive substring match on object name.' },
        type: { type: 'string', description: 'Restrict to one object type: MESH, CAMERA, LIGHT, EMPTY, CURVE, ARMATURE…' },
        selected_only: { type: 'boolean', description: 'Only list currently selected objects.' },
        limit: { type: 'integer', description: 'Maximum rows to return (default 60).' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const result = await call(runtime, 'object.list', args, exec)
        const lines = (result.objects ?? []).map(objectLine)
        return { count: result.total ?? lines.length, returned: lines.length, objects: lines, raw: result.objects }
      },
    }),

    defineTool({
      name: 'blender_select_objects',
      description:
        'Change the selection: replace/add/subtract/toggle a set of objects and optionally set the active object. ' +
        'Selection matters because mesh edits, joins, booleans-by-selection and exports (selected_only) operate on it.',
      parameters: {
        names: { type: 'array', items: { type: 'string' }, description: 'Object names to select.' },
        mode: { type: 'string', enum: ['REPLACE', 'ADD', 'SUBTRACT', 'TOGGLE'], description: 'Selection mode (default REPLACE).' },
        active: { type: 'string', description: 'Name to make the active object.' },
        all: { type: 'boolean', description: 'Select every object in the scene (ignores names).' },
        clear: { type: 'boolean', description: 'Deselect everything first.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return call(runtime, 'object.select', args, exec)
      },
    }),

    defineTool({
      name: 'blender_transform_object',
      description:
        'Move, rotate and/or scale one or more objects. Values are absolute by default; set delta=true to apply them as an offset ' +
        'relative to the current transform. Set apply=true to bake the transform into the mesh data (useful before boolean/bevel work). ' +
        'Rotation is in DEGREES and accepts either a single number (applied per axis) or [x, y, z].',
      parameters: {
        names: { type: 'array', items: { type: 'string' }, required: true, description: 'Objects to transform.' },
        location: { ...VEC3, description: 'New (or offset) world location.' },
        rotation: { type: 'array', items: { type: 'number' }, description: 'Rotation in degrees, absolute euler XYZ.' },
        scale: { ...VEC3, description: 'Scale factors (uniform when a single number is given).' },
        delta: { type: 'boolean', description: 'Treat location/rotation/scale as offsets from the current transform.' },
        apply: { type: 'boolean', description: 'Apply (bake) the resulting transform into the mesh.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return call(runtime, 'object.transform', args, exec)
      },
    }),

    defineTool({
      name: 'blender_duplicate_objects',
      description:
        'Duplicate objects, optionally as a linear or radial array. One call can produce N copies with per-copy offsets, ' +
        'rotation steps and scale steps — the fastest way to build repeated structures (stairs, fence posts, petals).',
      parameters: {
        name: { type: 'string', required: true, description: 'Source object to duplicate.' },
        count: { type: 'integer', description: 'Number of copies to create (default 1).' },
        offset: { ...VEC3, description: 'Translation applied per copy [x, y, z].' },
        rotation_offset: { ...VEC3, description: 'Rotation applied per copy, in DEGREES.' },
        scale_step: { type: 'number', description: 'Multiplicative scale per copy (1 = no change).' },
        linked: { type: 'boolean', description: 'Share mesh data between copies (linked duplicates).' },
        prefix: { type: 'string', description: 'Name prefix for the copies.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return call(runtime, 'object.duplicate', args, exec)
      },
    }),

    defineTool({
      name: 'blender_object_ops',
      description:
        'Object-level operations that are not plain transforms: join several meshes into one, separate loose parts, ' +
        'set the origin (pivot), shade smooth/flat, rename, apply transform, move an object to another collection, or parent/unparent. ' +
        'action=join merges every selected mesh into the active one; action=separate splits by loose parts.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['join', 'separate', 'origin_set', 'shade_smooth', 'shade_flat', 'rename', 'apply_transform', 'move_to_collection', 'parent', 'unparent'],
          description: 'Operation to perform.',
        },
        names: { type: 'array', items: { type: 'string' }, description: 'Target objects (defaults to the current selection).' },
        name: { type: 'string', description: 'Single target object (alias for names with one entry).' },
        new_name: { type: 'string', description: 'New name for action=rename.' },
        origin_type: {
          type: 'string',
          enum: ['ORIGIN_GEOMETRY', 'ORIGIN_CURSOR', 'ORIGIN_CENTER_OF_MASS', 'ORIGIN_CENTER_OF_VOLUME'],
          description: 'Origin mode for action=origin_set (default ORIGIN_GEOMETRY, median).',
        },
        collection: { type: 'string', description: 'Target collection for action=move_to_collection.' },
        parent: { type: 'string', description: 'Parent object for action=parent.' },
        smooth_angle: { type: 'number', description: 'Angle threshold in degrees for shade_smooth on Blender 4.1+.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return call(runtime, 'object.ops', args, exec)
      },
    }),

    defineTool({
      name: 'blender_delete_objects',
      description:
        'Delete objects from the scene. Pass explicit names, or all=true to empty the scene (optionally keeping cameras and lights). ' +
        'Deletion is undoable with blender_file action=undo.',
      parameters: {
        names: { type: 'array', items: { type: 'string' }, description: 'Object names to delete.' },
        all: { type: 'boolean', description: 'Delete every object in the scene.' },
        keep_cameras: { type: 'boolean', description: 'With all=true, keep cameras.' },
        keep_lights: { type: 'boolean', description: 'With all=true, keep lights.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return call(runtime, 'object.delete', args, exec)
      },
    }),

    defineTool({
      name: 'blender_scene',
      description:
        'Scene-level settings and lifecycle: read the full scene report, reset (empty) the scene, set the 3D cursor, ' +
        'change units or the render engine, and list/create collections.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['info', 'reset', 'cursor', 'units', 'engine', 'collection_create', 'collection_list'],
          description: 'What to do.',
        },
        location: { ...VEC3, description: '3D cursor location for action=cursor.' },
        unit_system: { type: 'string', enum: ['METRIC', 'IMPERIAL', 'NONE'], description: 'Unit system for action=units.' },
        scale_length: { type: 'number', description: 'Unit scale (metres per Blender unit) for action=units.' },
        engine: {
          type: 'string',
          enum: ['BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES', 'BLENDER_WORKBENCH'],
          description: 'Render engine for action=engine.',
        },
        name: { type: 'string', description: 'Collection name for action=collection_create.' },
        keep_cameras: { type: 'boolean', description: 'With action=reset, keep cameras.' },
        keep_lights: { type: 'boolean', description: 'With action=reset, keep lights.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const { action, ...params } = args
        return call(runtime, `scene.${action === 'collection_create' ? 'collection_create' : action === 'collection_list' ? 'collection_list' : action}`, params, exec)
      },
    }),
  ]
}
