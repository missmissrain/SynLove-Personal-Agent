"""功能：在场状态快照与推理结果的脱敏落盘，供常驻刻画与切换使用。

注册参数root为主项目路径；默认只写 runtime/presenceState 与 runtime/voiceRouting。
本类只保留「最新快照 + 上次推理基线 + 最近一次判定」，全部覆写，不追加历史、不保存图像与精确坐标。
"""
import json
from pathlib import Path


class SnapshotStore:
    """维护 current、lastReasoned、reasoning 三类文件，全部原子覆写。"""

    def __init__(self, root):
        """root为主项目Path；构造时只计算路径，不创建目录、不读写。"""
        self.root = Path(root)
        base = self.root / "runtime/presenceState"
        self.current_path = base / "current.json"
        self.reasoned_path = base / "lastReasoned.json"
        self.reasoning_path = self.root / "runtime/voiceRouting/reasoning.json"

    def _write(self, path, value):
        """path为目标文件、value为可序列化对象；原子覆写，失败不抛出。"""
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temp = path.with_suffix(path.suffix + ".tmp")
            temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), "utf-8")
            temp.replace(path)
        except OSError:
            pass

    def _read(self, path):
        """path为文件路径；返回字典，缺失或损坏时返回空字典。"""
        try:
            value = json.loads(path.read_text("utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def read_current(self):
        """无参数；返回最近一次状态快照。"""
        return self._read(self.current_path)

    def write_current(self, snapshot):
        """snapshot为本轮状态快照；覆写 current.json，不保留历史副本。"""
        self._write(self.current_path, snapshot)

    def read_last_reasoned(self):
        """无参数；返回上一次触发推理时的快照，作为漂移比较基线。"""
        return self._read(self.reasoned_path)

    def write_last_reasoned(self, snapshot):
        """snapshot为触发推理时的快照；覆写基线，不追加历史。"""
        self._write(self.reasoned_path, snapshot)

    def write_reasoning(self, value):
        """value为一次推理的决策、理由与漂移摘要；覆写，供排查与回放最近一次。"""
        self._write(self.reasoning_path, value)

    def read_reasoning(self):
        """无参数；返回最近一次推理记录。"""
        return self._read(self.reasoning_path)
