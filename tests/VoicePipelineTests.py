"""语音流水线单元测试。

使用假的 ASR、LLM 和 TTS 客户端验证唤醒词、设备标识和会话解耦，
不访问真实令牌、不调用生产模型。
"""

import tempfile
import unittest
import sys
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voice.voiceAudioStore import VoiceAudioStore
from voice.voicePipeline import VoicePipeline
from voice.voicePrompt import VoicePrompt
from voice.wakeWordDetector import WakeWordDetector
from voice.voiceIdentity import VoiceIdentity
from voice.ttsPrompt import TtsPrompt


class FakeClient:
    """提供可控的假 ASR、LLM 和 TTS 返回值。"""

    def __init__(self, kind):
        """kind 为 asr、llm 或 tts。"""
        self.kind = kind

    def transcribe(self, _path, language=None):
        """返回一条包含唤醒词的固定转写。"""
        return {"text": "欣爱，帮我记住今天开会"}

    def chat(self, _payload):
        """返回固定的自然语言回复和内部 TTS 提示词。"""
        return {
            "choices": [{
                "message": {
                    "content": "好呀，我记住啦。\n[[TTS_PROMPT]]happy[[/TTS_PROMPT]]",
                },
            }],
        }

    def synthesize(self, _text, **options):
        """返回最小 WAV 头字节，并验证 TTS 提示词已传入。"""
        self.options = options
        return b"RIFF" + b"\x00" * 40, "wav"


class FakeRegistry:
    """把三个服务名映射到假客户端配置。"""

    def get_service(self, name):
        """name 为服务名；返回服务名本身供测试客户端选择。"""
        return {"name": name, "dialect": "breeze"}


