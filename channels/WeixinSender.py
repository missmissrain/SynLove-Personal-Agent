"""功能：微信通道发送器，通过 Harness 本机管理口把文本排队进既有 outbox，不重复实现 iLink 协议。

注册参数 base_url 默认 http://127.0.0.1:3081、timeout 默认 20 秒；默认走 /admin/send-text。
失败抛 RuntimeError 并保留管理口返回的原因；不重试、不改道、不伪造成功回执。
"""

import urllib.error

from services.HttpJson import JsonHttpClient


class WeixinSender:
    """微信外发：文本 → Harness outbox → iLink。"""

    def __init__(self, base_url="http://127.0.0.1:3081", timeout=20.0):
        """base_url 为 Harness 注入口地址；timeout 为管理动作等待秒数。"""
        self.base_url = str(base_url or "http://127.0.0.1:3081").rstrip("/")
        self.client = JsonHttpClient(base=self.base_url, timeout=timeout)

    def __call__(self, envelope, text):
        """envelope 为消息、text 为正文；返回投递回执，失败抛 RuntimeError。"""
        body = str(text or "").strip()
        if not body:
            raise RuntimeError("微信正文为空")
        payload = {"text": body[:1000]}
        target = str(getattr(envelope, "sender", "") or "").strip()
        if target:
            payload["user_id"] = target
        try:
            value = self.client.request_json("POST", "/admin/send-text", payload)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:200]
            raise RuntimeError("微信投递失败：HTTP %d %s" % (error.code, detail))
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise RuntimeError("微信投递失败：" + type(error).__name__)
        status = str(value.get("status") or "")
        if status.startswith("failed"):
            raise RuntimeError("微信投递失败：" + str(value.get("error") or status)[:120])
        return {"ok": True, "channel": "weixin", "id": value.get("outbound_id"),
                "state": status or "queued", "target": value.get("user_id")}
