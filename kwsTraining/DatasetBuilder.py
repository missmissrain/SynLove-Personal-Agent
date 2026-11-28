"""KWS 数据集构建。

功能：用多说话人 TTS 生成“欣爱”正样本与对话/近音负样本，混合后切窗并提取 log-mel。
注册参数 config 为 KwsConfig；生成结果保存为 dataset.npz，按说话人划分训练/验证/测试。
"""

import hashlib
import random

import numpy as np

from kwsTraining.LogMel import LogMel
from kwsTraining.ProgressBar import DqtmBar


class DatasetBuilder:
    """正负样本生成、混合、切窗与特征打包。"""

    def __init__(self, config, synth):
        """config 为 KwsConfig；synth 为 TtsSynthesizer。"""
        self.config = config
        self.synth = synth
        self.logmel = LogMel(config)
        self.split_map = {}

    def _assign_splits(self, sids):
        """sids 为本次使用的说话人；按 70/15/15 分配 train/val/test。"""
        pool = list(sids)
        random.Random(self.config.seed).shuffle(pool)
        total = len(pool)
        val_count = max(1, int(total * self.config.val_ratio)) if total >= 3 else 0
        test_count = max(1, int(total * self.config.test_ratio)) if total >= 3 else 0
        test_sids = set(pool[:test_count])
        val_sids = set(pool[test_count:test_count + val_count])
        self.split_map = {}
        for sid in pool:
            if sid in test_sids:
                self.split_map[sid] = "test"
            elif sid in val_sids:
                self.split_map[sid] = "val"
            else:
                self.split_map[sid] = "train"

    def negative_sentences(self, limit=80):
        """limit 为最多条数；返回真实对话中的短句，过滤含唤醒词的句子。"""
        path = self.config.negative_sentences_file
        lines = []
        if path.is_file():
            for line in path.read_text(encoding="utf-8").splitlines():
                text = line.strip()
                if 6 <= len(text) <= 40 and "欣爱" not in text:
                    lines.append(text)
        if not lines:
            lines = ["今天天气不错，我们下午再聊。", "这个方案还需要再改一版。",
                     "我先去吃饭，回来继续。"]
        return lines[:limit]

    def _split_of(self, sid):
        """sid 为说话人；返回 train/val/test。"""
        return self.split_map.get(sid, "train")

    def _windows(self, samples, keyword=None):
        """samples 为 int16；keyword 为 (start,end) 或 None；返回 (特征, 标签) 列表。"""
        cfg = self.config
        win, hop = cfg.window_samples, cfg.hop_samples
        rows, labels = [], []
        if samples.size < win // 2:
            return rows, labels
        for start in range(0, max(1, samples.size - win + 1), hop):
            chunk = samples[start:start + win]
            if chunk.size < win:
                chunk = np.pad(chunk, (0, win - chunk.size))
            rms = float(np.sqrt(np.mean(chunk.astype(np.float32) ** 2)))
            if rms < cfg.min_rms:
                continue
            positive = False
            if keyword is not None:
                k_start, k_end = keyword
                overlap = max(0, min(start + win, k_end) - max(start, k_start))
                if overlap >= min(0.25 * cfg.sample_rate, (k_end - k_start) * 0.5):
                    positive = True
            rows.append(self.logmel.features(chunk))
            labels.append(1 if positive else 0)
        return rows, labels

    def _insert(self, dialogue, keyword):
        """dialogue/keyword 为 int16；把关键词随机插入对话，返回混合音频与区间。"""
        if keyword.size >= dialogue.size:
            return None
        room = dialogue.size - keyword.size
        start = random.randint(0, max(0, room - 1))
        mixed = dialogue.astype(np.float32).copy()
        gain = random.uniform(0.5, 1.1)
        mixed[start:start + keyword.size] += keyword.astype(np.float32) * gain
        mixed = np.clip(mixed, -32768, 32767).astype(np.int16)
        return mixed, (start, start + keyword.size)

    def build(self, limit_sids=None, limit_sentences=None):
        """limit_sids 限制说话人数；limit_sentences 限制负样本句数；返回统计字典。"""
        cfg = self.config
        random.seed(cfg.seed)
        np.random.seed(cfg.seed)
        positives = []
        sids = cfg.positive_sids[:limit_sids] if limit_sids else cfg.positive_sids
        self._assign_splits(sids)
        total = len(sids) * len(cfg.positive_texts) * len(cfg.speeds)
        bar = DqtmBar(total, "positive-tts")
        for sid in sids:
            for text in cfg.positive_texts:
                for speed in cfg.speeds:
                    try:
                        positives.append((sid, self.synth.synth(text, sid, speed)))
                    except Exception:
                        pass
                    bar.update(1, "sid=%d" % sid)
        bar.close()

        sentences = self.negative_sentences(limit_sentences or 60)
        neg_sids = list(sids)
        total = len(sentences) * len(neg_sids)
        bar = DqtmBar(total, "negative-tts")
        negatives = []
        for sid in neg_sids:
            for text in sentences:
                try:
                    negatives.append((sid, self.synth.synth(text, sid, 1.0)))
                except Exception:
                    pass
                bar.update(1, "sid=%d" % sid)
        bar.close()

        total = len(cfg.hard_negatives) * len(neg_sids)
        bar = DqtmBar(total, "hard-negative")
        hard = []
        for sid in neg_sids:
            for text in cfg.hard_negatives:
                try:
                    hard.append((sid, self.synth.synth(text, sid, 1.0)))
                except Exception:
                    pass
                bar.update(1, "sid=%d" % sid)
        bar.close()

        rows, labels, groups, kinds, splits = [], [], [], [], []
        for sid, samples in positives:
            x, y = self._windows(samples, (0, samples.size))
            for feature, label in zip(x, y):
                rows.append(feature)
                labels.append(label)
                groups.append(sid)
                kinds.append("positive")
                splits.append(self._split_of(sid))

        for sid, dialogue in negatives:
            x, y = self._windows(dialogue)
            for index, (feature, label) in enumerate(zip(x, y)):
                if index % 3 != 0:
                    continue
                rows.append(feature)
                labels.append(label)
                groups.append(sid)
                kinds.append("dialogue")
                splits.append(self._split_of(sid))
            if positives:
                for _ in range(2 if len(dialogue) > 3 * self.config.sample_rate else 1):
                    if random.random() >= 0.6:
                        continue
                    source_sid, keyword = random.choice(positives)
                    mixed = self._insert(dialogue, keyword)
                    if mixed is not None:
                        audio, interval = mixed
                        x, y = self._windows(audio, interval)
                        for feature, label in zip(x, y):
                            rows.append(feature)
                            labels.append(label)
                            groups.append(sid)
                            kinds.append("mixed")
                            splits.append(self._split_of(sid))

        for sid, samples in hard:
            x, y = self._windows(samples)
            for feature, label in zip(x, y):
                rows.append(feature)
                labels.append(0)
                groups.append(sid)
                kinds.append("hard")
                splits.append(self._split_of(sid))

        # 本人口音补充：真实录音里关键词区间为正，其余窗口为负。
        if cfg.real_audio.is_file():
            import audioop
            import wave
            handle = wave.open(str(cfg.real_audio), "rb")
            rate = handle.getframerate()
            raw = handle.readframes(handle.getnframes())
            handle.close()
            if rate != cfg.sample_rate:
                raw, _ = audioop.ratecv(raw, 2, 1, rate, cfg.sample_rate, None)
            real = np.frombuffer(raw, dtype=np.int16)
            begin, end = cfg.real_positive_range
            x, y = self._windows(real, (int(begin * cfg.sample_rate),
                                        int(end * cfg.sample_rate)))
            for feature, label in zip(x, y):
                rows.append(feature)
                labels.append(label)
                groups.append(-1)
                kinds.append("real")
                splits.append("train")

        data = {
            "X": np.asarray(rows, dtype=np.float16),
            "y": np.asarray(labels, dtype=np.uint8),
            "group": np.asarray(groups, dtype=np.int16),
            "split": np.asarray(splits),
            "kind": np.asarray(kinds),
        }
        path = cfg.data_dir / "dataset.npz"
        np.savez_compressed(str(path), **data)
        stats = {
            "total": len(labels),
            "positive": int(sum(labels)),
            "negative": int(len(labels) - sum(labels)),
            "train": int(sum(1 for item in splits if item == "train")),
            "val": int(sum(1 for item in splits if item == "val")),
            "test": int(sum(1 for item in splits if item == "test")),
            "path": str(path),
        }
        return stats
