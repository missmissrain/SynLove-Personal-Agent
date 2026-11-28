"""控制台外部看护（计划任务每 5 分钟跑一次）。

功能：当后端（3080/3081）都活着、但控制台（3082）掉了（electron 被杀/崩溃/单实例锁被占）时，
无界面地把控制台拉起来；用户主动"全停"（runtime/guardian.pause）时不动。

为什么需要它：electron 自己的 20 秒巡检只能覆盖"服务端子进程死了"，
覆盖不了"electron.exe 整个消失"——那时没有任何东西在盯 3082。

参数（均可选）：
    无（全部从环境变量读：CONTROL_PANEL_PORT 默认 3082，DSH_CONSOLE_HOUR_LIMIT 默认 4）
"""

import io
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONSOLE_DIR = ROOT / "console"
LOG_PATH = ROOT / "runtime" / "console-watch.log"
PAUSE_MARKER = ROOT / "runtime" / "guardian.pause"
ELECTRON = CONSOLE_DIR / "node_modules" / "electron" / "dist" / "electron.exe"
CONSOLE_PORT = int(os.environ.get("CONTROL_PANEL_PORT", "3082"))
BACKEND_PORTS = (3080, 3081)
HOUR_LIMIT = int(os.environ.get("DSH_CONSOLE_HOUR_LIMIT", "4"))
STATE_PATH = ROOT / "runtime" / "console-watch.json"


def append_log(message: str) -> None:
    """把一行带时间戳的记录追加到 runtime/console-watch.log。"""
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(f"{stamp} {message}\n")


def port_open(port: int, timeout: float = 1.0) -> bool:
    """探测本机某端口是否有服务在监听，返回是否可连。"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def recent_starts() -> list[float]:
    """读出最近一小时内的拉起时间戳（用于限速）。"""
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        stamps = [float(item) for item in data.get("starts", [])]
    except (OSError, ValueError, TypeError):
        stamps = []
    now = time.time()
    return [stamp for stamp in stamps if now - stamp < 3600]


def record_start() -> None:
    """记一次拉起时间，用于限速。"""
    stamps = recent_starts() + [time.time()]
    STATE_PATH.write_text(json.dumps({"starts": stamps}, ensure_ascii=False), encoding="utf-8")


def start_console() -> subprocess.Popen:
    """无界面地拉起控制台（electron --hidden），返回进程对象。"""
    flags = 0x08000000 | 0x20000000  # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    return subprocess.Popen(
        [str(ELECTRON), str(CONSOLE_DIR), "--hidden"],
        cwd=str(CONSOLE_DIR),
        creationflags=flags,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def kill_stale_electron() -> int:
    """杀掉"3082 已经不在、却还挂着"的旧 electron（单实例锁会挡住新实例），返回杀掉的进程数。"""
    script = (
        "$c=(Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | "
        f"Where-Object {{ $_.CommandLine -like '*{CONSOLE_DIR}*' }}); "
        "$n=0; foreach($p in $c){ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; $n"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", script],
            capture_output=True, text=True, timeout=30, encoding="utf-8", errors="replace",
            creationflags=0x08000000,  # CREATE_NO_WINDOW：别再每次闪一个控制台
        )
        text = (result.stdout or "").strip().splitlines()
        return int(text[-1]) if text and text[-1].isdigit() else 0
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0


def main() -> int:
    """看护主流程：暂停则退出；控制台活着则退出；后端活着但控制台掉了则拉起（限速）。"""
    if PAUSE_MARKER.exists():
        return 0
    if port_open(CONSOLE_PORT):
        return 0
    if not all(port_open(port) for port in BACKEND_PORTS):
        return 0  # 后端没起来时由 autostart / 守护负责，这里不抢
    if not ELECTRON.exists():
        append_log(f"控制台掉了，但找不到 {ELECTRON}")
        return 1
    stamps = recent_starts()
    if len(stamps) >= HOUR_LIMIT:
        append_log(f"控制台掉了，但本小时已拉起 {len(stamps)} 次，暂不拉（上限 {HOUR_LIMIT}）")
        return 0
    killed = kill_stale_electron()
    if killed:
        append_log(f"先清掉 {killed} 个残留 electron（单实例锁会挡住新实例）")
    process = start_console()
    record_start()
    append_log(f"控制台掉了（3082 DOWN，后端 UP），已无界面拉起，pid={process.pid}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
