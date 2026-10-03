# Launch the talk2tech backend (which also serves the mobile client).
# Usage:  .\start.ps1 [-Port 8000] [-Mock] [-Tunnel]
#   -Mock    run every service in mock mode (no API keys needed)
#   -Tunnel  also open an HTTPS tunnel with cloudflared so a phone can use the camera and mic
param(
    [int]$Port = 8000,
    [switch]$Mock,
    [switch]$Tunnel
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$python = ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Write-Host "Creating virtual environment..."
    python -m venv .venv
}

# Reinstall dependencies only when requirements.txt changes.
$hash = (Get-FileHash requirements.txt).Hash
$stamp = ".venv\.requirements-hash"
if (-not (Test-Path $stamp) -or (Get-Content $stamp) -ne $hash) {
    Write-Host "Installing dependencies..."
    & $python -m pip install -q --disable-pip-version-check -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
    Set-Content $stamp $hash
}

if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    Write-Host "Created .env from .env.example. Add your API keys there (blank keys run in mock mode)."
}

if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is already in use. Try: .\start.ps1 -Port $($Port + 1)"
}

if ($Mock) { $env:FORCE_MOCK = "1" }

if ($Tunnel) {
    if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
        throw "cloudflared not found. Install it: winget install Cloudflare.cloudflared"
    }
    Write-Host "Starting HTTPS tunnel. Open the https://...trycloudflare.com URL it prints on your phone."
    Start-Process cloudflared -ArgumentList "tunnel", "--url", "http://localhost:$Port"
}

Write-Host "talk2tech running at http://localhost:$Port"
& $python -m uvicorn backend.main:app --host 0.0.0.0 --port $Port --reload
