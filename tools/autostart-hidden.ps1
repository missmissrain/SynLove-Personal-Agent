# 自启的"带环境变量"入口（无黑框）。
#
# 为什么需要它：Windows 上 pip 的 editable 安装会把 `.pth` 写成 **UTF-8**，
# 而 Python 默认按系统 GBK 读 `.pth` —— 这台机器上已经出现过（别的项目装的
# `__editable__.aiec-*.pth` 带中文路径），结果是**任何 python 命令都启动失败**，
# 于是"开机自启"也会静默失效。这里统一带上 PYTHONUTF8=1 绕开这一类问题。
#
# 用法：由"启动文件夹"里的快捷方式调用：
#   powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File tools\autostart-hidden.ps1
# 它只负责设好环境变量并把 tools\autostart.py 以隐藏方式拉起，然后自己立刻退出。

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $projectRoot 'tools\autostart.py'
$pythonw = Join-Path $projectRoot '.venv\Scripts\pythonw.exe'
if (-not (Test-Path -LiteralPath $entry)) { throw "找不到自启入口：$entry" }
if (-not (Test-Path -LiteralPath $pythonw)) { throw "找不到 pythonw.exe：$pythonw" }

# 关键：UTF-8 模式 + 中文输出编码（避免 .pth / 控制台编码问题）
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

# --delay 90：开机后网络/DNS/代理往往还没就绪（会看到 weixin_token=unreachable），
# 等 90 秒再起更稳；autostart.py 里还有一次失败重试兜底。
Start-Process -FilePath $pythonw -ArgumentList ('"' + $entry + '"'), '--delay', '90' `
    -WorkingDirectory $projectRoot -WindowStyle Hidden
