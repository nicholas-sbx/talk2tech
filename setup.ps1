# Set up talk2tech without starting it: create .venv, install dependencies, and create .env.
# Safe to run repeatedly; dependencies are reinstalled only when requirements.txt changes.
# Usage:  .\setup.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$python = ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Write-Host "Creating virtual environment..."
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw "Could not create .venv. Is Python 3 installed and on PATH?" }
}

# Reinstall dependencies only when requirements.txt changes.
# Lowercase with no trailing CRLF so the stamp matches what setup.sh writes.
$hash = (Get-FileHash requirements.txt).Hash.ToLower()
$stamp = ".venv\.requirements-hash"
if (-not (Test-Path $stamp) -or (Get-Content $stamp).Trim() -ne $hash) {
    Write-Host "Installing dependencies..."
    & $python -m pip install -q --disable-pip-version-check -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
    Set-Content $stamp "$hash`n" -NoNewline
}

if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    Write-Host "Created .env from .env.example. Add your API keys there (blank keys run in mock mode)."
}
