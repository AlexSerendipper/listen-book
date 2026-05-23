$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$StartScript = Join-Path $ProjectRoot "scripts\start_listen_book.ps1"
$ShortcutName = [string]::Concat([char]0x672C, [char]0x5730, [char]0x542C, [char]0x4E66, ".lnk")
$ShortcutPath = Join-Path $ProjectRoot $ShortcutName

if (!(Test-Path -LiteralPath $StartScript)) {
  throw "Start script not found: $StartScript"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoExit -ExecutionPolicy Bypass -File `"$StartScript`""
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.WindowStyle = 1
$shortcut.Description = "Start Local Audiobook Reader"
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
$shortcut.Save()

Write-Host "Created project shortcut:"
Write-Host $ShortcutPath
