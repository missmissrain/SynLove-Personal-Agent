"""业务任务中转客户端。参数cfg含固定Hub地址、能力名与CA；只使用现有VPS任务API，不向私网猜端口。"""

import json
import time
import uuid
import urllib.request
from services.ServiceCredential import ServiceCredential
from services.ServiceTls import ServiceTls


class RelayBusinessClient:
    """一条HTTP业务请求对应一个中转任务，写操作出错后保留业务ID，不自动重提。"""

    def __init__(self, cfg):
        """cfg为服务注册配置，relayCapability为服务端已注册能力名。"""
        self.cfg = cfg
        self.base = cfg["baseURL"].rstrip("/")

    def request_hub(self, method, path, data=None, content_type="application/json", limit=8*1024*1024):
        """method/path为固定Hub接口，data为字节；验证TLS、禁止重定向并限制响应。"""
        headers = {"Content-Type": content_type}
        key = ServiceCredential.resolve_key(self.cfg)
        if key:
            headers["Authorization"] = "Bearer " + key
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=ServiceTls.create_context(self.cfg)))
        for handler in opener.handlers:
            if isinstance(handler, urllib.request.HTTPRedirectHandler):
                handler.redirect_request = lambda *args, **kwargs: None
        with opener.open(req, timeout=min(float(self.cfg["timeoutSeconds"]), 60)) as res:
            out = res.read(limit + 1)
            if len(out) > limit:
                raise ValueError("中转响应超过限制")
            return out

    def request(self, method, path, body=None, content_type="application/json", limit=8*1024*1024):
        """method/path为业务白名单接口；文件通过Hub附件传输，返回原业务响应字节。"""
        capability = self.cfg.get("relayCapability")
        if capability not in ("crawlerCenter", "webCollection", "scheduler", "video"):
            raise ValueError("没有配置合法的远端业务能力")
        if path == "/health":
            catalog = json.loads(self.request_hub("GET", "/capabilities"))
            if not any(row["name"] == capability and row.get("nodes", 0) > 0 and
                       row.get("capacity", 0) > 0 for row in catalog.get("capabilities", [])):
                raise RuntimeError("家庭节点尚未注册此后台能力")
        args = {"method": method, "path": "/v1" + path if path != "/health" else path}
        payload = {"capability": capability, "input": args,
                   "timeoutMs": min(120000, int(float(self.cfg["timeoutSeconds"]) * 1000))}
        kind = "application/json"
        if body is not None and content_type == "application/octet-stream":
            if len(body) > 30 * 1024 * 1024:
                raise ValueError("VPS附件上传限制30MiB；更大视频请传公开视频URL或使用直连")
            boundary = "SynLove" + uuid.uuid4().hex
            prefix = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"capability\"\r\n\r\n"
                      f"{capability}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"input\"\r\n\r\n"
                      f"{json.dumps({'input': args})}\r\n--{boundary}\r\n"
                      "Content-Disposition: form-data; name=\"file\"; filename=\"input.bin\"\r\n"
                      "Content-Type: application/octet-stream\r\n\r\n").encode()
            data = prefix + body + f"\r\n--{boundary}--\r\n".encode()
            kind = "multipart/form-data; boundary=" + boundary
        else:
            if body:
                args["body"] = json.loads(body)
            data = json.dumps(payload).encode()
        view = json.loads(self.request_hub("POST", "/tasks", data, kind))
        # Hub创建返回task视图；成功后只查询该ID，不重发原操作。
        view = view.get("task", view)
        ident = view["id"]
        deadline = time.monotonic() + max(120, float(self.cfg["timeoutSeconds"]))
        while view.get("status") not in ("done", "failed", "expired", "cancelled"):
            if time.monotonic() >= deadline:
                raise TimeoutError("等待中转超时，任务ID=" + ident)
            time.sleep(0.25)
            view = json.loads(self.request_hub("GET", "/tasks/" + ident))
        if view["status"] != "done":
            raise RuntimeError("远端任务失败；任务ID=" + ident)
        result = view.get("payload") or {}
        if not 200 <= result.get("status", 0) < 300:
            raise RuntimeError("业务接口返回HTTP " + str(result.get("status", "未知")))
        if result.get("binary"):
            return self.request_hub("GET", "/tasks/" + ident + "/attachments/0", limit=limit)
        return json.dumps(result["body"], ensure_ascii=False).encode()
