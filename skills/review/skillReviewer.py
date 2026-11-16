"""技能沉淀器：对一个时间窗口的对话跑一次"临时 agent loop"，产出一组技能。

职责：
- 拼 Hermes 风格的沉淀提示词（技能定义 / 不要沉淀的清单 / 固定格式）；
- 让模型在受限工具集（list/read/save/finish）里循环，直到 finish 或达到迭代上限；
- 返回本次新增/暂存/跳过的结果；
- 云端模型不可用时降级为单轮（Gemma），只尝试提炼一个技能。

注册参数（构造）：
    config     skillReviewConfig 实例
    store      skillStore 实例
    llm        llmClient 实例
"""

import json
from pathlib import Path

class skillReviewer:
    """一次复盘 = 一段对话素材 + 一个临时工具循环。"""

    def __init__(self, config, store, llm):
        """config：配置；store：技能仓库；llm：模型客户端。"""
        self.config = config
        self.store = store
        self.llm = llm
        self.max_skills = int(config.get("maxSkillsPerRun", 3))
        self.max_iterations = int(config.get("maxIterations", 8))

    def review(self, transcript, dry_run=False):
        """对一段素材跑复盘，返回 {saved, staged, summary, fallback, error}。"""
        from .reviewTools import reviewTools

        turns = int((transcript or {}).get("turns") or 0)
        min_turns = int(self.config.get("minTurns", 4))
        if not transcript.get("text"):
            return {"saved": [], "staged": [], "summary": "没有新素材", "finished": True}
        if turns < min_turns and not transcript.get("evidence") and not transcript.get("truncated"):
            return {"saved": [], "staged": [], "summary": f"对话太少（{turns} 轮），跳过", "skipped": True}

        tools = reviewTools(self.store, transcript, self.max_skills)
        if dry_run:
            tools.store = _dry_store(self.store)

        system = (Path(__file__).resolve().parents[2] / "prompts/SkillReview.md").read_text(encoding="utf-8")
        system = system.replace("每次最多保存 N 个技能", f"每次最多保存 {self.max_skills} 个技能")
        user = (
            "下面是这段时间的对话（含工具调用摘要）。请按工作方式执行，最后必须调用 finish。\n\n"
            "【对话】\n" + (transcript.get("text") or "")
        )
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]

        fallback_used = False
        error = ""
        for _ in range(self.max_iterations):
            try:
                response = self.llm.chat(messages, tools.definitions())
            except Exception as exc:  # 主备都失败
                error = f"{type(exc).__name__}: {exc}"
                break
            message = response.get("message") or {}
            fallback_used = fallback_used or bool(response.get("fallback"))
            tools.force_stage = fallback_used
            tool_calls = message.get("tool_calls") or []
            if tool_calls and not response.get("fallback"):
                messages.append({
                    "role": "assistant",
                    "content": message.get("content") or "",
                    "tool_calls": tool_calls,
                })
                done = False
                for call in tool_calls:
                    fn = call.get("function") or {}
                    result, finished = tools.call(fn.get("name"), fn.get("arguments"))
                    messages.append({"role": "tool", "tool_call_id": call.get("id"), "content": result})
                    done = done or finished
                    if len(tools.saved) + len(tools.staged) >= self.max_skills:
                        tools.finished = True
                        done = True
                        break
                if done:
                    break
                continue

            # 没有工具调用（或降级模型）：按"单轮输出"处理
            content = (message.get("content") or "").strip()
            tools.finished = self._handle_single_shot(tools, content)
            if not tools.finished:
                error = "复盘未返回有效技能或明确结束标记，保留处理游标"
            break

        result = tools.result()
        result["execution"] = getattr(self.llm, "last_execution", None)
        result["fallback"] = fallback_used
        result["summary"] = (result.get("summary") or "") if isinstance(result.get("summary"), str) else ""
        if error:
            result["error"] = error
        elif not tools.finished and not result.get("error"):
            result["error"] = "复盘达到迭代上限但未完成，保留处理游标"
        if result["finished"] and not result["summary"]:
            result["summary"] = f"新增 {len(result['saved'])} 个，待审 {len(result['staged'])} 个"
        return result

    def _handle_single_shot(self, tools, content):
        """降级/单轮输出：若内容是完整 SKILL.md 就尝试保存一个技能。"""
        if not content or content.lower().startswith("nothing to save"):
            return bool(content)
        text = content
        if text.startswith("```"):
            lines = text.splitlines()
            if lines and lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines).strip()
        if not text.startswith("---"):
            return False
        name = _frontmatter_name(text)
        if not name:
            return False
        result, _ = tools.call("save_skill", {"name": name, "content": text, "reason": "fallback 单轮提炼"})
        return json.loads(result).get("ok") is True


def _frontmatter_name(content):
    """从 frontmatter 里取 name（极简解析）。"""
    lines = content.splitlines()
    if not lines or not lines[0].startswith("---"):
        return ""
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if line.startswith("name:"):
            return line.split(":", 1)[1].strip().strip("'\"")
    return ""


class _dry_store:
    """dry-run 用的空仓库：只校验，不落盘。"""

    def __init__(self, real):
        """包一层真实仓库（复用校验逻辑）。"""
        self.real = real

    def list_skills(self):
        """列出真实技能（只读）。"""
        return self.real.list_skills()

    def read_skill(self, name):
        """读真实技能（只读）。"""
        return self.real.read_skill(name)

    def save(self, name, content, reason=""):
        """只校验，不写盘。"""
        ok, error = self.real.validate(name, content)
        if not ok:
            return {"action": "skipped", "error": error}
        return {"action": "created", "path": "(dry-run)"}

    def stage_candidate(self, name, content, reason=""):
        """name、content、reason 为待审候选；仅做格式验证，不写入任何目录。"""
        ok, error = self.real.validate(name, content)
        return ({"action": "staged", "pending": "(dry-run)"} if ok
                else {"action": "skipped", "error": error})
