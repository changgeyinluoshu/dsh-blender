"""数据进出命令：导出、导入、文件/撤销、任意 Python 执行。"""

import contextlib
import io
import os
import time
import traceback as traceback_module

import bmesh  # type: ignore[import-not-found]
import bpy  # type: ignore[import-not-found]
import mathutils  # type: ignore[import-not-found]

import dsh_helpers as helpers
import dsh_protocol as protocol
import dsh_registry as registry


def _call(candidates, description):
    """依次尝试若干 (函数, kwargs) 组合，兼容不同 Blender 版本的算子签名。

    candidates: [(callable, dict_of_kwargs), ...] —— 第一个成功即返回。
    """
    errors = []
    for func, kwargs in candidates:
        try:
            func(**kwargs)
            return True
        except TypeError as exc:  # 签名不匹配（版本差异）
            errors.append(f"{getattr(func, '__name__', func)}: {exc}")
        except RuntimeError as exc:  # 算子自身失败（例如无可导出对象）
            errors.append(f"{getattr(func, '__name__', func)}: {exc}")
    raise protocol.CommandError(
        f"{description} 失败：" + "；".join(errors[-2:]),
        code="OPERATOR_FAILED",
    )


def _require(path):
    if not path:
        raise protocol.CommandError("需要一个文件路径。", code="BAD_REQUEST")
    return os.path.abspath(str(path))


@registry.command("export.file")
def export_file(server, params):
    """导出场景/选择集。返回落盘路径与字节数。"""
    fmt = str(params.get("format") or "glb").lower()
    filepath = _require(params.get("filepath"))
    helpers.ensure_directory(filepath)
    selected = bool(params.get("selected_only"))
    apply_modifiers = params.get("apply_modifiers", True) is not False
    scale = float(params.get("scale") or 1.0)
    y_up = params.get("y_up", True) is not False
    triangulate = bool(params.get("triangulate"))
    started = time.time()

    if fmt in {"glb", "gltf"}:
        _call([
            (bpy.ops.export_scene.gltf, {
                "filepath": filepath,
                "export_format": "GLB" if fmt == "glb" else "GLTF_SEPARATE",
                "use_selection": selected,
                "export_apply": apply_modifiers,
                "export_yup": y_up,
            }),
            (bpy.ops.export_scene.gltf, {"filepath": filepath}),
        ], "导出 glTF")
    elif fmt == "fbx":
        _call([
            (bpy.ops.export_scene.fbx, {
                "filepath": filepath,
                "use_selection": selected,
                "use_mesh_modifiers": apply_modifiers,
                "global_scale": scale,
                "apply_unit_scale": True,
                "mesh_smooth_type": "OFF",
            }),
            (bpy.ops.export_scene.fbx, {"filepath": filepath, "use_selection": selected}),
            (bpy.ops.export_scene.fbx, {"filepath": filepath}),
        ], "导出 FBX")
    elif fmt == "obj":
        _call([
            (bpy.ops.wm.obj_export, {
                "filepath": filepath,
                "export_selected_objects": selected,
                "apply_modifiers": apply_modifiers,
                "export_materials": True,
                "forward_axis": "NEGATIVE_Z",
                "up_axis": "Y" if y_up else "Z",
                "global_scale": scale,
            }),
            (bpy.ops.wm.obj_export, {"filepath": filepath, "export_selected_objects": selected}),
            (bpy.ops.export_scene.obj, {"filepath": filepath, "use_selection": selected}),
        ], "导出 OBJ")
    elif fmt == "stl":
        _call([
            (bpy.ops.wm.stl_export, {
                "filepath": filepath,
                "export_selected_objects": selected,
                "apply_modifiers": apply_modifiers,
                "global_scale": scale,
            }),
            (bpy.ops.wm.stl_export, {"filepath": filepath}),
            (bpy.ops.export_mesh.stl, {"filepath": filepath, "use_selection": selected}),
        ], "导出 STL")
    elif fmt == "ply":
        _call([
            (bpy.ops.wm.ply_export, {
                "filepath": filepath,
                "export_selected_objects": selected,
                "apply_modifiers": apply_modifiers,
            }),
            (bpy.ops.wm.ply_export, {"filepath": filepath}),
            (bpy.ops.export_mesh.ply, {"filepath": filepath, "use_selection": selected}),
        ], "导出 PLY")
    elif fmt in {"usd", "usda", "usdc", "usdz"}:
        _call([
            (bpy.ops.wm.usd_export, {
                "filepath": filepath,
                "selected_objects_only": selected,
                "export_apply": apply_modifiers,
            }),
            (bpy.ops.wm.usd_export, {"filepath": filepath}),
        ], "导出 USD")
    elif fmt == "blend":
        _call([
            (bpy.ops.wm.save_as_mainfile, {"filepath": filepath, "copy": True, "compress": False}),
        ], "保存 .blend 副本")
    else:
        raise protocol.CommandError(
            f"不支持的导出格式：{fmt}",
            code="BAD_FORMAT",
            hint="可用：glb / gltf / fbx / obj / stl / ply / usd / usda / blend",
        )

    if triangulate and fmt in {"glb", "gltf"}:
        pass  # glTF 导出本身即三角化
    size = os.path.getsize(filepath) if os.path.exists(filepath) else 0
    if size == 0:
        raise protocol.CommandError(f"导出后文件为空：{filepath}", code="EMPTY_OUTPUT")
    return {
        "path": filepath,
        "format": fmt,
        "bytes": size,
        "seconds": round(time.time() - started, 2),
        "selected_only": selected,
        "objects": len(bpy.context.scene.objects),
    }


