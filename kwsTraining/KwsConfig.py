"""KWS 训练配置。

功能：集中管理多说话人 TTS、正负样本文案、窗口与梅尔参数、输出目录。
注册参数：root 为项目根，默认按文件位置推导；所有路径可用环境变量覆盖。
"""

import os
from pathlib import Path


class KwsConfig:
    """训练与数据生成的唯一配置源。"""

    def __init__(self, root=None):
        """root 为项目根目录；缺省为本文件上两级。"""
        self.root = Path(root or Path(__file__).resolve().parents[1])
        self.tts_dir = Path(os.environ.get(
            "SYNLOVE_KWS_TTS_DIR", r"PRODUCTION_ROOT/models\tts\vits-zh-aishell3"))
        self.data_dir = Path(os.environ.get(
            "SYNLOVE_KWS_DATA", str(self.root / "runtime" / "kwsTraining" / "data")))
        self.cache_dir = self.data_dir / "ttsCache"
        self.model_dir = Path(os.environ.get(
            "SYNLOVE_KWS_MODEL", r"PRODUCTION_ROOT/models\kws-cnn"))
        self.log_dir = self.root / "runtime" / "kwsTraining"
        for path in (self.data_dir, self.cache_dir, self.model_dir, self.log_dir):
            path.mkdir(parents=True, exist_ok=True)

        # 音频与窗口
        self.sample_rate = 16000
        self.window_seconds = 1.2
        self.hop_seconds = 0.2
        self.window_samples = int(self.sample_rate * self.window_seconds)
        self.hop_samples = int(self.sample_rate * self.hop_seconds)
        self.min_rms = 120
        self.seed = 20261127

        # 梅尔特征（训练与推理必须完全一致）
        self.n_fft = 512
        self.win_length = 400
        self.hop_length = 160
        self.n_mels = 40
        self.fmin = 40
        self.fmax = 7600
        self.frames = 120

        # 正样本文案：裸词、带语气、短指令
        self.positive_texts = [
            "欣爱", "欣爱。", "欣爱，", "欣爱呀", "欣爱欣爱",
            "欣爱你在吗", "欣爱帮我一下", "欣爱在吗",
        ]
        # AISHELL3 共 174 个说话人；按步长取样覆盖男女声
        self.positive_sids = list(range(0, 174, 5))
        self.negative_sids = list(range(2, 174, 11))
        self.speeds = [0.85, 1.0, 1.15]

        # 难负样本：与“欣爱”近音但不应唤醒
        self.hard_negatives = [
            "心爱", "新爱", "恩爱", "心挨", "欣艾", "心爱呀", "新爱呀",
            "小爱同学", "亲爱", "喜爱", "心爱在吗", "新爱在吗",
        ]
        self.negative_sentences_file = self.root / "kwsTraining" / "prompts" / "NegativeSentences.txt"

        # 训练
        self.batch_size = 64
        self.epochs = 24
        self.learning_rate = 2e-3
        self.val_ratio = 0.15
        self.test_ratio = 0.15
        self.threshold = 0.9
        self.consecutive_hits = 2
        # 真实录音用于补充本人口音的正负样本；区间为“欣爱”出现的秒数。
        self.real_audio = self.log_dir / "live_probe.wav"
        self.real_positive_range = (10.0, 11.8)
