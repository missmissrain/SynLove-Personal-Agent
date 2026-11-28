"""浏览器采集源：调用 tools/browserMcp/extractNews.mjs（Playwright MCP + 本机 Edge）抓列表。

职责：
- 用**独立 browser profile**（runtime/browser-profile-digest）启动，避免和 harness 里常驻的
  Playwright MCP 抢同一个 profile（一个 profile 同时只能被一个浏览器占用）；
- 抓完把 JSON 读回来，做去重与字段校验，返回 list[dict]；
- 全程打印步骤与耗时，方便在 cmd 前台观察。

注册参数（来自配置 browser 段）：
    node             node.exe 路径
    extractorScript  extractNews.mjs 绝对路径
    profileDir       浏览器 profile 目录
    timeoutSeconds   子进程超时，默认 120 秒
"""

import json
import subprocess
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:  # 极老的解释器没有 reconfigure
    pass


class browserSource:
    """把"某个新闻列表页"抓成结构化条目列表。"""

    def __init__(self, root, browser_config):
        """root：项目根目录；browser_config：配置里的 browser 段（node/脚本/profile/超时）。"""
        self.root = Path(root)
        self.node = browser_config.get("node") or "node"
        self.script = browser_config["extractorScript"]
        self.profile = browser_config["profileDir"]
        self.timeout = int(browser_config.get("timeoutSeconds", 120))

    def fetch(self, url, limit):
        """打开列表页并取回条目（time/title/url），失败抛异常。

        url：列表页地址；limit：最多取多少条。
        """
        out_path = self.root / "runtime" / "news-raw.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        command = [
            self.node, self.script,
            f"--limit={int(limit)}",
            f"--url={url}",
            f"--profile={self.profile}",
            f"--save={out_path}",
        ]
        started = time.time()
        print(f"[采集] 启动浏览器 {Path(self.script).name} …", flush=True)
        result = subprocess.run(
            command, cwd=str(self.root), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=self.timeout,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip()[-1200:]
            raise RuntimeError(f"浏览器采集失败（退出码 {result.returncode}）：{detail}")
        if not out_path.exists():
            raise RuntimeError(f"采集脚本没有产出文件：{out_path}")
        rows = json.loads(out_path.read_text(encoding="utf-8-sig"))
        cleaned = [
            {"time": str(row.get("time", "")), "title": str(row.get("title", "")).strip(), "url": str(row.get("url", ""))}
            for row in rows
            if str(row.get("title", "")).strip() and str(row.get("url", "")).startswith("http")
        ]
        print(f"[采集] 完成：{len(cleaned)} 条，用时 {time.time() - started:.1f}s", flush=True)
        return cleaned
