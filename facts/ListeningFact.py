"""功能：全项目唯一的监听目标事实源，谁要判断「现在哪台在听」都必须经过本类。

注册参数root为主项目路径；默认文件 runtime/presence/listening.json，原子覆写、线程安全。
本类不下发命令、不推理；只回答「当前目标与原因」，外部禁止直接读该 JSON。
"""
import json
import threading
import time
from pathlib import Path


class ListeningFact:
    """监听目标的唯一入口：read / replace / clear。"""

    def __init__(self, root):
        """root为主项目Path；构造只计算路径。"""
        self.root = Path(root)
        self.path = self.root / "runtime/presence/listening.json"
        self._lock = threading.RLock()

    def read(self):
        """无参数；返回当前监听目标副本，缺失时返回 stopped。"""
        with self._lock:
            try:
                value = json.loads(self.path.read_text("utf-8"))
            except (OSError, ValueError):
                return {"state": "stopped", "target": None}
            return dict(value) if isinstance(value, dict) else {"state": "stopped", "target": None}

    def replace(self, value, source="unknown"):
        """value为完整监听状态；整体覆写并返回写入内容。"""
        with self._lock:
            data = dict(value or {})
            data["updatedAt"] = time.time()
            data["source"] = source
            self._write(data)
            return dict(data)

    def clear(self, reason="stopped"):
        """reason为停止原因；写入停止状态并返回。"""
        return self.replace({"state": "stopped", "target": None, "reason": reason},
                            source="listeningFact")

    def _write(self, value):
        """value为要落盘的对象；临时文件 + 原子替换。"""
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix(".tmp")
            temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), "utf-8")
            temp.replace(self.path)
        except OSError:
            pass


_INSTANCES = {}


def listening_fact(root):
    """root为主项目路径；返回进程内共享实例。"""
    key = str(Path(root).resolve())
    if key not in _INSTANCES:
        _INSTANCES[key] = ListeningFact(key)
    return _INSTANCES[key]
