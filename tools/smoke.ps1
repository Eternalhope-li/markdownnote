$smoke = Join-Path $env:TEMP 'markdownnote-smoke.json'
if (Test-Path $smoke) { Remove-Item -LiteralPath $smoke -Force }
$proc = Start-Process -FilePath 'E:\MarkdownNote\App\MarkdownNote.exe' -ArgumentList '--smoke' -PassThru -Wait
Write-Output ("Smoke exit code: " + $proc.ExitCode)
if (Test-Path $smoke) {
  $data = Get-Content $smoke -Raw | ConvertFrom-Json
  $boolFields = $data.PSObject.Properties | Where-Object { $_.Value -is [bool] }
  $falseCount = @($boolFields | Where-Object { -not $_.Value }).Count
  Write-Output ("Boolean assertions: " + @($boolFields).Count + ", false: " + $falseCount)
  $boolFields | Where-Object { -not $_.Value } | ForEach-Object { Write-Output ("FALSE: " + $_.Name) }
  $data.PSObject.Properties | Where-Object { -not ($_.Value -is [bool]) } | ForEach-Object { Write-Output ("INFO " + $_.Name + " = " + $_.Value) }
} else {
  Write-Output 'SMOKE JSON NOT FOUND'
}
