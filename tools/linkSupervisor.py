"""链路自愈状态机：发现「消息进来了但回不出去 / 进来就报错」时自动重启+清状态，
推得通就提醒主人重发，连续两次救不回来就停机（不再空转）。

职责：
- `tick`：巡检每分钟调一次，扫状态库里**新出现**的失败（入站 failed_terminal、
  出站 failed_terminal）以及语义失败（preset 挂不上），命中就走一遍恢复流程；
- `recover`：调 `recoverLinks.linkRecovery`（L0 重启 → L1 清死锁 → L2 清状态库，
  preset 仍挂不上再升 L3 清上下文）；
- `repair`：重启治不好的故障交给固定 `runCodeRepair.py`，不依赖 Harness Agent；
- `notify`：恢复后用 QQ 推送一句"请重发"，推得通说明链路真回来了；
- `halt`：连续两次恢复都推不通，就停掉整套栈并写「暂停自启」标记，
  不再让巡检反复拉起来空转（那只会无限刷日志、白耗电）。

状态落盘在 `runtime/link-supervisor.json`，重启进程也不丢计数。

注册参数（构造）：
    root           工程根目录
    cooldown       两次自动恢复之间的最小间隔（秒），默认 600
    max_attempts   连续失败多少次就停机，默认 2
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from services.RuntimePaths import RuntimePaths

ROOT_DEFAULT = Path(__file__).resolve().parents[1]


class linkSupervisor:
    """把「失败 → 自愈 → 验证 → 停机」做成一个有状态、可复盘的闭环。"""

    def __init__(self, root: Path = ROOT_DEFAULT, cooldown: int = 600, max_attempts: int = 2) -> None:
        """参数 root：工程根；cooldown：恢复冷却秒数；max_attempts：停机阈值。"""
        self.root = Path(root)
        self.runtime = self.root / "runtime"
        self.state_file = self.runtime / "link-supervisor.json"
        self.log_file = self.runtime / "link-supervisor.log"
        self.state_db = RuntimePaths(self.root).state
        self.cooldown = cooldown
        self.max_attempts = max_attempts
        self.state = self._load()
        # 自修由独立固定脚本进程执行，避免 Harness Agent 未启动时无法修复。
        self._repair = {"process": None, "result": None, "request": None}

    # ---------------------------------------------------------------- 状态

    def _load(self) -> dict:
        """读状态文件；坏文件/不存在都用默认值。"""
        default = {
            "attempts": 0,            # 连续失败次数
            "phase": "healthy",       # healthy / recovered / retrying / halted
            "last_attempt_at": 0.0,
            "last_heartbeat_at": 0.0, # 上次心跳（30 分钟一条，证明状态机活着）
            "last_health": None,      # 上次心跳时的健康结论（True/False），用于状态翻转时立刻记一条
            "seen_failures": [],      # 已经处理过的失败 id（只留最近 200 个）
            "pending_failures": [],   # 冷却期间仍须保留的待恢复故障
        }
        try:
            if self.state_file.is_file():
                data = json.loads(self.state_file.read_text(encoding="utf-8"))
                default.update({key: data[key] for key in default if key in data})
        except (OSError, json.JSONDecodeError):
            pass
        return default

    def _save(self) -> None:
        """落盘状态（失败只记日志，不能因为写文件崩掉）。"""
        try:
            self.runtime.mkdir(parents=True, exist_ok=True)
            self.state["seen_failures"] = self.state["seen_failures"][-200:]
            self.state_file.write_text(json.dumps(self.state, ensure_ascii=False, indent=2),
                                       encoding="utf-8")
        except OSError as error:
            self.log(f"状态写不进去：{error}")

    def log(self, message: str) -> None:
        """打印并追加到 supervisor 日志。参数 message：内容。"""
        line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
        print(line, flush=True)
        try:
            with self.log_file.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError:
            pass

    # ---------------------------------------------------------------- 侦测

    def new_failures(self) -> list[dict]:
        """返回「上次以来新出现」的失败记录（入站失败 + 出站被拒）。

        判据：`delivery.status='failed_terminal'` 或 `outbox.status='failed_terminal'`，
        按「表名:主键」去重，只认最近 30 分钟内产生的。
        """
        if not self.state_db.is_file():
            return []
        since_ms = int(time.time() * 1000) - 30 * 60 * 1000
        seen = set(self.state["seen_failures"])
        found = []
        try:
            connection = sqlite3.connect(self.state_db, timeout=10)
            connection.row_factory = sqlite3.Row
            tables = {row["name"] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            if "delivery" in tables:
                for row in connection.execute(
                        "SELECT delivery_id AS id, last_error, received_at AS at FROM delivery "
                        "WHERE status='failed_terminal' AND received_at >= ?", (since_ms,)):
                    key = f"delivery:{row['id']}"
                    if key in seen:
                        continue
                    found.append({"key": key, "kind": "入站", "reason": row["last_error"] or "未知"})
            if "outbox" in tables:
                for row in connection.execute(
                        "SELECT outbound_id AS id, last_error, created_at AS at FROM outbox "
                        "WHERE status='failed_terminal' AND created_at >= ?", (since_ms,)):
                    key = f"outbox:{row['id']}"
                    if key in seen:
                        continue
                    found.append({"key": key, "kind": "出站", "reason": row["last_error"] or "未知"})
            connection.close()
        except sqlite3.Error as error:
            self.log(f"读状态库失败：{error}")
        return found

    # ---------------------------------------------------------------- 动作

    def recover(self) -> bool:
        """跑一遍链路恢复（L0→L2，必要时升 L3）。返回是否恢复成功。"""
        self.log("开始自动恢复：停栈 → 清死锁 → 清状态库 → 起栈 → 验证")
        try:
            sys.path.insert(0, str(self.root / "tools"))
            from recoverLinks import linkRecovery  # noqa: PLC0415 —— 惰性导入
            recovery = linkRecovery(dry_run=False, max_level="L2", wait_seconds=180)
            code = recovery.run()
            self.log(f"恢复流程结束，退出码 {code}（0=已恢复，2=超出 L0~L3 范围）")
            return code == 0
        except Exception as error:  # noqa: BLE001
            self.log(f"恢复流程异常：{error}")
            return False

    def repair(self, reason: str) -> bool:
        """重启和清状态都修不好时，让编码 agent 改代码/配置。返回是否修好（静态验证通过）。

        为什么需要这一层：L0~L3 只能修「进程卡死、死锁、状态库脏」。
        2026-10-30 的故障是 preset 里 `skills` 服务重复注册 —— 重启一百次也修不好，
        只能改配置。这类故障以前的结果是「第二次恢复失败 → 停机」。

        注意：这个方法会**阻塞**到 CLI 结束（codex 最长 30 分钟），
        巡检里请用 start_repair() 放到后台跑。

        参数 reason：故障描述（会原样进提示词）。
        """
        try:
            sys.path.insert(0, str(self.root / "tools"))
            from codeRepair import codeRepair  # noqa: PLC0415 —— 惰性导入
            agent = codeRepair(root=self.root, timeout=480, codex_timeout=1800)
            result = agent.attempt(reason, self._evidence())
            changed = len(result.get("changed") or [])
            self.log(f"自修结果：{'成功' if result['ok'] else '失败'}（{result.get('cli') or '-'}，"
                     f"改动 {changed} 个文件，{result.get('verify', '')[:80]}）")
            return bool(result.get("ok"))
        except Exception as error:  # noqa: BLE001 —— 自修自己不能把状态机带崩
            self.log(f"自修异常：{type(error).__name__}: {error}")
            return False

    def start_repair(self, reason: str) -> bool:
        """由固定脚本进程启动自修，巡检立刻返回。返回是否真的启动了。

        参数 reason：故障描述。
        """
        process = self._repair.get("process")
        if process is not None and process.poll() is None:
            self.log("上一轮自修还在跑，不重复启动")
            return False
        self._repair["result"] = None
        self.runtime.mkdir(parents=True, exist_ok=True)
        request = self.runtime / "coderepair-request.json"
        result = self.runtime / "coderepair-result.json"
        try:
            sys.path.insert(0, str(self.root / "tools"))
            from LogRedactor import LogRedactor  # noqa: PLC0415
            safe_reason = LogRedactor.redact_text(reason)
        except Exception:
            safe_reason = "脱敏失败，已隐藏故障详情"
        try:
            evidence = self._evidence()[:4000]
            request.write_text(json.dumps({
                "reason": safe_reason[:1500], "detail": evidence,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            result.unlink(missing_ok=True)
        except OSError as error:
            self.log(f"固定自修请求落盘失败：{error}")
            return False
        script = self.root / "tools" / "runCodeRepair.py"
        try:
            flags = 0x08000000 if sys.platform == "win32" else 0
            process = subprocess.Popen(
                [sys.executable, str(script), "--root", str(self.root),
                 "--request", str(request), "--result", str(result)],
                cwd=str(self.root), stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=flags,
            )
        except OSError as error:
            self.log(f"固定自修脚本启动失败：{error}")
            return False
        self._repair["process"] = process
        self._repair["request"] = request
        self.log(f"固定自修脚本已启动（PID {process.pid}，Codex 最长 30 分钟）：{safe_reason[:80]}")
        return True

    def _poll_repair(self) -> dict | None:
        """固定自修进程退出后读取结果；进程仍在运行返回 None。"""
        process = self._repair.get("process")
        if process is None:
            return None
        if process.poll() is None:
            return None
        result_path = self.runtime / "coderepair-result.json"
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            result = {"ok": False, "verify": f"固定自修脚本无结果（退出码 {process.returncode}）"}
        request = self._repair.get("request")
        if isinstance(request, Path):
            try:
                request.unlink(missing_ok=True)
            except OSError:
                pass
        self._repair["process"] = None
        self._repair["request"] = None
        self._repair["result"] = None
        return result

    def _handle_repair(self, result: dict) -> str:
        """自修返回后的处置：修好就重跑恢复并推送，修不好按次数决定停机还是再等一轮。

        参数 result：自修结果（ok / cli / changed / verify）。
        """
        if isinstance(result, bool):     # 兼容只返回布尔的实现/打桩
            result = {"ok": result, "verify": "自修流程完成" if result else "自修没修好"}

        if result.get("ok"):
            self.log("自修完成，重跑一遍恢复看是否真的好了")
            if self.recover():
                self.notify("我这边自己修好了，后台已恢复，请把你刚才那条消息重发一下。")
                self.state["attempts"] = 0
                self.state["pending_failures"] = []
                self.state["phase"] = "recovered"
                self._save()
                self.log("恢复成功且推送验证通过，已提醒主人重发")
                return "recovered"
            self.log("自修成功但恢复后仍然不通或推不出去")
        else:
            self.log(f"自修没修好：{str(result.get('verify') or '')[:120]}")

        if int(self.state["attempts"]) >= self.max_attempts:
            self.halt(f"连续 {self.state['attempts']} 次自动恢复（含自修）后仍然不通")
            return "halted"
        self.state["phase"] = "retrying"
        self._save()
        self.log("自修没解决问题，等下轮再试")
        return "retrying"

    def _evidence(self) -> str:
        """给编码 agent 的证据：最近两次恢复的日志尾部 + 探针日志里的报错行。

        只取尾巴、只取含错误关键词的行，避免把几千行日志塞进提示词。
        """
        chunks = []
        for name, keep in (("harness-run.log", 40), ("weixin-probe.log", 60),
                           ("link-supervisor.log", 15)):
            path = self.root / "runtime" / name
            if not path.is_file():
                continue
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-400:]
            except OSError:
                continue
            interesting = [line for line in lines
                           if any(word in line for word in
                                  ("error", "Error", "ERROR", "failed", "did not activate",
                                   "failed to mount", "skills", "preset"))]
            tail = interesting[-keep:] or lines[-keep:]
            chunks.append(f"### {name}（尾部）\n" + "\n".join(line[:300] for line in tail))
        from LogRedactor import LogRedactor
        return LogRedactor.redact_text("\n\n".join(chunks))[:4000]


    def notify(self, text: str) -> bool:
        """通过 QQ 推送一条消息；推送成功说明"回传通路"是通的。参数 text：内容。"""
        try:
            sys.path.insert(0, str(self.root / "tools"))
            from qq_notify import send_qq_text_message  # noqa: PLC0415
            result = send_qq_text_message(text)
            ok = bool(result.get("ok"))
            self.log(f"通知{'成功' if ok else '失败'}：{result}")
            return ok
        except Exception as error:  # noqa: BLE001
            self.log(f"通知异常：{error}")
            return False

    def halt(self, reason: str) -> None:
        """停机：停掉整套栈并写「暂停自启」标记，避免巡检把它反复拉起来空转。

        参数 reason：停机原因（写进日志与标记文件）。
        """
        self.log(f"停机：{reason}")
        try:
            subprocess.run([sys.executable, str(self.root / "tools" / "stop_stack.py")],
                           cwd=str(self.root), capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=180)
        except Exception as error:  # noqa: BLE001
            self.log(f"停栈失败：{error}")
        self.notify(f"【已停机】{reason}。我先停下不再空转，需要你回来处理。")
        self.state["phase"] = "halted"
        self._save()

    # ---------------------------------------------------------------- 心跳

    def _heartbeat(self, health: dict | None = None) -> None:
        """每 30 分钟记一条心跳，内容以**真实流量证据**为准，而不是"没抓到失败"。

        三种结论：链路正常 / 链路未验证 / **链路异常**。
        「未验证」是诚实的状态——最近没有入站消息，就没有任何证据能证明
        preset 能挂上；这时宁可说不知道，也不要假绿（也绝不为了探活去造一个假会话）。
        健康状态一旦翻转立刻记一条，不等 30 分钟。
        """
        health = health or {}
        preset_ok = health.get("preset_ok")
        gemma_ok = health.get("gemma_ok")
        detail = str(health.get("preset_detail") or "")

        parts = []
        parts.append({True: "preset 正常", False: "**preset 失败**", None: "preset 未验证"}[preset_ok])
        parts.append({True: "Gemma 正常", False: "**Gemma 失败**", None: "Gemma 未探测"}[gemma_ok])
        if preset_ok is None and detail:
            parts.append(detail[:60])

        if preset_ok is False or gemma_ok is False:
            label = "**链路异常**"
        elif preset_ok is None or gemma_ok is None:
            label = "链路未验证"
        else:
            label = "链路正常"
        ok = label == "链路正常"
        text = f"心跳：{label}（{'；'.join(parts)}；连续失败 {self.state['attempts']} 次）"

        now = time.time()
        previous = self.state.get("last_health")
        flipped = previous is not None and previous != label
        if not flipped and now - float(self.state.get("last_heartbeat_at") or 0) < 1800:
            return

        self.state["last_heartbeat_at"] = now
        self.state["last_health"] = label
        self._save()
        self.log(text)

    # ---------------------------------------------------------------- 主流程

    def tick(self, health: dict | None = None) -> str:
        """巡检每轮调用一次。返回当前阶段（healthy / recovered / retrying / halted）。

        参数 health：语义健康结论（preset_ok / preset_detail / gemma_ok）。
        **preset 挂不上必须当成故障**——那意味着欣爱根本创建不出会话，
        哪怕一条消息都没进来、`new_failures()` 空着，也不能说链路正常。
        """
        if self.state["phase"] == "halted":
            return "halted"

        health = health or {}

        # 上一轮自修如果跑完了，先处理它的结果（修好就重跑恢复，修不好决定停机）
        done = self._poll_repair()
        if done is not None:
            return self._handle_repair(done)

        # 自修还在跑：别启动第二次恢复（会互相打架），但心跳照写
        process = self._repair.get("process")
        if process is not None and process.poll() is None:
            self._heartbeat(health)
            return self.state["phase"]

        failures = self.new_failures()

        if health.get("preset_ok") is False:
            key = f"preset:{int(float(health.get('preset_at') or 0))}"
            if key not in set(self.state["seen_failures"]):
                failures.append({
                    "key": key,
                    "kind": "语义",
                    "reason": f"preset 挂载失败（欣爱起不来）：{str(health.get('preset_detail') or '')[:140]}",
                })

        pending = {item["key"]: item for item in self.state.get("pending_failures", [])}
        pending.update({item["key"]: item for item in failures})
        failures = list(pending.values())[-200:]
        if not failures and self.state["phase"] == "retrying":
            failures = [{"key": "retry:unresolved", "kind": "恢复", "reason": "上一轮恢复仍未完成"}]
        self.state["pending_failures"] = failures
        if not failures:
            self._heartbeat(health)
            return self.state["phase"]

        seen = set(self.state["seen_failures"])
        for item in failures:
            if item["key"] not in seen:
                self.state["seen_failures"].append(item["key"])
                self.log(f"发现{item['kind']}失败：{item['reason'][:120]}")
        self._save()

        # 冷却：刚恢复过就别马上再来一次（否则会陷入重启风暴）
        if time.time() - float(self.state["last_attempt_at"]) < self.cooldown:
            self.log(f"距上次恢复不足 {self.cooldown} 秒，本轮只记录不动手")
            return self.state["phase"]

        attempt = int(self.state["attempts"]) + 1
        self.state["attempts"] = attempt
        self.state["last_attempt_at"] = time.time()
        self._save()

        self.log(f"第 {attempt} 次自动恢复（阈值 {self.max_attempts}）")
        recovered = self.recover()

        # 恢复失败后异步提交故障单；不能把恢复失败直接断言为代码错误。
        if not recovered:
            reason = failures[0]["reason"] if failures else "链路恢复失败"
            if self.start_repair(reason):
                self.state["phase"] = "retrying"
                self._save()
                return "retrying"

        if recovered:
            pushed = self.notify("我这边刚自动恢复过，链路已经通了，请把你刚才那条消息重发一下。")
        else:
            pushed = False

        if recovered:
            self.state["attempts"] = 0
            self.state["phase"] = "recovered"
            self.state["pending_failures"] = []
            self._save()
            self.log("恢复成功且推送验证通过，已提醒主人重发" if pushed
                     else "后台恢复验证成功，通知未送达；保留运行，不因推送失败停机")
            return "recovered"

        # 只有后台恢复验证本身失败才累计停机阈值。
        if attempt >= self.max_attempts:
            self.halt(f"连续 {attempt} 次后台恢复验证失败，已停止空转")
            return "halted"

        self.state["phase"] = "retrying"
        self._save()
        self.log(f"第 {attempt} 次恢复后仍不通，等下轮再试（最多 {self.max_attempts} 次）")
        return "retrying"

    def status(self) -> dict:
        """给运维看的当前状态。"""
        return {
            "phase": self.state["phase"],
            "attempts": self.state["attempts"],
            "last_attempt_at": self.state["last_attempt_at"],
            "cooldown": self.cooldown,
            "max_attempts": self.max_attempts,
        }
