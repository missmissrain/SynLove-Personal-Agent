"""功能：统一通道状态对象，负责单个通道的状态字段与有界日志。

注册参数root为主项目路径、name为通道名；状态写 runtime/channels/<name>.json，日志同目录 .log（最多 200 行）。
本类不做连接、不解析业务消息；通道类只通过它维护自己的状态与日志。
"""
import json
import threading
import time
from pathlib import Path


class ChannelState:
    """单通道的状态与日志容器。"""

    def __init__(self, root, name):
        """root为主项目Path、name为通道名（weixin/qq）。"""
        self.root = Path(root)
        self.name = str(name)
        base = self.root / "runtime" / "channels"
        self.path = base / (self.name + ".json")
        self.log_path = base / (self.name + ".log")
        self._lock = threading.RLock()
        self._last = {}

    def update(self, **fields):
        """fields为状态字段；合并后覆写状态文件并返回最新状态。"""
        with self._lock:
            value = dict(self._last)
            value.update(fields)
            value["name"] = self.name
            value["updatedAt"] = time.time()
            self._last = value
            self._write(value)
            return dict(value)

    def log(self, line):
        """line为一行日志；追加并保留最近 200 行。"""
        with self._lock:
            try:
                self.log_path.parent.mkdir(parents=True, exist_ok=True)
                stamp = time.strftime("%m-%d %H:%M:%S")
                with self.log_path.open("a", encoding="utf-8") as handle:
                    handle.write("%s %s\n" % (stamp, str(line)[:300]))
                lines = self.log_path.read_text("utf-8").splitlines()
                if len(lines) > 200:
                    self.log_path.write_text("\n".join(lines[-200:]) + "\n", "utf-8")
            except OSError:
                pass

    def read(self):
        """无参数；返回最后一次写入的状态。"""
        with self._lock:
            if self._last:
                return dict(self._last)
            try:
                value = json.loads(self.path.read_text("utf-8"))
                return value if isinstance(value, dict) else {}
            except (OSError, ValueError):
                return {}

    def _write(self, value):
        """value为状态对象；原子覆写。"""
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix(".tmp")
            temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), "utf-8")
            temp.replace(self.path)
        except OSError:
            pass
