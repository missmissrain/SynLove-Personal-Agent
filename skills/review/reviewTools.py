"""复盘用的工具集（临时 agent loop 能调用的只读/受限写工具）。

职责：
- 给模型暴露：list_skills / read_skill / read_transcript / save_skill / finish；
- 执行调用，并把结果转成 JSON 字符串；
- 限制单次复盘最多写 max_skills 个技能。

注册参数（构造）：
    store          skillStore 实例
    transcript     完整对话素材（dict：text/turns/...）
    max_skills     单次最多保存几个技能
"""

import json


class reviewTools:
    """复盘 agent 可用的工具。"""

    def __init__(self, store, transcript, max_skills=3):
        """store：技能仓库；transcript：对话素材；max_skills：单次上限。"""
        self.store = store
        self.transcript = transcript or {}
        self.max_skills = int(max_skills)
        self.saved = []
        self.staged = []
        self.finished = False
        self.persist_error = ""

    def definitions(self):
        """OpenAI tools 定义。"""
        return [
            {
                "type": "function",
                "function": {
                    "name": "list_skills",
                    "description": "列出已有技能的名字和一句话描述（写新技能前先看，避免重复造轮子）。",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "read_skill",
                    "description": "读一个已有技能的 SKILL.md 全文（准备更新它之前必须先读）。",
                    "parameters": {
                        "type": "object",
                        "properties": {"name": {"type": "string", "description": "技能名"}},
                        "required": ["name"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "read_transcript",
                    "description": "读对话素材的更多内容（offset 为字符偏移，默认 0）。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "offset": {"type": "integer", "description": "起始字符偏移"},
                            "limit": {"type": "integer", "description": "最多读多少字符，默认 6000"},
                        },
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "save_skill",
                    "description": "保存一个技能（新技能直接落盘；已存在的技能会暂存待人工确认）。content 必须是完整的 SKILL.md（含 frontmatter 与四段正文）。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "kebab-case 技能名"},
                            "content": {"type": "string", "description": "完整 SKILL.md 文本"},
                            "reason": {"type": "string", "description": "一句话说明为什么值得沉淀"},
                        },
                        "required": ["name", "content"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "finish",
                    "description": "结束本次复盘。summary 用一句话说明做了什么。",
                    "parameters": {
                        "type": "object",
                        "properties": {"summary": {"type": "string", "description": "一句话总结"}},
                        "required": ["summary"],
                    },
                },
            },
        ]

    def call(self, name, arguments):
        """执行一个工具调用，返回 (结果字符串, 是否结束)。"""
        args = arguments or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                return json.dumps({"ok": False, "error": "参数不是合法 JSON"}, ensure_ascii=False), False

        if name == "list_skills":
            return json.dumps({"ok": True, "skills": self.store.list_skills()}, ensure_ascii=False), False

        if name == "read_skill":
            skill_name = str(args.get("name") or "").strip()
            content = self.store.read_skill(skill_name)
            if content is None:
                return json.dumps({"ok": False, "error": f"技能不存在：{skill_name}"}, ensure_ascii=False), False
            return json.dumps({"ok": True, "name": skill_name, "content": content}, ensure_ascii=False), False

        if name == "read_transcript":
            text = self.transcript.get("text") or ""
            offset = max(0, int(args.get("offset") or 0))
            limit = max(500, int(args.get("limit") or 6000))
            chunk = text[offset:offset + limit]
            return json.dumps({
                "ok": True, "offset": offset, "total": len(text),
                "content": chunk,
            }, ensure_ascii=False), False

        if name == "save_skill":
            if len(self.saved) + len(self.staged) >= self.max_skills:
                return json.dumps({"ok": False, "error": f"本次最多沉淀 {self.max_skills} 个技能"}, ensure_ascii=False), False
            skill_name = str(args.get("name") or "").strip()
            content = str(args.get("content") or "")
            reason = str(args.get("reason") or "")
            result = self.store.save(skill_name, content, reason)
            if result.get("action") == "skipped":
                if result.get("retryable"):
                    self.persist_error = result.get("error") or "技能持久化失败"
                return json.dumps({"ok": False, "error": result.get("error")}, ensure_ascii=False), False
            if result.get("action") == "staged":
                self.staged.append(skill_name)
            else:
                self.saved.append(skill_name)
            return json.dumps({"ok": True, **result}, ensure_ascii=False), False

        if name == "finish":
            self.finished = True
            return json.dumps({"ok": True, "summary": str(args.get("summary") or "")}, ensure_ascii=False), True

        return json.dumps({"ok": False, "error": f"未知工具：{name}"}, ensure_ascii=False), False

    def result(self):
        """本次复盘的结果汇总。"""
        result = {"saved": list(self.saved), "staged": list(self.staged), "finished": self.finished}
        if self.persist_error:
            result["error"] = self.persist_error
        return result
