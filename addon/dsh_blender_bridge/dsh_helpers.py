"""bpy 侧的公共小工具：参数规范化、对象查找、上下文覆盖、描述生成。"""

import math
import os

import bpy  # type: ignore[import-not-found]  # Blender 运行时提供
import dsh_protocol as protocol


# ------------------------------------------------------------------ 参数规范化


def as_vector(value, default=(0.0, 0.0, 0.0)):
    """把 [x, y, z] / 单个数字 / None 规范化成三元组。"""
    if value is None:
        return tuple(float(item) for item in default)
    if isinstance(value, (int, float)):
        return (float(value), float(value), float(value))
    if isinstance(value, (list, tuple)):
        items = [float(item) for item in value]
        while len(items) < 3:
            items.append(float(default[len(items)]))
        return tuple(items[:3])
    return tuple(float(item) for item in default)


def as_scale(value, default=(1.0, 1.0, 1.0)):
    """缩放：单个数字表示等比缩放。"""
    if value is None:
        return tuple(float(item) for item in default)
    if isinstance(value, (int, float)):
        return (float(value),) * 3
    return as_vector(value, default)


def degrees(value, default=(0.0, 0.0, 0.0)):
    """角度（度）→ 弧度三元组。"""
    return tuple(math.radians(item) for item in as_vector(value, default))


def as_name_list(params, key="names"):
    """把 names / name 两种写法统一成字符串列表。"""
    names = params.get(key)
    if not names and params.get("name"):
        names = [params.get("name")]
    if names is None:
        return []
    if isinstance(names, str):
        return [names]
    return [str(item) for item in names if item]


# ------------------------------------------------------------------ 对象查找


def get_object(name, required=True):
    """按名字取对象；找不到时按需抛 CommandError。"""
    if not name:
        obj = bpy.context.view_layer.objects.active
        if obj is None and required:
            raise protocol.CommandError("当前没有活动对象，请指定 name。", code="NO_ACTIVE_OBJECT")
        return obj
    obj = bpy.data.objects.get(str(name))
    if obj is None and required:
        available = ", ".join(list(bpy.data.objects.keys())[:10]) or "（场景为空）"
        raise protocol.CommandError(f"找不到对象：{name}（现有：{available}）", code="OBJECT_NOT_FOUND")
    return obj


def require_mesh(obj):
    """确保是网格对象。"""
    if obj is None:
        raise protocol.CommandError("需要一个网格对象。", code="NO_OBJECT")
    if obj.type != "MESH":
        raise protocol.CommandError(f"对象 {obj.name} 不是网格（当前类型 {obj.type}）。", code="NOT_A_MESH")
    return obj


def selected_objects():
    return [obj for obj in bpy.context.selected_objects]


def objects_from(params, key="names"):
    """取参数里的对象列表；缺省用当前选择，再缺省用活动对象。"""
    names = as_name_list(params, key)
    if names:
        return [get_object(name) for name in names]
    objects = selected_objects()
    if objects:
        return list(objects)
    active = bpy.context.view_layer.objects.active
    if active is not None:
        return [active]
    raise protocol.CommandError("没有选中任何对象，请用 names 指定。", code="NO_SELECTION")


def resolve_targets(params, default="all"):
    """用于相机取景：names → 选择 → 全部。"""
    names = as_name_list(params, "target") + as_name_list(params, "names")
    if names:
        return [get_object(name) for name in names]
    objects = [obj for obj in selected_objects() if obj.type in {"MESH", "CURVE", "SURFACE", "META", "FONT"}]
    if objects:
        return objects
    if default == "all":
        objects = [obj for obj in bpy.context.scene.objects if obj.type in {"MESH", "CURVE", "SURFACE", "META", "FONT"}]
        if objects:
            return objects
    raise protocol.CommandError("场景里没有可用的几何体，请先创建对象。", code="NOTHING_TO_FRAME")


# ------------------------------------------------------------------ 上下文


def select_only(objects, active=None):
    """只选中给定对象，并把其中一个设为活动对象。"""
    for obj in bpy.context.view_layer.objects:
        obj.select_set(False)
    target_active = None
    for obj in objects:
        try:
            obj.select_set(True)
        except RuntimeError:
            continue
        if target_active is None:
            target_active = obj
    if active is not None:
        target_active = active
        try:
            target_active.select_set(True)
        except RuntimeError:
            pass
    if target_active is not None:
        bpy.context.view_layer.objects.active = target_active
    return target_active


def activate(obj):
    """设为活动对象（不改变选择状态）。"""
    bpy.context.view_layer.objects.active = obj
    return obj


def set_mode(mode):
    """切换交互模式，已经是目标模式时不做任何事。"""
    current = getattr(bpy.context, "mode", "OBJECT")
    if current == mode:
        return
    obj = bpy.context.view_layer.objects.active
    if obj is None and mode != "OBJECT":
        raise protocol.CommandError("切换编辑模式需要活动对象。", code="NO_ACTIVE_OBJECT")
    bpy.ops.object.mode_set(mode=mode)


