"""迭代分支：为一轮自动维护在生产仓库里开一条独立分支并提交补丁，不改动工作区。

参数repo为仓库根目录，round为轮次标识（如 20261126-033002），patch为补丁文件，files为改动文件清单。

注册参数：
- branchPrefix：分支名前缀，默认 auto/iter/，方便一眼看出是自动迭代产物。
- author：虚拟提交身份，避免依赖本机 git 全局配置。
"""
import subprocess
import tempfile
from pathlib import Path


class IterationBranch:
    """把一轮补丁提交到独立分支，等主人确认后再合并到 main。"""

    branchPrefix = "auto/iter/"
    author = ("SynLoveMaintenance", "maintenance@localhost")

    def __init__(self, repo, round_id, patch_path, files, note=""):
        """repo为仓库根目录，round_id为轮次，patch_path为补丁，files为允许改动的文件。"""
        self.repo = Path(repo).resolve()
        self.round = str(round_id)
        self.patch = Path(patch_path).resolve()
        self.files = [str(name) for name in (files or [])]
        self.note = note
        self.branch = self.branchPrefix + self.round

    def git(self, *args, cwd=None):
        """args为Git参数；在指定目录执行并返回 CompletedProcess。"""
        return subprocess.run(["git", *args], cwd=str(cwd or self.repo), capture_output=True,
                              check=True, timeout=600,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def base_commit(self):
        """无参数；返回当前 HEAD 提交号，作为分支基线。"""
        return self.git("rev-parse", "HEAD").stdout.decode("utf-8").strip()

    def exists(self):
        """无参数；分支是否已存在。"""
        done = subprocess.run(["git", "rev-parse", "--verify", "--quiet", self.branch],
                              cwd=str(self.repo), capture_output=True)
        return done.returncode == 0

    def drop(self):
        """无参数；删除同名旧分支，保证同一轮可重跑。"""
        if not self.exists():
            return False
        self.git("branch", "-D", self.branch)
        return True

    def create(self):
        """无参数；用临时工作树提交补丁，返回分支名、提交号与文件数。"""
        if not self.patch.is_file() or not self.files:
            raise RuntimeError("迭代分支缺少补丁或文件清单")
        self.drop()
        work = Path(tempfile.mkdtemp(prefix="synlove-iter-"))
        tree = work / "tree"
        try:
            self.git("worktree", "add", "--detach", str(tree), "HEAD")
            self.git("checkout", "-q", "-b", self.branch, cwd=tree)
            self.git("apply", "--whitespace=nowarn", str(self.patch), cwd=tree)
            self.git("add", "--", *self.files, cwd=tree)
            message = "auto(iter): %s %s" % (self.round, self.note or "维护补丁")
            self.git("-c", "user.name=" + self.author[0], "-c", "user.email=" + self.author[1],
                     "commit", "-q", "-m", message, cwd=tree)
            commit = self.git("rev-parse", "HEAD", cwd=tree).stdout.decode("utf-8").strip()
        finally:
            subprocess.run(["git", "worktree", "remove", "--force", str(tree)],
                           cwd=str(self.repo), capture_output=True)
            try:
                work.rmdir()
            except OSError:
                pass
        return {"branch": self.branch, "commit": commit, "files": len(self.files)}

    def status(self):
        """无参数；返回分支是否存在及其提交号。"""
        if not self.exists():
            return {"branch": self.branch, "exists": False}
        commit = self.git("rev-parse", self.branch).stdout.decode("utf-8").strip()
        return {"branch": self.branch, "exists": True, "commit": commit}
