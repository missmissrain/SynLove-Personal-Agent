"""技能存储：读写 `~/.dsh/skills/<name>/SKILL.md`，并做固定格式校验。

职责：
- 列出已有技能（name + description）；
- 读某个技能全文；
- 校验新技能是否符合固定格式（frontmatter + 四段正文）；
- 写入：新技能直接落盘，已存在的技能默认**暂存待审**（不自动覆盖）。
- 所有写操作走"临时文件 + 原子替换"，避免半截文件。

注册参数（构造）：
    skills_dir   技能根目录（默认 ~/.dsh/skills）
    auto_create  新技能是否直接写入（默认 True）
    stage_updates 已存在技能是否只暂存待审（默认 True）
"""

import json
import re
import time
from pathlib import Path

from skills.store.durableFile import durableFile

try:
    import yaml
except ImportError:  # 没有 pyyaml 时退化为极简解析（只认本文件需要的字段）
    yaml = None

REQUIRED_SECTIONS = ("## 何时使用", "## 步骤", "## 坑", "## 验证")
NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
FILE_WRITER = durableFile()


class skillStore:
    """技能文件仓库（只做存储与校验，不做模型调用）。"""

    def __init__(self, skills_dir, auto_create=True, stage_updates=True):
        """skills_dir：技能根目录；auto_create/stage_updates 见模块注释。"""
        self.dir = Path(skills_dir)
        self.pending_dir = self.dir / ".pending"
        self.auto_create = bool(auto_create)
        self.stage_updates = bool(stage_updates)

    def ensure_dirs(self):
        """确保目录存在（外部清空后能自愈）。"""
        self.dir.mkdir(parents=True, exist_ok=True)
        self.pending_dir.mkdir(parents=True, exist_ok=True)

    def list_skills(self):
        """返回 [{name, description}]（读不到 frontmatter 的目录会被跳过）。"""
        self.ensure_dirs()
        out = []
        for path in sorted(self.dir.glob("*/SKILL.md")):
            name = path.parent.name
            if name.startswith("."):
                continue
            meta = self._frontmatter(path.read_text(encoding="utf-8", errors="replace"))
            out.append({"name": name, "description": (meta or {}).get("description", "")})
        return out

    def read_skill(self, name):
        """读一个技能全文；不存在返回 None。"""
        if not NAME_PATTERN.fullmatch(name or ""):
            return None
        path = self.dir / name / "SKILL.md"
        if not path.is_file():
            return None
        return path.read_text(encoding="utf-8", errors="replace")

    def validate(self, name, content):
        """校验固定格式。返回 (ok, error)。"""
        if not NAME_PATTERN.match(name or ""):
            return False, f"name 必须是 kebab-case（小写字母/数字/连字符）：{name!r}"
        meta = self._frontmatter(content)
        if meta is None:
            return False, "缺少 YAML frontmatter（文件必须以 --- 开头并以 --- 结束头部）"
        if meta.get("name") != name:
            return False, f"frontmatter.name（{meta.get('name')!r}）与请求的 name（{name!r}）不一致"
        description = str(meta.get("description") or "").strip()
        if not description:
            return False, "frontmatter.description 为空"
        if len(description) > 120:
            return False, f"description 过长（{len(description)} 字，上限 120）"
        if not str(meta.get("version") or "").strip():
            return False, "frontmatter.version 为空"
        hermes = ((meta.get("metadata") or {}).get("hermes") or {})
        if not hermes.get("category"):
            return False, "metadata.hermes.category 为空"
        if not isinstance(hermes.get("tags"), list) or not hermes.get("tags"):
            return False, "metadata.hermes.tags 必须是非空数组"
        body = content.split("---", 2)[-1]
        missing = [section for section in REQUIRED_SECTIONS if section not in body]
        if missing:
            return False, "正文缺少固定段落：" + "、".join(missing)
        if len(body.strip()) < 120:
            return False, "正文太短（少于 120 字），不像一个可用技能"
        return True, ""

    def save(self, name, content, reason=""):
        """保存技能，返回 {action, path, pending}（action: created / staged / skipped）。"""
        ok, error = self.validate(name, content)
        if not ok:
            return {"action": "skipped", "error": error}
        self.ensure_dirs()
        path = self.dir / name / "SKILL.md"
        existed = path.is_file()
        if existed:
            current = path.read_text(encoding="utf-8", errors="replace")
            if current.strip() == content.strip():
                return {"action": "skipped", "error": "内容与现有技能完全相同"}
            if self.stage_updates:
                pending = self._stage(name, content, reason)
                if pending is None:
                    return {"action": "skipped", "error": "待审文件未写入，未确认保存成功", "retryable": True}
                return {"action": "staged", "path": str(path), "pending": str(pending)}
        if not path.is_file() and not self.auto_create:
            return {"action": "skipped", "error": "autoCreate=false，新技能不落盘"}
        if not self._write_atomic(path, content):
            return {"action": "skipped", "error": "技能文件未写入，原内容未更新", "retryable": True}
        return {"action": "updated" if existed else "created", "path": str(path)}

    def _stage(self, name, content, reason):
        """把"对已有技能的修改"写进待审目录，等人确认后再覆盖。

        参数 name：技能名；content：新全文；reason：模型给的修改理由。
        写不进去时（临时文件被占用）会转存降级副本，不抛异常——一轮复盘不能因为暂存失败全废。
        """
        self.pending_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        path = self.pending_dir / f"{name}-{stamp}.json"
        payload = {"name": name, "content": content, "reason": reason, "created_at": stamp}
        return path if FILE_WRITER.write_text(path, json.dumps(payload, ensure_ascii=False, indent=2)) else None

    @staticmethod
    def _frontmatter(content):
        """解析 `---` 之间的 YAML；失败返回 None。"""
        text = (content or "").lstrip("\ufeff")
        if not text.startswith("---"):
            return None
        end = text.find("\n---", 3)
        if end < 0:
            return None
        head = text[3:end]
        if yaml is not None:
            try:
                data = yaml.safe_load(head) or {}
                return data if isinstance(data, dict) else None
            except yaml.YAMLError:
                return None
        out = {}
        for line in head.splitlines():
            if ":" in line and not line.startswith((" ", "\t")):
                key, value = line.split(":", 1)
                out[key.strip()] = value.strip()
        return out or None

    @staticmethod
    def _write_atomic(path, content):
        """原子写技能文件（重试 + 降级，被占用不会把整轮复盘带崩）。

        参数 path：目标 SKILL.md；content：全文。
        """
        return FILE_WRITER.write_text(path, content.rstrip("\n") + "\n")
