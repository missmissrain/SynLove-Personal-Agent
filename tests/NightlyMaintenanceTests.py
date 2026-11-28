"""夜间维护回归测试：使用临时源码与假CLI，不调用模型；验证并发覆盖、越界及失败隔离。"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from maintenance.RepositoryWorkspace import RepositoryWorkspace
from maintenance.NightlyMaintenance import NightlyMaintenance


class NightlyMaintenanceTests(unittest.TestCase):
    """验证自动维护的真实补丁生成与应用边界。"""

    def make_workspace(self, root):
        """root为临时目录，创建带私有配置及嵌套配置模块的源码。"""
        source = root / "production"
        source.mkdir()
        (source / "example.py").write_text("value = 1\n", encoding="utf-8")
        (source / "config").mkdir()
        (source / "config/private.json").write_text('{"key":"private"}', encoding="utf-8")
        (source / "skills/config").mkdir(parents=True)
        (source / "skills/config/Loader.py").write_text("value = 2\n", encoding="utf-8")
        box = RepositoryWorkspace(source, root / "isolated")
        box.prepare_workspace()
        return box

    def test_patch_preserves_user_git_and_secrets(self):
        """真实Git补丁应用成功，私有配置不进入隔离区，嵌套源码配置模块仍保留。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            box = self.make_workspace(root)
            self.assertFalse((box.work / "config").exists())
            self.assertTrue((box.work / "skills/config/Loader.py").exists())
            (box.work / "example.py").write_text("value = 3\n", encoding="utf-8")
            patch_file = root / "result.patch"
            names = box.collect_patch(patch_file)
            box.apply_patch(patch_file, names)
            self.assertEqual((box.source / "example.py").read_text(), "value = 3\n")
            self.assertFalse((box.source / ".git").exists())

    def test_concurrent_user_edit_is_preserved(self):
        """隔离区完成后人工又修改原文件，自动维护必须拒绝应用。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            box = self.make_workspace(root)
            (box.work / "example.py").write_text("value = 3\n", encoding="utf-8")
            patch_file = root / "result.patch"
            names = box.collect_patch(patch_file)
            (box.source / "example.py").write_text("value = 5\n", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                box.apply_patch(patch_file, names)
            self.assertEqual((box.source / "example.py").read_text(), "value = 5\n")

    def test_delete_and_secret_changes_rejected(self):
        """删除文件和写入凭据都不能作为自动补丁应用。"""
        with tempfile.TemporaryDirectory() as temp:
            box = self.make_workspace(Path(temp))
            (box.work / "example.py").unlink()
            with self.assertRaises(RuntimeError):
                box.collect_patch(Path(temp) / "bad.patch")
            self.assertFalse(box.allowed_path("../outside.py"))
            self.assertFalse(box.allowed_path("config/model.json"))
            self.assertFalse(box.allowed_path("privateKeys/key.pem"))

    def test_failed_check_never_changes_production(self):
        """假Codex写出补丁但验收失败时，生产代码保持原样。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "production"
            source.mkdir()
            (source / "example.py").write_text("value = 1\n", encoding="utf-8")
            (root / "prompts").mkdir()
            (root / "prompts/NightlyMaintenance.md").write_text("test", encoding="utf-8")
            config = root / "settings.json"
            config.write_text(json.dumps({}), encoding="utf-8")
            service = NightlyMaintenance(root, config)
            def fake_process(args, cwd, timeout, log):
                """假执行器模拟模型成功、验收失败。"""
                if args[0] == "fakeCodex":
                    (cwd / "example.py").write_text("value = 3\n", encoding="utf-8")
                    return 0
                return 1
            def fake_codex(prompt, work, timeout):
                """模拟独立设备在隔离目录写文件，不调用真实Codex。"""
                (work / "example.py").write_text("value = 3\n", encoding="utf-8")
                return {"text": "fixture", "patch": b"", "device": "fixture", "jobId": "fixture"}
            with patch.object(service, "run_process", side_effect=fake_process), patch(
                    "maintenance.CodexDispatcher.CodexDispatcher") as dispatcher:
                dispatcher.return_value.execute_task.side_effect = fake_codex
                with self.assertRaises(RuntimeError):
                    service.run_repository({"name": "example", "path": str(source),
                                            "autoApply": True, "checks": [["check"]]},
                                           root / "run", "fakeCodex")
            self.assertEqual((source / "example.py").read_text(), "value = 1\n")
