"""功能：主人格桥接，把文本回合交给 8813 的既有语音回复接口，不另建推理通道。

注册参数base_url默认 127.0.0.1:8813、timeout为整轮秒数；默认按 sessionId 复用会话。
返回回复文本；格式不符或网络失败抛 RuntimeError。
"""
import json
import urllib.error
import urllib.request


class AgentBridge:
    """文本通道 → 主人格。"""

    def __init__(self, base_url="http://127.0.0.1:8813", timeout=180.0):
        """base_url为主人格桥地址；timeout为整轮等待秒数。"""
        self.base_url = base_url.rstrip("/")
        self.timeout = float(timeout)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def __call__(self, envelope):
        """envelope为消息；返回回复文本。"""
        body = {"text": envelope.text, "sessionId": envelope.session or "main",
                "channel": envelope.channel, "userId": getattr(envelope, "sender", ""),
                "mode": "text"}
        request = urllib.request.Request(
            self.base_url + "/v1/voice/reply",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                value = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise RuntimeError("主人格不可用：" + type(error).__name__)
        for key in ("reply", "text", "answer"):
            raw = value.get(key)
            if not isinstance(raw, str) or not raw.strip():
                continue
            plain = raw.strip()
            # 语音回合返回的是 {"text":...,"ttsEmotion":...} 字符串；
            # 文本通道只取 text，避免把 JSON 原样发给微信/QQ。
            try:
                parsed = json.loads(plain)
            except ValueError:
                return plain
            if isinstance(parsed, dict) and isinstance(parsed.get("text"), str):
                return parsed["text"]
            return plain
        raise RuntimeError("主人格回复格式无效")
