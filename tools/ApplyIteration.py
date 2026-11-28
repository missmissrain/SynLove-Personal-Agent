"""按轮次把自动迭代分支的改动落到生产、提交 main、推送 GitHub，并可重启实例。

用法：
  python tools/ApplyIteration.py --list             # 查看待确认的轮次与分支
  python tools/ApplyIteration.py --apply            # 应用最新待确认轮次
  python tools/ApplyIteration.py --apply 20261126-033002
  python tools/ApplyIteration.py --apply --no-restart
  python tools/ApplyIteration.py --discard          # 丢弃最新待确认轮次

注册参数：
- root：仓库根目录，默认脚本上两级。
- 轮次档案：runtime/nightlyMaintenance/rounds/<轮次>.json
- 补丁位置：runtime/nightlyMaintenance/<轮次>/<仓库名>/changes.patch
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAINT = ROOT / "runtime" / "nightlyMaintenance"
ROUNDS = MAINT / "rounds"
PENDING = MAINT / "pending.json"


def git(repo, *args, check=True, timeout=900):
    """repo为仓库目录，args为Git参数；返回 CompletedProcess。"""
    return subprocess.run(["git", *args], cwd=str(repo), capture_output=True, check=check,
                          timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def latest_round(explicit=None):
    """explicit为指定轮次；为空时读取 pending.json，再退回最新的轮次档案。"""
    if explicit:
        return explicit
    if PENDING.is_file():
        try:
            data = json.loads(PENDING.read_text(encoding="utf-8-sig"))
            if data.get("round"):
                return str(data["round"])
        except Exception:
            pass
    if ROUNDS.is_dir():
        files = sorted(ROUNDS.glob("*.json"))
        if files:
            return files[-1].stem
    return None


def load_round(round_id):
    """round_id为轮次标识；返回轮次档案字典。"""
    path = ROUNDS / (round_id + ".json")
    if not path.is_file():
        raise SystemExit("找不到轮次档案：" + str(path))
    return json.loads(path.read_text(encoding="utf-8-sig"))


def changed_repos(record):
    """record为轮次档案；返回带分支的仓库结果列表。"""
    return [row for row in record.get("results", []) if row.get("state") == "branch_ready" and row.get("branch")]


def list_pending():
    """无参数；打印待确认轮次与分支明细。"""
    round_id = latest_round()
    if round_id is None:
        print("没有待确认的轮次")
        return
    record = load_round(round_id)
    print("轮次", round_id, "生成于", time.strftime("%m-%d %H:%M", time.localtime(record.get("created", 0))))
    for row in changed_repos(record):
        print("  %-20s 分支 %-28s %d 个文件" % (row["name"], row["branch"], len(row.get("files") or [])))
        for name in (row.get("files") or [])[:8]:
            print("      -", name)
    if record.get("report"):
        print("摘要:", record["report"].splitlines()[0][:160])


def restart_stack(seconds=None, reason="应用自动迭代"):
    """seconds为延迟秒数（None 表示立即）；延迟模式用分离进程，保证调用方先拿到返回。"""
    if seconds is not None:
        flags = 0x00000008 | 0x00000200 | 0x08000000
        subprocess.Popen([sys.executable, "-X", "utf8",
                          str(ROOT / "tools" / "DeferredRestart.py"),
                          "--delay", str(int(seconds)), "--reason", reason],
                         creationflags=flags, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, close_fds=True)
        print("重启：已安排 %d 秒后重启实例" % int(seconds))
        return
    sys.path.insert(0, str(ROOT))
    try:
        from tools.stop_stack import kill_harness
        print("重启：停止", kill_harness())
    except Exception as error:
        print("重启：停止失败", type(error).__name__)
    lock = ROOT / "runtime" / "stack-recovery2.lock"
    if lock.is_file():
        try:
            lock.unlink()
        except OSError:
            pass
    code = subprocess.run(["schtasks", "/Run", "/TN", "SynLove-StartNow"], capture_output=True).returncode
    print("重启：启动任务返回", code)


def apply_round(round_id, do_restart=True, defer_seconds=None):
    """round_id为轮次；逐仓库应用补丁、提交 main、推送，返回是否全部成功。"""
    record = load_round(round_id)
    ok_all = True
    for row in changed_repos(record):
        name, branch = row["name"], row["branch"]
        repo = Path([item["path"] for item in load_config_repos() if item["name"] == name][0])
        patch = MAINT / round_id / name / "changes.patch"
        files = row.get("files") or []
        print("=" * 60)
        print("仓库", name, "分支", branch, "文件", len(files))
        if not patch.is_file():
            print("  失败：补丁不存在", patch)
            ok_all = False
            continue
        check = git(repo, "apply", "--check", str(patch), check=False)
        if check.returncode != 0:
            print("  失败：补丁无法干净应用（生产文件已变动）")
            print("  ", check.stderr.decode("utf-8", "replace")[:200])
            ok_all = False
            continue
        git(repo, "apply", str(patch))
        git(repo, "add", "--", *files)
        message = "auto(iter): %s %s" % (round_id, row.get("headline") or "自动维护补丁")
        commit = git(repo, "commit", "-m", message, check=False)
        if commit.returncode != 0:
            print("  失败：提交未成功", commit.stderr.decode("utf-8", "replace")[:160])
            ok_all = False
            continue
        print("  已提交", git(repo, "rev-parse", "--short", "HEAD").stdout.decode().strip())
        pushed = False
        for attempt in range(1, 4):
            done = git(repo, "push", "origin", "HEAD:main", check=False)
            if done.returncode == 0:
                pushed = True
                print("  已推送 GitHub（第 %d 次）" % attempt)
                break
            print("  推送失败（第 %d 次）：%s" % (
                attempt, (done.stderr.decode("utf-8", "replace") or "").strip()[:120]))
            time.sleep(5)
        if not pushed:
            ok_all = False
            print("  推送未成功，分支保留，可稍后重试")
            continue
        git(repo, "branch", "-D", branch, check=False)
        print("  已删除临时分支", branch)
    if ok_all:
        if PENDING.is_file():
            PENDING.unlink()
        if do_restart:
            restart_stack(defer_seconds)
        print("\n全部完成。")
    else:
        print("\n有仓库未成功，pending.json 保留，可修好后再次 --apply。")
    return ok_all


def discard_round(round_id):
    """round_id为轮次；删除该轮所有分支并清掉待确认标记。"""
    record = load_round(round_id)
    for row in changed_repos(record):
        repo = Path([item["path"] for item in load_config_repos() if item["name"] == row["name"]][0])
        git(repo, "branch", "-D", row["branch"], check=False)
        print("已删除分支", row["branch"])
    if PENDING.is_file():
        PENDING.unlink()
    print("轮次", round_id, "已丢弃")


def load_config_repos():
    """无参数；读取私有维护配置里的仓库清单。"""
    path = ROOT / "config" / "nightlyMaintenance.json"
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    return [row for row in data.get("repositories", []) if row.get("path")]


def main():
    """无参数；解析命令行并执行对应动作。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--apply", nargs="?", const="", default=None)
    parser.add_argument("--discard", nargs="?", const="", default=None)
    parser.add_argument("--no-restart", action="store_true")
    parser.add_argument("--defer-restart", type=int, default=None,
                        help="延迟多少秒后重启实例（MCP 调用用，避免切断当前会话）")
    args = parser.parse_args()
    if args.list:
        list_pending()
        return
    if args.apply is not None:
        round_id = latest_round(args.apply or None)
        if round_id is None:
            raise SystemExit("没有待确认轮次")
        sys.exit(0 if apply_round(round_id, not args.no_restart, args.defer_restart) else 1)
    if args.discard is not None:
        round_id = latest_round(args.discard or None)
        if round_id is None:
            raise SystemExit("没有待确认轮次")
        discard_round(round_id)
        return
    parser.print_help()


if __name__ == "__main__":
    main()
