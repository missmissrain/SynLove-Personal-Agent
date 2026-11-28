"""训练进度条。

功能：前台 CMD 可见的单行进度输出，包含百分比、计数、速度和预计剩余。
注册参数 total 为总步数；label 为前缀；width 为进度条宽度。
"""

import sys
import time


class DqtmBar:
    """轻量 DQTM 风格进度条，不依赖第三方库。"""

    def __init__(self, total, label="progress", width=24):
        """total 为总步数；label 为显示名；width 为字符宽度。"""
        self.total = max(1, int(total))
        self.label = str(label)
        self.width = int(width)
        self.done = 0
        self.started = time.time()
        self.last = 0.0

    def update(self, step=1, extra=""):
        """step 为增量；extra 为附加信息；按节流刷新单行。"""
        self.done = min(self.total, self.done + int(step))
        now = time.time()
        if now - self.last < 0.2 and self.done < self.total:
            return
        self.last = now
        ratio = self.done / self.total
        filled = int(self.width * ratio)
        bar = "#" * filled + "-" * (self.width - filled)
        elapsed = max(1e-6, now - self.started)
        speed = self.done / elapsed
        remain = (self.total - self.done) / speed if speed > 0 else 0
        text = "\r%s [%s] %5.1f%% %d/%d %.1f/s eta %02d:%02d %s" % (
            self.label, bar, ratio * 100, self.done, self.total, speed,
            int(remain) // 60, int(remain) % 60, extra)
        sys.stdout.write(text[:200].ljust(200))
        sys.stdout.flush()

    def close(self, extra=""):
        """无参数；补满进度并换行。"""
        self.done = self.total
        self.update(0, extra)
        sys.stdout.write("\n")
        sys.stdout.flush()
