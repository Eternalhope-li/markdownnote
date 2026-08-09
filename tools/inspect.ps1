$root = 'E:\MarkdownNote'
Get-Content (Join-Path $root 'package.json') -Raw
Write-Output '=== main process files ==='
Get-ChildItem $root -Recurse -Include *.js -File | Where-Object { $_.FullName -notmatch 'node_modules|release|\\App\\|dist' } | Select-Object -ExpandProperty FullName
Write-Output '=== icon / BrowserWindow refs ==='
Get-ChildItem $root -Recurse -Include *.js -File | Where-Object { $_.FullName -notmatch 'node_modules|release|\\App\\' } | Select-String -Pattern 'icon|BrowserWindow|setIcon|nativeImage' | ForEach-Object { $_.Path + ':' + $_.LineNumber + ': ' + $_.Line.Trim() }
