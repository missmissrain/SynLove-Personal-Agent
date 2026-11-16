"""维护进程的软件定位适配器，复用终端查询而非依赖服务继承的PATH。

参数root为主仓库；config默认config/terminalConnection.json；不安装或升级软件。
"""
import importlib.util
import json
import os
from pathlib import Path


class SoftwareCommandResolver:
    """为维护任务提供本机真实CLI路径。"""

    def __init__(self, root):
        """root为生产根目录，用于读取终端仓库位置。"""
        self.root = Path(root)

    def resolve_command(self, name):
        """name为软件名；只返回可信CLI候选，找不到抛异常，不把GUI当CLI。"""
        configured = os.environ.get("SYNLOVE_" + name.upper() + "_BIN")
        if configured and Path(configured).is_file():
            return str(Path(configured))
        config = json.loads((self.root / "config/terminalConnection.json").read_text(encoding="utf-8-sig"))
        repo = Path(config.get("repositoryRoot") or self.root.parent / "SynLove-Terminal-Connection")
        if not repo.is_absolute():
            repo = self.root / repo
        script = repo / "terminalConnection/software/SoftwareLocator.py"
        spec = importlib.util.spec_from_file_location("maintenanceSoftwareLocator", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        result = module.SoftwareLocator().find_software(name)
        for row in result.get("candidates", []):
            path = Path(row["path"])
            if path.suffix.lower() not in (".exe", ".cmd", ".bat", ""):
                continue
            if row["source"] == "registry:Uninstall":
                continue
            if name == "opencode" and path.stem.lower() == "opencode-cli":
                return str(path)
            if path.stem.lower() == name:
                if name == "codex" and "openai" in str(path).lower() and "bin" not in [p.lower() for p in path.parts]:
                    continue
                return str(path)
        raise RuntimeError("软件定位未找到CLI：" + name)
