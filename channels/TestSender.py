"""功能：test 通道发送器。只落回执，不向任何外部平台发送，用于统一入口的通道注入测试。

注册参数root为主项目路径；默认写 runtime/test-channel.log，返回 ok 让网关认为投递成功。
"""
import io
import json
import os
import time
import uuid


class TestSender:
    """测试通道：把回复写进本机日志，验证统一入口能完成整轮。"""

    def __init__(self, root):
        """root 为主项目路径；日志固定在 runtime/test-channel.log。"""
        self.root = root
        self.path = os.path.join(root, "runtime", "test-channel.log")

    def __call__(self, envelope, text):
        """envelope 为消息、text 为回复；返回可确认的回执。"""
        record = {"at": time.time(), "sender": getattr(envelope, "sender", ""),
                  "text": text, "id": uuid.uuid4().hex}
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        io.open(self.path, "a", encoding="utf-8", newline="\n").write(
            json.dumps(record, ensure_ascii=False) + "\n")
        return {"ok": True, "channel": "test", "id": record["id"], "mode": "test"}
