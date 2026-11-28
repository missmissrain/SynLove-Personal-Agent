"""功能：按现有主人格优先级解析视觉模型凭据，不复制或输出任何密钥。

注册参数root为生产根；默认环境变量优先，其次私有secrets.json，再读当前DSH托管refs。
DSH_HOME未设置时使用同一生产根runtime/dsh，不读取其他历史实例。
"""
import os
from pathlib import Path


class ScreenCredential:
    """让后台观察沿用主人格已登记的凭据，而非另建账号或密钥文件。"""

    def __init__(self, root):
        """root为生产Path；不在初始化时读取凭据。"""
        self.root = root

    def resolve_key(self, provider, name, secrets):
        """provider/name/secrets为模型定义、提供方标识与私有字典；只返回内存值。"""
        ref = provider.get("apiKeyEnv", "")
        key = os.environ.get(ref) or secrets.get("providers", {}).get(name, {}).get("apiKey")
        if key:
            return key
        path = Path(os.environ.get("DSH_HOME") or self.root / "runtime/dsh") / ".credentials.yaml"
        if not ref or not path.is_file():
            return None
        import yaml
        data = yaml.safe_load(path.read_text("utf-8-sig")) or {}
        key = data.get("refs", {}).get(ref)
        return key if isinstance(key, str) and key else None
