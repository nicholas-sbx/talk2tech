"""FastAPI orchestrator: serves the mobile web client and runs one Session per WebSocket.

Run from the repo root:  uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
"""

import logging

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles

from backend.session import Session
from integrations import config
from integrations.llm import make_llm
from integrations.memory import make_memory
from integrations.voice import make_voice

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

app = FastAPI(title="talk2tech")
llm = make_llm()
voice = make_voice()
memory = make_memory()


@app.get("/health")
async def health() -> dict:
    return {"llm": type(llm).__name__, "voice": type(voice).__name__, "memory": memory.name}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    await Session(ws, llm, voice, memory).run()


# Mounted last so /health and /ws take priority.
app.mount("/", StaticFiles(directory=config.ROOT / "device", html=True), name="device")
