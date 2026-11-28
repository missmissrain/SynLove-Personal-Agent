"""功能：封装流式 ASR 的 WebSocket 客户端，并为旧文件上传 ASR 提供回退。

注册参数 url 为 ws/wss 地址；chunk_ms 默认 600；language 默认 zh；timeout_seconds 默认 30。
该类只处理音频帧、partial/final 事件和连接错误，不保存原始音频，不改变模型权重。
"""

import json
import time


class StreamingAsrClient:
    """可选的实时 ASR 客户端，协议与 services/StreamingAsrServer.py 对齐。"""

    def __init__(self, url, chunk_ms=600, language="zh", timeout_seconds=30):
        """url 为 WebSocket 地址；chunk_ms 为单帧毫秒数；language 为语言；
        timeout_seconds 为整体超时。"""
        self.url = str(url or "")
        self.chunk_ms = int(chunk_ms)
        self.language = str(language or "zh")
        self.timeout_seconds = float(timeout_seconds)

    def available(self):
        """无参数；返回是否配置了地址且安装了 websocket-client。"""
        if not self.url:
            return False
        try:
            import websocket  # noqa: F401
            return True
        except Exception:
            return False

    def transcribe(self, frames, sample_rate=16000, on_partial=None, on_final=None):
        """frames 为可迭代 PCM 帧；sample_rate 为采样率；
        on_partial/on_final 接收脱敏文本事件；返回最终转写结果。"""
        if not self.available():
            raise RuntimeError("流式ASR未配置或缺少websocket-client")
        import websocket

        started = time.monotonic()
        ws = websocket.create_connection(self.url, timeout=self.timeout_seconds)
        self._wait_ready(ws, self.timeout_seconds)
        partial = ""
        final_text = ""
        try:
            init = {
                "mode": "2pass",
                "wav_name": "synlove-live",
                "is_speaking": True,
                "chunk_size": [0, 10, 5],
                "chunk_interval": 10,
                "audio_fs": int(sample_rate),
                "itn": True,
                "language": self.language,
            }
            ws.send(json.dumps(init, ensure_ascii=False))
            for frame in frames:
                if not frame:
                    continue
                ws.send(frame, opcode=websocket.ABNF.OPCODE_BINARY)
                for text, is_final in self._drain(ws, 0.02):
                    if is_final:
                        final_text = text
                        if on_final:
                            on_final({"text": text, "elapsedSeconds": time.monotonic() - started})
                    elif text != partial:
                        partial = text
                        if on_partial:
                            on_partial({"text": text,
                                        "elapsedSeconds": time.monotonic() - started})
            ws.send(json.dumps({"is_speaking": False}, ensure_ascii=False))
            deadline = time.monotonic() + self.timeout_seconds
            while time.monotonic() < deadline:
                for text, is_final in self._drain(ws, 0.2):
                    if text:
                        final_text = text
                        if on_final:
                            on_final({"text": text,
                                      "elapsedSeconds": time.monotonic() - started})
                    if is_final:
                        return {"text": final_text, "streaming": True,
                                "elapsedSeconds": round(time.monotonic() - started, 4)}
                if final_text:
                    break
            return {"text": final_text, "streaming": True,
                    "elapsedSeconds": round(time.monotonic() - started, 4)}
        finally:
            try:
                ws.close()
            except Exception:
                pass

    def warm(self, timeout=30):
        """timeout 为最长等待；连接服务并等到模型 ready，返回是否就绪。"""
        if not self.available():
            return False
        import websocket
        ws = None
        try:
            ws = websocket.create_connection(self.url, timeout=float(timeout))
            return self._wait_ready(ws, timeout)
        except Exception:
            return False
        finally:
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass

    def _wait_ready(self, ws, timeout):
        """ws 为连接；等待服务端 {"ready": true}，超时返回 False。"""
        import websocket
        ws.settimeout(float(timeout))
        try:
            data = ws.recv()
        except websocket.WebSocketTimeoutException:
            return False
        except Exception:
            return False
        if not isinstance(data, str):
            return False
        try:
            event = json.loads(data)
        except ValueError:
            return False
        return bool(event.get("ready"))

    def _drain(self, ws, timeout):
        """ws 为连接；timeout 为单次读取等待；返回已收到的 (text, is_final) 列表。"""
        import websocket

        events = []
        ws.settimeout(timeout)
        while True:
            try:
                data = ws.recv()
            except websocket.WebSocketTimeoutException:
                break
            except Exception:
                break
            if not data:
                break
            if isinstance(data, bytes):
                continue
            try:
                event = json.loads(data)
            except ValueError:
                continue
            text = str(event.get("text") or event.get("result") or "").strip()
            is_final = bool(event.get("is_final") or event.get("mode") in
                            ("2pass-final", "2pass-offline"))
            if text or is_final:
                events.append((text, is_final))
        return events
