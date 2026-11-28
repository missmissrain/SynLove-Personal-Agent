@echo off
REM 手动启动欣爱后端（带 PYTHONUTF8=1，避免 site-packages 里非 GBK 的 .pth 让 python 起不来）。
REM
REM 为什么不直接敲 python start_stack.py：本机 D:\py39 的 site-packages 里混有别的项目
REM 用 pip 装的 UTF-8 编码 .pth（带中文路径），Python 默认按 GBK 读会直接崩在 site 阶段。
REM 双击本文件或在 CMD 里运行都可以。

setlocal
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
cd /d "%~dp0"
call Start.cmd --backend %*
echo.
echo 启动器已执行（日志: runtime\harness-run.log）
pause
