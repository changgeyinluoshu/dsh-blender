"""DSH Blender Bridge —— TCP 服务端。

线程模型（重要）：
    * 监听/读取在后台线程里做；
    * **所有 bpy 操作都在 Blender 主线程执行**（bpy 不是线程安全的）；
    * GUI 模式：后台线程把请求塞进队列，主线程由 bpy.app.timers 定时泵出执行；
    * headless 模式：没有事件循环，主线程直接 accept 并同步执行（serve_forever）。

因此同一时刻只有一个请求真正跑在 bpy 上，天然串行，不需要额外加锁。
"""

import queue
import socket
import threading
import time

import dsh_protocol as protocol


class _Job:
    """一次跨线程的请求/响应搬运。"""

    __slots__ = ("request_id", "cmd", "params", "response", "done")

    def __init__(self, request_id, cmd, params):
        self.request_id = request_id
        self.cmd = cmd
        self.params = params
        self.response = None
        self.done = threading.Event()


class BridgeServer:
    """把命令执行能力暴露成一条本地 TCP 通道。"""

    def __init__(self, host=protocol.DEFAULT_HOST, port=protocol.DEFAULT_PORT, token="", executor=None, logger=None):
        self.host = host
        self.port = int(port)
        self.token = token or ""
        self.executor = executor
        self.logger = logger
        self.running = False
        self.last_error = None
        self.started_at = None
        self.request_count = 0
        self.last_command = None
        self._socket = None
        self._thread = None
        self._queue = queue.Queue()
        self._stop = threading.Event()
        self._job_timeout = 600.0

    # ---------------------------------------------------------------- 生命周期

    @property
    def address(self):
        return f"{self.host}:{self.port}"

    def start(self):
        """绑定端口并启动后台接受线程。已在运行时直接返回。"""
        if self.running:
            return True
        try:
            server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind((self.host, self.port))
            server.listen(16)
            server.settimeout(0.5)
        except OSError as exc:
            self.running = False
            self.last_error = f"无法监听 {self.address}：{exc}"
            raise
        self._socket = server
        self._stop.clear()
        self._thread = threading.Thread(target=self._accept_loop, name="dsh-blender-bridge", daemon=True)
        self._thread.start()
        self.running = True
        self.started_at = time.time()
        self.last_error = None
        return True

    def stop(self):
        """停止服务并关闭套接字（可重复调用）。"""
        self._stop.set()
        self.running = False
        if self._socket is not None:
            try:
                self._socket.close()
            except OSError:
                pass
            self._socket = None
        thread = self._thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2.0)
        self._thread = None
        return True

    def status(self):
        return {
            "running": self.running,
            "address": self.address,
            "requests": self.request_count,
            "last_error": self.last_error,
            "uptime_seconds": round(time.time() - self.started_at, 1) if self.started_at else 0,
        }

    # ---------------------------------------------------------------- 主线程泵

    def pump(self, budget=8):
        """主线程调用：执行队列里等待中的请求。返回处理条数。"""
        handled = 0
        while handled < budget:
            try:
                job = self._queue.get_nowait()
            except queue.Empty:
                break
            self._run_job(job)
            handled += 1
        return handled

    def _run_job(self, job):
        self.request_count += 1
        self.last_command = job.cmd
        try:
            if self.executor is None:
                raise protocol.CommandError("服务端没有装配执行器。", code="NO_EXECUTOR")
            result = self.executor(job.cmd, job.params)
            job.response = protocol.ok_response(job.request_id, result)
        except Exception as exc:  # noqa: BLE001 - 任何异常都要回给 DSH，而不是打断 Blender
            job.response = protocol.error_from_exception(job.request_id, exc)
        finally:
            job.done.set()

    # ---------------------------------------------------------------- 后台接受

    def _accept_loop(self):
        while not self._stop.is_set():
            sock = self._socket
            if sock is None:
                break
            try:
                conn, _address = sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            worker = threading.Thread(target=self._serve_connection, args=(conn,), daemon=True)
            worker.start()

    def _serve_connection(self, conn):
        """一条连接可以发送多条请求；DSH 侧目前是一请求一连接。"""
        try:
            conn.settimeout(30.0)
            buffer = b""
            while not self._stop.is_set():
                try:
                    chunk = conn.recv(65536)
                except socket.timeout:
                    break
                except OSError:
                    break
                if not chunk:
                    break
                buffer += chunk
                if len(buffer) > protocol.MAX_REQUEST_BYTES:
                    conn.sendall(protocol.error_response(None, "请求过大。", code="REQUEST_TOO_LARGE"))
                    break
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not line.strip():
                        continue
                    response = self._dispatch(line)
                    conn.sendall(protocol.encode_message(response))
        except OSError as exc:
            self.last_error = f"连接处理失败：{exc}"
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _dispatch(self, line):
        """解析请求、校验 token、投递给主线程并等待结果。"""
        message_id = None
        try:
            message_id, cmd, params, token = protocol.parse_request(line.decode("utf-8"))
        except protocol.CommandError as exc:
            return protocol.error_response(None, exc.message, code=exc.code)
        except UnicodeDecodeError:
            return protocol.error_response(None, "请求不是合法 UTF-8。", code="BAD_REQUEST")
        if not cmd:
            return protocol.error_response(message_id, "缺少 cmd 字段。", code="BAD_REQUEST")
        if self.token and token != self.token:
            return protocol.error_response(message_id, "token 不匹配。", code="UNAUTHORIZED")
        job = _Job(message_id, cmd, params)
        self._queue.put(job)
        if not job.done.wait(self._job_timeout):
            return protocol.error_response(message_id, f"命令 {cmd} 执行超时（{self._job_timeout:.0f}s）。", code="EXECUTION_TIMEOUT")
        return job.response if job.response is not None else protocol.error_response(message_id, "内部错误：没有结果。", code="NO_RESULT")

    # ---------------------------------------------------------------- headless

    def serve_forever(self, on_ready=None, max_requests=None):
        """headless 专用：主线程 accept 并同步执行，直到 stop() 被调用。

        没有事件循环的 Blender（--background）里 bpy.app.timers 不会被触发，
        所以这里让主线程自己完成 accept → 执行 → 响应，保持 bpy 单线程语义。
        """
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((self.host, self.port))
        server.listen(8)
        server.settimeout(0.5)
        self._socket = server
        self.running = True
        self.started_at = time.time()
        if on_ready:
            on_ready(self)
        try:
            while not self._stop.is_set():
                try:
                    conn, _address = server.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                with conn:
                    conn.settimeout(30.0)
                    buffer = b""
                    keep = True
                    while keep and not self._stop.is_set():
                        try:
                            chunk = conn.recv(65536)
                        except (socket.timeout, OSError):
                            break
                        if not chunk:
                            break
                        buffer += chunk
                        while b"\n" in buffer:
                            line, buffer = buffer.split(b"\n", 1)
                            if not line.strip():
                                continue
                            message_id, cmd, params, token = (None, None, {}, "")
                            try:
                                message_id, cmd, params, token = protocol.parse_request(line.decode("utf-8"))
                            except protocol.CommandError as exc:
                                conn.sendall(protocol.encode_message(protocol.error_response(None, exc.message, code=exc.code)))
                                continue
                            if self.token and token != self.token:
                                conn.sendall(protocol.encode_message(protocol.error_response(message_id, "token 不匹配。", code="UNAUTHORIZED")))
                                continue
                            self.request_count += 1
                            self.last_command = cmd
                            try:
                                result = self.executor(cmd, params)
                                response = protocol.ok_response(message_id, result)
                            except Exception as exc:  # noqa: BLE001
                                response = protocol.error_from_exception(message_id, exc)
                            conn.sendall(protocol.encode_message(response))
                            if max_requests is not None and self.request_count >= max_requests:
                                keep = False
                                self._stop.set()
        finally:
            try:
                server.close()
            except OSError:
                pass
            self.running = False
        return True
