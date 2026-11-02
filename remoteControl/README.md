# 远程 CMD

让欣爱通过已有的 Remote-CMD-Control 链路，在指定 Windows 电脑上运行 CMD。模块随主程序分发，由 Harness 挂载为本机 stdio 工具；不增加远程微服务，也不依赖旁边的源码目录。

链路：欣爱 → 本机远控工具 → VPS 的 FRP 转发端口 → 目标电脑 OpenSSH → CMD。

## 配置

现在可以在桌面控制台的 **通道 → 远程连接** 中配置，无需手改 JSON：

- “远程服务”配置 TTS、ASR 和大模型的本机/远程地址、端口、HTTP/HTTPS 和 API 访问密钥。密钥留空保留旧值；自动查验通过后才应用端点。Agent 内核读取大模型地址仍需重启。
- “远控电脑”输入电脑标识、IP/主机名、SSH/FRP 转发端口、Windows 账号和密码。读取并在目标电脑核对 SSH 指纹，勾选确认后保存，再测试连接。
- 密码输入框不回填；编辑时留空保留原凭据。删除只移除本机连接配置，不操作远端电脑。
- 主页消息通道中的“远程连接”可直接打开此页；只有一分钟内且配置未变化的真实 SSH/CMD 检查证据才显示已连接。未验证和不可用均不显示绿灯。

共享服务的 API 密钥与远控电脑的登录密码是两类凭据，不能混用。以下手工配置方式仍可使用。

1. 先按 Remote-CMD-Control 的部署方式，让目标电脑的 OpenSSH、frpc 与 VPS 的 frps 正常运行。本模块只使用已有隧道，不自动部署服务器或开启电脑 SSH。
2. 将 `config/remoteControl.example.json` 复制为 `config/remoteControl.json`。每台电脑设一个固定别名，例如 `officePc`；填写 VPS 地址、**该电脑对应的转发端口**及**该电脑的 Windows 登录用户名**。不要填 VPS 管理用户。
3. 核对目标电脑的 SSH 主机公钥。可在目标电脑上运行 `ssh-keygen -lf C:\ProgramData\ssh\ssh_host_ed25519_key.pub -E sha256`，将核对后的 `SHA256:...` 填入 `hostKeySha256`。也可指定已有可信 `knownHostsPath`，其中主机项应匹配转发地址及端口，例如 `[your-vps.example.com]:21119`。不要把未经核验的网络扫描结果直接当成可信公钥。更换电脑或重装 SSH 后需重新核验。
4. 在现有 `config/secrets.json` 顶层合并以下结构，不要覆盖原有模型、微信或 QQ 凭据：

```json
{
  "remoteControl": {
    "targets": {
      "officePc": {
        "password": "",
        "privateKeyPath": "C:/Users/your-user/.ssh/id_ed25519",
        "passphrase": ""
      }
    }
  }
}
```

可用 Windows 密码，也可用已在对方电脑安装公钥的私钥；二选一即可。私钥路径相对生产根目录解析；密钥口令用 `passphrase`。此处的账号密钥属于目标电脑，不属于 VPS。

5. 将该目标 `enabled` 改为 `true`。工具每次调用重新读取目标与凭据，修改后不用重启；首次安装工具需通过正常启动入口重启内核加载。未配置目标不影响聊天。

本机应安装项目的 `requirements.txt`。正常安装器会一并安装 Paramiko；已有环境只补缺失依赖，无需重新安装整套环境。

## 欣爱如何使用

- `remote_cmd_list`：列出目标别名、说明和启用状态，不联网。
- `remote_cmd_probe(target)`：完成 SSH 主机身份校验、登录与固定 CMD echo 检测。
- `remote_cmd_run(target, command, timeoutSec=30)`：执行一次 CMD，返回退出码、标准输出、标准错误和截断/超时标志。Harness 中实际公开名带 `mcp__remote-cmd__` 前缀，以工具目录为准。

例如：“在办公室电脑上查一下当前目录”。目标不明确时欣爱应先问你是哪台，不根据 IP 或名字猜。命令由 `cmd.exe /d /s /c` 执行；切目录可用 `cd /d`。使用非交互命令，不能响应 UAC、口令提示或 GUI 对话框；需要 PowerShell 时在 CMD 中显式调用 `powershell -NoProfile -NonInteractive -Command ...`。

默认命令期限 30 秒，可设为 1～120 秒；连接阶段每步至多 10 秒，配置上限 30 秒。stdout/stderr 同时读取，合计最多保留 32 KiB，多余输出排空但不进入模型上下文；自动识别 UTF-8/GB18030，也可在目标配置固定编码。

命令不会自动重试。超时或连接中断后，远端程序可能继续运行；工具失败不能视为远端已停止，也不要直接重新执行可能有副作用的命令。长任务应在目标电脑创建可查询的后台任务，再用后续命令查询，不把一次 SSH 通话当作永久任务管理器。

## 数据与部署边界

只访问显式启用的目标。`remoteControl.json`、`secrets.json`、本机 known_hosts 和私钥均留在本机，公开仓库只提供脱敏模板。不会自动信任未知主机或修改 VPS 管理账号。普通执行不会开启额外监听端口，也不会新增 FRP/微信/QQ 消费者。

隔离验证入口：`python tests/RemoteControlTests.py`。测试只连接本机临时 SSH 测试端，不连接生产 VPS 或真实电脑。

Harness 自带 MCP SDK 兼容性检查：`node tests/RemoteControlMcpTest.mjs`。默认使用发行目录 `.venv`，可用 `DSH_PYTHON` 指定已装依赖的解释器。
