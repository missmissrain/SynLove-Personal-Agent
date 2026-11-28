"""家庭节点超时补丁回归：用临时配置运行真实 PowerShell 脚本，不连接远端。

默认只验证显式节点与注册表的等待值、配置保留及选择性备份，不启动节点或模型。
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


class RelayTimeoutPatchTests(unittest.TestCase):
    """用真实解释器验证交给家庭节点的配置补丁。"""

    def test_patch_preserves_addresses_and_updates_registry_override(self):
        """无参数；显式注册表的覆盖值也必须更新，否则 worker 改动不会生效。"""
        script = Path(__file__).resolve().parents[3] / "消息中转" / "deploy" / "SetRelayTimeouts.ps1"
        if not script.exists():
            self.skipTest("独立发行包没有中转仓库，跳过配套脚本测试")
        shell = shutil.which("pwsh") or shutil.which("powershell")
        if not shell:
            self.skipTest("无 PowerShell")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = root / "config"
            config.mkdir()
            node_path = config / "node.json"
            registry = config / "serviceConfig.json"
            node = {"hubUrl": "wss://relay.example.test/ws/node",
                    "serviceConfigFile": "config/serviceConfig.json",
                    "workers": {name: {"mode": "test", "timeoutMs": 180000}
                                for name in ("chat", "tts", "asr")}}
            services = {"version": 1, "services": {
                name: {"baseURL": "http://127.0.0.1:1/v1", "timeoutSeconds": 180}
                for name in ("llm", "tts", "asr")}}
            node_path.write_text(json.dumps(node), encoding="utf-8")
            registry.write_text(json.dumps(services), encoding="utf-8")
            env = os.environ.copy()
            env.pop("SYNLOVE_SERVICE_CONFIG", None)
            result = subprocess.run([shell, "-NoProfile", "-File", str(script),
                                     "-NodeConfig", str(node_path), "-WorkerSeconds", "900"],
                                    capture_output=True, timeout=30, env=env)
            self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
            changed = json.loads(node_path.read_text(encoding="utf-8-sig"))
            changed_services = json.loads(registry.read_text(encoding="utf-8-sig"))
            self.assertEqual(changed["hubUrl"], node["hubUrl"])
            self.assertTrue(all(row["timeoutMs"] == 900000 for row in changed["workers"].values()))
            self.assertTrue(all(row["timeoutSeconds"] == 900
                                for row in changed_services["services"].values()))
            self.assertEqual(changed_services["services"]["tts"]["baseURL"], "http://127.0.0.1:1/v1")
            backups = list((root / "备份").glob("*/版本记录.json"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(len(json.loads(backups[0].read_text(encoding="utf-8-sig"))["files"]), 2)
