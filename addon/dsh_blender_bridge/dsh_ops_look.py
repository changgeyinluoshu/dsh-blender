"""外观与出图命令：材质、相机取景、渲染、视口截图。"""

import math
import os
import time

import bpy  # type: ignore[import-not-found]
from mathutils import Vector  # type: ignore[import-not-found]

import dsh_helpers as helpers
import dsh_protocol as protocol
import dsh_registry as registry

#: Principled BSDF 输入名在不同 Blender 版本间的别名（4.x 重命名过几个）。
INPUT_ALIASES = {
    "base_color": ("Base Color", "Base color"),
    "metallic": ("Metallic",),
    "roughness": ("Roughness",),
    "ior": ("IOR",),
    "alpha": ("Alpha",),
    "emission_color": ("Emission Color", "Emission"),
    "emission_strength": ("Emission Strength",),
    "transmission": ("Transmission Weight", "Transmission"),
    "specular": ("Specular IOR Level", "Specular"),
    "sheen": ("Sheen Weight", "Sheen"),
    "coat": ("Coat Weight", "Clearcoat"),
}


def parse_color(params, key="color"):
    """接受 [r,g,b(,a)]（0..1 或 0..255）与 #rrggbb / rrggbb。"""
    value = params.get(key)
    hex_value = params.get("hex")
    if isinstance(hex_value, str) and hex_value.strip():
        text = hex_value.strip().lstrip("#")
        if len(text) == 3:
            text = "".join(char * 2 for char in text)
        if len(text) not in (6, 8):
            raise protocol.CommandError(f"无法解析颜色：{hex_value}", code="BAD_COLOR")
        channels = [int(text[index:index + 2], 16) / 255.0 for index in range(0, len(text), 2)]
        while len(channels) < 4:
            channels.append(1.0)
        return channels
    if value is None:
        return None
    if isinstance(value, str):
        return parse_color({"hex": value})
    if not isinstance(value, (list, tuple)) or len(value) < 3:
        raise protocol.CommandError(f"颜色需要 [r, g, b] 或 hex 字符串，收到：{value}", code="BAD_COLOR")
    channels = [float(item) for item in value]
    if max(channels) > 1.0:  # 允许 0..255 写法
        channels = [item / 255.0 for item in channels]
    while len(channels) < 4:
        channels.append(1.0)
    return channels[:4]


def principled_node(material):
    """找到 Principled BSDF 节点（没有就补一个）。"""
    if not material.use_nodes:
        material.use_nodes = True
    for node in material.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            return node
    node = material.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    output = next((item for item in material.node_tree.nodes if item.type == "OUTPUT_MATERIAL"), None)
    if output is not None:
        material.node_tree.links.new(node.outputs[0], output.inputs["Surface"])
    return node


def set_input(node, key, value):
    """按别名写入 Principled 输入，返回是否成功。"""
    for name in INPUT_ALIASES.get(key, (key,)):
        socket = node.inputs.get(name)
        if socket is None:
            continue
        if key in {"base_color", "emission_color"} and isinstance(value, (list, tuple)):
            socket.default_value = value[:4] if len(value) >= 4 else list(value[:3]) + [1.0]
        else:
            socket.default_value = value
        return True
    return False


def describe_material(material):
    """材质摘要（含基础色/金属度/粗糙度）。"""
    info = {"name": material.name, "users": material.users, "use_nodes": material.use_nodes}
    try:
        node = principled_node(material)
        base = node.inputs.get("Base Color")
        info["base_color"] = [round(value, 4) for value in base.default_value] if base is not None else None
        for key, name in (("metallic", "Metallic"), ("roughness", "Roughness"), ("alpha", "Alpha")):
            socket = node.inputs.get(name)
            if socket is not None:
                info[key] = round(float(socket.default_value), 4)
    except Exception:  # noqa: BLE001 - 摘要失败不应影响主流程
        pass
    if hasattr(material, "blend_method"):
        info["blend_method"] = material.blend_method
    elif hasattr(material, "surface_render_method"):
        info["surface_render_method"] = material.surface_render_method
    return info


@registry.command("material.create")
def material_create(server, params):
    name = str(params.get("name") or "Material")
    material = bpy.data.materials.get(name)
    created = material is None
    if material is None:
        material = bpy.data.materials.new(name)
    result = material_apply(material, params)
    return {"created": created, "material": result}


