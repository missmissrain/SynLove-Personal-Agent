"""Observation 微服务隔离测试：验证脱敏记录幂等追加和只读快照。

测试使用临时 SQLite，不启动模型、不连接远程端点。
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class ObservationServiceTests(unittest.TestCase):
    """观测服务最小回归。"""

    def setUp(self):
        """创建临时数据库并加载服务模块。"""
        self.temp = tempfile.TemporaryDirectory()
        os.environ["SYNLOVE_OBSERVATION_DB"] = str(Path(self.temp.name) / "observation.db")
        import importlib
        from observation import observationService
        self.service = importlib.reload(observationService)

    def tearDown(self):
        """清理临时目录和环境变量。"""
        os.environ.pop("SYNLOVE_OBSERVATION_DB", None)
        self.temp.cleanup()

    def call(self, name, arguments):
        """调用一个观测工具并返回结构化结果。"""
        response = self.service.handle({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        })
        result = response["result"]
        self.assertFalse(result.get("isError"), result)
        return result["structuredContent"]

    def test_append_is_idempotent(self):
        """同一脱敏记录重复提交只保存一次。"""
        record = {"traceId": "t1", "kind": "model", "phase": "start", "at": "2026-10-31T00:00:00Z"}
        self.assertTrue(self.call("observation_append", {"record": record})["inserted"])
        self.assertFalse(self.call("observation_append", {"record": record})["inserted"])
        self.assertEqual(self.call("observation_snapshot", {})["count"], 1)
        self.assertEqual(len(self.call("observation_recent", {"limit": 10})["records"]), 1)


if __name__ == "__main__":
    unittest.main()
