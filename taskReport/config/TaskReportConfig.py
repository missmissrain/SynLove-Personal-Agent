"""任务汇报的配置读取：开关、模型、轮询节奏、状态文件位置。

职责：
- 开关存在微信状态库的 meta 表（`report.codex` / `report.opencode`，值 `1`/`0`），
  与控制在控制台上点的那个开关是同一份数据，改完下一轮扫描就生效，不需要重启；
- 模型取 `config/modelConfig.json` 的默认对话模型（baseURL + model + apiKeyEnv），
  密钥取 `config/secrets.json` 的 `providers.<provider>.apiKey`，不读环境变量里的残留值；
- 运行参数可用环境变量覆盖：`DSH_TASK_REPORT_POLL_MS`、`DSH_TASK_REPORT_FRESH_MINUTES`。

注册参数（构造）：
    root 生产根目录；默认按本文件位置向上推三级（taskReport/config -> 根）
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path


class TaskReportConfig:
    """任务汇报的全部配置来源。"""

    def __init__(self, root=None):
        """root：生产根目录；不传则按文件位置推断。"""
        self.root = Path(root) if root else Path(__file__).resolve().parents[2]
        self.state_db = self.root / 'runtime' / 'dsh' / 'weixin-state.db'
        self.toggle_path = self.root / 'config' / 'taskReport.json'
        self.state_file = self.root / 'runtime' / 'task-report-state.json'
        self.log_file = self.root / 'runtime' / 'task-report.log'
        self.model_config_path = self.root / 'config' / 'modelConfig.json'
        self.secrets_path = self.root / 'config' / 'secrets.json'

    def is_enabled(self, source):
        """该来源的完成汇报是否开启。参数 source：`codex` 或 `opencode`。

        开关放在 config/taskReport.json，而不是状态库 meta：harness 会整表刷新 meta，
        不认识的键会被它冲掉（实测打开后几分钟又变回 0）。
        """
        data = self._toggles()
        return data.get(source) is True

    def _toggles(self):
        """读开关文件；不存在或坏掉时按"全关"处理。"""
        if not self.toggle_path.is_file():
            return {}
        try:
            data = json.loads(self.toggle_path.read_text(encoding='utf-8-sig'))
        except (json.JSONDecodeError, OSError):
            return {}
        return data if isinstance(data, dict) else {}

    def bridge_window(self):
        """微信桥的运行窗口（毫秒）；落在窗口里的 opencode 会话已由桥自己汇报过。"""
        raw = self._meta('oc_bridge_window')
        if not raw:
            return None
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        if not isinstance(data, dict):
            return None
        return {'start': float(data.get('start') or 0), 'end': float(data.get('end') or 0)}

    def model_target(self):
        """返回润色用的模型配置：base_url / model / api_key / timeout。"""
        config = json.loads(self.model_config_path.read_text(encoding='utf-8-sig'))
        default = config.get('defaultModel') or {}
        provider_id = default.get('provider') or ''
        provider = (config.get('providers') or {}).get(provider_id) or {}
        base_url = str(provider.get('baseURL') or '').rstrip('/')
        model = str(default.get('model') or '')
        api_key = self._api_key(provider_id)
        if not base_url or not model:
            raise RuntimeError('modelConfig.json 里取不到默认模型的 baseURL/model')
        if not api_key:
            raise RuntimeError(f'secrets.json 里没有 providers.{provider_id}.apiKey')
        return {
            'base_url': base_url,
            'model': model,
            'api_key': api_key,
            'timeout': int(provider.get('timeoutSeconds') or 60),
        }

    def poll_seconds(self):
        """轮询间隔（秒），默认 15；可用 DSH_TASK_REPORT_POLL_MS 覆盖。"""
        try:
            return max(5.0, float(os.environ.get('DSH_TASK_REPORT_POLL_MS', '15000')) / 1000.0)
        except ValueError:
            return 15.0

    def fresh_minutes(self):
        """只汇报这么多分钟内完成的任务（防止停机后补推一堆旧任务），默认 120。"""
        try:
            return max(1.0, float(os.environ.get('DSH_TASK_REPORT_FRESH_MINUTES', '120')))
        except ValueError:
            return 120.0

    def _meta(self, key):
        """读状态库 meta 表的单个键；库不存在或没这张表时返回 None。参数 key：键名。"""
        if not self.state_db.is_file():
            return None
        try:
            conn = sqlite3.connect(f'file:{self.state_db}?mode=ro', uri=True, timeout=3)
        except sqlite3.Error:
            return None
        try:
            row = conn.execute('SELECT value FROM meta WHERE key = ?', (key,)).fetchone()
            return None if row is None else row[0]
        except sqlite3.Error:
            return None
        finally:
            conn.close()

    def _api_key(self, provider_id):
        """从 secrets.json 取密钥。参数 provider_id：模型提供方 id。"""
        if not self.secrets_path.is_file():
            return ''
        try:
            data = json.loads(self.secrets_path.read_text(encoding='utf-8-sig'))
        except (json.JSONDecodeError, OSError):
            return ''
        provider = (data.get('providers') or {}).get(provider_id) or {}
        return str(provider.get('apiKey') or '').strip()
