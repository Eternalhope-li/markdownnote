$pinDir = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
Write-Output ('pin dir: ' + $pinDir)
if (Test-Path $pinDir) {
  Get-ChildItem -LiteralPath $pinDir -Filter '*.lnk' -Force | ForEach-Object {
    Write-Output ('pinned: ' + $_.Name)
  }
}
