"""视频下载步骤：优先用本机 yt-dlp 服务（不在就唤起），需要登录的站点先走浏览器 cookie。

职责：
- 输入 URL → 调 services/ytdlpService.py（8088）下载，返回本地路径；
- 已知要登录的站点：先用 Playwright 读本机浏览器 cookie（tools/edgeSession.mjs），
  没有登录态就**弹登录窗口**等用户登录，登录后导出 cookie 再下载；
- 输入本地文件 → 原样返回。

注册参数：
    port / idleSeconds          服务端口与闲置退出
    login.timeoutSeconds        弹窗后等登录的秒数，默认 180
    login.sites                 需要登录的域名后缀列表
"""

import io
import json
import os
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent.parent
SERVICE = ROOT / "services" / "ytdlpService.py"
LOG = ROOT / "runtime" / "ytdlp-server.log"
EDGE_SESSION = ROOT / "tools" / "edgeSession.mjs"
NODE = os.environ.get("DSH_NODE") or "node"


class loginRequired(RuntimeError):
    """需要用户先在浏览器里登录。"""


class videoDownloader:
    """把一个视频 URL（或本地路径）落到本地磁盘。"""

    def __init__(self, config, out_dir, login_config=None):
        """config：ytdlp 段；out_dir：下载目录；login_config：登录相关配置。"""
        self.port = int(config.get("port", 8088))
        self.idle = int(config.get("idleSeconds", 60))
        self.out_dir = Path(out_dir)
        login_config = login_config or {}
        self.login_timeout = int(login_config.get("timeoutSeconds", 180))
        self.login_sites = list(login_config.get("sites", [
            "bilibili.com", "xiaohongshu.com", "douyin.com", "weibo.com", "zhihu.com", "youtube.com",
        ]))

    def _port_open(self):
        """服务是否已监听。"""
        try:
            with socket.create_connection(("127.0.0.1", self.port), timeout=1.0):
                return True
        except OSError:
            return False

    def _ensure(self):
        """服务不在就后台拉起。"""
        if self._port_open():
            return
        LOG.parent.mkdir(parents=True, exist_ok=True)
        flags = 0x08000000 | 0x00000008
        with LOG.open("a", encoding="utf-8") as handle:
            subprocess.Popen(
                [sys.executable, str(SERVICE), "--port", str(self.port), "--idle-seconds", str(self.idle)],
                cwd=str(ROOT), stdout=handle, stderr=handle, creationflags=flags,
            )
        for _ in range(40):
            time.sleep(0.5)
            if self._port_open():
                return
        raise RuntimeError(f"yt-dlp 服务启动超时，见日志 {LOG}")

    def _needs_login(self, url):
        """URL 是否属于需要登录的站点。"""
        host = urllib.parse.urlparse(url).netloc.lower()
        return any(host.endswith(site) for site in self.login_sites)

    def _cookie_file(self, url):
        """确保有该站 cookie：先 check，没登录就弹窗等；返回 cookie 文件或 None。"""
        host = urllib.parse.urlparse(url).netloc.lower()
        domain = next((site for site in self.login_sites if host.endswith(site)), None)
        if domain is None:
            return None
        out = ROOT / "runtime" / "cookies" / f"{domain}.txt"
        if os.environ.get("SYNLOVE_SERVICE_WORKER") == "1":
            # 无头服务器不弹登录窗；由管理员预先提供服务器自己的cookie文件。
            if out.is_file() and out.stat().st_size:
                return str(out)
            raise loginRequired(f"{domain} 缺少服务端cookie，请预先配置，不会打开本机浏览器")
        check = subprocess.run(
            [NODE, str(EDGE_SESSION), "--check", f"--domain={domain}", f"--out={out}"],
            cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if check.returncode == 0:
            print(f"[登录] 已复用本机浏览器登录态（{domain}）", flush=True)
            return str(out)

        print(f"[登录] {domain} 登录态缺失或已过期，正在打开登录窗口…", flush=True)
        login = subprocess.run(
            [NODE, str(EDGE_SESSION), f"--domain={domain}", f"--url={url}",
             f"--out={out}", f"--timeout={self.login_timeout}"],
            cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if login.returncode == 0:
            print(f"[登录] 登录成功，已导出 cookie：{out.name}", flush=True)
            return str(out)
        raise loginRequired(
            f"{domain} 需要登录：已弹出登录窗口（{self.login_timeout} 秒内未完成）。"
            f"请在弹出的浏览器里登录后重新运行。"
        )

    def fetch(self, target):
        """下载/接收视频，返回本地绝对路径。"""
        if Path(target).is_file():
            return str(Path(target).resolve())
        self.out_dir.mkdir(parents=True, exist_ok=True)

        cookie_file = None
        if self._needs_login(target):
            cookie_file = self._cookie_file(target)
        if os.environ.get("SYNLOVE_SERVICE_WORKER") == "1":
            # 下载属于视频服务内部步骤，不再唤起另一个本机8088常驻服务。
            from services.ytdlpService import download
            files = download(target, str(self.out_dir), False, None, cookie_file)
            if not files:
                raise RuntimeError("下载完成但没有返回文件")
            return str(Path(files[0]).resolve())
        self._ensure()

        payload = {"url": target, "outDir": str(self.out_dir)}
        if cookie_file:
            payload["cookieFile"] = cookie_file
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/download",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        started = time.time()
        try:
            with urllib.request.urlopen(request, timeout=1800) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", "replace")
            if cookie_file is None and ("login" in body.lower() or "403" in body or "412" in body):
                raise loginRequired(f"下载被拒绝（可能需要登录）：{body[:200]}")
            raise RuntimeError(f"下载失败：{body[:300]}")

        files = data.get("files") or []
        if not files:
            raise RuntimeError("下载完成但没有返回文件")
        print(f"[下载] 完成：{Path(files[0]).name}（{time.time() - started:.1f}s）", flush=True)
        return str(Path(files[0]))
