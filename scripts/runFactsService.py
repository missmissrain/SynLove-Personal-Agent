"""启动事实层微服务。参数：无。由计划任务 SynLove-FactsService 调用。"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from services.LogBus import bind, capture_stdio, install_excepthook  # noqa: E402
LOG = bind("facts", ROOT)
capture_stdio("facts", ROOT)
install_excepthook(LOG)
LOG.info("服务启动 runFactsService.py")
sys.path.insert(0, str(ROOT.parent / "terminal-pc"))
sys.path.insert(0, str(ROOT.parent / "backend-service"))

from facts.FactsService import FactsService  # noqa: E402
from facts.PresenceRuntime import PresenceRuntime  # noqa: E402
from facts.ServiceWatchdog import ServiceWatchdog  # noqa: E402
from facts.ActivationRuntime import ActivationRuntime  # noqa: E402


def main():
    """无参数；读取 config/facts.json（可选）后常驻运行。"""
    import json
    config_path = ROOT / "config" / "facts.json"
    config = {}
    if config_path.is_file():
        config = json.loads(config_path.read_text("utf-8-sig"))
    reasoning_path = ROOT / "config" / "presenceReasoning.json"
    reasoning = (json.loads(reasoning_path.read_text("utf-8-sig"))
                 if reasoning_path.is_file() else {})
    runtime = PresenceRuntime(ROOT, config=reasoning).start()
    watchdog = ServiceWatchdog(ROOT).start()
    activation = ActivationRuntime(ROOT).start()
    service = FactsService(ROOT, host=config.get("host", "127.0.0.1"),
                           port=int(config.get("port", 8794)))
    service.watchdog = watchdog
    service.activation = activation
    print("facts service on %s:%d" % (service.host, service.port), flush=True)
    service.serve_forever()


if __name__ == "__main__":
    main()
