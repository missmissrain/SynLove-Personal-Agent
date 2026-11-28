"""公共服务鉴权解析：环境变量优先，显式 apiKeyRef=backendService 时读取本机密钥。

注册参数 config 为服务配置，env 默认进程环境；不在服务地址或公开配置保存密钥正文。
缺省密钥路径为生产根目录 config/secrets.json；请求时读取，修改后客户端无需重建。
"""

from services.ProjectPaths import model_config
import json
import os
from pathlib import Path


class ServiceCredential:
    """为 HTTP 业务客户端和启动环境提供同一凭据来源。"""

    @staticmethod
    def resolve_key(config, env=None):
        """config 为服务配置、env 为可选环境；返回内存中的密钥，不输出到日志。"""
        source = os.environ if env is None else env
        key = source.get(config.get("apiKeyEnv", ""), "")
        if key:
            return key
        # 按服务名读 secrets.json（apiKeyRef=tts/asr/...），进程环境不再必需。
        ref = config.get("apiKeyRef")
        if isinstance(ref, str) and ref and ref != "backendService":
            file = model_config(Path(__file__).resolve().parent.parent, "secrets.json")
            try:
                data = json.loads(file.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError):
                data = {}
            for field in ("httpApiKey", "apiKey", "token"):
                value = (data.get(ref) or {}).get(field)
                if value:
                    return str(value)
            return ""
        if config.get("apiKeyRef") != "backendService":
            return key
        file = model_config(Path(__file__).resolve().parent.parent, "secrets.json")
        if not file.exists():
            return ""
        data = json.loads(file.read_text(encoding="utf-8-sig"))
        return data.get("backendService", {}).get("apiKey", "")
