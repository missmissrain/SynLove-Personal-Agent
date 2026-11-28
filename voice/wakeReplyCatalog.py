"""功能：读取默认唤醒应答池，为不同设备轮换选择且避免连续重复。

注册参数path默认prompts/WakeReplies.json，pool_path默认运行时唤醒池清单；
最多10句，每句30字以内，仅允许既有情绪代码。默认记录最近128台设备的
轮换队列，不推测用户心情、不调用模型或播放器。
"""
import json
import os
import random
import threading
from collections import OrderedDict
from pathlib import Path
from voice.ttsPrompt import TtsPrompt


class WakeReplyCatalog:
    """管理预定义应答及每设备独立的无重复轮换。"""

    def __init__(self, path=None, pool_path=None):
        """path为基础应答清单，pool_path为每日轮换池清单；启动时校验，失败明确报错。"""
        self.path = Path(path or Path(__file__).resolve().parents[1] / "prompts/WakeReplies.json")
        default_pool = Path(__file__).resolve().parents[1] / "runtime/voiceDeployment/wakeReplies/WakeReplyPool.json"
        self.pool_path = Path(pool_path or os.environ.get("SYNLOVE_WAKE_REPLY_POOL") or default_pool)
        rows = self._read_rows()
        if not isinstance(rows, list) or not 1 <= len(rows) <= 10:
            raise ValueError("唤醒应答池必须包含1至10句")
        ids, pairs = set(), set()
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("唤醒应答必须为对象")
            ident, text, mood = row.get("id"), row.get("text"), row.get("emotion")
            if (not isinstance(ident, str) or not ident or ident in ids
                    or not isinstance(text, str) or not 1 <= len(text.strip()) <= 30
                    or text != text.strip() or not isinstance(mood, str) or mood not in TtsPrompt.EMOTIONS
                    or (text, mood) in pairs):
                raise ValueError("唤醒应答标识、正文或情绪不合法")
            ids.add(ident)
            pairs.add((text, mood))
        self.rows = tuple(dict(row) for row in rows)
        self.pairs = pairs
        self.devices = OrderedDict()
        self.lock = threading.Lock()
        self.random = random.SystemRandom()

    def _read_rows(self):
        """无参数；优先读取每日轮换池，池不存在或为空时回退到基础提示词文件。"""
        candidates = [self.pool_path, self.path]
        for candidate in candidates:
            try:
                data = json.loads(candidate.read_text("utf-8-sig"))
                rows = data.get("replies") if isinstance(data, dict) else None
                if isinstance(rows, list) and rows:
                    return rows
            except (OSError, ValueError):
                continue
        raise ValueError("唤醒应答池或基础清单不可读")

    def list_replies(self):
        """无参数；返回清单副本，供预生成和缓存校验，不向调用方暴露可变内部状态。"""
        return [dict(row) for row in self.rows]

    def allows_reply(self, text, emotion):
        """text/emotion为候选正文与情绪；只允许清单明确登记的组合。"""
        return isinstance(text, str) and isinstance(emotion, str) and (text, emotion) in self.pairs

    def select_reply(self, device):
        """device为收音设备ID；每轮打乱完整清单，边界处也避免与上一句连续重复。"""
        with self.lock:
            key = str(device)
            state = self.devices.pop(key, {"last": None, "pending": []})
            if not state["pending"]:
                rows = self.list_replies()
                self.random.shuffle(rows)
                if len(rows) > 1 and rows[-1]["id"] == state["last"]:
                    rows[0], rows[-1] = rows[-1], rows[0]
                state["pending"] = rows
            row = state["pending"].pop()
            state["last"] = row["id"]
            self.devices[key] = state
            while len(self.devices) > 128:
                self.devices.popitem(last=False)
            return dict(row)
