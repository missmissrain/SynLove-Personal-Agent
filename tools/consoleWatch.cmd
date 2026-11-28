@echo off
rem 控制台外部看护的启动包装：带上 PYTHONUTF8=1 再跑（本机 site-packages 有非 GBK 的 .pth，
rem 不带这个变量 python 会在启动阶段直接崩，计划任务里看不到任何输出）。
setlocal
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "ROOT=%~dp0.."
set "PYTHON=%ROOT%\.venv\Scripts\pythonw.exe"
if not exist "%PYTHON%" set "PYTHON=pythonw"
"%PYTHON%" "%ROOT%\tools\consoleWatch.py"
endlocal
