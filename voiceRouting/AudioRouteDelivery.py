"""功能：将主人格的短回复以固定音色投送到统一路由选定的设备，或通过QQ澄清。

注册参数routes为统一路由服务、pipeline为既有固定音色流水线；默认最长120秒有效。
不接受自定义音色、音频URL或输出路径，播放前再次确认目标和授权没有变化。
"""
import json
import threading
import time
import uuid
from pathlib import Path

from voiceRouting.DeliveryGuard import DeliveryGuard


class AudioRouteDelivery:
    """为文本通道工具、后续主动行为提供相同的语音投送入口和真实播放回执。"""

    def __init__(self, routes, pipeline):
        """routes提供设备证据与设置，pipeline固定参考声；串行槽避免同时多段播音。"""
        self.routes, self.pipeline = routes, pipeline
        self.lock = threading.Lock()

    def deliver_reply(self, body):
        """body含text/emotion；短回复最多160字，保留每轮情绪，拒绝声线覆盖。"""
        if (set(body) - {"action", "text", "emotion"} or not isinstance(body.get("text"), str)
                or not 1 <= len(body["text"].strip()) <= 160
                or body.get("emotion", "neutral") not in
                ("neutral", "happy", "gentle", "concerned", "sad", "excited")):
            raise ValueError("短语音只接受1至160字正文和情绪代码")
        if not self.lock.acquire(blocking=False):
            raise RuntimeError("上一段语音尚在投送，不要重复提交")
        ident, output, route = uuid.uuid4().hex, None, {}
        try:
            snapshot = self.routes.read_snapshot()
            terminal = snapshot[1]
            route = self.routes.resolve_route(purpose="reply", snapshot=snapshot)
            expires = time.time() + 120
            if route["mode"] != "tts":
                clarification = self.routes.ask_target(route, terminal)
                terminal.queue_text(ident, body["text"].strip(), expires)
                value = {"ok": True, "state": "textQueued", "route": route,
                         "clarification": clarification}
            else:
                result = self.pipeline.process_reply(
                    {"text": body["text"], "ttsEmotion": body.get("emotion", "neutral")},
                    session_id="audioRoute", device_id=route["target"])
                output = Path(result["audioPath"])
                still_suitable = DeliveryGuard.make(
                    route, lambda: self.routes.resolve_route(purpose="reply"))
                receipt = terminal.play_audio(route["target"], ident, output.read_bytes(), expires,
                                              still_suitable, require_active=False)
                if not receipt.get("remotePlaybackCompleted"):
                    raise RuntimeError("终端没有确认语音播放完成")
                value = {"ok": True, "state": "played", "route": route, **receipt}
            self.record_delivery(ident, value["state"], route)
            return value
        except Exception:
            self.record_delivery(ident, "failed", route)
            raise
        finally:
            try:
                if output is not None:
                    output.resolve().relative_to((self.routes.root / "runtime/voice").resolve())
                    output.unlink(missing_ok=True)
            finally:
                self.lock.release()

    def record_delivery(self, ident, state, route):
        """ident/state/route记录投送状态，不保存正文、声音或私人画面。"""
        path = self.routes.root / "runtime/voiceRouting/delivery.jsonl"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as out:
                out.write(json.dumps({"id": ident, "at": time.time(), "state": state,
                                      "target": route.get("target"), "mode": route.get("mode"),
                                      "reason": route.get("reason")}) + "\n")
        except OSError:
            pass