def material_apply(material, params):
    """把参数写进材质（create/set 共用）。"""
    node = principled_node(material)
    applied = {}
    color = parse_color(params)
    if color is not None:
        if set_input(node, "base_color", color):
            applied["base_color"] = [round(item, 4) for item in color]
    for key in ("metallic", "roughness", "ior", "emission_strength", "transmission", "specular", "sheen", "coat"):
        if params.get(key) is not None:
            if set_input(node, key, float(params[key])):
                applied[key] = float(params[key])
    emission_color = parse_color(params, "emission_color")
    if emission_color is not None and set_input(node, "emission_color", emission_color):
        applied["emission_color"] = [round(item, 4) for item in emission_color]
    if params.get("alpha") is not None:
        alpha = float(params["alpha"])
        if set_input(node, "alpha", alpha):
            applied["alpha"] = alpha
        # 低于 1 的 alpha 需要材质本身进入混合模式，否则视口里仍是不透明
        if alpha < 1.0:
            try:
                material.blend_method = "BLEND"
            except (AttributeError, TypeError):
                try:
                    material.surface_render_method = "BLENDED"
                except (AttributeError, TypeError):
                    pass
    return describe_material(material)


@registry.command("material.set")
def material_set(server, params):
    material = bpy.data.materials.get(str(params.get("name") or ""))
    if material is None:
        raise protocol.CommandError(f"找不到材质：{params.get('name')}", code="MATERIAL_NOT_FOUND")
    return material_apply(material, params)


@registry.command("material.assign")
def material_assign(server, params):
    name = str(params.get("name") or "Material")
    material = bpy.data.materials.get(name)
    if material is None:
        material = bpy.data.materials.new(name)
        material_apply(material, params)
    targets = helpers.objects_from(params)
    assigned = []
    for obj in targets:
        if obj.type not in {"MESH", "CURVE", "SURFACE", "META", "FONT"}:
            continue
        if params.get("replace_all"):
            obj.data.materials.clear()
        if not any(slot.material == material for slot in obj.material_slots):
            obj.data.materials.append(material)
        assigned.append(obj.name)
    if not assigned:
        raise protocol.CommandError("没有可指派材质的对象。", code="NO_TARGET")
    return {"material": describe_material(material), "assigned": assigned}


@registry.command("material.list")
def material_list(server, params):
    materials = [describe_material(material) for material in bpy.data.materials]
    return {"count": len(materials), "materials": materials}


# ------------------------------------------------------------------ 渲染


def ensure_camera(params):
    """取相机：显式名字 → 场景相机 → auto 新建/重取景。"""
    requested = params.get("camera")
    scene = bpy.context.scene
    if requested and str(requested) not in {"auto", "AUTO"}:
        camera = bpy.data.objects.get(str(requested))
        if camera is None or camera.type != "CAMERA":
            raise protocol.CommandError(f"找不到相机：{requested}", code="CAMERA_NOT_FOUND")
        return camera, False
    if str(requested).lower() == "auto" or scene.camera is None:
        camera = scene.camera
        if camera is None:
            bpy.ops.object.camera_add(location=(4.0, -4.0, 3.0))
            camera = bpy.context.view_layer.objects.active
            scene.camera = camera
        return camera, True
    return scene.camera, False


def ensure_light(params):
    """场景里没有光源时临时补一盏太阳光，否则预览渲染出来一片漆黑。"""
    if params.get("auto_light") is False:
        return None
    if any(obj.type == "LIGHT" for obj in bpy.context.scene.objects):
        return None
    bpy.ops.object.light_add(type="SUN", location=(4.0, -4.0, 6.0))
    light = bpy.context.view_layer.objects.active
    light.name = "DSH_Preview_Sun"
    light.data.energy = float(params.get("light_energy") or 4.0)
    light.rotation_euler = (math.radians(50.0), 0.0, math.radians(40.0))
    return light


def apply_world_strength(params):
    """临时改世界背景亮度（预览用），返回可恢复的快照。"""
    strength = params.get("world_strength")
    if strength is None:
        return None
    world = bpy.context.scene.world
    if world is None or not world.use_nodes:
        return None
    background = next((node for node in world.node_tree.nodes if node.type == "BACKGROUND"), None)
    if background is None:
        return None
    previous = background.inputs["Strength"].default_value
    background.inputs["Strength"].default_value = float(strength)
    return (world, previous)


