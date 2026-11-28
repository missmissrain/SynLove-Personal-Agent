@echo off
rem SynLove 安装与启动入口；首次前台安装，后续直接打开桌面。
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" bootstrap.py %*
) else (
  where py >nul 2>nul
  if errorlevel 1 (
    python bootstrap.py %*
  ) else (
    py -3 bootstrap.py %*
  )
)
if errorlevel 1 pause
endlocal
