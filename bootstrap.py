"""首次安装与启动入口：委托 BootstrapManager 管理依赖、默认配置和桌面启动。

参数 --check 仅检查文件；--install-only 仅安装；--backend 安装后启动后端；默认打开桌面。
"""
from installer.BootstrapManager import BootstrapManager


if __name__ == "__main__":
    raise SystemExit(BootstrapManager().run_cli())
