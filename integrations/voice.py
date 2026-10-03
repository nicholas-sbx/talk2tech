"""ElevenLabs speech-to-text and text-to-speech over plain HTTP."""

import logging

import httpx

from integrations import config

log = logging.getLogger(__name__)


class ElevenLabsVoice:
    def __init__(self) -> None:
        self._http = httpx.AsyncClient(
            base_url="https://api.elevenlabs.io/v1",
            headers={"xi-api-key": config.ELEVENLABS_API_KEY},
            timeout=30,
        )

    async def transcribe(self, audio: bytes, mime: str) -> str:
        resp = await self._http.post(
            "/speech-to-text",
            data={"model_id": config.ELEVENLABS_STT_MODEL},
            files={"file": ("clip", audio, mime or "application/octet-stream")},
        )
        resp.raise_for_status()
        return resp.json().get("text", "").strip()

    async def synthesize(self, text: str, voice_id: str) -> bytes | None:
        """Returns MP3 bytes, or None so the device falls back to on-device speech."""
        try:
            resp = await self._http.post(
                f"/text-to-speech/{voice_id}",
                params={"output_format": "mp3_44100_128"},
                json={"text": text, "model_id": config.ELEVENLABS_TTS_MODEL},
            )
            resp.raise_for_status()
            return resp.content
        except httpx.HTTPError as exc:
            log.error("ElevenLabs TTS failed for voice %s: %s", voice_id, exc)
            return None


class MockVoice:
    """No audio from the server: the device speaks with the browser's built-in voice instead."""

    async def transcribe(self, audio: bytes, mime: str) -> str:
        return "Hey, who are you?"

    async def synthesize(self, text: str, voice_id: str) -> bytes | None:
        return None


def make_voice():
    if config.use_elevenlabs():
        return ElevenLabsVoice()
    log.warning("ELEVENLABS_API_KEY not set: using mock voice")
    return MockVoice()
