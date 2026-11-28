"""功能：用登记模型对在场快照做一次无工具、无记忆的静默判断，返回结构化决策。

注册参数root为生产路径，request可注入用于测试；默认按模型登记顺序尝试，失败进入冷却。
本类不写长期记忆、不保存提示词正文到日志、不记录供应商与密钥名。
"""
from services.ProjectPaths import model_config
import json
import os
import time
import urllib.request
from pathlib import Path

from screenInitiative.screenCredential import ScreenCredential
from services.HttpJson import JsonHttpClient


class PresenceModelClient:
    """单轮文本判定：输入一份状态快照，输出一段 JSON。"""

    def __init__(self, root, request=None):
        """root为主项目Path；request为可注入的 HTTP 发送函数。"""
        self.root = Path(root)
        self.request = request or self.request_json
        self.cooldowns = {}
        self.last_errors = []

    def ask(self, context):
        """context为快照与漂移摘要；返回模型输出的原始文本，全部候选失败时抛出 RuntimeError。"""
        config = json.loads(model_config(self.root, "modelConfig.json").read_text("utf-8-sig"))
        secrets_path = model_config(self.root, config.get("secretsFile", "secrets.json"))
        secrets = json.loads(secrets_path.read_text("utf-8-sig")) if secrets_path.is_file() else {}
        prompt = (self.root / "prompts/PresenceReasoning.md").read_text("utf-8-sig")
        rows = [config["defaultModel"]]
        if config.get("failover", {}).get("enabled"):
            rows += config["failover"].get("order", [])
        text = json.dumps(context, ensure_ascii=False)
        seen = set()
        self.last_errors = []
        for row in rows:
            name, model = row["provider"], row["model"]
            identity = (name, model)
            if identity in seen or self.cooldowns.get(identity, 0) > time.monotonic():
                continue
            seen.add(identity)
            provider = config["providers"].get(name, {})
            key = ScreenCredential(self.root).resolve_key(provider, name, secrets)
            base = os.environ.get(provider.get("baseURLEnv", "")) or provider.get("baseURL")
            if not key or not base:
                self.last_errors.append({"errorType": "MissingCredentialOrEndpoint"})
                continue
            if provider.get("api") == "openai-responses":
                path = "/responses"
                payload = {"model": model, "instructions": prompt, "store": False,
                           "max_output_tokens": 700, "stream": False,
                           "input": [{"role": "user", "content": [
                               {"type": "input_text", "text": text}]}]}
            else:
                path = "/chat/completions"
                payload = {"model": model, "max_tokens": 700, "stream": False,
                           "messages": [{"role": "system", "content": prompt},
                                        {"role": "user", "content": text}]}
            try:
                reply = self.request(base.rstrip("/") + path, payload, key)
                if path == "/responses":
                    value = "".join(part.get("text", "") for item in reply.get("output", [])
                                    if item.get("type") == "message"
                                    for part in item.get("content", [])
                                    if part.get("type") == "output_text")
                else:
                    value = reply["choices"][0]["message"]["content"]
                if not isinstance(value, str) or not value.strip():
                    raise ValueError("在场判定为空")
                return value
            except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
                self.last_errors.append({"errorType": type(error).__name__,
                                         "httpStatus": getattr(error, "code", None)})
                self.cooldowns[identity] = time.monotonic() + 600
        raise RuntimeError("在场判定模型暂无可用结果")

    def request_json(self, url, payload, key):
        """url/payload/key为登记服务与内存凭据；禁用代理与重定向，响应上限 1MiB。"""
        return JsonHttpClient(base=url, timeout=45, limit=1024 * 1024).request_json(
            "POST", url, payload, token=key, message="在场判定响应过大")
