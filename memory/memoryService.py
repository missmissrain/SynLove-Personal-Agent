"""长期记忆微服务。参数为时间线目录、图谱目录和 stdin JSON-RPC；默认使用服务环境变量。

该模块只负责时间线与知识图谱的受限文件访问，不调用模型、不发送消息，也不决定摘要策略。
正式部署时由 microServices.ServiceHost 独占启动；调用方通过 HTTP/MCP 访问，避免多个进程
分别维护同一份长期记忆。
"""

import json
import os
import re
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TIMELINE_DIR = Path(os.environ.get("SYNLOVE_MEMORY_TIMELINE_DIR", str(ROOT / "runtime" / "timeline"))).resolve()
GRAPH_DIR = Path(os.environ.get("SYNLOVE_MEMORY_GRAPH_DIR", str(ROOT / "runtime" / "graph"))).resolve()
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_TEXT = 200_000
MAX_LIMIT = 100
lock = threading.RLock()

TOOLS = [
    {
        "name": "memory_append",
        "description": "幂等追加一条用户或助手对话到指定日期的时间线。",
        "inputSchema": {"type": "object", "required": ["entry"],
                        "properties": {"entry": {"type": "object"}}},
    },
    {
        "name": "memory_days",
        "description": "列出时间线日期和记录数量。",
        "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}}},
    },
    {
        "name": "memory_read",
        "description": "读取某一天的摘要和对话记录。",
        "inputSchema": {"type": "object", "required": ["date"],
                        "properties": {"date": {"type": "string"}, "includeEntries": {"type": "boolean"}}},
    },
    {
        "name": "memory_search",
        "description": "在时间线中搜索关键词。",
        "inputSchema": {"type": "object", "required": ["keyword"],
                        "properties": {"keyword": {"type": "string"}, "limit": {"type": "integer"}}},
    },
    {
        "name": "memory_update_entry",
        "description": "按日期和稳定 ID 更新一条时间线记录的字段。",
        "inputSchema": {"type": "object", "required": ["date", "entryId", "patch"],
                        "properties": {"date": {"type": "string"}, "entryId": {"type": "string"},
                                       "patch": {"type": "object"}}},
    },
    {
        "name": "memory_update_summary",
        "description": "原子更新指定日期的摘要。",
        "inputSchema": {"type": "object", "required": ["date", "summary"],
                        "properties": {"date": {"type": "string"}, "summary": {"type": "string"},
                                       "meta": {"type": "object"}}},
    },
    {
        "name": "memory_update_attachment",
        "description": "更新一条记录中指定附件的描述。",
        "inputSchema": {"type": "object", "required": ["date", "entryId", "attachmentId", "description"],
                        "properties": {"date": {"type": "string"}, "entryId": {"type": "string"},
                                       "attachmentId": {"type": "string"}, "description": {"type": "string"}}},
    },
    {
        "name": "graph_snapshot",
        "description": "读取知识图谱节点和关系边快照。",
        "inputSchema": {"type": "object"},
    },
    {
        "name": "graph_ensure_center",
        "description": "确保欣爱和主人两个中心节点及互相称呼存在。",
        "inputSchema": {"type": "object"},
    },
    {
        "name": "graph_upsert_person",
        "description": "幂等新增或更新人物节点。",
        "inputSchema": {"type": "object", "required": ["person"],
                        "properties": {"person": {"type": "object"}}},
    },
    {
        "name": "graph_upsert_edge",
        "description": "幂等新增或更新人物关系边。",
        "inputSchema": {"type": "object", "required": ["edge"],
                        "properties": {"edge": {"type": "object"}}},
    },
    {
        "name": "graph_watermark",
        "description": "读取或提交图谱增量更新复合水位。",
        "inputSchema": {"type": "object", "properties": {"update": {"type": "object"}}},
    },
]


def _jsonl(path):
    """path 为受信任的服务文件路径；读取合法 JSONL，忽略损坏行以保证查询可用。"""
    if not path.exists():
        return []
    result = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                result.append(value)
    except OSError:
        return []
    return result


