"""SSH 主机指纹校验：验证目标电脑 SHA256 公钥，不接受自动信任首次连接。

注册参数 fingerprint 为事先从目标电脑核对的 OpenSSH SHA256:... 指纹。
仅在配置指纹且未从 known_hosts 命中时使用；不写入或自动更新 known_hosts。
"""

import base64
import hashlib
import hmac

import paramiko


class PinnedHostPolicy(paramiko.MissingHostKeyPolicy):
    """按预置 SHA256 指纹核对 SSH 主机身份。"""

    def __init__(self, fingerprint):
        """fingerprint 为 SHA256: 开头的可信指纹；拒绝占位符和错误格式。"""
        if not isinstance(fingerprint, str) or not fingerprint.startswith("SHA256:"):
            raise ValueError("主机指纹必须采用 SHA256:... 格式")
        digest = fingerprint[7:].rstrip("=")
        try:
            raw = base64.b64decode(digest + "=" * (-len(digest) % 4), validate=True)
        except (ValueError, TypeError) as error:
            raise ValueError("主机指纹格式不正确") from error
        if len(raw) != 32:
            raise ValueError("主机指纹必须是 SHA256 摘要")
        self.fingerprint = "SHA256:" + digest

    def missing_host_key(self, client, hostname, key):
        """client/hostname 为 SSH 回调信息，key 为对端公钥；不匹配则终止握手。"""
        actual = "SHA256:" + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")
        if not hmac.compare_digest(actual, self.fingerprint):
            raise paramiko.SSHException("远程电脑主机指纹不匹配")
