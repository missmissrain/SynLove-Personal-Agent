"""业务迁移快照。参数--output为新私人目录，--freeze-local停止本机四项业务并禁用旧调度后导出。"""

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from pathlib import Path
from contextlib import closing

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from microServices.ServiceManager import ServiceManager
from services.ServiceRegistry import ServiceRegistry


class BusinessDataExport:
    """只迁移提醒、新闻去重库与新闻日程，私人聊天、账号、密钥和记忆留在本机。"""

    def __init__(self, root=ROOT):
        """root为个人实例根目录，不支持扫描其他项目。"""
        self.root = Path(root)

    def export_data(self, output, freeze=False):
        """output必须是不存在的目录；freeze显式冻结本机调度，未冻结只作演练快照。"""
        target = Path(output).resolve()
        registry = ServiceRegistry(self.root / "config" / "serviceConfig.json")
        if freeze:
            if any(registry.get_service(name)["management"] == "external"
                   for name in ("reminders", "digest")):
                raise ValueError("当前已经指向远端，不能导出本机旧数据库作为最新数据")
            from microServices.LegacyServiceMigration import LegacyServiceMigration
            LegacyServiceMigration(self.root, registry=registry).check()
        target.mkdir(parents=True, exist_ok=False)
        current = json.loads(json.dumps(registry.data))
        if freeze:
            manager = ServiceManager(self.root, registry)
            # 保留旧配置供回滚，先禁用自动补拉，再使用已加载的旧配置关闭所属服务。
            (target / "privateRollback.json").write_text(json.dumps(current, ensure_ascii=False), encoding="utf-8")
            disabled = json.loads(json.dumps(current))
            for name in ("reminders", "digest", "video", "crawler", "rsshub"):
                disabled["services"].setdefault(name, {})["management"] = "disabled"
            temp = registry.path.with_suffix(".migration.tmp")
            with temp.open("w", encoding="utf-8") as out:
                json.dump(disabled, out, ensure_ascii=False, indent=2)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temp, registry.path)
            for name in ("reminders", "digest", "video", "crawler"):
                manager.stop_service(name)
        files = {}
        for name, filename in (("reminders", "reminders.db"), ("digest", "newsDigest.db")):
            cfg = registry.get_service(name)
            source = self.root / cfg.get("databasePath", "runtime/" + filename)
            files["runtime/" + filename] = source
        digest = registry.get_service("digest")
        state = self.root / digest.get("dataDir", "runtime/microServices/digest")
        files["runtime/microServices/digest/schedule.sqlite"] = state / "schedule.sqlite"
        hashes = {}
        for name, source in files.items():
            if not source.is_file():
                continue
            dest = target / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as old, closing(sqlite3.connect(dest)) as new:
                old.backup(new)
                if new.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise RuntimeError("迁移数据库完整性检查失败")
            hashes[name] = hashlib.sha256(dest.read_bytes()).hexdigest()
        news = self.root / "newsDigest" / "config" / "newsDigest.json"
        if news.is_file():
            data = json.loads(news.read_text(encoding="utf-8-sig"))
            clean = {key: data[key] for key in
                     ("enabled", "sources", "interest", "maxItems", "maxChars", "hot") if key in data}
            clean["push"] = {"enabled": True}
            clean["browser"] = {}
            name = "newsDigest/config/newsDigest.json"
            dest = target / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")
            hashes[name] = hashlib.sha256(dest.read_bytes()).hexdigest()
        manifest = {"version": 1, "frozen": freeze, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "private": True, "files": hashes}
        (target / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return {"exported": True, "frozen": freeze, "files": len(hashes),
                "migrationId": hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--freeze-local", action="store_true")
    args = parser.parse_args()
    print(json.dumps(BusinessDataExport().export_data(args.output, args.freeze_local), ensure_ascii=False))
