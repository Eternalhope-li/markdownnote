Add-Type -AssemblyName System.Drawing
$exe = 'E:\MarkdownNote\release\win-unpacked\MarkdownNote.exe'
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
$bmp = $icon.ToBitmap()
$out = 'E:\MarkdownNote\build\exe-extracted-icon-check.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("Size: " + $bmp.Width + "x" + $bmp.Height)
Write-Output ("Saved: " + $out)
$icon.Dispose(); $bmp.Dispose()
