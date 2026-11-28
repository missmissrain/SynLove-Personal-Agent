"""唤醒词检测层。

负责从一次 ASR 文本中识别“欣爱”唤醒词，并把唤醒词后的用户指令切出来。
默认唤醒词来自配置；后续可以在不修改语音流水线的情况下替换为 sherpa-onnx
等持续音频关键词检测器。
"""

import re


class WakeWordDetector:
    """提供与具体关键词模型解耦的唤醒词检测接口。"""

    def __init__(self, wake_words=None):
        """wake_words 为允许触发本轮会话的关键词列表，默认包含“欣爱”。"""
        self.wake_words = tuple(
            str(item).strip() for item in (wake_words or ("欣爱",))
            if str(item).strip()
        )
        if not self.wake_words:
            raise ValueError("至少需要一个唤醒词")

    def detect(self, text):
        """text 为 ASR 输出文本；返回是否唤醒、去掉唤醒词后的指令和命中的关键词。"""
        normalized = re.sub(r"[\s，。！？、,.!?：:；;]+", " ", str(text or "")).strip()
        if not normalized:
            return {"wake": False, "command": "", "keyword": ""}
        for keyword in self.wake_words:
            index = normalized.find(keyword)
            if index >= 0:
                command = normalized[index + len(keyword):].strip(" ，。！？、,.!?：:；;")
                return {"wake": True, "command": command, "keyword": keyword}
        return {"wake": False, "command": normalized, "keyword": ""}
