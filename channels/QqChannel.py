"""功能：QQ 通道状态出口。连接以网关租约进程存活为准，队列统计以后端 outbox 为准。

注册参数 root 为主项目路径、outboxPath 为后端队列文件、leasePath 为网关租约库；
默认 runtime/dsh/qq-outbox.json 与 runtime/dsh/qq-gateway-lease.db。
本类只读，不发送、不清理；文件缺失时明确标记未配置，不做猜测。
"""
import ctypes
import json
import os
import sqlite3
import time
from pathlib import Path

from channels.ChannelState import ChannelState

STILL_ACTIVE = 259
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def process_alive(pid):
    """pid 为进程号；返回该进程是否仍在运行（仅 Windows，其它平台返回 False）。"""
    if not isinstance(pid, int) or pid <= 0 or os.name != "nt":
        return False
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


class QqChannel:
    """QQ 通道状态出口。"""

    def __init__(self, root, outbox_path=None, lease_path=None):
        """root 为主项目 Path；outboxPath 为队列文件；leasePath 为网关租约库。"""
        self.root = Path(root)
        self.state = ChannelState(root, "qq")
        self.outbox_path = Path(outbox_path) if outbox_path else \
            self.root / "runtime/dsh/qq-outbox.json"
        self.lease_path = Path(lease_path) if lease_path else \
            self.root / "runtime/dsh/qq-gateway-lease.db"

    def gateway(self):
        """无参数；读租约库判断网关是否在线，返回 {pid, startedAt, alive}。"""
        value = {"pid": None, "startedAt": None, "alive": False}
        if not self.lease_path.is_file():
            return value
        try:
            uri = "file:%s?mode=ro" % self.lease_path.as_posix()
            with sqlite3.connect(uri, uri=True, timeout=2) as db:
                db.row_factory = sqlite3.Row
                row = db.execute(
                    "SELECT pid, started_at FROM gateway_lease WHERE id = 1").fetchone()
        except sqlite3.Error:
            return value
        if row is None:
            return value
        pid = int(row["pid"] or 0)
        started = row["started_at"]
        value.update({"pid": pid or None,
                      "startedAt": int(started) if isinstance(started, (int, float)) else None,
                      "alive": process_alive(pid)})
        return value

    def snapshot(self):
        """无参数；返回网关在线、待发、永久失败与最近活动。"""
        gateway = self.gateway()
        value = {"connected": bool(gateway["alive"]), "gateway": gateway,
                 "source": self.outbox_path.name, "outbox": {}}
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
        if not gateway["alive"]:
            value["state"] = "offline"
        else:
            value["state"] = "active" if rows else "idle"
        previous = self.state.read()
        self.state.update(**value)
        if previous.get("state") != value["state"] or previous.get("connected") != value["connected"]:
            self.state.log("state=%s gateway=%s outbox=%s" % (value["state"], gateway["alive"], counts))
        return self.state.read()
