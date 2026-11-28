"""功能：Windows 桌面 MCP 插件。把本机桌面操作以 MCP 工具形式统一暴露。

注册参数 root 为主项目 Path、config 为可选覆盖；默认读 config/windowsMcpConfig.json。
本插件只做协议透传（tools/list、tools/call），桌面能力由 windows_mcp 进程提供。
"""
import json
from pathlib import Path

from plugins.McpHttpClient import McpHttpClient


class WindowsPlugin:
    """Windows 桌面的唯一调用出口。"""

    description = "Windows 桌面 MCP：窗口、输入、系统操作（工具由 windows_mcp 提供）"

    def __init__(self, root, config=None):
        """root 为主项目 Path；config 可覆盖 url/token/python。"""
        self.root = Path(root)
        path = self.root / "config" / "windowsMcpConfig.json"
        data = json.loads(path.read_text("utf-8-sig")) if path.is_file() else {}
        data.update(dict(config or {}))
        self.url = str(data.get("url") or "http://127.0.0.1:17865/mcp")
        self.token = str(data.get("token") or "")
        self.timeout = float(data.get("toolCallTimeoutMs") or 120000) / 1000.0
        self.client = None

    def actions(self):
        """无参数；返回动作目录。"""
        return [
            {"name": "tools", "description": "列出桌面 MCP 提供的工具", "args": {}},
            {"name": "call", "description": "调用一个桌面工具",
             "args": {"tool": "工具名", "arguments": "工具参数对象"}},
        ]

    def call(self, action, payload):
        """action 为动作名、payload 为参数；返回结构化结果。"""
        client = self._ensure()
        if action == "tools":
            return client.tools()
        if action == "call":
            return client.call_tool(str(payload.get("tool") or ""),
                                    payload.get("arguments") or {})
        raise KeyError("未知动作：" + action)

    def _ensure(self):
        """无参数；按需创建 MCP 客户端。"""
        if self.client is None:
            self.client = McpHttpClient(self.url, token=self.token, timeout=self.timeout)
        return self.client