def _date(value):
    """value 为日期字符串；校验后返回规范日期，否则抛出协议错误。"""
    text = str(value or "").strip()
    if not DATE_RE.fullmatch(text):
        raise ValueError("date 必须是 YYYY-MM-DD")
    return text


def _entry(value):
    """value 为待写入记录；校验稳定 id、角色和正文，返回可持久化副本。"""
    if not isinstance(value, dict):
        raise ValueError("entry 必须是对象")
    item = dict(value)
    if not isinstance(item.get("id"), str) or not item["id"].strip():
        raise ValueError("entry.id 不能为空")
    if item.get("role") not in ("user", "assistant"):
        raise ValueError("entry.role 必须是 user 或 assistant")
    if not isinstance(item.get("text"), str) or len(item["text"]) > MAX_TEXT:
        raise ValueError("entry.text 无效或过长")
    if not isinstance(item.get("ts"), (int, float)):
        item["ts"] = int(time.time() * 1000)
    return item


def append_entry(entry):
    """entry 为一条已校验记录；按日期幂等追加并返回是否实际写入。"""
    item = _entry(entry)
    date = _date(item.get("date") or time.strftime("%Y-%m-%d", time.localtime(item["ts"] / 1000)))
    item["date"] = date
    target = TIMELINE_DIR / "days" / f"{date}.jsonl"
    with lock:
        target.parent.mkdir(parents=True, exist_ok=True)
        current = _jsonl(target)
        if any(row.get("id") == item["id"] for row in current):
            return False
        with target.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
        return True


def read_day(date, include_entries=True):
    """date 为日期；读取摘要和当天记录，不允许通过路径穿越。"""
    day = _date(date)
    path = TIMELINE_DIR / "days" / f"{day}.jsonl"
    entries = _jsonl(path) if include_entries else []
    summary_path = TIMELINE_DIR / "days" / f"{day}.summary.md"
    try:
        summary = summary_path.read_text(encoding="utf-8") if summary_path.exists() else ""
    except OSError:
        summary = ""
    return {"date": day, "summary": summary, "entries": entries}


def days(limit=14):
    """limit 为最大日期数量；返回按日期倒序的轻量索引。"""
    amount = max(1, min(int(limit or 14), MAX_LIMIT))
    result = []
    folder = TIMELINE_DIR / "days"
    if not folder.exists():
        return result
    for path in sorted(folder.glob("*.jsonl"), reverse=True)[:amount]:
        if DATE_RE.fullmatch(path.stem):
            rows = _jsonl(path)
            result.append({"date": path.stem, "entries": len(rows),
                           "lastTs": max((row.get("ts", 0) for row in rows), default=0)})
    return result


def search(keyword, limit=20):
    """keyword 为非空关键词；返回最新命中的日期、角色和短正文。"""
    text = str(keyword or "").strip().lower()
    if not text:
        raise ValueError("keyword 不能为空")
    amount = max(1, min(int(limit or 20), MAX_LIMIT))
    hits = []
    for day in days(MAX_LIMIT):
        for row in read_day(day["date"])["entries"]:
            if text in str(row.get("text", "")).lower():
                hits.append({"date": day["date"], "entry": row})
    return list(reversed(hits[-amount:]))


