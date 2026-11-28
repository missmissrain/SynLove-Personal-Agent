"""看门狗：发现 10095 未监听就重新拉起流式 ASR 任务。

功能：检查本机 10095 端口；未监听时调用 schtasks 启动 SynLove-StreamingAsr。
注册参数：无；端口与任务名固定，便于计划任务每 5 分钟执行。
"""

import socket
import subprocess
import sys


def listening(port=10095):
    """port 为端口号；返回是否已有进程监听。"""
    with socket.socket() as sock:
        sock.settimeout(2)
        return sock.connect_ex(("127.0.0.1", port)) == 0


if __name__ == "__main__":
    if listening():
        print("streaming-asr ok")
        sys.exit(0)
    done = subprocess.run(["schtasks", "/Run", "/TN", "SynLove-StreamingAsr"],
                          capture_output=True)
    print("restart", done.returncode,
          done.stdout.decode("gbk", "replace").strip()[:120])
