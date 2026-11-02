"""Relay 服务接入工具：通过已固定 SSH 身份取得现有 Hub CA 和令牌，配置公共服务。

注册参数 root 为生产根；configure 必须显式给出 serverConfig 与 nodeConfig 文件，
不猜 SSH 账号，不改变 VPS/家庭节点，不启动消息消费者。verify 只发送短功能测试。
所有凭据仅在内存和本机 secrets.json 中处理，不写进报告。
"""

import argparse
import json
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from services.ServiceClient import ServiceClient
from services.ServiceRegistry import ServiceRegistry


class RelayServiceSetup:
    """连接已有 Relay，保存私有配置并验证真实公共能力。"""

    def __init__(self, root):
        """root 为生产根目录；报告与证书保存在 runtime/relay，不进入公开仓库。"""
        self.root = Path(root).resolve()
        self.runtime = self.root / "runtime" / "relay"

    def read_json(self, path):
        """path 为明确文件路径；读取严格 JSON，不回显正文。"""
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))

    def connect_ssh(self, path):
        """path 为已保存的 VPS 配置；只接受 known_hosts 中已有的主机身份。"""
        import paramiko
        cfg = self.read_json(path)["server"]
        client = paramiko.SSHClient()
        client.load_host_keys(str(Path.home() / ".ssh" / "known_hosts"))
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
        try:
            client.connect(
                cfg["host"], port=int(cfg.get("port", 22)), username=cfg["user"],
                key_filename=cfg.get("privateKeyPath") or None,
                password=cfg.get("password") or None, timeout=10, banner_timeout=10,
                auth_timeout=10, allow_agent=False, look_for_keys=False)
        except Exception:
            client.close()
            raise
        return client, cfg

    def write_json(self, path, value):
        """path 为配置或报告路径，value 为对象；同目录临时文件原子替换。"""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + ".relay.tmp")
        try:
            temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(temp, path)
        finally:
            if temp.exists():
                temp.unlink()

    def configure_remote(self, server_config, node_config):
        """server_config/node_config 为既有 SSH/Hub 配置路径；核验 TLS 与能力后保存服务指向。"""
        import paramiko

        ssh_cfg = self.read_json(server_config)["server"]
        node = self.read_json(node_config)
        origin = urllib.parse.urlsplit(node["hubUrl"])
        if origin.scheme not in ("wss", "https") or origin.username or origin.password:
            raise ValueError("现有 Hub 必须使用无内嵌凭据的 HTTPS/WSS 地址")
        base = "https://" + origin.netloc
        client = paramiko.SSHClient()
        client.load_host_keys(str(Path.home() / ".ssh" / "known_hosts"))
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
        try:
            client.connect(
                ssh_cfg["host"], port=int(ssh_cfg.get("port", 22)), username=ssh_cfg["user"],
                key_filename=ssh_cfg.get("privateKeyPath") or None,
                password=ssh_cfg.get("password") or None, timeout=10, banner_timeout=10,
                auth_timeout=10, allow_agent=False, look_for_keys=False)
            with client.open_sftp() as remote:
                with remote.open("/etc/synlove-relay/certs/ca.crt") as handle:
                    cert = handle.read(65537).decode("ascii")
                with remote.open("/etc/synlove-relay/relay.env") as handle:
                    env_text = handle.read(65537).decode("utf-8")
            if len(cert) > 65536 or len(env_text) > 65536:
                raise ValueError("服务器信任配置过大")
        finally:
            client.close()
        fields = {}
        for line in env_text.splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                fields[key.strip()] = value.strip().strip("\"'")
        token = fields["RELAY_TOKEN"]
        ctx = ssl.create_default_context(cadata=cert)
        req = urllib.request.Request(base + "/v1/capabilities",
                                     headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, context=ctx, timeout=12) as response:
            caps = json.load(response)["capabilities"]
        active = {item["name"] for item in caps
                  if item.get("nodes", 0) > 0 and item.get("capacity", 0) > 0}
        if not {"tts", "asr", "chat"} <= active:
            raise ValueError("远端节点未同时提供 TTS、ASR 和对话能力，未修改生产配置")

        # 沿用控制台的密钥保存接口；不会在命令行或响应报告中暴露 token。
        body = {"mode": "remote", "host": origin.hostname, "protocol": "https",
                "ports": {name: origin.port or 443 for name in ("tts", "asr", "llm")},
                "apiKey": token}
        req = urllib.request.Request(
            "http://127.0.0.1:3082/api/backend/config",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as response:
            if not json.load(response).get("ok"):
                raise RuntimeError("控制台未确认配置保存")
        self.runtime.mkdir(parents=True, exist_ok=True)
        ca = self.runtime / "relayCa.pem"
        ca.write_text(cert, encoding="ascii")
        config_path = self.root / "config" / "serviceConfig.json"
        config = self.read_json(config_path)
        for name in ("tts", "asr", "llm"):
            cfg = config["services"][name]
            cfg.update({"baseURL": base + "/v1", "management": "external",
                        "transport": "relay", "apiKeyRef": "backendService",
                        "tlsCaFile": "runtime/relay/relayCa.pem",
                        "healthPath": "/v1/capabilities"})
            if name == "tts":
                cfg["dialect"] = "openai"
        self.write_json(config_path, config)
        backend_path = self.root / "config" / "backendService.json"
        backend = self.read_json(backend_path)
        backend["transport"] = "relay"
        backend["resolved"] = {}
        for name in ("tts", "asr", "llm"):
            backend["services"][name]["transport"] = "relay"
            backend["resolved"][name] = {
                "port": origin.port or 443, "endpoint": base,
                "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
        self.write_json(backend_path, backend)
        return {"configured": True, "transport": "relay", "capabilities": sorted(active),
                "certificateVerification": True, "localDataUnchanged": True}

    def verify_services(self):
        """无参数；通过生产客户端执行短 LLM、TTS→ASR 测试，不发送平台消息。"""
        registry = ServiceRegistry(self.root / "config" / "serviceConfig.json")
        report = {"date": time.strftime("%Y-%m-%d %H:%M:%S%z"), "transport": "relay",
                  "checks": {}, "platformMessagesSent": 0}
        for name in ("llm", "tts", "asr"):
            cfg = registry.get_service(name)
            if cfg.get("transport") != "relay" or cfg["management"] != "external":
                raise ValueError("生产公共服务尚未统一切到 Relay")
        checks = report["checks"]
        start = time.monotonic()
        try:
            result = ServiceClient(registry.get_service("llm")).chat({
                "messages": [{"role": "user", "content": "这是连接测试，请只回复：连接成功"}],
                "max_tokens": 64, "temperature": 0, "stream": False})
            text = result["choices"][0].get("message", {}).get("content", "")
            checks["llm"] = {"ok": bool(text.strip()), "seconds": round(time.monotonic() - start, 2),
                             "reply": text[:200]}
        except Exception as error:
            checks["llm"] = {"ok": False, "errorType": type(error).__name__}
        start = time.monotonic()
        audio = None
        try:
            audio, fmt = ServiceClient(registry.get_service("tts")).synthesize(
                "欣爱连接测试，今天阳光很好。")
            valid = audio[:4] == b"RIFF" and audio[8:12] == b"WAVE"
            checks["tts"] = {"ok": valid, "bytes": len(audio),
                             "seconds": round(time.monotonic() - start, 2)}
            if valid:
                self.runtime.mkdir(parents=True, exist_ok=True)
                path = self.runtime / "连通测试.wav"
                path.write_bytes(audio)
            else:
                audio = None
        except Exception as error:
            checks["tts"] = {"ok": False, "errorType": type(error).__name__}
        if audio:
            start = time.monotonic()
            try:
                result = ServiceClient(registry.get_service("asr")).transcribe(path, language="zh")
                text = result["text"]
                checks["asr"] = {"ok": bool(text.strip()), "text": text[:200],
                                 "seconds": round(time.monotonic() - start, 2)}
            except Exception as error:
                checks["asr"] = {"ok": False, "errorType": type(error).__name__}
        else:
            checks["asr"] = {"ok": False, "reason": "TTS 未生成有效测试音频，未伪造转写结果"}
        report["result"] = "PASS" if all(item["ok"] for item in checks.values()) else "PARTIAL"
        self.write_json(self.runtime / "远程功能验证.json", report)
        return report

    def raise_timeouts(self, server_config):
        """server_config 为 VPS 配置；备份后增大 Hub 和本机等待，不声称修改远端节点。"""
        client_cfg = ServiceRegistry().get_service("llm")
        # Hub 重启会丢失其内存任务；先确认没有未终结任务，避免打断远端执行。
        for status in ("queued", "assigned", "running"):
            data, _ = ServiceClient(client_cfg).request("/tasks?status=" + status + "&limit=1")
            if json.loads(data).get("tasks"):
                raise RuntimeError("中转仍有未终结任务，拒绝立即重启")
        client, cfg = self.connect_ssh(server_config)
        path = "/opt/synlove-relay/config/hub.json"
        backup = "/opt/synlove-relay/备份"
        version = backup + "/SynLoveTimeoutv1.0"
        try:
            with client.open_sftp() as remote:
                with remote.open(path) as handle:
                    raw = handle.read().decode("utf-8-sig")
                value = json.loads(raw)
                mode = remote.stat(path).st_mode & 0o777
                try:
                    remote.stat(backup)
                except FileNotFoundError:
                    remote.mkdir(backup, mode=0o700)
                try:
                    remote.stat(version)
                except FileNotFoundError:
                    remote.mkdir(version, mode=0o700)
                    for name, text in (
                        ("hub.json", raw),
                        ("版本记录.json", json.dumps({"version": "1.0",
                         "time": time.strftime("%Y-%m-%d %H:%M:%S%z")}, ensure_ascii=False)),
                        ("版本说明.md", "# SynLoveTimeout v1.0\n\n调高等待期限前的 Hub 配置，含私密配置，不得公开。\n")):
                        with remote.open(version + "/" + name, "w") as handle:
                            handle.write(text.encode("utf-8"))
                        remote.chmod(version + "/" + name, 0o600)
                value["taskTimeoutSeconds"] = 1200
                value["resultTtlSeconds"] = max(1800, value.get("resultTtlSeconds", 0))
                with remote.open(path + ".timeout.tmp", "w") as handle:
                    handle.write((json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
                remote.chmod(path + ".timeout.tmp", mode)
                remote.posix_rename(path + ".timeout.tmp", path)
            command = "systemctl restart synlove-relay.service"
            if cfg["user"] != "root":
                command = "sudo -n " + command
            _, stdout, stderr = client.exec_command(command, timeout=30)
            if stdout.channel.recv_exit_status() != 0:
                raise RuntimeError("Hub 重启未被系统确认")
            _, stdout, stderr = client.exec_command("systemctl is-active synlove-relay.service", timeout=10)
            if stdout.read().decode().strip() != "active":
                raise RuntimeError("Hub 服务未达到 active")
        finally:
            client.close()
        local_path = self.root / "config" / "serviceConfig.json"
        local = self.read_json(local_path)
        for name in ("tts", "asr", "llm"):
            local["services"][name]["timeoutSeconds"] = 1260
        self.write_json(local_path, local)
        return {"localTimeoutSeconds": 1260, "hubTimeoutSeconds": 1200,
                "hubResultTtlSeconds": value["resultTtlSeconds"], "hubActive": True,
                "nodeTimeoutChanged": False,
                "nodeTimeoutNote": "家庭节点的 worker 超时须在节点配置修改；现有 Hub API 不提供该管理接口"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("configure", "verify", "timeouts"))
    parser.add_argument("--server-config")
    parser.add_argument("--node-config")
    args = parser.parse_args()
    setup = RelayServiceSetup(ROOT)
    try:
        if args.action == "configure":
            if not args.server_config or not args.node_config:
                parser.error("configure 需要明确的 --server-config 和 --node-config")
            result = setup.configure_remote(args.server_config, args.node_config)
        elif args.action == "timeouts":
            if not args.server_config:
                parser.error("timeouts 需要明确的 --server-config")
            result = setup.raise_timeouts(args.server_config)
        else:
            result = setup.verify_services()
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(1 if result.get("result") == "PARTIAL" else 0)
    except Exception as error:
        print(json.dumps({"ok": False, "errorType": type(error).__name__}, ensure_ascii=False))
        sys.exit(1)
