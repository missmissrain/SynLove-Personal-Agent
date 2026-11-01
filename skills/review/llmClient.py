"""OpenAI 兼容的模型客户端（主用云端 qwen，失败降级本地 Gemma）。

职责：
- 从环境变量或 `~/.dsh/.credentials.yaml` 取密钥；
- 调用 /chat/completions，支持 function-calling（tools）；
- 主模型失败时自动降级到 fallback（Gemma 不支持可靠的工具调用，降级后按单轮处理）。

注册参数（来自配置 model / fallback 段）：
    provider / baseUrl / model / apiKeyEnv / timeoutSeconds
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


class llmClient:
    """一个主模型 + 一个降级模型。"""

    def __init__(self, primary, fallback=None):
        """primary/fallback：{baseUrl, model, apiKeyEnv, timeoutSeconds, provider}。"""
        self.primary = dict(primary or {})
        self.fallback = dict(fallback or {})

    def chat(self, messages, tools=None, use_fallback=False):
        """调一次模型；返回 {message, model, provider, fallback}。"""
        target = self.fallback if use_fallback else self.primary
        if not target:
            raise RuntimeError("没有可用的模型配置")
        try:
            return self._request(target, messages, tools, fallback=use_fallback)
        except Exception as error:
            if use_fallback or not self.fallback:
                raise
            print(f"[llm] 主模型失败（{type(error).__name__}: {error}），降级到 {self.fallback.get('model')}", flush=True)
            return self._request(self.fallback, messages, None, fallback=True)

    def _request(self, target, messages, tools, fallback):
        """真正发 HTTP 请求。"""
        base = str(target.get("baseUrl") or "").rstrip("/")
        model = target.get("model") or ""
        timeout = int(target.get("timeoutSeconds") or 180)
        key = self._key(target.get("apiKeyEnv"))
        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": 2500,
        }
        if tools and not fallback:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        request = urllib.request.Request(
            f"{base}/chat/completions",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8", "replace"))
        message = ((data.get("choices") or [{}])[0] or {}).get("message") or {}
        return {
            "message": message,
            "model": data.get("model") or model,
            "provider": target.get("provider") or "",
            "fallback": fallback,
        }

    @staticmethod
    def _key(env_name):
        """按优先级取密钥：环境变量 → ~/.dsh/.credentials.yaml 的 refs。"""
        if not env_name:
            return ""
        value = os.environ.get(env_name)
        if value:
            return value
        path = Path(os.environ.get("DSH_HOME") or Path(__file__).resolve().parents[2] / "runtime/dsh") / ".credentials.yaml"
        if yaml is None or not path.is_file():
            return ""
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            return str((data.get("refs") or {}).get(env_name) or "")
        except Exception:
            return ""
