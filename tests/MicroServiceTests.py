"""微服务隔离回归。使用临时目录、随机端口和假业务验证协议，不调用模型、不发送平台消息。"""

import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from microServices.ArtifactStore import ArtifactStore
from microServices.OperationStore import OperationStore
from microServices.ServiceHost import ServiceHost
from microServices.ServiceLease import ServiceLease
from microServices.ServiceManager import ServiceManager
from microServices.ServiceMcpBridge import ServiceMcpBridge
from microServices.ServiceTransport import ServiceTransport
from services.ServiceRegistry import ServiceRegistry


class MicroServiceTests(unittest.TestCase):
    """验证网络与状态归属，真实工具测试只使用隔离提醒库。"""

    def setUp(self):
        """无参数；创建临时配置和独立HTTP服务器，不运行后台调度。"""
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / "serviceConfig.json"
        self.config.write_text(json.dumps({"version": 1, "services": {"reminders": {
            "baseURL": "http://127.0.0.1:1/v1", "management": "external",
            "timeoutSeconds": 5, "background": False, "apiKeyEnv": "SYNLOVE_TEST_KEY",
            "dataDir": str(self.root / "state")}}}), encoding="utf-8")
        self.env = patch.dict(os.environ, {"SYNLOVE_TEST_KEY": "isolated-test-key",
                                         "SYNLOVE_REMINDERS_DB": str(self.root / "reminders.sqlite")})
        self.env.start()
        self.registry = ServiceRegistry(self.config)
        self.host = ServiceHost("reminders", self.registry)
        self.thread = threading.Thread(target=self.host.serve, args=("127.0.0.1", 0), daemon=True)
        self.thread.start()
        for _ in range(100):
            if self.host.server:
                break
            time.sleep(0.01)
        port = self.host.server.server_address[1]
        self.cfg = {**self.registry.get_service("reminders"), "baseURL": f"http://127.0.0.1:{port}/v1"}
        self.client = ServiceTransport(self.cfg)

    def tearDown(self):
        """无参数；等待服务与业务进程退出，关闭锁后清理临时目录。"""
        self.host.server.shutdown()
        self.thread.join(20)
        self.assertFalse(self.thread.is_alive())
        self.env.stop()
        self.temp.cleanup()

    def test_health_identity(self):
        """无参数；健康检查验证服务名和协议版本。"""
        data = json.loads(self.client.request("GET", "/health"))
        self.assertEqual(data["service"], "reminders")
        self.assertEqual(data["protocol"], 1)

    def test_authentication(self):
        """无参数；错误密钥不能查询服务或操作数据库。"""
        with patch.dict(os.environ, {"SYNLOVE_TEST_KEY": "wrong"}):
            with self.assertRaisesRegex(RuntimeError, "401"):
                self.client.request("GET", "/health")

    def test_actual_reminder_crud_and_mcp(self):
        """无参数；真实MCP桥经HTTP创建未来提醒、查询、删除，数据只在临时服务库。"""
        config = json.loads(self.config.read_text())
        config["services"]["reminders"]["baseURL"] = self.cfg["baseURL"]
        self.config.write_text(json.dumps(config))
        bridge = ServiceMcpBridge("reminders", ROOT)
        bridge.manager = ServiceManager(ROOT, ServiceRegistry(self.config))
        def call(name, args):
            return bridge.handle({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                                  "params": {"name": name, "arguments": args}})
        result = call("remind_add", {"text": "隔离测试，不推送", "at": "2099-01-01 12:00"})
        self.assertNotIn("isError", result["result"])
        self.assertIn("隔离测试", call("remind_list", {})["result"]["content"][0]["text"])
        self.assertIn("已删除", call("remind_delete", {"id": 1})["result"]["content"][0]["text"])
        self.assertTrue((self.root / "reminders.sqlite").exists())

    def test_duplicate_requests(self):
        """无参数；重复提交相同ID不会重复创建提醒。"""
        message = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                   "params": {"name": "remind_add", "arguments": {
                       "text": "dedup", "at": "2099-01-01 12:00"}}}
        first = self.client.call(message, "same-request")
        second = self.client.call(message, "same-request")
        self.assertEqual(first, second)
        result = self.client.call({"id": 2, "method": "tools/call",
                                   "params": {"name": "remind_list", "arguments": {}}})
        self.assertEqual(result["result"]["content"][0]["text"].count("dedup"), 1)

    def test_reused_id_with_different_body(self):
        """无参数；同ID不同内容在空闲或忙碌时都不能复用结果。"""
        message = {"id": 1, "method": "tools/list"}
        self.client.call(message, "collision")
        with self.assertRaisesRegex(RuntimeError, "400"):
            self.client.call({"id": 2, "method": "tools/list"}, "collision")

    def test_file_roundtrip_and_traversal(self):
        """无参数；跨机文件内容往返一致，非法ID无法读取其他路径。"""
        path = self.root / "input.mp4"
        path.write_bytes(b"isolated-media")
        key = self.client.upload(path)
        self.assertEqual(self.client.download(key), b"isolated-media")
        with self.assertRaises(ValueError):
            self.host.files.resolve("../secrets.json")

    def test_busy_and_duplicate_inflight(self):
        """无参数；执行槽被占用时新任务返回429，同ID任务只返回原状态。"""
        self.host.store.begin("inflight", {"id": 1, "method": "tools/list"})
        self.host.slot.acquire()
        try:
            prior = self.host.submit({"requestId": "inflight", "message": {"id": 1, "method": "tools/list"}})
            self.assertEqual(prior["state"], "running")
            with self.assertRaises(BlockingIOError):
                self.host.submit({"requestId": "another", "message": {"id": 1, "method": "tools/list"}})
        finally:
            self.host.slot.release()

    def test_unknown_after_restart(self):
        """无参数；崩溃前未确认任务重启后标未知，不重新执行写操作。"""
        path = self.root / "operations.sqlite"
        store = OperationStore(path)
        store.begin("interrupted", {"method": "tools/call"})
        self.assertEqual(OperationStore(path).get("interrupted")["state"], "unknown")

    def test_lease_rejects_second_instance(self):
        """无参数；同一数据目录第二个服务进程不能取得状态所有权。"""
        lease = ServiceLease(self.host.state / "service.lock")
        with self.assertRaises(RuntimeError):
            lease.acquire()

    def test_external_never_starts_local(self):
        """无参数；外部端点失效时绝不拉起本机替代服务。"""
        with patch("subprocess.Popen") as spawn:
            with self.assertRaises(RuntimeError):
                ServiceManager(ROOT, self.registry).ensure_service("reminders")
            spawn.assert_not_called()

    def test_managed_remote_is_invalid(self):
        """无参数；配置不能把远程服务标为本机托管。"""
        config = json.loads(self.config.read_text())
        config["services"]["reminders"].update(baseURL="http://192.0.2.1:8791/v1", management="managed")
        self.config.write_text(json.dumps(config))
        with self.assertRaises(ValueError):
            ServiceRegistry(self.config).get_service("reminders")

    def test_malformed_protocol(self):
        """无参数；HTTP接口拒绝任意方法和缺失ID，不能运行隐藏管理方法。"""
        with self.assertRaisesRegex(RuntimeError, "400"):
            self.client.request("POST", "/rpc", json.dumps({
                "requestId": "unsafe", "message": {"method": "service/tick"}}).encode())

    def test_snapshot_reads_service_database(self):
        """无参数；只读API从真实业务Worker创建的隔离提醒库取数，而非GUI本机副本。"""
        result = self.client.call({"id": 1, "method": "tools/call", "params": {
            "name": "remind_add", "arguments": {"text": "snapshot-test", "at": "2099-01-01 12:00"}}})
        self.assertFalse(result["result"].get("isError", False))
        state = json.loads(self.client.request("GET", "/snapshot"))
        self.assertEqual(state["service"], "reminders")
        self.assertEqual(state["total"], 1)
        self.assertEqual(state["rows"][0]["text"], "snapshot-test")

    def test_invalid_reminder_fields_do_not_mutate_database(self):
        """无参数；布尔ID、空文本和多种时间字段不能导致误删或创建无效提醒。"""
        result = self.client.call({"id": 1, "method": "tools/call", "params": {
            "name": "remind_add", "arguments": {"text": "protected", "at": "2099-01-01 12:00"}}})
        self.assertFalse(result["result"].get("isError", False))
        for name, args in (("remind_delete", {"id": True}),
                           ("remind_add", {"text": None, "inSeconds": 60}),
                           ("remind_add", {"text": "bad", "at": "2099-01-01 12:00", "dailyAt": "12:00"})):
            response = self.client.call({"id": 2, "method": "tools/call", "params": {
                "name": name, "arguments": args}})
            self.assertTrue(response["result"].get("isError", False))
        state = json.loads(self.client.request("GET", "/snapshot"))
        self.assertEqual(state["total"], 1)
        self.assertEqual(state["rows"][0]["text"], "protected")


if __name__ == "__main__":
    unittest.main(verbosity=2)
