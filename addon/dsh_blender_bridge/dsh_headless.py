"""无界面启动 DSH 桥（Blender --background）。

用法：

    blender --background --python <addons>/dsh_blender_bridge/dsh_headless.py -- --port 9880

可选参数：
    --host 127.0.0.1    监听地址（默认回环）
    --port 9880         端口
    --token TOKEN       访问令牌（与 DSH 侧保持一致）
    --once              处理完一条请求后退出（CI 冒烟测试用）
    --open FILE         启动前打开一个 .blend
    --print-commands    打印支持的命令清单后退出

无界面模式下 bpy.app.timers 不会被触发，因此这里由主线程直接
accept → 执行 → 响应，保持 bpy 单线程语义。
"""

import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import bpy  # type: ignore[import-not-found]

import dsh_protocol as protocol
import dsh_registry as registry
import dsh_server as server_module


def parse_args(argv):
    """从 blender 的命令行里取出 '--' 之后的参数。"""
    tail = argv[argv.index("--") + 1 :] if "--" in argv else []
    parser = argparse.ArgumentParser(prog="dsh_headless.py", description="DSH Blender Bridge (headless)")
    parser.add_argument("--host", default=protocol.DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=protocol.DEFAULT_PORT)
    parser.add_argument("--token", default="")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--open", dest="open_file", default="")
    parser.add_argument("--print-commands", action="store_true")
    parser.add_argument("--ready-file", dest="ready_file", default="", help="就绪后把 host/port/pid 写进该 JSON 文件（便于外部进程等待）")
    args, _unknown = parser.parse_known_args(tail)
    return args


def main():
    args = parse_args(sys.argv)
    if args.print_commands:
        print("DSH_BRIDGE_COMMANDS " + ",".join(registry.command_names()))
        return
    if args.open_file:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.open_file))

    holder = {}

    def executor(cmd, params):
        return registry.execute(cmd, params, holder.get("server"))

    server = server_module.BridgeServer(host=args.host, port=args.port, token=args.token, executor=executor)
    holder["server"] = server

    def on_ready(instance):
        print(f"DSH_BRIDGE_READY host={instance.host} port={instance.port} commands={len(registry.command_names())}", flush=True)
        if args.ready_file:
            try:
                with open(args.ready_file, "w", encoding="utf-8") as handle:
                    json.dump(
                        {
                            "host": instance.host,
                            "port": instance.port,
                            "pid": os.getpid(),
                            "blender": bpy.app.version_string,
                            "commands": len(registry.command_names()),
                        },
                        handle,
                    )
            except OSError as exc:  # 就绪文件只是辅助手段，失败不影响服务
                print(f"[dsh-blender-bridge] 写入 ready 文件失败：{exc}")

    try:
        server.serve_forever(on_ready=on_ready, max_requests=1 if args.once else None)
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()
    return 0


if __name__ == "__main__":
    main()
