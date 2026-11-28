"""发行安装测试：用临时目录验证默认人格、路径渲染和用户配置保护。

运行 python -m unittest discover -s installer/tests -p '*Test.py'；不安装依赖、不启动消息消费者。
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from installer.BootstrapManager import BootstrapManager


class BootstrapManagerTest(unittest.TestCase):
    """验证安装器只依赖包内模板，重复执行不覆盖已经保存的用户设置。"""

    def test_config_is_portable_and_idempotent(self):
        """无参数；生成配置后修改用户数据，第二次初始化必须完整保留。"""
        source = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="SynLovePortable-") as directory:
            root = Path(directory)
            (root / "config").mkdir()
            for name in ("modelConfig.example.json", "secrets.example.json", "harnessTuning.example.json",
                         "weixinProfile.patch.example.yml"):
                shutil.copyfile(source / "config" / name, root / "config" / name)
            shutil.copytree(source / "config" / "agentPresets", root / "config" / "agentPresets")
            shutil.copytree(source / "prompts", root / "prompts")
            installer = BootstrapManager(root)
            installer.initialize_config()
            patch = root / "config" / "weixinDoubaoProfile.patch.yml"
            text = patch.read_text(encoding="utf-8")
            self.assertIn("你叫欣爱", text)
            self.assertNotIn("<项目根>", text)
            self.assertIn(root.as_posix(), text)
            self.assertTrue((root / "runtime/dsh/.agent-presets/weixin-lite/agent.cordis.yml").is_file())
            secrets = json.loads((root / "config/secrets.json").read_text(encoding="utf-8"))
            self.assertEqual(secrets["weixin"]["token"], "")
            patch.write_text("用户自己的人格\n", encoding="utf-8")
            installer.initialize_config()
            self.assertEqual(patch.read_text(encoding="utf-8"), "用户自己的人格\n")
