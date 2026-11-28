"""功能：事实层微服务，唯一持有在场、监听、服务在线状态等事实，主进程通过固定 API 读写。

注册参数root为主项目Path、host/port为监听地址；默认只绑 127.0.0.1:8794，不对外网开放。
服务内部只调用各维护类（PresenceFact/ListeningFact/CapabilityTable），不直接读文件。
"""
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from facts.ListeningFact import listening_fact
from facts.PresenceFact import presence_fact
from fleetService.CapabilityTable import CapabilityTable

LOG = logging.getLogger("synlove.facts")


class FactsService:
    """把事实维护类包装成 HTTP API。"""

    def __init__(self, root, host="127.0.0.1", port=8794):
        """root为主项目Path；host/port为监听地址。"""
        self.root = root
        self.host = host
        self.port = int(port)
        self.server = None
        self.presence = presence_fact(root)
        self.listening = listening_fact(root)

    def serve_forever(self):
        """无参数；阻塞运行 HTTP 服务。"""
        service = self

        class Handler(BaseHTTPRequestHandler):
            """仅暴露 /health 与 /v1/facts/*，其他路径一律 404。"""

            def log_message(self, fmt, *args):
                """fmt/args 为标准日志；静默，避免刷屏。"""
                return

            def _reply(self, status, payload):
                """status/payload为响应码与对象；以 UTF-8 JSON 返回。"""
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
                """无参数；读取事实或健康状态。"""
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query)
                if parsed.path == "/health":
                    return self._reply(200, {"ok": True, "service": "facts"})
                if parsed.path == "/v1/facts/presence":
                    value = service.presence.read()
                    ttl = query.get("ttl", [None])[0]
                    if ttl and value:
                        import time
                        try:
                            if time.time() - float(value.get("updatedAt") or 0) > float(ttl):
                                value = {}
                        except (TypeError, ValueError):
                            pass
                    return self._reply(200, {"ok": True, "value": value})
                if parsed.path == "/v1/facts/listening":
                    return self._reply(200, {"ok": True, "value": service.listening.read()})
                if parsed.path == "/v1/facts/activation":
                    runtime = getattr(service, "activation", None)
                    if runtime is None:
                        return self._reply(503, {"ok": False, "error": "主动激活未装配"})
                    return self._reply(200, {"ok": True, "value": runtime.snapshot()})
                if parsed.path == "/v1/facts/services":
                    watchdog = getattr(service, "watchdog", None)
                    if watchdog is None:
                        return self._reply(503, {"ok": False, "error": "看门狗未装配"})
                    return self._reply(200, {"ok": True, "value": watchdog.snapshot()})
                if parsed.path == "/v1/facts/capabilities":
                    return self._reply(200, {"ok": True, "commands": CapabilityTable.COMMANDS,
                                             "aliases": CapabilityTable.ALIASES})
                return self._reply(404, {"ok": False, "error": "未找到该事实"})

            def do_POST(self):
                """无参数；写入事实，body 支持 value 或 section+values。"""
                parsed = urlsplit(self.path)
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > 65536:
                    return self._reply(400, {"ok": False, "error": "请求体无效"})
                try:
                    body = json.loads(self.rfile.read(length).decode("utf-8"))
                except ValueError:
                    return self._reply(400, {"ok": False, "error": "JSON 无效"})
                source = str(body.get("source") or "api")[:40]
                if parsed.path == "/v1/facts/presence":
                    if isinstance(body.get("section"), str) and isinstance(body.get("values"), dict):
                        value = service.presence.update_section(body["section"], body["values"],
                                                                source=source)
                    elif isinstance(body.get("value"), dict):
                        value = service.presence.replace(body["value"], source=source)
                    else:
                        return self._reply(400, {"ok": False, "error": "缺少 value"})
                    return self._reply(200, {"ok": True, "value": value})
                if parsed.path == "/v1/facts/listening":
                    if not isinstance(body.get("value"), dict):
                        return self._reply(400, {"ok": False, "error": "缺少 value"})
                    value = service.listening.replace(body["value"], source=source)
                    return self._reply(200, {"ok": True, "value": value})
                if parsed.path == "/v1/facts/activation/route":
                    runtime = getattr(service, "activation", None)
                    if runtime is None:
                        return self._reply(503, {"ok": False, "error": "主动激活未装配"})
                    value = runtime.fresh_route(body.get("deviceId"))
                    return self._reply(200, {"ok": True, "value": value})
                if parsed.path == "/v1/facts/services/check":
                    watchdog = getattr(service, "watchdog", None)
                    if watchdog is None:
                        return self._reply(503, {"ok": False, "error": "看门狗未装配"})
                    return self._reply(200, {"ok": True, "value": watchdog.check_once()})
                return self._reply(404, {"ok": False, "error": "未找到该事实"})

        self.server = ThreadingHTTPServer((self.host, self.port), Handler)
        self.server.daemon_threads = True
        self.server.serve_forever()

    def start(self):
        """无参数；后台线程启动，返回自身。"""
        thread = threading.Thread(target=self.serve_forever, daemon=True, name="SynLoveFacts")
        thread.start()
        return self
