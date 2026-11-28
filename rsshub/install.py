"""安装本机 RSSHub：clone 上游 → pnpm install → pnpm build。

职责：
- 在 `rsshub/RSSHub` 放一份 RSSHub 检出（已存在则 git pull）；
- 装依赖并构建，产出 `dist/index.mjs` 供 start_stack.py / guardService.py 拉起。

注册参数（命令行）：
    --force    已存在时也强制重新 install + build（默认只在缺 dist 时构建）
    --repo     git 地址，默认 https://github.com/DIYgod/RSSHub.git
    --ref      分支/标签，默认 master
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
TARGET = ROOT / "RSSHub"
ENTRY = TARGET / "dist" / "index.mjs"


def run(cmd, cwd=None):
    """执行外部命令；失败抛 RuntimeError（带最后几行输出）。"""
    print("+", " ".join(cmd))
    result = subprocess.run(cmd, cwd=str(cwd or ROOT), capture_output=True, text=True,
                            encoding="utf-8", errors="replace", shell=False)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip().splitlines()[-8:]
        raise RuntimeError(f"命令失败（{result.returncode}）：{' '.join(cmd)}\n" + "\n".join(tail))
    return result.stdout


def ensure_clone(repo, ref):
    """确保 RSSHub 源码存在（不存在就 clone，存在就 fetch + 切到 ref）。"""
    if not (TARGET / "package.json").is_file():
        run(["git", "clone", "--depth", "1", "--branch", ref, repo, str(TARGET)], cwd=ROOT)
        return "cloned"
    run(["git", "fetch", "--depth", "1", "origin", ref], cwd=TARGET)
    run(["git", "checkout", "FETCH_HEAD"], cwd=TARGET)
    return "updated"


def ensure_tools():
    """检查 node / pnpm 是否可用。"""
    if not shutil.which("node"):
        raise RuntimeError("没找到 node，请先安装 Node 20+ 并加入 PATH")
    if not shutil.which("pnpm"):
        raise RuntimeError("没找到 pnpm，请先执行：npm i -g pnpm")


def build(force):
    """装依赖并构建（已有 dist 且没 force 时跳过）。"""
    if ENTRY.is_file() and not force:
        print("dist/index.mjs 已存在，跳过构建（要重建加 --force）")
        return "skipped"
    run(["pnpm", "install"], cwd=TARGET)
    run(["pnpm", "build"], cwd=TARGET)
    if not ENTRY.is_file():
        raise RuntimeError("构建完成但没找到 dist/index.mjs，请检查 RSSHub 版本与构建脚本")
    return "built"


def main(argv=None):
    """入口：安装并构建 RSSHub。"""
    parser = argparse.ArgumentParser(description="安装本机 RSSHub")
    parser.add_argument("--force", action="store_true", help="强制重新安装与构建")
    parser.add_argument("--repo", default="https://github.com/DIYgod/RSSHub.git", help="git 仓库地址")
    parser.add_argument("--ref", default="master", help="分支或标签")
    args = parser.parse_args(argv)

    ensure_tools()
    print("源码：", ensure_clone(args.repo, args.ref))
    print("构建：", build(args.force))
    print("完成：", ENTRY)
    print("启动：", "在项目根执行 python start_stack.py（会自动拉起 1200 端口）")


if __name__ == "__main__":
    main()
