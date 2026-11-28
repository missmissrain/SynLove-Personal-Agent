"""技能证据门槛：检查候选是否引用本轮真实工具回执；不把格式正确当成事实正确。

参数 transcript 为复盘素材；require_evidence 默认 True。缺少依据或模型降级时仅暂存，
不自动挂载；本门槛不能替代人工语义审查，也不会执行技能中的命令。
"""
import re


class SkillQualityGate:
    """为自动入库提供可核验的最低证据要求。"""

    def __init__(self, transcript, require_evidence=True):
        """transcript 含 evidence 工具回执列表；require_evidence 控制是否要求原文引用。"""
        self.evidence = [row for row in (transcript or {}).get("evidence", [])
                         if isinstance(row, str) and row.startswith("status=returned ")
                         and not re.search(r'"(?:ok|success)"\s*:\s*false|"exitCode"\s*:\s*-[1-9]|"exitCode"\s*:\s*[1-9]', row)]
        self.required = bool(require_evidence)

    def review_content(self, content, fallback=False):
        """content 为完整技能正文；fallback 表示使用降级模型；返回需要暂存审查的原因。"""
        issues = []
        if fallback:
            issues.append("降级模型生成，需核对接口和事实")
        if self.required:
            match = re.search(r"(?m)^## 依据\s*\n([\s\S]*?)(?=^## |\Z)", content)
            quotes = re.findall(r"(?m)^>\s*(.{16,})$", match.group(1)) if match else []
            if not any(quote.strip() in row for quote in quotes for row in self.evidence):
                issues.append("未引用本轮真实工具回执，不能自动确认操作已跑通")
        return issues
