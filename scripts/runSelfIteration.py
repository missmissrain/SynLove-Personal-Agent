"""启动自迭代微服务。参数：无。由计划任务 SynLove-SelfIteration 调用。"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from services.LogBus import bind, capture_stdio, install_excepthook  # noqa: E402
LOG = bind("iteration", ROOT)
capture_stdio("iteration", ROOT)
install_excepthook(LOG)
LOG.info("服务启动 runSelfIteration.py")

from iteration.SelfIterationService import SelfIterationService  # noqa: E402


def main():
    """无参数；启动调度与 HTTP 服务。"""
    service = SelfIterationService(ROOT).start()
    print("self-iteration on %s:%d" % (service.host, service.port), flush=True)
    service.serve_forever()


if __name__ == "__main__":
    main()
