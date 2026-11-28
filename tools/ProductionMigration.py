"""生产迁移：备份指定代码和业务数据，合并旧配置、会话与记忆；不迁移进程锁或重放旧队列。
参数 --backup 只建立快照；--migrate 要求快照存在。默认源为同工程旧目录及用户 .dsh。
"""
import argparse
import hashlib
import json
import os
import shutil
import sqlite3
from pathlib import Path
from datetime import datetime


class ProductionMigration:
    """在停栈维护窗口内执行有清单、可恢复的数据迁移。"""

    def __init__(self):
        """无参数；固定本项目源、目标与版本快照，避免扫描或修改其他工程。"""
        self.root = Path(__file__).resolve().parents[1]
        self.base = self.root.parents[1]
        self.old = self.base / "微信Harness链路"
        self.home = Path.home() / ".dsh"
        self.backup = self.base / "备份" / "SynLove-v1.5-productionMigration"
        self.report = {"time": datetime.now().isoformat(), "files": 0, "databases": []}

    def copy_file(self, source, target):
        """source 为已确定源文件，target 为目标；创建父目录并保留时间信息。"""
        # 中文工程路径叠加历史会话编码后可能超过 MAX_PATH，使用 Windows 长路径前缀。
        if os.name == "nt":
            source = Path("\\\\?\\" + str(source.resolve())) if not str(source).startswith("\\\\?\\") else source
            target = Path("\\\\?\\" + str(target.resolve())) if not str(target).startswith("\\\\?\\") else target
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        self.report["files"] += 1

    def copy_data(self, source, target, snapshot=False):
        """source/target 为数据树；跳过依赖、历史备份、活动锁；SQLite 使用一致性备份。"""
        if not source.exists():
            return
        for item in source.rglob("*"):
            rel = item.relative_to(source)
            if any(x in {"node_modules", "__pycache__", ".git", "备份"} for x in rel.parts):
                continue
            if not item.is_file() or item.name.endswith(("-wal", "-shm", ".lock", ".pid")):
                continue
            dest = target / rel
            if item.suffix in {".db", ".sqlite"} and item.stat().st_size:
                dest.parent.mkdir(parents=True, exist_ok=True)
                src = sqlite3.connect("file:" + item.as_posix() + "?mode=ro", uri=True)
                out = sqlite3.connect(str(dest))
                try:
                    src.backup(out)
                    if out.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                        raise RuntimeError("数据库快照校验失败")
                finally:
                    out.close()
                    src.close()
            else:
                self.copy_file(item, dest)

    def make_backup(self):
        """无参数；只备份本轮涉及的代码、配置和业务产物，不复制模型及依赖。"""
        if self.backup.exists():
            raise RuntimeError("快照已经存在，拒绝覆盖")
        self.backup.mkdir(parents=True)
        for rel in ["config", "runtime", "console", "tools", "installer", "services"]:
            self.copy_data(self.root / rel, self.backup / "production" / rel, True)
        for rel in ["config", "runtime", "提示词", "prompts", "newsDigest/config", "reminders/config"]:
            self.copy_data(self.old / rel, self.backup / "legacy" / rel, True)
        for rel in ["sessions", "timeline", "graph", "storages", "skills", ".agent-presets"]:
            self.copy_data(self.home / rel, self.backup / "home" / rel, True)
        for item in self.home.iterdir():
            if item.is_file() and (item.suffix == ".db" or item.name in {".credentials.yaml", "shared-session.txt"}):
                self.copy_file(item, self.backup / "home" / item.name)
        for rel in ["packages/webhook/webhook-weixin", "packages/webhook/webhook-qq"]:
            self.copy_data(self.root / "backend" / rel, self.backup / "backend" / rel, True)
        (self.backup / "版本记录.json").write_text(json.dumps({
            "version": "1.5", "time": self.report["time"], "scope": "代码配置和业务数据，不含依赖和模型",
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        (self.backup / "版本说明.md").write_text(
            "# v1.5 生产迁移前快照\n\n保留旧、新运行配置、数据库、会话和本轮修改的连接器代码。"
            "仅供本机回滚，含敏感数据，不得上传。\n", encoding="utf-8")
        print("backup_created")

    def merge_tree(self, source, target):
        """source 为旧数据；相同路径相同内容跳过，冲突保留双方，JSONL 按整行合并去重。"""
        if not source.exists():
            return
        for item in source.rglob("*"):
            if not item.is_file() or "__pycache__" in item.parts:
                continue
            dest = target / item.relative_to(source)
            if not dest.exists():
                self.copy_file(item, dest)
            elif item.read_bytes() != dest.read_bytes():
                if item.suffix == ".jsonl":
                    lines = list(dict.fromkeys(item.read_text(encoding="utf-8").splitlines()
                                               + dest.read_text(encoding="utf-8").splitlines()))
                    dest.write_text("\n".join(lines) + "\n", encoding="utf-8")
                elif item.name == "index.json" and item.parent.name == "timeline":
                    old = json.loads(item.read_text(encoding="utf-8"))
                    new = json.loads(dest.read_text(encoding="utf-8"))
                    old["days"] = {**old.get("days", {}), **new.get("days", {})}
                    dest.write_text(json.dumps(old, ensure_ascii=False, indent=2), encoding="utf-8")
                else:
                    self.copy_file(dest, self.backup / "conflicts" / dest.relative_to(self.root))
                    self.copy_file(item, dest)

    def merge_state(self):
        """无参数；合并旧消息历史，保留生产游标和租约；旧未完成消息转终态避免重复通知。"""
        source = self.home / "weixin-state.db"
        target = self.root / "runtime/dsh/weixin-state.db"
        src = sqlite3.connect("file:" + source.as_posix() + "?mode=ro", uri=True)
        out = sqlite3.connect(str(target))
        try:
            for table in ["meta", "route", "delivery", "outbox", "turn_context"]:
                cols = [x[1] for x in src.execute('PRAGMA table_info("' + table + '")')]
                names = ",".join('"' + x + '"' for x in cols)
                before = out.total_changes
                for values in src.execute('SELECT ' + names + ' FROM "' + table + '"'):
                    row = dict(zip(cols, values))
                    # 保留共享会话代次、通知开关和任务完成去重水位；只排除由代码管理的版本号。
                    if table == "meta" and row["key"] == "schema_version":
                        continue
                    if table in {"delivery", "outbox"} and row["status"] not in {
                        "sent", "completed", "failed_terminal", "control_applied", "injected"
                    }:
                        row["status"] = "failed_terminal"
                        row["last_error"] = "迁移归档：旧队列不自动重放"
                    out.execute('INSERT OR IGNORE INTO "' + table + '" (' + names + ') VALUES ('
                                + ",".join("?" for _ in cols) + ")", list(row.values()))
                self.report["databases"].append({"table": table, "inserted": out.total_changes - before})
            out.commit()
            if out.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("状态数据库合并校验失败")
        finally:
            src.close()
            out.close()

    def migrate(self):
        """无参数；恢复有效本机配置，迁移业务数据，保留生产结构和新通道凭据。"""
        if not (self.backup / "版本记录.json").exists():
            raise RuntimeError("必须先备份")
        cfg = self.root / "config"
        old_cfg = self.old / "config"
        old_secret = json.loads((old_cfg / "secrets.json").read_text(encoding="utf-8-sig"))
        new_secret = json.loads((cfg / "secrets.json").read_text(encoding="utf-8-sig"))
        for name, block in old_secret.items():
            if isinstance(block, dict):
                current = new_secret.setdefault(name, {})
                for key, value in block.items():
                    if not current.get(key):
                        current[key] = value
        # providers 内还有一层 provider 名称，逐个恢复真实密钥。
        for name, block in old_secret.get("providers", {}).items():
            if block.get("apiKey"):
                new_secret.setdefault("providers", {}).setdefault(name, {})["apiKey"] = block["apiKey"]
        (cfg / "secrets.json").write_text(json.dumps(new_secret, ensure_ascii=False, indent=2), encoding="utf-8")
        for name in ["modelConfig.json", "harnessTuning.json", "observationConfig.json"]:
            if (old_cfg / name).exists():
                self.copy_file(old_cfg / name, cfg / name)
        # 保留生产模板的路径及插件架构，只迁移人格正文。
        old_text = (old_cfg / "weixinDoubaoProfile.patch.yml").read_text(encoding="utf-8")
        new_text = (cfg / "weixinDoubaoProfile.patch.yml").read_text(encoding="utf-8")
        a, z = "    personaPrefix: |", "    personaSuffix:"
        if a in old_text and z in old_text and a in new_text and z in new_text:
            new_text = new_text[:new_text.index(a)] + old_text[old_text.index(a):old_text.index(z)] + new_text[new_text.index(z):]
            (cfg / "weixinDoubaoProfile.patch.yml").write_text(new_text, encoding="utf-8")
        home = self.root / "runtime/dsh"
        for name in ["sessions", "timeline", "graph", "storages", "skills"]:
            self.merge_tree(self.home / name, home / name)
        self.merge_tree(self.old / "runtime/sessions", home / "sessions")
        for name in ["newsDigest/config", "reminders/config", "提示词", "prompts"]:
            self.merge_tree(self.old / name, self.root / name)
        for name in ["reminders.db", "newsDigest.db"]:
            src = self.backup / "legacy/runtime" / name
            if src.exists():
                self.copy_file(src, self.root / "runtime" / name)
        self.merge_tree(self.old / "runtime/cookies", self.root / "runtime/cookies")
        self.merge_state()
        # 共享代次与旧会话一致；失败的新 main 只作历史记录，不清空旧对话。
        shared = (self.home / "shared-session.txt").read_text(encoding="utf-8").strip()
        (home / "shared-session.txt").write_text(shared + "\n", encoding="utf-8")
        # API 与内核必须指向同一份数据库和记忆树。
        services = json.loads((cfg / "serviceConfig.json").read_text(encoding="utf-8"))
        for name, values in {
            "memory": {"timelineDir": "runtime/dsh/timeline", "graphDir": "runtime/dsh/graph"},
            "state": {"databasePath": "runtime/dsh/weixin-state.db"},
            "qqstate": {"databasePath": "runtime/dsh/qq-state.db"},
            "session": {"rootDir": "runtime/dsh/sessions"},
            "observation": {"databasePath": "runtime/observations.sqlite"},
        }.items():
            services["services"].setdefault(name, {}).update(values)
        (cfg / "serviceConfig.json").write_text(json.dumps(services, ensure_ascii=False, indent=2), encoding="utf-8")
        report = self.root / "runtime/reports/生产迁移结果.json"
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(self.report, ensure_ascii=False, indent=2), encoding="utf-8")
        print("migration_data_copied", self.report["files"])

    def migrate_service_data(self):
        """无参数；迁移微服务幂等记录、日程、缓存与用户资产，保持生产已存在的操作记录。"""
        if not (self.backup / "版本记录.json").exists():
            raise RuntimeError("必须先备份")
        src_root = self.backup / "legacy/runtime/microServices"
        for item in src_root.rglob("*"):
            if not item.is_file() or item.name.endswith((".lock", ".pid", ".log")):
                continue
            target = self.root / "runtime/microServices" / item.relative_to(src_root)
            if not target.exists() or item.name == "schedule.sqlite":
                self.copy_file(item, target)
            elif item.suffix == ".sqlite":
                src, out = sqlite3.connect(str(item)), sqlite3.connect(str(target))
                try:
                    tables = [n for n, in src.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
                    for table in tables:
                        cols = [x[1] for x in src.execute('PRAGMA table_info("' + table + '")')]
                        dest_cols = [x[1] for x in out.execute('PRAGMA table_info("' + table + '")')]
                        if cols != dest_cols:
                            raise RuntimeError("微服务数据结构不一致，停止合并")
                        names = ",".join('"' + c + '"' for c in cols)
                        out.executemany('INSERT OR IGNORE INTO "' + table + '" (' + names + ') VALUES ('
                                        + ",".join("?" for _ in cols) + ")",
                                        src.execute('SELECT ' + names + ' FROM "' + table + '"'))
                    out.commit()
                    if out.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                        raise RuntimeError("微服务数据库校验失败")
                finally:
                    src.close()
                    out.close()
        for name in ["tts", "videoDigest", "videoTest", "browser-profile", "browser-profile-digest",
                     "browser-profile-media", "browser-mcp-output", "cookies", "reports", "testReports"]:
            self.merge_tree(self.old / "runtime" / name, self.root / "runtime" / name)
        for name in ["observations.jsonl", "observations.history.jsonl", "kugou-player-state.json"]:
            src = self.old / "runtime" / name
            if src.exists():
                self.copy_file(src, self.root / "runtime" / name)
        print("service_data_migrated", self.report["files"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--backup", action="store_true")
    parser.add_argument("--migrate", action="store_true")
    parser.add_argument("--remaining-data", action="store_true")
    args = parser.parse_args()
    manager = ProductionMigration()
    if args.backup:
        manager.make_backup()
    if args.migrate:
        manager.migrate()
    if args.remaining_data:
        manager.migrate_service_data()
