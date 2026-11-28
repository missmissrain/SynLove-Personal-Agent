"""日志梅尔特征。

功能：只用 numpy 计算 40 维 log-mel，训练与终端推理共用同一实现。
注册参数 config 为 KwsConfig；输出形状固定为 (40, 120)。
"""

import numpy as np


def hz_to_mel(hz):
    """hz 为频率；返回梅尔刻度。"""
    return 2595.0 * np.log10(1.0 + np.asarray(hz, dtype=np.float64) / 700.0)


def mel_to_hz(mel):
    """mel 为梅尔刻度；返回频率。"""
    return 700.0 * (10.0 ** (np.asarray(mel, dtype=np.float64) / 2595.0) - 1.0)


class LogMel:
    """固定参数的 log-mel 提取器。"""

    def __init__(self, config):
        """config 为 KwsConfig；构造时缓存梅尔滤波器与汉宁窗。"""
        self.config = config
        self.fb = self._filterbank()
        self.window = np.hanning(config.win_length).astype(np.float32)

    def _filterbank(self):
        """无参数；返回 (n_mels, n_fft/2+1) 三角滤波器。"""
        cfg = self.config
        bins = cfg.n_fft // 2 + 1
        edges = mel_to_hz(np.linspace(hz_to_mel(cfg.fmin), hz_to_mel(cfg.fmax),
                                      cfg.n_mels + 2))
        freqs = np.linspace(0, cfg.sample_rate / 2, bins)
        fb = np.zeros((cfg.n_mels, bins), dtype=np.float32)
        for index in range(cfg.n_mels):
            left, center, right = edges[index], edges[index + 1], edges[index + 2]
            rising = (freqs - left) / max(1e-6, center - left)
            falling = (right - freqs) / max(1e-6, right - center)
            fb[index] = np.maximum(0.0, np.minimum(rising, falling))
        return fb

    def features(self, samples):
        """samples 为 int16/float 单声道 16k；返回 (40, frames) float32。"""
        cfg = self.config
        data = np.asarray(samples)
        if data.dtype == np.int16:
            data = data.astype(np.float32) / 32768.0
        else:
            data = data.astype(np.float32)
        peak = float(np.max(np.abs(data))) if data.size else 0.0
        if peak > 0:
            data = data / peak * 0.9
        need = (cfg.frames - 1) * cfg.hop_length + cfg.win_length
        if data.size < need:
            data = np.pad(data, (0, need - data.size))
        data = data[:need]
        view = np.lib.stride_tricks.sliding_window_view(data, cfg.win_length)[::cfg.hop_length]
        view = view[:cfg.frames]
        spectrum = np.fft.rfft(view * self.window, n=cfg.n_fft)
        power = (np.abs(spectrum) ** 2).astype(np.float32)
        mel = power @ self.fb.T
        logmel = np.log(mel + 1e-6)
        mean = float(np.mean(logmel))
        std = float(np.std(logmel))
        if std > 1e-5:
            logmel = (logmel - mean) / std
        return logmel.T.astype(np.float32)
