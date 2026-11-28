"""把一段文字发到主人 QQ 的小工具（复用 newsDigest 的 qqPush）。

其他脚本只需 `from tools.qq_notify import send_qq_text_message`。
"""

import io
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from newsDigest.push.qqPush import qqPush  # noqa: E402


def send_qq_text_message(text, dry_run=False):
    """发一条 QQ 文本，返回 qqPush 的结果 dict。"""
    config = json.loads((ROOT / "newsDigest" / "config" / "newsDigest.json").read_text(encoding="utf-8-sig"))
    openid = str((config.get("push") or {}).get("userOpenid") or "").strip()
    if openid == "":
        raise RuntimeError("newsDigest.json 里没有 push.userOpenid")
    if dry_run:
        print(f"[QQ][dry-run] {text[:80]}")
        return {"ok": True, "mode": "dry-run"}
    pusher = qqPush(ROOT / "config" / "secrets.json", openid,
                    bool((config.get("push") or {}).get("allowWakeupFallback", True)))
    return pusher.push(text)
