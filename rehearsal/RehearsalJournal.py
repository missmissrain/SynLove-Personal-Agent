"""预演日志：把每轮预演写进时间线（不新建数据库，也不打扰主人）。

参数 root 为个人实例仓库根目录；registry 不再必需，直接读 config/rehearsal.json。

注册参数：
- timelineDays：runtime/dsh/timeline/days（append-only JSONL）。
- timelineIndex：runtime/dsh/timeline/index.json，用于累加条数。
- 去重：runtime/rehearsal-state.json 里 apps[<名字>].journaled 记录已记账的 delivery。
"""
import json
import os
import sqlite3
import time
from pathlib import Path


class RehearsalJournal:
    """把已结束的预演任务写成时间线条目，并顺带记录产出的 skill。"""

    role = "rehearsal"

    def __init__(self, root, config):
        """root为仓库根目录，config为预演配置字典。"""
        self.root = Path(root)
        self.config = config or {}
        self.days = self.root / "runtime" / "dsh" / "timeline" / "days"
        self.index = self.root / "runtime" / "dsh" / "timeline" / "index.json"
        self.tasks = self.root / "runtime" / "agentTasks" / "taskStore.sqlite"
        self.state_path = self.root / str(self.config.get("stateFile") or "runtime/rehearsal-state.json")
        self.skill_root = self.root / str(self.config.get("skillRoot") or "runtime/dsh/rehearsalSkills")

    def state(self):
        """无参数；读取预演状态。"""
        if not self.state_path.is_file():
            return {}
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8-sig"))
        except Exception:
            return {}

    def save_state(self, state):
        """state为状态字典；原子写入。"""
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.state_path)

    def find_task(self, delivery):
        """delivery为注入编号；返回 (task_id, state) 或 None。"""
        if not delivery or not self.tasks.is_file():
            return None
        try:
            with sqlite3.connect(self.tasks.as_uri() + "?mode=ro", uri=True, timeout=5) as db:
                row = db.execute(
                    "SELECT id, state FROM agentTasks WHERE origin LIKE ? ORDER BY created DESC LIMIT 1",
                    ("%" + str(delivery) + "%",)).fetchone()
            return (row[0], row[1]) if row else None
        except Exception:
            return None

    def steps(self, task_id):
        """task_id为任务；返回进度条数。"""
        path = self.root / "runtime" / "agentTasks" / "progress" / (str(task_id) + ".jsonl")
        if not path.is_file():
            return 0
        try:
            return sum(1 for line in path.read_text(encoding="utf-8", errors="replace").splitlines()
                       if line.strip().startswith("{"))
        except Exception:
            return 0

    def skills_since(self, since_ts):
        """since_ts为秒级时间；返回此后更新过的预演 skill 目录名。"""
        if not self.skill_root.is_dir():
            return []
        out = []
        for path in self.skill_root.iterdir():
            if not path.is_dir():
                continue
            skill = path / "SKILL.md"
            try:
                if skill.is_file() and skill.stat().st_mtime >= since_ts:
                    out.append(path.name)
            except OSError:
                continue
        return sorted(out)

    def append_timeline(self, text, ts_ms):
        """text为正文，ts_ms为毫秒时间；写入当日 JSONL 并累加索引。"""
        date = time.strftime("%Y-%m-%d", time.localtime(ts_ms / 1000))
        self.days.mkdir(parents=True, exist_ok=True)
        path = self.days / (date + ".jsonl")
        entry = {"id": "rehearsal:%d" % ts_ms, "ts": ts_ms, "role": self.role, "text": text,
                 "kind": "rehearsal", "user_id": "rehearsal@local", "session_id": "rehearsal"}
        if path.is_file():
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                if '"' + entry["id"] + '"' in line:
                    return False
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        self.bump_index(date, ts_ms)
        return True

    def bump_index(self, date, ts_ms):
        """date为日期，ts_ms为时间；尽力累加索引里的条数。"""
        try:
            data = json.loads(self.index.read_text(encoding="utf-8-sig")) if self.index.is_file() else {}
        except Exception:
            return
        days = data.setdefault("days", {})
        meta = days.setdefault(date, {"date": date, "timezone": "Asia/Shanghai",
                                      "entries": 0, "user_entries": 0, "assistant_entries": 0})
        meta["entries"] = int(meta.get("entries") or 0) + 1
        meta["rehearsal_entries"] = int(meta.get("rehearsal_entries") or 0) + 1
        meta.setdefault("first_ts", ts_ms)
        meta["last_ts"] = max(int(meta.get("last_ts") or 0), ts_ms)
        meta["updated_at"] = int(time.time() * 1000)
        data["updated_at"] = int(time.time() * 1000)
        try:
            tmp = self.index.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, self.index)
        except Exception:
            pass

    def journal_pending(self):
        """无参数；把已结束但未记账的预演写进时间线，返回新增文本列表。"""
        state = self.state()
        apps = state.get("apps") or {}
        written = []
        changed = False
        for name, entry in list(apps.items()):
            delivery = entry.get("delivery")
            if not delivery or delivery in (entry.get("journaled") or []):
                continue
            found = self.find_task(delivery)
            if found is None:
                continue
            task_id, task_state = found
            if task_state not in ("succeeded", "partial", "failed", "cancelled", "interrupted"):
                continue
            since = float(entry.get("at") or 0)
            skills = self.skills_since(since) if since else []
            text = "[预演] %s（%s）→ %s（%d 步）· %s" % (
                name, entry.get("device") or "?", task_state, self.steps(task_id),
                ("产出 " + "、".join(skills)) if skills else "本轮没有产出 skill")
            if self.append_timeline(text, int(time.time() * 1000)):
                written.append(text)
            entry["journaled"] = list(entry.get("journaled") or []) + [delivery]
            entry["last_outcome"] = task_state
            apps[name] = entry
            changed = True
        if changed:
            state["apps"] = apps
            self.save_state(state)
        return written
