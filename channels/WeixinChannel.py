"""功能：微信通道封装。连接状态与收发队列由本类读取并对外统一成一份快照。

注册参数root为主项目路径、dbPath为微信状态库；默认 runtime/dsh/weixin-state.db，只读打开。
本类不修改微信状态库、不发送消息；外部要微信通道状态只调 snapshot()。
"""
import os
import sqlite3
import time
from pathlib import Path

from channels.ChannelState import ChannelState

ACTIVE_WINDOW = 300


class WeixinChannel:
    """微信通道的状态出口。"""

    def __init__(self, root, db_path=None):
        """root为主项目Path、dbPath为状态库路径；默认 runtime/dsh/weixin-state.db。"""
        self.root = Path(root)
        self.state = ChannelState(root, "weixin")
        self.db_path = Path(db_path) if db_path else self.root / "runtime/dsh/weixin-state.db"

    def snapshot(self):
        """无参数；返回微信通道快照（连接、待发、失败、最近活动）。"""
        now = time.time()
        value = {"connected": False, "db": self.db_path.name, "delivery": {}, "outbox": {}}
        if not self.db_path.is_file():
            self.state.update(**value, reason="数据库不存在")
            return self.state.read()
        try:
            uri = "file:%s?mode=ro" % self.db_path.as_posix()
            with sqlite3.connect(uri, uri=True, timeout=2) as db:
                db.row_factory = sqlite3.Row
                for table, key in (("delivery", "delivery"), ("outbox", "outbox")):
                    try:
                        rows = db.execute(
                            "SELECT status, COUNT(*) AS n FROM %s GROUP BY status" % table
                        ).fetchall()
                        value[key] = {str(row["status"]): int(row["n"]) for row in rows}
                    except sqlite3.Error:
                        value[key] = {}
                latest = db.execute(
                    "SELECT MAX(received_at) AS last FROM delivery").fetchone()
                last = latest["last"] if latest and latest["last"] else 0
            age = max(0.0, now - float(last)) if last else None
            value["connected"] = age is not None and age <= ACTIVE_WINDOW
            value["lastEventAgeSeconds"] = int(age) if age is not None else None
        except sqlite3.Error as error:
            value["error"] = type(error).__name__
        previous = self.state.read()
        self.state.update(**value)
        if previous.get("connected") != value.get("connected"):
            self.state.log("connected=%s delivery=%s outbox=%s"
                           % (value.get("connected"), value.get("delivery"),
                              value.get("outbox")))
        return self.state.read()
