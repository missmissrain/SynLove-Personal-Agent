"""Observation 微服务：独立保存脱敏模型、工具和调用链观测记录。

参数：SYNLOVE_OBSERVATION_DB 指向 SQLite 文件；只接受已经由调用方裁剪后的元数据，
不保存提示词、聊天正文、工具参数、密钥或任意文件路径。
"""

import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.environ.get("SYNLOVE_OBSERVATION_DB", str(ROOT / "runtime" / "observation.db"))).resolve()

TOOLS = [
    {"name": "observation_append", "description": "幂等追加一条已脱敏观测记录。",
     "inputSchema": {"type": "object", "required": ["record"], "properties": {"record": {"type": "object"}}}},
    {"name": "observation_recent", "description": "读取最近的观测记录。",
     "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}}}},
    {"name": "observation_snapshot", "description": "读取观测数量和最近时间。",
     "inputSchema": {"type": "object"}},
]


def _connect():
    """无参数；创建观测数据库连接并初始化事件表。"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=5000")
    db.execute(
        "CREATE TABLE IF NOT EXISTS observation (event_id TEXT PRIMARY KEY, at TEXT NOT NULL, record_json TEXT NOT NULL)"
    )
    db.commit()
    return db


def _event_id(record):
    """record 为脱敏观测对象；返回稳定事件指纹。"""
    return hashlib.sha256(json.dumps(record, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def _call(name, args):
    """name 为观测工具名，args 为工具参数；执行有界读写。"""
    with _connect() as db:
        if name == "observation_append":
            record = args.get("record")
            if not isinstance(record, dict):
                raise ValueError("record 必须是对象")
            encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
            if len(encoded.encode("utf-8")) > 16_384:
                raise ValueError("观测记录过大")
            event_id = str(record.get("eventId") or _event_id(record))
            at = str(record.get("at") or "")
            cursor = db.execute(
                "INSERT OR IGNORE INTO observation(event_id,at,record_json) VALUES(?,?,?)",
                (event_id, at, encoded),
            )
            db.commit()
            return {"eventId": event_id, "inserted": cursor.rowcount == 1}
        if name == "observation_recent":
            limit = max(1, min(500, int(args.get("limit", 50))))
            rows = db.execute(
                "SELECT record_json FROM observation ORDER BY rowid DESC LIMIT ?", (limit,)
            ).fetchall()
            return {"records": [json.loads(row["record_json"]) for row in rows]}
        if name == "observation_snapshot":
            row = db.execute("SELECT COUNT(*) AS n, MAX(at) AS latest FROM observation").fetchone()
            return {"count": int(row["n"]), "latest": row["latest"]}
    raise ValueError("未知观测工具")


def handle(message):
    """message 为 MCP JSON-RPC 消息；返回协议响应，不触碰 Harness session。"""
    method = message.get("method")
    key = message.get("id")
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": key, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = message.get("params") or {}
        try:
            result = _call(str(params.get("name")), params.get("arguments") or {})
            return {"jsonrpc": "2.0", "id": key, "result": {"structuredContent": result}}
        except Exception as error:
            return {"jsonrpc": "2.0", "id": key, "result": {"isError": True, "content": [{"type": "text", "text": str(error)}]}}
    return {"jsonrpc": "2.0", "id": key, "result": {}}
