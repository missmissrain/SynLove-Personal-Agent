' runHidden.vbs — 后台执行一条命令，完全不显示窗口。
'
' 为什么需要它：计划任务直接跑 .cmd 会新建一个控制台窗口，每 5 分钟闪一下，
' 看起来就像"系统一直在闪屏"。wscript 本身是 GUI 程序、不建控制台，
' 再用 WshShell.Run(..., 0, ...) 把子进程的窗口也设成隐藏，就不会闪。
'
' 用法：
'   wscript.exe //B "tools\runHidden.vbs" "G:\...\tools\guardOnce.cmd"

Option Explicit

Dim sh, cmd
If WScript.Arguments.Count < 1 Then
    WScript.Quit 2
End If

cmd = WScript.Arguments(0)

' cmd /c ""..."" 是最稳的写法：外层引号给 cmd 解析，内层引号保住带空格的路径。
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c """ & """" & cmd & """" & """", 0, False
Set sh = Nothing
