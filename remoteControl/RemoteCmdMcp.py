"""本机远控 MCP 适配器：由 Harness 管理 stdio 子进程，无 HTTP 端口或独立守护。

注册参数 tools 可注入测试替身；默认根目录为当前模块上级，使用同目录配置与密钥。
支持 initialize、ping、tools/list、tools/call；每行一个 JSON-RPC 消息，不向 stdout 打印日志。
"""

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from remoteControl.RemoteCmdClient import RemoteCmdClient
from remoteControl.RemoteCmdTools import RemoteCmdTools
from remoteControl.RemoteTargetConfig import RemoteTargetConfig


class RemoteCmdMcp:
    """把远控业务映射到 MCP，不负责网络部署、账号创建或自动修复。"""

    def __init__(self, tools=None):
        """tools 为可选工具集合；默认使用本生产目录内的配置和执行器。"""
        config = RemoteTargetConfig(ROOT)
        self.tools = tools or RemoteCmdTools(config, RemoteCmdClient(config))

    def handle_message(self, message):
        """message 为 JSON-RPC 请求；通知不响应，异常参数以标准错误返回。"""
        if not isinstance(message, dict):
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
        if "id" not in message:
            return None
        result = {"jsonrpc": "2.0", "id": message["id"]}
        method = message.get("method")
        params = message.get("params", {})
        if not isinstance(params, dict):
            return {**result, "error": {"code": -32602, "message": "Invalid params"}}
        if method == "initialize":
            value = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                     "serverInfo": {"name": "synlove-remote-cmd", "version": "1.0.0"},
                     "instructions": "远控先列出电脑别名；目标不明确就问用户。只执行已授权操作，不读取或回显凭据。失败或超时不自动重做；超时不代表远端进程已停止。"}
        elif method == "ping":
            value = {}
        elif method == "tools/list":
            value = {"tools": self.tools.list_tools()}
            # MCP 协议独占 stdout；只在发现工具时向宿主日志写一条无隐私诊断。
            sys.stderr.write("[remote-cmd] pid=%s tools/list=3\n" % os.getpid())
            sys.stderr.flush()
        elif method == "tools/call":
            value = self.tools.call_tool(params.get("name"), params.get("arguments", {}))
        else:
            return {**result, "error": {"code": -32601, "message": "Method not found"}}
        return {**result, "result": value}

    def run_stdio(self):
        """无参数；读取 UTF-8 JSON 行并输出协议响应，单请求超时由执行器负责。"""
        for raw in sys.stdin:
            try:
                response = self.handle_message(json.loads(raw))
            except json.JSONDecodeError:
                response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
            if response is not None:
                sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                sys.stdout.flush()


if __name__ == "__main__":
    RemoteCmdMcp().run_stdio()
