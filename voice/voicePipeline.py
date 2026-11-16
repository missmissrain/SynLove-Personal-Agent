"""欣爱语音会话流水线。

职责是把设备音频依次交给 ASR、人格化 LLM 和 TTS，并返回结构化结果。
该类不持有麦克风、不判断用户位置、不绑定某个设备，方便未来扩展多终端。
"""

from pathlib import Path

from services.ServiceClient import ServiceClient
from services.ServiceRegistry import ServiceRegistry
from voice.voiceAudioStore import VoiceAudioStore
from voice.voicePrompt import VoicePrompt
from voice.ttsPrompt import TtsPrompt
from voice.voiceIdentity import VoiceIdentity
from voice.wakeWordDetector import WakeWordDetector


class VoicePipeline:
    """编排单轮唤醒、识别、理解和语音回复。"""

    def __init__(self, registry=None, detector=None, prompt=None, store=None, tts_prompt=None, identity=None):
        """各依赖可注入；identity 为固定参考声配置，禁止由模型控制音色身份。"""
        self.registry = registry or ServiceRegistry()
        self.detector = detector or WakeWordDetector()
        self.prompt = prompt or VoicePrompt()
        self.store = store or VoiceAudioStore()
        self.tts_prompt = tts_prompt or TtsPrompt()
        self.identity = identity or VoiceIdentity()

    def process_audio(self, audio_path, session_id="default", device_id="local"):
        """audio_path 为设备音频路径；返回唤醒状态、文本、回复和 TTS 文件路径。"""
        path = Path(audio_path)
        if not path.is_file():
            raise FileNotFoundError("语音输入不存在：" + str(path))
        asr = ServiceClient(self.registry.get_service("asr")).transcribe(path, language="zh")
        transcript = str(asr.get("text") or "").strip()
        wake = self.detector.detect(transcript)
        result = {
            "ok": True,
            "deviceId": str(device_id),
            "sessionId": str(session_id),
            "transcript": transcript,
            "wake": bool(wake["wake"]),
            "keyword": wake["keyword"],
            "command": wake["command"],
        }
        if not wake["wake"]:
            result["state"] = "waiting_for_wake_word"
            return result
        command = wake["command"]
        tts_config = self.registry.get_service("tts")
        if tts_config.get("dialect") != "breeze":
            raise ValueError("固定音色克隆要求 TTS 服务配置 dialect=breeze")
        # 先验证参考声，避免缺配置时仍占用 LLM 或服务器显卡。
        options = self.identity.build_options(self.tts_prompt.DEFAULT)
        if not command:
            reply = "嗯，我在～"
            tts_prompt = self.tts_prompt.DEFAULT
        else:
            answer = self._ask_agent(command, session_id)
            reply = answer["text"]
            tts_prompt = answer["ttsPrompt"]
        options["instruction"] = self.identity.build_instruction(tts_prompt)
        audio, fmt = ServiceClient(tts_config).synthesize(reply, **options)
        output = self.store.save_output(audio, session_id, "." + fmt)
        result.update({
            "state": "replied",
            "reply": reply,
            "ttsPrompt": tts_prompt,
            "audioPath": str(output),
            "audioFormat": fmt,
        })
        return result

    def _ask_agent(self, command, session_id):
        """command 为去掉唤醒词的用户指令；session_id 用于后续接入会话存储。"""
        payload = {
            "messages": [
                {"role": "system", "content": self.prompt.load()},
                {"role": "user", "content": command},
            ],
            "temperature": 0.7,
            "max_tokens": 512,
            "stream": False,
            "metadata": {"channel": "voice", "sessionId": str(session_id)},
        }
        response = ServiceClient(self.registry.get_service("llm")).chat(payload)
        choices = response.get("choices") or []
        if not choices:
            raise ValueError("LLM 没有返回 choices")
        message = choices[0].get("message") or {}
        content = str(message.get("content") or "").strip()
        if not content:
            raise ValueError("LLM 没有返回文本")
        return self.tts_prompt.parse(content)
