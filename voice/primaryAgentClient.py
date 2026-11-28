"""主人格语音适配：把语音正文提交现有 Harness 会话，保留工具、记忆和模型路由。

注册参数 base_url 默认回环 8813；timeout 默认180秒；该接口由主人格进程持有。
"""
import json
import urllib.request
import time


class PrimaryAgentClient:
    """调用本机主人格语音桥，不创建第二个人格模型会话。"""

    def __init__(self, base_url="http://127.0.0.1:8813", timeout=180):
        """base_url 为本机主人格桥；timeout 为整轮等待秒数，默认180。"""
        self.url = base_url.rstrip("/")
        self.timeout = timeout

    def ask_agent(self, text, session_id):
        """text 为识别正文；session_id 为追踪标识，实际会话由主人格桥选择。"""
        body = json.dumps({"text": text, "sessionId": session_id}, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.url + "/v1/voice/reply", data=body,
                                     headers={"Content-Type": "application/json"})
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with client.open(req, timeout=self.timeout) as res:
            result = json.loads(res.read(1024 * 1024))
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise RuntimeError("主人格语音回复失败")
        return result["reply"]

    def ask_agent_stream(self, text, session_id, on_ack=None, on_event=None):
        """text为识别正文；优先读取主人格的首个确认事件，再等待最终任务回复。"""
        body = json.dumps({
            "text": text,
            "sessionId": session_id,
            "stream": True,
            "returnAck": True,
        }, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            self.url + "/v1/voice/reply",
            data=body,
            headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
        )
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        started = time.monotonic()
        with client.open(req, timeout=self.timeout) as res:
            content_type = str(res.headers.get("Content-Type") or "")
            if "event-stream" not in content_type and "ndjson" not in content_type:
                result = json.loads(res.read(1024 * 1024))
                if not isinstance(result, dict) or result.get("ok") is not True:
                    raise RuntimeError("主人格语音回复失败")
                ack = result.get("ack") or result.get("ackText") or result.get("accepted")
                if ack and on_ack:
                    event = ack if isinstance(ack, dict) else {
                        "type": "ack",
                        "text": str(ack),
                        "reply": str(ack),
                    }
                    on_ack(event, round(time.monotonic() - started, 4))
                return result["reply"]
            final = None
            for raw in res:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line or line.startswith(":"):
                    continue
                if line.startswith("data:"):
                    line = line[5:].strip()
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if on_event:
                    on_event(event)
                if event.get("type") in ("ack", "accepted", "reply_ack") and on_ack:
                    on_ack(event, round(time.monotonic() - started, 4))
                if event.get("type") in ("final", "completed", "reply") or event.get("done"):
                    final = event.get("reply") or event.get("text") or event.get("result")
            if isinstance(final, dict):
                return final
            if final:
                return final
            raise RuntimeError("主人格流式回复没有最终文本")
