"""QQ 状态微服务隔离测试：验证队列幂等、分段进度和单消费者租约。

测试使用临时 SQLite，不启动 QQ 网关、不发送真实消息。
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

class QqStateServiceTests(unittest.TestCase):
    """QQ 状态服务的最小隔离回归。"""

    def setUp(self):
        """创建临时数据库并重新加载服务模块。"""
        self.temp = tempfile.TemporaryDirectory()
        os.environ["SYNLOVE_QQ_STATE_DB"] = str(Path(self.temp.name) / "qq.db")
        import importlib
        from qqState import qqStateService
        self.service = importlib.reload(qqStateService)

    def tearDown(self):
        """清理临时数据库环境。"""
        os.environ.pop("SYNLOVE_QQ_STATE_DB", None)
        self.temp.cleanup()

    def call(self, name, arguments):
        """调用一个服务工具并返回结构化结果。"""
        response = self.service.handle({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        })
        result = response["result"]
        self.assertFalse(result.get("isError"), result)
        return result["structuredContent"]

    def test_outbox_is_idempotent_and_tracks_parts(self):
        """同一消息只入队一次，并能记录分段和发送完成。"""
        reply = {"text": "同一条", "target": {"kind": "c2c", "id": "u1"}, "msgId": "m1"}
        first = self.call("qq_enqueue", {"reply": reply})["outbox"]
        second = self.call("qq_enqueue", {"reply": reply})["outbox"]
        self.assertEqual(first["id"], second["id"])
        self.call("qq_mark_part_sent", {"id": first["id"], "index": 0})
        row = self.call("qq_get", {"id": first["id"]})["outbox"]
        self.assertEqual(row["sent_parts"], [0])
        self.call("qq_mark_sent", {"id": first["id"]})
        self.assertIsNone(self.call("qq_get", {"id": first["id"]})["outbox"])

    def test_only_one_lease_holder(self):
        """同一账号同时只有一个租约持有者。"""
        args = {"pid": 1, "startedAt": 1, "staleMs": 60_000, "accountId": "qq"}
        self.assertTrue(self.call("qq_acquire_lease", {**args, "ownerId": "a"})["acquired"])
        self.assertFalse(self.call("qq_acquire_lease", {**args, "ownerId": "b"})["acquired"])
        self.assertTrue(self.call("qq_heartbeat_lease", {"ownerId": "a"})["updated"])
        self.assertTrue(self.call("qq_release_lease", {"ownerId": "a"})["updated"])
        self.assertTrue(self.call("qq_acquire_lease", {**args, "ownerId": "b"})["acquired"])

    def test_task_receipt_survives_sent_removal(self):
        """完成通知发送后仍保留幂等凭据，防止任务库确认前重启造成重复入队。"""
        reply = {"text": "后台总结", "target": {"kind": "c2c", "id": "u1"}, "dedupeKey": "task-1"}
        first = self.call("qq_enqueue", {"reply": reply})["outbox"]
        self.call("qq_mark_sent", {"id": first["id"]})
        again = self.call("qq_enqueue", {"reply": reply})["outbox"]
        self.assertEqual(first["id"], again["id"])
        self.assertEqual(self.call("qq_list_pending", {})["outbox"], [])


if __name__ == "__main__":
    unittest.main()
