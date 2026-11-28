"""远控工具注册：生成 Harness 的附加 patch，复用现有人格及通道配置。

注册参数 root 为生产根目录、python 为当前已安装依赖的控制台解释器。
默认输出 runtime/remoteControl/remoteControl.patch.yml；无私密数据，不新增网络监听。
"""

import json
from pathlib import Path


class RemoteControlRegistration:
    """为现有安装和纯净安装生成相同的远控插件注册。"""

    def __init__(self, root, python):
        """root 为生产目录，python 为 Python 可执行文件；均转为明确路径。"""
        self.root = Path(root).resolve()
        self.python = str(python)

    def build_patch(self):
        """无参数；返回本地附加 patch 路径，不修改用户人格或已有 MCP 配置。"""
        bridge = self.root / "config" / "terminalConnection.json"
        args = None
        if bridge.exists():
            cfg = json.loads(bridge.read_text(encoding="utf-8-sig"))
            entry = (self.root / cfg["repositoryRoot"]).resolve() / "terminalConnection" / "tools" / "TerminalMcp.py"
            if not entry.is_file():
                raise FileNotFoundError("终端组件入口不存在，拒绝退回旧远控链路")
            args = [str(entry), "--config", str(bridge)]
        path = self.root / "runtime" / "remoteControl" / "remoteControl.patch.yml"
        data = [{"insert": [{
            "id": "mcp-remote-cmd", "name": "@deepseek-ai/dsh-mcp-client",
            "config": {"transport": "stdio", "serverName": "remote-cmd",
                       "command": self.python,
                       "args": args,
                       "env": {"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
                       "failOnStartupError": False, "toolCallTimeoutMs": 360000}
        }]}] if args else []
        path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        if not path.exists() or path.read_text(encoding="utf-8") != text:
            temp = path.with_suffix(".tmp")
            temp.write_text(text, encoding="utf-8")
            temp.replace(path)
        return path


if __name__ == "__main__":
    import sys
    print(RemoteControlRegistration(Path(__file__).resolve().parent.parent, sys.executable).build_patch())
