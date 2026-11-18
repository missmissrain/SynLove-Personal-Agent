"""运行监测摘要：把 llm-probe 与 weixin-probe 里的模型、工具、通知数据压缩成一段中文摘要。

职责：
- 统计回看窗口内各模型的请求次数、错误类型、模型切换次数；
- 统计工具调用次数（按工具名排序），以及任务通知的延迟/失败次数；
- 输出一段可直接拼进提示词的文本（不超过约 1200 字）。

注册参数：
- root：项目根目录（默认按本文件位置推断）；
- hours：回看小时数，默认 72。
"""

from __future__ import annotations

import collections
import json
import re
from datetime import datetime, timezone
from pathlib import Path


def parse_at(value: str) -> float | None:
    """把 ISO8601 时间（带 Z）转成 epoch 秒；无法解析返回 None。"""
    if not value:
        return None
    try:
        text = value.replace("Z", "+00:00")
        return datetime.fromisoformat(text).astimezone(timezone.utc).timestamp()
    except ValueError:
        return None


class RuntimeTelemetry:
    """读取探针日志并生成运行监测摘要。"""

    def __init__(self, root: str | Path, hours: int = 72) -> None:
        """root 为项目根目录；hours 为回看小时数。"""
        self.root = Path(root)
        self.hours = max(1, int(hours))

    def _lines(self, path: Path):
        """逐行读取探针日志，文件不存在或过大时跳过。"""
        if not path.is_file() or path.stat().st_size > 400 * 1024 * 1024:
            return
        with path.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                at = parse_at(str(obj.get("at") or ""))
                if at is None or at < self.cutoff:
                    continue
                yield obj

    def build(self) -> str:
        """生成摘要文本；没有任何数据时返回空字符串。"""
        self.cutoff = datetime.now(timezone.utc).timestamp() - self.hours * 3600
        models = collections.Counter()
        errors = collections.Counter()
        tools = collections.Counter()
        switches = 0
        notices = collections.Counter()

        for obj in self._lines(self.root / "runtime" / "llm-probe.log"):
            if obj.get("kind") == "request":
                model = str(obj.get("model") or "unknown")
                models[model] += 1
            elif obj.get("kind") == "event":
                if obj.get("type") == "error":
                    detail = str(obj.get("error") or "").lower()
                    if "overload" in detail or "429" in detail or "rate limit" in detail:
                        errors["过载/限流"] += 1
                    elif "context overflow" in detail or "too long" in detail:
                        errors["上下文超限"] += 1
                    elif "unauthorized" in detail or "401" in detail or "403" in detail:
                        errors["鉴权失败"] += 1
                    elif "timeout" in detail or "timed out" in detail:
                        errors["超时"] += 1
                    else:
                        errors["其他"] += 1
                elif obj.get("type") == "toolcall_end":
                    detail = obj.get("detail")
                    name = ""
                    if isinstance(detail, str):
                        match = re.search(r'"toolCall"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]+)"', detail)
                        if match:
                            name = match.group(1)
                    elif isinstance(detail, dict):
                        name = str((detail.get("toolCall") or {}).get("name") or "")
                    tools[name or "unknown"] += 1

        for obj in self._lines(self.root / "runtime" / "weixin-probe.log"):
            scope = str(obj.get("scope") or "")
            event = str(obj.get("event") or "")
            if scope == "failover" and event in ("model.switched", "model.dead", "model.restored"):
                if event == "model.switched":
                    switches += 1
            elif scope == "agent-task" and event in ("notice.deferred", "notice.delivery_deferred"):
                task_id = str((obj.get("data") or {}).get("taskId") or "")
                notices[task_id or "unknown"] += 1
            elif scope == "inbound" and event == "agent.error":
                errors["代理错误"] += 1

        if not models and not errors and not tools:
            return ""

        total_models = sum(models.values())
        parts = [f"运行监测（近 {self.hours} 小时）："]
        parts.append(
            "- 模型请求 %d 次：%s" % (
                total_models,
                "、".join("%s %d" % (name, count) for name, count in models.most_common(4)) or "无",
            )
        )
        if errors:
            parts.append(
                "- 模型/代理错误 %d 次：%s" % (
                    sum(errors.values()),
                    "、".join("%s %d" % (name, count) for name, count in errors.most_common(5)),
                )
            )
        if switches:
            parts.append(f"- 模型自动切换 {switches} 次")
        if tools:
            parts.append(
                "- 工具调用 %d 次，最多：%s" % (
                    sum(tools.values()),
                    "、".join("%s %d" % (name, count) for name, count in tools.most_common(5)),
                )
            )
        if notices:
            parts.append("- 任务通知异常涉及 %d 个任务" % len(notices))
        parts.append("（据此优先复盘：反复失败的工具调用、频繁切换的模型、通知与上下文相关故障。）")
        return "\n".join(parts)
