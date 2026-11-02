"""技能复盘配置加载器。

职责：
- 读取 `skills/config/skillReview.json`，补默认值、展开 ~ 与相对路径；
- 校验关键字段（模型端点、模型名、技能目录），缺了就明确报错而不是静默跑空。

注册参数：无。构造时传入项目根目录即可。
"""

import json
import os
from pathlib import Path


class skillReviewConfig:
    """技能复盘配置（字典的只读封装）。"""

    DEFAULTS = {
        "enabled": True,
        "intervalHours": 6,
        "firstRunLookbackHours": 24,
        "skillsDir": "runtime/dsh/skills",
        "stateFile": "runtime/skill-review-state.json",
        "logFile": "runtime/skill-review.log",
        "lockFile": "runtime/skill-review.lock",
        "heartbeatFile": "runtime/skill-review-heartbeat.json",
        "scheduleHour": 3,
        "catchUpGraceMinutes": 10,
        "retryCooldownMinutes": 30,
        "lockStaleSeconds": 21600,
        "model": {
            "provider": "qwen",
            "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "model": "qwen3.8-flash",
            "apiKeyEnv": "DASHSCOPE_API_KEY",
            "timeoutSeconds": 180,
        },
        "fallback": {
            "provider": "gemma",
            "baseUrl": "http://127.0.0.1:8080/v1",
            "model": "gemma-4-E4B-it-Q4_K_M",
            "timeoutSeconds": 300,
        },
        "maxIterations": 8,
        "maxSkillsPerRun": 3,
        "minTurns": 4,
        "transcriptChars": 14000,
        "notifyQQ": True,
        "autoCreate": True,
        "stageUpdates": True,
    }

    def __init__(self, root, path=None):
        """root：项目根目录；path：可选的自定义配置文件。"""
        self.root = Path(root).resolve()
        self.path = Path(path) if path is not None else self.root / "skills" / "config" / "skillReview.json"
        self.data = self._load()

    def _load(self):
        """读配置并与默认值合并，最后展开路径。"""
        raw = {}
        if self.path.is_file():
            raw = json.loads(self.path.read_text(encoding="utf-8-sig"))
        merged = _deep_merge(self.DEFAULTS, raw)
        folder = Path(os.path.expanduser(merged["skillsDir"]))
        if raw.get("skillsDir") in (None, "~/.dsh/skills"):
            folder = Path(os.environ.get("DSH_HOME") or self.root / "runtime/dsh") / "skills"
        merged["skillsDir"] = str((folder if folder.is_absolute() else self.root / folder).resolve())
        merged["stateFile"] = str((self.root / merged["stateFile"]).resolve())
        merged["logFile"] = str((self.root / merged["logFile"]).resolve())
        merged["lockFile"] = str((self.root / merged["lockFile"]).resolve())
        merged["heartbeatFile"] = str((self.root / merged["heartbeatFile"]).resolve())
        self._validate(merged)
        return merged

    @staticmethod
    def _validate(data):
        """关键字段缺失时直接报错（宁可启动失败，也不静默跑空）。"""
        model = data.get("model") or {}
        if not model.get("baseUrl") or not model.get("model"):
            raise ValueError("skillReview.json: model.baseUrl / model.model 不能为空")
        if not data.get("skillsDir"):
            raise ValueError("skillReview.json: skillsDir 不能为空")
        if int(data.get("maxSkillsPerRun", 0)) <= 0:
            raise ValueError("skillReview.json: maxSkillsPerRun 必须大于 0")

    def get(self, key, default=None):
        """取一个配置项。"""
        return self.data.get(key, default)

    def section(self, key):
        """取一个子配置（dict）。"""
        return self.data.get(key) or {}


def _deep_merge(base, override):
    """递归合并字典（override 优先）。"""
    out = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out
