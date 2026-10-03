"""Vision LLM: Gemini for persona creation ("birth") and streaming in-character replies."""

import asyncio
import json
import logging
from collections.abc import AsyncIterator

from integrations import config
from integrations.voices import voice_menu

log = logging.getLogger(__name__)

BIRTH_PROMPT = f"""Look at this photo and pick the single most prominent physical object in it.
Imagine that object just woke up and can talk. Invent a vivid, funny personality that fits how it
looks (a cracked mug might be a grumpy veteran, a houseplant a passive-aggressive roommate).

Reply with JSON only, using exactly these keys:
- "object": what the object is, in a few words
- "name": a short character name
- "personality": one sentence
- "speaking_style": one sentence about how it talks
- "voice": the best match from this list of keys:
{voice_menu()}
- "greeting": the first thing it says on waking up, one or two short sentences
"""


def persona_system_prompt(persona: dict) -> str:
    return f"""You are {persona['name']}, a {persona['object']} that has come to life.
Personality: {persona['personality']}
Speaking style: {persona['speaking_style']}

The user is pointing a phone camera at you. The attached image is what the camera sees right now.
Rules:
- Stay in character as the object. Never mention being an AI or a model.
- Your words are spoken aloud: no markdown, emoji, lists, or stage directions.
- Keep each reply to one to three short sentences.
- If the image shows something new, react to it in character."""


class GeminiLLM:
    def __init__(self) -> None:
        from google import genai

        self._client = genai.Client(api_key=config.GEMINI_API_KEY)
        self._models = [m for m in (config.GEMINI_MODEL, config.GEMINI_FALLBACK_MODEL) if m]

    def _config(self, **kwargs):
        from google.genai import types

        # Thinking adds latency we can't afford in a voice loop, so keep it at the lowest useful level.
        if config.GEMINI_THINKING_LEVEL:
            kwargs["thinking_config"] = types.ThinkingConfig(thinking_level=config.GEMINI_THINKING_LEVEL)
        return types.GenerateContentConfig(**kwargs)

    async def _with_fallback(self, call, **kwargs):
        """Try each model in turn when one is overloaded or rate limited (503/429)."""
        from google.genai import errors

        for i, model in enumerate(self._models):
            try:
                return await call(model=model, **kwargs)
            except errors.APIError as e:
                if e.code not in (429, 503) or i == len(self._models) - 1:
                    raise
                log.warning("Gemini %s unavailable (%s), falling back to %s", model, e.code, self._models[i + 1])

    @staticmethod
    def _image_part(image: bytes):
        from google.genai import types

        return types.Part.from_bytes(data=image, mime_type="image/jpeg")

    async def make_persona(self, image: bytes | None) -> dict:
        contents = [self._image_part(image), BIRTH_PROMPT] if image else [BIRTH_PROMPT]
        resp = await self._with_fallback(
            self._client.aio.models.generate_content,
            contents=contents,
            config=self._config(response_mime_type="application/json", temperature=1.0),
        )
        return _normalize_persona(json.loads(resp.text))

    async def reply_stream(
        self, persona: dict, history: list[dict], user_text: str, image: bytes | None
    ) -> AsyncIterator[str]:
        from google.genai import types

        contents = [
            types.Content(
                role="user" if turn["role"] == "user" else "model",
                parts=[types.Part.from_text(text=turn["text"])],
            )
            for turn in history
        ]
        parts = [self._image_part(image)] if image else []
        parts.append(types.Part.from_text(text=user_text))
        contents.append(types.Content(role="user", parts=parts))

        stream = await self._with_fallback(
            self._client.aio.models.generate_content_stream,
            contents=contents,
            config=self._config(
                system_instruction=persona_system_prompt(persona),
                max_output_tokens=1024,  # includes thinking tokens; the prompt keeps replies short
                temperature=0.9,
            ),
        )
        async for chunk in stream:
            if chunk.text:
                yield chunk.text


class MockLLM:
    """Canned persona and replies, so the device and voice loop work with no Gemini key."""

    async def make_persona(self, image: bytes | None) -> dict:
        await asyncio.sleep(0.5)
        return _normalize_persona(
            {
                "object": "coffee mug",
                "name": "Mugsy",
                "personality": "A chipped veteran of a thousand early mornings, grumpy but loyal.",
                "speaking_style": "Short, dry, world-weary one-liners.",
                "voice": "gruff_man",
                "greeting": "Ugh. Who woke me up? I was enjoying being empty.",
            }
        )

    async def reply_stream(
        self, persona: dict, history: list[dict], user_text: str, image: bytes | None
    ) -> AsyncIterator[str]:
        reply = f"You said: {user_text}. Fascinating. Now, is anyone going to fill me with coffee or not?"
        for word in reply.split(" "):
            await asyncio.sleep(0.03)
            yield word + " "


def _normalize_persona(raw: dict) -> dict:
    defaults = {
        "object": "thing",
        "name": "Thing",
        "personality": "Curious and a little confused about being alive.",
        "speaking_style": "Casual and friendly.",
        "voice": None,
        "greeting": "Oh! Hello there.",
    }
    return {k: str(raw.get(k) or v) if v is not None else raw.get(k) for k, v in defaults.items()}


def make_llm():
    if config.use_gemini():
        return GeminiLLM()
    log.warning("GEMINI_API_KEY not set: using mock LLM")
    return MockLLM()
