@echo off
rem 计划任务专用入口：与 runDigest.cmd 相同，但**不 pause**（前台会卡住计划任务）。
rem 日志由 runDigest.py 自己写 runtime/news-digest.log，这里只负责带 PYTHONUTF8=1 启动。
setlocal
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "ROOT=%~dp0.."
if not defined PYTHON if exist "%ROOT%\.venv\Scripts\python.exe" set "PYTHON=%ROOT%\.venv\Scripts\python.exe"
if defined PYTHON if not exist "%PYTHON%" if exist "%ROOT%\.venv\Scripts\python.exe" set "PYTHON=%ROOT%\.venv\Scripts\python.exe"
if not defined PYTHON set "PYTHON=python"
"%PYTHON%" "%~dp0runDigest.py" %*
endlocal
