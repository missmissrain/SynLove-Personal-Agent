"""把润色好的汇报推到主人 QQ：复用 newsDigest 的官方机器人通道，不新开一条发送路径。

为什么走 QQ 官方接口而不是 harness 的 QQ 网关：官方机器人主动消息是普通 HTTP 调用，
不抢网关的 WebSocket 会话、不影响欣爱正在聊的那条连接；网关掉线时汇报照样能发出去。

注册参数（构造）：
    root 生产根目录；用于定位 tools/qq_notify.py 与它的配置
"""

from __future__ import annotations

import sys
from pathlib import Path

# QQ 主动消息单条长度有限制，超出会被接口拒绝；按段落切，尽量不断句。
MAX_CHARS = 900


class QqReporter:
    """QQ 文本推送器。"""

    def __init__(self, root):
        """root：生产根目录。"""
        self.root = Path(root)
        if str(self.root) not in sys.path:
            sys.path.insert(0, str(self.root))

    def send(self, text):
        """发一条文本，返回 qqPush 的结果 dict。参数 text：要发的内容。"""
        from tools.qq_notify import send_qq_text_message
        return send_qq_text_message(text)

    def send_chunks(self, text):
        """超长时按段落切成多条依次发。参数 text：要发的内容。"""
        parts = split_message(text, MAX_CHARS)
        results = []
        for part in parts:
            results.append(self.send(part))
        return results


def split_message(text, limit=MAX_CHARS):
    """按段落把长文本切成不超过 limit 的块。参数 text 原文；limit 单块字符上限。"""
    value = str(text or '').strip()
    if len(value) <= limit:
        return [value] if value else []
    chunks = []
    current = ''
    for paragraph in value.split('\n'):
        candidate = paragraph if not current else current + '\n' + paragraph
        if len(candidate) <= limit:
            current = candidate
            continue
        if current:
            chunks.append(current)
            current = ''
        while len(paragraph) > limit:
            chunks.append(paragraph[:limit])
            paragraph = paragraph[limit:]
        current = paragraph
    if current:
        chunks.append(current)
    return chunks
