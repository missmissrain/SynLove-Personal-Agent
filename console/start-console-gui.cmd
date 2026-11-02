@echo off
rem Agent 控制台 · 桌面版（Electron 壳）
rem 右上角叉叉 = 最小化到托盘；右击托盘图标 = 可退出
setlocal
set HERE=%~dp0
if not exist "%HERE%node_modules\electron\dist\electron.exe" (
  echo [错误] 还没安装 Electron，请先在 console 目录执行：npm install
  pause
  exit /b 1
)
rem 不再用 start 直接拉 Electron：在部分 Windows 环境下，cmd 会一直
rem 持有 conhost，形成用户看到的黑窗口。交给无控制台的 wscript 入口。
wscript.exe //B "%HERE%launch-electron-hidden.vbs"
endlocal
