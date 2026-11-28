"""迁移路径回归：验证独立启动的守护和修复脚本不再读取全局旧状态。
默认使用临时安装根和模拟环境，不连接平台、不调用修复器。
"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from services.RuntimePaths import RuntimePaths


class RuntimePathsTests(unittest.TestCase):
    """测试路径、旧日志隔离及可选模型的健康判断。"""

    def test_installation_data_is_default(self):
        """未传环境变量时，数据必须归属于选定安装目录。"""
        with patch.dict(os.environ, {}, clear=True), tempfile.TemporaryDirectory() as tmp:
            paths = RuntimePaths(tmp)
            self.assertEqual(paths.home, Path(tmp) / "runtime/dsh")
            self.assertEqual(paths.state, paths.home / "weixin-state.db")
            self.assertEqual(paths.qq_lock, paths.home / "qq-gateway.pid")

    def test_explicit_overrides_are_consistent(self):
        """外部显式数据目录和状态文件覆盖必须作用于所有读取方。"""
        with patch.dict(os.environ, {"DSH_HOME": "customHome", "DSH_WEIXIN_STATE_DB": "customState.db"}):
            paths = RuntimePaths("fixture")
            self.assertEqual(paths.sessions, Path("customHome/sessions"))
            self.assertEqual(paths.state, Path("customState.db"))

    def test_guard_ignores_poll_events_from_before_its_start(self):
        """旧运行日志中的静默不能让新实例刚启动就进入恢复流程。"""
        from tools import guardService as guard
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "runtime").mkdir()
            (root / "runtime/weixin-probe.log").write_text(
                json.dumps({"event": "poll.idle", "at": "2020-01-01T00:00:00Z"}) + "\n", encoding="utf-8")
            with patch.object(guard, "ROOT", root), patch.object(guard, "restart_stack") as restart:
                guard.check_weixin_stall()
                restart.assert_not_called()

    def test_cloud_chat_does_not_require_optional_gemma(self):
        """默认模型是云端时，不访问 Gemma 健康接口、不记为核心故障。"""
        from tools import guardService as guard
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "config").mkdir()
            (root / "config/modelConfig.json").write_text(
                json.dumps({"defaultModel": {"provider": "qwen"}}), encoding="utf-8")
            with patch.object(guard, "ROOT", root), \
                    patch("services.ServiceRegistry.ServiceRegistry") as registry, \
                    patch("services.ServiceClient.ServiceClient") as client:
                registry.return_value.get_service.return_value = {"provider": "gemma-local", "management": "managed"}
                self.assertIsNone(guard.check_gemma_alive())
                client.assert_not_called()
