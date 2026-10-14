"""DSH Blender Bridge —— Blender 侧插件入口。

启用后会在本机回环地址上开一条 TCP 通道（默认 127.0.0.1:9880），
DSH 的 dsh-blender-studio 插件通过它把建模指令送进来；所有 bpy 操作都在
Blender 主线程执行（socket 线程只做收发与排队）。

面板位置：3D 视图 → 侧栏（N 面板）→ DSH。
无界面场景（服务器/CI）请改用同目录的 dsh_headless.py。
"""

bl_info = {
    "name": "DSH Blender Bridge",
    "author": "dsh-blender-studio contributors",
    "version": (0, 1, 0),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > DSH",
    "description": "Let DeepSeek Harness (DSH) agents model in Blender: primitives, mesh edits, modifiers, booleans, materials, renders and exports.",
    "doc_url": "https://github.com/OWNER/dsh-blender-studio",
    "category": "Interface",
}

import os
import sys

_ADDON_DIR = os.path.dirname(os.path.abspath(__file__))
if _ADDON_DIR not in sys.path:
    sys.path.insert(0, _ADDON_DIR)

import bpy  # type: ignore[import-not-found]
from bpy.props import BoolProperty, IntProperty, StringProperty  # type: ignore[import-not-found]

import dsh_protocol as protocol
import dsh_registry as registry
import dsh_server as server_module

#: 当前进程内的桥服务实例（每进程最多一个）。
_server = None

STATUS_ITEMS = [
    ("running", "运行中", ""),
    ("stopped", "已停止", ""),
    ("error", "启动失败", ""),
]


def get_preferences(context=None):
    """安全地取插件偏好设置。"""
    ctx = context or bpy.context
    try:
        addon = ctx.preferences.addons.get(__name__)
    except AttributeError:
        return None
    return addon.preferences if addon is not None else None


def _pump():
    """主线程定时器：把 socket 线程收到的请求执行掉。"""
    if _server is not None and _server.running:
        try:
            _server.pump()
        except Exception as exc:  # noqa: BLE001 - 绝不能让定时器异常打断 Blender
            print(f"[dsh-blender-bridge] pump 出错：{exc}")
    return 0.05


def _executor(cmd, params):
    return registry.execute(cmd, params, _server)


def start_bridge(host=None, port=None, token=None):
    """启动桥服务（幂等）。返回 (ok, message)。"""
    global _server
    prefs = get_preferences()
    host = host or (prefs.host if prefs else protocol.DEFAULT_HOST)
    port = int(port or (prefs.port if prefs else protocol.DEFAULT_PORT))
    token = token if token is not None else (prefs.token if prefs else "")
    if _server is not None and _server.running:
        if (host, port, token) == (_server.host, _server.port, _server.token):
            return True, f"桥已在运行：{_server.address}"
        stop_bridge()
    _server = server_module.BridgeServer(host=host, port=port, token=token, executor=_executor)
    try:
        _server.start()
    except OSError as exc:
        message = f"启动桥失败：{exc}"
        print(f"[dsh-blender-bridge] {message}")
        return False, message
    if not bpy.app.timers.is_registered(_pump):
        bpy.app.timers.register(_pump, persistent=True)
    message = f"DSH 桥已就绪：{_server.address}"
    print(f"[dsh-blender-bridge] {message}")
    return True, message


def stop_bridge():
    """停止桥服务。"""
    global _server
    if _server is None:
        return False, "桥未运行。"
    _server.stop()
    if bpy.app.timers.is_registered(_pump):
        bpy.app.timers.unregister(_pump)
    message = f"DSH 桥已停止（{_server.address}）。"
    _server = None
    print(f"[dsh-blender-bridge] {message}")
    return True, message


def bridge_status():
    """面板/诊断用的状态字典。"""
    if _server is None:
        return {"running": False, "address": "—", "requests": 0, "commands": len(registry.command_names())}
    status = _server.status()
    status["commands"] = len(registry.command_names())
    return status


