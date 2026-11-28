"""
视频/音频下载命令行：调用本机 yt-dlp 服务（不在就跑起来）。

用法：
    python tools\\downloadVideo.py "https://..." [--audio] [--out DIR] [--max-seconds 60]

行为：
- 端口没监听时后台拉起 services/ytdlpService.py（无窗口），等 /health；
- POST 下载，打印文件路径；服务闲置会自动退出，不常驻。
"""

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
SERVICE = ROOT / "services" / "ytdlpService.py"
LOG = ROOT / "runtime" / "ytdlp-server.log"
PORT = int(os.environ.get("YTDLP_PORT") or "8088")
BASE = f"http://127.0.0.1:{PORT}"


def port_open(port):
    """端口是否可连。"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.0):
            return True
    except OSError:
        return False


def ensure_service(idle_seconds):
    """服务没起来就后台拉起，并等健康检查通过。"""
    if port_open(PORT):
        return
    LOG.parent.mkdir(parents=True, exist_ok=True)
    flags = 0x08000000 | 0x00000008  # CREATE_NO_WINDOW | DETACHED_PROCESS
    with LOG.open("a", encoding="utf-8") as handle:
        subprocess.Popen(
            [sys.executable, str(SERVICE), "--port", str(PORT), "--idle-seconds", str(idle_seconds)],
            cwd=str(ROOT), stdout=handle, stderr=handle, creationflags=flags,
        )
    for _ in range(40):
        time.sleep(0.5)
        if port_open(PORT):
            return
    raise RuntimeError(f"yt-dlp 服务启动超时，见日志 {LOG}")


def main(argv):
    """入口。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--audio", action="store_true", help="只下音频并转 mp3")
    parser.add_argument("--out", default=str(ROOT / "runtime" / "downloads"))
    parser.add_argument("--max-seconds", type=int, default=0, help="只下前 N 秒（测试用）")
    parser.add_argument("--idle-seconds", type=int, default=120)
    args = parser.parse_args(argv)

    ensure_service(args.idle_seconds)
    payload = json.dumps({
        "url": args.url,
        "outDir": str(Path(args.out).resolve()),
        "audioOnly": args.audio,
        "maxSeconds": args.max_seconds,
    }, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(f"{BASE}/download", data=payload,
                                     headers={"Content-Type": "application/json"}, method="POST")
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=3600) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        print(f"下载失败 HTTP {error.code}: {body[:600]}")
        return 1
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        print(f"下载失败：{error}（日志 {LOG}）")
        return 1

    print(f"用时 {time.time() - started:.1f}s")
    for path in data.get("files", []):
        size = os.path.getsize(path) if os.path.isfile(path) else 0
        print(f"{path}  ({size / 1024 / 1024:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
