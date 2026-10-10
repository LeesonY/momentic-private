param([switch]$Build)

# Isolated Docker Desktop development launcher.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$compose = Join-Path $PSScriptRoot 'docker-compose.dev.yml'
Set-Location $repo
if ($Build) {
  docker compose -f $compose build --parallel
  if ($LASTEXITCODE -ne 0) { throw 'Development image build failed' }
}
docker compose -f $compose up -d --wait
if ($LASTEXITCODE -ne 0) { throw 'Development service startup failed' }

$logRoot = Join-Path $env:LOCALAPPDATA 'LocalQA'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$pidFile = Join-Path $logRoot 'compose-dev-watch.pid'
$launcher = Join-Path $logRoot 'compose-dev-watch.cmd'
$watchProcess = $null
if (Test-Path $pidFile) {
  $watchPid = (Get-Content $pidFile -Raw).Trim()
  $watchProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$watchPid" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*compose-dev-watch.cmd*' }
}
if (-not $watchProcess) {
  # WMI creates the watch process outside the short-lived invocation job:
  # Start-Process children are terminated when that job exits.
  $dockerExe = (Get-Command docker).Source
  $outLog = Join-Path $logRoot 'compose-dev-watch.log'
  $errLog = Join-Path $logRoot 'compose-dev-watch.err.log'
  $content = @(
    '@echo off',
    "cd /d `"$repo`"",
    "`"$dockerExe`" compose -f `"$compose`" watch --no-up --prune=false 1>>`"$outLog`" 2>>`"$errLog`""
  ) -join [Environment]::NewLine
  [System.IO.File]::WriteAllText($launcher, $content)
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = "cmd.exe /d /c `"$launcher`""
    CurrentDirectory = $repo
  }
  if ($created.ReturnValue -ne 0) { throw "Cannot launch Compose Watch (WMI code $($created.ReturnValue))" }
  Set-Content -Path $pidFile -Value $created.ProcessId
  Start-Sleep -Seconds 2
  $watchProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($created.ProcessId)" -ErrorAction SilentlyContinue
  if (-not $watchProcess) { throw "Compose Watch exited; see $errLog" }
  Write-Output "Compose Watch running: PID $($created.ProcessId)"
} else {
  Write-Output "Compose Watch already running: PID $($watchProcess.ProcessId)"
}
Write-Output 'LocalQA development URL: http://localhost:5173'
docker compose -f $compose ps
