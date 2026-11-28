"""功能：缓存固定唤醒应答的已合成WAV，避免每次唤醒都等待Breeze重新生成。

注册参数root为私有缓存目录，默认runtime/voice/wakeCache；catalog默认读取独立唤醒清单。
缓存键包含参考音、参考文本、情绪指令、seed和cfgScale，音色配置变化自动失效。
"""
import hashlib
import io
import json
import wave
import uuid
from pathlib import Path
from voice.wakeReplyCatalog import WakeReplyCatalog


class WakeReplyCache:
    """只复用固定唤醒应答，不缓存普通对话，也不改变语音模型。"""

    def __init__(self, root=None, catalog=None):
        """root为可注入的私有目录，catalog限定允许缓存的应答；不在初始化时写磁盘。"""
        self.root = Path(root or Path(__file__).resolve().parents[1] / "runtime/voice/wakeCache")
        self.catalog = catalog or WakeReplyCatalog()

    def cache_path(self, text, emotion, options):
        """text/emotion/options为完整合成输入；只有预定义应答可返回缓存路径。"""
        if not self.catalog.allows_reply(text, emotion):
            return None
        key = hashlib.sha256(json.dumps(
            {"text": text, "emotion": emotion, "options": options},
            ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
        return self.root / (key + ".wav")

    def read_audio(self, path):
        """path为cache_path返回的路径；仅返回可解析且完整的PCM WAV，损坏时按未命中处理。"""
        try:
            if path is None or not path.is_file() or not 44 < path.stat().st_size <= 8 * 1024 * 1024:
                return None
            raw = path.read_bytes()
            return raw if self.valid_audio(raw) else None
        except OSError:
            return None

    def save_audio(self, path, raw):
        """path为缓存路径、raw为已生成WAV；原子写入并保留其他应答，不互相覆盖删除。"""
        if path is None or not self.valid_audio(raw):
            return
        self.root.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix("." + uuid.uuid4().hex + ".tmp")
        temp.write_bytes(raw)
        temp.replace(path)

    def valid_audio(self, raw):
        """raw为候选音频；检查PCM格式、长度和帧完整性，防止把错误响应缓存成声音。"""
        try:
            with wave.open(io.BytesIO(raw), "rb") as audio:
                count = audio.getnframes()
                return (audio.getcomptype() == "NONE" and audio.getnchannels() in (1, 2)
                        and audio.getsampwidth() == 2 and 0 < count <= audio.getframerate() * 30
                        and len(audio.readframes(count + 1)) == count * audio.getnchannels() * 2)
        except (wave.Error, EOFError, OSError):
            return False
