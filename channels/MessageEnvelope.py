"""功能：跨通道消息的统一信封，接收与发送共用同一结构。

注册参数无；字段固定为 channel/sender/session/text/media/reply/meta。
本类只做序列化与校验，不发送、不推理；未知通道直接拒绝，避免静默丢消息。
"""
import time

CHANNELS = ("weixin", "qq", "voice")


class MessageEnvelope:
    """一条消息的统一表示。"""

    SLOTS = ("channel", "sender", "session", "text", "media", "reply", "meta")

    def __init__(self, channel, sender="", text="", session="", media=None,
                 reply="", meta=None):
        """channel为通道名；sender/session为来源与会话；text/media为内容；reply为已生成回复。"""
        if channel not in CHANNELS:
            raise ValueError("未知通道：" + str(channel))
        if not isinstance(text, str):
            raise ValueError("消息正文必须为字符串")
        self.channel = channel
        self.sender = str(sender or "")
        self.session = str(session or "")
        self.text = text
        self.media = media if isinstance(media, dict) else None
        self.reply = str(reply or "")
        self.meta = meta if isinstance(meta, dict) else {}
        self.createdAt = time.time()

    def to_dict(self):
        """无参数；返回可传输的字典。"""
        return {"channel": self.channel, "sender": self.sender, "session": self.session,
                "text": self.text, "media": self.media, "reply": self.reply,
                "meta": self.meta, "createdAt": self.createdAt}

    @classmethod
    def from_dict(cls, value):
        """value为入站字典；返回信封，字段缺失时抛 ValueError。"""
        if not isinstance(value, dict):
            raise ValueError("消息必须为对象")
        channel = value.get("channel")
        if channel not in CHANNELS:
            raise ValueError("未知通道：" + str(channel))
        return cls(channel, value.get("sender", ""), value.get("text", ""),
                   value.get("session", ""), value.get("media"),
                   value.get("reply", ""), value.get("meta") or {})
