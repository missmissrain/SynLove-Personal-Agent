"""技能复盘后台服务：每隔 N 小时把最近的对话跑一遍，自动沉淀技能。

职责：
- 读取水位（上次复盘时间），取 (水位, 现在] 的对话；
- 用云端模型（默认 qwen3.8-flash）跑一次临时 agent loop，产出 0～N 个技能；
- 新技能直接写入 `~/.dsh/skills/<name>/SKILL.md`，对已有技能的修改暂存待审；
- 写日志、更新水位、把结果用 QQ 通知给用户（可选）。

用法：
    python skills\\skillReviewService.py --once                # 立刻跑一次
    python skills\\skillReviewService.py --once --dry-run      # 只校验不落盘
    python skills\\skillReviewService.py --once --since-hours 48
    python skills\\skillReviewService.py --loop                # 常驻（按 intervalHours）
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from skills.config.configLoader import skillReviewConfig  # noqa: E402
from skills.review.llmClient import llmClient  # noqa: E402
from skills.review.skillReviewer import skillReviewer  # noqa: E402
from skills.review.transcriptBuilder import transcriptBuilder, find_session_root  # noqa: E402
from skills.store.durableFile import durableFile  # noqa: E402
from skills.store.runLock import runLock  # noqa: E402
from skills.store.skillStore import skillStore  # noqa: E402

FILE_WRITER = durableFile()


def log(path, message):
    """带时间戳写日志并打印。

    参数 path 是日志文件路径（可为空，只打印）；message 是要记的内容。
    写不进去不抛异常：durableFile 会重试，再不行转存 `*.locked-*.bak`，本条另打到 stderr。
    2026-10-29 03:00 那次就是被一次 PermissionError 把整轮复盘带崩的，所以这里必须"降级不抛"。
    """
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
    print(line, flush=True)
    if not path:
        return
    if not FILE_WRITER.append_line(path, line):
        print(f"[warn] 日志主文件不可写，本条已转存降级副本", file=sys.stderr, flush=True)


def load_state(path):
    """读水位状态（不存在 / 半截文件 / 被占用都返回空字典）。"""
    return FILE_WRITER.read_json(path)


def save_state(path, state):
    """原子写水位状态；被占用时重试，仍失败则转存降级副本（返回是否写进主文件）。"""
    payload = json.dumps(state, ensure_ascii=False, indent=2)
    written = FILE_WRITER.write_text(path, payload)
    if not written:
        log(None, f"[warn] 水位文件不可写，已转存降级副本：{path}")
    return written



def run_once(config, dry_run=False, since_hours=None, notify=True):
    """跑一次复盘（外面套一层单实例锁，防计划任务与兜底巡检并排跑）。

    参数 config：skillReviewConfig；dry_run：只校验不落盘、不推进水位；
    since_hours：覆盖回看窗口（小时）；notify：是否推 QQ。
    抢不到锁时返回 ok=True + skipped=locked，这样计划任务不会被判成"失败"。
    """
    cfg = config
    lock = runLock(cfg.get("lockFile"), stale_seconds=int(cfg.get("lockStaleSeconds", 6 * 3600)))
    if not lock.acquire():
        holder = lock.holder()
        log(cfg.get("logFile"),
            f"已有一轮在跑（pid={holder.get('pid')}，起始 {holder.get('acquired_text')}），本轮跳过")
        return {"ok": True, "skipped": "locked"}
    try:
        write_heartbeat(cfg, dry_run)
        return _review_once(cfg, dry_run=dry_run, since_hours=since_hours, notify=notify)
    finally:
        lock.release()


def write_heartbeat(config, dry_run):
    """写一份"正在跑"的心跳（pid + 开始时刻），给人排查用，不影响主流程。"""
    payload = json.dumps({
        "pid": os.getpid(),
        "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "dry_run": bool(dry_run),
    }, ensure_ascii=False, indent=2)
    FILE_WRITER.write_text(config.get("heartbeatFile"), payload)


def _review_once(cfg, dry_run=False, since_hours=None, notify=True):
    """真正的一轮复盘（取素材 → 调模型 → 落盘 → 推水位）。"""
    log_path = cfg.get("logFile")
    sessions_home = Path(os.environ.get("DSH_HOME") or ROOT / "runtime/dsh") / "sessions"
    session_root = find_session_root(sessions_home, ROOT)
    if session_root is None:
        log(log_path, f"找不到本项目会话目录（token={ROOT.name}），跳过")
        return {"ok": False, "error": "session_root_not_found"}

    state = load_state(cfg.get("stateFile"))
    now = int(time.time() * 1000)
    if since_hours is not None:
        since = now - int(since_hours) * 3600 * 1000
    elif state.get("last_review_ts"):
        since = int(state["last_review_ts"])
    else:
        since = now - int(cfg.get("firstRunLookbackHours", 24)) * 3600 * 1000

    transcript = transcriptBuilder(session_root).build(
        since, now, max_chars=int(cfg.get("transcriptChars", 14000)))
    log(log_path, f"窗口 {time.strftime('%m-%d %H:%M', time.localtime(since/1000))} → "
                  f"{time.strftime('%m-%d %H:%M', time.localtime(now/1000))}，"
                  f"{transcript['turns']} 轮用户发言，素材 {len(transcript['text'])} 字")

    store = skillStore(cfg.get("skillsDir"),
                       auto_create=bool(cfg.get("autoCreate", True)),
                       stage_updates=bool(cfg.get("stageUpdates", True)))
    llm = llmClient(cfg.section("model"), cfg.section("fallback"))
    result = skillReviewer(cfg, store, llm).review(transcript, dry_run=dry_run)

    saved = result.get("saved") or []
    staged = result.get("staged") or []
    failed = bool(result.get("error"))
    log(log_path, f"完成：新增 {len(saved)} {saved}，待审 {len(staged)} {staged}，"
                  f"模型降级={result.get('fallback')}，错误={result.get('error') or '无'}")

    if not dry_run:
        state.update({
            "last_run_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "runs": int(state.get("runs") or 0) + 1,
            "last_saved": saved,
            "last_staged": staged,
        })
        if failed:
            # 模型挂了就别推进水位：这段素材还没被消化，留给下一轮（与兜底补跑）重试，
            # 否则失败一次就永久丢掉这个窗口，等于"没跑"。只记错误信息。
            state["last_error"] = str(result.get("error"))
            state["last_error_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            log(log_path, "本轮模型出错，水位不推进；下一轮会重新覆盖这段素材")
        else:
            state["last_review_ts"] = now
            state.pop("last_error", None)
        save_state(cfg.get("stateFile"), state)

    if notify and not dry_run and (saved or staged):
        send_notification(saved, staged)

    return {"ok": not failed, **result}


def send_notification(saved, staged):
    """用 QQ 把复盘结果通知用户（失败只记日志）。"""
    parts = []
    if saved:
        parts.append("新增技能：" + "、".join(saved))
    if staged:
        parts.append("待你确认的更新：" + "、".join(staged) + "（`/skills pending` 查看）")
    if not parts:
        return
    text = "技能复盘 · " + "；".join(parts)
    try:
        from tools.qq_notify import send_qq_text_message
        send_qq_text_message(text)
    except Exception as error:  # 通知失败不影响主流程
        print(f"[skill-review] QQ 通知失败：{type(error).__name__}: {error}", flush=True)


def main(argv=None):
    """入口：解析参数 → 跑一次或常驻。"""
    parser = argparse.ArgumentParser(description="技能自动沉淀（夜间复盘）")
    parser.add_argument("--once", action="store_true", help="只跑一次（默认）")
    parser.add_argument("--loop", action="store_true", help="常驻，按 intervalHours 周期跑")
    parser.add_argument("--dry-run", action="store_true", help="只校验不落盘、不更新水位")
    parser.add_argument("--since-hours", type=float, default=None, help="覆盖回看窗口（小时）")
    parser.add_argument("--no-notify", action="store_true", help="不推送 QQ")
    parser.add_argument("--config", default=None, help="自定义配置文件")
    args = parser.parse_args(argv)

    config = skillReviewConfig(ROOT, args.config)
    if not config.get("enabled", True):
        print("skillReview.enabled=false，退出")
        return 0

    if not args.loop:
        # --once 也不许把异常直接崩给计划任务：先落进日志，再返回非零退出码
        try:
            result = run_once(config, dry_run=args.dry_run, since_hours=args.since_hours,
                              notify=not args.no_notify)
        except Exception as error:  # noqa: BLE001 —— 单轮失败要留痕，不要留一堆 traceback
            log(config.get("logFile"), f"本轮失败：{type(error).__name__}: {error}")
            return 1
        return 0 if result.get("ok") else 1

    interval = max(1, int(config.get("intervalHours", 6)))
    print(f"技能复盘常驻：每 {interval} 小时一次（Ctrl+C 退出）", flush=True)
    while True:
        try:
            run_once(config, dry_run=args.dry_run, since_hours=args.since_hours,
                     notify=not args.no_notify)
        except Exception as error:  # 任何异常都不能让常驻进程退出
            print(f"[skill-review] 本轮失败：{type(error).__name__}: {error}", flush=True)
        time.sleep(interval * 3600)


if __name__ == "__main__":
    raise SystemExit(main())
