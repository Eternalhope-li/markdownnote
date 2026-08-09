$installer = 'E:\MarkdownNote\release\MarkdownNote-Setup-0.1.0.exe'
$proc = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru -Wait
Write-Output ("Installer exit code: " + $proc.ExitCode)
Start-Sleep -Seconds 2
Write-Output '--- App exe after install ---'
Get-Item 'E:\MarkdownNote\App\MarkdownNote.exe' -ErrorAction SilentlyContinue | Select-Object FullName, Length, LastWriteTime
Get-ChildItem 'E:\MarkdownNote\App\Uninstall MarkdownNote.exe' -ErrorAction SilentlyContinue | Select-Object FullName
