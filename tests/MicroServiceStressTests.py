"""业务微服务压力与故障回归。随机端口、临时目录、假任务；禁止模型计费与平台推送。"""

import concurrent.futures
import importlib.util
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from unittest.mock import patch
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from microServices.CrawlerAdapter import CrawlerAdapter
from microServices.McpAdapter import McpAdapter
from microServices.ReportBundle import ReportBundle
from microServices.ArtifactStore import ArtifactStore
from microServices.ScheduleStore import ScheduleStore
from microServices.OperationStore import OperationStore
from microServices.LegacyServiceMigration import LegacyServiceMigration
from microServices.ServiceHost import ServiceHost
from microServices.ServiceManager import ServiceManager
from microServices.ServiceLease import ServiceLease
from microServices.ServiceTransport import ServiceTransport
from services.ServiceRegistry import ServiceRegistry


class MicroServiceStressTests(unittest.TestCase):
    """测量重复投递、并发拒绝、输出上界、服务隔离与实际Worker工具发现。"""

    def setUp(self):
        """无参数；所有测试状态都落在临时目录。"""
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.hosts = []

    def tearDown(self):
        """无参数；回收所有测试HTTP服务、业务Worker和临时状态。"""
        for host, thread in self.hosts:
            host.server.shutdown()
            thread.join(20)
            self.assertFalse(thread.is_alive())
        self.temp.cleanup()

    def start_host(self, name):
        """name为待测服务；使用真实生产服务代码，禁用后台调度和真实外部调用。"""
        config = self.root / (name + ".json")
        config.write_text(json.dumps({"version": 1, "services": {name: {
            "baseURL": "http://127.0.0.1:1/v1", "management": "external",
            "background": False, "timeoutSeconds": 15, "apiKeyEnv": "SYNLOVE_TEST_KEY",
            "dataDir": str(self.root / name),
            "databasePath": str(self.root / (name + ".sqlite"))}}}), encoding="utf-8")
        registry = ServiceRegistry(config)
        host = ServiceHost(name, registry)
        thread = threading.Thread(target=host.serve, args=("127.0.0.1", 0), daemon=True)
        thread.start()
        deadline = time.monotonic() + 5
        while host.server is None and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertIsNotNone(host.server)
        self.hosts.append((host, thread))
        cfg = {**registry.get_service(name),
               "baseURL": "http://127.0.0.1:" + str(host.server.server_address[1]) + "/v1"}
        return host, ServiceTransport(cfg)

    def test_all_actual_worker_tool_discovery(self):
        """无参数；六类真实Worker均可列出工具，无任何工具执行或模型调用。"""
        counts = {"reminders": 3, "digest": 2, "video": 1, "history": 2, "coding": 2, "crawler": 1}
        for name, count in counts.items():
            with self.subTest(name=name):
                result = McpAdapter(ROOT, name, 15, {
                    "SYNLOVE_SERVICE_DATA_DIR": str(self.root / name)}).call({
                        "jsonrpc": "2.0", "id": 1, "method": "tools/list"})
                self.assertEqual(len(result["result"]["tools"]), count)

    def test_parallel_same_request_runs_once(self):
        """无参数；60次并发提交同一写请求，业务只执行一次，服务之后仍能响应。"""
        host, client = self.start_host("crawler")
        calls = []
        def fake_call(adapter, message):
            """adapter/message为假任务参数；记录执行次数并制造可控延迟。"""
            calls.append(message)
            time.sleep(0.3)
            return {"jsonrpc": "2.0", "id": 1, "result": {"content": []}}
        body = json.dumps({"requestId": "same-write", "message": {
            "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
                "name": "crawler_fetch", "arguments": {"url": "https://example.com"}}}}).encode()
        with patch.object(McpAdapter, "call", fake_call):
            with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
                results = list(pool.map(lambda _: json.loads(client.request("POST", "/rpc", body)), range(60)))
            deadline = time.monotonic() + 3
            while host.slot.locked() and time.monotonic() < deadline:
                time.sleep(0.01)
        self.assertEqual(len(calls), 1)
        self.assertTrue(all(row["id"] == "same-write" for row in results))
        self.assertTrue(json.loads(client.request("GET", "/health"))["ok"])

    def test_busy_rejects_new_request_without_losing_health(self):
        """无参数；执行槽繁忙时40个不同请求均被拒绝，健康查询仍可用。"""
        host, client = self.start_host("crawler")
        host.slot.acquire()
        def submit(index):
            """index为唯一任务编号；返回HTTP错误而非执行假任务。"""
            try:
                client.request("POST", "/rpc", json.dumps({
                    "requestId": "busy-" + str(index), "message": {"method": "tools/list"}}).encode())
                return False
            except RuntimeError as error:
                return "429" in str(error)
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
                self.assertTrue(all(pool.map(submit, range(40))))
            self.assertTrue(json.loads(client.request("GET", "/health"))["ok"])
            listing = client.call({"jsonrpc": "2.0", "id": 99, "method": "tools/list"})
            self.assertEqual(listing["result"]["tools"][0]["name"], "crawler_fetch")
        finally:
            host.slot.release()

    def test_actual_digest_schedule_over_api(self):
        """无参数；经真实HTTP→Worker设置/查询/停用日程，不能生成Windows计划任务。"""
        host, client = self.start_host("digest")
        def schedule(action):
            """action为仅修改独立服务SQLite的调度操作。"""
            return client.call({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                "params": {"name": "digest_schedule",
                                           "arguments": {"action": action, "time": "09:15"}}})
        first = schedule("set")
        self.assertFalse(first["result"].get("isError", False))
        state = json.loads(schedule("get")["result"]["content"][0]["text"])
        self.assertEqual(state["time"], "09:15")
        self.assertTrue(state["enabled"])
        self.assertFalse(json.loads(schedule("disable")["result"]["content"][0]["text"])["enabled"])
        self.assertTrue((host.state / "schedule.sqlite").is_file())

    def test_schedule_submission_failure_does_not_consume_day(self):
        """无参数；调度入队前失败可再次领取，相同日期确认后不再领取。"""
        store = ScheduleStore(self.root, self.root / "schedule.sqlite")
        with store.connect() as conn:
            conn.execute("UPDATE schedule SET enabled=1,hhmm='00:00'")
        key = store.claim_due()
        self.assertIsNotNone(key)
        self.assertEqual(store.claim_due(), key)
        store.confirm_enqueued(key)
        self.assertIsNone(store.claim_due())

    def test_crawler_rejects_private_and_browser(self):
        """无参数；公开域名解析到私网也拒绝，浏览器不能绕过网络边界。"""
        crawler = CrawlerAdapter(ROOT)
        with patch("socket.getaddrinfo", return_value=[
                (2, 1, 6, "", ("127.0.0.1", 443))]):
            with self.assertRaises(ValueError):
                crawler.validate_url("https://example.com")
        with self.assertRaisesRegex(ValueError, "浏览器"):
            crawler.handle({"id": 1, "method": "tools/call", "params": {
                "name": "crawler_fetch", "arguments": {"url": "https://example.com", "mode": "browser"}}})

    def test_partial_upload_has_no_orphan(self):
        """无参数；上传中断不留下看似成功的文件。"""
        store = ArtifactStore(self.root / "files")
        with self.assertRaises(ValueError):
            store.receive(io.BytesIO(b"short"), 100, ".mp4")
        self.assertEqual(list(store.root.iterdir()), [])

    def test_report_bundle_keeps_images_portable(self):
        """无参数；报表和图打包后只含相对路径，越界文件不能混入结果。"""
        reports = self.root / "runtime" / "reports"
        reports.mkdir(parents=True)
        image = self.root / "runtime" / "frame.png"
        image.write_bytes(b"fake-image")
        report = reports / "test.md"
        report.write_text("![frame](" + image.as_posix() + ")", encoding="utf-8")
        files = ArtifactStore(self.root / "files")
        key = ReportBundle(self.root / "runtime").publish(report, files)
        with zipfile.ZipFile(files.resolve(key)) as archive:
            self.assertEqual(archive.read("images/1.png"), b"fake-image")
            self.assertIn(b"images/1.png", archive.read("report.md"))
        secret = self.root / "secret.txt"
        secret.write_text("private")
        report.write_text("![bad](" + secret.as_posix() + ")", encoding="utf-8")
        with self.assertRaises(ValueError):
            ReportBundle(self.root / "runtime").publish(report, files)

    def test_worker_timeout_kills_process(self):
        """无参数；超时Worker确实退出，随后可创建新的独立Worker。"""
        folder = self.root / "microServices"
        folder.mkdir()
        shutil.copyfile(ROOT / "tests" / "fixtures" / "SlowWorker.py", folder / "McpWorker.py")
        adapter = McpAdapter(self.root, "fake", 0.2)
        with self.assertRaises(TimeoutError):
            adapter.call({"id": 1})
        self.assertIsNotNone(adapter.child.poll())

    def test_worker_output_is_bounded(self):
        """无参数；超过8MiB输出被主动中止，不把无限输出累积在内存。"""
        folder = self.root / "microServices"
        folder.mkdir()
        shutil.copyfile(ROOT / "tests" / "fixtures" / "FloodWorker.py", folder / "McpWorker.py")
        adapter = McpAdapter(self.root, "fake", 10)
        with self.assertRaisesRegex(RuntimeError, "8MiB"):
            adapter.call({"id": 1})
        self.assertIsNotNone(adapter.child.poll())

    def test_invalid_payload_is_400(self):
        """无参数；数组请求和错误参数类型返回400，不能使HTTP线程崩溃。"""
        host, client = self.start_host("crawler")
        for data in ([], {"requestId": "bad", "message": {"method": "tools/call", "params": []}}):
            with self.assertRaisesRegex(RuntimeError, "400"):
                client.request("POST", "/rpc", json.dumps(data).encode())
        self.assertTrue(json.loads(client.request("GET", "/health"))["ok"])

    def test_slow_connections_are_bounded_and_recover(self):
        """无参数；32个慢请求占满容量后第33个收到503，关闭后恢复健康查询。"""
        host, client = self.start_host("crawler")
        address = host.server.server_address
        peers = []
        try:
            for _ in range(32):
                peer = socket.create_connection(address, timeout=3)
                peer.sendall(b"GET /health HTTP/1.1\r\n")
                peers.append(peer)
            deadline = time.monotonic() + 5
            while host.server.slots._value and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(host.server.slots._value, 0)
            with socket.create_connection(address, timeout=3) as extra:
                self.assertIn(b"503", extra.recv(4096))
        finally:
            for peer in peers:
                peer.close()
        deadline = time.monotonic() + 5
        while host.server.slots._value != 32 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(host.server.slots._value, 32)
        self.assertTrue(json.loads(client.request("GET", "/health"))["ok"])

    def test_failed_reminder_is_not_marked_done(self):
        """无参数；假推送失败后一次性提醒仍pending，绝不向真实QQ发送消息。"""
        spec = importlib.util.spec_from_file_location("isolatedReminder", ROOT / "reminders" / "reminderService.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        config = self.root / "newsDigest" / "config"
        config.mkdir(parents=True)
        (config / "newsDigest.json").write_text(json.dumps({"push": {"userOpenid": "fake-user"}}))
        module.ROOT, module.DB = self.root, self.root / "reminders.sqlite"
        key, _ = module.add("isolated-failure", in_seconds=600)
        with module.connect() as conn:
            conn.execute("UPDATE reminders SET next_at='2000-01-01 00:00:00' WHERE id=?", (key,))
        fake = types.SimpleNamespace(qqPush=lambda *args: types.SimpleNamespace(
            push=lambda text: {"ok": False, "detail": "isolated offline"}))
        with patch.dict(sys.modules, {"newsDigest.push.qqPush": fake}):
            self.assertEqual(module.fire_due(), 0)
        self.assertEqual(module.pending()[0][0], key)

    def test_video_failure_returns_mcp_error(self):
        """无参数；视频执行失败必须携带isError，不能伪装成成功文本。"""
        spec = importlib.util.spec_from_file_location("isolatedVideo", ROOT / "videoDigest" / "mcp" / "videoMcp.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        fake = types.SimpleNamespace(returncode=1, stdout="isolated pipeline failure", stderr="")
        with patch.object(module.subprocess, "run", return_value=fake):
            result = module.handle({"id": 1, "method": "tools/call", "params": {
                "name": "video_digest", "arguments": {"pathOrUrl": "https://example.com/video"}}})
        self.assertTrue(result["result"]["isError"])

    def test_expired_result_keeps_idempotency_tombstone(self):
        """无参数；正文过期后仍保留写操作ID，不会重新执行历史任务。"""
        store = OperationStore(self.root / "operations.sqlite")
        message = {"method": "tools/call"}
        store.begin("old", message)
        store.finish("old", {"result": {"content": []}})
        store.expire_results(time.time() + 1)
        self.assertEqual(store.get("old")["state"], "expired")
        self.assertEqual(store.begin("old", message)["state"], "expired")

    def test_real_video_pipeline_with_fake_models(self):
        """无参数；真实ffmpeg视频上传→假ASR/VLM→报表ZIP下载，无付费或生产数据访问。"""
        if importlib.util.find_spec("PIL") is None:
            self.skipTest("当前解释器没有Pillow；请使用已安装Pillow的现有视频处理环境单独运行本项")
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            self.skipTest("未安装ffmpeg/ffprobe，不能声称视频流水线验证通过")
        sys.path.insert(0, str(ROOT / "tests"))
        from FakeModelHandler import FakeModelHandler
        FakeModelHandler.calls = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), FakeModelHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            host, client = self.start_host("video")
            config = Path(host.config_path)
            settings = json.loads(config.read_text())
            base = "http://127.0.0.1:" + str(server.server_port) + "/v1"
            for name in ("llm", "asr"):
                settings["services"][name] = {"baseURL": base, "management": "external",
                                               "model": "isolated-fake", "timeoutSeconds": 10}
            settings["services"]["video"].update(workDir=str(self.root / "videoWork"), timeoutSeconds=60)
            config.write_text(json.dumps(settings))
            host.cfg.update(workDir=str(self.root / "videoWork"), timeoutSeconds=60)
            client.cfg["timeoutSeconds"] = 60
            video = self.root / "sample.mp4"
            created = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                "-i", "color=c=blue:s=160x120:d=1", "-f", "lavfi", "-i",
                "sine=frequency=440:duration=1", "-shortest", "-c:v", "mpeg4",
                "-c:a", "aac", str(video)], capture_output=True, timeout=20)
            self.assertEqual(created.returncode, 0, created.stderr.decode(errors="replace"))
            file_id = client.upload(video)
            result = client.call({"jsonrpc": "2.0", "id": 9, "method": "tools/call",
                "params": {"name": "video_digest", "arguments": {
                    "pathOrUrl": "artifact:" + file_id, "frames": 2}}})
            self.assertFalse(result["result"].get("isError", False), result)
            artifacts = result["result"]["artifacts"]
            content = client.download(artifacts[0]["id"])
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                self.assertIn("report.md", archive.namelist())
                self.assertTrue(any(name.startswith("images/") for name in archive.namelist()))
                self.assertIn("隔离视频测试", archive.read("report.md").decode())
            self.assertIn("/v1/audio/transcriptions", FakeModelHandler.calls)
            self.assertIn("/v1/chat/completions", FakeModelHandler.calls)
        finally:
            server.shutdown()
            thread.join(5)
            server.server_close()

    def test_real_digest_dry_run_with_fake_models(self):
        """无参数；真实RSS采集→去重库→假模型摘要，dry_run不能访问QQ接口。"""
        sys.path.insert(0, str(ROOT / "tests"))
        from FakeModelHandler import FakeModelHandler
        FakeModelHandler.calls = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), FakeModelHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            host, client = self.start_host("digest")
            config = Path(host.config_path)
            settings = json.loads(config.read_text())
            base = "http://127.0.0.1:" + str(server.server_port)
            settings["services"]["llm"] = {"baseURL": base + "/v1", "management": "external",
                                           "model": "isolated-fake", "timeoutSeconds": 10}
            settings["services"]["rsshub"] = {"baseURL": base, "management": "external",
                                              "timeoutSeconds": 10}
            business = self.root / "news.json"
            business.write_text(json.dumps({"enabled": True, "interest": "隔离测试",
                "hot": {"enabled": False}, "sources": [
                    {"type": "rsshub", "name": "fake", "path": "/fake-feed", "limit": 2}],
                "push": {"channel": "qq", "userOpenid": "fake-never-send"}}))
            extra = {"businessConfigPath": str(business), "databasePath": str(self.root / "news.sqlite")}
            settings["services"]["digest"].update(extra)
            host.cfg.update(extra)
            config.write_text(json.dumps(settings))
            result = client.call({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "digest_run", "arguments": {"dry_run": True}}})
            self.assertFalse(result["result"].get("isError", False), result)
            self.assertIn("--dry-run", result["result"]["content"][0]["text"])
            self.assertTrue((self.root / "news.sqlite").is_file())
            self.assertEqual(FakeModelHandler.calls, ["/fake-feed", "/v1/chat/completions"])
        finally:
            server.shutdown()
            thread.join(5)
            server.server_close()

    def test_managed_service_process_start_and_stop(self):
        """无参数；启动真实独立爬虫服务进程，身份探活后经API停止并验证独占锁释放。"""
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        config = self.root / "managed.json"
        data = self.root / "managedState"
        config.write_text(json.dumps({"version": 1, "services": {"crawler": {
            "baseURL": f"http://127.0.0.1:{port}/v1", "management": "managed",
            "timeoutSeconds": 10, "dataDir": str(data), "apiKeyEnv": ""}}}))
        manager = ServiceManager(ROOT, ServiceRegistry(config))
        try:
            manager.ensure_service("crawler")
            self.assertTrue(manager.is_ready("crawler"))
            self.assertTrue((data / "service.pid").is_file())
        finally:
            if manager.is_ready("crawler"):
                self.assertTrue(manager.stop_service("crawler"))
        self.assertFalse(manager.is_ready("crawler"))
        deadline = time.monotonic() + 5
        while True:
            try:
                lease = ServiceLease(data / "service.lock").acquire()
                lease.close()
                break
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)

    def test_worker_failure_is_unknown_and_never_replayed(self):
        """无参数；业务进程超时可能已产生副作用，记录unknown，同ID不能重做。"""
        host, client = self.start_host("crawler")
        message = {"id": 1, "method": "tools/call", "params": {
            "name": "crawler_fetch", "arguments": {"url": "https://example.com"}}}
        with patch.object(McpAdapter, "call", side_effect=TimeoutError("isolated timeout")) as run:
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError, "结果未知"):
                    client.call(message, "uncertain")
            self.assertEqual(run.call_count, 1)
        self.assertEqual(host.store.get("uncertain")["state"], "unknown")

    def test_cross_origin_cannot_shutdown_local_service(self):
        """无参数；恶意网页的跨站简单POST不能关闭无鉴权回环服务。"""
        host, client = self.start_host("crawler")
        headers = {"Origin": "https://attacker.example"}
        if host.key:
            headers["Authorization"] = "Bearer " + host.key
        request = urllib.request.Request(client.cfg["baseURL"] + "/shutdown", data=b"",
                                         headers=headers, method="POST")
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request, timeout=3)
        self.assertEqual(error.exception.code, 403)
        self.assertTrue(json.loads(client.request("GET", "/health"))["ok"])

    def test_same_database_cannot_have_two_service_owners(self):
        """无参数；即便换状态目录，同一提醒数据库仍只有一个服务进程能拥有写入权。"""
        config = self.root / "database-owner.json"
        settings = {"version": 1, "services": {"reminders": {
            "baseURL": "http://127.0.0.1:1/v1", "management": "external",
            "background": False, "dataDir": str(self.root / "first"),
            "databasePath": str(self.root / "same.sqlite")}}}
        config.write_text(json.dumps(settings))
        first = ServiceHost("reminders", ServiceRegistry(config))
        try:
            settings["services"]["reminders"]["dataDir"] = str(self.root / "second")
            config.write_text(json.dumps(settings))
            with self.assertRaises(RuntimeError):
                ServiceHost("reminders", ServiceRegistry(config))
        finally:
            first.close()

    @unittest.skipUnless(os.name == "nt", "旧schtasks编码迁移仅适用于Windows")
    def test_legacy_xml_codepage_is_decoded_without_corruption(self):
        """无参数；模拟声明UTF-16实际GBK的任务XML，中文路径和任务归属都能保留。"""
        xml = ('<?xml version="1.0" encoding="UTF-16"?>'
               '<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">'
               '<RegistrationInfo><Description>中文新闻任务</Description></RegistrationInfo>'
               '<Triggers><CalendarTrigger><StartBoundary>2026-10-01T09:15:00</StartBoundary>'
               '</CalendarTrigger></Triggers><Settings><Enabled>false</Enabled></Settings>'
               '<Actions><Exec><Command>' + str(self.root / "newsDigest" / "runDigestTask.cmd")
               + '</Command></Exec></Actions></Task>')
        fake = types.SimpleNamespace(returncode=0, stdout=xml.encode("gbk"))
        with patch("subprocess.run", return_value=fake):
            result = LegacyServiceMigration(self.root).news_task()
        self.assertEqual(result["time"], "09:15")
        self.assertFalse(result["enabled"])
        self.assertIn("中文新闻任务", result["xml"])

    def test_deleted_schedule_requires_time_before_enable(self):
        """无参数；删除日程后不能假启用无时间计划，字符串false也不能被当成True。"""
        store = ScheduleStore(self.root, self.root / "schedule.sqlite")
        store.configure({"action": "delete"}, None)
        with self.assertRaisesRegex(ValueError, "time"):
            store.configure({"action": "enable"}, None)
        with self.assertRaisesRegex(ValueError, "布尔"):
            store.configure({"action": "enable", "time": "09:00", "enabled": "false"}, None)


if __name__ == "__main__":
    unittest.main(verbosity=2)