class DSHBridgePreferences(bpy.types.AddonPreferences):
    """插件偏好设置（编辑 > 偏好设置 > 插件 > DSH Blender Bridge）。"""

    bl_idname = __name__

    host: StringProperty(
        name="监听地址",
        description="只建议使用回环地址；改成 0.0.0.0 会把这个建模通道暴露给局域网",
        default=protocol.DEFAULT_HOST,
    )
    port: IntProperty(name="端口", description="与 DSH 插件配置保持一致", default=protocol.DEFAULT_PORT, min=1, max=65535)
    token: StringProperty(name="访问令牌", description="可选：填写后 DSH 侧也要配置相同 token", default="", subtype="PASSWORD")
    auto_start: BoolProperty(name="启用插件时自动启动", default=True)
    show_welcome: BoolProperty(name="启动时打印连接提示", default=True)

    def draw(self, context):
        layout = self.layout
        status = bridge_status()
        box = layout.box()
        box.label(text=f"状态：{'运行中' if status['running'] else '已停止'}　地址：{status['address']}")
        box.label(text=f"已处理请求：{status['requests']}　支持命令：{status['commands']}")
        column = layout.column(align=True)
        column.prop(self, "host")
        column.prop(self, "port")
        column.prop(self, "token")
        column.prop(self, "auto_start")
        column.prop(self, "show_welcome")


class DSH_OT_bridge_start(bpy.types.Operator):
    bl_idname = "dsh_bridge.start"
    bl_label = "启动 DSH 桥"
    bl_description = "开始接受来自 DSH 的建模指令"

    def execute(self, context):
        ok, message = start_bridge()
        self.report({"INFO"} if ok else {"ERROR"}, message)
        return {"FINISHED"} if ok else {"CANCELLED"}


class DSH_OT_bridge_stop(bpy.types.Operator):
    bl_idname = "dsh_bridge.stop"
    bl_label = "停止 DSH 桥"
    bl_description = "断开与 DSH 的连接"

    def execute(self, context):
        _ok, message = stop_bridge()
        self.report({"INFO"}, message)
        return {"FINISHED"}


class DSH_OT_copy_endpoint(bpy.types.Operator):
    bl_idname = "dsh_bridge.copy_endpoint"
    bl_label = "复制连接信息"
    bl_description = "把地址与端口复制到剪贴板，便于填进 DSH 配置"

    def execute(self, context):
        status = bridge_status()
        payload = f"{status['address']}"
        context.window_manager.clipboard = payload
        self.report({"INFO"}, f"已复制：{payload}")
        return {"FINISHED"}


class DSH_PT_bridge_panel(bpy.types.Panel):
    bl_label = "DSH Blender Bridge"
    bl_idname = "DSH_PT_bridge_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "DSH"

    def draw(self, context):
        layout = self.layout
        status = bridge_status()
        box = layout.box()
        box.label(text="运行中" if status["running"] else "已停止", icon="PLAY" if status["running"] else "PAUSE")
        box.label(text=f"地址 {status['address']}")
        box.label(text=f"请求 {status['requests']} · 命令 {status['commands']}")
        if status.get("last_error"):
            box.label(text=str(status["last_error"])[:60], icon="ERROR")
        row = layout.row(align=True)
        row.operator("dsh_bridge.start", icon="PLAY")
        row.operator("dsh_bridge.stop", icon="PAUSE")
        layout.operator("dsh_bridge.copy_endpoint", icon="COPY_ID")
        column = layout.column(align=True)
        column.label(text="在 DSH 里试一句：")
        column.label(text="「用 blender 建个桌子」")


CLASSES = (
    DSHBridgePreferences,
    DSH_OT_bridge_start,
    DSH_OT_bridge_stop,
    DSH_OT_copy_endpoint,
    DSH_PT_bridge_panel,
)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    prefs = get_preferences()
    if prefs is not None and prefs.auto_start and not bpy.app.background:
        ok, message = start_bridge()
        if ok and prefs.show_welcome:
            print("[dsh-blender-bridge] 在 DSH 中运行 blender_status 即可确认连接。")


def unregister():
    stop_bridge()
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()
