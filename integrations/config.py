"""Environment-driven settings. Each integration falls back to a mock when its keys are missing."""

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


# Set FORCE_MOCK=1 to run everything offline, even when keys are present.
FORCE_MOCK = _env("FORCE_MOCK") == "1"

GEMINI_API_KEY = _env("GEMINI_API_KEY")
GEMINI_MODEL = _env("GEMINI_MODEL", "gemini-3.5-flash-lite")
# Tried in order when the model before times out or is overloaded. Comma-separated, fastest first.
GEMINI_FALLBACK_MODELS = [
    m.strip()
    for m in _env("GEMINI_FALLBACK_MODELS", _env("GEMINI_FALLBACK_MODEL", "gemini-3.1-flash-lite")).split(",")
    if m.strip()
]
# Less thinking = faster replies. gemini-3.5-flash-lite supports minimal/low/medium/high.
GEMINI_THINKING_LEVEL = _env("GEMINI_THINKING_LEVEL", "minimal")
# If a model hasn't started answering after GEMINI_HEDGE_S, also send the prompt to the next one and
# take whichever answers first, up to GEMINI_MAX_ATTEMPTS requests and GEMINI_GIVE_UP_S overall.
GEMINI_HEDGE_S = float(_env("GEMINI_HEDGE_S", "1.5"))
GEMINI_MAX_ATTEMPTS = int(_env("GEMINI_MAX_ATTEMPTS", "4"))
GEMINI_GIVE_UP_S = float(_env("GEMINI_GIVE_UP_S", "12"))

ELEVENLABS_API_KEY = _env("ELEVENLABS_API_KEY")
ELEVENLABS_STT_MODEL = _env("ELEVENLABS_STT_MODEL", "scribe_v1")
# Eleven v3/v4 act out inline audio tags like [laughs] or [whispers]; older models would read them aloud.
ELEVENLABS_TTS_MODEL = _env("ELEVENLABS_TTS_MODEL", "eleven_v4_turbo")
ELEVENLABS_DEFAULT_VOICE_ID = _env("ELEVENLABS_DEFAULT_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")

LOCAL_EVENTS_PATH = ROOT / "data" / "events.jsonl"


def use_gemini() -> bool:
    return bool(GEMINI_API_KEY) and not FORCE_MOCK


def use_elevenlabs() -> bool:
    return bool(ELEVENLABS_API_KEY) and not FORCE_MOCK

