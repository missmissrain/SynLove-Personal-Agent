"""仓库维护隔离区：复制当前源码作为基线，检查补丁后按原文件哈希应用。

参数source为实际代码目录，work为独占工作目录；默认不复制运行数据、配置密钥、模型和依赖。
只允许既有文本源码的修改与新增，自动应用不允许删除；生产目录可以有用户的未提交修改。
"""
import hashlib
import os
import shutil
import subprocess
from pathlib import Path


class RepositoryWorkspace:
    """把当前生产源码隔离，保留基线和补丁，防止覆盖并发人工改动。"""

    skip = {".git", ".venv", "venv", "node_modules", "__pycache__", "runtime",
            "models", "privatekeys", "backup", "backups", ".codex", ".workbuddy", "logs",
            "dist", ".cache", "assets", "public", "artreview"}
    skip.update({"备份", "分发包", "vendor", "rsshub", "kugou", "thirdparty", "third_party"})
    extensions = {".py", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md",
                  ".css", ".html", ".yml", ".yaml", ".toml", ".ps1", ".cmd", ".txt"}

    def __init__(self, source, work):
        """source为实际源码根目录，work为本轮隔离目录，必须尚不存在。"""
        self.source, self.work = Path(source).resolve(), Path(work).resolve()
        self.hashes = {}

    @classmethod
    def allowed_path(cls, rel):
        """rel为相对文件路径；拒绝密钥、配置、二进制、目录逃逸和启动持久化脚本。"""
        path = Path(rel)
        name = path.name.lower()
        return (not path.is_absolute() and ".." not in path.parts
                and (not path.parts or path.parts[0].lower() != "config")
                and not ("config" in [p.lower() for p in path.parts[:-1]]
                         and path.suffix.lower() in {".json", ".yaml", ".yml", ".toml"})
                and not any(p.lower() in cls.skip or p.startswith(".") for p in path.parts)
                and path.suffix.lower() in cls.extensions
                and not any(s in name for s in ("secret", "credential", "token", ".env", "pairing"))
                and not path.suffix.lower() in {".cmd", ".ps1"})

    @staticmethod
    def file_hash(path):
        """path为普通文件；返回内容哈希，文件不存在时返回None。"""
        return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None

    def git_run(self, *args):
        """args为Git参数数组；只在隔离目录执行并检查返回码。"""
        return subprocess.run(["git", *args], cwd=self.work, capture_output=True,
                              check=True, timeout=90, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def prepare_workspace(self):
        """复制当前有效源码并创建本轮基线提交；不读取凭据，不修改原仓库Git状态。"""
        self.work.mkdir(parents=True, exist_ok=False)
        total = 0
        for folder, dirs, files in os.walk(self.source, followlinks=False):
            dirs[:] = [d for d in dirs if d.lower() not in self.skip and not d.startswith(".")
                       and not (Path(folder) == self.source and d.lower() == "config")
                       and not (Path(folder) / d).is_symlink()
                       and not (getattr((Path(folder) / d).stat(), "st_file_attributes", 0) & 0x400)]
            for name in files:
                src = Path(folder) / name
                rel = src.relative_to(self.source)
                if not self.allowed_path(rel) or src.is_symlink() or src.stat().st_size > 2 * 1024 * 1024:
                    continue
                total += src.stat().st_size
                if total > 100 * 1024 * 1024 or len(self.hashes) >= 10000:
                    raise RuntimeError("源码快照超过预算")
                dest = self.work / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
                self.hashes[rel.as_posix()] = self.file_hash(src)
        self.git_run("init", "-q")
        self.git_run("add", ".")
        self.git_run("-c", "user.name=SynLoveMaintenance", "-c", "user.email=maintenance@localhost",
                     "commit", "-qm", "Current source snapshot")
        return {"files": len(self.hashes), "bytes": total}

    def collect_patch(self, patch_path):
        """patch_path为私有补丁输出；拒绝越界文件和删除，返回修改文件名列表。"""
        self.git_run("add", "-N", ".")
        names = self.git_run("diff", "HEAD", "--name-only", "-z").stdout.decode("utf-8").split("\0")
        names = [n for n in names if n]
        for name in names:
            path = self.work / name
            if not self.allowed_path(name) or not path.is_file() or path.is_symlink():
                raise RuntimeError("自动维护补丁包含禁止修改的文件：" + name)
        if len(names) > 20:
            raise RuntimeError("单轮维护改动超过20个文件，保留隔离区供人工审阅")
        patch = self.git_run("diff", "HEAD", "--binary").stdout
        if len(patch) > 2 * 1024 * 1024:
            raise RuntimeError("维护补丁超过2MiB，需要人工审阅")
        Path(patch_path).write_bytes(patch)
        return names

    def apply_patch(self, patch_path, names):
        """patch_path为已验证补丁，names为改动清单；原文件哈希变化则拒绝覆盖。"""
        if not Path(patch_path).is_file():
            raise RuntimeError("补丁交付物不存在")
        for name in names:
            if self.file_hash(self.source / name) != self.hashes.get(name):
                raise RuntimeError("源文件在维护期间被修改，取消应用：" + name)
        # 不调用生产Git：部署目录可能位于另一个Git工程的子目录，git apply会静默跳过路径。
        backup = self.work.parent / "productionBackup"
        applied = []
        try:
            for name in names:
                dest = self.source / name
                if not self.allowed_path(name):
                    raise RuntimeError("禁止应用的路径：" + name)
                for parent in [dest, *list(dest.parents)[:len(Path(name).parts)]]:
                    if parent.is_symlink() or (parent.exists() and getattr(parent.stat(), "st_file_attributes", 0) & 0x400):
                        raise RuntimeError("源目录包含链接或重解析点")
                if self.file_hash(dest) != self.hashes.get(name):
                    raise RuntimeError("应用前文件发生变化：" + name)
                saved = backup / name
                if dest.exists():
                    saved.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(dest, saved)
                dest.parent.mkdir(parents=True, exist_ok=True)
                staged = dest.with_name(dest.name + ".synloveMaintenance.tmp")
                with staged.open("xb") as stream:
                    stream.write((self.work / name).read_bytes())
                os.replace(staged, dest)
                applied.append(name)
        except Exception:
            for name in reversed(applied):
                dest, saved = self.source / name, backup / name
                if self.file_hash(dest) == self.file_hash(self.work / name):
                    if saved.exists():
                        shutil.copy2(saved, dest)
                    else:
                        dest.unlink()
            raise
