"""功能：事实服务的唯一客户端，主进程只通过它读写事实，不直接碰文件。

注册参数base_url默认 127.0.0.1:8794，timeout为单次请求秒数；禁用系统代理。
失败时抛出 RuntimeError，由调用方决定降级；本类不做本地兜底，避免出现第二事实源。
"""
import json
import urllib.error
import urllib.request


class FactsClient:
    """与事实服务通信的唯一入口。"""

    def __init__(self, base_url="http://127.0.0.1:8802", timeout=3.0):
        """base_url为事实服务地址；timeout为单次请求秒数。"""
        self.base_url = base_url.rstrip("/")
        self.timeout = float(timeout)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def healthy(self):
        """无参数；服务可用返回 True，不抛异常。"""
        try:
            return bool(self._request("GET", "/health").get("ok"))
        except RuntimeError:
            return False

    def presence(self, ttl=None):
        """ttl为可接受的最大年龄秒数；返回在场事实，失败抛 RuntimeError。"""
        path = "/v1/facts/presence"
        if ttl:
            path += "?ttl=%d" % int(ttl)
        return self._request("GET", path).get("value") or {}

    def write_presence(self, value, source="unknown"):
        """value为完整在场结论、source为写入方；整体覆写并返回写入结果。"""
        reply = self._request("POST", "/v1/facts/presence",
                              {"value": value or {}, "source": source})
        return reply.get("value") or {}

    def update_presence_section(self, section, values, source="unknown"):
        """section为子节名、values为字段；只更新该子节并返回最新事实。"""
        reply = self._request("POST", "/v1/facts/presence",
                              {"section": section, "values": values or {}, "source": source})
        return reply.get("value") or {}

    def listening(self):
        """无参数；返回监听目标事实。"""
        return self._request("GET", "/v1/facts/listening").get("value") or {}

    def write_listening(self, value, source="unknown"):
        """value为完整监听状态；覆写并返回写入结果。"""
        reply = self._request("POST", "/v1/facts/listening",
                              {"value": value or {}, "source": source})
        return reply.get("value") or {}

    def _request(self, method, path, body=None):
        """method/path/body为请求要素；返回解析后的 JSON，失败抛 RuntimeError。"""
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        request = urllib.request.Request(self.base_url + path, data=data, method=method,
                                         headers={"Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise RuntimeError("事实服务不可用：" + type(error).__name__)


_SHARED = {}


def facts_client(base_url=None):
    """base_url为可选覆盖；返回进程内共享客户端，避免每次请求都新建连接。"""
    key = base_url or "default"
    if key not in _SHARED:
        _SHARED[key] = FactsClient(base_url) if base_url else FactsClient()
    return _SHARED[key]
