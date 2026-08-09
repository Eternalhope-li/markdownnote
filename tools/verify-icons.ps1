Add-Type -AssemblyName System.Drawing
$exe = 'E:\MarkdownNote\App\MarkdownNote.exe'
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
$bmp = $icon.ToBitmap()
$out = 'E:\MarkdownNote\build\installed-exe-icon-check.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("Installed exe icon: " + $bmp.Width + "x" + $bmp.Height + " -> " + $out)
$icon.Dispose(); $bmp.Dispose()

# Find shortcuts
$shell = New-Object -ComObject WScript.Shell
$paths = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
  "$env:ProgramData\Microsoft\Windows\Start Menu\Programs"
)
foreach ($p in $paths) {
  Get-ChildItem -Path $p -Filter '*MarkdownNote*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $lnk = $shell.CreateShortcut($_.FullName)
    Write-Output ("Shortcut: " + $_.FullName + " -> " + $lnk.TargetPath)
  }
}
