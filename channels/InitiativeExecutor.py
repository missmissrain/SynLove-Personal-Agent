"""功能：消息层的主动投递执行器。只负责把事实层的判断变成文字或语音，不再做判断。

注册参数 root 为主项目 Path、pipeline 为语音流水线；terminal/audio_router 可注入测试。
投递前会回问事实层最新路由，不一致就丢弃这条过时语音；失败直接报错。
"""
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

from screenInitiative.screenTerminal import ScreenTerminal
from voiceRouting.DeliveryGuard import DeliveryGuard


class InitiativeExecutor:
    """消息层唯一的主动投递出口。"""

    def __init__(self, root, pipeline, terminal=None, audio_router=None):
        """root 为主项目 Path；pipeline 为语音流水线；terminal 为终端适配器。"""
        self.root = Path(root)
        self.pipeline = pipeline
        self.audio_router = audio_router
        path = self.root / "config" / "screenInitiative.json"
        config = json.loads(path.read_text("utf-8-sig")) if path.is_file() else {}
        self.terminal = terminal or ScreenTerminal(self.root, config)
        self.facts = os.environ.get("SYNLOVE_FACTS_URL", "http://127.0.0.1:8802").rstrip("/")

    @property
    def status(self):
        """无参数；读取事实层的主动激活状态，供 /v1/initiative/status 透传。"""
        try:
            with _opener().open(self.facts + "/v1/facts/activation", timeout=3) as response:
                return json.loads(response.read().decode("utf-8")).get("value") or {}
        except Exception as error:  # noqa: BLE001
            return {"state": "factsUnavailable", "errorType": type(error).__name__}

    def deliver(self, request):
        """request 含 mode/text/deviceId/ident/expiresAt/route；返回最终投递状态。"""
        mode = str(request.get("mode") or "")
        text = str(request.get("text") or "")
        ident = str(request.get("ident") or "")
        expires = float(request.get("expiresAt") or 0)
        if not text.strip() or not ident:
            raise ValueError("投递请求缺少 text 或 ident")
        if mode == "qq":
            self.terminal.queue_text(ident, text, expires)
            return {"state": "textQueued", "channel": "qq"}
        if mode != "tts":
            raise ValueError("不支持的投递方式：" + mode)
        device = str(request.get("deviceId") or "")
        route = request.get("route") or {}
        result = self.pipeline.process_reply(
            {"text": text, "ttsEmotion": request.get("emotion") or "neutral"},
            session_id="screenInitiative", device_id=device)
        output = Path(result["audioPath"])
        try:
            if time.time() >= expires:
                return {"state": "speechExpired", "channel": "tts"}
            guard = DeliveryGuard.make(route, lambda: self._fresh_route(device))
            self.terminal.play_audio(route["target"], ident, output.read_bytes(), expires, guard,
                                     require_active=self.audio_router is None)
            return {"state": "spoken", "channel": "tts", "outputDevice": route.get("target")}
        finally:
            target = output.resolve()
            target.relative_to((self.root / "runtime/voice").resolve())
            target.unlink(missing_ok=True)

    def _fresh_route(self, device):
        """device 为观察设备；回问事实层最新路由，失败返回空字典（复核会判为不一致）。"""
        body = json.dumps({"deviceId": device}, ensure_ascii=False).encode("utf-8")
        try:
            with _opener().open(self.facts + "/v1/facts/activation/route", data=body,
                                timeout=5) as response:
                return json.loads(response.read().decode("utf-8")).get("value") or {}
        except Exception:  # noqa: BLE001
            return {}


def _opener():
    """无参数；返回绕过系统代理的本机请求器。"""
    return build_opener(ProxyHandler({}))
