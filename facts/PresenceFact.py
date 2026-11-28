"""功能：全项目唯一的在场事实源，规则版与模型版都写这一份，外部只通过本类读取。

注册参数root为主项目路径；默认文件 runtime/presence/presence.json，原子覆写、线程安全。
本类不推理、不下发命令、不读其他状态文件；外部禁止直接读写该 JSON。
"""
import json
import threading
import time
from pathlib import Path


class PresenceFact:
    """在场结论的唯一入口：read / replace / update / update_section。"""

    def __init__(self, root):
        """root为主项目Path；构造只计算路径，不创建目录、不读写。"""
        self.root = Path(root)
        self.path = self.root / "runtime/presence/presence.json"
        self._lock = threading.RLock()

    def read(self):
        """无参数；返回当前在场结论的副本，文件缺失或损坏时返回空字典。"""
        with self._lock:
            try:
                value = json.loads(self.path.read_text("utf-8"))
            except (OSError, ValueError):
                return {}
            return dict(value) if isinstance(value, dict) else {}

    def replace(self, value, source="unknown"):
        """value为完整在场结论、source为写入方标识；整体覆写并返回写入内容。"""
        with self._lock:
            data = dict(value or {})
            data["updatedAt"] = time.time()
            data["source"] = source
            self._write(data)
            return dict(data)

    def update(self, values, source="unknown"):
        """values为要合并的字段；顶层合并后覆写，返回最新内容。"""
        with self._lock:
            data = self.read()
            data.update(values or {})
            data["updatedAt"] = time.time()
            data["source"] = source
            self._write(data)
            return dict(data)

    def update_section(self, name, values, source="unknown"):
        """name为子节名（如 screenInitiative）；只更新该子节，避免两个写入方互相覆盖。"""
        with self._lock:
            data = self.read()
            section = data.get(name)
            merged = dict(section) if isinstance(section, dict) else {}
            merged.update(values or {})
            data[name] = merged
            data["updatedAt"] = time.time()
            data["source"] = source
            self._write(data)
            return dict(data)

    def _write(self, value):
        """value为要落盘的对象；临时文件 + 原子替换，失败静默不抛。"""
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix(".tmp")
            temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), "utf-8")
            temp.replace(self.path)
        except OSError:
            pass


_INSTANCES = {}


def presence_fact(root):
    """root为主项目路径；返回进程内共享实例，避免多处各建一份缓存。"""
    key = str(Path(root).resolve())
    if key not in _INSTANCES:
        _INSTANCES[key] = PresenceFact(key)
    return _INSTANCES[key]
