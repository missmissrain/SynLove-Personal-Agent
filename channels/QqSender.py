"""功能：QQ 发送器，复用终端服务的主动消息收件箱，不重新实现 QQ 协议。

注册参数baseURL默认 http://127.0.0.1:17864、token为管理令牌；默认 240 秒过期。
本类只负责投递一条已生成文本；发送失败抛 RuntimeError，不重试、不降级。
"""
import time
import urllib.error
import uuid

from services.HttpJson import JsonHttpClient


class QqSender:
    """把文本投递到既有 QQ 收件通道。"""

    def __init__(self, base_url="http://127.0.0.1:17864", token=""):
        """base_url为终端服务地址；token为管理令牌。"""
        self.base_url = base_url.rstrip("/")
        self.client = JsonHttpClient(base=self.base_url, token=token, timeout=10)

    def __call__(self, envelope, text):
        """envelope为消息、text为正文；返回 {ok, id}，失败抛 RuntimeError。"""
        if not isinstance(text, str) or not text.strip():
            raise RuntimeError("QQ 发送正文为空")
        payload = {"id": uuid.uuid4().hex, "text": text.strip()[:160],
                   "expiresAt": time.time() + 240}
        try:
            value = self.client.request_json("POST", "/v1/initiative/text", payload)
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise RuntimeError("QQ 投递失败：" + type(error).__name__)
        if not value.get("ok"):
            raise RuntimeError("QQ 投递被拒绝")
        return {"ok": True, "channel": "qq", "id": payload["id"]}
