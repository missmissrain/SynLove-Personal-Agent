"""功能：三通道消息路由（微信 / QQ / 语音），负责入站归一、回复分发与状态记录。

注册参数root为主项目路径、senders为通道发送器字典、agent为可选的推理入口。
本类不实现具体发送与推理：sender 由各通道类注入，agent 由主逻辑注入；缺失时明确报错，不静默降级。
"""
import json
import time
from pathlib import Path

from channels.ChannelState import ChannelState
from channels.MessageEnvelope import MessageEnvelope


class MessageGateway:
    """消息接收与回复的唯一路由点。"""

    def __init__(self, root, senders=None, agent=None):
        """root为主项目Path；senders为 {channel: callable(envelope, text)}；agent为 callable(envelope)->text。"""
        self.root = Path(root)
        self.senders = dict(senders or {})
        self.agent = agent
        self.state = ChannelState(root, "gateway")

    def handle_inbound(self, payload):
        """payload为入站字典；交给 agent 生成回复后再按原通道分发，返回处理结果。"""
        envelope = MessageEnvelope.from_dict(payload)
        started = time.time()
        if self.agent is None:
            raise RuntimeError("消息网关未注入推理入口")
        reply = self.agent(envelope)
        if not isinstance(reply, str) or not reply.strip():
            raise RuntimeError("推理入口未返回文本")
        result = self.dispatch(envelope, reply)
        self._record("inbound", envelope, len(reply), started)
        return {"ok": True, "channel": envelope.channel, "reply": reply, "dispatch": result}

    def dispatch(self, envelope, text):
        """envelope为消息、text为要发送的文本；按通道发送，返回发送结果。"""
        sender = self.senders.get(envelope.channel)
        if sender is None:
            raise RuntimeError("通道未注册发送器：" + envelope.channel)
        value = sender(envelope, text)
        if not isinstance(value, dict) or not value.get("ok"):
            raise RuntimeError("通道发送失败：" + envelope.channel)
        return value

    def dispatch_text(self, channel, target, text, meta=None):
        """channel/target/text 为纯文本外发（主动消息）；返回发送结果。"""
        envelope = MessageEnvelope(channel, sender=target, text=text, meta=meta or {})
        sender = self.senders.get(channel)
        if sender is None:
            raise RuntimeError("通道未注册发送器：" + channel)
        value = sender(envelope, text)
        self._record("outbound", envelope, len(text), time.time())
        return value

    def status(self):
        """无参数；返回网关自身与各通道发送器注册情况。"""
        return {"updatedAt": time.time(),
                "registered": sorted(self.senders.keys()),
                "agent": self.agent is not None,
                "last": self.state.read()}

    def _record(self, direction, envelope, size, started):
        """direction为方向；记录一条脱敏统计，不保存正文。"""
        self.state.update(last={"direction": direction, "channel": envelope.channel,
                                "size": int(size), "session": envelope.session[:32],
                                "elapsedMs": int((time.time() - started) * 1000),
                                "at": time.time()})