def restore_world_strength(snapshot):
    """恢复 apply_world_strength 改过的背景亮度。"""
    if not snapshot:
        return
    world, previous = snapshot
    try:
        background = next((node for node in world.node_tree.nodes if node.type == "BACKGROUND"), None)
        if background is not None:
            background.inputs["Strength"].default_value = previous
    except Exception:  # noqa: BLE001 - 恢复失败不影响渲染结果
        pass


def frame_camera(camera, targets, margin=1.25):
    """把相机摆到能看见 targets 的位置（手动计算，不依赖视口）。"""
    points = []
    for obj in targets:
        try:
            points.extend([obj.matrix_world @ Vector(corner) for corner in obj.bound_box])
        except Exception:  # noqa: BLE001 - 没有 bound_box 的对象（如空物体）跳过
            points.append(obj.matrix_world.translation.copy())
    if not points:
        raise protocol.CommandError("没有可用于取景的几何体。", code="NOTHING_TO_FRAME")
    minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    center = (minimum + maximum) / 2.0
    radius = max((point - center).length for point in points)
    radius = max(radius, 0.05)
    camera_data = camera.data
    sensor = camera_data.sensor_width
    lens = camera_data.lens or 50.0
    half_angle = math.atan(sensor / (2.0 * lens))
    distance = (radius / math.tan(half_angle)) * margin
    direction = Vector((1.0, -1.2, 0.7)).normalized()
    camera.location = center + direction * distance
    look = (center - camera.location).normalized()
    camera.rotation_euler = look.to_track_quat("-Z", "Y").to_euler()
    return {
        "camera": camera.name,
        "center": [round(value, 4) for value in center],
        "radius": round(radius, 4),
        "distance": round(distance, 4),
    }


@registry.command("render.image")
def render_image(server, params):
    """渲染一张 PNG。返回文件路径，DSH 侧可再用 read_image 查看。"""
    scene = bpy.context.scene
    render = scene.render
    filepath = params.get("filepath")
    if not filepath:
        raise protocol.CommandError("render.image 需要 filepath。", code="BAD_REQUEST")
    filepath = os.path.abspath(str(filepath))
    helpers.ensure_directory(filepath)

    resolution = params.get("resolution")
    original = {
        "resolution_x": render.resolution_x,
        "resolution_y": render.resolution_y,
        "resolution_percentage": render.resolution_percentage,
        "engine": render.engine,
        "film_transparent": render.film_transparent,
        "filepath": render.filepath,
        "samples_cycles": getattr(scene.cycles, "samples", None) if hasattr(scene, "cycles") else None,
        "samples_eevee": getattr(scene.eevee, "taa_render_samples", None) if hasattr(scene, "eevee") else None,
    }
    if isinstance(resolution, (list, tuple)) and len(resolution) >= 2:
        render.resolution_x = max(16, int(resolution[0]))
        render.resolution_y = max(16, int(resolution[1]))
    if params.get("resolution_percentage") is not None:
        render.resolution_percentage = max(1, min(400, int(params["resolution_percentage"])))
    if params.get("engine"):
        render.engine = str(params["engine"])
    if params.get("transparent") is not None:
        render.film_transparent = bool(params["transparent"])
    if params.get("samples") is not None:
        samples = max(1, int(params["samples"]))
        if render.engine == "CYCLES" and hasattr(scene, "cycles"):
            scene.cycles.samples = samples
            scene.cycles.use_denoising = bool(params.get("denoise", True))
        elif hasattr(scene, "eevee"):
            scene.eevee.taa_render_samples = samples
    if params.get("frame") is not None:
        scene.frame_set(int(params["frame"]))

    camera, should_frame = ensure_camera(params)
    preview_light = ensure_light(params)
    world_snapshot = apply_world_strength(params)
    frame_info = None
    if should_frame:
        targets = helpers.resolve_targets(params)
        frame_info = frame_camera(camera, targets, float(params.get("margin") or 1.25))
    scene.camera = camera

    render.filepath = filepath
    image_settings = render.image_settings
    previous_format = image_settings.file_format
    image_settings.file_format = "PNG"
    started = time.time()
    try:
        bpy.ops.render.render(write_still=True)
    except RuntimeError as exc:
        raise protocol.CommandError(
            f"渲染失败：{exc}",
            code="RENDER_FAILED",
            hint="后台模式下 EEVEE 需要 GPU/OpenGL 支持；可改用 BLENDER_WORKBENCH 或 CYCLES。",
        ) from exc
    finally:
        image_settings.file_format = previous_format
        if preview_light is not None and preview_light.name in bpy.data.objects:
            bpy.data.objects.remove(preview_light, do_unlink=True)
        restore_world_strength(world_snapshot)
        render.resolution_x = original["resolution_x"]
        render.resolution_y = original["resolution_y"]
        render.resolution_percentage = original["resolution_percentage"]
        render.engine = original["engine"]
        render.film_transparent = original["film_transparent"]
        render.filepath = original["filepath"]
        if original["samples_cycles"] is not None and hasattr(scene, "cycles"):
            scene.cycles.samples = original["samples_cycles"]
        if original["samples_eevee"] is not None and hasattr(scene, "eevee"):
            scene.eevee.taa_render_samples = original["samples_eevee"]

    size = os.path.getsize(filepath) if os.path.exists(filepath) else 0
    return {
        "path": filepath,
        "bytes": size,
        "engine": original["engine"] if not params.get("engine") else str(params["engine"]),
        "resolution": [render.resolution_x, render.resolution_y],
        "camera": camera.name,
        "framed": frame_info,
        "seconds": round(time.time() - started, 2),
        "objects": len(scene.objects),
        "preview_light": "临时太阳光已用于本次预览并在渲染后移除" if preview_light is not None else None,
    }


