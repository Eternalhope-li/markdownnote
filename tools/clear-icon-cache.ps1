# 1. Kill app
Get-Process | Where-Object { $_.ProcessName -like '*MarkdownNote*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Write-Output 'app killed'

# 2. Stop explorer (safely) - use taskkill via explorer management
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 3. Delete icon cache db files
$cacheDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer'
$deleted = @()
Get-ChildItem -LiteralPath $cacheDir -Filter 'iconcache_*.db' -Force -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
  $deleted += $_.Name
}
Write-Output ('icon cache deleted: ' + ($deleted -join ', '))

# 4. Restart explorer
Start-Process explorer.exe
Start-Sleep -Seconds 3
Write-Output 'explorer restarted'
