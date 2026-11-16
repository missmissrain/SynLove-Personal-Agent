"""固定声线配置层：读取已确认参考音和逐字文本，组装 Breeze 克隆参数。

注册参数：config_path 默认为 config/voiceIdentity.json；config 可注入测试配置。
参考音只从本地配置读取，不接受模型覆盖；默认种子 42，cfgScale 1.0。
"""

import base64
import json
import math
from pathlib import Path

from voice.ttsPrompt import TtsPrompt


class VoiceIdentity:
    """固定音色身份，只允许每轮情绪发生变化。"""

    def __init__(self, config_path=None, config=None):
        """config_path 为配置路径；config 为可选配置字典，参考音相对配置目录解析。"""
        root = Path(__file__).resolve().parents[1]
        self.path = Path(config_path or root / "config" / "voiceIdentity.json")
        self.config = config

    def build_options(self, emotion):
        """emotion 为受限情绪代码；返回固定参考音、对应文本和合成参数。"""
        if self.config is None:
            if not self.path.is_file():
                raise ValueError("尚未配置欣爱固定参考声，请填写 config/voiceIdentity.json")
            cfg = json.loads(self.path.read_text(encoding="utf-8-sig"))
        else:
            cfg = self.config
        if not isinstance(cfg, dict):
            raise ValueError("固定参考声配置必须为 JSON 对象")
        ref = str(cfg.get("refAudio") or "").strip()
        text = str(cfg.get("refText") or "").strip()
        if not ref or not text:
            raise ValueError("固定参考声必须同时配置 refAudio 和逐字匹配的 refText")
        path = Path(ref)
        if not path.is_absolute():
            path = self.path.parent / path
        if not path.is_file() or not 0 < path.stat().st_size <= 16 * 1024 * 1024:
            raise ValueError("固定参考音不存在、为空或超过16MiB")
        seed = cfg.get("seed", 42)
        scale = cfg.get("cfgScale", 1.0)
        if isinstance(seed, bool) or not isinstance(seed, int) or not 1 <= seed <= 2147483647:
            raise ValueError("固定参考声 seed 必须为 1 至 2147483647 的整数")
        if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not math.isfinite(scale) or scale <= 0:
            raise ValueError("固定参考声 cfgScale 必须为有限正数")
        return {
            "refAudioBase64": base64.b64encode(path.read_bytes()).decode("ascii"),
            "refText": text,
            "seed": seed,
            "cfgScale": float(scale),
            "instruction": self.build_instruction(emotion),
        }

    def build_instruction(self, emotion):
        """emotion 为情绪代码；仅映射受控情绪，不接收模型生成的声线描述。"""
        mood = TtsPrompt.EMOTIONS.get(emotion, TtsPrompt.EMOTIONS["neutral"])
        return "保持参考音的说话人身份与音色不变。本轮情绪：" + mood + "。"
