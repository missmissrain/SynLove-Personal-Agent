"""功能：跨仓库唯一的 HTTP JSON 客户端，集中处理鉴权、代理、重定向、超时与响应上限。

注册参数 base 为固定源站、token 为内存凭据、timeout 为默认秒数、limit 为默认字节上限；
默认禁用代理与重定向，不输出令牌与正文。path 传入绝对 URL 时忽略 base。
opener 允许调用方注入已配置 TLS 校验的 opener，用于固定证书的中转链路。
本模块不读文件、不读环境变量，凭据由调用方从维护类取得后传入。
"""

import json
import urllib.request

DEFAULT_LIMIT = 1024 * 1024


def encode_json(data):
    """data 为待提交对象；None 表示无正文，其余按 UTF-8 编码且不转义中文。"""
    return None if data is None else json.dumps(data, ensure_ascii=False).encode("utf-8")


def decode_json(raw, limit=None, message="响应过大"):
    """raw 为响应字节；limit 为字节上限，超过即报错，返回解析后的对象。"""
    if limit is not None and len(raw) > limit:
        raise ValueError(message)
    return json.loads(raw)


class JsonHttpClient:
    """固定源站与鉴权方式的 JSON 请求客户端。"""

    def __init__(self, base="", token="", timeout=15.0, limit=DEFAULT_LIMIT,
                 require_ok=False, error_message="服务拒绝请求", proxy=False,
                 redirect=False, headers=None, opener=None):
        """base/token 为源站与凭据；timeout/limit 为默认等待与上限；require_ok 决定是否校验 ok 字段。"""
        self.base = (base or "").rstrip("/")
        self.token = token
        self.timeout = float(timeout)
        self.limit = int(limit)
        self.require_ok = require_ok
        self.error_message = error_message
        self.headers = dict(headers or {})
        self.opener = opener if opener is not None else self._build_opener(proxy, redirect)

    @staticmethod
    def _build_opener(proxy, redirect):
        """proxy/redirect 为是否允许代理与跳转；返回按策略装配的 opener。"""
        handlers = []
        if not proxy:
            handlers.append(urllib.request.ProxyHandler({}))
        opener = urllib.request.build_opener(*handlers)
        if not redirect:
            for handler in opener.handlers:
                if isinstance(handler, urllib.request.HTTPRedirectHandler):
                    handler.redirect_request = lambda *args, **kwargs: None
        return opener

    def request_json(self, method, path, data=None, timeout=None, limit=None, token=None,
                     headers=None, require_ok=None, message=None):
        """method/path/data 为请求内容；timeout/limit/token/headers 可覆盖默认；返回解析后的对象。"""
        url = path if "://" in path else self.base + path
        wait = self.timeout if timeout is None else max(.001, float(timeout))
        cap = self.limit if limit is None else int(limit)
        merged = {"Content-Type": "application/json"}
        merged.update(self.headers)
        merged.update(headers or {})
        value = self.token if token is None else token
        if value is not None:
            merged["Authorization"] = "Bearer " + value
        request = urllib.request.Request(url, encode_json(data), merged, method=method)
        with self.opener.open(request, timeout=wait) as response:
            raw = response.read(cap + 1)
        result = decode_json(raw, cap, message or "响应过大")
        if (self.require_ok if require_ok is None else require_ok) and not result.get("ok"):
            raise RuntimeError(self.error_message)
        return result
