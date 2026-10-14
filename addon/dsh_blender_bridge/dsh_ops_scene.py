"""场景与对象命令：ping / scene.* / object.*（不含网格编辑、材质与 IO）。"""

import math

import bpy  # type: ignore[import-not-found]

import dsh_helpers as helpers
import dsh_protocol as protocol
import dsh_registry as registry

#: 几何体别名 → 内部类型
KIND_ALIASES = {
    "cube": "cube",
    "box": "cube",
    "sphere": "sphere",
    "uv_sphere": "sphere",
    "ico_sphere": "ico_sphere",
    "icosphere": "ico_sphere",
    "cylinder": "cylinder",
    "cone": "cone",
    "torus": "torus",
    "donut": "torus",
    "plane": "plane",
    "grid": "grid",
    "circle": "circle",
    "monkey": "monkey",
    "suzanne": "monkey",
    "empty": "empty",
    "camera": "camera",
    "light": "light",
}


@registry.command("ping")
def ping(server, params):
    """连通性探测：返回版本、模式、当前文件与服务状态。"""
    return {
        "app": "blender",
        "bridge": protocol.BRIDGE_VERSION,
        "protocol": protocol.PROTOCOL_VERSION,
        "blender": bpy.app.version_string,
        "version": list(bpy.app.version),
        "mode": "background" if bpy.app.background else "gui",
        "file": bpy.data.filepath or None,
        "scene": bpy.context.scene.name,
        "server": server.status() if server is not None else None,
    }


@registry.command("commands.list")
def commands_list(server, params):
    """列出本桥支持的全部命令（排错用）。"""
    return {"count": len(registry.command_names()), "commands": registry.command_names()}


@registry.command("scene.info")
def scene_info(server, params):
    return helpers.scene_summary(with_objects=bool(params.get("with_objects")))


@registry.command("scene.cursor")
def scene_cursor(server, params):
    location = helpers.as_vector(params.get("location"), (0.0, 0.0, 0.0))
    bpy.context.scene.cursor.location = location
    return {"cursor": [round(value, 5) for value in bpy.context.scene.cursor.location]}


@registry.command("scene.units")
def scene_units(server, params):
    settings = bpy.context.scene.unit_settings
    if params.get("unit_system"):
        settings.system = str(params["unit_system"])
    if params.get("scale_length") is not None:
        settings.scale_length = float(params["scale_length"])
    if params.get("length_unit"):
        settings.length_unit = str(params["length_unit"])
    return {
        "system": settings.system,
        "scale_length": settings.scale_length,
        "length_unit": settings.length_unit,
    }


@registry.command("scene.engine")
def scene_engine(server, params):
    engine = params.get("engine")
    if engine:
        try:
            bpy.context.scene.render.engine = str(engine)
        except TypeError as exc:
            raise protocol.CommandError(f"不支持的渲染引擎：{engine}", code="BAD_ENGINE") from exc
    return {"engine": bpy.context.scene.render.engine}


@registry.command("scene.collection_create")
def scene_collection_create(server, params):
    name = params.get("name")
    if not name:
        raise protocol.CommandError("collection_create 需要 name。", code="BAD_REQUEST")
    collection = helpers.ensure_collection(str(name))
    return {"name": collection.name, "collections": [item.name for item in bpy.data.collections]}


@registry.command("scene.collection_list")
def scene_collection_list(server, params):
    return {
        "collections": [
            {"name": collection.name, "objects": [obj.name for obj in collection.objects]}
            for collection in bpy.data.collections
        ]
    }


@registry.command("scene.reset")
def scene_reset(server, params):
    """清空场景（默认连相机/灯一起清），并回收没有用户的孤立数据。"""
    keep_cameras = bool(params.get("keep_cameras"))
    keep_lights = bool(params.get("keep_lights"))
    removed = []
    for obj in list(bpy.data.objects):
        if keep_cameras and obj.type == "CAMERA":
            continue
        if keep_lights and obj.type == "LIGHT":
            continue
        removed.append(obj.name)
        bpy.data.objects.remove(obj, do_unlink=True)
    purged = 0
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.cameras, bpy.data.lights, bpy.data.images):
        for datablock in list(collection):
            if datablock.users == 0 and not datablock.use_fake_user:
                try:
                    collection.remove(datablock)
                    purged += 1
                except Exception:  # noqa: BLE001 - 清理是尽力而为
                    pass
    return {"removed": removed, "purged_datablocks": purged, "scene": helpers.scene_summary()}


