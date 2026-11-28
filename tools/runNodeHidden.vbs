' SynLove Node 隐藏启动器
'
' 参数：
'   1. node.exe 完整路径
'   2. 工作目录
'   3. Node 脚本完整路径
'   4+. 传给 Node 脚本的参数

Option Explicit

Dim shell, fso, i, nodePath, workDir, scriptPath, commandLine
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count < 3 Then WScript.Quit 2

nodePath = WScript.Arguments(0)
workDir = WScript.Arguments(1)
scriptPath = WScript.Arguments(2)
If Not fso.FileExists(nodePath) Then WScript.Quit 3
If Not fso.FileExists(scriptPath) Then WScript.Quit 4

commandLine = Quote(nodePath) & " " & Quote(scriptPath)
For i = 3 To WScript.Arguments.Count - 1
    commandLine = commandLine & " " & Quote(WScript.Arguments(i))
Next

shell.CurrentDirectory = workDir
shell.Run commandLine, 0, False

Set fso = Nothing
Set shell = Nothing

Function Quote(value)
    Quote = """" & Replace(CStr(value), """", """""") & """"
End Function