@registry.command("import.file")
def import_file(server, params):
    """导入模型文件，返回新建对象名。"""
    filepath = _require(params.get("filepath"))
    if not os.path.exists(filepath):
        raise protocol.CommandError(f"文件不存在：{filepath}", code="FILE_NOT_FOUND")
    fmt = str(params.get("format") or os.path.splitext(filepath)[1].lstrip(".")).lower()
    scale = float(params.get("scale") or 1.0)
    before = {obj.name for obj in bpy.data.objects}

    if fmt in {"glb", "gltf"}:
        _call([(bpy.ops.import_scene.gltf, {"filepath": filepath})], "导入 glTF")
    elif fmt == "fbx":
        _call([
            (bpy.ops.import_scene.fbx, {"filepath": filepath, "global_scale": scale}),
            (bpy.ops.import_scene.fbx, {"filepath": filepath}),
        ], "导入 FBX")
    elif fmt == "obj":
        _call([
            (bpy.ops.wm.obj_import, {"filepath": filepath, "global_scale": scale}),
            (bpy.ops.wm.obj_import, {"filepath": filepath}),
            (bpy.ops.import_scene.obj, {"filepath": filepath}),
        ], "导入 OBJ")
    elif fmt == "stl":
        _call([
            (bpy.ops.wm.stl_import, {"filepath": filepath, "global_scale": scale}),
            (bpy.ops.wm.stl_import, {"filepath": filepath}),
            (bpy.ops.import_mesh.stl, {"filepath": filepath}),
        ], "导入 STL")
    elif fmt == "ply":
        _call([
            (bpy.ops.wm.ply_import, {"filepath": filepath}),
            (bpy.ops.import_mesh.ply, {"filepath": filepath}),
        ], "导入 PLY")
    elif fmt in {"usd", "usda", "usdc", "usdz"}:
        _call([(bpy.ops.wm.usd_import, {"filepath": filepath})], "导入 USD")
    elif fmt == "dae":
        _call([(bpy.ops.wm.collada_import, {"filepath": filepath})], "导入 DAE")
    elif fmt == "blend":
        raise protocol.CommandError(
            "导入 .blend 请用 blender_file action=open（会替换当前文件），或先在 Blender 里 append。",
            code="USE_OPEN",
        )
    else:
        raise protocol.CommandError(f"不支持的导入格式：{fmt}", code="BAD_FORMAT")

    created = [obj for obj in bpy.data.objects if obj.name not in before]
    location = params.get("location")
    if location and created:
        offset = helpers.as_vector(location)
        for obj in created:
            if obj.parent is None:
                obj.location = [obj.location[index] + offset[index] for index in range(3)]
    bpy.context.view_layer.update()
    if created:
        helpers.select_only(created, active=created[0])
    return {
        "path": filepath,
        "format": fmt,
        "imported": [helpers.describe_object(obj) for obj in created],
        "count": len(created),
    }


