"""记忆与主动研究发版门槛：运行 Node 回归，失败即阻塞发布。参数：无。"""

import glob
import os
import shutil
import subprocess
import sys

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


def summarize(text, limit=800):
    """取输出末尾的非空行，压成一行，供 CI 注解展示。"""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    joined = " / ".join(lines[-6:])
    return joined[:limit]


def annotate(message):
    """在 GitHub Actions 里输出 error 注解；本地运行只是普通打印。"""
    print("::error title=MemoryGate::" + message.replace("\n", "%0A").replace("\r", ""), flush=True)


def main() -> int:
    """跑记忆、图谱和主动研究回归；返回 Node 的退出码。"""
    # Windows 控制台默认是 GBK/cp1252，Node 的 TAP 输出带 ✔/✖，不转 UTF-8 会直接抛 UnicodeEncodeError。
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    node = find_node()
    if node is None:
        annotate("找不到 node，无法执行发版门槛")
        print("GATE_FAIL 找不到 node，无法执行发版门槛")
        return 2
    missing = [name for name in TESTS if not os.path.isfile(os.path.join(REPO, name))]
    if missing:
        annotate("缺少测试文件：" + "、".join(missing))
        print("GATE_FAIL 缺少测试文件：" + "、".join(missing))
        return 2
    command = [node, "--test", *TESTS]
    print("RUN", " ".join(command), flush=True)
    result = subprocess.run(command, cwd=REPO, capture_output=True, text=True,
                            encoding="utf-8", errors="replace")
    print(result.stdout or "", flush=True)
    if result.stderr:
        print(result.stderr, flush=True)
    if result.returncode == 0:
        print("GATE_PASS 记忆与主动研究回归通过")
        return 0
    annotate("回归失败（exit " + str(result.returncode) + "）：" + summarize((result.stdout or "") + "\n" + (result.stderr or "")))
    print("GATE_FAIL 记忆或主动研究回归失败，禁止发布")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
