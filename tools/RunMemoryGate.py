"""记忆与主动研究发版门槛：运行 Node 回归，失败即阻塞发布。参数：无。"""

import glob
import os
import shutil
import subprocess

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = [
    os.path.join("tests", "MemoryReliabilityTests.mjs"),
    os.path.join("tests", "ProactiveResearchTests.mjs"),
]


def find_node():
    """依次从环境变量、PATH、常见安装目录找 node；找不到返回 None。"""
    candidate = os.environ.get("CONSOLE_NODE")
    if candidate and os.path.isfile(candidate):
        return candidate
    found = shutil.which("node")
    if found:
        return found
    for pattern in (r"G:\runtimes\node24\*\node.exe", r"C:\Program Files\nodejs\node.exe"):
        for path in sorted(glob.glob(pattern), reverse=True):
            if os.path.isfile(path):
                return path
    return None


def main() -> int:
    """跑记忆、图谱和主动研究回归；返回 Node 的退出码。"""
    node = find_node()
    if node is None:
        print("GATE_FAIL 找不到 node，无法执行发版门槛")
        return 2
    missing = [name for name in TESTS if not os.path.isfile(os.path.join(REPO, name))]
    if missing:
        print("GATE_FAIL 缺少测试文件：" + "、".join(missing))
        return 2
    command = [node, "--test", *TESTS]
    print("RUN", " ".join(command), flush=True)
    returncode = subprocess.run(command, cwd=REPO).returncode
    if returncode == 0:
        print("GATE_PASS 记忆与主动研究回归通过")
    else:
        print("GATE_FAIL 记忆或主动研究回归失败，禁止发布")
    return returncode


if __name__ == "__main__":
    raise SystemExit(main())
