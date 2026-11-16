"""本机语音会话 HTTP 网关。

设备只需要提交一段音频和设备/会话标识；网关不保存设备连接状态，
也不绑定固定终端，未来可由终端连接仓库或 VPS 代理转发。
"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from voice.voicePipeline import VoicePipeline


class VoiceGateway:
    """提供回环 HTTP 语音入口和健康检查。"""

    def __init__(self, host="127.0.0.1", port=8812, pipeline=None, token=None):
        """host、port 为监听地址；pipeline 为语音流水线；token 可选用于终端转发鉴权。"""
        self.host = host
        self.port = int(port)
        self.pipeline = pipeline or VoicePipeline()
        self.token = token if token is not None else os.environ.get("SYNLOVE_VOICE_GATEWAY_TOKEN", "")

    def serve_forever(self):
        """无参数；启动网关并持续处理 /health 与 /v1/voice/turn。"""
        pipeline = self.pipeline
        expected_token = self.token

        class Handler(BaseHTTPRequestHandler):
            """处理本机语音网关请求。"""

            def _reply(self, status, payload):
                """status 为 HTTP 状态码；payload 为可 JSON 序列化对象。"""
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                """处理健康检查请求。"""
                if self.path == "/health":
                    self._reply(200, {"ok": True, "service": "voice-gateway"})
                    return
                self._reply(404, {"ok": False, "error": "路径不存在"})

            def do_POST(self):
                """接收原始音频字节并运行一轮语音流水线。"""
                if self.path != "/v1/voice/turn":
                    self._reply(404, {"ok": False, "error": "路径不存在"})
                    return
                if expected_token and self.headers.get("Authorization", "") != "Bearer " + expected_token:
                    self._reply(401, {"ok": False, "error": "鉴权失败"})
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if length <= 0 or length > 32 * 1024 * 1024:
                        raise ValueError("音频大小必须在 1B 到 32MiB 之间")
                    data = self.rfile.read(length)
                    session_id = self.headers.get("X-Session-Id", "default")
                    device_id = self.headers.get("X-Device-Id", "local")
                    suffix = Path(self.headers.get("X-Audio-Name", "input.wav")).suffix or ".wav"
                    input_path = pipeline.store.save_input(data, session_id, suffix)
                    result = pipeline.process_audio(input_path, session_id, device_id)
                    self._reply(200, result)
                except Exception as error:
                    self._reply(500, {"ok": False, "errorType": type(error).__name__, "error": str(error)[:240]})

            def log_message(self, _format, *_args):
                """关闭默认访问日志，避免把音频请求内容写入控制台。"""
                return

        server = ThreadingHTTPServer((self.host, self.port), Handler)
        server.serve_forever()
