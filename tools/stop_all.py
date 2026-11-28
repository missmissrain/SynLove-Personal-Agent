"""全部停止：**先关前端（控制台/守护），再关后端（harness + 本地 Gemma）**。

为什么顺序必须是"前端先死"：
控制台里跑着"后端守护心跳"——探到后端掉线会自动把它拉起来。如果先杀后端，
守护会在几秒内把后端重新拉起来（表现为"怎么关都关不干净"）。所以这里
① 先写"暂停守护"标记，② 关掉控制台（守护随之消失），③ 最后才关后端。

用法：
    python tools/stop_all.py            # 关控制台 + 后端（保留 opencode server）
    python tools/stop_all.py --with-opencode   # 连 opencode server 一起关

也可以双击 `tools\\stop_all.cmd`（会自动带上 PYTHONUTF8=1，避免 .pth 编码问题）。
"""

from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stop_stack  # noqa: E402  （复用"停 harness"与"写暂停标记"的逻辑，避免两处实现漂移）

PROJECT_ROOT = Path(__file__).resolve().parents[1]
GEMMA_MARKER = "Gemma4"                      # 我们自己的本地模型路径特征（别误杀别的项目）
CONSOLE_MARKER = str(PROJECT_ROOT / "console")
CONSOLE_PORT = 3082
OPencode = ["opencode", "server"]            # opencode server 的命令行特征（默认不动它）


def port_free(port: int) -> bool:
    """端口是否已释放。"""
    sock = socket.socket()
    sock.settimeout(1.0)
    try:
        sock.connect(("127.0.0.1", port))
        return False
    except OSError:
        return True
    finally:
        sock.close()


def kill_matching(match) -> list[int]:
    """按命令行特征结束进程，返回被结束的 pid 列表。"""
    me = os.getpid()
    killed: list[int] = []
    for proc in stop_stack.list_processes():
        pid = proc.get("ProcessId")
        cmd = proc.get("CommandLine") or ""
        if pid is None or pid == me or not match(cmd):
            continue
        command = ["taskkill", "/F", "/T", "/PID", str(pid)] if os.name == "nt" else ["kill", "-9", str(pid)]
        subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        killed.append(pid)
    return killed


def main() -> int:
    """执行"先前端后后端"的停止流程。"""
    parser = argparse.ArgumentParser(description="全部停止（先关前端再关后端）")
    parser.add_argument("--with-opencode", action="store_true", help="连 opencode server 一起关")
    args = parser.parse_args()

    # ① 先按住守护，避免"边关边被拉起"
    marker = stop_stack.write_pause_marker("正在执行 stop_all（全部停止）", hours=1.0)
    print("guardian_pause=%s" % marker)

    # ② 关前端（控制台：先 Electron 外壳，再 node 服务进程）
    print("stop_frontend=先关控制台…")
    front = kill_matching(lambda cmd: "electron" in cmd.lower() and CONSOLE_MARKER.lower() in cmd.lower())
    front += kill_matching(lambda cmd: "server.mjs" in cmd and CONSOLE_MARKER.lower() in cmd.lower())
    for _ in range(10):
        if port_free(CONSOLE_PORT):
            break
        time.sleep(1)
    print("frontend_killed=%s console_port=%s" % (front, "free" if port_free(CONSOLE_PORT) else "still_listening"))

    # ③ 再关后端（harness + 我们自己的 Gemma）
    print("stop_backend=再关后端…")
    harness = stop_stack.kill_harness()
    gemma = kill_matching(lambda cmd: GEMMA_MARKER in cmd and "llama-server" in cmd.lower())
    if args.with_opencode:
        gemma += kill_matching(lambda cmd: all(word in cmd.lower() for word in OPencode) and "node" in cmd.lower())
    for _ in range(15):
        if port_free(3080) and port_free(8080):
            break
        time.sleep(2)
    print("harness_killed=%s" % harness)
    print("gemma_killed=%s" % gemma)
    print("ports_3080=%s ports_8080=%s" % (
        "free" if port_free(3080) else "still_listening",
        "free" if port_free(8080) else "still_listening",
    ))
    print("提示：要重新开始，双击桌面/启动文件夹里的控制台，或在项目目录跑 python start_stack.py")
    print("提示：自动重启守护现在是**暂停**状态（runtime/guardian.pause）；想恢复就在控制台点“恢复自动重启”")
    return 0


if __name__ == "__main__":
    sys.exit(main())