@registry.command("view.screenshot")
def view_screenshot(server, params):
    """截取 3D 视口/窗口（仅 GUI 会话可用）。"""
    filepath = params.get("filepath")
    if not filepath:
        raise protocol.CommandError("view.screenshot 需要 filepath。", code="BAD_REQUEST")
    filepath = os.path.abspath(str(filepath))
    helpers.ensure_directory(filepath)
    if bpy.app.background:
        raise protocol.CommandError(
            "后台模式（--background）没有可截图的窗口。",
            code="NO_GUI",
            hint="请用 blender_render_view（相机渲染）代替，或在前台 Blender 会话里执行。",
        )
    windows = list(getattr(bpy.context.window_manager, "windows", []))
    if not windows:
        raise protocol.CommandError("没有可用窗口。", code="NO_GUI")
    want = str(params.get("area") or "VIEW_3D").upper()
    captured = []
    if want in {"ALL", "VIEW_3D"}:
        for window in windows:
            screen = window.screen
            for area in screen.areas:
                if area.type != "VIEW_3D":
                    continue
                region = next((item for item in area.regions if item.type == "WINDOW"), None)
                target = filepath if not captured else _suffixed(filepath, len(captured) + 1)
                with bpy.context.temp_override(window=window, area=area, region=region):
                    bpy.ops.screen.screenshot_area(filepath=target)
                captured.append(target)
                if want == "VIEW_3D":
                    break
            if want == "VIEW_3D" and captured:
                break
    if not captured:
        window = windows[0]
        area = window.screen.areas[0] if window.screen.areas else None
        region = next((item for item in (area.regions if area else []) if item.type == "WINDOW"), None)
        with bpy.context.temp_override(window=window, area=area, region=region):
            bpy.ops.screen.screenshot_area(filepath=filepath)
        captured.append(filepath)

    max_size = params.get("max_size")
    if max_size:
        for path in captured:
            _downscale(path, int(max_size))
    return {
        "paths": captured,
        "bytes": [os.path.getsize(path) if os.path.exists(path) else 0 for path in captured],
        "area": want,
    }


def _suffixed(path, index):
    root, ext = os.path.splitext(path)
    return f"{root}.{index:02d}{ext}"


def _downscale(path, longest_edge):
    """用 Blender 自带的图像 API 缩放截图，避免引入 PIL 依赖。"""
    try:
        image = bpy.data.images.load(path)
        width, height = image.size
        scale = longest_edge / float(max(width, height))
        if 0 < scale < 1.0:
            image.scale(max(1, int(width * scale)), max(1, int(height * scale)))
            image.filepath_raw = path
            image.file_format = "PNG"
            image.save()
        bpy.data.images.remove(image)
    except Exception:  # noqa: BLE001 - 缩放失败保留原图即可
        pass
