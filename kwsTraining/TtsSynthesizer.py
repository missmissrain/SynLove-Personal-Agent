"""多说话人 TTS 合成器。

功能：用 sherpa-onnx 的 aishell3 VITS 模型合成中文语音，供 KWS 训练造数据。
注册参数 config 为 KwsConfig；首次调用才加载模型，合成结果按文本/说话人/速度缓存。
"""

import audioop
import hashlib

import numpy as np
import sherpa_onnx


class TtsSynthesizer:
    """AISHELL3 多说话人 TTS 的薄封装。"""

    def __init__(self, config):
        """config 为 KwsConfig；不立即加载模型。"""
        self.config = config
        self.tts = None

    def _load(self):
        """无参数；加载 VITS 模型，返回 OfflineTts。"""
        if self.tts is not None:
            return self.tts
        base = self.config.tts_dir
        model_config = sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=str(base / "vits-aishell3.int8.onnx"),
                lexicon=str(base / "lexicon.txt"),
                tokens=str(base / "tokens.txt")),
            num_threads=2)
        rules = ",".join(str(base / name) for name in ("date.fst", "number.fst", "phone.fst"))
        self.tts = sherpa_onnx.OfflineTts(
            sherpa_onnx.OfflineTtsConfig(model=model_config, rule_fsts=rules,
                                        max_num_sentences=1))
        return self.tts

    def synth(self, text, sid, speed=1.0):
        """text 为中文文本；sid 为说话人编号；speed 为语速；返回 16k int16 数组。"""
        key = hashlib.sha1(("%s|%s|%s" % (text, sid, speed)).encode("utf-8")).hexdigest()
        cache = self.config.cache_dir / (key + ".npy")
        if cache.is_file():
            return np.load(str(cache))
        tts = self._load()
        audio = tts.generate(str(text), sid=int(sid), speed=float(speed))
        samples = np.asarray(audio.samples, dtype=np.float32)
        rate = int(audio.sample_rate)
        peak = float(np.max(np.abs(samples))) if samples.size else 0.0
        if peak > 0:
            samples = samples / peak * 0.9
        if rate != self.config.sample_rate and samples.size:
            pcm = np.clip(samples * 32767, -32768, 32767).astype(np.int16)
            converted, _ = audioop.ratecv(pcm.tobytes(), 2, 1, rate,
                                          self.config.sample_rate, None)
            pcm = np.frombuffer(converted, dtype=np.int16)
        else:
            pcm = np.clip(samples * 32767, -32768, 32767).astype(np.int16)
        np.save(str(cache), pcm)
        return pcm

    def synth_dialogue(self, text, sid, speed=1.0):
        """text 为对话句子；sid/speed 同上；返回 16k int16 数组。"""
        return self.synth(text, sid, speed)
