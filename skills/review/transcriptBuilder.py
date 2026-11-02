"""把一段时间窗口内的对话整理成复盘素材（含工具调用摘要）。

职责：
- 扫描本项目会话库（main / qq-* / weixin-*），抽出 (since, until] 内的
  用户消息、欣爱回复、工具调用（名称 + 参数摘要）；
- 渲染成紧凑文本，供技能沉淀模型阅读；
- 超长时保留最近的部分并标注截断（复盘更关心最近发生了什么）。

注册参数（构造）：
    session_root  项目会话目录（~/.dsh/sessions/<项目哈希>）
    timezone      渲染时间用的时区（默认 Asia/Shanghai）
"""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .SessionCompression import SessionCompression

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TZ = timezone(timedelta(hours=8))


class transcriptBuilder:
    """会话 → 复盘素材。"""

    def __init__(self, session_root, timezone=TZ):
        """session_root：项目会话目录；timezone：渲染时区。"""
        self.session_root = Path(session_root)
        self.tz = timezone

    def build(self, since_ts, until_ts, max_chars=14000):
        """返回 {text, start_ts, end_ts, turns, truncated}。"""
        rows = []
        for path in sorted(self.session_root.rglob("session.v3.jsonl.zstd")):
            rows.extend(self._read_session(path, since_ts, until_ts))
        rows.sort(key=lambda item: item[0])
        turns = sum(1 for item in rows if item[1] == "user")
        lines = [self._render(item) for item in rows]
        text = "\n".join(lines)
        truncated = False
        if len(text) > max_chars:
            text = text[-max_chars:]
            cut = text.find("\n")
            if cut > 0:
                text = text[cut + 1:]
            text = "[更早的内容已省略]\n" + text
            truncated = True
        start_ts = rows[0][0] if rows else since_ts
        end_ts = rows[-1][0] if rows else until_ts
        return {"text": text, "start_ts": start_ts, "end_ts": end_ts,
                "turns": turns, "truncated": truncated}

    def _read_session(self, path, since_ts, until_ts):
        """读一个会话文件，返回 [(ts, kind, body)]。"""
        try:
            text = SessionCompression.decompress_bytes(path.read_bytes()).decode("utf-8", "replace")
        except Exception as error:
            raise RuntimeError("技能素材会话读取失败，保留复盘水位") from error
        out = []
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = item.get("time")
            if not isinstance(ts, int) or not (since_ts < ts <= until_ts):
                continue
            kind = item.get("type", "")
            data = item.get("data", {}) or {}
            if kind == "user/message":
                body = _text_of(data.get("content"))
                if body and "Time sampled" not in body:
                    out.append((ts, "user", body))
            elif kind == "assistant/message":
                msg = data.get("message", {}) or {}
                body = _text_of(msg.get("content"))
                if body:
                    out.append((ts, "assistant", body))
            elif kind == "tool/call":
                name = data.get("name") or ""
                args = data.get("arguments") or {}
                raw = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
                out.append((ts, "tool", f"{name} {raw[:200]}"))
        return out

    def _render(self, row):
        """渲染一行：[MM-DD HH:MM] 角色：正文。"""
        ts, kind, body = row
        stamp = datetime.fromtimestamp(ts / 1000, self.tz).strftime("%m-%d %H:%M")
        who = {"user": "用户", "assistant": "欣爱", "tool": "工具"}.get(kind, kind)
        return f"[{stamp}] {who}：{body[:900]}"


def _text_of(content):
    """把 content 数组里的 text 片段拼起来（跳过 reasoning / tool-call）。"""
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            value = (block.get("text") or "").strip()
            if value:
                parts.append(value)
    return "\n".join(parts).strip()


def encode_project_token(path):
    """path 为完整项目路径；按 Harness 的 UTF-16 路径协议生成精确目录键。"""
    out = []
    separator = False
    units = str(path).encode("utf-16-le", errors="surrogatepass")
    for index in range(0, len(units), 2):
        code = int.from_bytes(units[index:index + 2], "little")
        ch = chr(code)
        if ch in "/\\:":
            if not separator:
                out.append("-")
            separator = True
            continue
        separator = False
        if ch.isascii() and (ch.isalnum() or ch in "._-"):
            out.append(ch)
        else:
            out.append("~" + format(code, "04X"))
    slug = "".join(out).lstrip("-") or "root"
    return "--" + slug[:251] + "--"


def find_session_root(sessions_home, project_dir):
    """sessions_home 为会话库，project_dir 为完整项目路径；只匹配本项目，避免串读同名工程。"""
    home = Path(sessions_home)
    if not home.is_dir():
        return None
    path = home / encode_project_token(Path(project_dir).resolve())
    return path if path.is_dir() else None
