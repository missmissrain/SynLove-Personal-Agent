"""Opencode 来源：读本机 opencode 的会话库，找出"刚跑完的任务"和它的最终回答。

数据来源（只读）：`~/.local/share/opencode/opencode.db`
    session  会话（directory / title / time_created / time_updated）
    message  消息（data 里带 role）
    part     分片（type=text 才是给人看的文本）

完成判定：会话静默超过 idle 秒 + 找到最后一条助手消息；用"最后一条助手消息 id"当去重指纹，
而不是 time_updated——否则会话每产生一点新输出就会重报一次。

注册参数（构造）：
    data_dir opencode 数据目录，默认取 OPENCODE_DATA_DIR 或 ~/.local/share/opencode
    limit    每轮最多看多少个最近会话，默认 10
    idle_ms  静默多久算完成，默认 8000
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

from taskReport.model.TaskReport import TaskReport


class OpencodeSource:
    """从 opencode 会话库里取"刚完成"的任务。"""

    def __init__(self, data_dir=None, limit=10, idle_ms=8000):
        """data_dir：opencode 数据目录；limit：会话数上限；idle_ms：判定完成的静默时长。"""
        self.data_dir = Path(data_dir or os.environ.get('OPENCODE_DATA_DIR')
                             or Path.home() / '.local' / 'share' / 'opencode')
        self.limit = limit
        self.idle_ms = idle_ms

    def poll(self):
        """返回最近一批会话的完成情况（未到静默期的会被标成运行中）。"""
        db_path = self.data_dir / 'opencode.db'
        if not db_path.is_file():
            return []
        sessions = self._recent_sessions(db_path)
        reports = []
        for row in sessions:
            session_id, directory, title, updated = row
            if _now_ms() - updated < self.idle_ms:
                continue                      # 还在写，等静默期过了再判
            last = self._last_answer(db_path, session_id)
            if last is None:
                continue
            message_id, text = last
            if not text.strip():
                continue
            reports.append(TaskReport(
                source='opencode',
                task_id=session_id,
                fingerprint=message_id,
                project=Path(str(directory or '')).name or str(directory or ''),
                title=self._last_user_text(db_path, session_id) or str(title or '未命名任务'),
                status='已完成',
                result=text,
                finished_at=updated / 1000.0,
            ))
        return reports

    def _recent_sessions(self, db_path):
        """取最近更新的非归档会话。参数 db_path：opencode 数据库路径。"""
        try:
            conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True, timeout=5)
        except sqlite3.Error:
            return []
        try:
            return conn.execute(
                'SELECT id, directory, title, time_updated FROM session '
                'WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT ?', (self.limit,)
            ).fetchall()
        except sqlite3.Error:
            return []
        finally:
            conn.close()

    def _last_answer(self, db_path, session_id):
        """取最后一条助手消息的 (id, 文本)。参数 session_id：会话 id。"""
        try:
            conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True, timeout=5)
        except sqlite3.Error:
            return None
        try:
            message = conn.execute(
                "SELECT id FROM message WHERE session_id = ? AND data LIKE '%\"role\":\"assistant\"%' "
                'ORDER BY rowid DESC LIMIT 1', (session_id,)
            ).fetchone()
            if message is None:
                return None
            texts = []
            for (data,) in conn.execute('SELECT data FROM part WHERE message_id = ? ORDER BY rowid ASC',
                                        (message[0],)):
                try:
                    part = json.loads(data)
                except (json.JSONDecodeError, TypeError):
                    continue
                if part.get('type') == 'text' and str(part.get('text') or '').strip():
                    texts.append(str(part['text']).strip())
            if not texts:
                return None
            return str(message[0]), '\n'.join(texts)
        except sqlite3.Error:
            return None
        finally:
            conn.close()

    def _last_user_text(self, db_path, session_id):
        """取该会话最后一条用户消息，作为任务标题。参数 session_id：会话 id。"""
        try:
            conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True, timeout=5)
        except sqlite3.Error:
            return ''
        try:
            rows = conn.execute(
                'SELECT p.data FROM part p JOIN message m ON p.message_id = m.id '
                "WHERE p.session_id = ? AND m.data LIKE '%\"role\":\"user\"%' "
                'ORDER BY p.rowid DESC LIMIT 20', (session_id,)
            ).fetchall()
        except sqlite3.Error:
            return ''
        finally:
            conn.close()
        for (data,) in rows:
            try:
                part = json.loads(data)
            except (json.JSONDecodeError, TypeError):
                continue
            if part.get('type') == 'text' and str(part.get('text') or '').strip():
                return _flatten_title(str(part['text']))
        return ''


def _flatten_title(text, limit=120):
    """把多行请求压成一行标题。参数 text 原文；limit 字数上限。"""
    import re as _re
    flat = ' '.join(_re.sub(r'^["#\s]+', '', line).strip()
                    for line in str(text or '').splitlines() if line.strip())
    flat = ' '.join(flat.split())
    flat = _re.sub(r'^(工作任务|任务|需求)[：:]\s*', '', flat)
    return flat[:limit] + ('…' if len(flat) > limit else '')


def _now_ms():
    """当前毫秒时间戳。"""
    import time
    return int(time.time() * 1000)
