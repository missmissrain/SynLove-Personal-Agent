"""链路兜底巡检：定时释放卡住的微信投递、清理死租约、检查 QQ 网关与 RSSHub。

背景：
- 微信入站协调器要等投递到终态才提交游标；一条卡在 routing 就能把后续消息全堵死
  （2026-10-28 实际发生过）。这里每 60 秒扫一次，把超时的非终态投递收尾。
- QQ 没有持久入站队列：网关挂了就收不到。这里检查网关 pid，异常时拉起整套栈。
- 日报依赖本机 RSSHub（1200）；挂了就顺手拉起来。
- 技能复盘（每天 03:00）如果崩了/计划任务没起来，这里负责**补跑（复活）**。

用法：
    python tools\\guardService.py --loop        # 常驻（start_stack 自动拉起）
    python tools\\guardService.py --once        # 只巡检一次
"""

import argparse
import datetime
import hashlib
import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 巡检自身没有控制台；起任何 console 程序都要显式隐藏，否则每次调用都会新建一个窗口闪一下
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from skills.store.durableFile import durableFile  # noqa: E402
from skills.store.runLock import runLock  # noqa: E402
from tools.PowerKeepAlive import PowerKeepAlive  # noqa: E402
from services.RuntimePaths import RuntimePaths

PATHS = RuntimePaths(ROOT)
STATE_DB = PATHS.state
QQ_LOCK = PATHS.qq_lock
GUARD_STARTED_AT = time.time()
LOG = ROOT / "runtime" / "guard-service.log"
PID_FILE = ROOT / "runtime" / "guard.pid"
RSSHUB_ENTRY = ROOT / "rsshub" / "RSSHub" / "dist" / "index.mjs"
RSSHUB_PORT = 1200

SKILL_DIR = ROOT / "skills"
SKILL_SCRIPT = SKILL_DIR / "skillReviewService.py"
SKILL_CONFIG = SKILL_DIR / "config" / "skillReview.json"
SKILL_CONSOLE = ROOT / "runtime" / "skill-review.console.log"
SKILL_GUARD = ROOT / "runtime" / "skill-review-guard.json"

DELIVERY_STUCK_MINUTES = 10
OUTBOX_SENDING_MINUTES = 5
OUTBOX_RETRY_MINUTES = 30

# ── 语义级健康检查（2026-10-30 加）────────────────────────────────────────
# 事故复盘：harness 进程活着、QQ 网关 READY，但 preset 挂载失败，
# 每条消息都回"我这边刚才没处理成"。当时所有基于 pid/端口的巡检全部放过。
HARNESS_PORT = int(os.environ.get("DSH_HARNESS_PORT") or "3080")
INJECT_PORT = int(os.environ.get("DSH_WEIXIN_INJECT_PORT") or "3081")
GEMMA_PORT = int(os.environ.get("GEMMA_SERVER_PORT") or "8080")

_preset_failures = 0        # 已废弃：不再定时造探针会话；保留字段避免旧调用方报错
_gemma_failures = 0         # Gemma 探活连续失败次数
_last_outbound_alert = 0.0  # 上次「推送失败」告警时间（1 小时去重）
_seen_inbound_failures: set[str] = set()   # 已告警过的入站失败（按 delivery_id 去重）
PAUSE_MARKER = ROOT / "runtime" / "guardian.pause"
_SUPERVISOR = None                         # 自愈状态机（第一次用到时才建）
_POWER = PowerKeepAlive()

# 语义探针的最近结果：心跳要用它判断"链路到底能不能用"，
# 而不是只看"有没有抓到新失败"（没人发消息时永远抓不到）。
_health = {"preset_ok": None, "preset_detail": "", "preset_at": 0.0,
           "gemma_ok": None, "gemma_at": 0.0}

FILE_WRITER = durableFile()


