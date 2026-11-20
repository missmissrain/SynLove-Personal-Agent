"""记忆与主动研究发版门槛：运行 Node 回归，失败即阻塞发布。参数：无。"""

import os
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = [
    os.path.join("tests", "MemoryReliabilityTests.mjs"),
    os.path.join("tests", "ProactiveResearchTests.mjs"),
]


def main() -> int:
    """跑记忆、图谱和主动研究回归；返回 Node 的退出码。"""
    node = os.environ.get("CONSOLE_NODE") or shutil.which("node")
    if node is None:
        node = r"G:\runtimes\node24\node-v24.22.2-win-x64\node.EXE"
    if not os.path.isfile(node):
        print("找不到 node，无法执行发版门槛。")
        return 2
    command = [node, "--test", *TESTS]
    print("RUN", " ".join(command))
    result = subprocess.run(command, cwd=REPO)
    if result.returncode == 0:
        print("GATE_PASS 记忆与主动研究回归通过")
    else:
        print("GATE_FAIL 记忆或主动研究回归失败，禁止发布")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
