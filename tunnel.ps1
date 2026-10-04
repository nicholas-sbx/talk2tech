# Open an HTTPS tunnel to the backend in its own terminal, so restarting the server keeps the same URL.
# Usage:  .\tunnel.ps1 [-Port 8000]
param([int]$Port = 8000)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) { $cloudflared = "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe" }
if (-not (Test-Path $cloudflared)) {
    throw "cloudflared not found. Install it: winget install Cloudflare.cloudflared"
}
$python = ".venv\Scripts\python.exe"
Write-Host "Tunneling to http://localhost:$Port. Scan the QR code (or open the trycloudflare.com URL) on your phone."
Write-Host "Leave this running; restart the server in another terminal as often as you like."

# The QR code uses Unicode block characters, so decode Python's output as UTF-8.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"
# cloudflared logs to stderr; with "Stop", PowerShell 5.1 would treat the first redirected line as an error.
$ErrorActionPreference = "Continue"

# Echo cloudflared's log and print a QR code for the tunnel URL once it appears.
$shown = $false
& $cloudflared tunnel --url "http://localhost:$Port" 2>&1 | ForEach-Object {
    $line = "$_"
    Write-Host $line
    if (-not $shown -and $line -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
        $shown = $true
        $url = $Matches[0]
        Write-Host ""
        if (Test-Path $python) {
            & $python -c "import sys, qrcode; q = qrcode.QRCode(border=2); q.add_data(sys.argv[1]); q.print_ascii(invert=True)" $url | Out-Host
        }
        if (-not (Test-Path $python) -or $LASTEXITCODE -ne 0) {
            Write-Host "(QR code unavailable; run .\setup.ps1 to install qrcode)"
        }
        Write-Host "  $url"
        Write-Host ""
    }
}
