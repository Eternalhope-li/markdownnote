$files = @{
  'asar-internal' = Join-Path $env:TEMP 'asar-icon-check.png'
  'repo-dist'     = 'E:\MarkdownNote\dist\icon.png'
  'build-icon'    = 'E:\MarkdownNote\build\icon.png'
  'old-backup'    = 'E:\MarkdownNote-backup-icons-20260809\icon.png'
}
foreach ($k in $files.Keys) {
  $f = $files[$k]
  if (Test-Path $f) {
    $h = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.Substring(0,16)
    $len = (Get-Item -LiteralPath $f).Length
    Write-Output ($k + ': len=' + $len + ' sha256=' + $h)
  } else { Write-Output ($k + ': NOT FOUND') }
}
