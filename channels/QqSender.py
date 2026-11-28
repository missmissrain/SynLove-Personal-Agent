"""功能：QQ 发送器。有入站 msgId 时走本机 QQ 管理口的被动回复，否则走终端主动消息收件箱。

注册参数 base_url 默认终端服务、token 为管理令牌、admin_url 为本机 QQ 发送口；
被动回复最多 1000 字，主动消息最多 160 字。失败抛 RuntimeError，不重试、不降级。
"""
import time
import urllib.error
import uuid

from services.HttpJson import JsonHttpClient


class QqSender:
    """把文本投递到 QQ：优先被动回复，没有 msgId 时退回主动消息。"""

    def __init__(self, base_url="http://127.0.0.1:17864", token="",
                 admin_url="http://127.0.0.1:3083"):
        """base_url 为终端服务地址；token 为管理令牌；admin_url 为 QQ 本机发送口。"""
        self.base_url = str(base_url or "http://127.0.0.1:17864").rstrip("/")
        self.admin_url = str(admin_url or "").rstrip("/")
        self.client = JsonHttpClient(base=self.base_url, token=token, timeout=10)

    def __call__(self, envelope, text):
        """envelope 为消息、text 为正文；返回 {ok, id}，失败抛 RuntimeError。"""
        if not isinstance(text, str) or not text.strip():
            raise RuntimeError("QQ 发送正文为空")
        meta = getattr(envelope, "meta", {}) or {}
        target = str(getattr(envelope, "sender", "") or "").strip()
        msg_id = str(meta.get("msgId") or "").strip()
        if msg_id and self.admin_url:
            return self._reply_passive(meta, target, msg_id, text)
        return self._send_initiative(target, text)

    def _reply_passive(self, meta, target, msg_id, text):
        """meta/target/msg_id/text 为被动回复参数；返回回执，失败抛 RuntimeError。"""
        body = {"text": text.strip()[:1000], "msgId": msg_id,
                "target": meta.get("target") or {"userOpenid": target}}
        admin = JsonHttpClient(base=self.admin_url, timeout=20)
        try:
            value = admin.request_json("POST", "/send", body)
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise RuntimeError("QQ 被动回复失败：" + type(error).__name__)
        if not value.get("ok"):
            raise RuntimeError("QQ 被动回复失败：" + str(value.get("error") or "")[:120])
        return {"ok": True, "channel": "qq", "id": msg_id, "mode": "passive"}

    def _send_initiative(self, target, text):
        """target 为收件人、text 为正文；走终端主动消息收件箱。"""
        payload = {"id": uuid.uuid4().hex, "text": text.strip()[:160],
                   "expiresAt": time.time() + 240}
        if target:
            payload["user_id"] = target
        try:
            value = self.client.request_json("POST", "/v1/initiative/text", payload)
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise RuntimeError("QQ 投递失败：" + type(error).__name__)
        if not value.get("ok"):
            raise RuntimeError("QQ 投递被拒绝")
        return {"ok": True, "channel": "qq", "id": payload["id"], "mode": "active"}
