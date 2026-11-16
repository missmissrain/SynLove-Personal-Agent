"""语音交互提示词读取层。

负责读取独立的语音人格提示词文件，不把提示词硬编码进音频处理代码。
"""

from pathlib import Path


class VoicePrompt:
    """加载并缓存语音会话的系统提示词。"""

    def __init__(self, prompt_path=None):
        """prompt_path 为提示词文件路径；未传时读取项目 prompts/VoiceInteraction.md。"""
        root = Path(__file__).resolve().parents[1]
        self.prompt_path = Path(prompt_path or root / "prompts" / "VoiceInteraction.md")
        self._content = ""

    def load(self):
        """无参数；读取 UTF-8 提示词并缓存，文件不存在时明确报错。"""
        if not self.prompt_path.is_file():
            raise FileNotFoundError("语音提示词不存在：" + str(self.prompt_path))
        if not self._content:
            self._content = self.prompt_path.read_text(encoding="utf-8-sig").strip()
        return self._content
