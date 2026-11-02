"""完成汇报的轮询编排：盯 codex / opencode，任务一结束就润色并推 QQ。

一轮的流程：
    读两个来源 → 指纹对不对得上 → 判断开关和新鲜度 → 润色 → 推 QQ → 落状态

三条保守规则（都是踩过坑才加的）：
1. **首轮只建基线**：装上或重启后不会把历史任务全播一遍；
2. **只报新鲜任务**：停机期间攒下的旧完成记录超过 2 小时就不再打扰；
3. **失败重试有上限**：推送失败最多重试 3 轮，避免网络不好时无限重发。

注册参数（构造）：
    root     生产根目录；默认按本文件位置向上推三级
    dry_run  True 时只打日志不真发（联调用）
"""

from __future__ import annotations

import json
import time
import traceback
from pathlib import Path

from taskReport.config.TaskReportConfig import TaskReportConfig
from taskReport.polish.ReportPolisher import ReportPolisher
from taskReport.push.QqReporter import QqReporter
from taskReport.sources.CodexSource import CodexSource
from taskReport.sources.OpencodeSource import OpencodeSource

# 每个来源各自记录"已经报过的完成指纹"
SOURCE_KEYS = ('codex', 'opencode')
MAX_ATTEMPTS = 3


class TaskReportWatcher:
    """完成汇报的轮询器。"""

    def __init__(self, root=None, dry_run=False):
        """root：生产根目录；dry_run：只记录不发送。"""
        self.config = TaskReportConfig(root)
        self.codex = CodexSource()
        self.opencode = OpencodeSource()
        self.reporter = QqReporter(self.config.root)
        self.dry_run = dry_run
        self._polisher = None
        self.state = self._load_state()

    def poll_once(self):
        """扫一轮，返回本轮处理过的条目数。"""
        reports = []
        try:
            reports.extend(self.codex.poll())
        except Exception as error:                      # noqa: BLE001 —— 单个来源坏掉不影响另一个
            self.log(f'codex 读取失败：{type(error).__name__}: {error}')
        try:
            reports.extend(self._opencode_reports())
        except Exception as error:                      # noqa: BLE001
            self.log(f'opencode 读取失败：{type(error).__name__}: {error}')

        handled = 0
        for report in reports:
            try:
                if self._handle(report):
                    handled += 1
            except Exception as error:                  # noqa: BLE001
                self.log(f'{report.source}:{report.task_id} 处理异常：{type(error).__name__}: {error}')
                self.log(traceback.format_exc(limit=2))
        if not self.state.get('seeded'):
            self.state['seeded'] = True
            self.state['dirty'] = True
            self.log('首轮基线建立完成，之后只汇报新完成的任务')
        if self.state.pop('dirty', False):
            self._save_state()
        return handled

    def run_forever(self):
        """常驻：按配置的间隔一直扫，直到进程被杀。"""
        interval = self.config.poll_seconds()
        self.log(f'完成汇报启动：每 {interval:.0f} 秒一轮')
        while True:
            try:
                self.poll_once()
            except Exception as error:                  # noqa: BLE001 —— 轮询器本身不能死
                self.log(f'本轮异常：{type(error).__name__}: {error}')
            time.sleep(interval)

    def _opencode_reports(self):
        """过滤掉微信桥已经汇报过的 opencode 会话。"""
        window = self.config.bridge_window()
        reports = []
        for report in self.opencode.poll():
            if window is not None and self._in_window(report.finished_at, window):
                self.log(f'opencode:{report.task_id} 在微信桥窗口内，跳过（由桥自己汇报）')
                continue
            reports.append(report)
        return reports

    @staticmethod
    def _in_window(finished_at, window):
        """任务是否落在微信桥的运行窗口里。参数 finished_at 秒；window 起止毫秒。"""
        stamp = finished_at * 1000.0
        return window['start'] - 2000 <= stamp <= (window['end'] or stamp) + 15000

    def _handle(self, report):
        """处理一条汇报；返回是否真的推送了。参数 report：TaskReport。"""
        bucket = self.state.setdefault(report.source, {})
        key = f'{report.source}:{report.task_id}'
        attempts = self.state.setdefault('attempts', {})

        if bucket.get(report.task_id) == report.fingerprint:
            return False                                # 报过或还在跑，直接跳过

        bucket[report.task_id] = report.fingerprint
        self.state['dirty'] = True
        if not self.state.get('seeded'):
            return False                                # 首轮只建基线
        if report.status not in ('已完成', '已中止'):
            self.log(f'{key} 状态 {report.status}，先不报')
            return False

        age_minutes = (time.time() - report.finished_at) / 60.0 if report.finished_at else 0.0
        if report.finished_at and age_minutes > self.config.fresh_minutes():
            self.log(f'{key} 已完成 {age_minutes:.0f} 分钟，超过新鲜度窗口，跳过')
            return False

        if not self.config.is_enabled(report.source):
            self.log(f'{key} 已完成，但「{report.source} 完成汇报」开关是关的')
            return False

        text, used_model, note = self._polish(report)
        if not used_model:
            self.log(f'{key} 润色未生效（{note}），改发原文')
        body = text or report.fallback_body()
        message = report.header() + '\n' + body

        if self.dry_run:
            self.log(f'{key} [dry-run] 将推送：\n{message}')
            return True

        try:
            self.reporter.send_chunks(message)
        except Exception as error:                      # noqa: BLE001
            attempts[key] = int(attempts.get(key, 0)) + 1
            bucket.pop(report.task_id, None)            # 允许下一轮重试
            self.state['dirty'] = True
            self.log(f'{key} 推送失败（第 {attempts[key]} 次）：{type(error).__name__}: {error}')
            if attempts[key] >= MAX_ATTEMPTS:
                bucket[report.task_id] = report.fingerprint
                self.log(f'{key} 连续失败 {MAX_ATTEMPTS} 次，放弃本轮汇报')
            return False

        attempts.pop(key, None)
        self.state['dirty'] = True
        self.log(f'{key} 已推送 QQ（{len(message)} 字，模型润色={used_model}）')
        return True

    def _polish(self, report):
        """润色；模型不可用时返回空文本让上层用原文兜底。参数 report：TaskReport。"""
        try:
            if self._polisher is None:
                self._polisher = ReportPolisher(self.config.model_target())
            text, used, note = self._polisher.polish(report)
            return (text if used else ''), used, note
        except Exception as error:                      # noqa: BLE001
            return '', False, f'{type(error).__name__}: {error}'

    def _load_state(self):
        """读状态文件；不存在或坏掉时返回空状态。"""
        path = self.config.state_file
        if not path.is_file():
            return {'seeded': False, 'attempts': {}, **{key: {} for key in SOURCE_KEYS}}
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError):
            return {'seeded': False, 'attempts': {}, **{key: {} for key in SOURCE_KEYS}}
        if not isinstance(data, dict):
            return {'seeded': False, 'attempts': {}, **{key: {} for key in SOURCE_KEYS}}
        for key in SOURCE_KEYS:
            data.setdefault(key, {})
        data.setdefault('attempts', {})
        data.setdefault('seeded', False)
        return data

    def _save_state(self):
        """落状态文件（先写临时文件再替换，避免半截文件）。"""
        path = self.config.state_file
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = Path(str(path) + '.tmp')
        temp.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding='utf-8')
        temp.replace(path)

    def log(self, message):
        """写一行日志（同时打屏，方便前台联调）。参数 message：文本。"""
        line = f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] {message}'
        print(line, flush=True)
        try:
            self.config.log_file.parent.mkdir(parents=True, exist_ok=True)
            with self.config.log_file.open('a', encoding='utf-8', errors='replace') as handle:
                handle.write(line + '\n')
        except OSError:
            pass
