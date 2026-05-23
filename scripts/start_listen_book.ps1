$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PythonExe = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$Requirements = Join-Path $ProjectRoot "requirements.txt"
$Port = 8765
$Url = "http://127.0.0.1:$Port"
$LogDir = Join-Path $ProjectRoot "app\logs"
$OutLog = Join-Path $LogDir "launcher-uvicorn.out.log"
$ErrLog = Join-Path $LogDir "launcher-uvicorn.err.log"

function Ensure-Venv {
  if (!(Test-Path -LiteralPath $PythonExe)) {
    Write-Host "Creating virtual environment..."
    py -m venv (Join-Path $ProjectRoot ".venv")
  }

  & $PythonExe -c "import fastapi, uvicorn, edge_tts, ebooklib, bs4" *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing dependencies..."
    & $PythonExe -m pip install -r $Requirements
  }
}

function Wait-For-Server {
  param([string]$HealthUrl)

  for ($i = 0; $i -lt 40; $i++) {
    try {
      Invoke-RestMethod -Uri "$HealthUrl/api/voices" -TimeoutSec 2 | Out-Null
      return $true
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  return $false
}

Set-Location $ProjectRoot
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Ensure-Venv

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Port $Port is already in use. Opening existing service..."
  Start-Process $Url
  Write-Host ""
  Write-Host "If this is not the audiobook service, close the process using port $Port and run this shortcut again."
  Write-Host "Press Enter to close this window."
  Read-Host | Out-Null
  exit 0
}

Write-Host "Starting Local Audiobook Reader on $Url ..."
$job = Start-Job -Name "ListenBookServer" -ArgumentList $ProjectRoot, $PythonExe, $Port, $OutLog, $ErrLog -ScriptBlock {
  param($ProjectRoot, $PythonExe, $Port, $OutLog, $ErrLog)
  Set-Location $ProjectRoot
  & $PythonExe -m uvicorn app.backend.main:app --host 127.0.0.1 --port $Port *> $OutLog 2> $ErrLog
}

try {
  if (!(Wait-For-Server $Url)) {
    Write-Host "Service did not start successfully."
    Write-Host "Error log:"
    Get-Content -LiteralPath $ErrLog -Raw -ErrorAction SilentlyContinue
    Write-Host "Press Enter to close this window."
    Read-Host | Out-Null
    exit 1
  }

  Start-Process $Url
  Write-Host ""
  Write-Host "Local Audiobook Reader is running:"
  Write-Host $Url
  Write-Host ""
  Write-Host "Keep this window open while using the app."
  Write-Host "Close this window, or press Enter here, to stop the service."
  Read-Host | Out-Null
} finally {
  if ($job) {
    Write-Host "Stopping service..."
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
}
