' SynLove PowerShell 隐藏启动器
'
' 负责：从 Python/计划任务启动 PowerShell 脚本时，使用 WScript 的 GUI
' 启动方式隐藏控制台，避免 powershell.exe 继承当前 cmd/conhost。
' 参数：第一个参数为要执行的 ps1 文件，后续参数原样传给该脚本。

Option Explicit

Dim shell, fso, i, scriptPath, commandLine
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count < 1 Then
    WScript.Quit 2
End If

scriptPath = WScript.Arguments(0)
If Not fso.FileExists(scriptPath) Then
    WScript.Quit 3
End If

commandLine = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Quote(scriptPath)
For i = 1 To WScript.Arguments.Count - 1
    commandLine = commandLine & " " & Quote(WScript.Arguments(i))
Next

shell.CurrentDirectory = fso.GetParentFolderName(scriptPath)
shell.Run commandLine, 0, False

Set fso = Nothing
Set shell = Nothing

Function Quote(value)
    Quote = """" & Replace(CStr(value), """", """""") & """"
End Function
