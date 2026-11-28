"""编码服务适配。CodingAdapter(root) 仅运行固定CLI和配置中的工作区别名，不提供任意Shell。"""

import json
import os
import shutil
import subprocess


class CodingAdapter:
    """服务器编码工具与本机工作区分离；默认只允许只读查询，执行需在服务端显式授权。"""

    def __init__(self, root):
        """root为服务代码根目录；执行策略来自config/executionConfig.json。"""
        self.root = root
        path = root / "config" / "executionConfig.json"
        self.config = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {
            "allowRun": False, "workspaces": {}}

    def handle(self, message):
        """message为MCP请求；保持两个服务器工具的固定操作集合。"""
        request_id = message.get("id")
        if message.get("method") == "tools/list":
            tools = []
            for engine in ("codex", "opencode"):
                tools.append({"name": "server_" + engine,
                              "description": "在配置的服务端工作区执行" + engine + "；路径属于服务端。",
                              "inputSchema": {"type": "object", "properties": {
                                  "action": {"type": "string", "enum": ["run", "list_sessions", "stats"]},
                                  "workspace": {"type": "string", "description": "服务端配置的工作区别名"},
                                  "prompt": {"type": "string"},
                                  "sessionId": {"type": "string"}},
                                  "required": ["action"]}})
            return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": tools}}
        params = message.get("params", {})
        name = params.get("name")
        if name not in ("server_codex", "server_opencode"):
            raise ValueError("未知编码工具")
        engine = name.removeprefix("server_")
        args = params.get("arguments", {})
        action = args.get("action")
        binary = self.config.get("binaries", {}).get(engine) or shutil.which(engine)
        if not binary:
            raise RuntimeError(engine + "未安装或未配置")
        if action == "run":
            if self.config.get("allowRun") is not True:
                raise ValueError("服务端尚未开启编码执行")
            workspace = self.config.get("workspaces", {}).get(args.get("workspace"))
            if not workspace:
                raise ValueError("必须指定已配置的服务端工作区别名")
            prompt = str(args.get("prompt", "")).strip()
            if not prompt or len(prompt) > 100000:
                raise ValueError("prompt为空或过长")
            if engine == "codex":
                command = [binary, "exec", "--skip-git-repo-check", "--json",
                           "-s", "workspace-write", prompt]
                if args.get("sessionId"):
                    raise ValueError("服务端Codex续会话尚未配置；请使用新的明确任务")
            else:
                command = [binary, "run", "--auto", "--dir", workspace]
                if args.get("sessionId"):
                    command += ["--fork", "-s", str(args["sessionId"])]
                command += [prompt]
            cwd = workspace
        elif engine == "opencode" and action in ("list_sessions", "stats"):
            command = [binary] + (["session", "list"] if action == "list_sessions" else ["stats"])
            cwd = str(self.root)
        else:
            raise ValueError("该引擎不支持此操作")
        if os.name == "nt" and str(binary).lower().endswith((".cmd", ".bat", ".ps1")):
            raise ValueError("服务端请配置原生可执行文件，禁止Shell包装器")
        # CLI认证从它自己的配置读取，剥离服务和模型密钥，防止编码输出泄露它们。
        env = {key: value for key, value in os.environ.items()
               if not any(word in key.upper() for word in ("KEY", "SECRET", "TOKEN", "PASSWORD"))}
        result = subprocess.run(command, cwd=cwd, stdin=subprocess.DEVNULL,
                                capture_output=True, timeout=1700, env=env)
        text = result.stdout.decode("utf-8", errors="replace")[-20000:]
        if result.returncode:
            text = f"编码失败，退出码{result.returncode}；" + text
        return {"jsonrpc": "2.0", "id": request_id, "result": {
            "content": [{"type": "text", "text": text}], "isError": result.returncode != 0}}
