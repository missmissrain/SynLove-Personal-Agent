"""停服验收回归：覆盖响应中断但端口已释放，以及身份不明的端口仍占用的情况。
参数：unittest；只使用模拟传输和端口，不关闭真实服务。
"""
import unittest
from types import SimpleNamespace
from unittest.mock import patch, MagicMock
from microServices.ServiceManager import ServiceManager


class ServiceShutdownTests(unittest.TestCase):
    """停服结果以实际端口为准，远程服务始终不受本机退出影响。"""

    def make_manager(self, management="managed"):
        """management 为服务归属；创建仅包含测试端点的管理器。"""
        registry = SimpleNamespace(get_service=lambda name: {
            "management": management, "host": "127.0.0.1", "port": 19999})
        return ServiceManager(registry=registry)

    def test_aborted_shutdown_response_with_released_port_is_success(self):
        """Windows 停服响应被中断，但监听确实已释放，应返回成功。"""
        manager = self.make_manager()
        with patch.object(manager, "is_ready", return_value=True), \
                patch("microServices.ServiceManager.ServiceTransport") as transport, \
                patch("microServices.ServiceManager.socket.create_connection", side_effect=OSError):
            transport.return_value.request.side_effect = ConnectionAbortedError()
            self.assertTrue(manager.stop_service("session"))

    def test_unhealthy_occupied_port_is_not_success(self):
        """无法验证身份但端口仍监听时必须报错，不能当成已停止。"""
        manager = self.make_manager()
        with patch.object(manager, "is_ready", return_value=False), \
                patch("microServices.ServiceManager.socket.create_connection", return_value=MagicMock()):
            with self.assertRaisesRegex(RuntimeError, "端口仍被占用"):
                manager.stop_service("session")

    def test_external_service_is_not_stopped(self):
        """退出本机程序不会向远程服务发送停服命令。"""
        manager = self.make_manager("external")
        with patch("microServices.ServiceManager.ServiceTransport") as transport:
            self.assertFalse(manager.stop_service("session"))
            transport.assert_not_called()
