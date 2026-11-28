"""微信状态微服务隔离测试。覆盖 outbox、turn context、lease 的状态迁移。

测试使用临时 SQLite，不连接生产服务，不发送真实微信或 QQ 消息。
"""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


SERVICE_PATH = Path(__file__).parents[1] / "state" / "stateService.py"


class StateServiceTests(unittest.TestCase):
    """验证微信状态服务的核心状态操作。"""

    def setUp(self):
        """无参数；为每个测试创建隔离数据库连接。"""
        spec = importlib.util.spec_from_file_location("state_service", SERVICE_PATH)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        fd, name = tempfile.mkstemp(prefix="synlove-state-", suffix=".db")
        os.close(fd)
        self.path = Path(name)
        self.module.DB_PATH = self.path
        self.db = self.module.connect()
        self.module.ensure_schema(self.db)

    def tearDown(self):
        """无参数；关闭连接并清理临时数据库。"""
        self.db.close()
        if self.path.exists():
            os.remove(self.path)

    def test_outbox_and_turn_context(self):
        """验证出站队列顺序、分段记录和轮次上下文。"""
        record = self.module.enqueue_outbox(self.db, {
            "session_id": "s1", "user_id": "u1", "kind": "reply", "text": "hello", "turn": 1,
        })
        self.assertEqual(record["outbound_id"], "s1:1")
        self.assertEqual(self.module.next_outbox(self.db, "s1")["text"], "hello")
        self.assertTrue(self.module.mark_outbox(self.db, "s1:1", "sending", {}))
        self.assertTrue(self.module.mark_outbox(self.db, "s1:1", "part_sent", {"index": 0}))
        self.assertTrue(self.module.mark_outbox(self.db, "s1:1", "sent", {}))
        self.assertEqual(self.module.get_outbox(self.db, "s1:1")["status"], "sent")
        self.assertTrue(self.module.bind_turn_context(self.db, {
            "session_id": "s1", "turn": 1, "delivery_id": "d1", "user_id": "u1", "context_token": "ctx",
        }))
        self.assertEqual(self.module.get_turn_context(self.db, "s1", 1)["delivery_id"], "d1")

    def test_lease_is_single_owner(self):
        """验证同一时间只有一个租约持有者。"""
        args = {"owner_id": "o1", "pid": 1, "process_started_at": 1, "account_id": "a", "stale_ms": 30000}
        self.assertTrue(self.module.try_acquire_lease(self.db, args))
        args["owner_id"] = "o2"
        self.assertFalse(self.module.try_acquire_lease(self.db, args))
        self.assertTrue(self.module.heartbeat_lease(self.db, "o1"))
        self.assertFalse(self.module.heartbeat_lease(self.db, "o2"))
        self.module.release_lease(self.db, "o1")
        self.assertTrue(self.module.try_acquire_lease(self.db, args))


if __name__ == "__main__":
    unittest.main()
