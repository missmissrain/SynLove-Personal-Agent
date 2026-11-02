"""Opencode 来源：读本机 opencode 的会话库，找出"刚跑完的任务"和它的最终回答。

数据来源（只读）：`~/.local/share/opencode/opencode.db`。
新版读取 session_v2/session_message，以当前回合末尾的 idle 事件及 outcome 判定完成；
旧版读取 session/message/part，必须存在最终回复或明确错误，静默本身不代表完成。
新版会话优先，同一会话不再回读旧表；只使用终态事件/最终消息作为稳定去重指纹。

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
        self.schema_version = None

    def poll(self):
        """无参数；在同一只读快照内读取已结束回合，运行中和等待工具的回合不汇报。"""
        db_path = self.data_dir / 'opencode.db'
        if not db_path.is_file():
            return []
        with sqlite3.connect(db_path.resolve().as_uri() + '?mode=ro', uri=True, timeout=5) as conn:
            conn.execute('PRAGMA query_only=ON')
            conn.execute('BEGIN')
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if {'session_v2', 'session_message'} <= tables:
                self.schema_version = 'v2'
                return self._poll_v2(conn)
            self.schema_version = 'v1'
        return self._poll_v1(db_path)

    def _poll_v2(self, conn):
        """conn 为只读事务连接；按序列界定本轮，只读取最终回复并尊重失败/中止事件。"""
        sessions = conn.execute(
            'SELECT id,directory,title FROM session_v2 WHERE time_archived IS NULL '
            'AND parent_id IS NULL ORDER BY time_updated DESC LIMIT ?', (self.limit,)
        ).fetchall()
        reports = []
        states = {'succeeded': '已完成', 'failed': '已失败',
                  'aborted': '已中止', 'cancelled': '已中止',
                  'canceled': '已中止', 'interrupted': '已中止'}
        for session_id, directory, title in sessions:
            tail = conn.execute(
                "SELECT id,seq,time_created,data,type FROM session_message WHERE session_id=? "
                "AND type IN ('user','assistant','idle') ORDER BY seq DESC LIMIT 1", (session_id,)
            ).fetchone()
            if not tail or tail[4] != 'idle':
                continue
            idle_id, seq, created, raw, _kind = tail
            data = json.loads(raw)
            status = states.get(data.get('outcome'))
            if not status or _now_ms() - created < self.idle_ms:
                continue
            boundary = conn.execute(
                "SELECT COALESCE(MAX(seq),-1) FROM session_message WHERE session_id=? "
                "AND seq<? AND type IN ('user','idle')", (session_id, seq)
            ).fetchone()[0]
            answer = conn.execute(
                "SELECT data FROM session_message WHERE session_id=? AND type='assistant' "
                'AND seq>? AND seq<? ORDER BY seq DESC LIMIT 1', (session_id, boundary, seq)
            ).fetchone()
            text = ''
            if answer:
                final = json.loads(answer[0])
                if final.get('finish') == 'stop' and final.get('time', {}).get('completed'):
                    text = self._final_text(final.get('content', []))
            if status == '已完成' and not text:
                continue
            if not text:
                text = ('OpenCode 本轮已中止，未产生最终回复。' if status == '已中止'
                        else 'OpenCode 本轮执行失败，未产生最终回复，请查看该会话错误记录。')
            user = conn.execute(
                "SELECT data FROM session_message WHERE session_id=? AND type='user' "
                'AND seq<? ORDER BY seq DESC LIMIT 1', (session_id, seq)
            ).fetchone()
            request = json.loads(user[0]).get('text', '') if user else ''
            reports.append(TaskReport(
                source='opencode', task_id=session_id, fingerprint='v2:' + idle_id,
                project=Path(str(directory or '')).name, title=_flatten_title(request or title),
                status=status, result=text, finished_at=created / 1000.0,
            ))
        return reports

    @staticmethod
    def _final_text(parts):
        """parts 为消息内容数组；只取可见 text，排除推理、工具输出和合成上下文。"""
        return '\n'.join(str(part.get('text') or '').strip() for part in parts
                         if part.get('type') == 'text' and not part.get('synthetic')).strip()

    def _poll_v1(self, db_path):
        """db_path 为旧版会话库；静默只作为延迟，最终消息状态才是完成证据。"""
        sessions = self._recent_sessions(db_path)
        reports = []
        for row in sessions:
            session_id, directory, title, updated = row
            if _now_ms() - updated < self.idle_ms:
                continue                      # 还在写，等静默期过了再判
            last = self._last_answer(db_path, session_id)
            if last is None:
                continue
            message_id, text, status, finished = last
            if not text.strip():
                continue
            reports.append(TaskReport(
                source='opencode',
                task_id=session_id,
                fingerprint=message_id,
                project=Path(str(directory or '')).name or str(directory or ''),
                title=self._last_user_text(db_path, session_id) or str(title or '未命名任务'),
                status=status,
                result=text,
                finished_at=finished / 1000.0,
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
        """参数 db_path/session_id：旧库及会话；最新消息须为已结束的助手最终回复。"""
        try:
            conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True, timeout=5)
        except sqlite3.Error:
            return None
        try:
            message = conn.execute('SELECT id,data FROM message WHERE session_id=? '
                                   'ORDER BY time_created DESC,rowid DESC LIMIT 1', (session_id,)).fetchone()
            if message is None:
                return None
            info = json.loads(message[1])
            completed = (info.get('time') or {}).get('completed')
            if info.get('role') != 'assistant' or not completed:
                return None
            if info.get('error'):
                status = '已中止' if info['error'].get('name') == 'MessageAbortedError' else '已失败'
            elif info.get('finish') == 'stop':
                status = '已完成'
            else:
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
            if not texts and status == '已完成':
                return None
            text = '\n'.join(texts) or ('OpenCode 本轮' + status + '，未产生最终回复。')
            return str(message[0]), text, status, completed
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
