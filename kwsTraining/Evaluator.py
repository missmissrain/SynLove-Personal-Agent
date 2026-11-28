"""KWS 评测器。

功能：在 NPZ 测试集与真实录音上评估唤醒模型的召回率、假阳性与触发时间。
注册参数 config 为 KwsConfig；默认优先使用 ONNX，缺失时回退 PyTorch。
"""

import audioop
import wave

import numpy as np

from kwsTraining.LogMel import LogMel


class Evaluator:
    """测试集指标与真实 WAV 滑动窗口评测。"""

    def __init__(self, config):
        """config 为 KwsConfig；初始化 log-mel，并读取校准阈值。"""
        self.config = config
        self.logmel = LogMel(config)
        self.session = None
        self.model = None
        self.threshold = config.threshold
        meta = config.model_dir / "meta.json"
        if meta.is_file():
            try:
                import json
                self.threshold = float(json.loads(meta.read_text(encoding="utf-8"))
                                       .get("threshold", config.threshold))
            except Exception:
                pass

    def _load_onnx(self):
        """无参数；加载 ONNX；缺少 onnxruntime 时返回 None。"""
        if self.session is not None:
            return self.session
        try:
            import onnxruntime as ort
        except Exception:
            return None
        path = self.config.model_dir / "xinai-wake.onnx"
        if not path.is_file():
            return None
        self.session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        return self.session

    def _load_torch(self):
        """无参数；加载 PyTorch 权重。"""
        import torch
        from kwsTraining.WakeModel import WakeModel
        self.model = WakeModel()
        self.model.load_state_dict(torch.load(str(self.config.model_dir / "best.pt"),
                                             map_location="cpu"))
        self.model.eval()
        return self.model

    def score_batch(self, features):
        """features 为 (N,40,120)；返回正类概率数组。"""
        if self._load_onnx() is not None:
            result = self.session.run(None, {"mel": features[:, None].astype(np.float32)})[0]
            exp = np.exp(result - result.max(axis=1, keepdims=True))
            return (exp[:, 1] / exp.sum(axis=1)).astype(np.float32)
        import torch
        model = self.model or self._load_torch()
        with torch.no_grad():
            logits = model(torch.from_numpy(features[:, None]))
            return torch.softmax(logits, dim=1)[:, 1].numpy()

    def evaluate_dataset(self):
        """无参数；返回测试集召回率与假阳性率。"""
        data = np.load(str(self.config.data_dir / "dataset.npz"), allow_pickle=True)
        mask = data["split"] == "test"
        x = data["X"][mask].astype(np.float32)
        y = data["y"][mask]
        if len(y) == 0:
            return {"test": 0, "recall": 0.0, "fpr": 0.0}
        score = self.score_batch(x)
        return {"test": int(len(y)),
                "recall": float(np.mean(score[y == 1] >= self.threshold))
                if int(y.sum()) else 0.0,
                "fpr": float(np.mean(score[y == 0] >= self.threshold))
                if int((y == 0).sum()) else 0.0}

    def evaluate_wav(self, path, positive_range=None):
        """path 为 WAV；positive_range 为 (start,end) 秒；返回触发点与得分。"""
        handle = wave.open(path, "rb")
        rate = handle.getframerate()
        channels = handle.getnchannels()
        data = handle.readframes(handle.getnframes())
        handle.close()
        if channels != 1:
            return {"error": "仅支持单声道"}
        if rate != self.config.sample_rate:
            data, _ = audioop.ratecv(data, 2, 1, rate, self.config.sample_rate, None)
        samples = np.frombuffer(data, dtype=np.int16)
        win, hop = self.config.window_samples, self.config.hop_samples
        rows, starts = [], []
        for start in range(0, max(1, len(samples) - win + 1), hop):
            chunk = samples[start:start + win]
            if chunk.size < win:
                chunk = np.pad(chunk, (0, win - chunk.size))
            rows.append(self.logmel.features(chunk))
            starts.append(start / self.config.sample_rate)
        if not rows:
            return {"error": "音频过短"}
        scores = self.score_batch(np.asarray(rows))
        hits = []
        streak = 0
        for index, value in enumerate(scores):
            if value >= self.threshold:
                streak += 1
                if streak == self.config.consecutive_hits:
                    hits.append(round(starts[index], 2))
            else:
                streak = 0
        result = {"hits": hits, "max": float(np.max(scores)), "frames": len(scores)}
        if positive_range is not None:
            begin, end = positive_range
            inside = [score for start, score in zip(starts, scores)
                      if begin <= start <= end]
            outside = [score for start, score in zip(starts, scores)
                       if not (begin <= start <= end)]
            result["positive_max"] = float(max(inside)) if inside else 0.0
            result["negative_max"] = float(max(outside)) if outside else 0.0
            result["hit_inside"] = bool(inside and max(inside) >= self.threshold)
        return result
