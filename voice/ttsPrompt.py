"""TTS 提示词解析与默认策略。

负责从主人格返回文本中提取内部 TTS 提示词，并清理不会展示给用户的标记。
该类不调用模型、不保存会话，也不绑定具体设备，方便以后由不同终端替换。
"""

import re


class TtsPrompt:
    """把主人格的语音回复拆成可展示正文和 TTS 控制提示。"""

    DEFAULT = "neutral"
    EMOTIONS = {
        "neutral": "自然平静",
        "happy": "开心，带轻微笑意",
        "gentle": "温柔亲近",
        "concerned": "关切",
        "sad": "轻微低落",
        "excited": "轻快兴奋",
    }
    _PATTERNS = (
        re.compile(r"\[\[TTS_PROMPT\]\](.*?)\[\[/TTS_PROMPT\]\]", re.I | re.S),
        re.compile(r"<tts_prompt>\s*(.*?)\s*</tts_prompt>", re.I | re.S),
        re.compile(r"^\s*TTS_PROMPT\s*[:：]\s*(.+?)\s*$", re.I | re.M),
    )

    def parse(self, content):
        """content 为主人格原始返回文本；返回 text 与 ttsPrompt 两个字段。"""
        text = str(content or "").strip()
        prompt = self.DEFAULT
        for pattern in self._PATTERNS:
            match = pattern.search(text)
            if match is not None and prompt == self.DEFAULT:
                candidate = re.sub(r"\s+", " ", match.group(1)).strip().lower()
                if candidate in self.EMOTIONS:
                    prompt = candidate
            text = pattern.sub("", text).strip()
        # 模型输出被截断时，内部控制尾段也不能被展示或朗读。
        text = re.split(r"\[\[TTS_PROMPT\]\]|<tts_prompt>", text, flags=re.I)[0].strip()
        if not text:
            raise ValueError("主人格返回缺少可朗读正文")
        return {"text": text, "ttsPrompt": prompt}
