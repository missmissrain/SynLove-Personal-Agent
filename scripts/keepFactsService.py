"""：事实服务健康检查与自动重启，失败就修，不做降级。由计划任务每 1 分钟调用。"""

import io
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / "runtime" / "logs" / "facts-watchdog.log"
TASK = "SynLove-FactsService"
URL = "http://127.0.0.1:8802/health"


def log(text):
    """text为一行记录；追加并保留最近 200 行。"""
    LOG.parent.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write("%s %s\n" % (stamp, text))
    lines = LOG.read_text("utf-8").splitlines()
    if len(lines) > 200:
        LOG.write_text("\n".join(lines[-200:]) + "\n", "utf-8")


def healthy():
    """无参数；服务可用返回 True。"""
    try:
        with urllib.request.urlopen(URL, timeout=4) as response:
            return json.loads(response.read().decode("utf-8")).get("service") == "facts"
    except Exception:
        return False


def main():
    """无参数；健康就退出，不健康就重启任务并复查一次。"""
    if healthy():
        return
    log("facts service unhealthy, restarting")
    subprocess.run(["schtasks", "/End", "/TN", TASK], capture_output=True)
    time.sleep(1)
    subprocess.run(["schtasks", "/Run", "/TN", TASK], capture_output=True)
    time.sleep(5)
    log("restart result healthy=%s" % healthy())


if __name__ == "__main__":
    main()
