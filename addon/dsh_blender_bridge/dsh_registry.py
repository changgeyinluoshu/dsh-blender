"""命令注册表：cmd 字符串 → 处理函数。

约定：
    * 每个处理函数签名统一为 `handler(server, params) -> dict | list | 值`；
    * 返回值会被 dsh_protocol.jsonable() 转成 JSON；
    * 失败请抛 dsh_protocol.CommandError(message, code, hint)，DSH 侧会原样展示。
"""

import dsh_protocol as protocol

#: name -> handler
REGISTRY = {}
_LOADED = False


def command(name):
    """把一个函数注册为命令处理函数。"""

    def decorator(func):
        if name in REGISTRY:
            raise RuntimeError(f"命令重复注册：{name}")
        REGISTRY[name] = func
        return func

    return decorator


def _ensure_loaded():
    """首次使用时导入各实现模块（它们靠装饰器自注册）。"""
    global _LOADED
    if _LOADED:
        return
    _LOADED = True
    # 这些模块仅为了副作用（装饰器注册）而导入。
    import dsh_ops_scene  # noqa: F401
    import dsh_ops_mesh  # noqa: F401
    import dsh_ops_look  # noqa: F401
    import dsh_ops_io  # noqa: F401


def command_names():
    _ensure_loaded()
    return sorted(REGISTRY)


def execute(cmd, params=None, server=None):
    """执行一条命令。未知命令给出可用命令清单，便于排错。"""
    _ensure_loaded()
    handler = REGISTRY.get(cmd)
    if handler is None:
        suggestion = ", ".join(sorted(REGISTRY)[:12])
        raise protocol.CommandError(
            f"未知命令：{cmd}（可用示例：{suggestion} …）",
            code="UNKNOWN_COMMAND",
            hint="用 blender_run_python 执行任意 bpy 代码，或查询本插件的命令清单。",
        )
    return handler(server, params or {})
