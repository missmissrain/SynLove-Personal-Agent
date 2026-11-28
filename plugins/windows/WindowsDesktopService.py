"""Windows交互桌面服务入口：在登录用户计划任务中运行Windows MCP并记录日志。

注册参数来自config/windowsMcpConfig.json，python为已安装Windows MCP的解释器；
默认仅绑定本机回环17865，鉴权密钥仅经环境传递，工具使用服务完整集合。
"""
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlsplit


class WindowsDesktopService:
    """连接Session 0中的Agent与真实登录用户桌面，不在后台会话伪造GUI成功。"""

    def __init__(self, root=None):
        """root为固定项目目录；默认由本脚本定位，不接收模型控制。"""
        self.root = Path(root) if root else Path(__file__).resolve().parents[1]

    def run_service(self):
        """无参数；校验回环配置并以前台子进程生命周期托管服务，输出写本机日志。"""
        config = json.loads((self.root / "config/windowsMcpConfig.json").read_text(encoding="utf-8-sig"))
        if not config.get("enabled"):
            return 0
        url = urlsplit(config["url"])
        if url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost") or url.path != "/mcp":
            raise ValueError("本机桌面服务必须绑定回环HTTP及/mcp路径")
        token = config.get("token", "")
        if not isinstance(token, str) or len(token) < 32:
            raise ValueError("缺少桌面服务独立凭据")
        python = Path(config["python"])
        if not python.is_file():
            raise FileNotFoundError("Windows MCP解释器不存在")
        env = dict(os.environ, WINDOWS_MCP_AUTH_KEY=token, PYTHONUTF8="1", PYTHONIOENCODING="utf-8",
                   ANONYMIZED_TELEMETRY="false", DO_NOT_TRACK="1")
        # 本机回环通信不经系统代理，避免既有失效代理破坏桌面MCP。
        env["NO_PROXY"] = ",".join(filter(None, [env.get("NO_PROXY", ""), "127.0.0.1", "localhost"]))
        path = self.root / "runtime/windowsMcp/desktop.log"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as log:
            result = subprocess.run([str(python), "-m", "windows_mcp", "serve",
                "--transport", "streamable-http", "--host", url.hostname, "--port", str(url.port or 17865)],
                cwd=self.root, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                creationflags=0x08000000 if os.name == "nt" else 0)
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(WindowsDesktopService().run_service())
