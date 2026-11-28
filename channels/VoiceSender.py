"""功能：语音通道发送器，把已生成文本交给语音网关合成并播放，不重复实现 TTS。

注册参数baseURL默认 127.0.0.1:8812；默认走既有 /v1/audio/route 的 speak 动作。
失败抛 RuntimeError，由网关统一上报，不做重试与改投。
"""
import urllib.error

from services.HttpJson import JsonHttpClient


class VoiceSender:
    """语音外发：文本 → TTS → 路由播放。"""

    def __init__(self, base_url="http://127.0.0.1:8812", timeout=90.0):
        """base_url为语音网关地址；timeout为整段合成与播放的等待秒数。"""
        self.base_url = base_url.rstrip("/")
        self.client = JsonHttpClient(base=self.base_url, timeout=timeout)

    def __call__(self, envelope, text):
        """envelope为消息、text为正文；返回播放回执，失败抛 RuntimeError。"""
        body = {"action": "speak", "text": str(text or "").strip()[:160],
                "emotion": (envelope.meta or {}).get("emotion", "neutral")}
        if not body["text"]:
            raise RuntimeError("语音正文为空")
        try:
            value = self.client.request_json("POST", "/v1/audio/route", body)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:160]
            raise RuntimeError("语音投送失败：HTTP %d %s" % (error.code, detail))
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise RuntimeError("语音投送失败：" + type(error).__name__)
        if not value.get("ok"):
            raise RuntimeError("语音投送被拒绝：" + str(value.get("state") or "")[:40])
        return {"ok": True, "channel": "voice", "state": value.get("state"),
                "target": (value.get("route") or {}).get("target")}
