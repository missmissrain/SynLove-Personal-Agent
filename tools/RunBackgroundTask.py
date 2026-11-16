"""无黑窗计划任务入口：先重定向日志，再运行固定夜间维护或技能复盘脚本。

参数task只允许skills或maintenance；用现有pythonw启动，复用当前解释器依赖。
"""
import argparse
import os
import runpy
import sys
from pathlib import Path


def main():
    """参数task选择固定脚本，日志写runtime，不接受任意命令或程序路径。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", choices=("skills", "maintenance"), required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    os.chdir(root)
    sys.path.insert(0, str(root))
    file = root / "runtime" / (args.task + "-scheduled.log")
    file.parent.mkdir(parents=True, exist_ok=True)
    with file.open("a", encoding="utf-8", buffering=1) as output:
        sys.stdout = sys.stderr = output
        target = root / ("skills/skillReviewService.py" if args.task == "skills" else "tools/RunNightlyMaintenance.py")
        sys.argv = [str(target)]
        runpy.run_path(str(target), run_name="__main__")


if __name__ == "__main__":
    main()