@registry.command("object.list")
def object_list(server, params):
    needle = (params.get("filter") or "").strip().lower()
    type_filter = (params.get("type") or "").strip().upper()
    selected_only = bool(params.get("selected_only"))
    limit = int(params.get("limit") or 60)
    rows = []
    for obj in bpy.context.scene.objects:
        if needle and needle not in obj.name.lower():
            continue
        if type_filter and obj.type != type_filter:
            continue
        if selected_only and not obj.select_get():
            continue
        rows.append(helpers.describe_object(obj))
    return {"total": len(rows), "objects": rows[:limit]}


@registry.command("object.create")
def object_create(server, params):
    """创建基础几何体 / 空物体 / 相机 / 灯光。"""
    kind = KIND_ALIASES.get(str(params.get("kind") or "cube").lower())
    if kind is None:
        raise protocol.CommandError(
            f"不支持的 kind：{params.get('kind')}（可用：{', '.join(sorted(set(KIND_ALIASES))) }）",
            code="BAD_KIND",
        )
    location = helpers.as_vector(params.get("location"), (0.0, 0.0, 0.0))
    rotation = helpers.degrees(params.get("rotation"), (0.0, 0.0, 0.0))
    scale = helpers.as_scale(params.get("scale"))
    size = float(params.get("size") or 2.0)
    radius = float(params.get("radius") or 1.0)
    depth = float(params.get("depth") or 2.0)
    segments = int(params.get("segments") or 32)
    rings = int(params.get("ring_count") or 16)
    subdivisions = int(params.get("subdivisions") or 2)

    def number(key, fallback):
        value = params.get(key)
        return float(value) if value is not None else fallback

    try:
        if kind == "cube":
            bpy.ops.mesh.primitive_cube_add(size=size, location=location, rotation=rotation)
        elif kind == "sphere":
            bpy.ops.mesh.primitive_uv_sphere_add(
                radius=radius, segments=max(3, segments), ring_count=max(3, rings), location=location, rotation=rotation
            )
        elif kind == "ico_sphere":
            bpy.ops.mesh.primitive_ico_sphere_add(
                subdivisions=max(1, subdivisions), radius=radius, location=location, rotation=rotation
            )
        elif kind == "cylinder":
            bpy.ops.mesh.primitive_cylinder_add(
                vertices=max(3, segments), radius=radius, depth=depth, location=location, rotation=rotation
            )
        elif kind == "cone":
            bpy.ops.mesh.primitive_cone_add(
                vertices=max(3, segments), radius1=radius, radius2=number("radius2", 0.0), depth=depth,
                location=location, rotation=rotation,
            )
        elif kind == "torus":
            bpy.ops.mesh.primitive_torus_add(
                major_radius=radius, minor_radius=number("minor_radius", max(0.05, radius * 0.25)),
                major_segments=max(3, segments), minor_segments=max(3, rings),
                location=location, rotation=rotation,
            )
        elif kind == "plane":
            bpy.ops.mesh.primitive_plane_add(size=size, location=location, rotation=rotation)
        elif kind == "grid":
            bpy.ops.mesh.primitive_grid_add(
                x_subdivisions=int(params.get("x_subdivisions") or 10),
                y_subdivisions=int(params.get("y_subdivisions") or 10),
                size=size, location=location, rotation=rotation,
            )
        elif kind == "circle":
            bpy.ops.mesh.primitive_circle_add(
                vertices=max(3, segments), radius=radius, fill_type="NGON", location=location, rotation=rotation
            )
        elif kind == "monkey":
            bpy.ops.mesh.primitive_monkey_add(size=size, location=location, rotation=rotation)
        elif kind == "empty":
            bpy.ops.object.empty_add(type="PLAIN_AXES", location=location, rotation=rotation)
        elif kind == "camera":
            bpy.ops.object.camera_add(location=location, rotation=rotation)
            camera = bpy.context.active_object
            if params.get("lens"):
                camera.data.lens = float(params["lens"])
        elif kind == "light":
            bpy.ops.object.light_add(
                type=str(params.get("light_type") or "POINT").upper(), location=location, rotation=rotation
            )
            light = bpy.context.active_object
            light.data.energy = number("energy", 1000.0 if light.data.type == "POINT" else 3.0)
            if params.get("light_color"):
                light.data.color = helpers.as_vector(params["light_color"], (1.0, 1.0, 1.0))
    except RuntimeError as exc:
        raise protocol.CommandError(f"创建 {kind} 失败：{exc}", code="CREATE_FAILED") from exc

    obj = bpy.context.view_layer.objects.active
    if obj is None:
        raise protocol.CommandError(f"创建 {kind} 后没有拿到对象。", code="CREATE_FAILED")
    if params.get("name"):
        obj.name = str(params["name"])
        if obj.data is not None:
            obj.data.name = str(params["name"])
    if scale != (1.0, 1.0, 1.0):
        obj.scale = scale
    if params.get("collection"):
        helpers.move_to_collection(obj, helpers.ensure_collection(str(params["collection"])))
    bpy.context.view_layer.update()
    return {"created": helpers.describe_object(obj), "scene_counts": helpers.scene_summary()["counts"]}


