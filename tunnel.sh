#!/usr/bin/env bash
# Open an HTTPS tunnel to the backend in its own terminal, so restarting the server keeps the same URL.
# Usage:  ./tunnel.sh [--port 8000]
set -euo pipefail

PORT=8000
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

command -v cloudflared >/dev/null || { echo "cloudflared not found. Install: brew install cloudflared"; exit 1; }
echo "Tunneling to http://localhost:$PORT. Open the https://...trycloudflare.com URL below on your phone."
echo "Leave this running; restart the server in another terminal as often as you like."
exec cloudflared tunnel --url "http://localhost:$PORT"
