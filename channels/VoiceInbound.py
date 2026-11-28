"""功能：语音通道入站，把一段音频交给语音网关完成识别与回复，不重复实现 ASR。

注册参数baseURL默认 127.0.0.1:8812、timeout为整轮等待秒数；默认走 /v1/voice/turn。
失败抛 RuntimeError；本类不改写音频、不做兜底识别。
"""
import json
import urllib.error
import urllib.request
import uuid


class VoiceInbound:
    """语音入站：音频 → 识别 → 主人格 → 回复（由语音网关完成）。"""

    def __init__(self, base_url="http://127.0.0.1:8812", timeout=180.0):
        """base_url为语音网关地址；timeout为整轮等待秒数。"""
        self.base_url = base_url.rstrip("/")
        self.timeout = float(timeout)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def transcribe_and_reply(self, audio, session_id="", device_id="", name="input.wav"):
        """audio为音频字节；返回语音网关的整轮结果（含识别文本与回复）。"""
        if not isinstance(audio, (bytes, bytearray)) or not audio:
            raise ValueError("音频为空")
        request = urllib.request.Request(
            self.base_url + "/v1/voice/turn", data=bytes(audio), method="POST",
            headers={"Content-Type": "application/octet-stream",
                     "X-Follow-Up": "1",
                     "X-Session-Id": session_id or ("voice-" + uuid.uuid4().hex[:8]),
                     "X-Device-Id": device_id or "local",
                     "X-Audio-Name": name})
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:200]
            raise RuntimeError("语音入站失败：HTTP %d %s" % (error.code, detail))
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise RuntimeError("语音入站失败：" + type(error).__name__)
