"""建模核心命令：编辑模式网格操作、修改器、布尔。"""

import math

import bpy  # type: ignore[import-not-found]

import dsh_helpers as helpers
import dsh_protocol as protocol
import dsh_registry as registry

#: 修改器上需要特殊处理的属性（值是对象名或枚举）。
OBJECT_PROPS = {"object", "target", "mirror_object", "offset_object", "texture_coords_object"}


def mesh_stats(obj):
    """网格拓扑计数，用于展示一次操作的效果。"""
    if obj.type != "MESH":
        return {}
    return {
        "vertices": len(obj.data.vertices),
        "edges": len(obj.data.edges),
        "polygons": len(obj.data.polygons),
        "dimensions": [round(value, 5) for value in obj.dimensions],
    }


def apply_props(modifier, props):
    """把 props 写进修改器，返回 (applied, skipped)。"""
    applied = {}
    skipped = []
    for key, value in (props or {}).items():
        if key in OBJECT_PROPS:
            target = bpy.data.objects.get(str(value))
            if target is None:
                skipped.append(f"{key}={value}（找不到对象）")
                continue
            setattr(modifier, key, target)
            applied[key] = target.name
            continue
        if not hasattr(modifier, key):
            skipped.append(f"{key}（{modifier.type} 修改器没有该属性）")
            continue
        try:
            if key == "angle_limit" and isinstance(value, (int, float)):
                value = math.radians(float(value))
            setattr(modifier, key, value)
            applied[key] = value
        except Exception as exc:  # noqa: BLE001 - 属性类型不对时给出可读反馈
            skipped.append(f"{key}={value}（{exc}）")
    return applied, skipped


@registry.command("mesh.edit")
def mesh_edit(server, params):
    obj = helpers.require_mesh(helpers.get_object(params.get("name")))
    action = str(params.get("action") or "").strip()
    before = mesh_stats(obj)
    helpers.select_only([obj], active=obj)
    helpers.set_mode("EDIT")
    try:
        if str(params.get("select") or "all") != "none":
            bpy.ops.mesh.select_all(action="SELECT")
        if action in {"extrude", "inset", "delete_faces"}:
            bpy.ops.mesh.select_mode(type="FACE")
        elif action in {"bevel", "merge_by_distance"}:
            bpy.ops.mesh.select_mode(type="EDGE")

        if action == "extrude":
            move = helpers.as_vector(params.get("move"), (0.0, 0.0, 1.0))
            bpy.ops.mesh.extrude_region_move(TRANSFORM_OT_translate={"value": move})
        elif action == "inset":
            bpy.ops.mesh.inset(
                thickness=float(params.get("thickness") or 0.1),
                depth=float(params.get("depth") or 0.0),
                use_even_offset=True,
            )
        elif action == "bevel":
            width = params.get("width", params.get("thickness"))
            bpy.ops.mesh.bevel(
                offset=float(width if width is not None else 0.05),
                segments=max(1, int(params.get("segments") or 1)),
                affect="EDGES",
                angle_limit=math.radians(float(params.get("angle_limit") or 30.0)),
                clamp_overlap=True,
            )
        elif action == "subdivide":
            bpy.ops.mesh.subdivide(
                number_cuts=max(1, int(params.get("cuts") or 1)),
                smoothness=float(params.get("smoothness") or 0.0),
            )
        elif action == "solidify":
            bpy.ops.mesh.solidify(thickness=float(params.get("thickness") or 0.05))
        elif action == "merge_by_distance":
            bpy.ops.mesh.remove_doubles(threshold=float(params.get("threshold") or 0.0001))
        elif action == "flip_normals":
            bpy.ops.mesh.flip_normals()
        elif action == "delete_faces":
            bpy.ops.mesh.delete(type="FACE")
        elif action == "smooth_vertices":
            bpy.ops.mesh.vertices_smooth(
                factor=float(params.get("factor") or 0.5),
                repeat=max(1, int(params.get("cuts") or params.get("repeat") or 1)),
            )
        elif action == "decimate_unsubdivide":
            bpy.ops.mesh.unsubdivide(iterations=max(1, int(params.get("cuts") or 1)))
        elif action == "triangulate":
            bpy.ops.mesh.quads_convert_to_tris(quad_method="BEAUTY", ngon_method="BEAUTY")
        else:
            raise protocol.CommandError(
                f"不支持的 mesh.edit action：{action or '(空)'}",
                code="BAD_ACTION",
                hint="可用：extrude / inset / bevel / subdivide / solidify / merge_by_distance / flip_normals / delete_faces / smooth_vertices / decimate_unsubdivide / triangulate",
            )
    except RuntimeError as exc:
        raise protocol.CommandError(f"网格操作 {action} 失败：{exc}", code="MESH_OP_FAILED") from exc
    finally:
        helpers.set_mode("OBJECT")
    bpy.context.view_layer.update()
    return {
        "object": obj.name,
        "action": action,
        "before": before,
        "after": mesh_stats(obj),
        "modifiers": [modifier.name for modifier in obj.modifiers],
    }


