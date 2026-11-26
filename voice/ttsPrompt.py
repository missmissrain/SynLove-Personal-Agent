"""TTS 提示词解析与默认策略。

负责从主人格返回文本中提取内部 TTS 提示词，并清理不会展示给用户的标记。
该类不调用模型、不保存会话，也不绑定具体设备，方便以后由不同终端替换。
"""

import json
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
        """content 为正文或包含 text、ttsEmotion 的下行对象；返回正文和兼容情绪字段。"""
        if isinstance(content, dict):
            return self.parse_reply(content)
        text = str(content or "").strip()
        # 仅将含正文键的对象识别成控制协议，普通 JSON 回答仍保留为正文。
        raw = text
        if text.startswith("```json\n") and text.endswith("```"):
            raw = text[8:-3].strip()
        if raw.startswith("{"):
            try:
                data = json.loads(raw)
            except ValueError:
                data = None
            if isinstance(data, dict) and "text" in data:
                return self.parse_reply(data)
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

    def parse_reply(self, reply):
        """reply 为主人格下行字典；白名单校验情绪，剥离正文标记，忽略声线覆盖字段。"""
        text = reply.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("主人格返回缺少可朗读正文")
        result = self.parse(text)
        mood = reply.get("ttsEmotion", reply.get("ttsPrompt", result["ttsPrompt"]))
        if isinstance(mood, str):
            mood = mood.strip().lower()
        result["ttsPrompt"] = mood if isinstance(mood, str) and mood in self.EMOTIONS else self.DEFAULT
        return result
