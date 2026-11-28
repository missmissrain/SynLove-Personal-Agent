"""生产数据路径：为守护、修复、复盘统一解析会话和状态目录。
注册参数 root 为安装根，默认本文件上级；DSH_HOME 与 DSH_WEIXIN_STATE_DB 可显式覆盖。
"""
import os
from pathlib import Path


class RuntimePaths:
    """不读取用户全局 .dsh，避免安装迁移后出现两个状态真相。"""

    def __init__(self, root=None):
        """root 为选定安装路径；环境覆盖优先，默认只在当前安装 runtime 下存储。"""
        self.root = Path(root or Path(__file__).resolve().parents[1])
        self.home = Path(os.environ.get("DSH_HOME") or self.root / "runtime/dsh")
        self.state = Path(os.environ.get("DSH_WEIXIN_STATE_DB") or self.home / "weixin-state.db")
        self.qq_lock = self.home / "qq-gateway.pid"
        self.sessions = self.home / "sessions"
        self.credentials = self.home / ".credentials.yaml"
        self.preset = self.home / ".agent-presets/weixin-lite"
