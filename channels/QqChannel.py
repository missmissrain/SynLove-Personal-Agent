"""功能：QQ 通道状态，以后端 qq-outbox.json 为准（Python 队列不再作为事实）。

注册参数root为主项目路径、outboxPath为后端队列文件；默认 runtime/dsh/qq-outbox.json。
本类只读队列统计，不发送、不修改；文件缺失时明确标记未配置。
"""
import json
import time
from pathlib import Path

from channels.ChannelState import ChannelState


class QqChannel:
    """QQ 通道状态出口。"""

    def __init__(self, root, outbox_path=None):
        """root为主项目Path、outboxPath为后端队列文件。"""
        self.root = Path(root)
        self.state = ChannelState(root, "qq")
        self.outbox_path = Path(outbox_path) if outbox_path else \
            self.root / "runtime/dsh/qq-outbox.json"

    def snapshot(self):
        """无参数；返回待发、永久失败、最近活动。"""
        value = {"connected": False, "source": self.outbox_path.name, "outbox": {}}
        if not self.outbox_path.is_file():
            self.state.update(**value, state="unconfigured", reason="后端队列文件不存在")
            return self.state.read()
        try:
            data = json.loads(self.outbox_path.read_text("utf-8"))
        except (OSError, ValueError) as error:
            self.state.update(**value, state="error", reason=type(error).__name__)
            return self.state.read()
        rows = data.get("rows") if isinstance(data, dict) else None
        rows = rows if isinstance(rows, list) else []
        counts = {"pending": 0, "failed_terminal": 0}
        latest = 0.0
        for row in rows:
            status = str(row.get("status") or "pending")
            counts[status] = counts.get(status, 0) + 1
            stamp = row.get("created_at") or row.get("next_at") or 0
            if isinstance(stamp, (int, float)):
                latest = max(latest, float(stamp))
        value["outbox"] = counts
        value["rows"] = len(rows)
        value["lastEventAgeSeconds"] = int(time.time() - latest) if latest else None
        value["connected"] = counts.get("pending", 0) > 0 or value["lastEventAgeSeconds"] is not None
        value["state"] = "active" if rows else "idle"
        previous = self.state.read()
        self.state.update(**value)
        if previous.get("state") != value["state"]:
            self.state.log("state=%s outbox=%s" % (value["state"], counts))
        return self.state.read()
