"""语音会话音频存储层。

负责把设备提交的音频和 TTS 结果保存到独立会话目录，避免设备适配器、
模型客户端和文件布局互相耦合。
"""

import re
import time
from pathlib import Path


class VoiceAudioStore:
    """管理语音会话的输入和输出音频文件。"""

    def __init__(self, root=None):
        """root 为音频根目录；默认使用 runtime/voice。"""
        project_root = Path(__file__).resolve().parents[1]
        self.root = Path(root or project_root / "runtime" / "voice")

    def save_input(self, data, session_id, suffix=".wav"):
        """data 为音频字节；session_id 为会话标识；返回已保存的输入路径。"""
        return self._save(data, session_id, suffix, "input")

    def save_output(self, data, session_id, suffix=".wav"):
        """data 为 TTS 音频字节；session_id 为会话标识；返回已保存的输出路径。"""
        return self._save(data, session_id, suffix, "output")

    def _save(self, data, session_id, suffix, prefix):
        """保存一份音频；内部统一限制路径字符，防止设备标识穿越目录。"""
        safe_session = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(session_id or "default"))[:80] or "default"
        safe_suffix = suffix if re.fullmatch(r"\.[A-Za-z0-9]{1,8}", suffix or "") else ".audio"
        folder = self.root / safe_session
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{prefix}-{int(time.time() * 1000)}{safe_suffix}"
        path.write_bytes(bytes(data))
        return path
