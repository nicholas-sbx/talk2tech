#!/usr/bin/env bash
# Open an HTTPS tunnel to the backend in its own terminal, so restarting the server keeps the same URL.
# Usage:  ./tunnel.sh [--port 8000]
set -euo pipefail
cd "$(dirname "$0")"

PORT=8000
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

command -v cloudflared >/dev/null || { echo "cloudflared not found. Install: brew install cloudflared"; exit 1; }
if [[ -x .venv/Scripts/python.exe ]]; then PY=.venv/Scripts/python.exe; else PY=.venv/bin/python; fi
echo "Tunneling to http://localhost:$PORT. Scan the QR code (or open the trycloudflare.com URL) on your phone."
echo "Leave this running; restart the server in another terminal as often as you like."

# Echo cloudflared's log and print a QR code for the tunnel URL once it appears.
shown=
cloudflared tunnel --url "http://localhost:$PORT" 2>&1 | while IFS= read -r line; do
  echo "$line"
  if [[ -z "$shown" && "$line" =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
    shown=1
    url="${BASH_REMATCH[1]}"
    echo
    "$PY" -c "import sys, qrcode; q = qrcode.QRCode(border=2); q.add_data(sys.argv[1]); q.print_ascii(invert=True)" "$url" \
      || echo "(QR code unavailable; run ./setup.sh to install qrcode)"
    echo "  $url"
    echo
  fi
done