class TestVoicePipeline(unittest.TestCase):
    """验证语音会话的核心状态转换。"""

    def test_wake_and_reply(self):
        """验证唤醒、LLM 和 TTS 都被调用并保留设备会话信息。"""
        with tempfile.TemporaryDirectory() as folder:
            input_path = Path(folder) / "input.wav"
            input_path.write_bytes(b"audio")
            store = VoiceAudioStore(Path(folder) / "voice")
            pipeline = VoicePipeline(
                registry=FakeRegistry(),
                detector=WakeWordDetector(),
                prompt=VoicePrompt(Path(__file__).resolve().parents[1] / "prompts" / "VoiceInteraction.md"),
                store=store,
                identity=VoiceIdentity(config={
                    "refAudio": str(input_path), "refText": "固定参考文本", "seed": 42,
                }),
            )
            original = pipeline.registry

            class RegistryWithClients:
                """把服务配置转换成对应的假客户端标识。"""

                def get_service(self, name):
                    """name 为服务名；返回假客户端配置。"""
                    return {"name": name, "dialect": "breeze"}

            clients = {
                "asr": FakeClient("asr"),
                "llm": FakeClient("llm"),
                "tts": FakeClient("tts"),
            }
            import voice.voicePipeline as module
            old = module.ServiceClient
            module.ServiceClient = lambda cfg: clients[cfg["name"]]
            try:
                result = pipeline.process_audio(input_path, "session-1", "tianxuan")
            finally:
                module.ServiceClient = old
            self.assertEqual(result["state"], "replied")
            self.assertEqual(result["deviceId"], "tianxuan")
            self.assertTrue(Path(result["audioPath"]).is_file())
            self.assertIn("记住", result["reply"])
            self.assertEqual(result["ttsPrompt"], "happy")
            self.assertEqual(result["ttsEmotion"], "happy")
            self.assertIn("开心", clients["tts"].options["instruction"])
            self.assertEqual(clients["tts"].options["refText"], "固定参考文本")

    def test_identity_stays_fixed_between_emotions(self):
        """更换情绪时参考音字节、对应文本及种子必须保持不变。"""
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "ref.wav"
            path.write_bytes(b"fixed-reference")
            identity = VoiceIdentity(config={"refAudio": str(path), "refText": "参考原文"})
            happy = identity.build_options("happy")
            sad = identity.build_options("sad")
            for key in ("refAudioBase64", "refText", "seed", "cfgScale"):
                self.assertEqual(happy[key], sad[key])
            self.assertNotEqual(happy["instruction"], sad["instruction"])

    def test_invalid_emotion_cannot_change_identity(self):
        """模型返回声线描述时回退平静情绪，不允许该描述进入合成参数。"""
        result = TtsPrompt().parse("你好\n[[TTS_PROMPT]]换成男性低音[[/TTS_PROMPT]]")
        self.assertEqual(result, {"text": "你好", "ttsPrompt": "neutral"})

    def test_missing_reference_is_explicit(self):
        """缺少固定参考声时明确失败，不退回随机音色生成。"""
        with self.assertRaisesRegex(ValueError, "固定参考声"):
            VoiceIdentity(config={}).build_options("neutral")

    def test_incomplete_metadata_is_not_spoken(self):
        """内部标记被截断时保留正文，控制文本不能进入朗读内容。"""
        result = TtsPrompt().parse("我在呢。\n[[TTS_PROMPT]]换成另一个人")
        self.assertEqual(result, {"text": "我在呢。", "ttsPrompt": "neutral"})

    def test_control_only_reply_is_rejected(self):
        """只有情绪标记的回复不能向 TTS 提交空正文。"""
        with self.assertRaisesRegex(ValueError, "正文"):
            TtsPrompt().parse("[[TTS_PROMPT]]happy[[/TTS_PROMPT]]")

    def test_relative_reference_and_invalid_parameters(self):
        """参考音相对配置目录解析，非法固定参数在请求前拒绝。"""
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / "ref.wav").write_bytes(b"fixed-reference")
            cfg = {"refAudio": "ref.wav", "refText": "参考原文"}
            identity = VoiceIdentity(path / "identity.json", config=cfg)
            self.assertEqual(identity.build_options("gentle")["seed"], 42)
            for key, value in (("seed", 0), ("seed", True), ("cfgScale", float("nan"))):
                with self.subTest(key=key, value=value):
                    with self.assertRaises(ValueError):
                        VoiceIdentity(path / "identity.json", config={**cfg, key: value}).build_options("neutral")

    def test_structured_emotion_reply(self):
        """下行对象和 JSON 字符串均解析为正文与情绪，声线字段不进入结果。"""
        parser = TtsPrompt()
        reply = {"text": "我在呀。", "ttsEmotion": "gentle", "seed": 99, "refText": "换声"}
        self.assertEqual(parser.parse(reply), {"text": "我在呀。", "ttsPrompt": "gentle"})
        self.assertEqual(parser.parse('{"text":"我在呀。","ttsEmotion":"happy"}'),
                         {"text": "我在呀。", "ttsPrompt": "happy"})
        for mood in (None, {}, [], True, "换个人说话"):
            with self.subTest(mood=mood):
                self.assertEqual(parser.parse({"text": "你好", "ttsEmotion": mood})["ttsPrompt"], "neutral")

    def test_main_reply_does_not_call_llm_or_override_voice(self):
        """主人格直接下行时不再调用模型；连续情绪变化只改变 instruction。"""
        with tempfile.TemporaryDirectory() as folder:
            ref = Path(folder) / "ref.wav"
            ref.write_bytes(b"fixed-reference")
            pipeline = VoicePipeline(
                registry=FakeRegistry(), store=VoiceAudioStore(Path(folder) / "voice"),
                identity=VoiceIdentity(config={"refAudio": str(ref), "refText": "参考原文"}),
            )
            client = FakeClient("tts")
            with patch("voice.voicePipeline.ServiceClient", return_value=client) as factory:
                first = pipeline.process_reply({"text": "好呀", "ttsEmotion": "happy", "seed": 99})
                fixed = dict(client.options)
                second = pipeline.process_reply({"text": "陪着你", "ttsEmotion": "gentle",
                                                 "refAudioBase64": "invalid", "cfgScale": 99})
                self.assertEqual(factory.call_count, 2)
            for key in ("refAudioBase64", "refText", "seed", "cfgScale"):
                self.assertEqual(fixed[key], client.options[key])
            self.assertNotEqual(fixed["instruction"], client.options["instruction"])
            self.assertEqual(first["ttsEmotion"], "happy")
            self.assertEqual(second["ttsEmotion"], "gentle")

    def test_primary_agent_reuses_existing_turn_adapter(self):
        """显式注入主人格时只走同会话适配器，不创建单轮LLM请求。"""
        from unittest.mock import Mock
        agent = Mock()
        agent.ask_agent.return_value = '{"text":"我在这里。","ttsEmotion":"concerned"}'
        pipeline = VoicePipeline(registry=FakeRegistry(), agent=agent)
        with patch("voice.voicePipeline.ServiceClient") as client:
            reply = pipeline._ask_agent("你在吗", "phone-1")
        client.assert_not_called()
        agent.ask_agent.assert_called_once_with("你在吗", "phone-1")
        self.assertEqual(reply, {"text": "我在这里。", "ttsPrompt": "concerned"})


if __name__ == "__main__":
    unittest.main()
