"""功能：自迭代调度器。按 daily/interval 计算下次执行，单飞执行子进程，状态落盘。

注册参数 root 为主项目 Path、registry 为任务表；默认状态在 runtime/iteration/state.json。
只负责调度与记录，不解释任务输出；失败写状态但不中断服务。
"""

import json
import logging
import subprocess
import threading
import time
from pathlib import Path

LOG = logging.getLogger("synlove.iteration")


class Scheduler:
    """自迭代任务的唯一调度者。"""

    def __init__(self, root, registry):
        """root 为主项目 Path；registry 为 JobRegistry。"""
        self.root = Path(root)
        self.registry = registry
        self.dir = self.root / "runtime" / "iteration"
        self.state_path = self.dir / "state.json"
        self.logs = self.dir / "logs"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.logs.mkdir(parents=True, exist_ok=True)
        self.state = json.loads(self.state_path.read_text("utf-8")) if self.state_path.is_file() else {}
        self.lock = threading.RLock()
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        """无参数；启动调度线程，重复调用不会重复起线程。"""
        if self._thread and self._thread.is_alive():
            return self
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="SynLoveSelfIteration")
        self._thread.start()
        return self

    def stop(self):
        """无参数；停止调度线程。"""
        self._stop.set()

    def status(self):
        """无参数；返回各任务的状态与下次执行时间。"""
        with self.lock:
            items = []
            for job in self.registry.list():
                value = dict(self.state.get(job["name"]) or {})
                value.update({"name": job["name"], "description": job["description"],
                              "schedule": job["schedule"], "enabled": job["enabled"]})
                items.append(value)
            return {"updatedAt": time.time(), "jobs": items}

    def run(self, name, wait=True):
        """name 为任务名；wait 为是否等待完成，返回执行状态。"""
        job = self.registry.get(name)
        if job is None:
            raise KeyError("未登记的任务：" + str(name))
        with self.lock:
            current = self.state.get(name) or {}
            if current.get("running"):
                raise RuntimeError("任务正在执行：" + name)
            current.update({"running": True, "startedAt": time.time(), "error": ""})
            LOG.info("任务开始 %s", name)
            self.state[name] = current
            self._save()
        thread = threading.Thread(target=self._execute, args=(job,), daemon=True,
                                  name="SynLoveJob-" + name)
        thread.start()
        if wait:
            thread.join(timeout=job["timeout"] + 5)
        with self.lock:
            return dict(self.state.get(name) or {})

    def _loop(self):
        """无参数；每 30 秒检查一次到期任务。"""
        while not self._stop.is_set():
            try:
                self._tick(time.time())
            except Exception:
                pass
            self._stop.wait(5)

    def _tick(self, now):
        """now 为当前秒；到期任务逐个启动，不阻塞调度线程。"""
        for job in self.registry.list():
            if not job["enabled"]:
                continue
            with self.lock:
                value = dict(self.state.get(job["name"]) or {})
                next_at = float(value.get("nextAt") or 0)
                running = bool(value.get("running"))
            if running:
                continue
            if next_at <= 0:
                self._plan(job, now)
                continue
            if now >= next_at:
                try:
                    self.run(job["name"], wait=False)
                except RuntimeError:
                    pass

    def _plan(self, job, now):
        """job 为任务、now 为基准时间；写入下一次执行时间。"""
        schedule = job["schedule"] if isinstance(job["schedule"], dict) else {}
        kind = str(schedule.get("type") or "manual")
        with self.lock:
            value = dict(self.state.get(job["name"]) or {})
            if kind == "interval":
                if schedule.get("seconds") is not None:
                    value["nextAt"] = now + max(5.0, float(schedule.get("seconds") or 30))
                else:
                    minutes = max(1.0, float(schedule.get("minutes") or 60))
                    value["nextAt"] = now + minutes * 60
            elif kind == "daily":
                at = str(schedule.get("at") or "03:00")
                hour, minute = [int(part) for part in at.split(":")[:2]]
                local = time.localtime(now)
                target = time.mktime((local.tm_year, local.tm_mon, local.tm_mday, hour, minute,
                                      0, 0, 0, -1))
                if target <= now:
                    target += 86400
                value["nextAt"] = target
            else:
                value["nextAt"] = 0
            self.state[job["name"]] = value
            self._save()

    def _execute(self, job):
        """job 为任务；执行子进程并记录结果。"""
        name = job["name"]
        started = time.time()
        log_path = self.logs / (name + ".log")
        try:
            with log_path.open("ab") as handle:
                handle.write(("\n===== %s =====\n" % time.strftime("%Y-%m-%d %H:%M:%S")).encode())
                done = subprocess.run(job["command"], cwd=str(self.root), stdout=handle,
                                      stderr=subprocess.STDOUT, timeout=job["timeout"])
            code, error = done.returncode, ""
        except subprocess.TimeoutExpired:
            code, error = -1, "timeout"
        except Exception as exc:
            code, error = -1, type(exc).__name__
        with self.lock:
            value = self.state.get(name) or {}
            value.update({"running": False, "finishedAt": time.time(),
                          "seconds": round(time.time() - started, 1),
                          "exitCode": code, "error": error})
            self.state[name] = value
            self._save()
        if code == 0:
            LOG.info("任务完成 %s 用时 %.1fs", name, time.time() - started)
        else:
            LOG.error("任务失败 %s exit=%s %s", name, code, error or "")
        self._plan_after(job, code)

    def _plan_after(self, job, code):
        """job 为任务、code 为退出码；失败且未超重试次数就顺延重试，成功则排下一次计划。"""
        with self.lock:
            value = dict(self.state.get(job["name"]) or {})
            attempts = int(value.get("attempts") or 0)
        attempts = 0 if code == 0 else attempts + 1
        if code != 0 and attempts <= int(job.get("retries") or 0):
            with self.lock:
                value = dict(self.state.get(job["name"]) or {})
                value["attempts"] = attempts
                value["nextAt"] = time.time() + float(job.get("retryMinutes") or 30) * 60.0
                self.state[job["name"]] = value
                self._save()
            return
        with self.lock:
            value = dict(self.state.get(job["name"]) or {})
            value["attempts"] = 0
            self.state[job["name"]] = value
        self._plan(job, time.time())

    def _save(self):
        """无参数；原子写入状态文件。"""
        temp = self.state_path.with_suffix(".tmp")
        temp.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self.state_path)
