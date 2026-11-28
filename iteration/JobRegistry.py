"""功能：自迭代任务登记表。每个任务只描述「做什么」，不负责调度与执行。

注册参数 path 为 config/iteration.json；默认包含预演、技能沉淀、夜间维护与日记归档。
任务字段：name、description、command（数组）、schedule（daily/interval/manual）、timeout、enabled。
"""

import json
from pathlib import Path


class JobRegistry:
    """读取与校验自迭代任务。"""

    def __init__(self, path):
        """path 为 iteration.json 路径。"""
        self.path = Path(path)
        data = json.loads(self.path.read_text("utf-8-sig")) if self.path.is_file() else {}
        self.jobs = {}
        for item in data.get("jobs") or []:
            name = str(item.get("name") or "").strip()
            command = item.get("command")
            if not name or not isinstance(command, list) or not command:
                continue
            self.jobs[name] = {
                "name": name,
                "description": str(item.get("description") or ""),
                "command": [str(part).replace("{python}", __import__("sys").executable)
                            .replace("{root}", str(self.path.parents[1]))
                            for part in command],
                "schedule": dict(item.get("schedule") or {"type": "manual"}),
                "timeout": int(item.get("timeout") or 3600),
                "retries": max(0, int(item.get("retries") or 0)),
                "retryMinutes": max(1, int(item.get("retryMinutes") or 30)),
                "enabled": bool(item.get("enabled", True)),
            }

    def list(self):
        """无参数；返回全部任务（按名称排序）。"""
        return [self.jobs[name] for name in sorted(self.jobs)]

    def get(self, name):
        """name 为任务名；返回任务或 None。"""
        return self.jobs.get(str(name))
