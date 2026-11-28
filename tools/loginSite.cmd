@echo off
rem 单独给某个站点登录用：弹出浏览器窗口，登录后自动导出 cookie。
rem 用法：tools\loginSite.cmd bilibili.com
setlocal
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "ROOT=%~dp0.."
set "DOMAIN=%~1"
if "%DOMAIN%"=="" (
  echo 用法: tools\loginSite.cmd ^<域名^>   例如 bilibili.com
  exit /b 2
)
if not defined NODE set "NODE=node"
if not exist "%NODE%" set "NODE=node"
set "DSH_NODE=%NODE%"
"%NODE%" "%ROOT%\tools\edgeSession.mjs" --domain=%DOMAIN% --url=https://www.%DOMAIN%/ --timeout=600 --out=%ROOT%\runtime\cookies\%DOMAIN%.txt
echo.
echo 退出码 %ERRORLEVEL%（0=已导出 cookie，2=未登录/超时）
pause
endlocal
