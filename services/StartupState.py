"""启动事务状态。StartupState(root)记录启动时的停止标记；默认不覆盖启动期间的新停止意图。"""

import json
import time
from pathlib import Path


class StartupState:
    """使用标记快照避免新收到的停机指令被旧启动流程清除。"""

    def __init__(self, root):
        """root为工程目录；读取旧停止标记并记录单调时钟起点。"""
        self.root = Path(root)
        self.path = self.root / "runtime" / "guardian.pause"
        self.before = self.path.read_bytes() if self.path.exists() else None
        self.started = time.monotonic()

    def was_stopped(self):
        """无参数；启动中产生不同停止标记则取消本次启动。"""
        return self.path.exists() and self.path.read_bytes() != self.before

    def complete_start(self):
        """无参数；只消费启动前的旧暂停，不删除新停机标记。"""
        if self.before is not None and self.path.exists() and self.path.read_bytes() == self.before:
            self.path.unlink()

    def record_stage(self, stage):
        """stage为不含敏感值的阶段名；追加耗时证据，不写模型配置或凭据。"""
        target = self.root / "runtime" / "startup-events.jsonl"
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as output:
            output.write(json.dumps({"at": time.strftime("%Y-%m-%d %H:%M:%S"),
                                     "stage": stage, "elapsedSeconds": round(time.monotonic() - self.started, 3)},
                                    ensure_ascii=False) + "\n")
