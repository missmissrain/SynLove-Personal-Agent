"""功能：通道注册表，汇总微信与 QQ 的统一状态，作为唯一对外出口。

注册参数root为主项目路径、config为可选配置（weixinDb/qqDb）；默认用各通道类自己的默认路径。
本类不连接平台、不发消息；外部只调 snapshot()。
"""
import time
from pathlib import Path

from channels.QqChannel import QqChannel
from channels.WeixinChannel import WeixinChannel


class ChannelRegistry:
    """微信与 QQ 的聚合出口。"""

    def __init__(self, root, config=None):
        """root为主项目Path；config可指定 weixinDb/qqDb。"""
        self.root = Path(root)
        config = dict(config or {})
        self.channels = {
            "weixin": WeixinChannel(self.root, config.get("weixinDb")),
            "qq": QqChannel(self.root, config.get("qqDb")),
        }

    def snapshot(self):
        """无参数；返回所有通道的统一快照。"""
        values = {}
        errors = {}
        for name, channel in self.channels.items():
            try:
                values[name] = channel.snapshot()
            except Exception as error:
                errors[name] = type(error).__name__
                values[name] = {"name": name, "state": "error",
                                "error": type(error).__name__}
        return {"updatedAt": time.time(), "channels": values, "errors": errors}
