"""核心就绪后的可选服务启动。StartupServices(root)独立进程并行预热，不阻塞微信/QQ接入。

参数root为工程根目录；继承启动器已解析的服务环境；每项失败独立记录，不重启核心。
"""

import concurrent.futures
import json
import os
import subprocess
import sys
import time
from pathlib import Path


class StartupServices:
    """单实例后台预热；用户停止系统后不再拉起新的服务。"""

    def __init__(self, root):
        """root为代码目录；使用统一服务管理器和启动锁。"""
        self.root = Path(root)

    def detach_start(self, env):
        """env为启动器已同步的环境；派生有独立日志的预热进程，返回PID。"""
        target = self.root / "runtime" / "optional-startup.log"
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("ab") as output:
            child = subprocess.Popen([sys.executable, "-u", str(Path(__file__).resolve())],
                                     cwd=str(self.root), env=env, stdin=subprocess.DEVNULL,
                                     stdout=output, stderr=output,
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                                     start_new_session=os.name != "nt")
        return child.pid

    def run_services(self):
        """无参数；持有预热锁并行启动配套服务；失败保留具体状态，绝不补拉远程服务。"""
        from microServices.ServiceLease import ServiceLease
        from microServices.ServiceManager import ServiceManager
        from services.ServiceRegistry import ServiceRegistry
        import start_stack
        registry = ServiceRegistry()
        manager = ServiceManager(self.root, registry)
        runtime = self.root / "runtime"
        lock = ServiceLease(runtime / "optional-startup.lock")
        try:
            lock.acquire()
        except RuntimeError:
            return 0
        try:
            calls = {
                "core": lambda: manager.ensure_service("core"),
                "reminders": lambda: manager.ensure_service("reminders"),
                "digest": lambda: manager.ensure_service("digest"),
                "opencode": lambda: start_stack.ensure_opencode_server(dict(os.environ)),
                "rsshub": lambda: start_stack.ensure_rsshub(dict(os.environ)),
                "guard": lambda: start_stack.ensure_guard_service(dict(os.environ)),
            }

            def start_one(item):
                """item为服务名与启动函数；只记录分类错误，详细错误留在服务自身日志中。"""
                name, call = item
                at = time.monotonic()
                if (runtime / "guardian.pause").exists():
                    return name, {"state": "cancelled", "seconds": 0}
                if name != "guard" and registry.get_service(name)["management"] != "managed":
                    return name, {"state": "external_or_disabled", "seconds": 0}
                try:
                    value = call()
                    return name, {"state": value or "ready", "seconds": round(time.monotonic() - at, 3)}
                except Exception as error:
                    print(name + ": startup failed (" + type(error).__name__ + ")", flush=True)
                    return name, {"state": "failed", "errorType": type(error).__name__,
                                  "seconds": round(time.monotonic() - at, 3)}

            with concurrent.futures.ThreadPoolExecutor(max_workers=len(calls)) as pool:
                result = dict(pool.map(start_one, calls.items()))
            (runtime / "optional-startup.json").write_text(
                json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            return 0
        finally:
            lock.close()


if __name__ == "__main__":
    project = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(project))
    raise SystemExit(StartupServices(project).run_services())
