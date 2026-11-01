"""欣爱的"自己的对话/记忆"查询服务（MCP stdio）。

职责：
- 直接读 harness 的会话库（`~/.dsh/sessions/**/session.v3.jsonl.zstd`），
  把"聊天记录"还原成「谁、什么时候、在哪条通道、说了什么」；
- 对外暴露两个工具，避免她去用 pwsh + sqlite3 翻数据库（那里面只有投递队列，不是聊天记录）：
    · `memory_recent` —— 最近 N 条对话（可限定通道/天数）
    · `memory_search` —— 按关键词检索历史对话，返回上下文片段
- 只读，不写任何文件；不启动浏览器、不联网。

启动参数（环境变量，均可选）：
    DSH_HOME      默认 %USERPROFILE%\\.dsh
    MEMORY_DAYS   默认只回看最近 14 天（避免每次解压上百万字节）
"""

import io
import json
import os
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

try:
    import zstandard as zstd
except ImportError:  # 理论上不会发生；真缺了就让工具明确报错而不是静默无结果
    zstd = None

DSH_HOME = Path(os.environ.get("DSH_HOME") or Path(__file__).resolve().parents[2] / "runtime/dsh")
SESSIONS = DSH_HOME / "sessions"
DEFAULT_DAYS = float(os.environ.get("MEMORY_DAYS", "14"))
# 这些是 harness 每轮自动注入的"上下文提示"，不是用户说的话，检索时要过滤掉
INJECTED_PREFIXES = (
    "Time sampled while preparing turn",
    "Browser time zone for this request",
    "[Context]",
)

TOOLS = [
    {
        "name": "memory_recent",
        "description": "查看自己最近的对话记录（跨微信/QQ 通道，按时间倒序）。用于回答'我刚才说了什么''你记不记得我刚才问的'这类问题。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "返回多少条，默认 20，最多 100"},
                "days": {"type": "number", "description": "回看最近几天，默认 14"},
                "channel": {"type": "string", "description": "限定通道：main / weixin / qq，不填=全部"},
            },
        },
    },
    {
        "name": "memory_search",
        "description": "在自己的历史对话里按关键词检索，返回命中的原话与上下文。用于'上次说的那个事''我之前是不是提过 X'这类回忆。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "关键词（不区分大小写，多个词用空格分隔）"},
                "days": {"type": "number", "description": "回看最近几天，默认 14"},
                "limit": {"type": "integer", "description": "最多返回多少条命中，默认 10"},
            },
            "required": ["query"],
        },
    },
]


def log(message):
    """调试信息写 stderr（stdout 是 MCP 协议通道）。"""
    sys.stderr.write(f"[self-memory] {message}\n")
    sys.stderr.flush()


def channel_of(session_dir):
    """从会话目录名判断通道：main / weixin / qq / 其它。"""
    name = session_dir.name
    if name == "main":
        return "main"
    if name.startswith("weixin"):
        return "weixin"
    if name.startswith("qq"):
        return "qq"
    return "other"


def read_session(path):
    """解压并解析一个会话文件，返回 [{time, channel, role, text}]（只保留有内容的文本消息）。"""
    if zstd is None:
        raise RuntimeError("缺少 zstandard 库：请执行 pip install zstandard")
    try:
        with open(path, "rb") as handle:
            data = zstd.ZstdDecompressor().stream_reader(handle).read()
    except (OSError, RuntimeError) as error:
        log(f"读取失败 {path.name}: {error}")
        return []
    records = []
    for line in data.decode("utf-8", "replace").split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = item.get("type")
        payload = item.get("data") or {}
        when = item.get("time")
        if kind == "user/message":
            text = "".join(part.get("text", "") for part in payload.get("content", []) if part.get("type") == "text").strip()
            if not text or text.startswith(INJECTED_PREFIXES):
                continue
            records.append({"time": when, "role": "user", "text": text})
        elif kind == "assistant/message":
            message = payload.get("message") or {}
            text = "".join(part.get("text", "") for part in message.get("content", []) if part.get("type") == "text").strip()
            if not text:
                continue
            records.append({"time": when, "role": "assistant", "text": text})
    return records


