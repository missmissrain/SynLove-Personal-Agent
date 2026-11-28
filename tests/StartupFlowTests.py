"""统一启动回归。使用临时停止标记和启动函数桩，不连接真实模型、QQ或微信，不改变生产文件。"""

import json
from contextlib import ExitStack
import tempfile
import unittest
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import start_stack
from services.StartupState import StartupState


class StartupFlowTests(unittest.TestCase):
    """验证暂停消费、取消竞态与云端启动不等待可选服务。"""

    def test_old_stop_is_consumed_only_on_success(self):
        """无参数；旧暂停仅在显式确认启动成功时清理。"""
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "runtime" / "guardian.pause"
            path.parent.mkdir()
            path.write_text('{"reason":"old"}', encoding="utf-8")
            state = StartupState(folder)
            self.assertFalse(state.was_stopped())
            self.assertTrue(path.exists())
            state.complete_start()
            self.assertFalse(path.exists())

    def test_new_stop_cannot_be_cleared_by_old_start(self):
        """无参数；启动中新的停止覆盖旧标记时必须保留新停止。"""
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "runtime" / "guardian.pause"
            path.parent.mkdir()
            path.write_text('{"reason":"old"}', encoding="utf-8")
            state = StartupState(folder)
            path.write_text('{"reason":"new"}', encoding="utf-8")
            self.assertTrue(state.was_stopped())
            state.complete_start()
            self.assertEqual(json.loads(path.read_text())["reason"], "new")

    def test_new_stop_is_detected_without_previous_marker(self):
        """无参数；原来没有暂停标记也必须识别启动中收到的停止。"""
        with tempfile.TemporaryDirectory() as folder:
            state = StartupState(folder)
            state.path.parent.mkdir()
            state.path.write_text("stop", encoding="utf-8")
            self.assertTrue(state.was_stopped())

    def test_cloud_start_prioritizes_harness(self):
        """无参数；云端默认模型直接启动Harness，所有可选依赖只能在核心就绪后派生。"""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            entry = root / "start.ps1"
            entry.touch()
            registry = SimpleNamespace(
                get_service=lambda name: {"management": "managed", "provider": "gemma-local"},
                apply_environment=lambda env: None,
                apply_model_config=lambda config, env=None: None)
            order = []
            def spawn_core(env):
                """env为假环境；记录核心派生而不启动进程。"""
                order.append("core")
                return SimpleNamespace(pid=1)
            def ready(*args):
                """args为就绪参数；记录核心确认顺序。"""
                order.append("ready")
                return True
            with ExitStack() as stack:
                for name, value in (("PROJECT_ROOT", root), ("HARNESS_SCRIPT", entry)):
                    stack.enter_context(patch.object(start_stack, name, value))
                for name, value in (("ServiceRegistry", registry), ("port_open", False),
                                    ("load_model_config", {"defaultModel": {"provider": "cloud"}}),
                                    ("load_console_env", []), ("sync_credentials", (0, []))):
                    stack.enter_context(patch.object(start_stack, name, return_value=value))
                calls = {}
                for name in ("kill_orphan_harness", "clear_stale_lease", "clear_stuck_deliveries",
                             "verify_harness_source", "apply_environment", "remember_python_for_console",
                             "sync_settings", "ensure_gemma_server", "ensure_opencode_server",
                             "ensure_rsshub", "ensure_reminder_service", "check_weixin_token"):
                    calls[name] = stack.enter_context(patch.object(start_stack, name))
                stack.enter_context(patch.object(start_stack, "start_harness_service", side_effect=spawn_core))
                stack.enter_context(patch.object(start_stack, "wait_harness_ready", side_effect=ready))
                stack.enter_context(patch.object(start_stack.StartupServices, "detach_start",
                                                side_effect=lambda env: order.append("optional") or 2))
                self.assertEqual(start_stack.main(), 0)
                self.assertEqual(order, ["core", "ready", "optional"])
                for name in ("ensure_gemma_server", "ensure_opencode_server", "ensure_rsshub",
                             "ensure_reminder_service", "check_weixin_token"):
                    calls[name].assert_not_called()


if __name__ == "__main__":
    unittest.main()
