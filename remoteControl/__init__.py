"""终端组件兼容入口：主程序只保留插件注册，SSH维护类从独立终端仓库加载。

参数来自私有config/terminalConnection.json的repositoryRoot；未配置时不加载可选组件。
"""
import json
from pathlib import Path

_bridge = Path(__file__).resolve().parents[1] / "config" / "terminalConnection.json"
if _bridge.is_file():
    _cfg = json.loads(_bridge.read_text(encoding="utf-8-sig"))
    _folder = (_bridge.parents[1] / _cfg["repositoryRoot"]).resolve() / "remoteControl"
    if _folder.is_dir():
        __path__.append(str(_folder))
