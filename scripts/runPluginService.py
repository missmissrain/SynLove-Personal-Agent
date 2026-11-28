"""启动插件微服务。参数：无。由计划任务 SynLove-PluginService 调用。"""
import io
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent / "terminal-pc"))
sys.path.insert(0, str(ROOT.parent / "backend-service"))

from services.LogBus import bind, capture_stdio, install_excepthook  # noqa: E402
from plugins.PluginService import PluginService  # noqa: E402

LOG = bind("plugins", ROOT)
capture_stdio("plugins", ROOT)
install_excepthook(LOG)
LOG.info("服务启动 runPluginService.py")


def _bind_output():
    """无参数；pythonw 下把标准输出接到 runtime/plugins.log，供依赖 reconfigure 的模块使用。"""
    if sys.stdout is not None and sys.stderr is not None:
        return
    path = ROOT / "runtime" / "plugins.log"
    path.parent.mkdir(parents=True, exist_ok=True)
    stream = io.TextIOWrapper(open(path, "ab", buffering=0), encoding="utf-8",
                              line_buffering=True)
    sys.stdout = sys.stdout or stream
    sys.stderr = sys.stderr or stream


def main():
    """无参数；常驻运行插件服务。"""
    service = PluginService(ROOT)
    print("plugin service on %s:%d" % (service.host, service.port), flush=True)
    service.serve_forever()


if __name__ == "__main__":
    main()
