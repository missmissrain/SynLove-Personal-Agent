"""功能：极简 MCP 客户端（streamable HTTP）。只做 initialize 与工具调用，不实现业务。

注册参数 url 为 /mcp 地址、token 为可选 Bearer、timeout 为单次请求秒数。
连接失败、协议错误、SSE 解析失败都抛 RuntimeError，不返回空结果冒充成功。
"""
import json
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener


class McpHttpClient:
    """MCP 的 HTTP 传输客户端。"""

    def __init__(self, url, token="", timeout=120):
        """url 为 MCP 地址；token 为可选鉴权；timeout 为单次请求秒数。"""
        self.url = url
        self.token = token
        self.timeout = float(timeout)
        self.session = None
        self.initialized = False
        self._opener = build_opener(ProxyHandler({}))
        self._next_id = 1

    def tools(self):
        """无参数；返回 MCP 工具列表。"""
        result = self._call("tools/list", {})
        return result.get("tools") or []

    def call_tool(self, name, arguments=None):
        """name 为工具名、arguments 为参数；返回 MCP 工具结果。"""
        if not name:
            raise ValueError("call_tool 需要 name")
        return self._call("tools/call", {"name": name, "arguments": arguments or {}})

    def _call(self, method, params):
        """method/params 为 JSON-RPC 方法与参数；返回 result 字典。"""
        self._ensure()
        reply = self._post({"jsonrpc": "2.0", "id": self._id(), "method": method,
                            "params": params})
        if "error" in reply:
            error = reply["error"]
            raise RuntimeError("%s 失败：%s" % (method, error.get("message") or error))
        return reply.get("result") or {}

    def _ensure(self):
        """无参数；完成一次 initialize 与 initialized 通知。"""
        if self.initialized:
            return
        reply = self._post({"jsonrpc": "2.0", "id": self._id(), "method": "initialize",
                            "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                       "clientInfo": {"name": "synlove-plugins",
                                                      "version": "1.0.0"}}})
        if "error" in reply:
            raise RuntimeError("MCP 初始化失败：%s" % (reply["error"].get("message") or ""))
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.initialized = True

    def _post(self, payload):
        """payload 为 JSON-RPC 消息；返回解析后的响应字典。"""
        headers = {"Content-Type": "application/json",
                   "Accept": "application/json, text/event-stream"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
            headers["X-Auth-Token"] = self.token
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = Request(self.url, data=data, headers=headers, method="POST")
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                session = response.headers.get("Mcp-Session-Id")
                if session:
                    self.session = session
                content_type = response.headers.get("Content-Type", "")
                body = response.read()
        except HTTPError as error:
            raise RuntimeError("MCP HTTP %d" % error.code)
        except Exception as error:  # noqa: BLE001
            raise RuntimeError("MCP 连接失败：%s" % type(error).__name__)
        if not body:
            return {}
        text = body.decode("utf-8", "replace")
        if "text/event-stream" in content_type:
            value = None
            for line in text.splitlines():
                if not line.startswith("data:"):
                    continue
                chunk = line[5:].strip()
                if not chunk or chunk == "[DONE]":
                    continue
                try:
                    parsed = json.loads(chunk)
                except ValueError:
                    continue
                if isinstance(parsed, dict) and ("result" in parsed or "error" in parsed):
                    value = parsed
            if value is None:
                raise RuntimeError("MCP 返回了无法解析的事件流")
            return value
        try:
            return json.loads(text)
        except ValueError:
            raise RuntimeError("MCP 返回了非 JSON 内容")

    def _id(self):
        """无参数；返回下一个 JSON-RPC 请求 id。"""
        self._next_id += 1
        return self._next_id
