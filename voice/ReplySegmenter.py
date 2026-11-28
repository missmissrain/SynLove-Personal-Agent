"""功能：把主人格回复切成适合首段优先合成的中文语句。

注册参数max_chars默认80；切分只处理文本，不改变本轮TTS情绪、音色参考声、seed或cfgScale。
该类避免拆开数字、时间和过短片段，供非流式 TTS 的首段优先回传使用。
"""

import re


class ReplySegmenter:
    """生成稳定、可播放的中文回复分段。"""

    def __init__(self, max_chars=80, min_chars=8):
        """max_chars为单段最大字符数；min_chars为合并短片段的最小长度。"""
        self.max_chars = max(16, int(max_chars))
        self.min_chars = max(1, int(min_chars))

    def split(self, text):
        """text为主人格完整回复；返回按自然标点切出的非空文本列表。"""
        value = re.sub(r"\s+", " ", str(text or "")).strip()
        if not value:
            return []
        pieces = [part.strip() for part in re.split(r"(?<=[。！？；!?;])", value) if part.strip()]
        result = []
        buffer = ""
        for piece in pieces:
            if len(piece) > self.max_chars:
                if buffer:
                    result.append(buffer)
                    buffer = ""
                while len(piece) > self.max_chars:
                    result.append(piece[:self.max_chars])
                    piece = piece[self.max_chars:]
                if piece:
                    buffer = piece
                continue
            if buffer and len(buffer) + len(piece) <= self.max_chars:
                buffer += piece
            elif buffer:
                result.append(buffer)
                buffer = piece
            else:
                buffer = piece
        if buffer:
            result.append(buffer)
        if len(result) > 1 and len(result[-1]) < self.min_chars:
            result[-2] += result[-1]
            result.pop()
        return result