def ensure_collection(name):
    """按名字取集合，不存在就创建并挂到场景集合下。"""
    if not name:
        return bpy.context.scene.collection
    collection = bpy.data.collections.get(str(name))
    if collection is None:
        collection = bpy.data.collections.new(str(name))
        bpy.context.scene.collection.children.link(collection)
    return collection


def move_to_collection(obj, collection):
    """把对象移动到目标集合（从其它集合解绑）。"""
    if collection.objects.get(obj.name) is None:
        collection.objects.link(obj)
    for parent in list(obj.users_collection):
        if parent != collection:
            parent.objects.unlink(obj)
    return obj


def apply_modifier(obj, modifier):
    """应用一个修改器（自动处理活动对象与模式）。"""
    select_only([obj], active=obj)
    set_mode("OBJECT")
    try:
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    except RuntimeError as exc:
        raise protocol.CommandError(
            f"应用修改器 {modifier.name} 失败：{exc}",
            code="MODIFIER_APPLY_FAILED",
            hint="多用户网格（linked duplicate）无法直接应用修改器，请先做单用户化。",
        ) from exc
    return obj


# ------------------------------------------------------------------ 描述


def describe_object(obj, detailed=True):
    """对象摘要，字段与 DSH 侧 blender_list_objects 的展示一一对应。"""
    info = {
        "name": obj.name,
        "type": obj.type,
        "location": [round(value, 5) for value in obj.location],
        "rotation_euler_degrees": [round(math.degrees(value), 3) for value in obj.rotation_euler],
        "scale": [round(value, 5) for value in obj.scale],
        "dimensions": [round(value, 5) for value in obj.dimensions],
        "selected": bool(obj.select_get()),
        "active": bpy.context.view_layer.objects.active == obj,
        "hidden": bool(obj.hide_get()),
        "parent": obj.parent.name if obj.parent else None,
        "collection": obj.users_collection[0].name if obj.users_collection else None,
    }
    if obj.type == "MESH":
        info["vertices"] = len(obj.data.vertices)
        info["edges"] = len(obj.data.edges)
        info["polygons"] = len(obj.data.polygons)
        info["materials"] = [slot.material.name for slot in obj.material_slots if slot.material]
        info["modifiers"] = [
            {"name": modifier.name, "type": modifier.type, "show_viewport": modifier.show_viewport}
            for modifier in obj.modifiers
        ]
        if detailed:
            info["dimensions"] = [round(value, 5) for value in obj.dimensions]
    elif obj.type == "CAMERA":
        info["camera"] = {
            "lens": round(obj.data.lens, 3),
            "sensor_width": round(obj.data.sensor_width, 3),
            "type": obj.data.type,
        }
    elif obj.type == "LIGHT":
        info["light"] = {"type": obj.data.type, "energy": round(obj.data.energy, 3), "color": list(obj.data.color)}
    return info


def scene_summary(with_objects=False, limit=200):
    """场景概览：计数、单位、游标、集合与（可选）对象清单。"""
    scene = bpy.context.scene
    objects = list(scene.objects)
    counts = {"objects": len(objects)}
    for obj in objects:
        key = obj.type.lower() + "s"
        counts[key] = counts.get(key, 0) + 1
    mesh_stats = {"vertices": 0, "edges": 0, "polygons": 0}
    for obj in objects:
        if obj.type == "MESH" and obj.data is not None:
            mesh_stats["vertices"] += len(obj.data.vertices)
            mesh_stats["edges"] += len(obj.data.edges)
            mesh_stats["polygons"] += len(obj.data.polygons)
    counts.update(mesh_stats)
    summary = {
        "scene": scene.name,
        "file": bpy.data.filepath or None,
        "is_dirty": bool(bpy.data.is_dirty),
        "engine": scene.render.engine,
        "units": {
            "system": scene.unit_settings.system,
            "scale_length": scene.unit_settings.scale_length,
            "length_unit": scene.unit_settings.length_unit,
        },
        "cursor": [round(value, 5) for value in scene.cursor.location],
        "frame_range": [scene.frame_start, scene.frame_end, scene.frame_current],
        "counts": counts,
        "selected": [obj.name for obj in bpy.context.selected_objects],
        "active": bpy.context.view_layer.objects.active.name if bpy.context.view_layer.objects.active else None,
        "collections": [collection.name for collection in bpy.data.collections],
        "materials": len(bpy.data.materials),
    }
    if with_objects:
        summary["objects"] = [describe_object(obj) for obj in objects[:limit]]
    return summary


def ensure_directory(path):
    directory = os.path.dirname(os.path.abspath(path))
    if directory and not os.path.isdir(directory):
        os.makedirs(directory, exist_ok=True)
    return path
