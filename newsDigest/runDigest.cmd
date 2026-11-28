@echo off
rem 新闻摘要手动入口：带上 PYTHONUTF8=1（本机 site-packages 有非 GBK 的 .pth，不带会崩），
rem 前台运行，窗口可看到每一步进度；传参原样转给 runDigest.py（如 --dry-run）。
setlocal
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
if not defined PYTHON set "PYTHON=python"
if not exist "%PYTHON%" set "PYTHON=python"
"%PYTHON%" "%~dp0runDigest.py" %*
echo.
echo 退出码 %ERRORLEVEL%
pause
endlocal