@registry.command("object.select")
def object_select(server, params):
    mode = str(params.get("mode") or "REPLACE").upper()
    if mode not in {"REPLACE", "ADD", "SUBTRACT", "TOGGLE"}:
        raise protocol.CommandError(f"不支持的 mode：{mode}", code="BAD_MODE")
    if params.get("all"):
        for obj in bpy.context.scene.objects:
            obj.select_set(True)
        active = bpy.context.view_layer.objects.active or (bpy.context.selected_objects[0] if bpy.context.selected_objects else None)
        if active is None:
            return {"selected": [], "active": None}
        bpy.context.view_layer.objects.active = active
        return {"selected": [obj.name for obj in bpy.context.selected_objects], "active": active.name}
    if params.get("clear") or mode == "REPLACE":
        for obj in bpy.context.view_layer.objects:
            obj.select_set(False)
    names = helpers.as_name_list(params)
    for name in names:
        obj = helpers.get_object(name)
        if mode == "SUBTRACT":
            obj.select_set(False)
        elif mode == "TOGGLE":
            obj.select_set(not obj.select_get())
        else:
            obj.select_set(True)
    active = helpers.get_object(params.get("active"), required=False) if params.get("active") else None
    if active is None and names:
        active = helpers.get_object(names[0], required=False)
    if active is not None:
        bpy.context.view_layer.objects.active = active
    return {"selected": [obj.name for obj in bpy.context.selected_objects], "active": (bpy.context.view_layer.objects.active.name if bpy.context.view_layer.objects.active else None)}


@registry.command("object.transform")
def object_transform(server, params):
    objects = helpers.objects_from(params)
    delta = bool(params.get("delta"))
    results = []
    for obj in objects:
        if params.get("location") is not None:
            target = helpers.as_vector(params["location"], tuple(obj.location))
            obj.location = [obj.location[index] + target[index] for index in range(3)] if delta else list(target)
        if params.get("rotation") is not None:
            target = helpers.degrees(params["rotation"], tuple(obj.rotation_euler))
            obj.rotation_euler = [obj.rotation_euler[index] + target[index] for index in range(3)] if delta else list(target)
        if params.get("scale") is not None:
            target = helpers.as_scale(params["scale"], tuple(obj.scale))
            obj.scale = [obj.scale[index] * target[index] for index in range(3)] if delta else list(target)
        results.append(obj)
    bpy.context.view_layer.update()
    if params.get("apply"):
        helpers.select_only(results, active=results[0] if results else None)
        helpers.set_mode("OBJECT")
        try:
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        except RuntimeError as exc:
            raise protocol.CommandError(f"应用变换失败：{exc}", code="APPLY_FAILED") from exc
    bpy.context.view_layer.update()
    return {"objects": [helpers.describe_object(obj) for obj in results]}


