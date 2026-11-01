"""链路一键恢复：把「看起来活着其实没用」的微信/QQ 链路拉回可用。

覆盖的层级（配置层面的问题不在此列，那是改文件的事）：
    L0  停栈 → 重新起栈            解决进程死、端口不通、网关状态坏、事件循环卡死
    L1  清死掉的 pid / lock 文件    解决「上次被强杀留下的 pid 挡住启动」
    L2  清链路状态库                解决消息堵死、投递卡住、游标错乱（**不动长期记忆**）
    L3  清会话上下文（按需）        解决上下文撑爆、会话文件写坏（**不动长期记忆**）

流程是「先修能修的，再用事实决定要不要更狠」：
    停栈 → L1 → L2 → 起栈 → 等端口 → 用 reload-preset 验证；
    验证不过才做 L3，然后再验证一次。这样平时不会白丢对话记忆。

注册参数（命令行）：
    --dry-run        只打印会做什么，不改任何东西
    --level L0/L1/L2 做到哪一层（默认 L2；L3 是验证失败后的自动升级）
    --clear-context  不管验证结果，直接清一次上下文
    --timeout 180    等端口就绪的秒数

用法：
    python tools\\recoverLinks.py            # 常规恢复（L0→L2，失败自动升 L3）
    python tools\\recoverLinks.py --dry-run  # 先看看会做什么
"""

from __future__ import annotations

import argparse
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

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "runtime"
LOG = RUNTIME / "recovery.log"
PAUSE_MARKER = RUNTIME / "guardian.pause"
STATE_DB = Path(os.environ.get("DSH_WEIXIN_STATE_DB") or
                Path(os.environ.get("DSH_HOME") or ROOT / "runtime/dsh") / "weixin-state.db")
HARNESS_PORT = int(os.environ.get("DSH_HARNESS_PORT") or "3080")
INJECT_PORT = int(os.environ.get("DSH_WEIXIN_INJECT_PORT") or "3081")


def port_open(port: int, timeout: float = 1.0) -> bool:
    """端口是否可连。参数 port：端口号。"""
    with socket.socket() as probe:
        probe.settimeout(timeout)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def process_alive(pid: int) -> bool:
    """pid 是否存活。参数 pid：进程号；<=0 直接判死。

    起 tasklist 时隐藏窗口：这个函数会被反复调用，不隐藏就会在屏幕上闪 cmd。
    """
    if pid <= 0:
        return False
    try:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                             capture_output=True, text=True, encoding="utf-8",
                             errors="replace", timeout=15,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return str(pid) in (out.stdout or "")
    except (OSError, subprocess.SubprocessError):
        return False


