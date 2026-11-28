"""语音专用服务选择：ASR使用配置的端侧回环隧道，TTS维持原Breeze服务。

注册参数path为原ServiceRegistry文件；voice_path默认config/voiceConfig.json。
默认不允许端侧离线时自动占用服务器ASR，不切换TTS模型。
"""
import json
from pathlib import Path
from services.ServiceRegistry import ServiceRegistry


class VoiceServiceRegistry(ServiceRegistry):
    """为语音入口提供独立路由，不改变新闻和其他后台任务的模型配置。"""

    def __init__(self, path=None, voice_path=None):
        """path为原服务表；voice_path为私有语音配置，读取失败明确报错。"""
        super().__init__(path)
        target = Path(voice_path or Path(__file__).resolve().parents[1] / "config" / "voiceConfig.json")
        self.voice = json.loads(target.read_text(encoding="utf-8-sig"))

    def get_service(self, name):
        """name为服务名；ASR仅允许指定回环隧道，TTS只补全固定Breeze协议声明。"""
        cfg = super().get_service(name)
        if name == "asr":
            base = self.voice.get("asrBaseURL", "http://127.0.0.1:18881/v1")
            if base != "http://127.0.0.1:18881/v1":
                raise ValueError("端侧ASR必须使用已登记回环隧道")
            cfg.update(baseURL=base, model=self.voice.get("asrModel", "small"), management="external",
                       dialect="whisper", timeoutSeconds=180, host="127.0.0.1", port=18881)
            cfg["streamingURL"] = self.voice.get("asrStreamingURL", "")
            cfg["streamingEnabled"] = bool(self.voice.get("asrStreamingEnabled", False))
            cfg["streamingTimeoutSeconds"] = self.voice.get("asrStreamingTimeoutSeconds", 60)
        elif name == "tts":
            cfg["dialect"] = "breeze"
            cfg["streamingPath"] = self.voice.get("ttsStreamingPath", "/audio/speech")
            cfg["streamingEnabled"] = bool(self.voice.get("ttsStreamingEnabled", False))
        return cfg
