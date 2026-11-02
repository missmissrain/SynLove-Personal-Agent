"""旧调度迁移。LegacyServiceMigration(root,roots) 仅识别指定根目录的提醒进程与新闻任务，默认只预检。"""

import json
import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path


class LegacyServiceMigration:
    """先保存旧任务定义，再停用旧调度；不复制、删除或覆盖聊天及业务数据库。"""

    def __init__(self, root, roots=None, registry=None):
        """root为新服务根目录，roots为允许迁移的安装列表，registry可指定独立配置。"""
        self.root = Path(root).resolve()
        self.registry = registry
        self.roots_path = self.root / "runtime" / "microServices" / "migrationRoots.json"
        if roots is None and self.roots_path.is_file():
            roots = json.loads(self.roots_path.read_text(encoding="utf-8"))
        # 当前生产目录也必须加入白名单：计划任务可能已指向当前目录，
        # 但它仍是旧调度器，只有允许识别后才能安全停用并迁移到新服务。
        candidates = [Path(path).resolve() for path in (roots or [root])]
        current = self.root.resolve()
        self.roots = [current, *[path for path in candidates if path != current]]

    def reminder_processes(self):
        """无参数；只返回指定目录中真实Python解释器执行的reminderService.py --loop。"""
        from tools.stop_stack import list_processes
        matches = []
        for row in list_processes():
            name = str(row.get("Name", "")).lower()
            if not re.fullmatch(r"python(?:w|3(?:\.\d+)?)?(?:\.exe)?", name):
                continue
            cmd = str(row.get("CommandLine") or "").replace("\\", "/").lower()
            if not re.search(r"(?:^|\s)--loop(?:\s|$)", cmd):
                continue
            for root in self.roots:
                path = (root / "reminders" / "reminderService.py").as_posix().lower()
                if re.search(r"(?:^|[\s\"'])" + re.escape(path) + r"(?=[\s\"']|$)", cmd):
                    matches.append(row)
                    break
        return matches

    def news_task(self):
        """无参数；读取固定旧任务XML；任务存在但不属于指定工程时拒绝修改。"""
        if os.name != "nt":
            return None
        name = os.environ.get("DIGEST_TASK_NAME", "SynLoveNewsDigest")
        result = subprocess.run(["schtasks", "/Query", "/TN", name, "/XML"],
                                capture_output=True, timeout=30,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:
            # Query失败不能解释为任务不存在，使用枚举确认；权限不足同样阻止迁移。
            check = subprocess.run(["schtasks", "/Query", "/FO", "CSV", "/NH"],
                                   capture_output=True, timeout=30,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
            if check.returncode or name.lower().encode() in check.stdout.lower():
                raise RuntimeError("旧新闻任务无法读取，需先检查任务权限")
            return None
        data = result.stdout
        if data[:2] in (b"\xff\xfe", b"\xfe\xff") or data[1:2] == b"\x00":
            xml = data.decode("utf-16")
        else:
            try:
                xml = data.decode("utf-8-sig")
            except UnicodeDecodeError:
                # schtasks在中文Windows可能声明UTF-16，却实际输出系统代码页字节。
                xml = data.decode("mbcs")
        xml = re.sub(r'encoding=["\'][^"\']+["\']', 'encoding="UTF-8"', xml, count=1)
        tree = ET.fromstring(xml)
        ns = {"t": "http://schemas.microsoft.com/windows/2004/02/mit/task"}
        action = " ".join((item.text or "") for item in tree.findall(".//t:Exec/*", ns))
        normalized = action.replace("\\", "/").lower()
        owned = any((root / "newsDigest" / "runDigestTask.cmd").as_posix().lower() in normalized
                    or (root / "newsDigest" / "runDigest.py").as_posix().lower() in normalized
                    for root in self.roots)
        if not owned:
            raise RuntimeError("同名新闻计划任务不属于允许迁移的目录，拒绝接管")
        boundary = tree.findtext(".//t:CalendarTrigger/t:StartBoundary", "", ns)
        clock = boundary.split("T")[-1][:5]
        if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", clock):
            raise RuntimeError("旧新闻计划不是可迁移的每日时间定义")
        enabled = tree.findtext("./t:Settings/t:Enabled", "true", ns).lower() != "false"
        return {"name": name, "xml": xml, "time": clock, "enabled": enabled}

    def check(self):
        """无参数；有存活旧消费者或旧任务仍启用时，拒绝启动第二套调度。"""
        rows, task = self.reminder_processes(), self.news_task()
        if rows or (task and task["enabled"]):
            raise RuntimeError("检测到旧调度；先运行 tools/ServiceControl.py migrate --apply 完成迁移")

    def migrate(self, apply=False):
        """apply默认False只报告；True先备份XML，再停旧进程、停用旧任务并迁移每日时刻。"""
        rows, task = self.reminder_processes(), self.news_task()
        result = {"reminderPids": [row["ProcessId"] for row in rows],
                  "newsTask": None if not task else {key: task[key] for key in ("name", "time", "enabled")},
                  "applied": apply}
        if not apply:
            return result
        from microServices.ServiceManager import ServiceManager
        manager = ServiceManager(self.root, self.registry)
        if any(manager.is_ready(name) for name in ("reminders", "digest")):
            raise RuntimeError("提醒或新闻API服务仍在运行，请先停止再迁移")
        backup = self.root / "runtime" / "microServices" / "migration" / time.strftime("%Y%m%d-%H%M%S")
        backup.mkdir(parents=True, exist_ok=False)
        (backup / "migration.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        self.roots_path.write_text(json.dumps([str(path) for path in self.roots], ensure_ascii=False),
                                   encoding="utf-8")
        if task:
            (backup / "newsTask.xml").write_text(task["xml"], encoding="utf-8")
            action = subprocess.run(["schtasks", "/Change", "/TN", task["name"], "/DISABLE"],
                                    capture_output=True, timeout=30,
                                    creationflags=subprocess.CREATE_NO_WINDOW)
            if action.returncode:
                raise RuntimeError("旧新闻任务未停用，新调度不启用")
            subprocess.run(["schtasks", "/End", "/TN", task["name"]], capture_output=True, timeout=30,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        # 再次检查命令行，不能根据历史pid误杀复用该pid的其他进程。
        live = {row["ProcessId"]: row for row in self.reminder_processes()}
        for pid in result["reminderPids"]:
            if pid not in live:
                continue
            command = ["taskkill", "/F", "/T", "/PID", str(pid)] if os.name == "nt" else ["kill", "-TERM", str(pid)]
            stopped = subprocess.run(command, capture_output=True, timeout=30)
            if stopped.returncode:
                raise RuntimeError("旧提醒调度停止失败，新服务不得启动")
        if task:
            from microServices.ScheduleStore import ScheduleStore
            from services.ServiceRegistry import ServiceRegistry
            cfg = (self.registry or ServiceRegistry()).get_service("digest")
            state = Path(cfg.get("dataDir") or self.root / "runtime" / "microServices" / "digest")
            if not state.is_absolute():
                state = self.root / state
            existed = (state / "schedule.sqlite").is_file()
            store = ScheduleStore(self.root, state / "schedule.sqlite")
            with store.connect() as conn:
                # 已经存在的 schedule.sqlite 是新服务当前生效的配置，重复迁移
                # 不能再用旧计划任务的时间覆盖用户后来调整过的时刻。
                if not existed:
                    conn.execute("UPDATE schedule SET hhmm=?,enabled=? WHERE id=1",
                                 (task["time"], int(task["enabled"])))
                # 不知道旧任务今天是否已发过，迁移当天不补发新闻；明日起使用新调度。
                conn.execute("UPDATE schedule SET day=? WHERE id=1", (time.strftime("%Y-%m-%d"),))
        notify = self.root / "reminders" / "config" / "reminderConfig.json"
        if not notify.exists():
            old = self.root / "newsDigest" / "config" / "newsDigest.json"
            config = json.loads(old.read_text(encoding="utf-8-sig"))
            notify.parent.mkdir(parents=True, exist_ok=True)
            with notify.open("x", encoding="utf-8") as handle:
                json.dump({"push": config.get("push", {})}, handle, ensure_ascii=False, indent=2)
        self.check()
        result["backup"] = str(backup)
        return result
