$ErrorActionPreference = 'Stop'
$logRoot = Join-Path $env:LOCALAPPDATA 'LocalQA'
$pidFile = Join-Path $logRoot 'compose-dev-watch.pid'
if (Test-Path $pidFile) {
  $watchPid = (Get-Content $pidFile -Raw).Trim()
  $watchProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$watchPid" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*compose-dev-watch.cmd*' }
  if ($watchProcess) {
    taskkill.exe /PID $watchProcess.ProcessId /T /F | Out-Null
    Write-Output 'Compose Watch stopped.'
  }
  Remove-Item $pidFile -Force
}
docker compose -f (Join-Path $PSScriptRoot 'docker-compose.dev.yml') stop
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output 'Containers stopped; database and credentials preserved.'
