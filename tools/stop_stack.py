"""停止欣爱（harness）后台进程。

用途：`switch_model.py`、控制台和人工维护都用它，避免"停服务"的逻辑散落在多份脚本里
（历史上就散过：一个放在系统临时目录的脚本被外部依赖着）。

注意：停之前会先写"暂停自动重启"标记（`runtime/guardian.pause`），
否则控制台的后端守护会把刚停掉的服务**立刻重新拉起来**（表现为"怎么停都停不掉"）。
要恢复自动重启：控制台「后端守护」卡片点"恢复自动重启"，或删掉那个标记文件。

用法：
    python tools/stop_stack.py                # 停止（并写"暂停守护"标记）
    python tools/stop_stack.py --no-pause     # 停止但不写标记（给"重启"用）
"""

from __future__ import annotations

import json
import argparse
import os
import re
import subprocess
import sys
import time
from pathlib import Path

# 判定"这是 harness 进程"的命令行特征（与 start_stack/控制台保持一致）
HARNESS_PATTERN = re.compile(r"apps[/\\]cli[/\\]lib[/\\]bin\.js|startHarnessBackend", re.I)
PROJECT_ROOT = Path(__file__).resolve().parents[1]
PAUSE_MARKER = PROJECT_ROOT / "runtime" / "guardian.pause"


def write_pause_marker(reason: str, hours: float = 24.0) -> Path:
    """写"暂停自动重启"标记，让控制台的守护不要把我刚停掉的服务拉回来。"""
    PAUSE_MARKER.parent.mkdir(parents=True, exist_ok=True)
    now_ms = int(time.time() * 1000)
    PAUSE_MARKER.write_text(
        json.dumps({"reason": reason, "until": now_ms + int(hours * 3_600_000), "at": now_ms},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return PAUSE_MARKER



def list_processes() -> list[dict]:
    """列出进程（Windows 走 PowerShell，其它平台走 ps）。"""
    if os.name != "nt":
        out = subprocess.run(["ps", "-eo", "pid=,args="], capture_output=True, text=True,
                             encoding="utf-8", errors="replace").stdout
        return [{"ProcessId": int(line.split(None, 1)[0]), "CommandLine": line.split(None, 1)[1]}
                for line in out.splitlines() if len(line.split(None, 1)) == 2]
    import json
    # 关键：显式让 PowerShell 输出 UTF-8，且 Python 也按 UTF-8 解码。
    # 否则在 PYTHONUTF8=1 / 中文 Windows 下会出现"命令行的中文按 GBK 输出、Python 按 UTF-8 解"
    # 的解码错误，结果**一个进程都没匹配到**（表现为"停不掉 harness"）。
    out = subprocess.run(
        ["powershell.exe", "-NoLogo", "-NoProfile", "-Command",
         "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
         "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
    ).stdout
    data = json.loads(out or "[]")
    return data if isinstance(data, list) else [data]


def kill_harness() -> list[int]:
    """结束 harness 进程，返回被结束的 pid 列表。"""
    me = os.getpid()
    killed: list[int] = []
    for proc in list_processes():
        pid = proc.get("ProcessId")
        cmd = proc.get("CommandLine") or ""
        if (pid is None or pid == me or not HARNESS_PATTERN.search(cmd)
                or str(PROJECT_ROOT).replace("\\", "/").lower() not in cmd.replace("\\", "/").lower()):
            continue
        command = ["taskkill", "/F", "/T", "/PID", str(pid)] if os.name == "nt" else ["kill", "-9", str(pid)]
        subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        killed.append(pid)
    return killed


def port_free(port: int) -> bool:
    """端口是否已释放。"""
    import socket
    sock = socket.socket()
    sock.settimeout(1.0)
    try:
        sock.connect(("127.0.0.1", port))
        return False
    except OSError:
        return True
    finally:
        sock.close()


def listeners_on(port: int) -> list[int]:
    """返回监听指定端口的进程 pid（Windows 用 Get-NetTCPConnection）。"""
    if os.name != "nt":
        return []
    script = (
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
        f"Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue "
        "| Select-Object -ExpandProperty OwningProcess"
    )
    out = subprocess.run(
        ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", script],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
    ).stdout
    return sorted({int(line.strip()) for line in out.splitlines() if line.strip().isdigit()})


def kill_port_owners(ports: tuple[int, ...] = (3080, 3081)) -> list[int]:
    """按"端口持有者"结束进程（含子进程树）。

    比"命令行特征匹配"可靠：pnpm/powershell 包装层的命令行里不一定带 harness 特征，
    历史上就漏杀过——旧进程继续占着 3080 和微信租约，新进程起来撞 EADDRINUSE 直接崩。
    """
    killed: list[int] = []
    me = os.getpid()
    owned = {proc.get("ProcessId") for proc in list_processes()
             if str(PROJECT_ROOT).replace("\\", "/").lower() in
             (proc.get("CommandLine") or "").replace("\\", "/").lower()
             and HARNESS_PATTERN.search(proc.get("CommandLine") or "")}
    for port in ports:
        for pid in listeners_on(port):
            if pid == me or pid not in owned:
                continue
            command = ["taskkill", "/F", "/T", "/PID", str(pid)] if os.name == "nt" else ["kill", "-9", str(pid)]
            subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            killed.append(pid)
    return killed


def main() -> int:
    """解析停栈范围和暂停时长；仅在目标端口释放、受管服务确认关闭后返回成功。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-pause", action="store_true")
    parser.add_argument("--pause-seconds", type=float, default=86400)
    parser.add_argument("--with-business", action="store_true")
    args = parser.parse_args()
    if args.pause_seconds <= 0:
        parser.error("--pause-seconds 必须大于0")
    # --no-pause：给"重启"用（马上还要起回来），不要留暂停标记把守护按住
    no_pause = args.no_pause
    if no_pause:
        print("guardian_pause=skipped(--no-pause)")
        if PAUSE_MARKER.exists():
            PAUSE_MARKER.unlink()
    else:
        marker = write_pause_marker("命令行执行了 tools/stop_stack.py（停止后端）",
                                    hours=args.pause_seconds / 3600)
        print("guardian_pause=%s" % marker)
    # ① 先按端口持有者杀（可靠），② 再按命令行匹配兜底（没监听端口但仍存活的残留进程）
    by_port = kill_port_owners()
    time.sleep(1)
    by_cmd = kill_harness()
    print("killed_by_port=%s" % by_port)
    print("killed_by_cmd=%s" % by_cmd)
    time.sleep(2)
    print("port3080=%s" % ("free" if port_free(3080) else "still_listening"))
    print("port3081=%s" % ("free" if port_free(3081) else "still_listening"))
    if not port_free(3080) or not port_free(3081):
        return 1
    if args.with_business:
        # 相对 argv 的 Node 会话服务不能靠命令行绝对路径识别；由服务身份和配置决定归属。
        sys.path.insert(0, str(PROJECT_ROOT))
        from microServices.ServiceManager import ServiceManager
        try:
            manager = ServiceManager(PROJECT_ROOT)
            states = manager.stop_managed_services()
            states["core"] = manager.stop_service("core")
            print("business_stopped=" + json.dumps(states, ensure_ascii=False))
        except Exception as error:
            print("business_stop_failed=" + type(error).__name__)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
