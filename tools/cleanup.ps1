Get-ChildItem 'E:\MarkdownNote\notes' -Force | Select-Object Name, Length
Write-Output '--- cleaning .bak ---'
Get-ChildItem 'E:\MarkdownNote\notes' -Filter '*.bak' -Force | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Output '--- after ---'
Get-ChildItem 'E:\MarkdownNote\notes' -Force | Select-Object Name, Length
