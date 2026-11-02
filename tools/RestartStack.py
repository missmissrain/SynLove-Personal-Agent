"""维护重启：先把后端（harness）停干净，再按标准启动流程拉起，最后验证两个端口就绪。

用途：控制台「重启后端服务（harness）」按钮的后台执行体（`console/server.mjs` 以分离方式
拉起本脚本后立刻返回，真正"停 → 起 → 验证"的活儿在这里做）。

为什么要单独一个脚本：控制台里直接 spawn 一个不存在的 `tools/RestartStack.py`，
按钮点下去只会静默失败（已按端口状态错乱过一次）。停和起都必须复用
`tools/stop_stack.py` 与 `start_stack.py`，不在这里重新实现一遍。

参数：
    --detach      控制台调用时会带上；脚本自身已经是分离进程，该参数只做兼容，默认 False
    --timeout     等待 3080/3081 同时就绪的上限秒数，默认 120

日志：runtime/restart-stack.log
退出码：0 = 两个端口都就绪；1 = 停止失败 / 启动超时 / 启动过程中被人工叫停。

最小权限原则：只动后端起停，不碰模型、人格、记忆与状态库。
"""

from __future__ import annotations

import argparse
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "runtime"
LOG_PATH = RUNTIME / "restart-stack.log"
PAUSE_MARKER = RUNTIME / "guardian.pause"
PORTS = (3080, 3081)
# 重启窗口内按住守护，避免它和我们同时拉起第二个消费者；过期后照常自愈
GUARD_HOLD_SECONDS = 300
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from services.ProcessLaunch import console_python, run_hidden, spawn_hidden  # noqa: E402


def log(message: str) -> None:
    """把一行结论写进重启日志。参数 message：要记录的文本（时间戳自动加）。"""
    RUNTIME.mkdir(parents=True, exist_ok=True)
    line = "[%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), message)
    with LOG_PATH.open("a", encoding="utf-8", errors="replace") as handle:
        handle.write(line + "\n")


def port_open(port: int) -> bool:
    """端口是否有人在监听。参数 port：端口号。"""
    sock = socket.socket()
    sock.settimeout(1.0)
    try:
        return sock.connect_ex(("127.0.0.1", port)) == 0
    except OSError:
        return False
    finally:
        sock.close()


def ports_ready() -> bool:
    """3080 与 3081 是否同时就绪（只认同时就绪，避免"起了一半"被当成成功）。"""
    return all(port_open(port) for port in PORTS)


def wait_ports(target: bool, timeout: float) -> bool:
    """等到两个端口同时达到目标状态。参数 target：True 等就绪、False 等释放；timeout：上限秒数。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if all(port_open(port) is target for port in PORTS):
            return True
        time.sleep(1.0)
    return all(port_open(port) is target for port in PORTS)


def run_stop(python: str) -> bool:
    """停后端：复用 stop_stack.py，带 5 分钟守护暂停（重启窗口内不许自愈插手）。"""
    command = [console_python(python), str(ROOT / "tools" / "stop_stack.py"),
               "--pause-seconds", str(GUARD_HOLD_SECONDS)]
    try:
        result = run_hidden(command, cwd=str(ROOT), capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=180)
    except (OSError, subprocess.SubprocessError) as error:
        log("停止失败：%s: %s" % (type(error).__name__, error))
        return False
    detail = " | ".join(((result.stdout or "") + (result.stderr or "")).split())[:400]
    log("停止结果 code=%d %s" % (result.returncode, detail))
    return result.returncode == 0


def start_stack(python: str, timeout: float) -> bool:
    """起后端：跑标准启动器并等它自己完成就绪检查，输出写进本日志。"""
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8", errors="replace") as handle:
        handle.write("===== %s 启动后端 =====\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
        handle.flush()
        try:
            # 用 python.exe + CREATE_NO_WINDOW（不是 DETACHED）：
            # 这样启动器及它拉起的整棵进程树共享一个隐藏控制台，不会闪黑框。
            process = spawn_hidden(
                [console_python(python), str(ROOT / "start_stack.py")],
                cwd=str(ROOT),
                stdout=handle, stderr=subprocess.STDOUT,
            )
        except (OSError, subprocess.SubprocessError) as error:
            log("启动失败：%s: %s" % (type(error).__name__, error))
            return False
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            log("启动器等待超时（%d 秒），改为按端口判定" % int(timeout))
            code = None
    log("启动器退出码=%s" % code)
    return code == 0 or ports_ready()


def main() -> int:
    """入口：停 → 等端口释放 → 起 → 等端口就绪 → 成功则解除守护暂停。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--detach", action="store_true")
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--skip-stop", action="store_true")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout 必须大于 0")

    python = sys.executable or "python"
    log("维护重启开始（python=%s，detach=%s）" % (python, args.detach))

    if not args.skip_stop:
        if not run_stop(python):
            log("停止未确认，放弃启动，避免两个消费者同时抢微信租约")
            return 1
        if not wait_ports(False, 30):
            log("3080/3081 仍未释放，放弃启动")
            return 1
        log("端口已释放，开始启动")

    if not start_stack(python, args.timeout):
        log("重启失败：后端未就绪，保留守护暂停等自愈")
        return 1

    if not wait_ports(True, 30):
        log("重启失败：启动器返回但端口没就绪")
        return 1

    if PAUSE_MARKER.is_file():
        try:
            PAUSE_MARKER.unlink()
            log("守护暂停已解除")
        except OSError as error:
            log("守护暂停未能解除：%s" % error)

    log("重启完成：3080/3081 均就绪")
    return 0


if __name__ == "__main__":
    sys.exit(main())
