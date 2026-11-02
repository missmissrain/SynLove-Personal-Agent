"""远程业务超时契约回归。使用内存Hub桩，检查普通请求和附件请求保持配置的长任务时限。"""
import json
import unittest
import urllib.error
from unittest.mock import MagicMock, patch
from microServices.RelayBusinessClient import RelayBusinessClient


class RelayBusinessTimeoutTests(unittest.TestCase):
    """不访问网络、不消耗token；验证服务端收到的时限，而非仅检查本地等待参数。"""

    def test_long_requests_keep_deadline(self):
        """无参数；900秒网页任务和3600秒附件任务不能被静默截成120秒。"""
        for seconds, body, kind in ((900, None, "application/json"),
                                    (3600, b"synthetic", "application/octet-stream")):
            calls = []
            client = RelayBusinessClient({"baseURL": "https://unused.invalid",
                                          "relayCapability": "video", "timeoutSeconds": seconds})

            def request_hub(method, path, data=None, content_type=None, **kwargs):
                """记录发给Hub的真实字节，立即返回完成任务，避免睡眠和真实服务依赖。"""
                calls.append((data, content_type))
                return json.dumps({"id": "fake", "status": "done",
                                   "payload": {"status": 200, "body": {"ok": True}}}).encode()

            client.request_hub = request_hub
            client.request("POST", "/tools", body, kind)
            data, content_type = calls[0]
            if kind == "application/json":
                self.assertEqual(json.loads(data)["timeoutMs"], seconds * 1000)
            else:
                self.assertIn(b'name="timeoutMs"\r\n\r\n3600000\r\n', data)
                self.assertIn(b"synthetic", data)

    def test_only_read_requests_reconnect(self):
        """无参数；网络中断仅重连GET，POST写入不重发，鉴权失败不重试。"""
        cfg = {"baseURL": "http://127.0.0.1:1", "timeoutSeconds": 30}
        for method, expected in (("GET", 3), ("POST", 1)):
            opener = MagicMock()
            opener.handlers = []
            opener.open.side_effect = urllib.error.URLError("synthetic disconnect")
            with patch("urllib.request.build_opener", return_value=opener), patch(
                    "microServices.RelayBusinessClient.time.sleep"):
                with self.assertRaises(urllib.error.URLError):
                    RelayBusinessClient(cfg).request_hub(method, "/tasks/test")
            self.assertEqual(opener.open.call_count, expected)
        opener = MagicMock()
        opener.handlers = []
        opener.open.side_effect = urllib.error.HTTPError("http://test", 401, "denied", {}, None)
        with patch("urllib.request.build_opener", return_value=opener):
            with self.assertRaises(urllib.error.HTTPError):
                RelayBusinessClient(cfg).request_hub("GET", "/tasks/test")
        self.assertEqual(opener.open.call_count, 1)


if __name__ == "__main__":
    unittest.main()
