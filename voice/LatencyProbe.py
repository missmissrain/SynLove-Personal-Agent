"""功能：记录欣爱语音链路各阶段的耗时与状态。

注册参数name为本轮探针名称；默认使用单调时钟，默认不记录音频、文本、令牌或设备隐私数据。
该类只保存当前一次请求的时间点，适合在 ASR、主人格和 TTS 的边界注入。
"""

import threading
import time


class LatencyProbe:
    """线程安全的单轮延迟探针。"""

    def __init__(self, name="voice_turn"):
        """name为探针名称；用于日志和返回结果中的脱敏标识。"""
        self.name = str(name)
        self.started_at = time.monotonic()
        self._marks = {}
        self._lock = threading.RLock()

    def mark(self, stage, state="ok"):
        """stage为阶段名称，state为阶段状态；记录阶段相对本轮开始的秒数。"""
        with self._lock:
            now = time.monotonic()
            self._marks[str(stage)] = {
                "elapsedSeconds": round(now - self.started_at, 4),
                "state": str(state),
            }
            return dict(self._marks[str(stage)])

    def snapshot(self):
        """无参数；返回本轮探针的脱敏快照，不包含原始语音和文本。"""
        with self._lock:
            return {
                "name": self.name,
                "totalSeconds": round(time.monotonic() - self.started_at, 4),
                "stages": {key: dict(value) for key, value in self._marks.items()},
            }