@registry.command("object.duplicate")
def object_duplicate(server, params):
    source = helpers.get_object(params.get("name") or params.get("source"))
    count = max(0, int(params.get("count") or 1))
    offset = helpers.as_vector(params.get("offset"), (0.0, 0.0, 0.0))
    rotation_step = helpers.degrees(params.get("rotation_offset"), (0.0, 0.0, 0.0))
    scale_step = float(params.get("scale_step") or 1.0)
    linked = bool(params.get("linked"))
    prefix = str(params.get("prefix") or (source.name + "_copy"))
    collection = source.users_collection[0] if source.users_collection else bpy.context.scene.collection
    created = []
    for index in range(1, count + 1):
        clone = source.copy()
        if not linked and source.data is not None:
            clone.data = source.data.copy()
        clone.name = f"{prefix}.{index:02d}"
        collection.objects.link(clone)
        clone.location = [source.location[axis] + offset[axis] * index for axis in range(3)]
        clone.rotation_euler = [source.rotation_euler[axis] + rotation_step[axis] * index for axis in range(3)]
        factor = scale_step ** index
        clone.scale = [source.scale[axis] * factor for axis in range(3)]
        created.append(clone)
    bpy.context.view_layer.update()
    return {"source": source.name, "created": [helpers.describe_object(obj) for obj in created]}


