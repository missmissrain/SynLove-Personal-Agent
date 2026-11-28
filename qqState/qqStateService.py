"""QQ 状态微服务：独立维护 QQ outbox 与网关租约，通过统一 MCP/HTTP RPC 提供读写。

参数：SYNLOVE_QQ_STATE_DB 指向本服务唯一 SQLite 文件；服务不连接 QQ、不发送消息，
只负责幂等队列、分段发送进度和单消费者租约，支持本地或远程部署。
"""

import json
import os
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.environ.get("SYNLOVE_QQ_STATE_DB", str(ROOT / "runtime" / "qq-state.db"))).resolve()

TOOLS = [
    {"name": "qq_enqueue", "description": "幂等加入 QQ 出站队列。",
     "inputSchema": {"type": "object", "required": ["reply"], "properties": {"reply": {"type": "object"}}}},
    {"name": "qq_list_pending", "description": "读取待发送 QQ 消息。",
     "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}}}},
    {"name": "qq_mark_part_sent", "description": "记录 QQ 消息已发送分段。",
     "inputSchema": {"type": "object", "required": ["id", "index"], "properties": {"id": {"type": "string"}, "index": {"type": "integer"}}}},
    {"name": "qq_mark_sent", "description": "标记 QQ 消息已发送并删除队列记录。",
     "inputSchema": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}}},
    {"name": "qq_mark_failed", "description": "记录 QQ 消息失败、重试时间和终态。",
     "inputSchema": {"type": "object", "required": ["id", "error", "nextAt", "terminal"],
                     "properties": {"id": {"type": "string"}, "error": {"type": "string"},
                                    "nextAt": {"type": "integer"}, "terminal": {"type": "boolean"}}}},
    {"name": "qq_get", "description": "读取一条 QQ 出站记录。",
     "inputSchema": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}}},
    {"name": "qq_acquire_lease", "description": "原子获取 QQ 网关唯一消费者租约。",
     "inputSchema": {"type": "object", "required": ["ownerId", "pid", "startedAt", "staleMs", "accountId"],
                     "properties": {"ownerId": {"type": "string"}, "pid": {"type": "integer"},
                                    "startedAt": {"type": "integer"}, "staleMs": {"type": "integer"},
                                    "accountId": {"type": "string"}}}},
    {"name": "qq_get_lease", "description": "读取 QQ 网关租约。",
     "inputSchema": {"type": "object"}},
    {"name": "qq_heartbeat_lease", "description": "续租 QQ 网关租约。",
     "inputSchema": {"type": "object", "required": ["ownerId"], "properties": {"ownerId": {"type": "string"}}}},
    {"name": "qq_release_lease", "description": "释放 QQ 网关租约。",
     "inputSchema": {"type": "object", "required": ["ownerId"], "properties": {"ownerId": {"type": "string"}}}},
    {"name": "qq_snapshot", "description": "读取 QQ 状态快照。",
     "inputSchema": {"type": "object"}},
]


def _connect():
    """无参数；创建当前 QQ 状态库连接并启用行字典。"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=5000")
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS qq_outbox (
          id TEXT PRIMARY KEY,
          target_json TEXT NOT NULL,
          text TEXT NOT NULL,
          msg_id TEXT,
          attempt INTEGER NOT NULL DEFAULT 0,
          next_at INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK(status IN ('pending','failed_terminal')),
          sent_parts_json TEXT NOT NULL DEFAULT '[]',
          error TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS qq_outbox_dedupe
          ON qq_outbox(msg_id, target_json, text)
          WHERE msg_id IS NOT NULL AND status <> 'failed_terminal';
        CREATE TABLE IF NOT EXISTS qq_lease (
          id INTEGER PRIMARY KEY CHECK(id=1),
          owner_id TEXT NOT NULL,
          pid INTEGER NOT NULL,
          started_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          account_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS qq_task_receipts (
          key TEXT PRIMARY KEY, item_id TEXT UNIQUE NOT NULL
        );
        """
    )
    db.commit()
    return db


def _row(row):
    """row 为 SQLite 行；转换为稳定的 QQ 状态对象。"""
    if row is None:
        return None
    item = dict(row)
    item["target"] = json.loads(item.pop("target_json"))
    item["sent_parts"] = json.loads(item.pop("sent_parts_json") or "[]")
    return item


