"""ElevenLabs speech-to-text and text-to-speech over plain HTTP."""

import logging

import httpx

from integrations import config

log = logging.getLogger(__name__)


class ElevenLabsVoice:
    # Eleven v3 and v4 act out inline audio tags like [laughs]; older models would read them aloud.
    supports_tags = config.ELEVENLABS_TTS_MODEL.startswith(("eleven_v3", "eleven_v4"))

    def __init__(self) -> None:
        self._http = httpx.AsyncClient(
            base_url="https://api.elevenlabs.io/v1",
            headers={"xi-api-key": config.ELEVENLABS_API_KEY},
            timeout=30,
        )

    async def design_voice(self, name: str, description: str) -> str | None:
        """A new voice made from a written description, or None to fall back to a preset voice."""
        if not config.ELEVENLABS_VOICE_DESIGN:
            return None
        description = description.strip()[:1000]
        if len(description) < 20:  # the API's minimum
            return None
        try:
            # stream_previews skips sending back preview audio we'd never play.
            resp = await self._http.post(
                "/text-to-voice/design",
                json={
                    "voice_description": description,
                    "model_id": config.ELEVENLABS_VOICE_DESIGN_MODEL,
                    "auto_generate_text": True,
                    "stream_previews": True,
                },
            )
            resp.raise_for_status()
            body = resp.json()
            previews = body.get("previews") or [{}]
            generated = previews[0].get("generated_voice_id")
            if not generated:
                log.error("ElevenLabs voice design returned no previews: %s", body)
                return None
            # Previews can't be used for speech, so save the first one as a real voice.
            resp = await self._http.post(
                "/text-to-voice",
                json={
                    "voice_name": f"talk2tech {name}"[:100],
                    "voice_description": description,
                    "generated_voice_id": generated,
                    "labels": {"app": "talk2tech"},
                },
            )
            resp.raise_for_status()
            return resp.json()["voice_id"]
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            detail = exc.response.text[:300] if isinstance(exc, httpx.HTTPStatusError) else ""
            log.error("ElevenLabs voice design failed: %s %s", exc, detail)
            return None

    async def delete_voice(self, voice_id: str) -> None:
        """Remove a designed voice once its object is forgotten, so they don't fill the account's voice slots."""
        try:
            resp = await self._http.delete(f"/voices/{voice_id}")
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            log.warning("couldn't delete designed voice %s: %s", voice_id, exc)

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

    supports_tags = False  # the browser would read them aloud

    async def transcribe(self, audio: bytes, mime: str) -> str:
        return "Hey, who are you?"

    async def design_voice(self, name: str, description: str) -> str | None:
        return None

    async def delete_voice(self, voice_id: str) -> None:
        pass

    async def synthesize(self, text: str, voice_id: str) -> bytes | None:
        return None


def make_voice():
    if config.use_elevenlabs():
        return ElevenLabsVoice()
    log.warning("ELEVENLABS_API_KEY not set: using mock voice")
    return MockVoice()
