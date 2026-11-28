"""功能：复用主模型登记与密钥，按Responses优先协议对单帧做无工具的静默判断。

注册参数root为生产根目录，request可注入；默认每候选最多请求一次、60秒超时。
仅支持登记模型的视觉请求；截图不写日志或文件，不进入主人格长期聊天及用户画像。
"""
from services.ProjectPaths import model_config
import base64
import json
import os
import time
import urllib.request
from screenInitiative.screenCredential import ScreenCredential
from services.HttpJson import JsonHttpClient


class ScreenModel:
    """从现有主模型链选取视觉模型，严格校验输出结构，失败保持静默。"""

    def __init__(self, root, request=None):
        """root为生产Path，request为测试传输；提示词独立存放，凭据只在内存使用。"""
        self.root, self.request = root, request or self.request_json
        self.cooldowns = {}
        self.last_errors = []
        self.before_request = None
        self.selected_model = None

    def decide_screen(self, raw, context):
        """raw为JPEG字节，context为短期状态；返回是否开口、建议渠道、正文与情绪。"""
        config = json.loads(model_config(self.root, "modelConfig.json").read_text("utf-8-sig"))
        secrets_path = model_config(self.root, config.get("secretsFile", "secrets.json"))
        secrets = json.loads(secrets_path.read_text("utf-8-sig")) if secrets_path.is_file() else {}
        prompt = (self.root / "prompts/ScreenInitiative.md").read_text("utf-8-sig")
        image = "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")
        rows = [config["defaultModel"]]
        if config.get("failover", {}).get("enabled"):
            rows += config["failover"].get("order", [])
        seen = set()
        self.last_errors = []
        for row in rows:
            name, model = row["provider"], row["model"]
            key_id = (name, model)
            if key_id in seen or self.cooldowns.get(key_id, 0) > time.monotonic():
                continue
            seen.add(key_id)
            provider = config["providers"].get(name, {})
            key = ScreenCredential(self.root).resolve_key(provider, name, secrets)
            base = os.environ.get(provider.get("baseURLEnv", "")) or provider.get("baseURL")
            if not key or not base:
                self.last_errors.append({"provider": name, "errorType": "MissingCredentialOrEndpoint"})
                continue
            text = json.dumps(context, ensure_ascii=False)
            if provider.get("api") == "openai-responses":
                path = "/responses"
                payload = {"model": model, "instructions": prompt, "store": False,
                    "max_output_tokens": 700, "stream": False,
                    "input": [{"role": "user", "content": [
                        {"type": "input_text", "text": text},
                        {"type": "input_image", "image_url": image}]}]}
            else:
                path = "/chat/completions"
                payload = {"model": model, "max_tokens": 700, "stream": False,
                    "messages": [{"role": "system", "content": prompt},
                        {"role": "user", "content": [{"type": "text", "text": text},
                         {"type": "image_url", "image_url": {"url": image}}]}]}
            try:
                if self.before_request is not None and not self.before_request():
                    break
                reply = self.request(base.rstrip("/") + path, payload, key)
                if path == "/responses":
                    value = "".join(part.get("text", "") for item in reply.get("output", [])
                        if item.get("type") == "message" for part in item.get("content", [])
                        if part.get("type") == "output_text")
                else:
                    value = reply["choices"][0]["message"]["content"]
                if value.startswith("```json\n") and value.rstrip().endswith("```"):
                    value = value.strip()[8:-3].strip()
                decision = self.validate_decision(json.loads(value))
                self.selected_model = {"provider": name, "model": model}
                return decision
            except (OSError, ValueError, KeyError, TypeError, IndexError) as exc:
                self.last_errors.append({"provider": name, "model": model,
                    "errorType": type(exc).__name__, "httpStatus": getattr(exc, "code", None)})
                self.cooldowns[key_id] = time.monotonic() + 600
        raise RuntimeError("观察模型暂无可用结果")

    def validate_decision(self, value):
        """value为模型JSON；拒绝自由参数、过长正文、伪造情绪或模糊的是否开口字段。"""
        if not isinstance(value, dict) or any(type(value.get(key)) is not bool
                for key in ("speak", "busy", "sensitive")):
            raise ValueError("观察判断字段不完整")
        score = value.get("confidence")
        if type(score) not in (int, float) or not 0 <= score <= 1:
            raise ValueError("观察信心分数无效")
        text, topic = value.get("text"), value.get("topicKey")
        if not isinstance(text, str) or len(text) > 160 or (value["speak"] and not text.strip()):
            raise ValueError("主动正文不合规")
        if not isinstance(topic, str) or not 1 <= len(topic) <= 80:
            raise ValueError("主动主题不合规")
        if value.get("emotion") not in ("neutral", "gentle", "happy", "concerned", "sad", "excited"):
            raise ValueError("主动情绪不合规")
        if value.get("modality") not in ("auto", "text", "tts"):
            raise ValueError("主动渠道不合规")
        return {key: value[key] for key in (
            "speak", "busy", "sensitive", "confidence", "text", "topicKey", "emotion", "modality")}

    def request_json(self, url, payload, key):
        """url/payload/key为登记服务与内存凭据；禁止代理和重定向，响应上限2MiB。"""
        return JsonHttpClient(base=url, timeout=60, limit=2 * 1024 * 1024).request_json(
            "POST", url, payload, token=key, message="观察模型响应过大")
