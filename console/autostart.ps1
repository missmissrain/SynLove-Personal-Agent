# SynLove快捷方式与登录启动入口。
# 参数Action默认install：设置桌面、开始菜单与登录自启；status只读；remove只移出本工程自启项。
# 统一指向Electron，由GUI协调后台；桌面快捷键默认Ctrl+Alt+S，登录时默认隐藏到托盘。
param([ValidateSet("install", "status", "remove")][string]$Action = "install")

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$project = Split-Path -Parent $here
$electron = Join-Path $here "node_modules\electron\dist\electron.exe"
$shell = New-Object -ComObject WScript.Shell
$startup = [Environment]::GetFolderPath("Startup")
$desktop = [Environment]::GetFolderPath("Desktop")
$programs = [Environment]::GetFolderPath("Programs")
$backup = Join-Path $project "备份\SynLoveShortcut-v1.0"

function save_shortcut([string]$Path, [bool]$Hidden = $false, [bool]$Hotkey = $false) {
    # Path为目标快捷方式；Hidden控制托盘启动；Hotkey只用于桌面，保留其他程序的同名文件。
    $link = $shell.CreateShortcut($Path)
    if (Test-Path -LiteralPath $Path) {
        $isElectron = ([IO.Path]::GetFileName($link.TargetPath) -ieq "electron.exe")
        $isSynLoveEntry = $link.Arguments.IndexOf("SynLove-Personal-Agent", [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $link.Arguments.IndexOf($project, [StringComparison]::OrdinalIgnoreCase) -ge 0
        if (($link.TargetPath -ne $electron) -and -not ($isElectron -and $isSynLoveEntry)) {
            throw "同名快捷方式指向其他程序，拒绝覆盖：$Path"
        }
    }
    $link.TargetPath = $electron
    $link.Arguments = "`"$here`"" + $(if ($Hidden) { " --hidden" } else { "" })
    $link.WorkingDirectory = $here
    $link.Description = "SynLove"
    $link.IconLocation = (Join-Path $here "public\assets\BrandIcon.ico") + ",0"
    $link.Hotkey = $(if ($Hotkey) { "CTRL+ALT+S" } else { "" })
    $link.Save()
}

function archive_startup([string]$Path) {
    # Path为已验证归属本项目的旧自启快捷方式；移至版本备份，支持恢复。
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $link = $shell.CreateShortcut($Path)
    $isElectron = ([IO.Path]::GetFileName($link.TargetPath) -ieq "electron.exe")
    $isSynLoveEntry = $link.Arguments.IndexOf("SynLove-Personal-Agent", [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $link.Arguments.IndexOf($project, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if (-not (($link.TargetPath -eq $electron) -or ($isElectron -and $isSynLoveEntry))) {
        throw "启动项不属于当前项目，拒绝迁移：$Path"
    }
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    $dest = Join-Path $backup ((Get-Date -Format "yyyyMMddHHmmssfff") + "-" + (Split-Path $Path -Leaf))
    Move-Item -LiteralPath $Path -Destination $dest
    @{version="1.0";at=(Get-Date -Format o);reason="合并旧启动入口";source=$Path;backup=$dest} |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup "版本记录.json") -Encoding UTF8
}

function show_status {
    # 无参数；读回快捷方式目标、参数与热键，验证不存在双后端启动入口。
    foreach ($path in @((Join-Path $desktop "SynLove.lnk"), (Join-Path $programs "SynLove.lnk"),
                         (Join-Path $startup "SynLove.lnk"))) {
        if (Test-Path -LiteralPath $path) {
            $link = $shell.CreateShortcut($path)
            [pscustomobject]@{Path=$path;Target=$link.TargetPath;Arguments=$link.Arguments;Hotkey=$link.Hotkey}
        }
    }
}

switch ($Action) {
    "install" {
        if (-not (Test-Path -LiteralPath $electron)) { throw "请先安装桌面依赖：$electron" }
        archive_startup (Join-Path $desktop "SynLove.lnk")
        archive_startup (Join-Path $programs "SynLove.lnk")
        archive_startup (Join-Path $startup "SynLove.lnk")
        archive_startup (Join-Path $startup "Agent 控制台.lnk")
        archive_startup (Join-Path $startup "欣爱（微信后端）.lnk")
        save_shortcut (Join-Path $desktop "SynLove.lnk") $false $true
        save_shortcut (Join-Path $programs "SynLove.lnk")
        save_shortcut (Join-Path $startup "SynLove.lnk") $true
        show_status
    }
    "remove" {
        archive_startup (Join-Path $startup "SynLove.lnk")
        show_status
    }
    "status" { show_status }
}
