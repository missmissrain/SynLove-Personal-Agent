"""微信状态微服务。参数为 SQLite 数据库路径；通过 JSON-RPC 提供游标、路由、投递、outbox 和租约操作。

该服务只维护一份微信链路状态库，所有写操作在 SQLite 事务内完成；不启动微信轮询、不发送消息，
也不管理模型。正式切换前不得让它与主进程同时写同一数据库。
"""

import json
import hashlib
import os
import sqlite3
import sys
import time
from pathlib import Path
from threading import RLock

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.environ.get("SYNLOVE_STATE_DB", str(ROOT / "runtime" / "weixin-state.db"))).resolve()
lock = RLock()

TOOLS = [
    {"name": "state_get_cursor", "description": "读取微信轮询游标。", "inputSchema": {"type": "object"}},
    {"name": "state_set_cursor", "description": "提交微信轮询游标。",
     "inputSchema": {"type": "object", "required": ["cursor"], "properties": {"cursor": {"type": "string"}}}},
    {"name": "state_get_session", "description": "读取用户到会话的路由。",
     "inputSchema": {"type": "object", "required": ["userId"], "properties": {"userId": {"type": "string"}}}},
    {"name": "state_set_session", "description": "设置用户到会话的路由。",
     "inputSchema": {"type": "object", "required": ["userId", "sessionId"],
                     "properties": {"userId": {"type": "string"}, "sessionId": {"type": "string"}}}},
    {"name": "state_get_meta", "description": "读取状态元数据。",
     "inputSchema": {"type": "object", "required": ["key"], "properties": {"key": {"type": "string"}}}},
    {"name": "state_set_meta", "description": "写入状态元数据。",
     "inputSchema": {"type": "object", "required": ["key", "value"], "properties": {"key": {"type": "string"}, "value": {"type": "string"}}}},
    {"name": "state_list_meta_prefix", "description": "按前缀列出状态元数据。",
     "inputSchema": {"type": "object", "required": ["prefix"], "properties": {"prefix": {"type": "string"}}}},
    {"name": "state_delete_meta", "description": "删除状态元数据。",
     "inputSchema": {"type": "object", "required": ["key"], "properties": {"key": {"type": "string"}}}},
    {"name": "state_session_id_for", "description": "按用户和上下文代次生成稳定会话 ID。",
     "inputSchema": {"type": "object", "required": ["userId"], "properties": {"userId": {"type": "string"}}}},
    {"name": "state_context_epoch", "description": "读取用户上下文代次。",
     "inputSchema": {"type": "object", "required": ["userId"], "properties": {"userId": {"type": "string"}}}},
    {"name": "state_bump_context_epoch", "description": "递增用户上下文代次。",
     "inputSchema": {"type": "object", "required": ["userId"], "properties": {"userId": {"type": "string"}}}},
    {"name": "state_clear_session", "description": "清除用户会话路由。",
     "inputSchema": {"type": "object", "required": ["userId"], "properties": {"userId": {"type": "string"}}}},
    {"name": "state_list_users", "description": "列出有会话路由的用户。", "inputSchema": {"type": "object"}},
    {"name": "state_clear_queue", "description": "清理未完成出站队列。", "inputSchema": {"type": "object"}},
    {"name": "state_get_delivery", "description": "读取一条入站投递记录。",
     "inputSchema": {"type": "object", "required": ["deliveryId"],
                     "properties": {"deliveryId": {"type": "string"}}}},
    {"name": "state_delivery_context_token", "description": "读取入站投递的上下文令牌。",
     "inputSchema": {"type": "object", "required": ["deliveryId"], "properties": {"deliveryId": {"type": "string"}}}},
    {"name": "state_put_delivery", "description": "幂等登记一条入站投递。",
     "inputSchema": {"type": "object", "required": ["record"], "properties": {"record": {"type": "object"}}}},
    {"name": "state_update_delivery", "description": "按期望状态原子更新投递状态。",
     "inputSchema": {"type": "object", "required": ["deliveryId", "status"],
                     "properties": {"deliveryId": {"type": "string"}, "status": {"type": "string"},
                                    "patch": {"type": "object"}}}},
    {"name": "state_latest_user", "description": "读取最近入站消息的用户。", "inputSchema": {"type": "object"}},
    {"name": "state_list_unfinished_deliveries", "description": "列出需要恢复的入站投递。",
     "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}}}},
    {"name": "state_batch_committable", "description": "判断一批投递是否可以提交游标。",
     "inputSchema": {"type": "object", "required": ["deliveryIds"], "properties": {"deliveryIds": {"type": "array"}}}},
    {"name": "state_enqueue_outbox", "description": "将出站消息原子写入队列。",
     "inputSchema": {"type": "object", "required": ["input"], "properties": {"input": {"type": "object"}}}},
    {"name": "state_next_outbox", "description": "读取指定会话下一条可发送消息。",
     "inputSchema": {"type": "object", "required": ["sessionId"], "properties": {"sessionId": {"type": "string"}, "now": {"type": "integer"}}}},
    {"name": "state_next_outbox_per_session", "description": "读取各会话下一条可发送消息。", "inputSchema": {"type": "object", "properties": {"now": {"type": "integer"}}}},
    {"name": "state_mark_outbox_sending", "description": "标记出站消息为发送中。",
     "inputSchema": {"type": "object", "required": ["outboundId"], "properties": {"outboundId": {"type": "string"}}}},
    {"name": "state_get_outbox", "description": "读取出站消息。", "inputSchema": {"type": "object", "required": ["outboundId"], "properties": {"outboundId": {"type": "string"}}}},
    {"name": "state_list_pending_outbox", "description": "列出需要恢复的出站消息。", "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}}}},
    {"name": "state_mark_outbox_part_sent", "description": "记录出站消息已成功发送的分段。",
     "inputSchema": {"type": "object", "required": ["outboundId", "index"], "properties": {"outboundId": {"type": "string"}, "index": {"type": "integer"}}}},
    {"name": "state_mark_outbox_sent", "description": "标记出站消息已发送。", "inputSchema": {"type": "object", "required": ["outboundId"], "properties": {"outboundId": {"type": "string"}}}},
    {"name": "state_mark_outbox_failed", "description": "标记出站消息失败及重试时间。",
     "inputSchema": {"type": "object", "required": ["outboundId", "status", "error"], "properties": {"outboundId": {"type": "string"}, "status": {"type": "string"}, "error": {"type": "string"}, "nextRetryAt": {"type": "integer"}}}},
    {"name": "state_parked_results", "description": "读取停放的通知结果。", "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}}}},
    {"name": "state_prune_parked_results", "description": "清理过期停放结果。", "inputSchema": {"type": "object", "required": ["maxAgeMs"], "properties": {"maxAgeMs": {"type": "integer"}, "now": {"type": "integer"}}}},
    {"name": "state_trim_pending_notices", "description": "限制每会话待发通知数量。", "inputSchema": {"type": "object", "required": ["sessionId"], "properties": {"sessionId": {"type": "string"}, "keep": {"type": "integer"}}}},
    {"name": "state_bind_turn_context", "description": "绑定会话轮次上下文。", "inputSchema": {"type": "object", "required": ["input"], "properties": {"input": {"type": "object"}}}},
    {"name": "state_get_turn_context", "description": "读取会话轮次上下文。", "inputSchema": {"type": "object", "required": ["sessionId", "turn"], "properties": {"sessionId": {"type": "string"}, "turn": {"type": "integer"}}}},
    {"name": "state_latest_delivery_for_session", "description": "读取会话最近一条已处理入站消息。", "inputSchema": {"type": "object", "required": ["sessionId"], "properties": {"sessionId": {"type": "string"}}}},
    {"name": "state_prune_turn_context", "description": "清理旧会话轮次上下文。", "inputSchema": {"type": "object", "required": ["sessionId"], "properties": {"sessionId": {"type": "string"}, "keep": {"type": "integer"}}}},
    {"name": "state_get_lease", "description": "读取消费者租约。", "inputSchema": {"type": "object"}},
    {"name": "state_try_acquire_lease", "description": "原子获取唯一消费者租约。", "inputSchema": {"type": "object", "required": ["input"], "properties": {"input": {"type": "object"}}}},
    {"name": "state_heartbeat_lease", "description": "续租消费者租约。", "inputSchema": {"type": "object", "required": ["ownerId"], "properties": {"ownerId": {"type": "string"}}}},
    {"name": "state_release_lease", "description": "释放消费者租约。", "inputSchema": {"type": "object", "required": ["ownerId"], "properties": {"ownerId": {"type": "string"}}}},
    {"name": "state_snapshot", "description": "读取状态库只读快照。", "inputSchema": {"type": "object"}},
]


def connect():
    """无参数；打开服务数据库并启用 WAL、外键和完整同步。"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(DB_PATH), timeout=8, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=FULL")
    return connection


def ensure_schema(db):
    """db 为 SQLite 连接；只创建状态服务需要的兼容表，不覆盖已有数据。"""
    db.executescript("""
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS transport_cursor (id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS route (user_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery (
      delivery_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT,
      status TEXT NOT NULL, received_at INTEGER NOT NULL, injected_at INTEGER,
      last_error TEXT, attempt INTEGER NOT NULL DEFAULT 0, context_token TEXT, payload_json TEXT
    );
    CREATE INDEX IF NOT EXISTS delivery_status_idx ON delivery(status, received_at);
    CREATE TABLE IF NOT EXISTS outbox (
      outbound_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
      turn INTEGER, sequence INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
      context_token TEXT, client_id TEXT NOT NULL, status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER, last_error TEXT,
      created_at INTEGER NOT NULL, sent_at INTEGER, sent_parts_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS outbox_queue_idx ON outbox(status, session_id, sequence);
    CREATE TABLE IF NOT EXISTS turn_context (
      session_id TEXT NOT NULL, turn INTEGER NOT NULL, delivery_id TEXT NOT NULL,
      user_id TEXT NOT NULL, context_token TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, turn)
    );
    CREATE TABLE IF NOT EXISTS consumer_lease (
      id INTEGER PRIMARY KEY CHECK(id=1), owner_id TEXT NOT NULL, pid INTEGER NOT NULL,
      process_started_at INTEGER NOT NULL, account_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL
    );
    """)


def row_json(row):
    """row 为 SQLite 行；返回 JSON 可序列化字典。"""
    if row is None:
        return None
    result = dict(row)
    if "payload_json" in result and isinstance(result["payload_json"], str):
        try:
            result["payload"] = json.loads(result["payload_json"])
        except json.JSONDecodeError:
            pass
    return result


def get_cursor(db):
    """db 为状态连接；返回当前游标，初始为空字符串。"""
    row = db.execute("SELECT cursor FROM transport_cursor WHERE id=1").fetchone()
    return row["cursor"] if row else ""


def set_cursor(db, cursor):
    """cursor 为平台游标；在事务中覆盖单例游标。"""
    now = int(time.time() * 1000)
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("INSERT INTO transport_cursor(id,cursor,updated_at) VALUES(1,?,?) "
                   "ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at",
                   (str(cursor), now))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return True


def get_session(db, user_id):
    """user_id 为微信用户标识；返回路由会话或空。"""
    row = db.execute("SELECT session_id FROM route WHERE user_id=?", (user_id,)).fetchone()
    return row["session_id"] if row else None


def get_meta(db, key):
    """key 为状态元数据键；返回值或空。"""
    row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(db, key, value):
    """key/value 为状态元数据；原子覆盖保存。"""
    db.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
               (key, value))
    return True


def list_meta_prefix(db, prefix):
    """prefix 为元数据键前缀；返回排序后的键值对。"""
    rows = db.execute("SELECT key,value FROM meta WHERE key LIKE ? ORDER BY key",
                      (f"{prefix}%",)).fetchall()
    return [{"key": row["key"], "value": row["value"]} for row in rows]


def delete_meta(db, key):
    """key 为状态元数据键；删除并返回是否存在。"""
    cursor = db.execute("DELETE FROM meta WHERE key=?", (key,))
    return cursor.rowcount == 1


def set_session(db, user_id, session_id):
    """user_id/session_id 为路由键值；原子写入并更新时间。"""
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("INSERT INTO route(user_id,session_id,updated_at) VALUES(?,?,?) "
                   "ON CONFLICT(user_id) DO UPDATE SET session_id=excluded.session_id,updated_at=excluded.updated_at",
                   (user_id, session_id, int(time.time() * 1000)))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return True


def context_epoch(db, user_id):
    """user_id 为用户标识；返回上下文代次。"""
    try:
        value = int(get_meta(db, f"context_epoch:{user_id}") or "0")
    except ValueError:
        value = 0
    return max(0, value)


def session_id_for(db, user_id):
    """user_id 为用户标识；生成不会复用旧上下文的会话 ID。"""
    epoch = context_epoch(db, user_id)
    return f"weixin-{user_id}" if epoch <= 0 else f"weixin-{user_id}-c{epoch}"


def bump_context_epoch(db, user_id):
    """user_id 为用户标识；递增并返回新的上下文代次。"""
    value = context_epoch(db, user_id) + 1
    set_meta(db, f"context_epoch:{user_id}", str(value))
    return value


def clear_session(db, user_id):
    """user_id 为用户标识；清除路由但保留历史会话文件。"""
    cursor = db.execute("DELETE FROM route WHERE user_id=?", (user_id,))
    return cursor.rowcount == 1


def list_users(db):
    """无参数；按最近更新时间列出已路由用户。"""
    rows = db.execute("SELECT user_id FROM route ORDER BY updated_at DESC").fetchall()
    return [row["user_id"] for row in rows]


def clear_queue(db):
    """无参数；清除所有未完成出站消息，保留历史终态记录。"""
    cursor = db.execute(
        "DELETE FROM outbox WHERE status IN ('pending','sending','failed_retryable')")
    return cursor.rowcount


def put_delivery(db, record):
    """record 为入站投递字段；返回首次登记标志，重复 ID 不覆盖原始载荷。"""
    if not isinstance(record, dict) or not record.get("delivery_id") or not record.get("user_id"):
        raise ValueError("record 必须包含 delivery_id 和 user_id")
    fields = (
        record["delivery_id"], record["user_id"], record.get("session_id"),
        record.get("status", "received"), int(record.get("received_at", int(time.time() * 1000))),
        record.get("context_token"), json.dumps(record.get("payload", record.get("payload_json")),
                                                ensure_ascii=False) if record.get("payload", record.get("payload_json")) is not None else None,
    )
    db.execute("BEGIN IMMEDIATE")
    try:
        cursor = db.execute(
            "INSERT OR IGNORE INTO delivery(delivery_id,user_id,session_id,status,received_at,context_token,payload_json) "
            "VALUES(?,?,?,?,?,?,?)", fields)
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return cursor.rowcount == 1


def get_delivery(db, delivery_id):
    """delivery_id 为稳定投递 ID；返回完整状态。"""
    return row_json(db.execute("SELECT * FROM delivery WHERE delivery_id=?", (delivery_id,)).fetchone())


def delivery_context_token(db, delivery_id):
    """delivery_id 为入站投递 ID；返回其上下文令牌。"""
    row = db.execute("SELECT context_token FROM delivery WHERE delivery_id=?", (delivery_id,)).fetchone()
    return row["context_token"] if row and row["context_token"] else None


def update_delivery(db, delivery_id, status, patch=None):
    """delivery_id/status 为状态迁移；patch 只允许更新已知状态字段。"""
    allowed = {"session_id", "injected_at", "last_error", "attempt", "context_token", "payload_json"}
    values = {"status": status}
    if isinstance(patch, dict):
        values.update({key: value for key, value in patch.items() if key in allowed})
    if patch and patch.get("increment_attempt"):
        values["attempt"] = int((get_delivery(db, delivery_id) or {}).get("attempt", 0)) + 1
    if not values:
        return False
    assignments = ", ".join(f"{key}=?" for key in values)
    params = list(values.values()) + [delivery_id]
    db.execute("BEGIN IMMEDIATE")
    try:
        cursor = db.execute(f"UPDATE delivery SET {assignments} WHERE delivery_id=?", params)
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return cursor.rowcount == 1


def latest_user(db):
    """db 为状态连接；返回最近入站消息的用户标识。"""
    row = db.execute("SELECT user_id FROM delivery ORDER BY received_at DESC LIMIT 1").fetchone()
    return row["user_id"] if row else None


def list_unfinished_deliveries(db, limit=200):
    """limit 为最多返回条数；返回尚未完成或可重试的投递。"""
    rows = db.execute(
        "SELECT * FROM delivery WHERE status IN ('received','routing','failed_retryable') "
        "ORDER BY received_at LIMIT ?", (max(1, int(limit)),)).fetchall()
    return [row_json(row) for row in rows]


def batch_committable(db, delivery_ids):
    """delivery_ids 为一批投递 ID；只有全部进入可提交状态才返回真。"""
    ids = [str(item) for item in delivery_ids]
    if not ids:
        return True
    marks = ",".join("?" for _ in ids)
    row = db.execute(
        f"SELECT COUNT(*) AS pending FROM delivery WHERE delivery_id IN ({marks}) "
        "AND status NOT IN ('injected','control_applied','failed_terminal')", ids).fetchone()
    return int(row["pending"]) == 0


def _outbox_json(row):
    """row 为 outbox 行；转换为远程客户端使用的稳定字段。"""
    if row is None:
        return None
    result = dict(row)
    try:
        result["sent_parts"] = json.loads(result.pop("sent_parts_json") or "[]")
    except json.JSONDecodeError:
        result["sent_parts"] = []
    return result


def enqueue_outbox(db, value):
    """value 为出站消息字段；按会话分配单调 sequence 并幂等落库。"""
    required = ("session_id", "user_id", "kind", "text")
    if not isinstance(value, dict) or any(not value.get(key) for key in required):
        raise ValueError("outbox input 必须包含 session_id、user_id、kind、text")
    now = int(time.time() * 1000)
    db.execute("BEGIN IMMEDIATE")
    try:
        last = db.execute("SELECT COALESCE(MAX(sequence),0) AS n FROM outbox WHERE session_id=?",
                          (value["session_id"],)).fetchone()["n"]
        sequence = int(last) + 1
        outbound_id = f'{value["session_id"]}:{sequence}'
        client_id = value.get("client_id")
        if not client_id:
            fingerprint = json.dumps({
                "session_id": value["session_id"],
                "user_id": value["user_id"],
                "kind": value["kind"],
                "text": value["text"],
                "turn": value.get("turn"),
                "context_token": value.get("context_token"),
            }, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            client_id = "dsh-" + hashlib.sha256(fingerprint).hexdigest()[:32]
        existing = db.execute(
            "SELECT * FROM outbox WHERE client_id=? ORDER BY sequence LIMIT 1",
            (client_id,),
        ).fetchone()
        if existing is not None:
            db.execute("COMMIT")
            return _outbox_json(existing)
        db.execute(
            "INSERT INTO outbox(outbound_id,session_id,user_id,turn,sequence,kind,text,context_token,client_id,status,attempt,created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,'pending',0,?)",
            (outbound_id, value["session_id"], value["user_id"], value.get("turn"), sequence,
             value["kind"], value["text"], value.get("context_token"), client_id, now))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return _outbox_json(db.execute("SELECT * FROM outbox WHERE outbound_id=?", (outbound_id,)).fetchone())


def get_outbox(db, outbound_id):
    """outbound_id 为出站消息 ID；返回完整记录。"""
    return _outbox_json(db.execute("SELECT * FROM outbox WHERE outbound_id=?", (outbound_id,)).fetchone())


def next_outbox(db, session_id, now=None):
    """session_id 为会话；返回下一条到期的待发送消息。"""
    now = int(now if now is not None else time.time() * 1000)
    row = db.execute(
        "SELECT * FROM outbox WHERE session_id=? AND "
        "(status='pending' OR (status='failed_retryable' AND (next_retry_at IS NULL OR next_retry_at<=?))) "
        "ORDER BY (turn IS NULL), sequence LIMIT 1", (session_id, now)).fetchone()
    return _outbox_json(row)


def next_outbox_per_session(db, now=None):
    """now 为当前时间；每个会话只返回一条优先待发送消息。"""
    now = int(now if now is not None else time.time() * 1000)
    rows = db.execute(
        "SELECT * FROM outbox WHERE status='pending' OR (status='failed_retryable' AND "
        "(next_retry_at IS NULL OR next_retry_at<=?)) ORDER BY session_id,(turn IS NULL),sequence", (now,)).fetchall()
    seen = set()
    result = []
    for row in rows:
        if row["session_id"] in seen:
            continue
        seen.add(row["session_id"])
        result.append(_outbox_json(row))
    return result


def list_pending_outbox(db, limit=500):
    """limit 为最多返回条数；列出崩溃恢复所需的出站消息。"""
    rows = db.execute(
        "SELECT * FROM outbox WHERE status IN ('pending','sending','failed_retryable') "
        "ORDER BY session_id,sequence LIMIT ?", (max(1, int(limit)),)).fetchall()
    return [_outbox_json(row) for row in rows]


def mark_outbox(db, outbound_id, action, args):
    """action 为发送状态操作；按已定义状态迁移更新出站记录。"""
    if action == "sending":
        db.execute("UPDATE outbox SET status='sending',attempt=attempt+1 WHERE outbound_id=?", (outbound_id,))
    elif action == "part_sent":
        row = db.execute("SELECT sent_parts_json FROM outbox WHERE outbound_id=?", (outbound_id,)).fetchone()
        if row is None:
            return False
        parts = json.loads(row["sent_parts_json"] or "[]")
        index = int(args.get("index", 0))
        if index not in parts:
            parts.append(index)
            parts.sort()
            db.execute("UPDATE outbox SET sent_parts_json=? WHERE outbound_id=?",
                       (json.dumps(parts), outbound_id))
    elif action == "sent":
        db.execute("UPDATE outbox SET status='sent',sent_at=?,last_error=NULL WHERE outbound_id=?",
                   (int(time.time() * 1000), outbound_id))
    elif action == "failed":
        status = args["status"]
        if status not in ("failed_retryable", "failed_terminal"):
            raise ValueError("非法 outbox 失败状态")
        db.execute("UPDATE outbox SET status=?,last_error=?,next_retry_at=? WHERE outbound_id=?",
                   (status, args.get("error", ""), args.get("nextRetryAt"), outbound_id))
    else:
        raise ValueError("未知 outbox 操作")
    return True


def parked_results(db, limit=20):
    """limit 为最多返回条数；读取尚未送达的通知类结果。"""
    rows = db.execute(
        "SELECT outbound_id,sequence,text,created_at FROM outbox WHERE turn IS NULL "
        "AND status IN ('pending','failed_retryable','failed_terminal') ORDER BY sequence LIMIT ?",
        (max(1, int(limit)),)).fetchall()
    return [dict(row) for row in rows]


def bind_turn_context(db, value):
    """value 为会话轮次绑定字段；写入或覆盖指定 turn。"""
    db.execute(
        "INSERT INTO turn_context(session_id,turn,delivery_id,user_id,context_token,created_at) VALUES(?,?,?,?,?,?) "
        "ON CONFLICT(session_id,turn) DO UPDATE SET delivery_id=excluded.delivery_id,user_id=excluded.user_id,"
        "context_token=excluded.context_token",
        (value["session_id"], int(value["turn"]), value["delivery_id"], value["user_id"],
         value.get("context_token"), int(time.time() * 1000)))
    return True


def get_turn_context(db, session_id, turn):
    """session_id/turn 为会话轮次键；返回上下文绑定。"""
    row = db.execute("SELECT delivery_id,user_id,context_token FROM turn_context WHERE session_id=? AND turn=?",
                     (session_id, int(turn))).fetchone()
    return dict(row) if row else None


def latest_delivery_for_session(db, session_id):
    """session_id 为会话；返回最近一条已处理入站投递。"""
    row = db.execute(
        "SELECT * FROM delivery WHERE session_id=? AND status IN ('injected','control_applied') "
        "ORDER BY received_at DESC LIMIT 1", (session_id,)).fetchone()
    return row_json(row)


def get_lease(db):
    """无参数；返回当前消费者租约。"""
    row = db.execute("SELECT owner_id,pid,heartbeat_at,account_id,process_started_at FROM consumer_lease WHERE id=1").fetchone()
    return dict(row) if row else None


def try_acquire_lease(db, value):
    """value 为 owner_id、pid、启动时间、账号和陈旧时长；原子取得唯一租约。"""
    now = int(time.time() * 1000)
    db.execute("BEGIN IMMEDIATE")
    try:
        existing = get_lease(db)
        if existing is not None:
            # 服务端不能可靠判断远程客户端 PID 是否存活；由 owner_id 和 stale_ms 控制接管。
            if now - int(existing["heartbeat_at"]) <= int(value.get("stale_ms", 30000)):
                db.execute("COMMIT")
                return False
        db.execute(
            "INSERT INTO consumer_lease(id,owner_id,pid,process_started_at,account_id,acquired_at,heartbeat_at) "
            "VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,pid=excluded.pid,"
            "process_started_at=excluded.process_started_at,account_id=excluded.account_id,"
            "acquired_at=excluded.acquired_at,heartbeat_at=excluded.heartbeat_at",
            (value["owner_id"], int(value.get("pid", 0)), int(value.get("process_started_at", 0)),
             value.get("account_id", ""), now, now))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return True


def heartbeat_lease(db, owner_id):
    """owner_id 为租约所有者；仅持有者可以续租。"""
    cursor = db.execute("UPDATE consumer_lease SET heartbeat_at=? WHERE id=1 AND owner_id=?",
                        (int(time.time() * 1000), owner_id))
    return cursor.rowcount == 1


def release_lease(db, owner_id):
    """owner_id 为租约所有者；释放自身租约。"""
    db.execute("DELETE FROM consumer_lease WHERE id=1 AND owner_id=?", (owner_id,))
    return True


def snapshot(db):
    """db 为状态连接；返回只读计数，不暴露令牌或原始消息正文。"""
    return {
        "cursor_len": len(get_cursor(db)),
        "routes": {"users": db.execute("SELECT COUNT(*) AS n FROM route").fetchone()["n"],
                   "sessions": db.execute("SELECT COUNT(DISTINCT session_id) AS n FROM route").fetchone()["n"]},
        "delivery": {row["status"]: row["n"] for row in db.execute(
            "SELECT status,COUNT(*) AS n FROM delivery GROUP BY status").fetchall()},
        "outbox": {row["status"]: row["n"] for row in db.execute(
            "SELECT status,COUNT(*) AS n FROM outbox GROUP BY status").fetchall()},
        "lease": get_lease(db),
    }


def handle(message):
    """message 为 JSON-RPC 请求；在单个数据库连接上执行固定白名单操作。"""
    request_id = message.get("id")
    method = message.get("method")
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": request_id, "result": {
            "protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
            "serverInfo": {"name": "synlove-state", "version": "1.0.0"}}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": request_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}}
    if method != "tools/call":
        return {"jsonrpc": "2.0", "id": request_id,
                "error": {"code": -32601, "message": f"unsupported method: {method}"}}
    args = (message.get("params") or {}).get("arguments") or {}
    name = (message.get("params") or {}).get("name")
    with lock:
        db = connect()
        try:
            ensure_schema(db)
            if name == "state_get_cursor":
                result = {"cursor": get_cursor(db)}
            elif name == "state_set_cursor":
                result = {"updated": set_cursor(db, args.get("cursor", ""))}
            elif name == "state_get_session":
                result = {"sessionId": get_session(db, args.get("userId", ""))}
            elif name == "state_set_session":
                result = {"updated": set_session(db, args["userId"], args["sessionId"])}
            elif name == "state_get_meta":
                result = {"value": get_meta(db, args["key"])}
            elif name == "state_set_meta":
                result = {"updated": set_meta(db, args["key"], args["value"])}
            elif name == "state_list_meta_prefix":
                result = {"items": list_meta_prefix(db, args["prefix"])}
            elif name == "state_delete_meta":
                result = {"deleted": delete_meta(db, args["key"])}
            elif name == "state_session_id_for":
                result = {"sessionId": session_id_for(db, args["userId"])}
            elif name == "state_context_epoch":
                result = {"epoch": context_epoch(db, args["userId"])}
            elif name == "state_bump_context_epoch":
                result = {"epoch": bump_context_epoch(db, args["userId"])}
            elif name == "state_clear_session":
                result = {"deleted": clear_session(db, args["userId"])}
            elif name == "state_list_users":
                result = {"users": list_users(db)}
            elif name == "state_clear_queue":
                result = {"removed": clear_queue(db)}
            elif name == "state_get_delivery":
                result = {"delivery": get_delivery(db, args["deliveryId"])}
            elif name == "state_delivery_context_token":
                result = {"contextToken": delivery_context_token(db, args["deliveryId"])}
            elif name == "state_put_delivery":
                result = {"first": put_delivery(db, args["record"])}
            elif name == "state_update_delivery":
                result = {"updated": update_delivery(db, args["deliveryId"], args["status"], args.get("patch"))}
            elif name == "state_latest_user":
                result = {"userId": latest_user(db)}
            elif name == "state_list_unfinished_deliveries":
                result = {"deliveries": list_unfinished_deliveries(db, args.get("limit", 200))}
            elif name == "state_batch_committable":
                result = {"committable": batch_committable(db, args.get("deliveryIds", []))}
            elif name == "state_enqueue_outbox":
                result = {"outbox": enqueue_outbox(db, args["input"])}
            elif name == "state_next_outbox":
                result = {"outbox": next_outbox(db, args["sessionId"], args.get("now"))}
            elif name == "state_next_outbox_per_session":
                result = {"outbox": next_outbox_per_session(db, args.get("now"))}
            elif name == "state_mark_outbox_sending":
                result = {"updated": mark_outbox(db, args["outboundId"], "sending", args)}
            elif name == "state_mark_outbox_part_sent":
                result = {"updated": mark_outbox(db, args["outboundId"], "part_sent", args)}
            elif name == "state_mark_outbox_sent":
                result = {"updated": mark_outbox(db, args["outboundId"], "sent", args)}
            elif name == "state_mark_outbox_failed":
                result = {"updated": mark_outbox(db, args["outboundId"], "failed", args)}
            elif name == "state_get_outbox":
                result = {"outbox": get_outbox(db, args["outboundId"])}
            elif name == "state_list_pending_outbox":
                result = {"outbox": list_pending_outbox(db, args.get("limit", 500))}
            elif name == "state_parked_results":
                result = {"results": parked_results(db, args.get("limit", 20))}
            elif name == "state_prune_parked_results":
                cutoff = int(args.get("now", int(time.time() * 1000))) - int(args["maxAgeMs"])
                cursor = db.execute(
                    "DELETE FROM outbox WHERE turn IS NULL AND status IN "
                    "('pending','failed_retryable','failed_terminal') AND created_at < ?", (cutoff,))
                result = {"removed": cursor.rowcount}
            elif name == "state_trim_pending_notices":
                keep = max(0, int(args.get("keep", 3)))
                cursor = db.execute(
                    "DELETE FROM outbox WHERE outbound_id IN (SELECT outbound_id FROM outbox "
                    "WHERE session_id=? AND status='pending' AND turn IS NULL "
                    "ORDER BY sequence DESC LIMIT -1 OFFSET ?)",
                    (args["sessionId"], keep))
                result = {"removed": cursor.rowcount}
            elif name == "state_bind_turn_context":
                result = {"updated": bind_turn_context(db, args["input"])}
            elif name == "state_get_turn_context":
                result = {"context": get_turn_context(db, args["sessionId"], args["turn"])}
            elif name == "state_latest_delivery_for_session":
                result = {"delivery": latest_delivery_for_session(db, args["sessionId"])}
            elif name == "state_prune_turn_context":
                db.execute(
                    "DELETE FROM turn_context WHERE session_id=? AND turn NOT IN "
                    "(SELECT turn FROM turn_context WHERE session_id=? ORDER BY turn DESC LIMIT ?)",
                    (args["sessionId"], args["sessionId"], max(0, int(args.get("keep", 20)))))
                result = {"updated": True}
            elif name == "state_get_lease":
                result = {"lease": get_lease(db)}
            elif name == "state_try_acquire_lease":
                result = {"acquired": try_acquire_lease(db, args["input"])}
            elif name == "state_heartbeat_lease":
                result = {"updated": heartbeat_lease(db, args["ownerId"])}
            elif name == "state_release_lease":
                result = {"updated": release_lease(db, args["ownerId"])}
            elif name == "state_snapshot":
                result = snapshot(db)
            else:
                raise ValueError(f"未知工具：{name}")
            return {"jsonrpc": "2.0", "id": request_id, "result": {"structuredContent": result}}
        except Exception as error:
            return {"jsonrpc": "2.0", "id": request_id,
                    "result": {"isError": True, "content": [{"type": "text", "text": str(error)}]}}
        finally:
            db.close()


def main():
    """无参数；读取 stdin JSON-RPC 并逐条输出。"""
    for raw in sys.stdin:
        if not raw.strip():
            continue
        try:
            result = handle(json.loads(raw))
            if result is not None:
                print(json.dumps(result, ensure_ascii=False), flush=True)
        except json.JSONDecodeError:
            continue


if __name__ == "__main__":
    main()
