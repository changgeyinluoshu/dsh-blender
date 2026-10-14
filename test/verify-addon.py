"""验证从 zip 安装的 Blender 插件能被真实 Blender 正常启用/停用。

用法：
    blender --background --python test/verify-addon.py -- <addons_root>

<addons_root> 是包含 dsh_blender_bridge/ 的目录（即 zip 解压后的目录）。
覆盖：bl_info / 命令注册表 / 面板与操作符注册 / 偏好设置条目 /
      background 下手动启动与停止桥 / 停用后清理干净。
"""

import json
import os
import sys

import addon_utils
import bpy

NAME = "dsh_blender_bridge"


def write_report(passed, failures, checks):
    """把结果写到 DSH_ADDON_REPORT 指定的文件，便于调用方（stdio 被忽略时）读取。"""
    path = os.environ.get("DSH_ADDON_REPORT")
    if not path:
        return
    try:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"passed": passed, "failures": failures, "checks": checks, "blender": bpy.app.version_string}, handle, ensure_ascii=False, indent=2)
    except OSError as exc:
        print("could not write report: " + str(exc))


def arg_after_dashdash():
    if "--" not in sys.argv:
        return None
    rest = sys.argv[sys.argv.index("--") + 1 :]
    return rest[0] if rest else None


def main():
    root = arg_after_dashdash()
    failures = []

    checks = []

    def check(label, ok, detail=""):
        print(("OK   " if ok else "FAIL ") + label + ("  " + str(detail) if detail else ""))
        checks.append({"label": label, "ok": bool(ok), "detail": str(detail)})
        if not ok:
            failures.append(label)

    check("addons root given", bool(root), root)
    if not root:
        return 1
    root = os.path.abspath(root)
    check("addon folder exists", os.path.isdir(os.path.join(root, NAME)))

    if root not in sys.path:
        sys.path.insert(0, root)
    addon_utils.modules_refresh()

    module = __import__(NAME)
    check("bl_info present", getattr(module, "bl_info", {}).get("name") == "DSH Blender Bridge")
    check("bridge version exported", module.protocol.BRIDGE_VERSION == "0.1.0")
    check("command registry non-empty", len(module.registry.command_names()) >= 25, len(module.registry.command_names()))

    # 用偏好设置的启用路径（与用户在界面上勾选一致），这样才会创建偏好设置条目。
    result = bpy.ops.preferences.addon_enable(module=NAME)
    check("preferences.addon_enable returns FINISHED", result == {"FINISHED"}, result)

    check("panel registered", hasattr(bpy.types, "DSH_PT_bridge_panel"))
    check("start operator registered", hasattr(bpy.types, "DSH_BRIDGE_OT_start"))
    check("stop operator registered", hasattr(bpy.types, "DSH_BRIDGE_OT_stop"))

    entry = bpy.context.preferences.addons.get(NAME)
    check("preferences entry created", entry is not None)
    if entry is not None:
        prefs = entry.preferences
        check("preferences expose host/port/token", all(hasattr(prefs, name) for name in ("host", "port", "token", "auto_start")), prefs.port)
        check("default port is 9880", prefs.port == 9880, prefs.port)
    else:
        prefs = None

    status = module.bridge_status()
    check("background mode did not auto-start the bridge", status["running"] is False, status)

    # GUI 未启动时手动启动也应工作（定时器在后台不触发，但绑定端口与状态维护应正常）
    ok, message = module.start_bridge(host="127.0.0.1", port=9912)
    check("manual start in background works", ok, message)
    check("status reports running", module.bridge_status()["running"] is True)
    ok_stop, _ = module.stop_bridge()
    check("stop works", ok_stop and module.bridge_status()["running"] is False)

    # 注册的命令清单能被 executor 找到（不实际执行）
    from dsh_registry import REGISTRY  # noqa: E402  (模块已随插件导入)

    check("executor registry populated", len(REGISTRY) >= 25, len(REGISTRY))

    disable_result = bpy.ops.preferences.addon_disable(module=NAME)
    check("addon_disable returns FINISHED", disable_result == {"FINISHED"}, disable_result)
    check("panel removed after disable", not hasattr(bpy.types, "DSH_PT_bridge_panel"))

    print("")
    if failures:
        print("FAILURES: " + ", ".join(failures))
        write_report(False, failures, checks)
        return 1
    print("ALL ADDON CHECKS PASSED")
    write_report(True, [], checks)
    return 0


if __name__ == "__main__":
    sys.exit(main())
