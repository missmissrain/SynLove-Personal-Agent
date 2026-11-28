@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
cd /d "%~dp0.."
rem 控制台输出单独一个文件：绝不能再重定向进 runtime\skill-review.log。
rem 那份日志是 python 自己写的，两个句柄写同一份文件，就是 2026-10-29 03:00
rem 那次 PermissionError 的直接来源。
".venv\Scripts\python.exe" skills\skillReviewService.py --once >> runtime\skill-review.console.log 2>&1
if not errorlevel 1 goto :done
rem 失败先等 2 分钟再试一次；还不行就交给 tools\guardService.py（每 5 分钟检一次）补跑
ping -n 121 127.0.0.1 >nul
".venv\Scripts\python.exe" skills\skillReviewService.py --once >> runtime\skill-review.console.log 2>&1
:done
