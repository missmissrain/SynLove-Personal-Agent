@echo off
REM 全部停止（先关前端控制台，再关后端 harness + 本地 Gemma）。
REM
REM 为什么要有这个 .cmd：这台机器上 pip 的 editable 安装会把 .pth 写成 UTF-8，
REM 而 Python 默认按 GBK 读 .pth，会导致 python 直接启动失败。这里统一带上
REM PYTHONUTF8=1 再调用 Python，避免"想关都关不掉"。
REM
REM 想连 opencode server 一起关：tools\stop_all.cmd --with-opencode

setlocal
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
cd /d "%~dp0.."
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" tools\stop_all.py %*
) else (
  python tools\stop_all.py %*
)
echo.
pause
