"""远控目标配置：按别名读取 FRP 转发后的电脑 SSH 入口，隔离 VPS 管理凭据。

注册参数 root 为 SynLove 根目录；配置默认 config/remoteControl.json，
凭据默认 config/secrets.json 的 remoteControl.targets；未配置时列出空目标，不联网。
每个目标必须显式启用并设置 SSH 指纹或 knownHostsPath；默认连接超时 10 秒。
"""

import json
from pathlib import Path


class RemoteTargetConfig:
    """提供公开目标列表及仅供执行层使用的私密连接参数。"""

    def __init__(self, root):
        """root 为项目根目录；初始化私有配置路径，不读取其他项目的服务器账号。"""
        self.root = Path(root).resolve()
        self.path = self.root / "config" / "remoteControl.json"

    def read_config(self):
        """无参数；每次重新读取本机配置，配置缺失返回空目标，损坏时明确失败。"""
        if not self.path.exists():
            return {"targets": {}}
        data = json.loads(self.path.read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict) or not isinstance(data.get("targets", {}), dict):
            raise ValueError("remoteControl.json 的 targets 必须为对象")
        return data

    def list_targets(self):
        """无参数；只返回别名、说明及启用状态，不向模型输出地址、用户名或密钥。"""
        data = self.read_config()
        return [{"target": name, "description": item.get("description", ""),
                 "enabled": item.get("enabled") is True}
                for name, item in data.get("targets", {}).items()
                if isinstance(item, dict)]

    def resolve_target(self, name):
        """name 为已配置别名；校验连接参数，合并本机凭据，禁止调用者指定任意主机。"""
        if not isinstance(name, str) or not name:
            raise ValueError("必须指定目标电脑别名")
        item = self.read_config().get("targets", {}).get(name)
        if not isinstance(item, dict):
            raise ValueError("未知目标电脑，请先调用 remote_cmd_list")
        if item.get("enabled") is not True:
            raise ValueError("该目标尚未启用")
        host, user = item.get("host"), item.get("user")
        if not isinstance(host, str) or not host.strip() or not isinstance(user, str) or not user.strip():
            raise ValueError("目标缺少 SSH host 或 user")
        port = item.get("port", 22)
        timeout = item.get("connectTimeoutSec", 10)
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("SSH 端口必须为 1 至 65535 的整数")
        if type(timeout) is not int or not 1 <= timeout <= 30:
            raise ValueError("连接超时必须为 1 至 30 秒的整数")
        fingerprint = item.get("hostKeySha256", "")
        known = item.get("knownHostsPath", "")
        if not fingerprint and not known:
            raise ValueError("请配置目标电脑的 hostKeySha256 或 knownHostsPath")
        secret_file = self.root / "config" / "secrets.json"
        secrets = json.loads(secret_file.read_text(encoding="utf-8-sig")) if secret_file.exists() else {}
        secret = secrets.get("remoteControl", {}).get("targets", {}).get(name, {})
        key = secret.get("privateKeyPath", "")
        password = secret.get("password", "")
        if not key and not password:
            raise ValueError("请在 secrets.json 的 remoteControl.targets 下配置目标凭据")
        encoding = item.get("encoding", "auto")
        if encoding not in ("auto", "utf-8", "gb18030"):
            raise ValueError("encoding 仅支持 auto、utf-8 或 gb18030")
        return {"host": host, "port": port, "user": user, "timeout": timeout,
                "fingerprint": fingerprint, "known": self.resolve_path(known) if known else "",
                "password": password, "key": self.resolve_path(key) if key else "",
                "passphrase": secret.get("passphrase"), "encoding": encoding}

    def resolve_path(self, value):
        """value 为本机文件路径；相对路径统一相对于生产根目录。"""
        path = Path(value).expanduser()
        return str(path if path.is_absolute() else self.root / path)