def log(message):
    """写日志并打印（写不进去只降级，不抛异常——巡检自己不能因为日志崩掉）。"""
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
    print(line, flush=True)
    if not FILE_WRITER.append_line(LOG, line):
        print("[warn] 巡检日志主文件不可写，已转存降级副本", file=sys.stderr, flush=True)


def process_alive(pid):
    """进程是否存活。

    必须带 CREATE_NO_WINDOW：巡检进程自己没有控制台，若直接起 console 程序（tasklist），
    Windows 会给它新建一个控制台窗口——每轮查一次就在屏幕上闪一下 cmd，
    这正是"系统老是闪屏"的元凶之一。
    """
    if pid <= 0:
        return False
    try:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                             capture_output=True, text=True, encoding="utf-8", errors="replace",
                             timeout=10, creationflags=NO_WINDOW).stdout
        return str(pid) in out
    except (OSError, subprocess.SubprocessError):
        return False


def port_open(port):
    """端口是否可连。"""
    with socket.socket() as probe:
        probe.settimeout(1.0)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def release_deliveries(now_ms):
    """now_ms 为当前毫秒；把未注入的陈旧投递交回有限重试，保留原错及合法终态。"""
    if not STATE_DB.is_file():
        return 0
    cutoff = now_ms - DELIVERY_STUCK_MINUTES * 60 * 1000
    try:
        db = sqlite3.connect(str(STATE_DB), timeout=8)
        try:
            rows = db.execute(
                "select delivery_id, status from delivery "
                "where status in ('received','routing') and received_at < ?",
                (cutoff,),
            ).fetchall()
            if not rows:
                return 0
            db.execute(
                "update delivery set status='failed_retryable', "
                "last_error=COALESCE(last_error,'stuck before injection (guard retry)') "
                "where status in ('received','routing') and received_at < ?",
                (cutoff,),
            )
            db.commit()
            log("重试卡住投递 " + ", ".join(f"{row[0]}({row[1]})" for row in rows))
            return len(rows)
        finally:
            db.close()
    except Exception as error:  # noqa: BLE001
        log(f"释放投递失败：{error}")
        return 0


def reset_outbox(now_ms):
    """把卡在 sending 出箱重置为可重试；重试太久的置为终态。"""
    if not STATE_DB.is_file():
        return
    cutoff = now_ms - OUTBOX_SENDING_MINUTES * 60 * 1000
    retry_cutoff = now_ms - OUTBOX_RETRY_MINUTES * 60 * 1000
    try:
        db = sqlite3.connect(str(STATE_DB), timeout=8)
        try:
            changed = db.execute(
                "update outbox set status='failed_retryable' "
                "where status='sending' and created_at < ?",
                (cutoff,),
            ).rowcount
            dropped = db.execute(
                "update outbox set status='failed_terminal' "
                "where status='failed_retryable' and created_at < ?",
                (retry_cutoff,),
            ).rowcount
            db.commit()
            if changed:
                log(f"出箱 sending → 可重试：{changed} 条")
            if dropped:
                log(f"出箱 重试超时 → 终态：{dropped} 条")
        finally:
            db.close()
    except Exception as error:  # noqa: BLE001
        log(f"清理出箱失败：{error}")


def clear_dead_lease():
    """清掉指向死进程的 consumer_lease。"""
    if not STATE_DB.is_file():
        return
    try:
        db = sqlite3.connect(str(STATE_DB), timeout=8)
        try:
            row = db.execute("select pid from consumer_lease where id=1").fetchone()
            if row and not process_alive(int(row[0] or 0)):
                db.execute("delete from consumer_lease where id=1")
                db.commit()
                log(f"清理死租约 pid={row[0]}")
        finally:
            db.close()
    except Exception as error:  # noqa: BLE001
        log(f"清理租约失败：{error}")


