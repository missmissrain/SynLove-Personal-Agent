"""本机语音会话 HTTP 网关。

设备只需要提交一段音频和设备/会话标识；网关不保存设备连接状态，
也不绑定固定终端，未来可由终端连接仓库或 VPS 代理转发。
"""

import json
import base64
import os
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from voice.voicePipeline import VoicePipeline
from voiceRouting.AudioRouteDelivery import AudioRouteDelivery


class VoiceGateway:
    """提供回环 HTTP 语音入口和健康检查。"""

    def __init__(self, host="127.0.0.1", port=8812, pipeline=None, token=None, activity=None,
                 initiative=None, audio_router=None, listening_router=None):
        """host/port为监听地址；pipeline为流水线，token为鉴权，activity记录占用，initiative提供只读状态。"""
        self.host = host
        self.port = int(port)
        self.pipeline = pipeline or VoicePipeline()
        self.token = token if token is not None else os.environ.get("SYNLOVE_VOICE_GATEWAY_TOKEN", "")
        self.activity, self.initiative = activity, initiative
        self.audio_router = audio_router
        self.listening_router = listening_router

    def serve_forever(self):
        """无参数；启动网关并持续处理 /health 与 /v1/voice/turn。"""
        pipeline = self.pipeline
        expected_token = self.token
        activity, initiative = self.activity, self.initiative
        audio_router = self.audio_router
        listening_router = self.listening_router
        delivery = AudioRouteDelivery(audio_router, pipeline) if audio_router is not None else None

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

            def _json_voice_result(self, result):
                """result为语音流水线结果；把音频文件转换为可跨终端传输的Base64字段。"""
                result = dict(result)
                if result.get("audioPath"):
                    path = Path(result["audioPath"])
                    result["audioBase64"] = base64.b64encode(path.read_bytes()).decode("ascii")
                    result.pop("audioPath", None)
                segments = []
                for item in result.get("audioSegments") or []:
                    segment = dict(item)
                    if segment.get("audioPath"):
                        path = Path(segment["audioPath"])
                        segment["audioBase64"] = base64.b64encode(
                            path.read_bytes()).decode("ascii")
                        segment.pop("audioPath", None)
                    segments.append(segment)
                if "audioSegments" in result:
                    result["audioSegments"] = segments
                return result

            def _write_stream_event(self, event):
                """event为一条NDJSON事件；立即写出并刷新，避免确认语音等待最终任务。"""
                body = (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")
                self.wfile.write(body)
                self.wfile.flush()

            def do_GET(self):
                """处理健康检查请求。"""
                if self.path == "/v1/audio/route" and audio_router is not None:
                    if self.headers.get("Origin") or (expected_token and self.headers.get(
                            "Authorization", "") != "Bearer " + expected_token):
                        self._reply(403, {"ok": False})
                        return
                    try:
                        self._reply(200, audio_router.handle_request({"action": "status"}))
                    except Exception as error:
                        self._reply(503, {"ok": False, "errorType": type(error).__name__})
                    return
                if self.path == "/v1/audio/listening" and listening_router is not None:
                    if self.headers.get("Origin") or (expected_token and self.headers.get(
                            "Authorization", "") != "Bearer " + expected_token):
                        self._reply(403, {"ok": False})
                        return
                    self._reply(200, listening_router.handle_request({"action": "status"}))
                    return
                if self.path == "/v1/initiative/status" and initiative is not None:
                    if self.headers.get("Origin") or (expected_token and self.headers.get(
                            "Authorization", "") != "Bearer " + expected_token):
                        self._reply(403, {"ok": False})
                        return
                    self._reply(200, {"ok": True, **dict(initiative.status)})
                    return
                if self.path == "/health":
                    self._reply(200, {"ok": True, "service": "voice-gateway"})
                    return
                self._reply(404, {"ok": False, "error": "路径不存在"})

            def do_POST(self):
                """接收原始音频字节并运行一轮语音流水线。"""
                if self.path == "/v1/audio/route" and audio_router is not None:
                    if (self.headers.get("Origin") or (expected_token and self.headers.get(
                            "Authorization", "") != "Bearer " + expected_token)):
                        self._reply(403, {"ok": False})
                        return
                    try:
                        length = int(self.headers.get("Content-Length", "0"))
                        if not 0 < length <= 8192:
                            raise ValueError("音频路由请求大小无效")
                        body = json.loads(self.rfile.read(length))
                        if not isinstance(body, dict):
                            raise ValueError("音频路由请求必须为对象")
                        value = (delivery.deliver_reply(body) if body.get("action") == "speak"
                                 else audio_router.handle_request(body))
                        if body.get("askIfUncertain") is True and "route" in value:
                            value["clarification"] = audio_router.ask_target(value["route"])
                        self._reply(200, value)
                    except ValueError as error:
                        self._reply(400, {"ok": False, "error": str(error)[:160]})
                    except Exception as error:
                        self._reply(503, {"ok": False, "errorType": type(error).__name__})
                    return
                if self.path == "/v1/audio/listening" and listening_router is not None:
                    if (self.headers.get("Origin") or (expected_token and self.headers.get(
                            "Authorization", "") != "Bearer " + expected_token)):
                        self._reply(403, {"ok": False})
                        return
                    try:
                        length = int(self.headers.get("Content-Length", "0"))
                        if not 0 < length <= 4096:
                            raise ValueError("监听请求大小无效")
                        body = json.loads(self.rfile.read(length))
                        self._reply(200, listening_router.handle_request(body))
                    except ValueError as error:
                        self._reply(400, {"ok": False, "error": str(error)[:160]})
                    return
                if self.path == "/v1/voice/turn/stream":
                    self._handle_voice_stream()
                    return
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
                    if activity is not None:
                        activity.set()
                    result = pipeline.process_audio(input_path, session_id, device_id,
                                                    follow_up=self.headers.get("X-Follow-Up") == "1")
                    self._reply(200, self._json_voice_result(result))
                except Exception as error:
                    self._reply(500, {"ok": False, "errorType": type(error).__name__, "error": str(error)[:240]})
                finally:
                    if activity is not None:
                        activity.clear()

            def _handle_voice_stream(self):
                """接收音频并以NDJSON先回确认事件，再回最终任务结果。"""
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
                    events = queue.Queue()
                    finished = object()

                    def on_event(event):
                        """event为主人格确认或确认TTS事件；转换音频后放入发送队列。"""
                        item = dict(event)
                        if item.get("audioPath"):
                            path = Path(item["audioPath"])
                            item["audioBase64"] = base64.b64encode(path.read_bytes()).decode("ascii")
                            item.pop("audioPath", None)
                        events.put(item)

                    def run_pipeline():
                        """后台继续执行主人格任务并在完成后推送最终回复。"""
                        try:
                            result = pipeline.process_audio(
                                input_path, session_id, device_id,
                                follow_up=self.headers.get("X-Follow-Up") == "1",
                                on_event=on_event,
                            )
                            events.put({"type": "final", "result": self._json_voice_result(result)})
                        except Exception as error:
                            events.put({
                                "type": "error",
                                "errorType": type(error).__name__,
                                "error": str(error)[:240],
                            })
                        finally:
                            events.put(finished)
                            if activity is not None:
                                activity.clear()

                    if activity is not None:
                        activity.set()
                    worker = threading.Thread(target=run_pipeline, daemon=True,
                                              name="SynLoveVoiceStream")
                    worker.start()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    while True:
                        event = events.get()
                        if event is finished:
                            break
                        self._write_stream_event(event)
                except ValueError as error:
                    self._reply(400, {"ok": False, "error": str(error)[:160]})
                except (BrokenPipeError, ConnectionResetError):
                    if activity is not None:
                        activity.clear()
                except Exception as error:
                    try:
                        self._reply(500, {"ok": False, "errorType": type(error).__name__})
                    except Exception:
                        pass

            def log_message(self, _format, *_args):
                """关闭默认访问日志，避免把音频请求内容写入控制台。"""
                return

        server = ThreadingHTTPServer((self.host, self.port), Handler)
        server.serve_forever()
