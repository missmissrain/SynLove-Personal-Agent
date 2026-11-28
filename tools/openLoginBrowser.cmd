@echo off
rem 打开登录用浏览器（有界面）。用户登录完直接关窗口即可，cookie 自动写回 profile。
setlocal
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "ROOT=%~dp0.."
if not defined NODE set "NODE=node"
if not exist "%NODE%" set "NODE=node"
set "LOGIN_PROFILE=%ROOT%\runtime\browser-profile-media"
set "LOGIN_SITES=bilibili.com,xiaohongshu.com,www.douyin.com,weibo.com"
"%NODE%" "%ROOT%\tools\openLoginBrowser.mjs"
endlocal
