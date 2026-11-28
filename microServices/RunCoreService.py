"""功能：由Windows服务管理启动主项目core，加载既有服务配置并托管服务器本机能力。

注册参数无；默认根目录为主项目，端口和鉴权从config/serviceConfig.json及私有凭据读取。
不会启动终端客户端，不改变模型或其他服务的生命周期。
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class RunCoreService:
    """为计划任务提供稳定的主项目入口，避免远程会话退出带走进程。"""

    def run_service(self):
        """无参数；按既有服务注册表解析环境与鉴权，运行唯一core宿主。"""
        from services.ServiceRegistry import ServiceRegistry
        from microServices.ServiceHost import ServiceHost
        registry = ServiceRegistry()
        env = dict(os.environ)
        registry.apply_environment(env)
        os.environ.update(env)
        cfg = registry.get_service("core")
        host = ServiceHost("core", registry)
        host.serve(cfg["host"], cfg["port"])


if __name__ == "__main__":
    RunCoreService().run_service()
