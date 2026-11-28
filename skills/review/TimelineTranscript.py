"""真实 skill 从时间线数据库取素材（与预演技能库分属两个领域）。

参数 root 为仓库根目录；since_ms/until_ms 为时间窗口；max_chars 为正文上限。

注册参数：
- daysDir：runtime/dsh/timeline/days。
- 只读 role=user / role=assistant，跳过 role=rehearsal，避免预演经验混进真实技能。
"""
import json
import time
from pathlib import Path


def timeline_transcript(root, since_ms, until_ms, max_chars=14000):
    """root为仓库根，since_ms/until_ms为毫秒窗口；返回与 transcriptBuilder 同形的字典，无素材返回 None。"""
    days = Path(root) / "runtime" / "dsh" / "timeline" / "days"
    if not days.is_dir():
        return None
    rows = []
    for path in sorted(days.glob("*.jsonl")):
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                item = json.loads(line)
            except Exception:
                continue
            role = str(item.get("role") or "")
            if role not in ("user", "assistant"):
                continue
            ts = int(item.get("ts") or 0)
            if ts < since_ms or ts >= until_ms:
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            rows.append((ts, role, text))
    if not rows:
        return None
    rows.sort(key=lambda item: item[0])
    # 从窗口尾部往前取，保证不超字符预算，再按时间正序渲染。
    picked = []
    total = 0
    for ts, role, text in reversed(rows):
        if total + len(text) > max_chars and picked:
            break
        picked.append((ts, role, text))
        total += len(text)
    picked.reverse()
    lines = []
    for ts, role, text in picked:
        stamp = time.strftime("%m-%d %H:%M", time.localtime(ts / 1000))
        lines.append("[%s %s] %s" % (stamp, "用户" if role == "user" else "我", text))
    return {"text": "\n".join(lines),
            "start_ts": picked[0][0],
            "end_ts": picked[-1][0],
            "turns": len([item for item in picked if item[1] == "user"]),
            "truncated": len(picked) < len(rows),
            "processed_until": picked[-1][0] + 1}