def check_rsshub():
    """RSSHub（1200）没在跑就拉起来（日报依赖它）。"""
    if port_open(RSSHUB_PORT) or not RSSHUB_ENTRY.is_file():
        return
    node = r"E:\project_make\nodejs\node.exe"
    if not Path(node).is_file():
        node = "node"
    env = {**os.environ, "PORT": str(RSSHUB_PORT), "NODE_ENV": "production",
           "NODE_OPTIONS": "--max-http-header-size=32768"}
    try:
        subprocess.Popen([node, str(RSSHUB_ENTRY)], cwd=str(RSSHUB_ENTRY.parent.parent), env=env,
                         creationflags=0x08000000 | 0x00000008,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        log("RSSHub 未在运行，已拉起")
    except OSError as error:
        log(f"RSSHub 拉起失败：{error}")


_last_stack_restart = 0.0


def restart_stack(reason):
    """重启整套栈（10 分钟冷却，避免重启风暴）。

    注意：如果 `runtime/guardian.pause` 存在且未过期，说明系统是**被人或自愈流程
    主动停机的**（例如连续自救失败后选择不再空转），这时不能再拉起来，
    否则就是「停了又被拉起」的死循环。
    """
    global _last_stack_restart
    if _halt_marker_active():
        log(f"系统处于停机状态（guardian.pause 未过期），跳过重启：{reason}")
        return
    if time.time() - _last_stack_restart < 600:
        return
    _last_stack_restart = time.time()
    log(f"重启栈：{reason}")
    try:
        subprocess.Popen([sys.executable, str(ROOT / "start_stack.py")],
                         cwd=str(ROOT), creationflags=0x08000000 | 0x00000008,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as error:
        log(f"重启栈失败：{error}")


def _halt_marker_active():
    """`runtime/guardian.pause` 是否存在且未到期。存在=true 表示不该自动重启。"""
    try:
        if not PAUSE_MARKER.is_file():
            return False
        data = json.loads(PAUSE_MARKER.read_text(encoding="utf-8") or "{}")
        until = float(data.get("until") or 0)
        if until and time.time() * 1000 >= until:
            return False
        return True
    except (OSError, json.JSONDecodeError, ValueError):
        # 标记文件坏了：当作存在处理，宁可不动手
        return PAUSE_MARKER.is_file()


def check_weixin_stall():
    """微信 ingress 若长时间没有任何 poll 事件，说明链路卡死，重启栈。

    2026-10-30 修的一个盲点：原来只看最后 80 行，而且要求「这 80 行里必须有 poll」才判断。
    QQ 的事件一多，poll 就被挤出窗口 → has_poll=False → 这项检查等于自动失效，
    微信真卡死了也不会有人管。现在改成扫最近 800 条，并且只在「窗口里有 poll 事件」
    时才用时间戳判断（避免刚启动还没开始轮询就误杀）。
    """
    probe = ROOT / "runtime" / "weixin-probe.log"
    if not probe.is_file():
        return
    try:
        lines = probe.read_text(encoding="utf-8", errors="replace").splitlines()[-800:]
    except OSError:
        return
    last_poll = 0.0
    for line in lines:
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not str(item.get("event", "")).startswith("poll."):
            continue
        at = item.get("at")
        if isinstance(at, str):
            try:
                last_poll = max(last_poll, datetime.datetime.fromisoformat(at.replace("Z", "+00:00")).timestamp())
            except ValueError:
                pass
    if last_poll >= GUARD_STARTED_AT and time.time() - last_poll > 300:
        restart_stack(f"微信 ingress 静默 {int(time.time() - last_poll)} 秒")


def check_qq_gateway():
    """无参数；核对 QQ 进程及有期限的协议心跳，不能把进程存活当连接正常。"""
    if not QQ_LOCK.is_file():
        return
    try:
        pid = int(QQ_LOCK.read_text(encoding="utf-8").strip() or 0)
    except (OSError, ValueError):
        pid = 0
    if pid > 0 and process_alive(pid):
        try:
            rows = (ROOT / "runtime" / "weixin-probe.log").read_text(encoding="utf-8", errors="replace").splitlines()
            for line in reversed(rows):
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                data = item.get("data", {})
                if item.get("event") != "qq.health" or data.get("pid") != pid:
                    continue
                if time.time() * 1000 > float(data.get("expires_at") or 0) + 60000:
                    restart_stack("QQ 协议心跳已过期")
                return
        except (OSError, ValueError):
            pass
        return
    restart_stack(f"QQ 网关进程不在（pid={pid}）")


def check_gemma_alive():
    """本地 Gemma 服务探活：连不上就记一次失败。

    为什么单独查：模型服务是"回复"的前提。它挂了，链路看起来全通（网关在、进程在），
    但每条消息都会失败。这里只做 GET /health（不触发加载，休眠中也能回）。
    """
    global _gemma_failures
    try:
        from services.ServiceRegistry import ServiceRegistry
        from services.ServiceClient import ServiceClient
        from urllib.parse import urlsplit, urlunsplit
        cfg = ServiceRegistry().get_service("llm")
        model_path = ROOT / "config/modelConfig.json"
        model_cfg = json.loads(model_path.read_text(encoding="utf-8-sig"))
        if model_cfg.get("defaultModel", {}).get("provider") != cfg.get("provider", "gemma-local"):
            _gemma_failures = 0
            return None  # 云端对话不依赖可选本地模型，不能因此重启微信/QQ。
        if cfg["management"] == "external":
            _gemma_failures = 0
            return None  # 外部服务不归本机守护器管理，也不应显示假绿。
        url = urlsplit(cfg["baseURL"])
        cfg["baseURL"] = urlunsplit((url.scheme, url.netloc, "", "", ""))
        cfg["timeoutSeconds"] = 10
        body, _ = ServiceClient(cfg).request(cfg.get("healthPath", "/health"), limit=65536)
        data = json.loads(body)
        if data.get("ok") is not True and data.get("status") != "ok":
            raise ValueError("模型服务健康检查失败")
    except Exception as error:  # noqa: BLE001
        _gemma_failures += 1
        log(f"Gemma 探活失败（第 {_gemma_failures} 次）：{error}")
        return False
    if _gemma_failures > 0:
        log(f"Gemma 探活恢复（之前连续失败 {_gemma_failures} 次）")
    _gemma_failures = 0
    return True


def check_semantic_health():
    """语义级巡检：从**真实流量**推断「欣爱现在能不能起来」，不制造假会话。

    为什么不再用 `/admin/reload-preset` 定时探活：那个接口会真的创建一个探针 Agent
    再释放。每 10 分钟建一次会话，既浪费又干扰（会话列表被污染、可能撞上正在进行的
    对话）。**探活不应该产生业务副作用。**

    改成纯观察：既有的证据链已经足够判断——
      正常证据：探针日志里的 `agent.created` / `agent.resumed`，或 `delivery` 里
                最近一条 `status=injected`（消息成功交给模型，说明会话建起来了）
      故障证据：`qq.handle_failed`（preset 挂载失败/会话创建失败）、`preset.reload_failed`
    比较两边最近的时间戳即可。没人发消息时结论是「未验证」而不是假绿。

    Gemma 仍然每轮 GET /health（纯读，无副作用）。
    """
    _health.update(_preset_evidence())
    gemma_ok = check_gemma_alive()
    _health["gemma_ok"] = gemma_ok
    _health["gemma_at"] = time.time()
    if gemma_ok is False and _gemma_failures >= 2:
        restart_stack(f"Gemma 连续 {_gemma_failures} 次探活失败")


def _preset_evidence():
    """从探针日志与状态库推断 preset 健康度。

    返回 {'preset_ok': True|False|None, 'preset_detail': str, 'preset_at': float}。
    None 表示"这段时间没有足够证据"，心跳会如实说「未验证」。
    """
    good_at = 0.0
    good_what = ""
    bad_at = 0.0
    bad_what = ""

    probe = ROOT / "runtime" / "weixin-probe.log"
    if probe.is_file():
        try:
            lines = probe.read_text(encoding="utf-8", errors="replace").splitlines()[-4000:]
        except OSError:
            lines = []
        for line in lines:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            event = str(record.get("event") or "")
            at = str(record.get("at") or "")
            try:
                ts = datetime.datetime.fromisoformat(at.replace("Z", "+00:00")).timestamp()
            except ValueError:
                continue
            if event in ("agent.created", "agent.resumed"):
                if ts > good_at:
                    good_at, good_what = ts, event
            elif event == "preset.reload_failed" or (
                event in ("qq.handle_failed", "admin.failed")
                and any(word in str(record.get("error") or "").lower()
                        for word in ("preset", "failed to mount", "failed to load"))
            ):
                if ts > bad_at:
                    bad_at, bad_what = ts, event

    # 消息成功交给模型，同样证明"会话能建、链路能用"
    if STATE_DB.is_file():
        try:
            connection = sqlite3.connect(STATE_DB, timeout=10)
            connection.row_factory = sqlite3.Row
            row = connection.execute(
                "SELECT MAX(injected_at) AS t FROM delivery WHERE status='injected'").fetchone()
            connection.close()
            if row and row["t"]:
                injected_at = float(row["t"]) / 1000
                if injected_at > good_at:
                    good_at, good_what = injected_at, "最近一条入站已交给模型"
        except sqlite3.Error:
            pass

    if bad_at and bad_at > good_at:
        return {"preset_ok": False, "preset_at": bad_at,
                "preset_detail": f"{bad_what}（{datetime.datetime.fromtimestamp(bad_at):%m-%d %H:%M}）"}
    if good_at and time.time() - good_at < 6 * 3600:
        return {"preset_ok": True, "preset_at": good_at,
                "preset_detail": f"{good_what}（{datetime.datetime.fromtimestamp(good_at):%m-%d %H:%M}）"}
    return {"preset_ok": None, "preset_at": good_at,
            "preset_detail": "最近 6 小时没有入站，无法验证（不制造假会话去探）"}


def check_outbound_health():
    """对账式心跳：从状态库判「收到了但发不出去」以及「推送失败的具体原因」。

    为什么这么设计：主动发一条测试消息会打扰人，而状态库本来就记着每一笔进出：
      delivery 表 → 收到的消息（status=injected 表示已交给模型）
      outbox   表 → 要发的消息（status=sent / failed_terminal，last_error 带原因）

    两条判定：
    1. **收得到但发不出**：最近 30 分钟有入站、却没有任何新的 outbox 记录
       （正常情况下模型回一句就会写一行）。这直接对应"你发了消息她不理"。
    2. **推送被平台拒**：最近 2 小时的 failed_terminal 按 last_error 聚合，
       同类原因 ≥3 次 → 说明是结构性问题（比如微信会话窗口关了），
       此时用**另一条通道**（QQ）把原因告诉主人 —— 两条链路互为备份。

    告警做 1 小时去重，避免同一条原因刷屏。
    """
    global _last_outbound_alert
    if not STATE_DB.is_file():
        return
    now_ms = int(time.time() * 1000)
    try:
        connection = sqlite3.connect(STATE_DB, timeout=10)
        connection.row_factory = sqlite3.Row
        tables = {row["name"] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        if "outbox" not in tables or "delivery" not in tables:
            connection.close()
            return

        inbound = connection.execute(
            "SELECT COUNT(*) AS c FROM delivery WHERE status='injected' AND injected_at >= ?",
            (now_ms - 30 * 60 * 1000,)).fetchone()["c"]
        outbound = connection.execute(
            "SELECT COUNT(*) AS c FROM outbox WHERE created_at >= ?",
            (now_ms - 30 * 60 * 1000,)).fetchone()["c"]

        failures = []
        for row in connection.execute(
                "SELECT last_error AS reason, COUNT(*) AS c FROM outbox "
                "WHERE status='failed_terminal' AND created_at >= ? "
                "GROUP BY last_error ORDER BY c DESC",
                (now_ms - 2 * 3600 * 1000,)):
            failures.append((row["reason"] or "(无原因)", row["c"]))
        connection.close()
    except sqlite3.Error as error:
        log(f"读状态库失败（不影响其他巡检）：{error}")
        return

    if inbound > 0 and outbound == 0:
        log(f"疑似「收得到发不出」：30 分钟内入站 {inbound} 条，但零条出站")
        warn_owner("微信这边好像只进不出：最近 30 分钟收到消息但没有发出任何回复。")

    for reason, count in failures:
        if count < 3:
            continue
        if time.time() - _last_outbound_alert < 3600:
            return
        _last_outbound_alert = time.time()
        log(f"推送被平台拒绝 {count} 次，原因：{reason[:120]}")
        warn_owner(f"微信推送连续失败 {count} 次，平台给的原因是：{reason[:120]}")
        return


def check_inbound_failures():
    """入站失败告警：有消息进来了但没处理成，用 QQ 告诉你「哪条、为什么」。

    数据来源是 `delivery` 表：每条入站都有自己的 status 与 last_error。
    正常情况下状态会从「非终态」走到 `injected`（已交给模型）；
    走到 `failed_terminal` 就说明这条消息**收到了但没处理成**——
    这正是「我在外面发了消息，她没回」在数据层的样子。

    只对**新出现**的失败告警（用 delivery_id 去重），"用户已取消"这类主动放弃的不算故障。
    """
    global _seen_inbound_failures
    if not STATE_DB.is_file():
        return
    now_ms = int(time.time() * 1000)
    try:
        connection = sqlite3.connect(STATE_DB, timeout=10)
        connection.row_factory = sqlite3.Row
        rows = list(connection.execute(
            "SELECT delivery_id, user_id, status, last_error, received_at, injected_at FROM delivery "
            "WHERE received_at >= ? ORDER BY received_at DESC LIMIT 50",
            (now_ms - 30 * 60 * 1000,)))
        connection.close()
    except sqlite3.Error as error:
        log(f"读入站记录失败：{error}")
        return

    if not rows:
        return

    fresh = 0
    failed = 0
    for row in rows:
        delivery_id = str(row["delivery_id"])
        fresh += 1
        if str(row["status"]) != "failed_terminal":
            continue
        if delivery_id in _seen_inbound_failures:
            continue
        _seen_inbound_failures.add(delivery_id)
        reason = str(row["last_error"] or "")
        if "用户已取消" in reason:
            continue
        failed += 1
        log(f"入站消息没处理成：{delivery_id[:36]} 原因={reason[:120]}")
        warn_owner(f"你刚才那条消息没处理成。原因：{reason[:100] or '未知'}（已记录，可稍后重发）")

    # 内存里的去重集合不能无限长
    if len(_seen_inbound_failures) > 500:
        _seen_inbound_failures = set(list(_seen_inbound_failures)[-200:])

    # received/routing 不等于注入成功；不再打印误导性的“全部已交给模型”。


def warn_owner(text):
    """用**另一条通道**把告警告诉主人（这里用 QQ；两条链路互为备份）。

    走 tools/qq_notify.py，失败只记日志——告警自己不能再抛异常。
    """
    try:
        # 统一告警去重，覆盖“有入站零出站”分支；落盘后重启守护也不会每分钟刷屏。
        state_file = ROOT / "runtime" / "guard-alert-state.json"
        state = FILE_WRITER.read_json(state_file)
        key = hashlib.sha256(str(text).encode("utf-8")).hexdigest()
        now = time.time()
        if now - float(state.get(key) or 0) < 3600:
            return
        state = {name: stamp for name, stamp in state.items()
                 if isinstance(stamp, (int, float)) and now - stamp < 86400}
        state[key] = now
        FILE_WRITER.write_text(state_file, json.dumps(state, ensure_ascii=False))
        sys.path.insert(0, str(ROOT / "tools"))
        from qq_notify import send_qq_text_message  # noqa: PLC0415 —— 惰性导入，避免启动时强依赖
        result = send_qq_text_message(f"【链路告警】{text}")
        log(f"已通过 QQ 发出告警：ok={result.get('ok')} mode={result.get('mode')}")
    except Exception as error:  # noqa: BLE001
        log(f"QQ 告警发送失败（可能两条链路都出问题了）：{error}")


def skill_config():
    """读 skills/config/skillReview.json（只取巡检要用的几个键，缺省用内置默认）。"""
    defaults = {
        "enabled": True,
        "scheduleHour": 3,
        "catchUpGraceMinutes": 10,
        "retryCooldownMinutes": 30,
        "lockStaleSeconds": 21600,
        "stateFile": "runtime/skill-review-state.json",
        "lockFile": "runtime/skill-review.lock",
    }
    data = FILE_WRITER.read_json(SKILL_CONFIG)
    merged = dict(defaults)
    merged.update({key: value for key, value in (data or {}).items() if key in defaults})
    return merged


def skill_paths(config):
    """按配置解析状态文件与锁文件（相对路径按项目根算）。"""
    def resolve(key):
        raw = Path(str(config.get(key) or ""))
        return raw if raw.is_absolute() else ROOT / raw

    return {"state": resolve("stateFile"), "lock": resolve("lockFile")}


def skill_review_due(config, last_review_ts, now=None):
    """判断技能复盘是否需要补跑，返回 (该不该跑, 原因)。

    参数 config：skill_config() 的结果；last_review_ts：上次成功复盘的毫秒时间戳（0 表示从没跑过）；
    now：当前 epoch 秒（默认现在）。
    判据：以"最近一个应跑时刻"（今天或昨天的 scheduleHour:00）为界，
    水位早于这个界 = 这一轮没跑成；刚过界的前 grace 分钟留给计划任务先跑，巡检不抢。
    """
    now = time.time() if now is None else now
    hour = max(0, min(23, int(config.get("scheduleHour", 3))))
    grace = max(0, int(config.get("catchUpGraceMinutes", 10))) * 60
    today = datetime.datetime.now().replace(hour=hour, minute=0, second=0, microsecond=0)
    boundary = today if now >= today.timestamp() else today - datetime.timedelta(days=1)
    boundary_ts = boundary.timestamp()
    if now - boundary_ts < grace:
        return False, "刚过应跑时刻，等计划任务先跑"
    if last_review_ts and last_review_ts / 1000.0 >= boundary_ts:
        return False, "本轮已跑过"
    stamp = boundary.strftime("%m-%d %H:%M")
    if not last_review_ts:
        return True, f"从没跑过（应跑时刻 {stamp}）"
    last_text = time.strftime("%m-%d %H:%M", time.localtime(last_review_ts / 1000.0))
    return True, f"{stamp} 这一轮没跑成（上次成功 {last_text}）"


def run_skill_review(config, reason):
    """补跑一轮技能复盘（脱离父进程；控制台输出单独一个文件，避免和 python 抢同一份日志）。"""
    if not SKILL_SCRIPT.is_file():
        log(f"技能复盘脚本缺失，无法补跑：{SKILL_SCRIPT}")
        return
    try:
        SKILL_CONSOLE.parent.mkdir(parents=True, exist_ok=True)
        with SKILL_CONSOLE.open("a", encoding="utf-8") as handle:
            handle.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} 兜底补跑：{reason} =====\n")
            handle.flush()
            subprocess.Popen([sys.executable, str(SKILL_SCRIPT), "--once"], cwd=str(ROOT),
                             stdout=handle, stderr=handle,
                             creationflags=0x08000000 | 0x00000008)
        FILE_WRITER.write_text(SKILL_GUARD, json.dumps({
            "last_spawn_at": time.time(),
            "last_spawn_text": time.strftime("%Y-%m-%d %H:%M:%S"),
            "reason": reason,
        }, ensure_ascii=False, indent=2))
        log(f"技能复盘补跑已启动：{reason}")
    except OSError as error:
        log(f"技能复盘补跑启动失败：{error}")


def check_skill_review():
    """技能复盘没跑成（崩溃 / 计划任务没起来 / 卡住）就补跑，带冷却防抖。"""
    config = skill_config()
    if not config.get("enabled", True):
        return
    paths = skill_paths(config)
    lock = runLock(paths["lock"], stale_seconds=int(config.get("lockStaleSeconds", 21600)))
    if lock.alive():
        return                                    # 正有一轮在跑，别插队
    cooldown = max(1, int(config.get("retryCooldownMinutes", 30))) * 60
    last_spawn = float(FILE_WRITER.read_json(SKILL_GUARD).get("last_spawn_at") or 0)
    if last_spawn and time.time() - last_spawn < cooldown:
        return                                    # 刚补过，给它跑完的时间
    state = FILE_WRITER.read_json(paths["state"])
    due, reason = skill_review_due(config, float(state.get("last_review_ts") or 0))
    if due:
        run_skill_review(config, reason)


def check_self_healing():
    """自愈状态机：发现「进来就报错 / 回不出去」就重启+清状态，救不回来两次就停机。

    这一层是**动手**的，前面几个 check_ 只负责发现和告警。委托给 linkSupervisor，
    它自己维护「连续失败次数 / 冷却 / 停机」的状态，进程重启也不丢。

    把 `_health` 一并传进去：preset 挂不上意味着"欣爱起不来"，
    哪怕一条消息都没进来，也必须当成故障处理 —— 这正是 2026-10-30 09:00 那次的情形。
    """
    global _SUPERVISOR
    try:
        if _SUPERVISOR is None:
            sys.path.insert(0, str(ROOT / "tools"))
            from linkSupervisor import linkSupervisor  # noqa: PLC0415 —— 惰性导入
            _SUPERVISOR = linkSupervisor(ROOT)
        phase = _SUPERVISOR.tick(health=dict(_health))
        if phase == "halted":
            log("自愈状态机已停机（需要人工介入），此后不再自动重启")
    except Exception as error:  # noqa: BLE001 —— 自愈自己不能把巡检带崩
        log(f"自愈状态机异常：{type(error).__name__}: {error}")


def guard_once():
    """跑一轮巡检。"""
    # 所有守护动作共享维护暂停，不能只在 restart_stack 内检查。
    paused = _halt_marker_active()
    _POWER.set_active(not paused and port_open(HARNESS_PORT))
    if paused:
        return
    process = _SUPERVISOR._repair.get("process") if _SUPERVISOR is not None else None
    if process is not None and process.poll() is None:
        return
    now_ms = int(time.time() * 1000)
    release_deliveries(now_ms)
    reset_outbox(now_ms)
    clear_dead_lease()
    check_rsshub()
    check_weixin_stall()
    check_qq_gateway()
    check_semantic_health()
    check_outbound_health()
    check_inbound_failures()
    check_self_healing()
    check_skill_review()


def main(argv=None):
    """入口。"""
    parser = argparse.ArgumentParser(description="链路兜底巡检")
    parser.add_argument("--once", action="store_true", help="只跑一次")
    parser.add_argument("--loop", action="store_true", help="常驻，每 60 秒一次")
    args = parser.parse_args(argv)

    if args.once or not args.loop:
        guard_once()
        return 0

    PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    log("兜底巡检启动：每 60 秒一次")
    try:
        while True:
            try:
                guard_once()
            except Exception as error:  # noqa: BLE001
                log(f"巡检异常：{type(error).__name__}: {error}")
            time.sleep(60)
    finally:
        _POWER.set_active(False)


if __name__ == "__main__":
    raise SystemExit(main())
