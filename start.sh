#!/usr/bin/env bash
# Launch the talk2tech backend (which also serves the mobile client).
# Usage:  ./start.sh [--port 8000] [--mock] [--tunnel]
#   --mock    run every service in mock mode (no API keys needed)
#   --tunnel  also open an HTTPS tunnel with cloudflared so a phone can use the camera and mic
set -euo pipefail
cd "$(dirname "$0")"

PORT=8000
TUNNEL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --mock) export FORCE_MOCK=1; shift ;;
    --tunnel) TUNNEL=1; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -x .venv/Scripts/python.exe ]]; then PY=.venv/Scripts/python.exe; else PY=.venv/bin/python; fi
if [[ ! -x "$PY" ]]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv 2>/dev/null || python -m venv .venv
  if [[ -x .venv/Scripts/python.exe ]]; then PY=.venv/Scripts/python.exe; else PY=.venv/bin/python; fi
fi

# Reinstall dependencies only when requirements.txt changes.
HASH=$("$PY" -c "import hashlib;print(hashlib.sha256(open('requirements.txt','rb').read()).hexdigest())")
if [[ "$(cat .venv/.requirements-hash 2>/dev/null)" != "$HASH" ]]; then
  echo "Installing dependencies..."
  "$PY" -m pip install -q --disable-pip-version-check -r requirements.txt
  echo "$HASH" > .venv/.requirements-hash
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example. Add your API keys there (blank keys run in mock mode)."
fi

if command -v lsof >/dev/null && lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Try: ./start.sh --port $((PORT + 1))"
  exit 1
fi

if [[ $TUNNEL == 1 ]]; then
  command -v cloudflared >/dev/null || { echo "cloudflared not found. Install: brew install cloudflared"; exit 1; }
  echo "Starting HTTPS tunnel. Open the https://...trycloudflare.com URL it prints on your phone."
  cloudflared tunnel --url "http://localhost:$PORT" &
  trap 'kill $!' EXIT
fi

echo "talk2tech running at http://localhost:$PORT"
"$PY" -m uvicorn backend.main:app --host 0.0.0.0 --port "$PORT" --reload
