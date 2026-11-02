' SynLove Electron 隐藏启动器
'
' 负责：从 .cmd 或计划任务启动桌面壳时，直接用 WScript.Shell.Run
' 启动 electron.exe，不创建 cmd/conhost 控制台窗口。
' 参数：无；入口目录由本文件所在目录解析。

Option Explicit

Dim shell, fso, here, electron, args
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
electron = fso.BuildPath(here, "node_modules\electron\dist\electron.exe")
If Not fso.FileExists(electron) Then
    WScript.Quit 1
End If

args = """" & here & """"
shell.CurrentDirectory = here
shell.Run """" & electron & """ " & args, 0, False

Set fso = Nothing
Set shell = Nothing
