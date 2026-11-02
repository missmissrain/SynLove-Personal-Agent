"""独立发行安装器：创建隔离环境、安装锁定依赖、生成默认人格和配置，并启动 GUI。

注册参数 root：发行根目录，默认当前文件的上级目录；首次安装需要网络，不下载模型权重。
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


class BootstrapManager:
    """管理发行目录自己的依赖与配置，不读取开发机或其他项目的密钥。"""

    def __init__(self, root=None):
        """root 为独立发行根目录；所有默认路径限制在本目录内。"""
        self.root = Path(root or Path(__file__).resolve().parent.parent).resolve()
        self.python = self.root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

    def run_command(self, args, cwd=None):
        """args 为不含密钥的命令数组，cwd 为运行目录；失败立即中止安装。"""
        subprocess.run([str(arg) for arg in args], cwd=str(cwd or self.root),
                       check=True, shell=os.name == "nt" and str(args[0]).endswith(".cmd"))

    def check_runtime(self):
        """无参数；检查 Python、Node 与必要发布文件，不安装依赖或启动业务。"""
        if sys.version_info < (3, 9):
            raise RuntimeError("需要 Python 3.9 或以上版本")
        node = shutil.which("node")
        npm = shutil.which("npm")
        if not node or not npm:
            raise RuntimeError("请先安装 Node.js 24 LTS（包含 npm）")
        major = int(subprocess.check_output([node, "-p", "process.versions.node.split('.')[0]"], text=True).strip())
        if major < 24:
            raise RuntimeError("需要 Node.js 24 或以上版本")
        required = ["backend/apps/cli/lib/bin.js", "backend/package.json",
                    "config/weixinProfile.patch.example.yml", "prompts/XinAi.md"]
        for rel in required:
            if not (self.root / rel).is_file():
                raise RuntimeError("发行文件缺失：" + rel)
        return node, npm

    def initialize_config(self):
        """无参数；只创建缺失配置，保留用户已经修改的人格、密钥及模型设置。"""
        config = self.root / "config"
        for name in ("modelConfig", "secrets", "harnessTuning"):
            dest = config / (name + ".json")
            source = config / (name + ".example.json")
            if not dest.exists() and source.is_file():
                shutil.copyfile(source, dest)
        patch = config / "weixinDoubaoProfile.patch.yml"
        if not patch.exists():
            text = (config / "weixinProfile.patch.example.yml").read_text(encoding="utf-8")
            persona = (self.root / "prompts" / "XinAi.md").read_text(encoding="utf-8").rstrip()
            start = text.index("    personaPrefix: |")
            end = text.index("    personaSuffix:", start)
            text = text[:start] + "    personaPrefix: |\n" + "\n".join(
                "      " + line for line in persona.splitlines()) + "\n" + text[end:]
            text = text.replace("<项目根>", self.root.as_posix())
            # MCP 使用隔离环境自己的解释器，不依赖系统 PATH 上另一份 Python。
            text = text.replace("command: 'python'", "command: " + json.dumps(self.python.as_posix()))
            patch.write_text(text, encoding="utf-8")
        env_file = config / "console.env"
        if not env_file.exists():
            env_file.write_text("PYTHON=" + str(self.python) + "\nCONSOLE_NODE=" +
                                (shutil.which("node") or "node") + "\nDSH_MEMORY_ENGINE=cloud\n", encoding="utf-8")
        preset = self.root / "runtime" / "dsh" / ".agent-presets" / "weixin-lite"
        if not (preset / "agent.cordis.yml").exists():
            preset.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(config / "agentPresets" / "weixin-lite" / "agent.cordis.yml",
                            preset / "agent.cordis.yml")

    def install_dependencies(self, npm):
        """npm 为已检查的包管理器；安装基础 Python、后端运行依赖与桌面，不编译 Harness。"""
        sources = ["requirements.txt", "backend/package.json", "backend/package-lock.json",
                   "console/package.json", "console/package-lock.json"]
        fingerprint = hashlib.sha256(("|".join((self.root / name).read_text(encoding="utf-8")
                                               for name in sources) + sys.version).encode("utf-8")).hexdigest()
        marker = self.root / "runtime" / "installState.json"
        electron = self.root / "console" / "node_modules" / "electron" / "dist" / (
            "electron.exe" if os.name == "nt" else "electron")
        try:
            state = json.loads(marker.read_text(encoding="utf-8"))
            if (state.get("fingerprint") == fingerprint and self.python.is_file() and electron.is_file()
                    and (self.root / "backend/node_modules/@deepseek-ai/dsh").exists()):
                return
        except (OSError, ValueError):
            pass
        if not self.python.is_file():
            self.run_command([sys.executable, "-m", "venv", self.root / ".venv"])
        self.run_command([self.python, "-m", "pip", "install", "-r", "requirements.txt"])
        for directory in ("backend", "console"):
            lock = self.root / directory / "package-lock.json"
            args = [npm, "ci" if lock.exists() else "install", "--omit=dev", "--no-audit", "--no-fund"]
            if directory == "backend":
                args.append("--legacy-peer-deps")
            self.run_command(args, self.root / directory)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps({"fingerprint": fingerprint}), encoding="utf-8")

    def launch_app(self, backend=False):
        """backend 为是否只启动后台；默认打开桌面，由用户配置模型和通道后启动后台。"""
        env = dict(os.environ)
        env["PYTHONUTF8"] = "1"
        env["DSH_HOME"] = str(self.root / "runtime" / "dsh")
        env["DSH_PYTHON"] = str(self.python)
        if backend:
            self.run_command([self.python, "start_stack.py", "--skip-login"])
            return
        executable = self.root / "console" / "node_modules" / "electron" / "dist" / (
            "electron.exe" if os.name == "nt" else "electron")
        if not executable.is_file():
            raise RuntimeError("桌面依赖未安装，请重新运行安装入口")
        # Windows 的 Electron 是 GUI 子系统，但从安装器继承控制台时仍可能
        # 让启动壳保留一个黑框；明确要求后台启动并断开标准句柄。
        options = {
            "cwd": str(self.root / "console"),
            "env": env,
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
        }
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NO_WINDOW
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE
            options["startupinfo"] = startupinfo
        subprocess.Popen([str(executable), str(self.root / "console")], **options)

    def run_cli(self):
        """无参数；解析安装选项并汇报真实结果，不启动模型或发送测试消息。"""
        parser = argparse.ArgumentParser(description="SynLove 首次安装与启动")
        parser.add_argument("--check", action="store_true")
        parser.add_argument("--install-only", action="store_true")
        parser.add_argument("--backend", action="store_true")
        args = parser.parse_args()
        try:
            _, npm = self.check_runtime()
            if args.check:
                print("发行文件与运行环境检查通过")
                return 0
            self.install_dependencies(npm)
            self.initialize_config()
            if not args.install_only:
                self.launch_app(args.backend)
            print("依赖与配置准备完成")
            return 0
        except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as error:
            print("启动失败：" + str(error))
            return 1
