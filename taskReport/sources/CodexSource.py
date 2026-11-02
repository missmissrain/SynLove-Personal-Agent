"""Codex 来源：读本机 Codex 的会话状态，找出"刚跑完的任务"和它的最终回答。

数据来源（只读，不打扰 Codex）：
    `~/.codex/state_5.sqlite` 的 threads 表 → 最近会话的 rollout 路径 / 工作目录 / 标题；
    rollout JSONL → 生命周期事件（task_started / task_complete / turn_aborted）与助手回答。

为什么不用 Codex 的 notify 钩子：那会变成"第二个推送进程"，历史上踩过重复消费的坑；
这里只读文件，汇报由本服务自己的轮询决定。

注册参数（构造）：
    codex_home Codex 数据目录，默认取 CODEX_HOME 或 ~/.codex
    limit      每轮最多看多少个最近会话，默认 8
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import datetime
from pathlib import Path

from taskReport.model.TaskReport import TaskReport

# rollout 尾部多大就够找到生命周期事件（任务结束总在文件末尾）
TAIL_BYTES = 512 * 1024
# 取最终回答时读的尾部大小；Codex 的 rollout 可能很大，不做全量解析
ANSWER_BYTES = 2 * 1024 * 1024
LIFECYCLE = (
    ('"type":"task_complete"', '已完成'),
    ('"type":"turn_aborted"', '已中止'),
    ('"type":"task_started"', '运行中'),
)


class CodexSource:
    """从 Codex 会话库里取"刚完成"的任务。"""

    def __init__(self, codex_home=None, limit=8):
        """codex_home：Codex 数据目录；limit：每轮扫描的会话数上限。"""
        self.codex_home = Path(codex_home or os.environ.get('CODEX_HOME')
                               or Path.home() / '.codex')
        self.limit = limit

    def poll(self):
        """返回本轮所有非归档会话的状态（含运行中的，由上层过滤）。"""
        state_db = self.codex_home / 'state_5.sqlite'
        if not state_db.is_file():
            return []
        try:
            conn = sqlite3.connect(f'file:{state_db}?mode=ro', uri=True, timeout=5)
        except sqlite3.Error:
            return []
        try:
            rows = conn.execute(
                'SELECT id, rollout_path, cwd, title, updated_at FROM threads '
                'WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?', (self.limit,)
            ).fetchall()
        except sqlite3.Error:
            return []
        finally:
            conn.close()

        reports = []
        for thread_id, rollout, cwd, title, _updated in rows:
            rollout_path = str(rollout or '')
            status, finished_at = self._lifecycle(rollout_path)
            reports.append(TaskReport(
                source='codex',
                task_id=str(thread_id),
                fingerprint=f'{status}|{finished_at:.0f}',
                project=Path(str(cwd or '')).name or str(cwd or ''),
                title=self._task_title(rollout_path) or _flatten_title(str(title or '未命名任务')),
                status=status,
                result=self._answer(rollout_path) if status == '已完成' else '',
                finished_at=finished_at,
            ))
        return reports

    def _lifecycle(self, rollout_path):
        """从 rollout 尾部倒着找最近一个生命周期事件，返回 (状态, 时间戳秒)。"""
        if not rollout_path or not Path(rollout_path).is_file():
            return '记录缺失', 0.0
        try:
            with open(rollout_path, 'rb') as handle:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                handle.seek(max(0, size - TAIL_BYTES))
                tail = handle.read().decode('utf-8', 'replace')
        except OSError:
            return '记录缺失', 0.0
        for line in reversed(tail.splitlines()):
            for marker, status in LIFECYCLE:
                if marker in line:
                    return status, _parse_time(line)
        return '等待首次运行', 0.0

    def _task_title(self, rollout_path):
        """取最近一条真实用户消息当任务标题。参数 rollout_path：rollout 文件路径。"""
        for line in reversed(_tail_lines(rollout_path, TAIL_BYTES)):
            if '"type":"user_message"' not in line:
                continue
            try:
                payload = json.loads(line).get('payload') or {}
            except json.JSONDecodeError:
                continue
            text = _clean_user_message(str(payload.get('message') or ''))
            if text:
                return text
        return ''

    def _answer(self, rollout_path):
        """取最后一条助手回答文本。参数 rollout_path：rollout 文件路径。"""
        latest = ''
        for line in _tail_lines(rollout_path, ANSWER_BYTES):
            if '"role":"assistant"' not in line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            payload = row.get('payload') or {}
            if row.get('type') != 'response_item' or payload.get('type') != 'message':
                continue
            if payload.get('role') != 'assistant':
                continue
            parts = [(item.get('text') or item.get('output_text') or '')
                     for item in (payload.get('content') or [])]
            text = '\n'.join(part for part in parts if part).strip()
            if text:
                latest = text
        return latest


def _tail_lines(path, size):
    """读文件尾部并按行切分（行可能被截断，解析时容错）。参数 path 文件；size 字节数。"""
    if not path or not Path(path).is_file():
        return []
    try:
        with open(path, 'rb') as handle:
            handle.seek(0, os.SEEK_END)
            total = handle.tell()
            handle.seek(max(0, total - size))
            return handle.read().decode('utf-8', 'replace').splitlines()
    except OSError:
        return []


def _parse_time(line):
    """从一行 JSONL 里取 timestamp 并转成 epoch 秒。参数 line：一行文本。"""
    match = re.search(r'"timestamp":"([^"]+)"', line)
    if match is None:
        return 0.0
    try:
        return datetime.fromisoformat(match.group(1).replace('Z', '+00:00')).timestamp()
    except ValueError:
        return 0.0


def _clean_user_message(message):
    """去掉 Codex 的包装文本，只留用户真实请求。参数 message：原始用户消息。"""
    marker = '## My request for Codex:'
    text = message
    if marker in text:
        text = text[text.index(marker) + len(marker):]
    text = text.strip()
    if text.startswith('<environment_context>') or text.startswith('<permissions instructions>'):
        return ''
    return _flatten_title(text)


def _flatten_title(text, limit=120):
    """把多行、带 markdown 的原始请求压成一行标题。参数 text 原文；limit 字数上限。"""
    lines = []
    for line in text.splitlines():
        value = re.sub(r'^["#\s]+', '', line).strip()
        if not value or value.startswith('Files pasted by the user'):
            continue
        lines.append(value)
    flat = ' '.join(lines)
    flat = re.sub(r'\s+', ' ', flat).strip()
    flat = re.sub(r'^(工作任务|任务|需求)[：:]\s*', '', flat)
    return flat[:limit] + ('…' if len(flat) > limit else '')
