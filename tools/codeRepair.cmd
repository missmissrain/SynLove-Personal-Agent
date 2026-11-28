@echo off
rem ASCII only on purpose: cmd.exe reads .cmd as ANSI(GBK) on this machine and
rem Chinese text inside rem/echo breaks parsing. All Chinese output comes from Python.
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo ================================================================
echo  Synlove self-repair (code/config faults that restart cannot fix)
echo  usage: tools\codeRepair.cmd --reason "..." [--detail "..."] [--dry-run]
echo  scope: tools\ config\ and the weixin preset dir only, snapshot + rollback
echo ================================================================
echo.

set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" tools\codeRepair.py %*
) else (
  python tools\codeRepair.py %*
)
set code=%errorlevel%

echo.
if "%code%"=="3" (
  echo [dry-run] prompt printed above, nothing executed.
) else if "%code%"=="0" (
  echo [done] fixed and static-verified. run tools\recoverLinks.cmd to apply.
) else (
  echo [failed] exit=%code% , changes rolled back. log: runtime\coderepair.log
)

endlocal