@registry.command("object.ops")
def object_ops(server, params):
    action = str(params.get("action") or "").strip()
    objects = helpers.objects_from(params) if (params.get("names") or params.get("name") or bpy.context.selected_objects) else []
    if action == "join":
        if len(objects) < 2:
            raise protocol.CommandError("join 需要至少两个对象（用 names 指定或用选择集）。", code="BAD_REQUEST")
        for obj in objects:
            if obj.type != "MESH":
                raise protocol.CommandError(f"{obj.name} 不是网格，无法 join。", code="NOT_A_MESH")
        helpers.select_only(objects, active=objects[0])
        helpers.set_mode("OBJECT")
        try:
            bpy.ops.object.join()
        except RuntimeError as exc:
            raise protocol.CommandError(f"join 失败：{exc}", code="JOIN_FAILED") from exc
        merged = bpy.context.view_layer.objects.active
        return {"joined_into": merged.name, "object": helpers.describe_object(merged)}

    if action == "separate":
        target = helpers.require_mesh(objects[0] if objects else helpers.get_object(params.get("name")))
        helpers.select_only([target], active=target)
        before = {obj.name for obj in bpy.data.objects}
        helpers.set_mode("EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        try:
            bpy.ops.mesh.separate(type=str(params.get("separate_type") or "LOOSE"))
        except RuntimeError as exc:
            raise protocol.CommandError(f"separate 失败：{exc}", code="SEPARATE_FAILED") from exc
        helpers.set_mode("OBJECT")
        new_names = sorted({obj.name for obj in bpy.data.objects} - before)
        return {"source": target.name, "created": new_names}

    if action == "origin_set":
        target = objects[0] if objects else helpers.get_object(params.get("name"))
        helpers.select_only([target], active=target)
        helpers.set_mode("OBJECT")
        origin_type = str(params.get("origin_type") or "ORIGIN_GEOMETRY").upper()
        center = str(params.get("center") or "MEDIAN").upper()
        try:
            bpy.ops.object.origin_set(type=origin_type, center=center)
        except (RuntimeError, TypeError) as exc:
            raise protocol.CommandError(f"设置原点失败：{exc}", code="ORIGIN_FAILED") from exc
        return {"object": helpers.describe_object(target)}

    if action in {"shade_smooth", "shade_flat"}:
        targets = objects or [helpers.get_object(params.get("name"))]
        mesh_targets = [obj for obj in targets if obj.type == "MESH"]
        if not mesh_targets:
            raise protocol.CommandError("shade_* 需要网格对象。", code="NOT_A_MESH")
        helpers.select_only(mesh_targets, active=mesh_targets[0])
        helpers.set_mode("OBJECT")
        try:
            if action == "shade_flat":
                bpy.ops.object.shade_flat()
            else:
                angle = params.get("smooth_angle")
                if angle is not None and hasattr(bpy.ops.object, "shade_smooth_by_angle"):
                    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(float(angle)))
                else:
                    bpy.ops.object.shade_smooth()
        except (RuntimeError, TypeError) as exc:
            raise protocol.CommandError(f"{action} 失败：{exc}", code="SHADE_FAILED") from exc
        return {"objects": [obj.name for obj in mesh_targets], "mode": action}

    if action == "rename":
        target = objects[0] if objects else helpers.get_object(params.get("name"))
        new_name = params.get("new_name")
        if not new_name:
            raise protocol.CommandError("rename 需要 new_name。", code="BAD_REQUEST")
        old_name = target.name
        target.name = str(new_name)
        if target.data is not None:
            target.data.name = str(new_name)
        return {"old_name": old_name, "new_name": target.name}

    if action == "apply_transform":
        targets = objects or [helpers.get_object(params.get("name"))]
        helpers.select_only(targets, active=targets[0])
        helpers.set_mode("OBJECT")
        try:
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        except RuntimeError as exc:
            raise protocol.CommandError(f"应用变换失败：{exc}", code="APPLY_FAILED") from exc
        return {"objects": [helpers.describe_object(obj) for obj in targets]}

    if action == "move_to_collection":
        targets = objects or [helpers.get_object(params.get("name"))]
        name = params.get("collection")
        if not name:
            raise protocol.CommandError("move_to_collection 需要 collection。", code="BAD_REQUEST")
        collection = helpers.ensure_collection(str(name))
        for obj in targets:
            helpers.move_to_collection(obj, collection)
        return {"collection": collection.name, "objects": [obj.name for obj in targets]}

    if action in {"parent", "unparent"}:
        targets = objects or [helpers.get_object(params.get("name"))]
        results = []
        if action == "parent":
            parent = helpers.get_object(params.get("parent"))
            for obj in targets:
                if obj == parent:
                    continue
                matrix = obj.matrix_world.copy()
                obj.parent = parent
                obj.matrix_parent_inverse = parent.matrix_world.inverted()
                obj.matrix_world = matrix
                results.append(obj.name)
            return {"parent": parent.name, "children": results}
        for obj in targets:
            matrix = obj.matrix_world.copy()
            obj.parent = None
            obj.matrix_world = matrix
            results.append(obj.name)
        return {"unparented": results}

    raise protocol.CommandError(
        f"不支持的 object.ops action：{action or '(空)'}",
        code="BAD_ACTION",
        hint="可用：join / separate / origin_set / shade_smooth / shade_flat / rename / apply_transform / move_to_collection / parent / unparent",
    )


@registry.command("object.delete")
def object_delete(server, params):
    if params.get("all"):
        keep_cameras = bool(params.get("keep_cameras"))
        keep_lights = bool(params.get("keep_lights"))
        deleted = []
        for obj in list(bpy.data.objects):
            if keep_cameras and obj.type == "CAMERA":
                continue
            if keep_lights and obj.type == "LIGHT":
                continue
            deleted.append(obj.name)
            bpy.data.objects.remove(obj, do_unlink=True)
        return {"deleted": deleted, "counts": helpers.scene_summary()["counts"]}
    names = helpers.as_name_list(params)
    if not names:
        raise protocol.CommandError("删除需要 names，或使用 all=true 清场。", code="BAD_REQUEST")
    deleted = []
    for name in names:
        obj = helpers.get_object(name)
        deleted.append(obj.name)
        bpy.data.objects.remove(obj, do_unlink=True)
    return {"deleted": deleted, "counts": helpers.scene_summary()["counts"]}