class linkRecovery:
    """按 L0→L2（必要时 L3）顺序恢复链路，并用真实探针判断有没有修好。"""

    def __init__(self, dry_run: bool = False, max_level: str = "L2",
                 force_context: bool = False, wait_seconds: int = 180,
                 hard: bool = False) -> None:
        """参数 dry_run：只说不做；max_level：常规步骤做到哪层；
        force_context：直接清上下文；hard：L2 全清状态库（含游标）。"""
        self.dry_run = dry_run
        self.max_level = max_level.upper()
        self.force_context = force_context
        self.wait_seconds = wait_seconds
        self.hard = hard
        self.actions: list[str] = []

    # ---------------------------------------------------------------- 日志

    def say(self, message: str) -> None:
        """打印并写日志（写不进去只降级，不能因为日志崩掉恢复流程）。"""
        line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
        print(line, flush=True)
        if self.dry_run:
            return
        try:
            RUNTIME.mkdir(parents=True, exist_ok=True)
            with LOG.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError:
            print("[warn] 日志写不进去，仅打印", file=sys.stderr)

    # ---------------------------------------------------------------- L0

    def stop_stack(self) -> None:
        """停整套栈。用 stop_stack.py 停（它会写「暂停守护」标记，避免刚停就被拉起来）。"""
        self.say("L0 停栈 …")
        if self.dry_run:
            self.actions.append("停栈：python tools/stop_stack.py")
            return
        result = subprocess.run([sys.executable, str(ROOT / "tools" / "stop_stack.py")],
                                cwd=str(ROOT), capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=180)
        for line in ((result.stdout or "") + (result.stderr or "")).splitlines()[-6:]:
            self.say("    " + line[:160])
        deadline = time.time() + 60
        while time.time() < deadline and (port_open(HARNESS_PORT) or port_open(INJECT_PORT)):
            time.sleep(1)
        alive_ports = [port for port in (HARNESS_PORT, INJECT_PORT) if port_open(port)]
        if alive_ports:
            self.say(f"    端口仍占用：{alive_ports}")
        else:
            self.say("    已停（端口已释放）")

    # ---------------------------------------------------------------- L1

    def clean_stale_locks(self) -> None:
        """删掉「pid 已经死了」的 pid 文件与启动锁；活着的一律不动。"""
        self.say("L1 清死掉的 pid / lock …")
        targets = sorted(RUNTIME.glob("*.pid")) + [RUNTIME / "stack.lock"]
        removed = 0
        for path in targets:
            if not path.is_file():
                continue
            try:
                pid = int((path.read_text(encoding="utf-8") or "0").strip() or 0)
            except (OSError, ValueError):
                pid = 0
            if pid > 0 and process_alive(pid):
                self.say(f"    {path.name}: pid={pid} 还活着，保留")
                continue
            self.say(f"    {path.name}: pid={pid} 已死 → {'会删除' if self.dry_run else '删除'}")
            removed += 1
            if not self.dry_run:
                try:
                    path.unlink()
                except OSError as error:
                    self.say(f"      删除失败：{error}")
        if removed == 0:
            self.say("    没有需要清理的残留")

    # ---------------------------------------------------------------- L2

    def reset_state_db(self) -> None:
        """清链路状态库。

        分两档：
        - 默认（安全）：只删**非终态**的行（真卡住的那种），保留 `sent` / `injected`
          这些终态历史——它们还被用作「这条已经发过」的去重依据，删了会重复推送。
        - `--hard`：调 reset_weixin_state.py 全清（连微信游标一起），
          代价是旧消息可能被重新拉一遍。
        """
        self.say("L2 清链路状态库 …")
        if not STATE_DB.is_file():
            self.say("    状态库不存在，跳过")
            return

        if self.hard:
            command = [sys.executable, str(ROOT / "tools" / "reset_weixin_state.py")]
            if self.dry_run:
                command.append("--dry-run")
            result = subprocess.run(command, cwd=str(ROOT), capture_output=True, text=True,
                                    encoding="utf-8", errors="replace", timeout=120)
            for line in ((result.stdout or "") + (result.stderr or "")).splitlines():
                if line.strip():
                    self.say("    " + line.strip()[:160])
            return

        terminal = ("sent", "injected", "failed_terminal", "done", "delivered", "failed")
        placeholders = ",".join("?" for _ in terminal)
        try:
            connection = sqlite3.connect(STATE_DB, timeout=15)
            connection.row_factory = sqlite3.Row
            tables = {row["name"] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            removed_total = 0
            for table in ("outbox", "delivery"):
                if table not in tables:
                    continue
                stuck = connection.execute(
                    f"SELECT COUNT(*) AS c FROM {table} WHERE status NOT IN ({placeholders})",
                    terminal).fetchone()["c"]
                self.say(f"    {table}: 非终态（真卡住）{stuck} 行")
                if stuck and not self.dry_run:
                    connection.execute(
                        f"DELETE FROM {table} WHERE status NOT IN ({placeholders})", terminal)
                    removed_total += stuck
            if self.dry_run:
                self.say("    （dry-run，不实际删除）")
            else:
                connection.commit()
                self.say(f"    已清理 {removed_total} 行；终态历史与微信游标都保留")
            connection.close()
        except sqlite3.Error as error:
            self.say(f"    数据库操作失败：{error}")

    # ---------------------------------------------------------------- 起栈

    def start_stack(self) -> None:
        """重新起栈（后台拉起，然后轮询端口）。"""
        self.say("L0 起栈 …")
        if self.dry_run:
            self.actions.append("起栈：python start_stack.py")
            return
        # 先撤掉「暂停守护」标记，否则控制台的守护不会帮忙兜底
        try:
            if PAUSE_MARKER.exists():
                PAUSE_MARKER.unlink()
                self.say("    已撤销「暂停自动重启」标记")
        except OSError:
            pass
        flags = 0x08000000 | 0x00000008 if os.name == "nt" else 0
        subprocess.Popen([sys.executable, str(ROOT / "start_stack.py")], cwd=str(ROOT),
                         creationflags=flags, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        if self.wait_ready():
            self.say("    端口已就绪")
        else:
            self.say(f"    {self.wait_seconds} 秒内端口没起来（看 runtime/harness-run.log）")

    def wait_ready(self) -> bool:
        """轮询等 3080/3081 就绪。"""
        deadline = time.time() + self.wait_seconds
        while time.time() < deadline:
            if port_open(HARNESS_PORT) and port_open(INJECT_PORT):
                return True
            time.sleep(3)
        return False

    # ---------------------------------------------------------------- 验证 / L3

    def verify(self, attempts: int = 3) -> bool:
        """用 reload-preset 验证 preset 能不能真的挂上（等价于消息能不能处理）。

        参数 attempts：重试次数——刚起栈时 harness 可能还没完全就绪。
        """
        self.say("验证：preset 能否挂载 …")
        if self.dry_run:
            self.actions.append("验证：POST /admin/reload-preset")
            return True
        for index in range(1, attempts + 1):
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{INJECT_PORT}/admin/reload-preset",
                    data=b"{}", method="POST",
                    headers={"content-type": "application/json"})
                with urllib.request.urlopen(request, timeout=120) as response:
                    body = json.loads(response.read().decode("utf-8", "replace"))
                if body.get("ok") is True:
                    self.say(f"    第 {index} 次：通过 {body}")
                    return True
                self.say(f"    第 {index} 次：未通过 {str(body)[:200]}")
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", "replace")[:200]
                self.say(f"    第 {index} 次：HTTP {error.code} {detail}")
            except Exception as error:  # noqa: BLE001
                self.say(f"    第 {index} 次：异常 {error}")
            time.sleep(10)
        return False

    def clear_context(self) -> bool:
        """清所有用户的会话上下文（不动长期记忆）。返回是否成功。"""
        self.say("L3 清会话上下文 …")
        if self.dry_run:
            self.actions.append("清上下文：POST /admin/clear-context")
            return True
        try:
            request = urllib.request.Request(
                f"http://127.0.0.1:{INJECT_PORT}/admin/clear-context",
                data=b"{}", method="POST",
                headers={"content-type": "application/json"})
            with urllib.request.urlopen(request, timeout=120) as response:
                body = json.loads(response.read().decode("utf-8", "replace"))
            self.say(f"    结果：{json.dumps(body, ensure_ascii=False)[:300]}")
            return True
        except Exception as error:  # noqa: BLE001
            self.say(f"    失败：{error}")
            return False

    # ---------------------------------------------------------------- 主流程

    def run(self) -> int:
        """执行恢复流程，返回 0 表示链路已恢复可用。"""
        self.say("=" * 60)
        self.say(f"链路恢复开始（dry_run={self.dry_run}，常规做到 {self.max_level}）")

        self.stop_stack()
        if self.max_level in ("L1", "L2", "L3"):
            self.clean_stale_locks()
        if self.max_level in ("L2", "L3"):
            self.reset_state_db()

        self.start_stack()

        if self.dry_run:
            self.verify()
            self.say("dry-run 结束：会执行 " + "；".join(self.actions))
            return 0

        ok = self.verify()
        if ok and not self.force_context:
            self.say("结论：链路已恢复（L0→L2 就够，没有丢上下文）")
            return 0

        if self.force_context or not ok:
            self.say("preset 仍挂不上，升级到 L3（清上下文后重试）")
            self.clear_context()
            ok = self.verify()

        if ok:
            self.say("结论：链路已恢复（升级到 L3，对话上下文已清空，长期记忆未动）")
            return 0

        self.say("结论：仍然不通。这已经不是 L0~L3 能修的范围了 —— "
                 "大概是 preset 配置冲突（~/.dsh/.agent-presets）或代码问题，需要人工看：")
        self.say("      runtime/harness-run.log 里搜 'did not activate' / 'failed to mount'")
        return 2


def main(argv: list[str] | None = None) -> int:
    """命令行入口。参数 argv：默认取 sys.argv。"""
    parser = argparse.ArgumentParser(description="微信/QQ 链路一键恢复（L0→L2，失败自动升 L3）")
    parser.add_argument("--dry-run", action="store_true", help="只打印计划，不改任何东西")
    parser.add_argument("--level", default="L2", choices=["L0", "L1", "L2", "L3"],
                        help="常规步骤做到哪一层，默认 L2")
    parser.add_argument("--clear-context", action="store_true", help="直接清一次上下文")
    parser.add_argument("--hard", action="store_true",
                        help="L2 全清状态库（含微信游标，可能重收旧消息）")
    parser.add_argument("--timeout", type=int, default=180, help="等端口就绪的秒数")
    args = parser.parse_args(argv)

    recovery = linkRecovery(dry_run=args.dry_run, max_level=args.level,
                            force_context=args.clear_context, wait_seconds=args.timeout,
                            hard=args.hard)
    return recovery.run()


if __name__ == "__main__":
    raise SystemExit(main())
