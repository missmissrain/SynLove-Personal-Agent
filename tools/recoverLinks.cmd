@echo off
rem ASCII only on purpose: cmd.exe parses .cmd as ANSI and Chinese text here
rem breaks parsing on some code pages. All Chinese output comes from Python.
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo ================================================================
echo  Synlove link recovery
echo  L0 restart stack, L1 clear stale locks, L2 reset queue state, then verify.
echo  Long-term memory (timeline / knowledge graph) is NOT touched.
echo ================================================================
echo.

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" tools\recoverLinks.py %*
) else (
  python tools\recoverLinks.py %*
)
set code=%errorlevel%

echo.
if "%code%"=="0" (
  echo [done] link recovered, messages should flow again.
) else (
  echo [failed] exit=%code%, see runtime\recovery.log and runtime\harness-run.log
)

endlocal
