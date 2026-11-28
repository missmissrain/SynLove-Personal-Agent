"""唤醒词分类模型。

功能：把 (40,120) 的 log-mel 窗口分类为“含欣爱 / 不含欣爱”。
注册参数 channels 为各层通道数；dropout 为分类头丢弃率。
"""

import torch
from torch import nn


class WakeModel(nn.Module):
    """小型卷积网络，CPU 单窗口推理在毫秒级。"""

    def __init__(self, channels=(32, 64, 128), dropout=0.2):
        """channels 为三层卷积通道；dropout 为分类头丢弃率。"""
        super().__init__()
        blocks = []
        prev = 1
        for index, width in enumerate(channels):
            blocks.extend([
                nn.Conv2d(prev, width, kernel_size=3, padding=1, bias=False),
                nn.BatchNorm2d(width),
                nn.ReLU(inplace=True),
                nn.MaxPool2d(2, 2),
            ])
            prev = width
        self.body = nn.Sequential(*blocks)
        self.head = nn.Sequential(
            nn.AdaptiveAvgPool2d(1), nn.Flatten(),
            nn.Dropout(dropout), nn.Linear(prev, 2))

    def forward(self, x):
        """x 为 (B,1,40,120)；返回 (B,2) logits。"""
        return self.head(self.body(x))
