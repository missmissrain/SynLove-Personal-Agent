"""技能提炼Codex适配器：独立会话只返回中文技能正文，不允许Codex直接写入生效目录。

参数root为主仓库、store为技能仓库；执行设备复用自迭代配置，默认天选离线才兜底服务器。
"""
import json
from pathlib import Path

from maintenance.CodexDispatcher import CodexDispatcher


class CodexReviewClient:
    """让原有技能质量门槛与存储流程继续负责校验、暂存和入库。"""

    def __init__(self, root, store):
        """root为生产根目录，store只读提供已有技能索引，避免重复造技能。"""
        self.root, self.store = Path(root), store

    def chat(self, messages, tools=None):
        """messages为已脱敏素材；tools仅为兼容旧接口，不执行远端写技能工具。"""
        config = json.loads((self.root / "config/nightlyMaintenance.json").read_text(encoding="utf-8-sig"))
        if not config.get("skillEnabled", True):
            raise RuntimeError("GUI已关闭Codex技能沉淀")
        prompt = (self.root / "prompts/CodexSkillReview.md").read_text(encoding="utf-8")
        prompt += "\n已有技能索引：\n" + json.dumps(self.store.list_skills(), ensure_ascii=False)[:3500]
        prompt += "\n素材与要求：\n" + "\n".join(str(m.get("content", "")) for m in messages)[:22000]
        prompt += "\n最终输出规则：忽略上面旧格式里关于调用工具与finish的要求；本轮不能调用工具，只返回一个完整SKILL.md或Nothing to save。"
        result = CodexDispatcher(self.root, config.get("execution", {})).execute_task(prompt)
        self.last_execution = {"engine": "codex", "device": result["device"], "jobId": result["jobId"]}
        return {"message": {"content": result["text"]}, "fallback": False,
                "provider": "codex", "device": result["device"]}
