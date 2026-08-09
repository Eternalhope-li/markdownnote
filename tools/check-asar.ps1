$asar = 'E:\MarkdownNote\App\resources\app.asar'
$asarTool = 'E:\MarkdownNote\node_modules\@electron\asar\bin\asar.js'
if (Test-Path $asarTool) {
  $list = & node $asarTool list $asar 2>&1 | Out-String
  Write-Output '=== asar contains icon.png? ==='
  ($list -split "`n") | Where-Object { $_ -match 'icon' }
  Write-Output '=== extract dist/icon.png from asar to temp ==='
  $tmp = Join-Path $env:TEMP 'asar-icon-check.png'
  if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Force }
  & node $asarTool extract-file $asar 'dist/icon.png' 2>&1 | Out-String | Write-Output
  if (Test-Path (Join-Path (Get-Location) 'dist\icon.png')) {
    Move-Item -LiteralPath (Join-Path (Get-Location) 'dist\icon.png') -Destination $tmp -Force
  }
  Write-Output 'extracted at: ' $tmp
} else {
  Write-Output 'asar tool not found'
}
