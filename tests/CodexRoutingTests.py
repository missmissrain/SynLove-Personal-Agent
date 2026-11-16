"""执行设备路由回归：假设备状态验证天选优先、离线兜底与不明网络状态停止，不调用模型。"""
import unittest
from unittest.mock import Mock
from maintenance.CodexDispatcher import CodexDispatcher


class CodexRoutingTests(unittest.TestCase):
    """避免网络抖动触发两端同时跑相同任务。"""

    def make_dispatcher(self, rows):
        """rows为假设备列表，不初始化真实管理器或读取任何凭据。"""
        service = CodexDispatcher.__new__(CodexDispatcher)
        service.settings = {}
        service.client = Mock()
        service.client.request_json.return_value = {"devices": rows}
        return service

    def test_online_primary(self):
        """首选在线且具备异步编码能力时，必须选天选。"""
        service = self.make_dispatcher([{"id": "tianxuanLaptop", "online": True, "capabilities": ["coding.run"]}])
        self.assertEqual(service.select_device(), "tianxuanLaptop")

    def test_offline_fallback(self):
        """确认天选离线后才使用服务器。"""
        service = self.make_dispatcher([{"id": "tianxuanLaptop", "online": False}])
        self.assertIsNone(service.select_device())
        service.settings["fallbackLocal"] = False
        with self.assertRaises(RuntimeError):
            service.select_device()

    def test_unknown_network_does_not_fallback(self):
        """管理器超时与设备在线但能力缺失都不能被误判为离线。"""
        service = self.make_dispatcher([])
        service.client.request_json.side_effect = TimeoutError()
        with self.assertRaises(TimeoutError):
            service.select_device()
        service = self.make_dispatcher([{"id": "tianxuanLaptop", "online": True, "capabilities": []}])
        with self.assertRaises(RuntimeError):
            service.select_device()
