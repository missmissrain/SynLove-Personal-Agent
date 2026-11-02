"""远端结果接收器。参数root为生产根目录；通知先在本机落盘，再确认远端；不创建消息消费者。"""

import json
import os
import sys
from pathlib import Path
from microServices.ServiceLease import ServiceLease
from microServices.ServiceTransport import ServiceTransport
from services.ServiceRegistry import ServiceRegistry


class NotificationPuller:
    """远端至少一次传递，本机消息队列按稳定ID去重；没有配置目标时保留远端结果。"""

    def __init__(self, root):
        """root为个人实例根目录，私人目标账号只从本机配置读取。"""
        self.root = Path(root)

    def pull_results(self):
        """无参数；单批最多40条，失败不删除本机文件、不确认尚未落盘的远端结果。"""
        registry = ServiceRegistry()
        home = Path(os.environ.get("DSH_HOME") or self.root / "runtime" / "dsh")
        inbox = home / "backendNotifications"
        inbox.mkdir(parents=True, exist_ok=True)
        try:
            lease = ServiceLease(inbox / "pull.lock").acquire()
        except RuntimeError:
            return {"accepted": 0, "busy": True}
        try:
            path = self.root / "newsDigest" / "config" / "newsDigest.json"
            config = json.loads(path.read_text(encoding="utf-8-sig")) if path.is_file() else {}
            target = str(config.get("push", {}).get("userOpenid", "")).strip()
            if not target:
                return {"accepted": 0, "reason": "尚未配置本机通知接收人"}
            count, errors = 0, []
            for name in ("reminders", "digest"):
                cfg = registry.get_service(name)
                if cfg["management"] != "external":
                    continue
                try:
                    transport = ServiceTransport(cfg)
                    data = json.loads(transport.request("GET", "/notifications"))
                    for row in data["items"]:
                        import re
                        ident = row["id"]
                        if not re.fullmatch("[a-f0-9]{64}", ident):
                            raise ValueError("非法远端通知ID")
                        text = row["text"]
                        if not isinstance(text, str) or not 0 < len(text) <= 30000:
                            raise ValueError("非法远端通知正文")
                        item = {"id": ident, "text": text, "target": {"userOpenid": target}}
                        final = inbox / (ident + ".json")
                        temp = inbox / (ident + ".tmp")
                        with temp.open("w", encoding="utf-8") as handle:
                            json.dump(item, handle, ensure_ascii=False)
                            handle.flush()
                            os.fsync(handle.fileno())
                        os.replace(temp, final)
                        transport.request("POST", "/notifications/" + ident + "/ack", b"{}")
                        count += 1
                except Exception as error:
                    errors.append(name + ":" + type(error).__name__)
            return {"accepted": count, "errors": errors}
        finally:
            lease.close()


if __name__ == "__main__":
    print(json.dumps(NotificationPuller(Path(__file__).resolve().parents[1]).pull_results()))
