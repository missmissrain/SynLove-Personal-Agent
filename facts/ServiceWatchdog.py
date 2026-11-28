"""功能：事实层唯一的服务看门狗。按配置探测每个服务是否在线，必要时拉起缺失的托管服务。

注册参数 root 为主项目 Path、config 为可选配置（默认 config/watchdog.json）；
默认 30 秒一轮、连续 2 次失败判离线、拉起冷却 300 秒、每小时最多 3 次。
只做探活与拉起，不修改业务数据；结论写 runtime/facts/services.json，状态变化写 watchdog.log。
"""
import io
import logging
import json
import socket
import subprocess
import threading
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener
from urllib.parse import urlsplit

LOG = logging.getLogger("synlove.watchdog")


class ServiceWatchdog:
    """所有服务在线状态的唯一判定者。"""

    def __init__(self, root, config=None):
        """root 为主项目 Path；config 为看门狗配置，缺省读 config/watchdog.json。"""
        self.root = Path(root)
        self.path = self.root / "config" / "watchdog.json"
        self.dir = self.root / "runtime" / "facts"
        self.snapshot_path = self.dir / "services.json"
        self.log_path = self.dir / "watchdog.log"
        data = dict(config or {})
        if not data:
            data = json.loads(self.path.read_text("utf-8-sig")) if self.path.is_file() else {}
        self.interval = max(5.0, float(data.get("intervalSeconds") or 30))
        self.threshold = max(1, int(data.get("failThreshold") or 2))
        self.cooldown = max(30.0, float(data.get("restartCooldownSeconds") or 300))
        self.max_restarts = max(1, int(data.get("maxRestartsPerHour") or 3))
        self.timeout = max(1.0, float(data.get("timeoutSeconds") or 3))
        self.services = [item for item in (data.get("services") or [])
                         if isinstance(item, dict) and item.get("name")]
        self.state = {}
        for item in self.services:
            self.state[item["name"]] = {"online": None, "failures": 0, "lastSeenAt": 0,
                                        "lastError": "", "restarts": 0, "lastRestartAt": 0,
                                        "restartHistory": []}
        self.rounds = 0
        self.checked_at = 0.0
        self._stop = threading.Event()
        self._thread = None
        self._lock = threading.RLock()
        self.dir.mkdir(parents=True, exist_ok=True)

    def start(self):
        """无参数；启动探活线程并立即检查一轮，重复调用不会重复起线程。"""
        if self._thread and self._thread.is_alive():
            return self
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="SynLoveWatchdog")
        self._thread.start()
        return self

    def stop(self):
        """无参数；停止探活线程。"""
        self._stop.set()

    def snapshot(self):
        """无参数；返回最近一轮的在线结论与失败原因。"""
        with self._lock:
            items = []
            for item in self.services:
                value = dict(self.state[item["name"]])
                value.update({"name": item["name"], "target": self._target(item),
                              "restartable": bool(item.get("task")),
                              "task": item.get("task", ""), "note": item.get("note", "")})
                value.pop("restartHistory", None)
                items.append(value)
            offline = [value["name"] for value in items if value["online"] is False]
            return {"checkedAt": self.checked_at, "rounds": self.rounds,
                    "intervalSeconds": self.interval, "offline": offline,
                    "count": {"total": len(items), "online": len(items) - len(offline),
                              "offline": len(offline)},
                    "services": items}

    def check_once(self):
        """无参数；把所有服务探测一遍，返回本轮快照。"""
        now = time.time()
        for item in self.services:
            name = item["name"]
            ok, error = self._probe(item)
            with self._lock:
                value = self.state[name]
                before = value["online"]
                if ok:
                    value.update({"online": True, "failures": 0, "lastSeenAt": now,
                                  "lastError": ""})
                    if before is False:
                        self._log("恢复 %s %s" % (name, self._target(item)))
                else:
                    value["failures"] = int(value["failures"]) + 1
                    value["lastError"] = error
                    if before is not False and value["failures"] >= self.threshold:
                        value["online"] = False
                        self._log("离线 %s %s：%s" % (name, self._target(item), error))
                offline = value["online"] is False
            if offline:
                self._restart(item, now)
        with self._lock:
            self.rounds += 1
            self.checked_at = now
            payload = self.snapshot()
        self._save(payload)
        return payload

    def _loop(self):
        """无参数；按间隔探活，异常只记录不退出。"""
        while not self._stop.is_set():
            try:
                self.check_once()
            except Exception as error:  # noqa: BLE001 —— 看门狗自己不能把事实服务带崩
                self._log("探活异常 %s: %s" % (type(error).__name__, str(error)[:120]))
            self._stop.wait(self.interval)

    def _probe(self, item):
        """item 为服务配置；有 url 走 HTTP 健康检查，否则走 TCP 连接，返回(在线, 错误)。"""
        url = str(item.get("url") or "").strip()
        if url:
            opener = build_opener(ProxyHandler({}))
            try:
                with opener.open(url, timeout=self.timeout) as response:
                    status = getattr(response, "status", 200)
                if 200 <= int(status) < 400:
                    return True, ""
                return False, "HTTP %s" % status
            except HTTPError as error:
                return False, "HTTP %d" % error.code
            except Exception as error:  # noqa: BLE001
                return False, type(error).__name__
        host = str(item.get("host") or "127.0.0.1")
        port = int(item.get("port") or 0)
        if not port:
            return False, "配置缺少 url 或 port"
        try:
            with socket.create_connection((host, port), timeout=self.timeout):
                return True, ""
        except OSError as error:
            return False, type(error).__name__

    def _restart(self, item, now):
        """item 为服务配置、now 为当前秒；按冷却与频率上限拉起计划任务，返回是否已触发。"""
        name = item["name"]
        task = str(item.get("task") or "").strip()
        if not task:
            return False
        with self._lock:
            value = self.state[name]
            history = [stamp for stamp in value["restartHistory"] if now - stamp < 3600]
            if now - float(value["lastRestartAt"] or 0) < self.cooldown:
                value["restartHistory"] = history
                return False
            if len(history) >= self.max_restarts:
                value["restartHistory"] = history
                value["lastError"] = "一小时内已拉起 %d 次，暂停自动重启" % len(history)
                return False
            history.append(now)
            value["restartHistory"] = history
            value["lastRestartAt"] = now
            value["restarts"] = int(value["restarts"]) + 1
        done = subprocess.run(["schtasks", "/run", "/tn", task], capture_output=True, timeout=30)
        if done.returncode != 0:
            detail = done.stderr.decode("gbk", "replace").strip()[:80]
            with self._lock:
                self.state[name]["lastError"] = "拉起失败：%s" % (detail or done.returncode)
            self._log("拉起失败 %s 任务=%s %s" % (name, task, detail))
            return False
        self._log("拉起 %s 任务=%s" % (name, task))
        return True

    def _target(self, item):
        """item 为服务配置；返回人类可读的探测目标。"""
        url = str(item.get("url") or "").strip()
        if url:
            return urlsplit(url).netloc + (urlsplit(url).path or "/")
        return "%s:%s" % (item.get("host") or "127.0.0.1", item.get("port") or "?")

    def _save(self, payload):
        """payload 为本轮快照；原子写入状态文件。"""
        temp = self.snapshot_path.with_suffix(".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")
        temp.replace(self.snapshot_path)

    def _log(self, message):
        """message 为状态变化或拉起记录；同时写入本地 watchdog.log 与总日志。"""
        LOG.info(message)
        try:
            with io.open(self.log_path, "a", encoding="utf-8") as handle:
                handle.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), message))
        except OSError:
            pass
