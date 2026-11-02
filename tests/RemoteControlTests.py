"""远控契约与隔离链路测试：验证配置、真实本机 SSH、输出界限、超时和 MCP 注册。

注册参数无；运行 python tests/RemoteControlTests.py，仅使用临时目录、假凭据和随机本机端口。
不调用模型，不接触生产配置，不执行真实 CMD，不访问 VPS。
"""

import base64
import hashlib
import json
import logging
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests" / "fixtures"))

from RemoteSshServer import RemoteSshServer
from remoteControl.RemoteCmdClient import RemoteCmdClient
from remoteControl.RemoteCmdMcp import RemoteCmdMcp
from remoteControl.RemoteCmdTools import RemoteCmdTools
from remoteControl.RemoteControlRegistration import RemoteControlRegistration
from remoteControl.RemoteTargetConfig import RemoteTargetConfig
from remoteControl.RemoteControlAdmin import RemoteControlAdmin
from services.ServiceCredential import ServiceCredential


class RemoteControlTests(unittest.TestCase):
    """针对新工具的独立故障与真实协议回归。"""

    def setUp(self):
        """无参数；为每个用例创建独立根目录，不使用生产 secrets。"""
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "config").mkdir()
        self.config = RemoteTargetConfig(self.root)
        self.client = RemoteCmdClient(self.config)
        self.tools = RemoteCmdTools(self.config, self.client)
        logging.getLogger("paramiko").setLevel(logging.CRITICAL)

    def configure_target(self, server, **overrides):
        """server 为本机测试端；overrides 覆盖目标参数并生成仅含假凭据的配置。"""
        fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(server.key.asbytes()).digest()).decode().rstrip("=")
        target = {"enabled": True, "host": "127.0.0.1", "port": server.port, "user": "tester",
                  "hostKeySha256": fingerprint, "description": "测试电脑", **overrides}
        self.config.path.write_text(json.dumps({"targets": {"testPc": target}}), encoding="utf-8")
        (self.root / "config" / "secrets.json").write_text(json.dumps({
            "remoteControl": {"targets": {"testPc": {"password": "fake-secret"}}}
        }), encoding="utf-8")

    def decode_result(self, result):
        """result 为 MCP 工具响应；提取 JSON 业务结果。"""
        return json.loads(result["content"][0]["text"])

    def test_unconfigured_is_usable(self):
        """无配置时工具正常挂载并返回空列表，不联网。"""
        result = self.tools.call_tool("remote_cmd_list", {})
        self.assertFalse(result["isError"])
        self.assertEqual(self.decode_result(result)["targets"], [])

    def test_unknown_target_no_connection(self):
        """未知别名在联网前拒绝。"""
        factory = MagicMock()
        client = RemoteCmdClient(self.config, factory)
        with self.assertRaises(ValueError):
            client.execute_command("unknown", "whoami")
        factory.assert_not_called()

    def test_disabled_target(self):
        """关闭目标不能绕过配置执行命令。"""
        self.config.path.write_text('{"targets":{"testPc":{"enabled":false}}}', encoding="utf-8")
        result = self.tools.call_tool("remote_cmd_run", {"target": "testPc", "command": "echo hi"})
        self.assertTrue(result["isError"])
        self.assertIn("尚未启用", self.decode_result(result)["error"])

    def test_parameter_bounds(self):
        """错误类型、超出上限和任意连接参数不能传入执行层。"""
        for args in ({"target": "testPc", "command": ""},
                     {"target": "testPc", "command": "echo x", "timeoutSec": True},
                     {"target": "testPc", "command": "echo x", "timeoutSec": 121},
                     {"target": "testPc", "command": "echo x", "host": "elsewhere"}):
            with self.subTest(args=args):
                self.assertTrue(self.tools.call_tool("remote_cmd_run", args)["isError"])

    def test_list_does_not_leak_credentials(self):
        """列表隐藏服务器地址、账号、密码和主机公钥。"""
        with RemoteSshServer(lambda *args: None) as server:
            self.configure_target(server)
            text = json.dumps(self.config.list_targets())
            for private in ("127.0.0.1", "tester", "fake-secret", "SHA256:"):
                self.assertNotIn(private, text)

    def test_successful_real_ssh_and_cmd_wrapper(self):
        """通过真实本机 SSH 验证中文输出及 CMD 包装，不执行真实程序。"""
        def handler(channel, command):
            """channel/command 为测试请求；返回 UTF-8 假输出。"""
            channel.sendall("你好，欣爱".encode())
            channel.send_exit_status(0)
        with RemoteSshServer(handler) as server:
            self.configure_target(server)
            result = self.client.execute_command("testPc", "echo 你好")
            self.assertTrue(result["ok"])
            self.assertEqual(result["stdout"], "你好，欣爱")
            self.assertEqual(server.command, 'cmd.exe /d /s /c "echo 你好"')
            self.assertIsNone(server.error)

    def test_probe_checks_exact_marker(self):
        """探活必须读到真实 CMD 响应，不能只因端口或登录成功就报在线。"""
        def handler(channel, command):
            """channel/command 为假请求；返回固定探活标志。"""
            channel.sendall(b"SynLoveRemoteCmdReady\r\n")
            channel.send_exit_status(0)
        with RemoteSshServer(handler) as server:
            self.configure_target(server)
            result = self.tools.call_tool("remote_cmd_probe", {"target": "testPc"})
            self.assertFalse(result["isError"])
            self.assertIn("echo SynLoveRemoteCmdReady", server.command)

    def test_probe_wrong_marker_fails(self):
        """登录到错误 shell 或非预期输出不能通过探活。"""
        fake = MagicMock()
        fake.execute_command.return_value = {"ok": True, "stdout": "other"}
        result = RemoteCmdTools(self.config, fake).call_tool("remote_cmd_probe", {"target": "testPc"})
        self.assertTrue(result["isError"])

    def test_nonzero_exit_and_gbk_stderr(self):
        """真实非零退出码、GBK 中文 stderr 原样反馈，失败不伪报成功。"""
        def handler(channel, command):
            """channel/command 为假请求；返回错误文本及退出码。"""
            channel.sendall_stderr("找不到文件".encode("gb18030"))
            channel.send_exit_status(7)
        with RemoteSshServer(handler) as server:
            self.configure_target(server)
            result = self.tools.call_tool("remote_cmd_run", {"target": "testPc", "command": "type missing"})
            data = self.decode_result(result)
            self.assertTrue(result["isError"])
            self.assertEqual(data["exitCode"], 7)
            self.assertEqual(data["stderr"], "找不到文件")

    def test_large_both_streams_no_deadlock(self):
        """两路各超 SSH 窗口的大输出不死锁，模型携带量保持固定上限。"""
        def handler(channel, command):
            """channel/command 为假请求；交替发送大于 SSH 窗口的双路内容。"""
            for _ in range(320):
                channel.sendall(b"O" * 8192)
                channel.sendall_stderr(b"E" * 8192)
            channel.send_exit_status(0)
        with RemoteSshServer(handler) as server:
            self.configure_target(server)
            result = self.client.execute_command("testPc", "large fake output", 15)
            self.assertTrue(result["ok"])
            self.assertTrue(result["truncated"])
            self.assertEqual(len(result["stdout"]) + len(result["stderr"]), 32768)

    def test_timeout_no_retry_and_uncertain_remote(self):
        """超时有明确失败标记，不声称远端已停止，不自动执行第二次。"""
        def handler(channel, command):
            """channel/command 为假请求；发送部分输出后等待超过命令期限。"""
            channel.sendall(b"started")
            time.sleep(1.3)
        with RemoteSshServer(handler) as server:
            self.configure_target(server)
            start = time.monotonic()
            result = self.client.execute_command("testPc", "long fake task", 1)
            self.assertTrue(result["timedOut"])
            self.assertTrue(result["remoteMayStillRun"])
            self.assertEqual(result["stdout"], "started")
            self.assertLess(time.monotonic() - start, 3)
            self.assertEqual(server.command, 'cmd.exe /d /s /c "long fake task"')

    def test_wrong_fingerprint_prevents_execution(self):
        """错误主机公钥在执行任何命令前拒绝。"""
        with RemoteSshServer(lambda *args: None) as server:
            self.configure_target(server, hostKeySha256="SHA256:" + base64.b64encode(b"x" * 32).decode().rstrip("="))
            result = self.tools.call_tool("remote_cmd_run", {"target": "testPc", "command": "whoami"})
            self.assertTrue(result["isError"])
            self.assertIsNone(server.command)
            self.assertNotIn("127.0.0.1", str(result))
            self.assertNotIn("fake-secret", str(result))

    def test_missing_fingerprint_rejected(self):
        """无指纹或可信 known_hosts 时不能静默接受主机。"""
        with RemoteSshServer(lambda *args: None) as server:
            self.configure_target(server, hostKeySha256="")
            result = self.tools.call_tool("remote_cmd_probe", {"target": "testPc"})
            self.assertTrue(result["isError"])
            self.assertIn("hostKeySha256", self.decode_result(result)["error"])

    def test_broken_auth_no_retry(self):
        """错误密码不会反复登录，且不会把凭据暴露给模型。"""
        with RemoteSshServer(lambda *args: None) as server:
            self.configure_target(server, user="wrong-user")
            result = self.tools.call_tool("remote_cmd_run", {"target": "testPc", "command": "whoami"})
            self.assertTrue(result["isError"])
            self.assertIsNone(server.command)
            self.assertNotIn("fake-secret", str(result))

    def test_cut_utf8_boundary(self):
        """输出截断恰好切到中文字符时，已有 UTF-8 文本不被误识别成 GBK。"""
        self.assertEqual(self.client.decode_output("你好".encode() + b"\xe4", "auto"), "你好\ufffd")

    def test_mcp_contract_and_bad_params(self):
        """初始化、通知、错误方法和错误参数符合 JSON-RPC。"""
        mcp = RemoteCmdMcp(self.tools)
        init = mcp.handle_message({"id": 1, "method": "initialize"})
        self.assertIn("tools", init["result"]["capabilities"])
        self.assertIsNone(mcp.handle_message({"method": "notifications/initialized"}))
        self.assertEqual(mcp.handle_message({"id": 2, "method": "tools/list", "params": []})["error"]["code"], -32602)
        self.assertEqual(mcp.handle_message({"id": 3, "method": "absent"})["error"]["code"], -32601)

    def test_mcp_subprocess_real_stdio(self):
        """独立子进程真实 stdio 握手并列出三个工具，无额外日志污染协议。"""
        payload = "\n".join(json.dumps(row) for row in [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
        ]) + "\n"
        result = subprocess.run([sys.executable, str(ROOT / "remoteControl" / "RemoteCmdMcp.py")],
                                input=payload, capture_output=True, text=True, encoding="utf-8",
                                env={**os.environ, "PYTHONUTF8": "1"}, timeout=10,
                                creationflags=0x08000000 if os.name == "nt" else 0)
        self.assertEqual(result.returncode, 0, result.stderr)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(replies), 2)
        self.assertEqual(len(replies[1]["result"]["tools"]), 3)

    def test_portable_registration_and_startup_arguments(self):
        """实际启动器加载附加 patch，且使用当前生产路径，不改用户 profile。"""
        import start_stack
        with patch.object(start_stack, "PROJECT_ROOT", self.root), \
                patch.object(start_stack, "spawn_silent") as spawn:
            start_stack.start_harness_service({})
        command = spawn.call_args.args[0]
        paths = [command[index + 1] for index, value in enumerate(command) if value == "--patch"]
        self.assertEqual(len(paths), 3)
        data = json.loads(Path(paths[-1]).read_text(encoding="utf-8"))
        cfg = data[0]["insert"][0]["config"]
        self.assertEqual(cfg["serverName"], "remote-cmd")
        self.assertEqual(cfg["args"], [str(self.root / "remoteControl" / "RemoteCmdMcp.py")])
        self.assertTrue(cfg["toolCallTimeoutMs"] >= 210000)

    def test_registration_idempotent(self):
        """重复生成相同 patch 不改文件时间，避免不必要的配置重载。"""
        register = RemoteControlRegistration(self.root, sys.executable)
        path = register.build_patch()
        before = path.stat().st_mtime_ns
        self.assertEqual(register.build_patch().stat().st_mtime_ns, before)

    def test_admin_reads_real_ssh_key_without_commands(self):
        """管理界面读取真实本机测试端的公钥，不提交账号或运行命令。"""
        with RemoteSshServer(lambda *args: None) as server:
            result = RemoteControlAdmin(self.root).handle_request(
                {"action": "peekKey", "host": "127.0.0.1", "port": server.port})
            expected = "SHA256:" + base64.b64encode(hashlib.sha256(server.key.asbytes()).digest()).decode().rstrip("=")
            self.assertEqual(result["fingerprint"], expected)
            self.assertIsNone(server.command)

    def test_admin_fixed_probe_and_no_arbitrary_command(self):
        """管理接口只接受固定 CMD 探活，不接收任意远控命令。"""
        def handler(channel, command):
            """channel/command 为测试请求；只回传固定探活标志。"""
            channel.sendall(b"SynLoveRemoteCmdReady\r\n")
            channel.send_exit_status(0)
        admin = RemoteControlAdmin(self.root)
        with RemoteSshServer(handler) as server:
            self.configure_target(server)
            result = admin.handle_request({"action": "probe", "target": "testPc", "command": "ignored"})
            self.assertTrue(result["available"])
            self.assertEqual(server.command, 'cmd.exe /d /s /c "echo SynLoveRemoteCmdReady"')
        with self.assertRaises(ValueError):
            admin.handle_request({"action": "run", "command": "anything"})

    def test_shared_service_key_reference_and_environment_priority(self):
        """共享服务只按显式引用读取本机密钥，现有环境变量优先。"""
        with patch.object(Path, "exists", return_value=True), patch.object(
                Path, "read_text", return_value='{"backendService":{"apiKey":"fake-key"}}') as read:
            self.assertEqual(ServiceCredential.resolve_key({"apiKeyRef": "backendService"}, {}), "fake-key")
            read.reset_mock()
            self.assertEqual(ServiceCredential.resolve_key({"apiKeyRef": "backendService",
                "apiKeyEnv": "TEST_SERVICE_KEY"}, {"TEST_SERVICE_KEY": "env-key"}), "env-key")
            read.assert_not_called()
            self.assertEqual(ServiceCredential.resolve_key({}, {}), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
