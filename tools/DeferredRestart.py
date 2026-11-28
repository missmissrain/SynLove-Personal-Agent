"""延迟重启栈：让调用方（例如 MCP 工具）先拿到返回结果，再停掉并拉起整套服务。

参数：--delay 秒，默认 20；--reason 文本，写入日志。
由 tools/ApplyIteration.py 在应用补丁后以分离进程启动。
"""
import argparse
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / "runtime" / "deferred-restart.log"


def log(message):
    """把一行写入重启日志，便于事后确认。"""
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), message))


def main():
    """无参数；等待指定秒数后停栈并重新拉起。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--delay", type=int, default=20)
    parser.add_argument("--reason", default="应用自动迭代")
    args = parser.parse_args()
    log("等待 %d 秒后重启：%s" % (args.delay, args.reason))
    time.sleep(max(1, args.delay))
    sys.path.insert(0, str(ROOT))
    try:
        from tools.stop_stack import kill_harness
        killed = kill_harness()
        log("已停止：%s" % (killed,))
    except Exception as error:
        log("停止失败：%s" % type(error).__name__)
    lock = ROOT / "runtime" / "stack-recovery2.lock"
    if lock.is_file():
        try:
            lock.unlink()
        except OSError:
            pass
    code = subprocess.run(["schtasks", "/Run", "/TN", "SynLove-StartNow"],
                          capture_output=True).returncode
    log("启动任务返回 %d" % code)


if __name__ == "__main__":
    main()
