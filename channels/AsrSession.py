"""功能：流式 ASR 的开启边界。终端只发开启请求，本类负责拉起/确认服务、加载模型并回报地址。

注册参数 root 为主项目 Path、config 为可选配置；默认读 config/voiceConfig.json。
服务未运行时自动拉起计划任务 SynLove-StreamingAsr，等待端口与模型就绪；失败抛 RuntimeError。
"""
import json
import os
import socket
import subprocess
import time
from pathlib import Path
from urllib.parse import urlsplit

from services.StreamingAsrClient import StreamingAsrClient


class AsrSession:
    """流式 ASR 的唯一开启入口。"""

    def __init__(self, root, config=None):
        """root 为主项目 Path；config 为可选配置（默认读 voiceConfig.json）。"""
        self.root = Path(root)
        self.config = dict(config or {})
        if not self.config:
            path = self.root / "config" / "voiceConfig.json"
            self.config = json.loads(path.read_text("utf-8-sig")) if path.is_file() else {}

    def open(self):
        """无参数；拉起并预热 ASR，返回 {ok, ws, ready, model, loadSeconds, started}。"""
        url = os.path.expandvars(str(self.config.get("asrStreamingURL")
                                  or "ws://127.0.0.1:10095"))
        model = os.path.expandvars(str(self.config.get("asrStreamingModel") or ""))
        started = time.monotonic()
        launched = self._ensure_running(url)
        client = StreamingAsrClient(url, timeout_seconds=30)
        if not client.available():
            raise RuntimeError("流式 ASR 客户端不可用（缺少 websocket-client 或地址为空）")
        if not client.warm(timeout=120):
            raise RuntimeError("流式 ASR 未能就绪：" + url)
        return {"ok": True, "ws": url, "ready": True, "model": model,
                "launched": launched,
                "loadSeconds": round(time.monotonic() - started, 1)}

    def _ensure_running(self, url, wait_seconds=90):
        """url 为 ws 地址；端口未监听时拉起计划任务并等待，返回是否由本次拉起。"""
        parsed = urlsplit(url)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 10095
        if self._port_open(host, port):
            return False
        result = subprocess.run(["schtasks", "/run", "/tn", "SynLove-StreamingAsr"],
                                capture_output=True)
        if result.returncode != 0:
            raise RuntimeError("流式 ASR 服务未运行且拉起失败，退出码 %d" % result.returncode)
        deadline = time.monotonic() + float(wait_seconds)
        while time.monotonic() < deadline:
            if self._port_open(host, port):
                return True
            time.sleep(1)
        raise RuntimeError("流式 ASR 服务在 %d 秒内未监听：%s:%d" % (wait_seconds, host, port))

    @staticmethod
    def _port_open(host, port, timeout=1.0):
        """host/port 为监听地址；返回端口是否可连接。"""
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return True
        except OSError:
            return False
