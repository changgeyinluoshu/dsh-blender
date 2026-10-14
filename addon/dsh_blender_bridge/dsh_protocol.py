"""DSH Blender Bridge —— 协议常量与 JSON 编解码。

传输格式（与 DSH 侧 lib/bridge.js 严格对应）：

    请求  {"id": 1, "cmd": "scene.info", "params": {}, "token": ""}\n
    成功  {"id": 1, "ok": true,  "result": {...}}\n
    失败  {"id": 1, "ok": false, "error": {"message": "...", "code": "...", "traceback": "..."}}\n

一行一个 JSON 对象（NDJSON），UTF-8。桥只监听回环地址。
"""

import json
import math
import traceback as _traceback

BRIDGE_VERSION = "0.1.0"
PROTOCOL_VERSION = 1
DEFAULT_PORT = 9880
DEFAULT_HOST = "127.0.0.1"

#: 单个请求允许的最大字节数（命令里可能带较长脚本，但也要防止内存被撑爆）。
MAX_REQUEST_BYTES = 8 * 1024 * 1024


class CommandError(Exception):
    """命令执行失败：带稳定 code，便于 DSH 侧分类提示。"""

    def __init__(self, message, code="COMMAND_FAILED", hint=None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.hint = hint

    def to_payload(self):
        payload = {"message": self.message, "code": self.code}
        if self.hint:
            payload["hint"] = self.hint
        return payload


def jsonable(value, depth=0):
    """把 Blender/bpy 的返回值转换成可 JSON 序列化的结构。

    Vector/Color/Matrix 走 to_list/行列转换，bpy 数据块（ID）转成名字，
    其余不可序列化对象退化成 repr()，保证桥永远不会因为返回值本身而失败。
    """
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if depth > 6:
        return repr(value)
    if isinstance(value, dict):
        return {str(key): jsonable(item, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [jsonable(item, depth + 1) for item in value]
    # mathutils.Vector / Color / Euler / Quaternion / Matrix
    for method in ("to_list", "to_tuple"):
        if hasattr(value, method):
            try:
                return jsonable(getattr(value, method)(), depth + 1)
            except Exception:
                pass
    if hasattr(value, "to_quaternion") and hasattr(value, "to_euler"):
        try:
            return [list(row) for row in value]  # 矩阵
        except Exception:
            pass
    # bpy 数据块（Object / Material / Collection …）
    if hasattr(value, "name") and hasattr(value, "bl_rna"):
        return value.name
    return repr(value)


def encode_message(payload):
    """序列化一条消息（带换行）。"""
    return (json.dumps(payload, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")


def ok_response(message_id, result):
    return {"id": message_id, "ok": True, "result": jsonable(result)}


def error_response(message_id, error, code="COMMAND_FAILED"):
    payload = {"id": message_id, "ok": False, "error": {"message": str(error), "code": code}}
    return payload


def error_from_exception(message_id, exc):
    """把异常转成响应；CommandError 保留 code/hint，其余带 traceback。"""
    if isinstance(exc, CommandError):
        return {"id": message_id, "ok": False, "error": exc.to_payload()}
    return {
        "id": message_id,
        "ok": False,
        "error": {
            "message": str(exc) or exc.__class__.__name__,
            "code": "EXCEPTION",
            "traceback": "".join(_traceback.format_exception(type(exc), exc, exc.__traceback__))[-4000:],
        },
    }


def parse_request(raw):
    """解析一行请求，返回 (id, cmd, params, token)。"""
    try:
        message = json.loads(raw)
    except Exception as exc:  # noqa: BLE001 - 需要把任何解析失败变成协议错误
        raise CommandError(f"请求不是合法 JSON：{exc}", code="BAD_REQUEST") from exc
    if not isinstance(message, dict):
        raise CommandError("请求必须是 JSON 对象。", code="BAD_REQUEST")
    return (
        message.get("id"),
        message.get("cmd"),
        message.get("params") or {},
        message.get("token") or "",
    )