@registry.command("modifier.manage")
def modifier_manage(server, params):
    action = str(params.get("action") or "list").strip()
    obj = helpers.get_object(params.get("name"))
    if obj is None:
        raise protocol.CommandError("modifier 操作需要对象（name 或活动对象）。", code="NO_OBJECT")

    if action == "list":
        return {
            "object": obj.name,
            "modifiers": [
                {
                    "name": modifier.name,
                    "type": modifier.type,
                    "show_viewport": bool(modifier.show_viewport),
                    "show_render": bool(modifier.show_render),
                }
                for modifier in obj.modifiers
            ],
        }

    if action == "add":
        modifier_type = str(params.get("type") or "").upper()
        if not modifier_type:
            raise protocol.CommandError("action=add 需要 type（如 SUBSURF）。", code="BAD_REQUEST")
        name = str(params.get("name") or modifier_type.title()) if params.get("modifier") else modifier_type.title()
        if params.get("modifier"):
            name = str(params["modifier"])
        try:
            modifier = obj.modifiers.new(name=name, type=modifier_type)
        except (RuntimeError, TypeError) as exc:
            raise protocol.CommandError(
                f"无法添加 {modifier_type} 修改器：{exc}",
                code="MODIFIER_ADD_FAILED",
                hint="用 blender_run_python 执行 bpy.types.Modifier.bl_rna 查询可用类型。",
            ) from exc
        applied, skipped = apply_props(modifier, params.get("props"))
        if params.get("index") is not None:
            try:
                bpy.ops.object.modifier_move_to_index(modifier=modifier.name, index=int(params["index"]))
            except RuntimeError:
                skipped.append("index（移动失败，已保留默认顺序）")
        result = {
            "object": obj.name,
            "modifier": {"name": modifier.name, "type": modifier.type},
            "props_applied": applied,
            "props_skipped": skipped,
        }
        if params.get("apply"):
            helpers.apply_modifier(obj, modifier)
            result["applied"] = True
            result["stats"] = mesh_stats(obj) if obj.type == "MESH" else {}
        return result

    if action == "apply":
        name = params.get("modifier")
        if name:
            modifier = obj.modifiers.get(str(name))
            if modifier is None:
                raise protocol.CommandError(f"{obj.name} 上没有修改器 {name}。", code="MODIFIER_NOT_FOUND")
        elif len(obj.modifiers) > 0:
            modifier = obj.modifiers[-1]
        else:
            raise protocol.CommandError(f"{obj.name} 没有可应用的修改器。", code="MODIFIER_NOT_FOUND")
        helpers.apply_modifier(obj, modifier)
        return {"object": obj.name, "applied": modifier.name, "stats": mesh_stats(obj)}

    if action == "remove":
        name = params.get("modifier")
        modifier = obj.modifiers.get(str(name)) if name else (obj.modifiers[-1] if len(obj.modifiers) else None)
        if modifier is None:
            raise protocol.CommandError("remove 需要 modifier 名字。", code="MODIFIER_NOT_FOUND")
        removed = modifier.name
        obj.modifiers.remove(modifier)
        return {"object": obj.name, "removed": removed}

    if action == "clear":
        removed = [modifier.name for modifier in obj.modifiers]
        for modifier in list(obj.modifiers):
            obj.modifiers.remove(modifier)
        return {"object": obj.name, "removed": removed}

    raise protocol.CommandError(
        f"不支持的 modifier action：{action}",
        code="BAD_ACTION",
        hint="可用：list / add / apply / remove / clear",
    )


@registry.command("boolean.op")
def boolean_op(server, params):
    target = helpers.require_mesh(helpers.get_object(params.get("target")))
    cutter = helpers.require_mesh(helpers.get_object(params.get("cutter")))
    if target == cutter:
        raise protocol.CommandError("target 与 cutter 不能是同一个对象。", code="BAD_REQUEST")
    operation = str(params.get("operation") or "DIFFERENCE").upper()
    if operation not in {"DIFFERENCE", "UNION", "INTERSECT"}:
        raise protocol.CommandError(f"不支持的布尔运算：{operation}", code="BAD_OPERATION")
    solver = str(params.get("solver") or "EXACT").upper()
    apply_now = params.get("apply", True) is not False
    keep_cutter = bool(params.get("keep_cutter"))
    delete_cutter = params.get("delete_cutter", True) is not False
    before = mesh_stats(target)
    target_name = target.name
    cutter_name = cutter.name

    modifier = target.modifiers.new(name=f"Boolean {operation.title()}", type="BOOLEAN")
    modifier.object = cutter
    modifier.operation = operation
    try:
        modifier.solver = solver
    except TypeError:
        pass

    if apply_now:
        helpers.apply_modifier(target, modifier)

    cutter_state = "kept"
    if cutter_name in bpy.data.objects:
        if apply_now and delete_cutter and not keep_cutter:
            bpy.data.objects.remove(cutter, do_unlink=True)
            cutter_state = "deleted"
        elif not keep_cutter:
            cutter.hide_viewport = True
            cutter.hide_render = True
            cutter_state = "hidden"

    bpy.context.view_layer.update()
    return {
        "target": target_name,
        "cutter": cutter_name,
        "operation": operation,
        "solver": solver,
        "applied": apply_now,
        "cutter_state": cutter_state,
        "before": before,
        "after": mesh_stats(target),
    }