@registry.command("file.op")
def file_op(server, params):
    """文件与历史：undo/redo/save/save_as/open/new/revert/info。"""
    action = str(params.get("action") or "info").lower()
    steps = max(1, int(params.get("steps") or 1))

    if action == "info":
        return {
            "file": bpy.data.filepath or None,
            "is_dirty": bool(bpy.data.is_dirty),
            "scene": bpy.context.scene.name,
            "objects": len(bpy.context.scene.objects),
        }

    if action in {"undo", "redo"}:
        if bpy.app.background:
            raise protocol.CommandError(
                "后台模式的 Blender 不维护撤销栈。",
                code="NO_UNDO",
                hint="请用前台 Blender 会话执行撤销，或直接重跑建模命令。",
            )
        operator = bpy.ops.ed.undo if action == "undo" else bpy.ops.ed.redo
        for _ in range(steps):
            try:
                operator()
            except RuntimeError as exc:
                raise protocol.CommandError(f"{action} 失败：{exc}", code="UNDO_FAILED") from exc
        return {"action": action, "steps": steps, "file": bpy.data.filepath or None}

    if action == "save":
        filepath = params.get("filepath")
        if filepath:
            _call([(bpy.ops.wm.save_as_mainfile, {"filepath": _require(filepath)})], "另存为")
        else:
            _call([(bpy.ops.wm.save_mainfile, {})], "保存")
        return {"file": bpy.data.filepath, "saved": True}

    if action == "save_as":
        filepath = _require(params.get("filepath"))
        helpers.ensure_directory(filepath)
        _call([(bpy.ops.wm.save_as_mainfile, {"filepath": filepath})], "另存为")
        return {"file": bpy.data.filepath, "saved": True}

    if action == "open":
        filepath = _require(params.get("filepath"))
        if not os.path.exists(filepath):
            raise protocol.CommandError(f"文件不存在：{filepath}", code="FILE_NOT_FOUND")
        _call([(bpy.ops.wm.open_mainfile, {"filepath": filepath})], "打开文件")
        return {"file": bpy.data.filepath, "objects": len(bpy.context.scene.objects)}

    if action == "new":
        _call([(bpy.ops.wm.read_homefile, {"use_empty": True})], "新建空文件")
        return {"file": bpy.data.filepath or None, "objects": len(bpy.context.scene.objects)}

    if action == "revert":
        if not bpy.data.filepath:
            raise protocol.CommandError("当前文件还没有保存过，无法 revert。", code="NO_FILE")
        _call([(bpy.ops.wm.revert_mainfile, {})], "还原文件")
        return {"file": bpy.data.filepath, "objects": len(bpy.context.scene.objects)}

    raise protocol.CommandError(
        f"不支持的 file action：{action}",
        code="BAD_ACTION",
        hint="可用：undo / redo / save / save_as / open / new / revert / info",
    )


@registry.command("python.exec")
def python_exec(server, params):
    """在 Blender 主线程执行一段 Python，返回 stdout 与 result 变量。"""
    code = params.get("code")
    if not isinstance(code, str) or not code.strip():
        raise protocol.CommandError("python.exec 需要非空的 code。", code="BAD_REQUEST")
    namespace = {
        "bpy": bpy,
        "bmesh": bmesh,
        "mathutils": mathutils,
        "math": __import__("math"),
        "os": os,
        "result": None,
        "__name__": "__dsh_blender__",
    }
    buffer = io.StringIO()
    started = time.time()
    try:
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            exec(compile(code, "<dsh-blender-studio>", "exec"), namespace)
    except Exception as exc:  # noqa: BLE001 - 把用户代码的异常原样带回 DSH
        raise protocol.CommandError(
            f"Python 执行失败：{exc}",
            code="PYTHON_ERROR",
            hint=traceback_module.format_exc()[-2000:],
        ) from exc
    result = namespace.get("result")
    return {
        "stdout": buffer.getvalue()[-8000:],
        "result": result,
        "seconds": round(time.time() - started, 2),
    }
