"""功能：消息网关微服务，三个通道统一从端口收消息、统一从端口发回复。

注册参数root、host/port、agent为推理入口、senders为通道发送器；默认关闭，需在 config/channels.json 显式开启。
本服务只做路由与协议转换；发送与推理都委托给注入的实现，缺任何一方都直接报错。
"""
import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from channels.MessageGateway import MessageGateway


class GatewayService:
    """HTTP 入口：/v1/inbound/{channel}、/v1/outbound、/v1/status。"""

    def __init__(self, root, host="127.0.0.1", port=8805, senders=None, agent=None):
        """root为主项目Path；senders/agent为注入的发送器与推理入口。"""
        self.root = Path(root)
        self.host = host
        self.port = int(port)
        self.gateway = MessageGateway(root, senders=senders, agent=agent)

    def serve_forever(self):
        """无参数；阻塞运行。"""
        service = self

        class Handler(BaseHTTPRequestHandler):
            """只暴露固定路由。"""

            def log_message(self, fmt, *args):
                """静默访问日志，避免刷屏。"""
                return

            def _reply(self, status, payload):
                """status/payload为响应；UTF-8 JSON。"""
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except OSError:
                    pass

            def do_GET(self):
                """无参数；健康检查与状态。"""
                path = urlsplit(self.path).path
                if path == "/health":
                    return self._reply(200, {"ok": True, "service": "message-gateway"})
                if path == "/v1/status":
                    return self._reply(200, {"ok": True, "value": service.gateway.status()})
                return self._reply(404, {"ok": False, "error": "未找到该路由"})

            def do_POST(self):
                """无参数；入站消息与主动外发。"""
                parsed = urlsplit(self.path)
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 262144:
                    return self._reply(400, {"ok": False, "error": "请求体无效"})
                try:
                    body = json.loads(self.rfile.read(length).decode("utf-8"))
                except ValueError:
                    return self._reply(400, {"ok": False, "error": "JSON 无效"})
                try:
                    if parsed.path == "/v1/inbound/voice":
                        inbound = getattr(service.gateway, "voice_inbound", None)
                        if inbound is None:
                            return self._reply(501, {"ok": False, "error": "语音入站未装配"})
                        raw = base64.b64decode(body.get("audioBase64") or "")
                        value = inbound.transcribe_and_reply(
                            raw, body.get("session", ""), body.get("device", ""),
                            body.get("name", "input.wav"))
                        return self._reply(200, {"ok": True, "channel": "voice", "value": value})
                    if parsed.path.startswith("/v1/inbound/"):
                        channel = parsed.path.rsplit("/", 1)[-1]
                        body["channel"] = channel
                        value = service.gateway.handle_inbound(body)
                        return self._reply(200, value)
                    if parsed.path == "/v1/outbound":
                        value = service.gateway.dispatch_text(body.get("channel"),
                                                              body.get("target", ""),
                                                              body.get("text", ""),
                                                              body.get("meta"))
                        return self._reply(200, {"ok": True, "dispatch": value})
                    return self._reply(404, {"ok": False, "error": "未找到该路由"})
                except (ValueError, RuntimeError) as error:
                    return self._reply(400, {"ok": False, "error": str(error)[:160]})
                except Exception as error:
                    return self._reply(500, {"ok": False, "error": type(error).__name__})

        server = ThreadingHTTPServer((self.host, self.port), Handler)
        server.daemon_threads = True
        server.serve_forever()

    def start(self):
        """无参数；后台线程启动。"""
        threading.Thread(target=self.serve_forever, daemon=True, name="SynLoveGateway").start()
        return self
