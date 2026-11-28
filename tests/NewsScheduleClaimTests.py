"""新闻配置回归：调整启用状态不能重发当天已经领取的摘要，不调用真实服务。"""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from microServices.ScheduleStore import ScheduleStore


class NewsScheduleClaimTests(unittest.TestCase):
    """独立保留原通知测试中的新闻调度约束，不依赖已移除的观察者。"""

    def test_enable_preserves_today_claim(self):
        """无参数；开启后持久生效，但当天已领取任务不得再次领取。"""
        with tempfile.TemporaryDirectory() as folder:
            store = ScheduleStore(Path(folder))
            store.confirm_enqueued("digest-schedule-" + time.strftime("%Y-%m-%d"))
            result = json.loads(store.configure({"action": "set", "time": "08:55", "enabled": True}, None))
            self.assertTrue(result["enabled"])
            self.assertEqual(result["time"], "08:55")
            self.assertIsNone(store.claim_due())
            self.assertTrue(json.loads(ScheduleStore(Path(folder)).configure({"action": "get"}, None))["enabled"])
