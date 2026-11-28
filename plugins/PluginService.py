"""功能：插件微服务。把插件动作暴露成固定 HTTP API，调用方只认这个端口。

注册参数 root 为主项目 Path、host/port 为监听地址；默认 127.0.0.1:8830。
只做路由与错误封装：动作实现全在各插件类，失败返回明确状态码与原因。
"""
import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

LOG = logging.getLogger("synlove.plugins")

from plugins.PluginRegistry import PluginRegistry


class PluginService:
    """插件动作的唯一 HTTP 入口。"""

    def __init__(self, root, host=None, port=None):
        """root 为主项目 Path；host/port 缺省用 config/plugins.json 的值。"""
        self.registry = PluginRegistry(root)
        self.host = host or self.registry.host
        self.port = int(port or self.registry.port)

    def serve_forever(self):
        """无参数；阻塞运行 HTTP 服务。"""
        service = self

        class Handler(BaseHTTPRequestHandler):
            """只暴露 /health、/v1/plugins 与 /v1/plugins/<name>/<action>。"""

            def log_message(self, fmt, *args):
                """静默访问日志。"""
                return

            def _reply(self, status, payload):
                """status/payload 为响应；UTF-8 JSON。"""
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                try:
                    LOG.info("%s %s -> %d", self.command, urlsplit(self.path).path,
                             int(status))
                except Exception:
                    pass
                self.end_headers()
                try:
                    self.wfile.write(body)
                except OSError:
                    pass

            def do_GET(self):
                """无参数；健康检查与插件目录。"""
                path = urlsplit(self.path).path
                if path == "/health":
                    return self._reply(200, {"ok": True, "service": "plugins",
                                             "count": len(service.registry.plugins)})
                if path == "/v1/plugins":
                    return self._reply(200, {"ok": True, "value": service.registry.catalog()})
                return self._reply(404, {"ok": False, "error": "未找到该路由"})

            def do_POST(self):
                """无参数；调用某个插件动作，body 为该动作的参数。"""
                parsed = urlsplit(self.path)
                parts = [part for part in parsed.path.strip("/").split("/") if part]
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 1048576:
                    return self._reply(400, {"ok": False, "error": "请求体无效"})
                try:
                    body = json.loads(self.rfile.read(length).decode("utf-8"))
                except ValueError:
                    return self._reply(400, {"ok": False, "error": "JSON 无效"})
                if len(parts) != 4 or parts[0] != "v1" or parts[1] != "plugins":
                    return self._reply(404, {"ok": False, "error": "未找到该路由"})
                plugin = service.registry.get(parts[2])
                if plugin is None:
                    return self._reply(404, {"ok": False, "error": "未登记插件：" + parts[2]})
                try:
                    value = plugin.call(parts[3], body if isinstance(body, dict) else {})
                except KeyError as error:
                    return self._reply(400, {"ok": False, "error": str(error)[:160]})
                except ValueError as error:
                    return self._reply(400, {"ok": False, "error": str(error)[:160]})
                except RuntimeError as error:
                    return self._reply(503, {"ok": False, "error": str(error)[:200]})
                except Exception as error:  # noqa: BLE001
                    return self._reply(500, {"ok": False,
                                             "error": type(error).__name__ + ": "
                                                      + str(error)[:160]})
                return self._reply(200, {"ok": True, "plugin": parts[2], "action": parts[3],
                                         "value": value})

        server = ThreadingHTTPServer((self.host, self.port), Handler)
        server.daemon_threads = True
        server.serve_forever()

    def start(self):
        """无参数；后台线程启动，返回自身。"""
        import threading
        threading.Thread(target=self.serve_forever, daemon=True, name="SynLovePlugins").start()
        return self
