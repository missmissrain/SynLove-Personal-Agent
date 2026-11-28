"""入站审计：回答「过去 N 小时到底收到几条、处理成几条、哪几条没成」。

负责的功能：
- 读 `~/.dsh/weixin-state.db` 的 `delivery` 表（每条入站一条记录）；
- 按状态汇总，并把失败原因原文列出来（不截断原因，只截宽度）；
- 从探针日志里找「可能漏消息」的空窗：QQ 网关断开、微信长轮询停摆；
- 打印一份人读的报告；`--json` 时输出机器可读结构（给别的脚本用）。

为什么要这个：链路是「推送式」的，平台不会告诉我「有条消息我没投给你」。
所以能抓的只有两种：**进来了但没处理成**（有记录，100% 可查），
和**这段时间链路停过**（间接推断，说明窗口内可能漏）。

注册参数（命令行）：
    --hours 24      统计最近多少小时
    --json          输出 JSON 而不是表格
    --probe         额外扫探针日志里的断连/停摆窗口
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

STATE_DB = Path(os.environ.get("DSH_WEIXIN_STATE_DB") or
                Path(os.environ.get("DSH_HOME") or Path(__file__).resolve().parents[1] / "runtime/dsh") / "weixin-state.db")
PROBE = Path(__file__).resolve().parents[1] / "runtime" / "weixin-probe.log"


def delivery_summary(hours: float) -> dict:
    """统计最近 hours 小时的入站情况。参数 hours：时间窗口（小时）。"""
    now_ms = int(time.time() * 1000)
    since = now_ms - int(hours * 3600 * 1000)
    summary = {"window_hours": hours, "total": 0, "status": {}, "failures": [], "oldest": None, "newest": None}
    if not STATE_DB.is_file():
        return summary

    connection = sqlite3.connect(STATE_DB, timeout=10)
    connection.row_factory = sqlite3.Row
    for row in connection.execute(
            "SELECT status, COUNT(*) AS c FROM delivery WHERE received_at >= ? GROUP BY status", (since,)):
        summary["status"][str(row["status"])] = row["c"]
        summary["total"] += row["c"]

    for row in connection.execute(
            "SELECT delivery_id, user_id, status, last_error, received_at, injected_at FROM delivery "
            "WHERE received_at >= ? AND status != 'injected' ORDER BY received_at DESC LIMIT 20", (since,)):
        summary["failures"].append({
            "delivery_id": row["delivery_id"],
            "user_id": row["user_id"],
            "status": row["status"],
            "reason": row["last_error"] or "(没有原因记录)",
            "received_at": row["received_at"],
        })

    span = connection.execute(
        "SELECT MIN(received_at) AS a, MAX(received_at) AS b FROM delivery WHERE received_at >= ?",
        (since,)).fetchone()
    if span and span["a"]:
        summary["oldest"] = datetime.fromtimestamp(span["a"] / 1000).strftime("%Y-%m-%d %H:%M:%S")
        summary["newest"] = datetime.fromtimestamp(span["b"] / 1000).strftime("%Y-%m-%d %H:%M:%S")
    connection.close()
    return summary


def probe_gaps(hours: float) -> list[str]:
    """从探针日志里找链路中断的证据（QQ 网关断开、微信长轮询停摆）。

    参数 hours：只看最近多少小时。返回人读的描述列表（空表示没发现异常）。
    """
    if not PROBE.is_file():
        return ["探针日志不存在，无法判断链路有没有停过"]

    since = time.time() - hours * 3600
    findings = []
    last_poll = 0.0
    prev_poll = 0.0
    recycle = 0          # 平台要求的正常保活重连（op=7，每小时一次）
    abnormal = 0         # 非预期的断开（网络错误、1006 等）
    pending_recycle = False

    for line in PROBE.read_text(encoding="utf-8", errors="replace").splitlines()[-20000:]:
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        at = str(record.get("at") or "")
        try:
            ts = datetime.fromisoformat(at.replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        if ts < since:
            continue
        event = str(record.get("event") or "")
        if event.startswith("poll."):
            if prev_poll:
                gap = ts - prev_poll
                if gap > 600:                     # 长轮询正常 20 秒一次，超过 10 分钟就是停过
                    findings.append(
                        f"{datetime.fromtimestamp(prev_poll).strftime('%H:%M:%S')} → "
                        f"{datetime.fromtimestamp(ts).strftime('%H:%M:%S')} 微信长轮询停了 {gap / 60:.0f} 分钟")
            prev_poll = last_poll = ts
        elif event == "qq.gateway":
            message = str((record.get("data") or {}).get("message") or "")
            if "op=7" in message:
                pending_recycle = True            # 平台主动要求重连，属于正常保活
                continue
            if "断开" in message or "失败" in message:
                if pending_recycle:
                    recycle += 1
                    pending_recycle = False
                else:
                    abnormal += 1

    if abnormal:
        findings.append(f"QQ 网关**异常**断开 {abnormal} 次（不是平台保活，断线期间平台不补发，那段时间可能漏消息）")
    if recycle:
        findings.append(f"（参考）QQ 网关正常保活重连 {recycle} 次 —— 平台每小时要求一次，属正常，不算漏消息）")
    if last_poll and time.time() - last_poll > 300:
        findings.append(f"微信长轮询已经 {int(time.time() - last_poll)} 秒没有动静（链路可能停摆）")
    return findings


def print_report(summary: dict, gaps: list[str]) -> None:
    """打印人读报告。参数 summary：delivery_summary 的结果；gaps：probe_gaps 的结果。"""
    print(f'=== 入站审计（最近 {summary["window_hours"]} 小时）===')
    print(f'  收到消息：{summary["total"]} 条')
    for status, count in summary["status"].items():
        label = {"injected": "已交给模型", "failed_terminal": "失败（终态）"}.get(status, status)
        print(f'    {label}：{count} 条')
    if summary["oldest"]:
        print(f'  时间范围：{summary["oldest"]} ~ {summary["newest"]}')

    print("")
    if summary["failures"]:
        print(f'=== 没处理成的 {len(summary["failures"])} 条 ===')
        for item in summary["failures"]:
            when = datetime.fromtimestamp(item["received_at"] / 1000).strftime("%m-%d %H:%M:%S")
            print(f'  {when}  {item["reason"][:120]}')
    else:
        print("=== 没有失败记录 ===")

    print("")
    print("=== 链路中断证据 ===")
    if gaps:
        for line in gaps:
            print("  " + line)
    else:
        print("  没发现（说明这段时间链路一直在正常转）")

    print("")
    print("说明：平台不会告诉我们「有条消息没投递」，所以「进不来」只能间接判断——")
    print("      上面「链路中断证据」里如果有断连/停摆窗口，那些时段就可能漏消息。")


def main(argv: list[str] | None = None) -> int:
    """命令行入口。"""
    parser = argparse.ArgumentParser(description="入站审计：收到几条、成没成、有没有断过")
    parser.add_argument("--hours", type=float, default=24, help="统计最近多少小时")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument("--probe", action="store_true", help="额外扫探针日志找断连窗口")
    args = parser.parse_args(argv)

    summary = delivery_summary(args.hours)
    gaps = probe_gaps(args.hours) if args.probe else []
    if args.json:
        print(json.dumps({"summary": summary, "gaps": gaps}, ensure_ascii=False, indent=2))
    else:
        print_report(summary, gaps)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
