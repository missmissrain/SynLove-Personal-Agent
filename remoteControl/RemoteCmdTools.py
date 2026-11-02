"""远控工具集合：列出电脑、握手探活、执行 CMD；供本机 MCP 适配器调用。

注册参数 config 为目标配置，client 为执行器；列举不联网，探活只运行固定 echo。
不向模型接受服务器地址、端口、用户名或密码，不允许修改远控配置。
"""

import json


class RemoteCmdTools:
    """提供固定工具契约和不含凭据的错误结果。"""

    def __init__(self, config, client):
        """config 为配置读取器，client 为远程命令执行器。"""
        self.config = config
        self.client = client

    def list_tools(self):
        """无参数；返回 MCP 工具定义，执行前要求显式电脑别名。"""
        target = {"type": "string", "description": "remote_cmd_list 返回的电脑别名，不可猜测"}
        return [
            {"name": "remote_cmd_list", "description": "列出已配置的远程电脑，不联网、不返回凭据。",
             "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
            {"name": "remote_cmd_probe", "description": "检查指定电脑的 SSH 身份、登录和 CMD 是否可用，只执行固定 echo。",
             "inputSchema": {"type": "object", "properties": {"target": target},
                             "required": ["target"], "additionalProperties": False}},
            {"name": "remote_cmd_run",
             "description": "通过 VPS/FRP 隧道在指定电脑执行 CMD。先列出目标，无法与用户所指电脑对应时询问，不猜。仅执行用户授权范围的操作；无自动重试，超时不代表远端停止。",
             "inputSchema": {"type": "object", "properties": {
                 "target": target, "command": {"type": "string", "description": "CMD 命令；切目录用 cd /d，非交互"},
                 "timeoutSec": {"type": "integer", "minimum": 1, "maximum": 120, "default": 30}},
                 "required": ["target", "command"], "additionalProperties": False}}
        ]

    def call_tool(self, name, args):
        """name 为固定工具名，args 为严格校验的参数对象；错误不回显 SSH 凭据或地址。"""
        try:
            definitions = {item["name"]: item["inputSchema"] for item in self.list_tools()}
            if name not in definitions:
                raise ValueError("未知远控工具")
            schema = definitions[name]
            if not isinstance(args, dict) or set(args) - set(schema["properties"]):
                raise ValueError("远控工具包含不支持的参数")
            if any(key not in args for key in schema.get("required", [])):
                raise ValueError("远控工具缺少必要参数")
            if name == "remote_cmd_list":
                result = {"ok": True, "targets": self.config.list_targets()}
            elif name == "remote_cmd_probe":
                result = self.client.execute_command(args["target"], "echo SynLoveRemoteCmdReady", 10)
                result["ok"] = bool(result["ok"] and result["stdout"].strip() == "SynLoveRemoteCmdReady")
            else:
                result = self.client.execute_command(args["target"], args["command"], args.get("timeoutSec", 30))
        except ValueError as error:
            # 配置解析错误不输出 JSON 源文本。
            message = "远控配置 JSON 格式错误" if isinstance(error, json.JSONDecodeError) else str(error)
            result = {"ok": False, "error": message}
        except Exception as error:
            result = {"ok": False, "error": "SSH 连接或执行失败（%s），请核对隧道、目标凭据及主机指纹；未自动重试" %
                      type(error).__name__, "remoteMayStillRun": name == "remote_cmd_run"}
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": not result["ok"]}
