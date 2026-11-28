"""隔离视频测试的假ASR与LLM。无注册参数；仅接受本机测试请求，返回固定结果，不加载模型。"""

import json
from http.server import BaseHTTPRequestHandler


class FakeModelHandler(BaseHTTPRequestHandler):
    """统一模拟兼容服务的转写与对话接口，并记录被调用路径。"""

    calls = []

    def log_message(self, *args):
        """args为默认日志参数；不打印上传字节。"""
        pass

    def do_POST(self):
        """无参数；消费上传内容，返回固定转写或固定模型回答。"""
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.calls.append(self.path)
        if self.path == "/v1/audio/transcriptions":
            result = {"text": "这是隔离视频测试。", "language": "zh",
                      "segments": [{"start": 0, "end": 1, "text": "这是隔离视频测试。"}]}
        elif self.path == "/v1/chat/completions":
            result = {"choices": [{"message": {"content": "t=0.0: 蓝色测试画面"}}]}
        else:
            self.send_error(404)
            return
        data = json.dumps(result, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        """无参数；返回固定RSS，供新闻服务在隔离环境完成采集与去重。"""
        self.calls.append(self.path)
        if self.path != "/fake-feed":
            self.send_error(404)
            return
        data = ("<rss><channel><item><title>隔离测试新闻</title>"
                "<link>https://example.com/isolated-news</link>"
                "<pubDate>2026-10-31</pubDate></item></channel></rss>").encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/rss+xml; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
