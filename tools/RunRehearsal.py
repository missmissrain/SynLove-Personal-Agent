"""预演调度（使用画像版）：图谱更新后，按最近常用软件逐个预演；每软件 48 小时冷却。

用法：
  python tools/RunRehearsal.py --list                 # 看候选软件、分数、是否冷却
  python tools/RunRehearsal.py --run                  # 立即预演本轮候选（最多 maxAppsPerRound 个）
  python tools/RunRehearsal.py --run --dry             # 只打印提示词
  python tools/RunRehearsal.py --if-graph-updated      # 图谱有更新才跑（计划任务用）
  python tools/RunRehearsal.py --journal               # 把已结束的预演写进时间线
  python tools/RunRehearsal.py --history 5             # 从时间线读最近几次预演
  python tools/RunRehearsal.py --loop                 # 常驻

注册参数：
- silentUserId：注入用隔离用户（默认 rehearsal@local），回复与任务通知都发往它，主人收不到。
- graphGate：图谱 gate，比对 runtime/dsh/graph/graph.md 的 mtime。
- cooldownHours / maxAppsPerRound / lookbackDays：冷却、单轮软件数、回看天数。
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from rehearsal.RehearsalJournal import RehearsalJournal
from rehearsal.RehearsalPlanner import build_app_prompt
from rehearsal.UsageInference import UsageInference

INJECT = "http://127.0.0.1:3081/inject"
MCP = ROOT.parent / "terminal-pc" / "terminalConnection" / "tools" / "TerminalMcp.py"
MCP_CONFIG = ROOT / "config" / "terminalConnection.json"
CONFIG = ROOT / "config" / "rehearsal.json"


def load_config():
    """无参数；读取预演配置。"""
    return json.loads(CONFIG.read_text(encoding="utf-8-sig"))


def log(config, message):
    """config为预演配置，message为一行日志。"""
    path = ROOT / str(config.get("logFile") or "runtime/rehearsal.log")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), message))


def mcp_call(tool, arguments, timeout=180):
    """tool为MCP工具名，arguments为参数；返回解析后的结果对象。"""
    python = ROOT / ".venv" / "Scripts" / "python.exe"
    exe = str(python) if python.is_file() else sys.executable
    payload = "".join(json.dumps(item) + "\n" for item in (
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
         "params": {"name": tool, "arguments": arguments}}))
    done = subprocess.run([exe, "-X", "utf8", str(MCP), "--config", str(MCP_CONFIG)],
                          input=payload.encode(), capture_output=True, timeout=timeout)
    for line in done.stdout.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        item = json.loads(line)
        if item.get("id") != 2:
            continue
        for block in (item.get("result") or {}).get("content", []):
            try:
                return json.loads(str(block.get("text")))
            except Exception:
                return {"raw": str(block.get("text"))}
    return {}


def android_packages():
    """无参数；用安卓设备命令取已装第三方包名集合。"""
    result = mcp_call("android_shell", {"target": "sonyXperia5III",
                                        "command": "pm list packages -3", "timeoutSec": 30})
    text = str(result.get("stdout") or "")
    return {line.split("package:")[-1].strip() for line in text.splitlines() if "package:" in line}


def busy():
    """无参数；主系统有排队或运行中的任务时返回 True。"""
    path = ROOT / "runtime" / "agentTasks" / "taskStore.sqlite"
    if not path.is_file():
        return False
    import sqlite3
    try:
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5) as db:
            return db.execute("SELECT count(*) FROM agentTasks WHERE state IN "
                              "('queued','running','cancelling')").fetchone()[0] > 0
    except Exception:
        return False


def graph_mtime():
    """无参数；返回知识图谱摘要的最后修改时间（秒）。"""
    path = ROOT / "runtime" / "dsh" / "graph" / "graph.md"
    return path.stat().st_mtime if path.is_file() else 0.0


def profile_text():
    """无参数；读取画像摘要。"""
    path = ROOT / "runtime" / "dsh" / "graph" / "graph.md"
    return path.read_text(encoding="utf-8", errors="replace")[:1200] if path.is_file() else ""


def inject(config, text):
    """config为预演配置，text为提示词；投给隔离用户并返回应答。"""
    user = str(config.get("silentUserId") or "rehearsal@local")
    body = json.dumps({"text": text, "user_id": user}, ensure_ascii=False).encode()
    request = urllib.request.Request(INJECT, data=body,
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def record(config, targets, delivery):
    """config为配置，targets为本轮软件，delivery为注入编号；写入冷却时间。"""
    path = ROOT / str(config.get("stateFile") or "runtime/rehearsal-state.json")
    state = {}
    if path.is_file():
        try:
            state = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            state = {}
    apps = state.setdefault("apps", {})
    now = time.time()
    for item in targets:
        entry = apps.get(item["name"]) or {}
        entry.update({"at": now, "text": time.strftime("%Y-%m-%d %H:%M:%S"),
                      "device": item["device"], "delivery": delivery,
                      "times": int(entry.get("times") or 0) + 1})
        apps[item["name"]] = entry
    state["lastGraphMtime"] = graph_mtime()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def rehearsal_history(limit=10):
    """limit为条数；返回时间线里最近的预演记录。"""
    days = ROOT / "runtime" / "dsh" / "timeline" / "days"
    if not days.is_dir():
        return []
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
            if item.get("role") == "rehearsal" or item.get("kind") == "rehearsal":
                rows.append((int(item.get("ts") or 0), str(item.get("text") or "")))
    rows.sort(key=lambda pair: pair[0])
    return ["%s %s" % (time.strftime("%m-%d %H:%M", time.localtime(ts / 1000)), text)
            for ts, text in rows[-limit:]]


def run_round(config, dry=False, force=False):
    """config为配置；推断候选并注入，返回结果字典。"""
    state = {}
    path = ROOT / str(config.get("stateFile") or "runtime/rehearsal-state.json")
    if path.is_file():
        try:
            state = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            state = {}
    inference = UsageInference(ROOT, config)
    packages = android_packages()
    targets = inference.pick(packages, state)
    if not targets:
        log(config, "本轮跳过：目标软件都在冷却或不可用")
        return {"ok": True, "skipped": "no_ready_app"}
    prompt = build_app_prompt(ROOT, config, targets, profile_text=profile_text())
    if dry:
        print(prompt)
        return {"ok": True, "dry": True, "targets": [item["name"] for item in targets]}
    if busy() and not force:
        log(config, "跳过：主系统有任务在跑")
        return {"ok": False, "skipped": "busy"}
    for item in targets:
        if item["kind"] != "android":
            continue
        try:
            unlocked = mcp_call("android_unlock", {"target": item["device"]}, timeout=150)
            log(config, "预演前解锁 %s：unlocked=%s" % (item["device"], unlocked.get("unlocked")))
        except Exception as error:
            log(config, "预演前解锁失败：%s" % type(error).__name__)
        break
    answer = inject(config, prompt)
    record(config, targets, answer.get("delivery_id"))
    log(config, "已发起预演：%s，delivery=%s" % (
        "、".join("%s(%s)" % (item["name"], item["device"]) for item in targets),
        answer.get("delivery_id")))
    return {"ok": bool(answer.get("ok")), "targets": [item["name"] for item in targets],
            "delivery": answer.get("delivery_id")}


def main():
    """无参数；解析命令行并执行。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--dry", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--if-graph-updated", action="store_true")
    parser.add_argument("--journal", action="store_true")
    parser.add_argument("--history", nargs="?", const=10, type=int, default=None)
    parser.add_argument("--loop", action="store_true")
    args = parser.parse_args()
    config = load_config()
    journal = RehearsalJournal(ROOT, config)

    if args.history is not None:
        rows = rehearsal_history(max(1, int(args.history)))
        print("\n".join(rows) if rows else "时间线里还没有预演记录")
        return

    if args.journal:
        written = journal.journal_pending()
        print("\n".join("JOURNAL " + line for line in written) if written else "没有需要记账的预演")
        return

    if args.list:
        journal.journal_pending()
        state = {}
        path = ROOT / str(config.get("stateFile") or "runtime/rehearsal-state.json")
        if path.is_file():
            try:
                state = json.loads(path.read_text(encoding="utf-8-sig"))
            except Exception:
                state = {}
        rows = UsageInference(ROOT, config).candidates(android_packages(), state)
        if not rows:
            print("没有可推断的候选软件（时间线与任务日志里没有命中）")
        for row in rows:
            print("  %-10s %-16s 分数=%-6s 提及=%-3d 冷却=%-5s 可用=%-5s %s" % (
                row["name"], row["device"], row["score"], row["hits"],
                row["cooling"], row["available"], row["reason"]))
        ready = [row["name"] for row in rows if row["ready"]]
        print("本轮候选：", "、".join(ready[:int(config.get("maxAppsPerRound") or 2)]) or "无（都在冷却）")
        return

    if args.if_graph_updated:
        state = {}
        path = ROOT / str(config.get("stateFile") or "runtime/rehearsal-state.json")
        if path.is_file():
            try:
                state = json.loads(path.read_text(encoding="utf-8-sig"))
            except Exception:
                state = {}
        last = float(state.get("lastGraphMtime") or 0)
        now = graph_mtime()
        if now <= last:
            print("图谱没有更新，本轮跳过")
            return
        journal.journal_pending()
        print(json.dumps(run_round(config), ensure_ascii=False))
        return

    if args.run:
        journal.journal_pending()
        print(json.dumps(run_round(config, dry=args.dry, force=args.force), ensure_ascii=False))
        return

    if args.loop:
        interval = float(config.get("cooldownHours") or 48)
        print("预演常驻：每 %.0f 小时检查一次" % interval, flush=True)
        while True:
            try:
                journal.journal_pending()
                print(json.dumps(run_round(config), ensure_ascii=False), flush=True)
            except Exception as error:
                print("[rehearsal] 本轮失败：%s: %s" % (type(error).__name__, error), flush=True)
            time.sleep(max(1.0, interval) * 3600)
        return

    parser.print_help()


if __name__ == "__main__":
    main()
