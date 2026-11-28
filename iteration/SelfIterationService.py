"""功能：自迭代微服务。唯一拥有预演、技能沉淀、夜间维护、日记归档等自动执行逻辑。

注册参数 root 为主项目 Path、host/port 为监听地址；默认 127.0.0.1:8820。
只调度已登记任务，不内联业务代码；所有执行结果写 runtime/iteration。
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from iteration.JobRegistry import JobRegistry
from iteration.Scheduler import Scheduler


class SelfIterationService:
    """自迭代任务的唯一入口。"""

    def __init__(self, root, host="127.0.0.1", port=8820):
        """root 为主项目 Path；host/port 为监听地址。"""
        self.root = root
        self.host = host
        self.port = int(port)
        self.registry = JobRegistry(root / "config" / "iteration.json")
        self.scheduler = Scheduler(root, self.registry)

    def start(self):
        """无参数；启动调度器（服务进程内）。"""
        self.scheduler.start()
        return self

    def serve_forever(self):
        """无参数；启动 HTTP 并常驻。"""
        service = self

        class Handler(BaseHTTPRequestHandler):
            """只暴露 /health、/v1/status、/v1/jobs 与手动执行。"""

            def _reply(self, status, payload):
                """status/payload 为响应；按 JSON 返回。"""
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                """无参数；读取状态与任务。"""
                path = urlsplit(self.path).path
                if path == "/health":
                    return self._reply(200, {"ok": True, "service": "self-iteration"})
                if path == "/v1/status":
                    return self._reply(200, {"ok": True, "value": service.scheduler.status()})
                if path == "/v1/jobs":
                    return self._reply(200, {"ok": True, "jobs": service.registry.list()})
                return self._reply(404, {"ok": False, "error": "未找到该路由"})

            def do_POST(self):
                """无参数；手动执行一个任务。"""
                path = urlsplit(self.path).path
                parts = path.strip("/").split("/")
                if len(parts) == 4 and parts[:2] == ["v1", "jobs"] and parts[3] == "run":
                    name = parts[2]
                    try:
                        value = service.scheduler.run(name, wait=False)
                    except KeyError as error:
                        return self._reply(404, {"ok": False, "error": str(error)})
                    except RuntimeError as error:
                        return self._reply(409, {"ok": False, "error": str(error)})
                    return self._reply(202, {"ok": True, "value": value})
                return self._reply(404, {"ok": False, "error": "未找到该路由"})

            def log_message(self, _format, *_args):
                """关闭默认访问日志。"""
                return

        server = ThreadingHTTPServer((self.host, self.port), Handler)
        server.daemon_threads = True
        server.serve_forever()
