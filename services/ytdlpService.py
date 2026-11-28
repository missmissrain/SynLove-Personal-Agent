"""
视频/音频下载服务（yt-dlp，本地 HTTP）。

职责：
- `POST /download {"url": "...", "outDir": "...", "audioOnly": false}` → 下载并返回文件绝对路径；
- **闲置 N 秒自动退出**（释放端口），下次用的时候由 CLI 再拉起；
- 依赖 ffmpeg（已在 PATH），用于合并音视频/转码。

启动参数（均可选）：
    --port 8088        监听端口
    --idle-seconds 120 闲置多久自动退出（0=不退出）
"""

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "runtime", "downloads")

_state = {"last_active": time.time()}
_lock = threading.Lock()


def log(message):
    """带时间戳打印到 stdout（启动方重定向到日志）。"""
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def download(url, out_dir, audio_only, max_seconds, cookie_file=None):
    """下载一个链接，返回最终文件路径列表。"""
    import yt_dlp  # 延迟导入，服务启动更快

    os.makedirs(out_dir, exist_ok=True)
    opts = {
        "outtmpl": os.path.join(out_dir, "%(title).120s-%(id)s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": True,
        "windowsfilenames": True,
        "paths": {"home": out_dir},
    }
    if cookie_file:
        opts["cookiefile"] = cookie_file
    if audio_only:
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}]
    else:
        opts["format"] = "bv*+ba/b"
        opts["merge_output_format"] = "mp4"
    if max_seconds and max_seconds > 0:
        opts["download_ranges"] = yt_dlp.utils.download_range_func(None, [(0, max_seconds)])

    started = time.time()
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        if info is None:
            raise RuntimeError("yt-dlp 没有返回任何信息")
        if "entries" in info:
            info = info["entries"][0]
        path = ydl.prepare_filename(info)
        # 合并/转码后扩展名会变，按前缀找最终文件
        base = os.path.splitext(path)[0]
        candidates = [path]
        for ext in (".mp4", ".mkv", ".webm", ".mp3", ".m4a", ".opus"):
            candidates.append(base + ext)
        found = [item for item in candidates if os.path.isfile(item)]
        if not found:
            folder = os.path.dirname(path)
            prefix = os.path.basename(base)
            found = [os.path.join(folder, name) for name in os.listdir(folder) if name.startswith(prefix)] if os.path.isdir(folder) else []
        # 去重（同一个文件可能被多个候选扩展名命中）
        found = list(dict.fromkeys(found))
        if not found:
            raise RuntimeError("下载完成但找不到输出文件")
        log(f"下载完成：{os.path.basename(found[0])} 用时 {time.time() - started:.1f}s")
        return found


class Handler(BaseHTTPRequestHandler):
    """极简 HTTP：/health 与 /download。"""

    server_version = "ytdlp-service/1.0"

    def _reply(self, code, payload):
        """写 JSON 响应。"""
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        """健康检查。"""
        if self.path.startswith("/health"):
            return self._reply(200, {"ok": True, "version": self._version()})
        return self._reply(404, {"ok": False, "error": "unknown path"})

    @staticmethod
    def _version():
        """yt-dlp 版本号。"""
        try:
            import yt_dlp
            return yt_dlp.version.__version__
        except Exception:
            return "unknown"

    def do_POST(self):
        """下载入口。"""
        if not self.path.startswith("/download"):
            return self._reply(404, {"ok": False, "error": "unknown path"})
        try:
            length = int(self.headers.get("Content-Length") or "0")
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            url = str(payload.get("url", "")).strip()
            if not url:
                raise ValueError("url 不能为空")
            _state["last_active"] = time.time()
            out_dir = str(payload.get("outDir") or DEFAULT_OUT)
            files = download(url, out_dir, bool(payload.get("audioOnly")), int(payload.get("maxSeconds") or 0), payload.get("cookieFile") or None)
            _state["last_active"] = time.time()
            return self._reply(200, {"ok": True, "files": files})
        except Exception as error:  # noqa: BLE001
            log(f"下载失败：{type(error).__name__}: {error}")
            return self._reply(500, {"ok": False, "error": f"{type(error).__name__}: {error}"})

    def log_message(self, fmt, *args):  # noqa: D401
        """压掉默认访问日志。"""
        return


def idle_watchdog(idle_seconds):
    """闲置超时退出（释放端口）。"""
    if idle_seconds <= 0:
        return
    while True:
        time.sleep(max(5, idle_seconds // 4))
        if time.time() - _state["last_active"] >= idle_seconds:
            log(f"闲置 {idle_seconds}s，退出以释放端口")
            os._exit(0)


def main(argv):
    """入口。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8088)
    parser.add_argument("--idle-seconds", type=int, default=120)
    args = parser.parse_args(argv)
    threading.Thread(target=idle_watchdog, args=(args.idle_seconds,), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log(f"yt-dlp 服务启动：端口 {args.port} 闲置退出 {args.idle_seconds}s 版本 {Handler._version()}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main(sys.argv[1:])
