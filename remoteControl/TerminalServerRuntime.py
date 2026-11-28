"""功能：在主项目core服务进程内托管设备管理、本机执行和VPS传输入口。

注册参数root为主项目目录；从config/terminalConnection.json定位共享终端库与私有配置。
未配置时不启动；默认复用17864管理端口和既有本地通知端口，不创建独立终端进程。
"""
import json
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path


class TerminalServerRuntime:
    """让设备管理与服务器本机能力随主项目启动、停止和诊断。"""

    def __init__(self, root):
        """root为主项目绝对目录；网络端点和身份仍由原有私有JSON配置提供。"""
        self.root = Path(root)
        self.stopped = threading.Event()
        self.http = self.node = self.local = self.manager = None
        self.thread = None

    def start_runtime(self):
        """无参数；在现有core进程创建线程，不拉起RunTerminal客户端或额外进程。"""
        bridge = self.root / "config/terminalConnection.json"
        if not bridge.is_file():
            return False
        cfg = json.loads(bridge.read_text(encoding="utf-8-sig"))
        repo = (self.root / cfg["repositoryRoot"]).resolve()
        sys.path.insert(0, str(repo))
        sys.path.insert(0, str(repo.parent / "backend-service"))
        if (repo / "runtime/dependencies").is_dir():
            sys.path.insert(0, str(repo / "runtime/dependencies"))
        from fleetService.TerminalManager import TerminalManager
        from fleetService.TerminalAdminHandler import TerminalAdminHandler
        from terminalConnection.server.RelayServerNode import RelayServerNode
        from terminalConnection.server.ServerLocalDevice import ServerLocalDevice
        server = json.loads((repo / "config/ServerConfig.json").read_text(encoding="utf-8-sig"))
        local = json.loads((repo / "config/TerminalConfig.json").read_text(encoding="utf-8-sig"))
        self.http = ThreadingHTTPServer(("127.0.0.1", int(server.get("adminPort", 17864))), TerminalAdminHandler)
        try:
            self.manager = TerminalManager(server)
            self.local = ServerLocalDevice(self.manager, local)
            self.manager.local_device = self.local
            self.node = RelayServerNode(self.manager, server)
            self.http.manager, self.http.node, self.http.token = self.manager, self.node, server["adminToken"]
            self.local.start_device()
            threading.Thread(target=self.http.serve_forever, daemon=True).start()
            threading.Thread(target=self.node.run_forever, daemon=True).start()
            self.thread = threading.Thread(target=self.maintain_runtime, daemon=True)
            self.thread.start()
            return True
        except BaseException:
            self.http.server_close()
            raise

    def maintain_runtime(self):
        """无参数；维护本机登记与完成通知，异常只记录类型，不落文件正文或凭据。"""
        state = self.root / "runtime/remoteControl/hostStatus.json"
        state.parent.mkdir(parents=True, exist_ok=True)
        while not self.stopped.is_set():
            try:
                self.local.maintain_device()
                self.manager.deliver_notifications()
                self.manager.write_snapshot()
                value = {"ok": True, "owner": "core", "relayConnected": self.node.connected}
            except Exception as exc:
                value = {"ok": False, "owner": "core", "error": type(exc).__name__}
            temp = state.with_suffix(".tmp")
            temp.write_text(json.dumps(value), encoding="utf-8")
            temp.replace(state)
            self.stopped.wait(3)

    def close_runtime(self):
        """无参数；释放宿主线程和监听端口，不关闭用户正在使用的其他应用。"""
        self.stopped.set()
        if self.node:
            self.node.stopped.set()
        if self.local:
            self.local.close_device()
        if self.http:
            self.http.shutdown()
            self.http.server_close()
        if self.thread:
            self.thread.join(timeout=5)
