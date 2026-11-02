"""任务汇报的数据模型：把"某个编码助手刚干完一个任务"标准化成一条记录。

职责：
- 在来源（codex / opencode）、润色、推送三段之间传递同一份结构，避免各自揣着原始字段跑；
- 提供未润色的兜底文本（模型润色失败时直接发它，不至于让汇报丢失）。

注册参数（TaskReport 字段）：
    source      来源标识，`codex` 或 `opencode`
    task_id     来源侧的会话/线程 id
    fingerprint 完成指纹（codex 用"状态+事件时间"，opencode 用最后一条助手消息 id）
    project     项目名（工作目录最后一段）
    title       任务标题（用户原话，截断后展示）
    status      完成状态：已完成 / 已中止
    result      原始结果文本（助手最后一段回答）
    finished_at 完成时刻（epoch 秒），用于过滤"服务停机期间攒下的旧任务"
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class TaskReport:
    """一条待汇报的任务完成记录。"""

    source: str
    task_id: str
    fingerprint: str
    project: str
    title: str
    status: str
    result: str
    finished_at: float

    def fallback_body(self, limit: int = 1800):
        """润色不可用时直接发的正文。参数 limit：保留字符数。"""
        body = (self.result or '').strip()
        if len(body) > limit:
            body = body[:limit] + '…'
        return body or '（没有取到结果文本）'

    def header(self, title_limit: int = 30):
        """回传抬头：哪个软件的、哪一段会话。参数 title_limit：标题保留字数。"""
        label = SOURCE_LABEL.get(self.source, self.source)
        title = (self.title or '').strip().replace('\n', ' ')
        if len(title) > title_limit:
            title = title[:title_limit] + '…'
        return f'{label} · {title or "未命名任务"}（会话 {_short_id(self.task_id)}）'

    def raw_text(self, limit: int = 1800):
        """拼出未润色的兜底汇报。参数 limit：结果文本保留的字符数。"""
        body = (self.result or '').strip()
        if len(body) > limit:
            body = body[:limit] + '…'
        lines = [self.header()]
        if self.status != '已完成':
            lines.append(f'状态：{self.status}')
        lines.append(f'项目：{self.project}')
        if body:
            lines.extend(['', body])
        return '\n'.join(lines)

    def brief(self):
        """给出润色用的紧凑事实块（省 token，也避免把整段日志塞给模型）。"""
        return '\n'.join([
            f'来源：{self.source}',
            f'会话：{_short_id(self.task_id)}',
            f'项目：{self.project}',
            f'任务：{self.title[:200]}',
            f'状态：{self.status}',
            '结果原文：',
            (self.result or '（没有取到结果文本）')[:4000],
        ])


# 回传里用的软件名：按各自官方写法，别写成小写的 codex / OpenCode。
SOURCE_LABEL = {'codex': 'Codex', 'opencode': 'opencode'}


def _short_id(task_id: str, size: int = 8):
    """把会话 id 压短（去掉 ses_ 前缀，取前几位）。参数 task_id 原始 id；size 保留长度。"""
    value = str(task_id or '').strip()
    if value.lower().startswith('ses_'):
        value = value[4:]
    return value[:size] if len(value) > size else value
