"""完成汇报的入口：codex / opencode 一结束，润色成人话推 QQ。

用法：
    python taskReport/runTaskReport.py --once        # 只扫一轮（联调/排查用）
    python taskReport/runTaskReport.py --once --dry-run   # 扫一轮但不真发
    python taskReport/runTaskReport.py --loop        # 常驻（start_stack 自动拉起）

参数：
    --once      扫一轮就退出
    --loop      按间隔一直扫（默认行为）
    --dry-run   只写日志不推送
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except AttributeError:
    pass

from taskReport.runtime.TaskReportWatcher import TaskReportWatcher


def main():
    """解析参数并跑起来。参数：无（见文件头）。"""
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--loop', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    watcher = TaskReportWatcher(ROOT, dry_run=args.dry_run)
    if args.once:
        handled = watcher.poll_once()
        print(f'本轮处理 {handled} 条', flush=True)
        return 0
    watcher.run_forever()
    return 0


if __name__ == '__main__':
    sys.exit(main())
