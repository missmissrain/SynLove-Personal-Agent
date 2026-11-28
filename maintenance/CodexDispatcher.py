"""Codex执行设备路由：默认天选，确认离线后才使用服务器；已提交任务不跨设备重放。

参数root为主仓库，settings为私有自迭代配置；复用签名命令及16KiB文件传输。
维护源码与补丁均校验SHA256。任务状态保存到runtime/codexDispatch，禁止失联即重复提交。
"""
import base64
import hashlib
import json
import sys
import time
import zipfile
from pathlib import Path


class CodexDispatcher:
    """为skill与代码维护提供统一独立上下文执行器。"""

    def __init__(self, root, settings):
        """root为主仓库；settings含primaryDevice、fallbackLocal、primaryInbox与timeoutSec。"""
        self.root, self.settings = Path(root), settings
        config = self.root / "config/terminalConnection.json"
        bridge = json.loads(config.read_text(encoding="utf-8-sig"))
        repo = Path(bridge.get("repositoryRoot") or self.root.parent / "terminal-pc")
        if not repo.is_absolute():
            repo = self.root / repo
        sys.path.insert(0, str(repo))
        from terminalConnection.client.TerminalApiClient import TerminalApiClient
        from terminalConnection.client.CodexJob import CodexJob
        self.client = TerminalApiClient(bridge)
        self.local = CodexJob(self.root / "runtime/maintenanceExecutor")
        self.home = self.root / "runtime/codexDispatch"
        self.home.mkdir(parents=True, exist_ok=True)

    def select_device(self):
        """查询真实设备状态；管理器不可达不视为天选离线，避免两端重复执行。"""
        device = self.settings.get("primaryDevice", "tianxuanLaptop")
        if device == "server":
            return None
        rows = self.client.request_json("GET", "/v1/devices")["devices"]
        found = next((r for r in rows if r["id"] == device), None)
        if found and found.get("online"):
            if "coding.run" not in found.get("capabilities", []):
                raise RuntimeError("首选终端在线但未更新编码能力，不能误判为离线")
            return device
        if self.settings.get("fallbackLocal", True):
            return None
        raise RuntimeError("首选终端离线，且本机兜底已关闭")

    def remote_request(self, device, kind, args):
        """device为已选终端，kind为固定协议；pending保留请求ID，不重新提交。"""
        value = self.client.execute_command(device, {"type": kind, "params": args}, wait_seconds=45)
        if value.get("pending"):
            raise RuntimeError("终端指令已提交尚未确认：" + str(value.get("requestId")))
        if not value.get("ok"):
            raise RuntimeError("终端执行失败：" + str(value.get("error", "unknown")))
        return value

    def upload_file(self, device, file, target):
        """file为本轮源码ZIP，target为终端既有runtime下的唯一文件；提交校验哈希。"""
        begin = self.remote_request(device, "file", {"action": "begin", "path": target})
        ident, offset = begin["uploadId"], 0
        digest = hashlib.sha256()
        with Path(file).open("rb") as stream:
            for part in iter(lambda: stream.read(16384), b""):
                self.remote_request(device, "file", {"action": "write", "uploadId": ident,
                    "offset": offset, "data": base64.b64encode(part).decode()})
                digest.update(part)
                offset += len(part)
        self.remote_request(device, "file", {"action": "commit", "uploadId": ident, "sha256": digest.hexdigest()})

    def read_file(self, device, path, size, digest):
        """读取完成产物，校验长度及SHA256；超过2MiB拒绝，不将源码输出塞进模型上下文。"""
        if size > 2 * 1024 * 1024 or size < 0:
            raise RuntimeError("Codex产物超限")
        if device is None:
            data = Path(path).read_bytes()
        else:
            data = bytearray()
            while len(data) < size:
                row = self.remote_request(device, "file", {"action": "read", "path": path,
                    "offset": len(data), "size": min(16384, size - len(data))})
                chunk = base64.b64decode(row["data"], validate=True)
                if not chunk:
                    raise RuntimeError("远端产物提前结束")
                data.extend(chunk)
            data = bytes(data)
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError("Codex产物校验失败")
        return data

    def execute_task(self, prompt, work=None, timeout=None):
        """prompt为脱敏任务，work为可选隔离源码；返回独立Codex结果及可选补丁。"""
        timeout = min(3600, max(30, int(timeout or self.settings.get("timeoutSec", 900))))
        archive = None
        digest = hashlib.sha256(prompt.encode("utf-8"))
        if work is not None:
            archive = self.home / ("source-" + str(time.time_ns()) + ".zip")
            with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as writer:
                for file in sorted(Path(work).rglob("*")):
                    rel = file.relative_to(work)
                    if file.is_file() and ".git" not in rel.parts:
                        writer.write(file, rel.as_posix())
                        digest.update(rel.as_posix().encode())
                        digest.update(file.read_bytes())
        ident = digest.hexdigest()[:32]
        receipt = self.home / (ident + ".json")
        if receipt.exists():
            record = json.loads(receipt.read_text(encoding="utf-8"))
            device = record["device"]
            submitted = record.get("submitted", False)
        else:
            device, submitted = self.select_device(), False
        request = {"action": "start", "jobId": ident, "prompt": prompt, "timeoutSec": timeout}
        if archive:
            if device is None:
                request["archive"] = str(archive)
            else:
                target = str(Path(self.settings["primaryInbox"]) / (ident + ".zip"))
                if not submitted:
                    self.upload_file(device, archive, target)
                request["archive"] = target
        receipt.write_text(json.dumps({"device": device, "jobId": ident, "submitted": True,
                                       "state": "submission_started"}), encoding="utf-8")
        # jobId幂等；网络丢失重查同一jobId，不选择另一设备。
        value = (self.local.run_request(request) if device is None
                 else self.remote_request(device, "codex_job", request))
        deadline = time.monotonic() + timeout + 120
        while value.get("state") not in ("done", "failed"):
            if time.monotonic() > deadline:
                raise RuntimeError("Codex结果未确认，保留任务ID：" + ident)
            time.sleep(2)
            query = {"action": "status", "jobId": ident}
            value = (self.local.run_request(query) if device is None
                     else self.remote_request(device, "codex_job", query))
        receipt.write_text(json.dumps({"device": device, "jobId": ident, "submitted": True,
                                       "state": value["state"]}), encoding="utf-8")
        if value["state"] != "done":
            raise RuntimeError("Codex独立任务失败：" + value.get("error", "unknown"))
        output = self.read_file(device, value["resultPath"], value["resultBytes"], value["resultSha256"]).decode("utf-8")
        patch = self.read_file(device, value["patchPath"], value["patchBytes"], value["patchSha256"]) if work is not None else None
        return {"text": output, "patch": patch, "device": device or "server", "jobId": ident}
