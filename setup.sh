#!/usr/bin/env bash
# Set up TalkTua without starting it: create .venv, install dependencies, and create .env.
# Safe to run repeatedly; dependencies are reinstalled only when requirements.txt changes.
# Usage:  ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"

venv_python() {
  if [[ -x .venv/Scripts/python.exe ]]; then echo .venv/Scripts/python.exe; else echo .venv/bin/python; fi
}

PY=$(venv_python)
if [[ ! -x "$PY" ]]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv 2>/dev/null || python -m venv .venv \
    || { echo "Could not create .venv. Is Python 3 installed?"; exit 1; }
  PY=$(venv_python)
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
