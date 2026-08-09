# Refresh taskbar/system icons
& "$env:SystemRoot\System32\ie4uinit.exe" -show | Out-Null

# Recreate shortcuts
$shell = New-Object -ComObject WScript.Shell
$target = 'E:\MarkdownNote\App\MarkdownNote.exe'
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'

foreach ($dir in @($desktop, $startMenu)) {
  $lnkPath = Join-Path $dir 'MarkdownNote.lnk'
  if (Test-Path -LiteralPath $lnkPath) { Remove-Item -LiteralPath $lnkPath -Force }
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = $target
  $lnk.WorkingDirectory = 'E:\MarkdownNote\App'
  $lnk.IconLocation = $target + ',0'
  $lnk.Description = 'MarkdownNote'
  $lnk.Save()
  Write-Output ('shortcut created: ' + $lnkPath)
}

# Relaunch app
Start-Process -FilePath $target
Start-Sleep -Seconds 4
Get-Process | Where-Object { $_.ProcessName -like '*MarkdownNote*' } | Select-Object ProcessName, Id, MainWindowTitle