def _call(name, args):
    """name 为工具名，args 为工具参数；在单次事务中执行一个 QQ 状态操作。"""
    with _connect() as db:
        if name == "qq_enqueue":
            reply = args.get("reply") or {}
            text = str(reply.get("text", "")).strip()
            target = reply.get("target")
            if not text or not isinstance(target, dict):
                raise ValueError("reply 必须包含非空 text 和 object target")
            target_json = json.dumps(target, ensure_ascii=False, sort_keys=True)
            msg_id = reply.get("msgId")
            task_key = reply.get("dedupeKey")
            if task_key:
                db.execute("BEGIN IMMEDIATE")
                prior = db.execute("SELECT item_id FROM qq_task_receipts WHERE key=?",
                                   (str(task_key),)).fetchone()
                if prior:
                    return {"outbox": {"id": prior["item_id"]}}
            if msg_id is not None:
                old = db.execute(
                    "SELECT * FROM qq_outbox WHERE msg_id=? AND target_json=? AND text=? AND status <> 'failed_terminal'",
                    (str(msg_id), target_json, text),
                ).fetchone()
                if old:
                    return {"outbox": _row(old)}
            import uuid
            item_id = str(uuid.uuid4())
            now = int(time.time() * 1000)
            db.execute(
                "INSERT INTO qq_outbox(id,target_json,text,msg_id,created_at,status) VALUES(?,?,?,?,?,'pending')",
                (item_id, target_json, text, None if msg_id is None else str(msg_id), now),
            )
            if task_key:
                db.execute("INSERT INTO qq_task_receipts VALUES(?,?)", (str(task_key), item_id))
            db.commit()
            return {"outbox": _row(db.execute("SELECT * FROM qq_outbox WHERE id=?", (item_id,)).fetchone())}
        if name == "qq_list_pending":
            limit = max(1, min(1024, int(args.get("limit", 1024))))
            rows = db.execute(
                "SELECT * FROM qq_outbox WHERE status <> 'failed_terminal' ORDER BY created_at LIMIT ?",
                (limit,),
            ).fetchall()
            return {"outbox": [_row(row) for row in rows]}
        if name == "qq_get":
            return {"outbox": _row(db.execute("SELECT * FROM qq_outbox WHERE id=?", (str(args["id"]),)).fetchone())}
        if name == "qq_mark_part_sent":
            item_id, index = str(args["id"]), int(args["index"])
            row = db.execute("SELECT sent_parts_json FROM qq_outbox WHERE id=?", (item_id,)).fetchone()
            if row is None:
                return {"updated": False}
            parts = json.loads(row["sent_parts_json"] or "[]")
            if index not in parts:
                parts.append(index)
            db.execute("UPDATE qq_outbox SET sent_parts_json=? WHERE id=?",
                       (json.dumps(sorted(set(parts))), item_id))
            db.commit()
            return {"updated": True}
        if name == "qq_mark_sent":
            cursor = db.execute("DELETE FROM qq_outbox WHERE id=?", (str(args["id"]),))
            db.commit()
            return {"updated": cursor.rowcount == 1}
        if name == "qq_mark_failed":
            status = "failed_terminal" if bool(args.get("terminal")) else "pending"
            cursor = db.execute(
                "UPDATE qq_outbox SET attempt=attempt+1,error=?,next_at=?,status=? WHERE id=?",
                (str(args.get("error", ""))[:160], int(args.get("nextAt", 0)), status, str(args["id"])),
            )
            db.commit()
            return {"updated": cursor.rowcount == 1}
        if name == "qq_get_lease":
            return {"lease": dict(db.execute("SELECT * FROM qq_lease WHERE id=1").fetchone() or {}) or None}
        if name == "qq_acquire_lease":
            now = int(time.time() * 1000)
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM qq_lease WHERE id=1").fetchone()
            if row and now - int(row["heartbeat_at"]) <= max(1, int(args["staleMs"])):
                db.rollback()
                return {"acquired": False}
            db.execute(
                "INSERT INTO qq_lease(id,owner_id,pid,started_at,heartbeat_at,account_id) VALUES(1,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,pid=excluded.pid,"
                "started_at=excluded.started_at,heartbeat_at=excluded.heartbeat_at,account_id=excluded.account_id",
                (str(args["ownerId"]), int(args["pid"]), int(args["startedAt"]), now, str(args["accountId"])),
            )
            db.commit()
            return {"acquired": True}
        if name == "qq_heartbeat_lease":
            cursor = db.execute("UPDATE qq_lease SET heartbeat_at=? WHERE id=1 AND owner_id=?",
                                (int(time.time() * 1000), str(args["ownerId"])))
            db.commit()
            return {"updated": cursor.rowcount == 1}
        if name == "qq_release_lease":
            cursor = db.execute("DELETE FROM qq_lease WHERE id=1 AND owner_id=?", (str(args["ownerId"]),))
            db.commit()
            return {"updated": cursor.rowcount == 1}
        if name == "qq_snapshot":
            counts = db.execute("SELECT status,COUNT(*) AS n FROM qq_outbox GROUP BY status").fetchall()
            return {"outbox": {str(row["status"]): int(row["n"]) for row in counts},
                    "lease": dict(db.execute("SELECT * FROM qq_lease WHERE id=1").fetchone() or {}) or None}
    raise ValueError("未知 QQ 状态工具")


def handle(message):
    """message 为 MCP JSON-RPC 消息；返回协议响应，不连接 QQ。"""
    method = message.get("method")
    key = message.get("id")
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": key, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = message.get("params") or {}
        try:
            return {"jsonrpc": "2.0", "id": key,
                    "result": {"structuredContent": _call(str(params.get("name")), params.get("arguments") or {})}}
        except Exception as error:
            return {"jsonrpc": "2.0", "id": key, "result": {"isError": True, "content": [{"type": "text", "text": str(error)}]}}
    return {"jsonrpc": "2.0", "id": key, "result": {}}
