Set-Location E:\MarkdownNote
& "D:\Program Files\nodejs\npx.cmd" electron-builder --win nsis 2>&1 | Out-String | Write-Output