def collect(days):
    """收集最近 days 天内所有会话的消息，按时间升序返回。"""
    cutoff = (time.time() - days * 86400) * 1000
    if not SESSIONS.exists():
        return []
    messages = []
    for path in SESSIONS.rglob("session.v3.jsonl.zstd"):
        try:
            if path.stat().st_mtime * 1000 < cutoff:
                continue
        except OSError:
            continue
        channel = channel_of(path.parent)
        for record in read_session(path):
            if record["time"] is None or record["time"] < cutoff:
                continue
            record["channel"] = channel
            record["session"] = path.parent.name[:40]
            messages.append(record)
    messages.sort(key=lambda item: item["time"])
    return messages


def format_time(millis):
    """毫秒时间戳 → 本地时间字符串（不带年份，聊天场景够用）。"""
    return time.strftime("%m-%d %H:%M", time.localtime(millis / 1000))


def tool_recent(arguments):
    """memory_recent：返回最近 N 条对话。"""
    limit = max(1, min(int(arguments.get("limit", 20)), 100))
    days = float(arguments.get("days", DEFAULT_DAYS))
    channel = str(arguments.get("channel", "")).strip().lower()
    messages = collect(days)
    if channel:
        messages = [item for item in messages if item["channel"] == channel]
    if not messages:
        return f"最近 {days:g} 天没有找到对话记录。"
    tail = messages[-limit:]
    lines = [f"最近 {len(tail)} 条（共 {len(messages)} 条，回看 {days:g} 天）："]
    for item in tail:
        who = "对方" if item["role"] == "user" else "我"
        lines.append(f"[{format_time(item['time'])}][{item['channel']}] {who}: {item['text'][:200]}")
    return "\n".join(lines)


def tool_search(arguments):
    """memory_search：按关键词检索历史对话。"""
    query = str(arguments.get("query", "")).strip()
    if not query:
        raise ValueError("query 不能为空")
    terms = [term.lower() for term in query.split() if term.strip()]
    limit = max(1, min(int(arguments.get("limit", 10)), 50))
    days = float(arguments.get("days", DEFAULT_DAYS))
    hits = []
    for item in collect(days):
        lowered = item["text"].lower()
        if not all(term in lowered for term in terms):
            continue
        position = lowered.find(terms[0])
        start = max(0, position - 60)
        snippet = item["text"][start:start + 220].replace("\n", " ")
        hits.append((item, snippet))
    if not hits:
        return f"最近 {days:g} 天里没有找到包含「{query}」的对话。"
    hits = hits[-limit:]
    lines = [f"找到 {len(hits)} 条包含「{query}」的记录（最近 {days:g} 天）："]
    for item, snippet in hits:
        who = "对方" if item["role"] == "user" else "我"
        lines.append(f"[{format_time(item['time'])}][{item['channel']}] {who}: {snippet}")
    return "\n".join(lines)


def handle(message):
    """按 JSON-RPC 方法分发。"""
    method = message.get("method")
    request_id = message.get("id")
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": request_id, "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "self-memory", "version": "1.0.0"},
        }}
    if method in ("notifications/initialized", "notifications/cancelled"):
        return None
    if method == "ping":
        return {"jsonrpc": "2.0", "id": request_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = message.get("params") or {}
        name = params.get("name")
        arguments = params.get("arguments") or {}
        try:
            if name == "memory_recent":
                text = tool_recent(arguments)
            elif name == "memory_search":
                text = tool_search(arguments)
            else:
                raise ValueError(f"未知工具：{name}")
            return {"jsonrpc": "2.0", "id": request_id, "result": {"content": [{"type": "text", "text": text}]}}
        except Exception as error:  # noqa: BLE001
            return {"jsonrpc": "2.0", "id": request_id, "result": {
                "content": [{"type": "text", "text": f"查询失败：{type(error).__name__}: {error}"}],
                "isError": True,
            }}
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"unsupported method: {method}"}}


def main():
    """stdio 主循环。"""
    log(f"started, sessions={SESSIONS}, days={DEFAULT_DAYS:g}")
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        response = handle(message)
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
