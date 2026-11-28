"""功能：验证服务器设备能力随主项目core启动和关闭，不创建独立终端进程。

注册参数无；使用临时配置和模拟运行时，不访问生产设备、网络或模型。
"""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from microServices.ServiceHost import ServiceHost


class TerminalHostTests(unittest.TestCase):
    """确认宿主归属和配置边界，避免其他服务重复启动设备管理。"""

    def check_host(self, name, configured):
        """name为服务名称，configured控制是否有桥接配置；返回模拟启动和关闭次数。"""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            if configured:
                (root / "config").mkdir()
                (root / "config/terminalConnection.json").write_text("{}", encoding="utf8")
            registry = SimpleNamespace(path=root / "serviceConfig.json",
                get_service=lambda key: {"dataDir": str(root / "state")})
            with patch("remoteControl.TerminalServerRuntime.TerminalServerRuntime") as runtime, \
                    patch("microServices.ServiceHost.OperationStore"):
                host = ServiceHost(name, registry, root)
                try:
                    counts = (runtime.call_count, runtime.return_value.start_runtime.call_count)
                finally:
                    host.close()
                return counts + (runtime.return_value.close_runtime.call_count,)

    def test_core_owns_runtime_lifecycle(self):
        """无参数；已配置的core只启动一次运行时，并在退出时释放一次。"""
        self.assertEqual(self.check_host("core", True), (1, 1, 1))

    def test_missing_config_does_not_start_runtime(self):
        """无参数；未配置终端的主项目保持现有服务生命周期。"""
        self.assertEqual(self.check_host("core", False), (0, 0, 0))

    def test_other_services_do_not_start_runtime(self):
        """无参数；即使存在桥接配置，其他服务也不能重复占用设备端口。"""
        self.assertEqual(self.check_host("history", True), (0, 0, 0))
