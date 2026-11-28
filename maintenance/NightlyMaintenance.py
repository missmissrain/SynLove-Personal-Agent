"""夜间维护调度器：按私有配置轮询仓库，独立调用Codex，验证后提交到独立分支并发送QQ回执。

参数root为主仓库；config为私有JSON。默认每3天维护全部登记仓库、单仓库900秒。
流程：隔离快照 → Codex 改代码 → 验收 → 提交 auto/iter/<轮次> 分支 → QQ 汇报并询问是否更新实例。
主人确认后由 tools/ApplyIteration.py 落到生产、提交 main 并推送 GitHub。
超时杀死本轮进程树并保留隔离区；不自动重试未知结果，不接触模型和运行凭据。
"""
import json
import os
import sqlite3
import subprocess
import sys
import time
import ast
from datetime import date
from pathlib import Path

from tools.RuntimeTelemetry import RuntimeTelemetry

from maintenance.IterationBranch import IterationBranch
from maintenance.RepositoryWorkspace import RepositoryWorkspace
from maintenance.SoftwareCommandResolver import SoftwareCommandResolver
from skills.store.durableFile import durableFile
from skills.store.runLock import runLock
from tools.LogRedactor import LogRedactor


class NightlyMaintenance:
    """独立于聊天进程的有界维护流水线。"""

    def __init__(self, root, config):
        """root为主仓库，config为已明确登记仓库与测试命令的JSON路径。"""
        self.root = Path(root)
        self.config = json.loads(Path(config).read_text(encoding="utf-8-sig"))
        self.home = self.root / "runtime/nightlyMaintenance"
        self.writer = durableFile()

    def run_process(self, args, cwd, timeout, log):
        """args为参数数组，cwd为隔离区，timeout为秒，log为私有日志；超时终止整棵进程树。"""
        with Path(log).open("w", encoding="utf-8") as output:
            child = subprocess.Popen(args, cwd=cwd, stdin=subprocess.DEVNULL, stdout=output,
                                     stderr=subprocess.STDOUT, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            try:
                return child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                                   capture_output=True, timeout=20, creationflags=0x08000000)
                else:
                    child.kill()
                child.wait(timeout=20)
                raise RuntimeError("维护任务超时，已终止本轮，补丁未应用")

    def busy_state(self):
        """检查主系统活跃任务；有后台任务时整轮推迟，避免维护争抢资源。"""
        path = self.root / "runtime/agentTasks/taskStore.sqlite"
        if not path.exists():
            return False
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5) as db:
            return db.execute("SELECT count(*) FROM agentTasks WHERE state IN ('queued','running','cancelling')").fetchone()[0] > 0

    def run_repository(self, row, folder, codex, round_id):
        """row为单仓库配置，folder为本轮私有输出目录，codex为已验证CLI，round_id为轮次标识。"""
        folder.mkdir(parents=True, exist_ok=False)
        box = RepositoryWorkspace(row["path"], folder / "source")
        snapshot = box.prepare_workspace()
        prompt = (self.root / "prompts/NightlyMaintenance.md").read_text(encoding="utf-8")
        evidence = self.home / "recentEvidence.txt"
        text = evidence.read_text(encoding="utf-8") if evidence.exists() else "本轮没有新增运行证据，检查明显缺陷；没有可靠问题就不改。"
        prompt += "\n仓库：" + row["name"] + "\n近期脱敏证据：\n" + text[:18000]
        telemetry = RuntimeTelemetry(self.root, hours=72).build()
        if telemetry:
            prompt += "\n\n" + telemetry
        checks = row.get("checks", [])
        if not checks:
            raise RuntimeError("仓库没有登记验收命令，不允许自动维护")
        from maintenance.CodexDispatcher import CodexDispatcher
        result = CodexDispatcher(self.root, self.config.get("execution", {})).execute_task(
            prompt, box.work, int(self.config.get("execution", {}).get("timeoutSec", row.get("timeoutSec", 900))))
        (folder / "summary.txt").write_text(result["text"], encoding="utf-8")
        if result["patch"]:
            received = folder / "received.patch"
            received.write_bytes(result["patch"])
            box.git_run("apply", "--check", str(received.resolve()))
            box.git_run("apply", str(received.resolve()))
        names = box.collect_patch(folder / "changes.patch")
        rejected = list(getattr(box, "rejected", []))
        if not names:
            return {"name": row["name"], "state": "unchanged", "snapshot": snapshot,
                    "rejected": rejected}
        for name in names:
            file = box.work / name
            if file.suffix == ".py":
                ast.parse(file.read_text(encoding="utf-8-sig"), filename=name)
            elif file.suffix == ".json":
                json.loads(file.read_text(encoding="utf-8-sig"))
        # 按改动范围追加回归：例如改了 webhook 就跑记忆/主动研究门槛。
        effective_checks = list(checks)
        for scope in row.get("scopeChecks", []):
            prefix = str(scope.get("prefix") or "")
            if prefix == "" or not any(name.startswith(prefix) for name in names):
                continue
            for command in scope.get("checks", []):
                if command not in effective_checks:
                    effective_checks.append(command)
        for index, command in enumerate(effective_checks):
            expanded = [str(part).replace("{python}", sys.executable).replace("{source}", row["path"]) for part in command]
            if self.run_process(expanded, box.work, 300, folder / f"check{index}.log") != 0:
                raise RuntimeError("维护补丁未通过验收，未提交分支")
        # 补丁已经过静态检查与验收，提交到独立分支等待确认；生产文件保持不动。
        branch = IterationBranch(row["path"], round_id, folder / "changes.patch", names,
                                 note=row["name"]).create()
        summary = result["text"].strip().splitlines()
        headline = next((line.strip() for line in summary if line.strip()), "")[:300]
        return {"name": row["name"], "state": "branch_ready", "files": names,
                "branch": branch["branch"], "commit": branch["commit"],
                "headline": headline, "rejected": rejected,
                "device": result["device"], "jobId": result["jobId"]}

    def build_report(self, round_id, results):
        """round_id为轮次，results为逐仓库结果；返回给主人看的变更摘要与待确认记录。"""
        lines = []
        changed = []
        for row in results:
            if row.get("state") == "branch_ready":
                changed.append(row)
                files = row.get("files") or []
                lines.append("· %s：%d 个文件（%s）" % (row["name"], len(files),
                                                     "、".join(files[:3]) + ("…" if len(files) > 3 else "")))
                if row.get("headline"):
                    lines.append("  改了什么：" + row["headline"])
            elif row.get("state") == "failed":
                lines.append("· %s：失败（%s）" % (row["name"], str(row.get("error"))[:60]))
            elif row.get("state") == "unchanged":
                lines.append("· %s：无需改动" % row["name"])
        if not changed:
            return {"round": round_id, "changed": [], "text": "本轮没有改动：" + "；".join(lines)}
        text = ("本轮自动迭代完成，已提交到分支 " + changed[0]["branch"] +
                "，生产代码没动。\n" + "\n".join(lines) +
                "\n\n要更新实例吗？回复「更新实例」我就合并、推 GitHub 并重启；回「不要」我就丢弃这些分支。")
        return {"round": round_id, "changed": changed, "text": text}

    def run_once(self, check_only=False):
        """check_only只验证配置、路径和CLI；正式运行持久锁、每日一次，错误逐仓库记录。"""
        codex = "device-routed-codex"
        if not self.config.get("enabled", True):
            return {"ok": True, "skipped": "disabled"}
        repos = [row for row in self.config.get("repositories", []) if row.get("enabled", True)]
        if not repos:
            raise RuntimeError("未登记维护仓库")
        for row in repos:
            if not Path(row["path"]).is_dir() or not row.get("checks"):
                raise RuntimeError("仓库路径或验收命令缺失：" + row["name"])
        if check_only:
            return {"ok": True, "repositories": [r["name"] for r in repos], "cli": codex}
        self.home.mkdir(parents=True, exist_ok=True)
        lock = runLock(self.home / "run.lock", stale_seconds=4 * 3600)
        if not lock.acquire():
            return {"ok": True, "skipped": "locked"}
        try:
            state_path = self.home / "state.json"
            state = self.writer.read_json(state_path)
            today = time.strftime("%Y-%m-%d")
            interval_days = max(1, int(self.config.get("intervalDays", 3)))
            last_run = state.get("lastRunDay") or state.get("lastDay")
            if last_run:
                elapsed = (date.fromisoformat(today) - date.fromisoformat(last_run)).days
                if elapsed < interval_days:
                    return {"ok": True, "skipped": "interval", "nextAfterDays": interval_days - elapsed}
            if self.busy_state():
                return {"ok": True, "skipped": "already_ran_or_busy"}
            state["lastRunDay"] = today
            if not self.writer.write_text(state_path, json.dumps(state)):
                raise RuntimeError("无法持久化本轮维护标记，停止避免重复执行")
            # 从会话与运行日志提取脱敏证据，不给Codex整个私人聊天库或配置目录。
            from skills.review.transcriptBuilder import transcriptBuilder, find_session_root
            source = find_session_root(self.root / "runtime/dsh/sessions", self.root)
            since = state.get("evidenceSince", int(time.time() * 1000) - 86400000)
            material = transcriptBuilder(source).build(since, int(time.time() * 1000), 14000) if source else {}
            logs = []
            for name in ("skill-review.log", "coderepair.log"):
                file = self.root / "runtime" / name
                if file.exists():
                    with file.open("rb") as stream:
                        stream.seek(max(0, file.stat().st_size - 6000))
                        logs.append(stream.read().decode("utf-8", "replace"))
            self.writer.write_text(self.home / "recentEvidence.txt", LogRedactor.redact_text(
                material.get("text", "") + "\n" + "\n".join(logs)))
            run = self.home / time.strftime("%Y%m%d-%H%M%S")
            round_id = run.name
            results = []
            start = int(state.get("nextRepository", 0))
            configured_limit = int(self.config.get("maxRepositoriesPerRun", 0))
            limit = len(repos) if configured_limit <= 0 else min(len(repos), configured_limit)
            for offset in range(limit):
                row = repos[(start + offset) % len(repos)]
                try:
                    results.append(self.run_repository(row, run / row["name"], codex, round_id))
                except Exception as error:
                    results.append({"name": row["name"], "state": "failed", "error": LogRedactor.redact_text(str(error))})
            state.update({"nextRepository": (start + limit) % max(1, len(repos)), "results": results,
                          "evidenceSince": material.get("processed_until", since)})
            self.writer.write_text(state_path, json.dumps(state, ensure_ascii=False, indent=2))
            # 轮次档案与待确认标记：主人确认后由 ApplyIteration 使用。
            report = self.build_report(round_id, results)
            rounds = self.home / "rounds"
            rounds.mkdir(parents=True, exist_ok=True)
            self.writer.write_text(rounds / (round_id + ".json"),
                                   json.dumps({"round": round_id, "created": time.time(),
                                               "report": report["text"], "results": results},
                                              ensure_ascii=False, indent=2))
            if report["changed"]:
                self.writer.write_text(self.home / "pending.json",
                                       json.dumps({"round": round_id, "created": time.time()},
                                                  ensure_ascii=False))
            if self.config.get("notifyQQ", True):
                try:
                    from tools.qq_notify import send_qq_text_message
                    receipt = send_qq_text_message("夜间维护：" + report["text"])
                    self.writer.write_text(run / "qqReceipt.json", json.dumps(receipt, ensure_ascii=False))
                except Exception as error:
                    self.writer.write_text(self.home / "notificationError.txt", type(error).__name__)
            return {"ok": all(row["state"] != "failed" for row in results),
                    "round": round_id, "report": report["text"], "results": results}
        finally:
            lock.release()
