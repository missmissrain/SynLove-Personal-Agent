"""后台业务切换工具。参数action为verify/configure；默认复用现有Relay连接，仅全部功能协议通过才切换。"""

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from microServices.ServiceManager import ServiceManager
from microServices.ServiceTransport import ServiceTransport
from services.ServiceRegistry import ServiceRegistry


class BusinessServiceSetup:
    """不猜服务器地址、不偷偷回退本机；切换失败保持原配置，留存版本化配置备份。"""

    CAPABILITIES = {"reminders": "scheduler", "digest": "crawlerCenter",
                    "video": "video", "crawler": "webCollection"}

    def __init__(self, config=None):
        """config为个人实例注册表，默认生产配置。"""
        self.registry = ServiceRegistry(config)
        self.root = self.registry.path.resolve().parents[1]

    def remote_config(self, name):
        """name为业务服务；复用现有远端Gemma的Hub、凭据引用和受信任CA。"""
        source = self.registry.get_service("llm")
        if source.get("transport") != "relay":
            raise ValueError("本工具需要现有Relay配置；直连部署请通过服务配置填写端点")
        current = self.registry.get_service(name)
        return {**current, **{k: source[k] for k in
                ("baseURL", "apiKeyEnv", "apiKeyRef", "tlsCaFile") if k in source},
                "management": "external", "transport": "relay",
                "relayCapability": self.CAPABILITIES[name], "healthPath": "/health",
                "timeoutSeconds": current["timeoutSeconds"]}

    def verify_services(self):
        """无参数；逐项调用真实远端健康协议，不能用节点注册清单替代验证。"""
        result = {}
        source = self.registry.get_service("llm")
        from microServices.RelayBusinessClient import RelayBusinessClient
        capabilities = json.loads(RelayBusinessClient(source).request_hub("GET", "/capabilities"))
        online = {row["name"] for row in capabilities.get("capabilities", []) if row.get("nodes", 0) > 0}
        for name, capability in self.CAPABILITIES.items():
            if capability not in online:
                result[name] = {"ready": False, "reason": "家庭节点尚未注册该能力"}
                continue
            try:
                data = json.loads(ServiceTransport(self.remote_config(name)).request("GET", "/health"))
                result[name] = {"ready": data.get("ok") is True and
                                data.get("service") == name and data.get("protocol") == 1,
                                "migrationId": data.get("migrationId")}
            except Exception as error:
                result[name] = {"ready": False, "reason": type(error).__name__}
        return result

    def configure_services(self, migration_confirmed=False, migration_id=None):
        """migration_confirmed要求操作者已迁移旧数据库并停止旧调度；未确认不允许切换。"""
        if not migration_confirmed:
            raise ValueError("先按迁移文档冻结并导入旧日程，再传--migration-confirmed")
        result = self.verify_services()
        if not all(row["ready"] for row in result.values()):
            return {"configured": False, "services": result}
        if migration_id and any(row.get("migrationId") != migration_id for row in result.values()):
            raise ValueError("远端迁移收据与指定快照不符")
        if not migration_id and any((self.root / "runtime" / name).is_file()
                                    for name in ("reminders.db", "newsDigest.db")):
            raise ValueError("本机已有业务数据，切换时必须提供--migration-id验证迁移收据")
        manager = ServiceManager(self.root, self.registry)
        # 先持久化备份，再停旧服务；失败时绝不留下双消费者。
        backup = self.root / "备份" / ("BusinessConfigv1.0-" + time.strftime("%Y%m%d%H%M%S"))
        backup.mkdir(parents=True, exist_ok=False)
        shutil.copyfile(self.registry.path, backup / "serviceConfig.json")
        (backup / "version.json").write_text(json.dumps(
            {"version": "1.0", "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "private": True}), encoding="utf-8")
        (backup / "版本说明.md").write_text("远程业务切换前的私人配置，仅供回滚，不得发布。", encoding="utf-8")
        for name in self.CAPABILITIES:
            manager.stop_service(name)
        data = self.registry.data
        for name in self.CAPABILITIES:
            cfg = self.remote_config(name)
            cfg.pop("host", None)
            cfg.pop("port", None)
            data["services"][name] = cfg
        # RSSHub由远端爬虫中心维护，本机启动器不再启动第二个RSSHub。
        data["services"].setdefault("rsshub", {})["management"] = "disabled"
        temp = self.registry.path.with_suffix(".tmp")
        with temp.open("w", encoding="utf-8") as out:
            json.dump(data, out, ensure_ascii=False, indent=2)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, self.registry.path)
        return {"configured": True, "services": result, "restartRequired": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("verify", "configure"))
    parser.add_argument("--config")
    parser.add_argument("--migration-confirmed", action="store_true")
    parser.add_argument("--migration-id")
    args = parser.parse_args()
    app = BusinessServiceSetup(args.config)
    result = app.verify_services() if args.action == "verify" else app.configure_services(
        args.migration_confirmed, args.migration_id)
    print(json.dumps(result, ensure_ascii=False))
