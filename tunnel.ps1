# Open an HTTPS tunnel to the backend in its own terminal, so restarting the server keeps the same URL.
# Usage:  .\tunnel.ps1 [-Port 8000]
param([int]$Port = 8000)
$ErrorActionPreference = "Stop"

$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) { $cloudflared = "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe" }
if (-not (Test-Path $cloudflared)) {
    throw "cloudflared not found. Install it: winget install Cloudflare.cloudflared"
}
Write-Host "Tunneling to http://localhost:$Port. Open the https://...trycloudflare.com URL below on your phone."
Write-Host "Leave this running; restart the server in another terminal as often as you like."
& $cloudflared tunnel --url "http://localhost:$Port"
