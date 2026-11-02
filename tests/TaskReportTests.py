"""完成汇报隔离回归：用临时SQLite和假发送器验证新版终态、去重、失败及收件话术。

运行参数：python -m unittest discover -s tests -p TaskReportTests.py -v；不访问真实模型或消息平台。
"""

import json
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from taskReport.model.TaskReport import TaskReport
from taskReport.polish.NoticeText import NoticeText
from taskReport.polish.ReportPolisher import ReportPolisher
from taskReport.push.QqReporter import QqReporter
from taskReport.runtime.TaskReportWatcher import TaskReportWatcher
from taskReport.sources.OpencodeSource import OpencodeSource
from microServices.ScheduleStore import ScheduleStore
from microServices.ServiceLease import ServiceLease
from taskReport import runTaskReport


class TaskReportTests(unittest.TestCase):
    """每个用例独占临时数据库；测试数据不写入生产目录。"""

    def setUp(self):
        """无参数；创建真实格式的v2表和独立测试会话。"""
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'opencode.db'
        self.now = int(time.time() * 1000) - 30000
        with sqlite3.connect(self.path) as conn:
            conn.executescript(
                'CREATE TABLE session_v2(id TEXT,directory TEXT,title TEXT,time_updated INTEGER,'
                'time_archived INTEGER,parent_id TEXT);'
                'CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,'
                'time_created INTEGER,data TEXT);')
            conn.execute('INSERT INTO session_v2 VALUES(?,?,?,?,NULL,NULL)',
                         ('ses_test', str(self.root), '测试任务', self.now))
        self.source = OpencodeSource(self.root)

    def add_message(self, seq, kind, data):
        """seq/kind/data 为事件序号、种类及JSON内容；写入隔离的OpenCode事件。"""
        with sqlite3.connect(self.path) as conn:
            conn.execute('INSERT INTO session_message VALUES(?,?,?,?,?,?)',
                         ('message_' + str(seq), 'ses_test', kind, seq, self.now,
                          json.dumps(data, ensure_ascii=False)))

    def complete_turn(self, start=1, outcome='succeeded'):
        """start 为起始序号，outcome 为终态；生成包含工具、推理和最终回复的一轮。"""
        self.add_message(start, 'user', {'text': '修复消息队列'})
        self.add_message(start + 1, 'assistant', {
            'finish': 'tool-calls', 'time': {'completed': self.now},
            'content': [{'type': 'text', 'text': '正在处理，不是最终结果'}]})
        self.add_message(start + 2, 'assistant', {
            'finish': 'stop', 'time': {'completed': self.now},
            'content': [{'type': 'reasoning', 'text': '不应外发'},
                        {'type': 'text', 'text': '修复完成，隔离测试通过。'}]})
        self.add_message(start + 3, 'idle', {'outcome': outcome})

    def make_watcher(self):
        """无参数；构造使用假模型、假QQ和独立状态目录的汇报器。"""
        watcher = TaskReportWatcher(self.root)
        watcher.opencode = self.source
        watcher.config.is_enabled = Mock(return_value=True)
        watcher.config.bridge_window = Mock(return_value=None)
        watcher.reporter = Mock()
        watcher.log = Mock()
        watcher._polish = Mock(return_value=('任务修好了。能收到消息吗？', True, ''))
        watcher.state['seeded'] = True
        return watcher

    def test_v2_final_and_stable_fingerprint(self):
        """v2只提取最终正文，浏览会话更新元数据不产生第二条汇报。"""
        self.complete_turn()
        report, = self.source.poll()
        self.assertEqual(report.result, '修复完成，隔离测试通过。')
        self.assertEqual(report.status, '已完成')
        with sqlite3.connect(self.path) as conn:
            conn.execute('UPDATE session_v2 SET time_updated=?', (self.now + 20000,))
        self.assertEqual(self.source.poll()[0].fingerprint, report.fingerprint)

    def test_v2_new_user_invalidates_old_idle(self):
        """旧回合已完成但用户又发了新任务时，不能复用旧最终回复。"""
        self.complete_turn()
        self.add_message(5, 'user', {'text': '继续处理'})
        self.assertEqual(self.source.poll(), [])

    def test_v2_tool_pause_is_not_completion(self):
        """工具调用暂时无输出、没有最终回复或idle时都不能报完成。"""
        self.add_message(1, 'user', {'text': '运行工具'})
        self.add_message(2, 'assistant', {
            'finish': 'tool-calls', 'time': {'completed': self.now},
            'content': [{'type': 'text', 'text': '稍等'}]})
        self.assertEqual(self.source.poll(), [])
        self.add_message(3, 'idle', {'outcome': 'succeeded'})
        self.assertEqual(self.source.poll(), [])

    def test_v2_failed_without_final(self):
        """明确失败且没有最终回复时，必须报告失败，不能伪称成功。"""
        self.add_message(1, 'user', {'text': '处理任务'})
        self.add_message(2, 'idle', {'outcome': 'failed'})
        report, = self.source.poll()
        self.assertEqual(report.status, '已失败')
        self.assertIn('未产生最终回复', report.result)

    def test_v2_cancelled(self):
        """取消任务的终态与成功终态分开。"""
        self.complete_turn(outcome='cancelled')
        self.assertEqual(self.source.poll()[0].status, '已中止')

    def test_v2_upgrade_baseline_and_next_turn(self):
        """升级首次不重放历史，下一轮新完成推一次，重复轮询不重发。"""
        self.complete_turn()
        watcher = self.make_watcher()
        reports = watcher._opencode_reports()
        self.assertFalse(watcher._handle(reports[0]))
        self.complete_turn(start=5)
        report, = watcher._opencode_reports()
        self.assertTrue(watcher._handle(report))
        self.assertFalse(watcher._handle(report))
        watcher.reporter.send_chunks.assert_called_once()
        self.assertNotIn('能收到', watcher.reporter.send_chunks.call_args[0][0])

    def test_legacy_requires_final_message(self):
        """旧版格式继续兼容，但只有最终状态明确且最新消息为助手时才报告。"""
        with sqlite3.connect(self.path) as conn:
            conn.executescript(
                'DROP TABLE session_v2; DROP TABLE session_message;'
                'CREATE TABLE session(id TEXT,directory TEXT,title TEXT,time_updated INTEGER,time_archived INTEGER);'
                'CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);'
                'CREATE TABLE part(message_id TEXT,session_id TEXT,data TEXT);')
            conn.execute('INSERT INTO session VALUES(?,?,?,?,NULL)',
                         ('legacy', str(self.root), '旧任务', self.now))
            conn.execute('INSERT INTO message VALUES(?,?,?,?)', ('a', 'legacy', self.now, json.dumps({
                'role': 'assistant', 'finish': 'stop', 'time': {'completed': self.now}})))
            conn.execute('INSERT INTO part VALUES(?,?,?)',
                         ('a', 'legacy', json.dumps({'type': 'text', 'text': '旧版完成'})))
        self.assertEqual(self.source.poll()[0].result, '旧版完成')
        with sqlite3.connect(self.path) as conn:
            conn.execute('INSERT INTO message VALUES(?,?,?,?)',
                         ('u', 'legacy', self.now + 1, json.dumps({'role': 'user'})))
        self.assertEqual(self.source.poll(), [])

    def test_qq_rejection_is_failure(self):
        """QQ接口返回ok=false而未抛错时也必须判失败。"""
        sender = QqReporter(self.root)
        with patch.object(sender, 'send', return_value={'ok': False}):
            with self.assertRaises(RuntimeError):
                sender.send_chunks('任务完成')

    def test_retries_bounded_per_completion(self):
        """同一终态最多三次失败；同一会话新任务有独立重试预算。"""
        self.complete_turn()
        report, = self.source.poll()
        watcher = self.make_watcher()
        watcher.reporter.send_chunks.side_effect = RuntimeError('模拟发送失败')
        for _ in range(5):
            self.assertFalse(watcher._handle(report))
        self.assertEqual(watcher.reporter.send_chunks.call_count, 3)
        report.fingerprint += '_next'
        watcher._handle(report)
        self.assertEqual(watcher.reporter.send_chunks.call_count, 4)

    def test_probe_questions_removed_but_decisions_kept(self):
        """去掉收件测试问句，保留真正需要用户选择的问题。"""
        self.assertEqual(NoticeText.clean('任务完成。你那边 QQ 收到结果消息了吗？'), '任务完成。')
        self.assertEqual(NoticeText.clean('能收到消息吗？'), '')
        self.assertEqual(NoticeText.clean('需要删除旧文件吗？'), '需要删除旧文件吗？')
        polisher = ReportPolisher({})
        with patch.object(polisher, '_chat', return_value='修好了。能收到消息吗？'):
            report = TaskReport('opencode', 's', 'f', 'p', 't', '已完成', '修复完成。', time.time())
            self.assertEqual(polisher.polish(report)[0], '修好了。')

    def test_dry_run_never_calls_model_or_sender(self):
        """dry-run必须零模型和平台请求，并且不把任务记成已经送达。"""
        self.complete_turn()
        report, = self.source.poll()
        watcher = self.make_watcher()
        watcher.dry_run = True
        self.assertTrue(watcher._handle(report))
        watcher._polish.assert_not_called()
        watcher.reporter.send_chunks.assert_not_called()
        self.assertNotIn(report.task_id, watcher.state['opencode'])
        watcher._save_state()
        self.assertFalse(watcher.config.state_file.exists())

    def test_second_sender_cannot_start(self):
        """已有发送者占有锁时，第二入口直接退出，不读取会话或发送通知。"""
        lease = ServiceLease(self.root / 'runtime' / 'task-report.lock').acquire()
        try:
            with patch.object(runTaskReport, 'ROOT', self.root), \
                    patch.object(sys, 'argv', ['runTaskReport', '--once']), \
                    patch.object(runTaskReport, 'TaskReportWatcher') as factory:
                self.assertEqual(runTaskReport.main(), 0)
                factory.assert_not_called()
        finally:
            lease.close()

    def test_news_enable_preserves_today_claim(self):
        """新闻时间设为08:55并开启后持久生效，不重发已经领取过的当天摘要。"""
        store = ScheduleStore(self.root)
        store.confirm_enqueued('digest-schedule-' + time.strftime('%Y-%m-%d'))
        result = json.loads(store.configure({'action': 'set', 'time': '08:55', 'enabled': True}, None))
        self.assertTrue(result['enabled'])
        self.assertEqual(result['time'], '08:55')
        self.assertIsNone(store.claim_due())
        result = json.loads(ScheduleStore(self.root).configure({'action': 'get'}, None))
        self.assertTrue(result['enabled'])
        self.assertEqual(result['time'], '08:55')


if __name__ == '__main__':
    unittest.main()
