"""远控界面探测桥：获取 SSH 公钥指纹或对已保存目标进行固定 CMD 探活。

注册参数 root 为生产根目录，默认当前模块上级；所有输入通过 stdin JSON，不经命令行传密码。
仅支持 peekKey/probe 两个动作，不接受任意命令；默认 TCP/SSH 连接期限各 8 秒。
"""

import base64
import hashlib
import json
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import paramiko
from remoteControl.RemoteCmdClient import RemoteCmdClient
from remoteControl.RemoteTargetConfig import RemoteTargetConfig


class RemoteControlAdmin:
    """供本机控制台调用的无任意命令探测入口。"""

    def __init__(self, root=ROOT):
        """root 为本机配置目录所属根路径；不接收外部传入的配置路径。"""
        self.config = RemoteTargetConfig(root)

    def handle_request(self, data):
        """data 为动作和目标参数；返回协议验证结果或待人工核对的公钥指纹。"""
        if not isinstance(data, dict):
            raise ValueError("输入必须为对象")
        if data.get("action") == "probe":
            result = RemoteCmdClient(self.config).execute_command(
                data.get("target"), "echo SynLoveRemoteCmdReady", 10)
            ok = result["ok"] and result["stdout"].strip() == "SynLoveRemoteCmdReady"
            return {"ok": bool(ok), "available": bool(ok),
                    "message": "SSH 身份、登录与 CMD 协议验证通过" if ok else
                    "CMD 协议未通过；超时后远端状态可能未知" if result.get("timedOut") else "CMD 协议响应不匹配"}
        if data.get("action") != "peekKey":
            raise ValueError("不支持的远控管理操作")
        host, port = data.get("host"), data.get("port")
        if not isinstance(host, str) or not host or len(host) > 253 or any(c in host for c in "/\\@\r\n\0 "):
            raise ValueError("服务器地址格式不正确")
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("SSH 端口不正确")
        with socket.create_connection((host, port), timeout=8) as sock:
            transport = paramiko.Transport(sock)
            try:
                transport.start_client(timeout=8)
                key = transport.get_remote_server_key()
                fingerprint = "SHA256:" + base64.b64encode(
                    hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")
                return {"ok": True, "fingerprint": fingerprint, "keyType": key.get_name(),
                        "message": "已读取公钥，尚未验证身份；请在目标电脑核对指纹后保存"}
            finally:
                transport.close()


if __name__ == "__main__":
    try:
        raw = sys.stdin.read(65537)
        if len(raw) > 65536:
            raise ValueError("输入过大")
        reply = RemoteControlAdmin().handle_request(json.loads(raw))
    except Exception as error:
        reply = {"ok": False, "available": False,
                 "message": "远控检查失败（%s），请核对地址、隧道、凭据及主机指纹" % type(error).__name__}
    print(json.dumps(reply, ensure_ascii=False))