def _rewrite_day(date, rows):
    """date 为合法日期，rows 为该日完整记录；原子替换权威 JSONL 文件。"""
    target = TIMELINE_DIR / "days" / f"{_date(date)}.jsonl"
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(
        "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )
    temporary.replace(target)


def update_entry(date, entry_id, patch):
    """按日期和稳定 ID更新标量字段，拒绝修改 id、日期、角色和时间。"""
    day = _date(date)
    if not isinstance(entry_id, str) or not entry_id.strip() or not isinstance(patch, dict):
        raise ValueError("entryId 或 patch 无效")
    forbidden = {"id", "date", "role", "ts"}
    if forbidden.intersection(patch):
        raise ValueError("不能修改记录的身份字段")
    with lock:
        rows = _jsonl(TIMELINE_DIR / "days" / f"{day}.jsonl")
        for index, row in enumerate(rows):
            if row.get("id") == entry_id:
                rows[index] = {**row, **patch}
                _rewrite_day(day, rows)
                return True
    return False


def update_attachment(date, entry_id, attachment_id, description):
    """更新指定附件描述；找不到记录或附件时返回 false，不创建幽灵记录。"""
    if not isinstance(description, str) or len(description) > MAX_TEXT:
        raise ValueError("description 无效或过长")
    day = _date(date)
    with lock:
        rows = _jsonl(TIMELINE_DIR / "days" / f"{day}.jsonl")
        for row in rows:
            if row.get("id") != entry_id:
                continue
            attachments = row.get("attachments")
            if not isinstance(attachments, list):
                return False
            for attachment in attachments:
                if isinstance(attachment, dict) and attachment.get("id") == attachment_id:
                    attachment["description"] = description
                    _rewrite_day(day, rows)
                    return True
            return False
    return False


def update_summary(date, summary, meta=None):
    """原子写入指定日期摘要及摘要元数据；摘要不写入对话 JSONL。"""
    day = _date(date)
    if not isinstance(summary, str) or len(summary) > MAX_TEXT:
        raise ValueError("summary 无效或过长")
    folder = TIMELINE_DIR / "days"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{day}.summary.md"
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(summary, encoding="utf-8")
    temporary.replace(target)
    if isinstance(meta, dict):
        meta_path = folder / f"{day}.summary.json"
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return True


def snapshot():
    """无参数；读取图谱节点和关系边，供远程查询使用。"""
    with lock:
        return {"nodes": _jsonl(GRAPH_DIR / "nodes.jsonl"),
                "edges": _jsonl(GRAPH_DIR / "edges.jsonl")}


def _write_jsonl(path, rows):
    """path 为服务目录内的 JSONL 文件；原子替换完整内容。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
                                  for row in rows), encoding="utf-8")
    temporary.replace(path)


def ensure_center():
    """无参数；建立图谱中心节点和互相称呼，操作幂等。"""
    with lock:
        nodes = _jsonl(GRAPH_DIR / "nodes.jsonl")
        edges = _jsonl(GRAPH_DIR / "edges.jsonl")
        by_name = {str(row.get("name")): row for row in nodes}
        now = int(time.time() * 1000)
        for name in ("欣爱", "主人"):
            if name not in by_name:
                row = {"id": f"memory-{len(nodes) + 1}", "name": name, "updated_at": now}
                nodes.append(row)
                by_name[name] = row
        _write_jsonl(GRAPH_DIR / "nodes.jsonl", nodes)
        pairs = (("欣爱", "主人", "主人"), ("主人", "欣爱", "欣爱"))
        for source, target, label in pairs:
            left, right = by_name[source]["id"], by_name[target]["id"]
            if not any(edge.get("from") == left and edge.get("to") == right and edge.get("kind") == "address"
                       for edge in edges):
                edges.append({"from": left, "to": right, "label": label, "kind": "address", "updated_at": now})
        _write_jsonl(GRAPH_DIR / "edges.jsonl", edges)
    return True


def upsert_person(person):
    """person 为人物字段；按 id 或姓名匹配并合并显式字段。"""
    if not isinstance(person, dict) or not str(person.get("name", "")).strip():
        raise ValueError("person.name 不能为空")
    with lock:
        nodes = _jsonl(GRAPH_DIR / "nodes.jsonl")
        found = next((row for row in nodes if person.get("id") and row.get("id") == person["id"]
                      or not person.get("id") and row.get("name") == person["name"]), None)
        now = int(time.time() * 1000)
        if found is None:
            found = {"id": f"memory-{int(time.time() * 1000000)}", "name": str(person["name"]).strip()}
            nodes.append(found)
        for key, value in person.items():
            if key not in ("id",) and value is not None:
                found[key] = value
        found["updated_at"] = now
        _write_jsonl(GRAPH_DIR / "nodes.jsonl", nodes)
        return found


def upsert_edge(edge):
    """edge 为关系字段；按双方节点和标签幂等写入，缺节点时返回空。"""
    if not isinstance(edge, dict):
        raise ValueError("edge 必须是对象")
    with lock:
        nodes = _jsonl(GRAPH_DIR / "nodes.jsonl")
        source = next((row for row in nodes if row.get("id") == edge.get("from")
                       or row.get("name") == edge.get("from")), None)
        target = next((row for row in nodes if row.get("id") == edge.get("to")
                       or row.get("name") == edge.get("to")), None)
        if source is None or target is None or source.get("id") == target.get("id"):
            return None
        current = _jsonl(GRAPH_DIR / "edges.jsonl")
        item = dict(edge)
        item["from"], item["to"] = source["id"], target["id"]
        if not str(item.get("label", "")).strip():
            return None
        match = next((row for row in current if row.get("from") == item["from"]
                      and row.get("to") == item["to"] and row.get("label") == item["label"]), None)
        if match is None:
            item["updated_at"] = int(time.time() * 1000)
            current.append(item)
            _write_jsonl(GRAPH_DIR / "edges.jsonl", current)
            return item
        return match


def graph_watermark(update=None):
    """update 为可选的 ts/ids；返回持久化的复合水位。"""
    path = GRAPH_DIR / "watermark.json"
    with lock:
        current = {}
        if path.exists():
            try:
                current = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                current = {}
        if isinstance(update, dict):
            current = {"ts": int(update.get("ts", 0)), "ids": list(update.get("ids", []))}
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(current, ensure_ascii=False), encoding="utf-8")
        return current


def handle(message):
    """message 为单条 JSON-RPC 请求；返回协议响应，不执行任意模块或命令。"""
    request_id = message.get("id")
    method = message.get("method")
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": request_id, "result": {
            "protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
            "serverInfo": {"name": "synlove-memory", "version": "1.0.0"}}}
    if method in ("ping", "notifications/initialized"):
        return None if method.startswith("notifications/") else {"jsonrpc": "2.0", "id": request_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}}
    if method != "tools/call":
        return {"jsonrpc": "2.0", "id": request_id,
                "error": {"code": -32601, "message": f"unsupported method: {method}"}}
    params = message.get("params") or {}
    name = params.get("name")
    args = params.get("arguments") or {}
    try:
        if name == "memory_append":
            result = {"written": append_entry(args.get("entry"))}
        elif name == "memory_days":
            result = {"days": days(args.get("limit", 14))}
        elif name == "memory_read":
            result = read_day(args.get("date"), args.get("includeEntries", True))
        elif name == "memory_search":
            result = {"hits": search(args.get("keyword"), args.get("limit", 20))}
        elif name == "memory_update_entry":
            result = {"updated": update_entry(args.get("date"), args.get("entryId"), args.get("patch"))}
        elif name == "memory_update_summary":
            result = {"updated": update_summary(args.get("date"), args.get("summary"), args.get("meta"))}
        elif name == "memory_update_attachment":
            result = {"updated": update_attachment(args.get("date"), args.get("entryId"),
                                                    args.get("attachmentId"), args.get("description"))}
        elif name == "graph_snapshot":
            result = snapshot()
        elif name == "graph_ensure_center":
            result = {"updated": ensure_center()}
        elif name == "graph_upsert_person":
            result = {"person": upsert_person(args.get("person"))}
        elif name == "graph_upsert_edge":
            result = {"edge": upsert_edge(args.get("edge"))}
        elif name == "graph_watermark":
            result = graph_watermark(args.get("update"))
        else:
            raise ValueError(f"未知工具：{name}")
        return {"jsonrpc": "2.0", "id": request_id, "result": {"structuredContent": result}}
    except Exception as error:
        return {"jsonrpc": "2.0", "id": request_id,
                "result": {"isError": True, "content": [{"type": "text", "text": str(error)}]}}


def main():
    """无参数；读取 stdin 的 JSON-RPC 请求并逐条输出响应。"""
    for raw in sys.stdin:
        if not raw.strip():
            continue
        try:
            response = handle(json.loads(raw))
            if response is not None:
                print(json.dumps(response, ensure_ascii=False), flush=True)
        except json.JSONDecodeError:
            continue


if __name__ == "__main__":
    main()
