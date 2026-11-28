"""使用画像推断：从知识图谱、时间线、任务日志里找出主人最近常用的软件，并做 48 小时冷却过滤。

参数 root 为个人实例仓库根目录；config 为预演配置（含 appCatalog 与 devices）。

注册参数：
- appCatalog：软件清单，含 name/device/package/aliases/flow。
- lookbackDays：回看天数，默认 7。
- cooldownHours：同一软件两次预演的最小间隔，默认 48。
- deviceSnapshot：终端设备快照，用于判断 Windows 设备是否在线。
"""
import json
import os
import re
import sqlite3
import time
from pathlib import Path


class UsageInference:
    """按使用频率给候选软件打分，并剔除冷却中/不可用的项。"""

    def __init__(self, root, config):
        """root为仓库根目录，config为预演配置字典。"""
        self.root = Path(root)
        self.data = config
        self.catalog = [row for row in self.data.get("appCatalog", []) if row.get("name")]
        self.devices = self.data.get("devices") or {}

    def timeline_texts(self, days):
        """days为回看天数；返回 [(ts, text)]，跳过预演记录。"""
        base = self.root / "runtime" / "dsh" / "timeline" / "days"
        if not base.is_dir():
            return []
        cutoff = (time.time() - days * 86400) * 1000
        rows = []
        for path in sorted(base.glob("*.jsonl")):
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for line in lines:
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    item = json.loads(line)
                except Exception:
                    continue
                if item.get("role") == "rehearsal":
                    continue
                ts = int(item.get("ts") or 0)
                if ts < cutoff:
                    continue
                rows.append((ts, str(item.get("text") or "")))
        return rows

    def task_texts(self, days):
        """days为回看天数；返回 [(ts, text)]，取任务原始需求与结果摘要。"""
        db = self.root / "runtime" / "agentTasks" / "taskStore.sqlite"
        if not db.is_file():
            return []
        cutoff = int(time.time() - days * 86400)
        rows = []
        try:
            with sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=5) as conn:
                for created, origin, request in conn.execute(
                        "SELECT created, origin, request FROM agentTasks "
                        "WHERE created >= ? ORDER BY created DESC LIMIT 400", (cutoff * 1000,)):
                    text = str(request or "") + " " + str(origin or "")
                    rows.append((int(created or 0), text))
        except Exception:
            return rows
        return rows

    def graph_text(self):
        """无参数；读取知识图谱摘要，只作为加权参考。"""
        path = self.root / "runtime" / "dsh" / "graph" / "graph.md"
        return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""

    def installed_packages(self, packages):
        """packages为已装包名集合；返回可判断的集合（空集合表示未知，按可用处理）。"""
        return set(str(item) for item in (packages or []))

    def online_devices(self):
        """无参数；从终端快照读出在线设备 id 集合。"""
        path = self.root / str(self.data.get("deviceSnapshot") or "")
        if not path.is_file():
            return set()
        try:
            data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        except Exception:
            return set()
        return {str(item.get("id")) for item in data.get("devices", []) if item.get("online")}

    def score(self, rows, graph_text, days):
        """rows为 [(ts, text)]；返回 {软件名: (分数, 命中次数, 最近时间)}。"""
        now = time.time()
        result = {}
        for app in self.catalog:
            keys = [app["name"]] + [str(item) for item in app.get("aliases", [])]
            pattern = re.compile("|".join(re.escape(key) for key in keys if key), re.I)
            total, hits, last = 0.0, 0, 0
            for ts, text in rows:
                if not text:
                    continue
                found = len(pattern.findall(text))
                if found == 0:
                    continue
                age_days = max(0.0, (now - ts / 1000.0) / 86400.0)
                weight = 3.0 if age_days < 1 else 2.0 if age_days < 2 else 1.0
                total += found * weight
                hits += found
                last = max(last, ts)
            if graph_text:
                total += len(pattern.findall(graph_text)) * 2.0
            if hits:
                result[app["name"]] = (total, hits, last)
        return result

    def cooling(self, name, state):
        """name为软件名，state为预演状态；返回是否仍在冷却期。"""
        hours = float(self.data.get("cooldownHours") or 48)
        entry = (state.get("apps") or {}).get(name) or {}
        last = float(entry.get("at") or 0)
        return bool(last) and (time.time() - last) < hours * 3600

    def candidates(self, packages=None, state=None):
        """packages为手机已装包名，state为预演状态；返回按分数排序的候选列表。"""
        days = int(self.data.get("lookbackDays") or 7)
        rows = self.timeline_texts(days) + self.task_texts(days)
        graph = self.graph_text()
        scores = self.score(rows, graph, days)
        installed = self.installed_packages(packages)
        online = self.online_devices()
        state = state or {}
        out = []
        for app in self.catalog:
            name = app["name"]
            if name not in scores:
                continue
            total, hits, last = scores[name]
            device = str(app.get("device") or "sonyXperia5III")
            kind = (self.devices.get(device) or {}).get("kind") or "android"
            available = True
            reason = ""
            if kind == "android" and installed and app.get("package") and app["package"] not in installed:
                available, reason = False, "未安装"
            if kind == "windows" and online and device not in online:
                available, reason = False, "设备离线"
            cool = self.cooling(name, state)
            out.append({"name": name, "device": device, "kind": kind,
                        "score": round(total, 2), "hits": hits, "last_seen": last,
                        "flow": app.get("flow", ""), "available": available,
                        "reason": reason, "cooling": cool,
                        "ready": available and not cool})
        out.sort(key=lambda item: (-item["ready"], -item["score"]))
        return out

    def pick(self, packages=None, state=None):
        """packages/state同 candidates；返回本轮要预演的软件列表（最多 maxAppsPerRound）。"""
        limit = max(1, int(self.data.get("maxAppsPerRound") or 2))
        ready = [row for row in self.candidates(packages, state) if row["ready"]]
        return ready[:limit]
