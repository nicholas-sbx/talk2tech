# talk2tech

Point your phone at any object and talk to it. It wakes up with its own personality and voice and
talks back, in character, about what it sees.

**Stack:** mobile web client · FastAPI · Gemini (vision) · ElevenLabs (speech) · 8th Wall + three.js (AR) · local JSONL (analytics)

## Repo layout

| folder | what's in it |
|---|---|
| `device/` | Mobile web client: camera, push-to-talk, playback. Plain HTML/JS, served by the backend. |
| `backend/` | FastAPI orchestrator: WebSocket endpoint and the turn loop. |
| `integrations/` | Thin wrappers for Gemini and ElevenLabs, each with a mock. |
| `dashboard/` | Streamlit analytics over the conversation log. |
| `docs/` | [Architecture](docs/architecture.md) and the [device ↔ backend protocol](docs/protocol.md). |

## Quick start

```powershell
.\start.ps1              # Windows
./start.sh               # macOS / Linux / Git Bash
```

The script creates `.venv`, installs dependencies (again only when `requirements.txt` changes),
creates `.env` from `.env.example`, and starts the server with auto-reload. To do only the setup
without starting the server, run `.\setup.ps1` or `./setup.sh`. Options:

| PowerShell | bash | what it does |
|---|---|---|
| `-Port 8001` | `--port 8001` | use another port |
| `-Mock` | `--mock` | mock every service, even if keys are set |
| `-Tunnel` | `--tunnel` | also open an HTTPS tunnel for a phone (needs `cloudflared`) |

Open http://localhost:8000 on your laptop. With no keys it runs fully mocked: a canned persona
and replies, spoken with the browser's built-in voice. Check http://localhost:8000/health to see which
services are real.

## Using it on a phone

Browsers only allow camera and mic on HTTPS (or localhost), so a phone needs an HTTPS URL.
Run `.\start.ps1 -Tunnel` (or `./start.sh --tunnel`) and open the printed `https://...trycloudflare.com`
URL on the phone. Install cloudflared with `winget install Cloudflare.cloudflared` or
`brew install cloudflared`, or use `ngrok http 8000` instead.
Without HTTPS the page still loads, but only the typed fallback works.

On a phone the camera runs through the [8th Wall engine](https://8thwall.org) (world tracking in plain
Safari or Chrome, no app or WebXR needed). When an object wakes up, a pulsing green cube appears on it
and stays there as you move. Allow motion access when asked; without it the app falls back to the
plain camera view. The engine is © Niantic Spatial, Inc., used under its
[XR Engine License Agreement](https://github.com/8thwall/engine/blob/main/LICENSE).

**Controls:** hold the big button and talk, release to send. Holding it again interrupts the reply.
The reset button (top right) forgets the current object so you can wake up a new one. The keyboard
button lets you type instead, and the captions button shows the conversation as subtitles. Add
`?debug` to the URL to show which services are live.

## Dashboard

```bash
pip install -r dashboard/requirements.txt
streamlit run dashboard/app.py
```

Reads `data/events.jsonl`.

## Team habits

- `main` always runs the demo. Short branches, small merges.
- Change [docs/protocol.md](docs/protocol.md) first, then code against it.
- Keys live in `.env` only. Share them privately, never in the repo or a public channel.
- Demo with headphones or push-to-talk only, so the mic doesn't hear the speaker. Bring a hotspot.
