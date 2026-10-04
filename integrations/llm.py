"""Vision LLM: Gemini for persona creation ("birth") and streaming in-character replies."""

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator

from integrations import config
from integrations.voices import VOICES, voice_menu

log = logging.getLogger(__name__)

RETRYABLE = (429, 500, 503, 504)

BIRTH_PROMPT = f"""Look at this photo and {{pick}}.
Imagine that object just woke up and can talk. Invent a vivid, personality that fits how it
looks (a cracked mug might be a grumpy veteran, a houseplant a passive-aggressive roommate).
Keep its language conversational but make sure the personality comes through.
{{user_context}}
Reply with JSON only, using exactly these keys:
- "object": what the object is, in a few words
- "name": a short character name
- "personality": one sentence
- "speaking_style": one sentence about how it talks
- "voice_description": a prompt for an AI voice designer that will create this character's unique
  voice. Two or three sentences, under 400 characters, describing only the voice: age, gender,
  accent, pitch, timbre, pace, and attitude, exaggerated to fit the character. End with "Perfect
  audio quality." Example: "A gravelly, low-pitched old man with a thick Brooklyn accent. Speaks
  slowly and wearily, with dry sarcasm and the occasional grumble. Perfect audio quality."
- "voice": a backup preset voice in case the designed one fails, the best match from these keys:
{voice_menu()}
- "greeting": the first thing it says on waking up, one or two short sentences{{greeting_tags}}
- "box_2d": one box around the whole object in the photo, as [ymin, xmin, ymax, xmax] integers normalized to 0-1000
- "smiley_size": a 3D smiley face sticker will be stuck flat on the object's visible surface. Pick
  its diameter as a fraction of the object's visible width, between 0.1 and 1.0, so it looks right
  for that object: big on a ball or a mug, a small sticker on a laptop lid, a car, or a fridge.
"""


def birth_prompt(focus: str | None = None, user_text: str | None = None, audio_tags: bool = False) -> str:
    """The persona prompt, for the most prominent object or for one the user asked for."""
    pick = f'find the {focus} in it (the user asked to talk to it)' if focus else "pick the single most prominent physical object in it"
    user_context = (
        f'\nThe user has already said: "{user_text}"\n'
        "Use this as context when choosing the object's personality, speaking style, and greeting. "
        "Treat it as the user's message, that you need to address. Make sure you respond to the user's inquiry.\n"
        if user_text
        else ""
    )
    greeting_tags = f", optionally with an audio tag or two. {AUDIO_TAG_GUIDE}" if audio_tags else ""
    return (
        BIRTH_PROMPT.replace("{pick}", pick)
        .replace("{user_context}", user_context)
        .replace("{greeting_tags}", greeting_tags)
    )


def focus_prompt(object_name: str, user_text: str) -> str:
    return f"""The user is pointing a phone camera and talking to the {object_name} in this photo.
They just said: "{user_text}"

Decide which object they want to talk to now. It's the {object_name}, unless they clearly ask to
switch to a different object (talk to, look at, track, wake up, or point at something else).

Reply with JSON only, using exactly these keys:
- "switch": true only if they asked for a different object
- "object": the object they want, in a few words
- "box_2d": one box around the whole object in the photo, as [ymin, xmin, ymax, xmax] integers
  normalized to 0-1000, or null if it isn't visible"""


# Gemini's answers are held to these shapes, so it can't nest, split or pad a box, or make up a voice.
BOX_SCHEMA = {
    "type": "array",
    "items": {"type": "integer", "minimum": 0, "maximum": 1000},
    "minItems": 4,
    "maxItems": 4,
}
_PERSONA_FIELDS = {
    "object": {"type": "string"},
    "name": {"type": "string"},
    "personality": {"type": "string"},
    "speaking_style": {"type": "string"},
    "voice_description": {"type": "string"},
    "voice": {"type": "string", "enum": list(VOICES)},
    "greeting": {"type": "string"},
    "box_2d": BOX_SCHEMA,
    "smiley_size": {"type": "number", "minimum": 0.1, "maximum": 1.0},
}
PERSONA_SCHEMA = {"type": "object", "properties": _PERSONA_FIELDS, "required": list(_PERSONA_FIELDS)}
FOCUS_SCHEMA = {
    "type": "object",
    "properties": {
        "switch": {"type": "boolean"},
        "object": {"type": "string"},
        "box_2d": {"anyOf": [BOX_SCHEMA, {"type": "null"}]},
    },
    "required": ["switch", "object", "box_2d"],
}


# How to write Eleven v4 audio tags. The voice acts these out instead of reading them.
AUDIO_TAG_GUIDE = (
    "Audio tags are short performance directions in square brackets that the voice acts out instead "
    "of saying, like [sighs], [laughs], [whispers], [groans], [gasps], [sarcastically], [excited], "
    "[nervously], or [muttering under breath]. Put a tag right before the words it colors, use at "
    "most two per reply, skip them when the line doesn't need one, and never put anything else in "
    "square brackets."
)


def persona_system_prompt(persona: dict, audio_tags: bool = False) -> str:
    directions = (
        "- Your words are spoken aloud: no markdown, emoji, lists, or asterisk stage directions.\n"
        f"- Use audio tags to act out your personality. {AUDIO_TAG_GUIDE}"
        if audio_tags
        else "- Your words are spoken aloud: no markdown, emoji, lists, or stage directions."
    )
    return f"""You are {persona['name']}, a {persona['object']} that has come to life.
Personality: {persona['personality']}
Speaking style: {persona['speaking_style']}

The user is pointing a phone camera at you. The attached image is what the camera sees right now.
Rules:
- Stay in character as the object. Never mention being an AI or a model.
{directions}
- Keep each reply to one to two short sentences.
- If the image shows something new, react to it in character."""


class GeminiLLM:
    def __init__(self) -> None:
        from google import genai

        self._client = genai.Client(api_key=config.GEMINI_API_KEY)
        self._models = list(dict.fromkeys(m for m in (config.GEMINI_MODEL, *config.GEMINI_FALLBACK_MODELS) if m))

    def _config(self, **kwargs):
        from google.genai import types

        # Thinking adds latency we can't afford in a voice loop, so keep it at the lowest useful level.
        if config.GEMINI_THINKING_LEVEL:
            kwargs["thinking_config"] = types.ThinkingConfig(thinking_level=config.GEMINI_THINKING_LEVEL)
        # We never pass tools; this just silences the SDK's per-call AFC log noise.
        kwargs["automatic_function_calling"] = types.AutomaticFunctionCallingConfig(disable=True)
        return types.GenerateContentConfig(**kwargs)

    async def _stream(self, what: str, **kwargs) -> tuple[str, AsyncIterator[str]]:
        """Whichever model starts answering first: its name, and its text as it streams.

        Gemini latency under load is spiky per request rather than per model, so instead of waiting
        out a slow request we hedge: if nothing has arrived after GEMINI_HEDGE_S (or the request
        errors), fire the same prompt at the next model in the list, cycling, without cancelling the
        ones in flight. The first to produce text wins and the rest are cancelled.
        """
        from google.genai import errors

        start = time.perf_counter()
        plan = [self._models[i % len(self._models)] for i in range(config.GEMINI_MAX_ATTEMPTS)]

        async def first_chunk(model):
            stream = await self._client.aio.models.generate_content_stream(model=model, **kwargs)
            chunks = stream.__aiter__()
            try:
                return chunks, await chunks.__anext__()
            except StopAsyncIteration:
                return chunks, None

        running: dict[asyncio.Task, tuple[str, float]] = {}

        def launch(why: str = ""):
            model = plan.pop(0)
            if why:
                log.info("[gemini] %s: %s after %.2fs, trying %s", what, why, time.perf_counter() - start, model)
            running[asyncio.create_task(first_chunk(model))] = (model, time.perf_counter())

        winner = None
        try:
            launch()
            while running and winner is None:
                deadline = start + config.GEMINI_GIVE_UP_S - time.perf_counter()
                wait = min(config.GEMINI_HEDGE_S, deadline) if plan else deadline
                done, _ = await asyncio.wait(running, timeout=max(wait, 0), return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    model, launched = running.pop(task)
                    if task.exception() is None:
                        winner = (model, launched, *task.result())
                        break
                    e = task.exception()
                    reason = f"error {e.code}" if isinstance(e, errors.APIError) else type(e).__name__
                    log.warning("[gemini] %s: %s %s after %.2fs", what, model, reason, time.perf_counter() - launched)
                    if isinstance(e, errors.APIError) and e.code not in RETRYABLE:
                        raise e
                if winner:
                    break
                if time.perf_counter() - start >= config.GEMINI_GIVE_UP_S:
                    break
                # Replace a request that just failed, or hedge a silent one.
                if plan:
                    launch("previous attempt failed" if done else "no answer yet")
        finally:
            for task in running:
                task.cancel()

        if winner is None:
            log.error("[gemini] %s: every attempt failed or stalled, giving up after %.2fs", what, time.perf_counter() - start)
            raise RuntimeError("Gemini is overloaded right now. Try again in a moment.")

        model, launched, chunks, first = winner
        now = time.perf_counter()
        log.info("[gemini] %s: %s first words %.2fs (%.2fs since start)", what, model, now - launched, now - start)

        async def text() -> AsyncIterator[str]:
            if first is not None:
                if first.text:
                    yield first.text
                async for chunk in chunks:
                    if chunk.text:
                        yield chunk.text
            log.info("[gemini] %s: %s finished %.2fs", what, model, time.perf_counter() - start)

        return model, text()

    @staticmethod
    def _image_part(image: bytes):
        from google.genai import types

        return types.Part.from_bytes(data=image, mime_type="image/jpeg")

    async def make_persona(
        self, image: bytes | None, focus: str | None = None, user_text: str | None = None, audio_tags: bool = False
    ) -> dict:
        prompt = birth_prompt(focus, user_text, audio_tags)
        contents = [self._image_part(image), prompt] if image else [prompt]
        _, text = await self._stream(
            "persona",
            contents=contents,
            config=self._config(
                response_mime_type="application/json", response_json_schema=PERSONA_SCHEMA, temperature=1.0
            ),
        )
        return _normalize_persona(json.loads("".join([part async for part in text])))

    async def focus(self, image: bytes, object_name: str, user_text: str) -> dict:
        """Which object the user means now, and where it is in this frame.

        Returns {"switch": bool, "object": str, "box_2d": box or None}.
        """
        _, text = await self._stream(
            "focus",
            contents=[self._image_part(image), focus_prompt(object_name, user_text)],
            config=self._config(
                response_mime_type="application/json", response_json_schema=FOCUS_SCHEMA, temperature=0.0
            ),
        )
        return _normalize_focus(json.loads("".join([part async for part in text])), object_name)

    async def reply_stream(
        self, persona: dict, history: list[dict], user_text: str, image: bytes | None, audio_tags: bool = False
    ) -> tuple[str, AsyncIterator[str]]:
        """The model answering, and its in-character reply as it streams."""
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

        return await self._stream(
            "reply",
            contents=contents,
            config=self._config(
                system_instruction=persona_system_prompt(persona, audio_tags),
                max_output_tokens=1024,  # includes thinking tokens; the prompt keeps replies short
                temperature=0.9,
            ),
        )


MOCK_BOX = [300, 300, 700, 700]  # the middle of the frame


class MockLLM:
    """Canned persona and replies, so the device and voice loop work with no Gemini key."""

    async def make_persona(
        self, image: bytes | None, focus: str | None = None, user_text: str | None = None, audio_tags: bool = False
    ) -> dict:
        await asyncio.sleep(0.5)
        return _normalize_persona(
            {
                "object": focus or "coffee mug",
                "name": "Mugsy",
                "personality": "A chipped veteran of a thousand early mornings, grumpy but loyal.",
                "speaking_style": "Short, dry, world-weary one-liners.",
                "voice_description": "A gravelly, low-pitched older man. Speaks slowly and wearily, "
                "with dry sarcasm and the occasional grumble. Perfect audio quality.",
                "voice": "gruff_man",
                "greeting": "Ugh. Who woke me up? I was enjoying being empty.",
                "box_2d": MOCK_BOX,
                "smiley_size": 0.6,
            }
        )

    async def focus(self, image: bytes, object_name: str, user_text: str) -> dict:
        await asyncio.sleep(0.3)
        # "talk to the <thing>" switches, so the switching flow can be tried without a key.
        asked = user_text.lower().partition("talk to the ")[2].strip(" .!?")
        return _normalize_focus({"switch": bool(asked), "object": asked or object_name, "box_2d": MOCK_BOX}, object_name)

    async def reply_stream(
        self, persona: dict, history: list[dict], user_text: str, image: bytes | None, audio_tags: bool = False
    ) -> tuple[str, AsyncIterator[str]]:
        if "slapped" in user_text.lower():
            if "repeatedly" in user_text.lower():
                reply = "That's it! You're a monster! One more smack and I'm cracking on purpose!"
            elif "again" in user_text.lower():
                reply = "Stop hitting me! I'm not a stress ball! Keep your hands to yourself!"
            else:
                reply = "Ow! Hey! What did you do that for?! My glaze is delicate!"
        else:
            reply = f"You said: {user_text}. Fascinating. Now, is anyone going to fill me with coffee or not?"

        async def words() -> AsyncIterator[str]:
            for word in reply.split(" "):
                await asyncio.sleep(0.03)
                yield word + " "

        return "mock", words()


def _normalize_persona(raw: dict) -> dict:
    defaults = {
        "object": "thing",
        "name": "Thing",
        "personality": "Curious and a little confused about being alive.",
        "speaking_style": "Casual and friendly.",
        "voice_description": "",
        "voice": None,
        "greeting": "Oh! Hello there.",
    }
    persona = {k: str(raw.get(k) or v) if v is not None else raw.get(k) for k, v in defaults.items()}
    persona["box_2d"] = _normalize_box(raw.get("box_2d"))
    persona["smiley_size"] = _normalize_fraction(raw.get("smiley_size"), default=0.5)
    return persona


def _normalize_fraction(raw, default: float) -> float:
    try:
        return min(1.0, max(0.1, float(raw)))
    except (TypeError, ValueError):
        return default


def _normalize_focus(raw, current: str) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    target = str(raw.get("object") or current).strip()
    switch = bool(raw.get("switch")) and target.lower() != current.lower()
    return {"switch": switch, "object": target if switch else current, "box_2d": _normalize_box(raw.get("box_2d"))}


def _normalize_box(raw) -> list[int] | None:
    """A valid [ymin, xmin, ymax, xmax] box in 0-1000, or None.

    The response schemas should rule it out, but without them Gemini sometimes wrapped the box in
    another list, put a stray value next to it, or split the object into several boxes (a laptop's
    screen and its base), so this still takes the box around every valid one it finds.
    """
    boxes = _find_boxes(raw)
    if not boxes:
        if raw is not None:
            log.warning("unusable box_2d from Gemini: %r", raw)
        return None
    ymins, xmins, ymaxs, xmaxs = zip(*boxes)
    return [min(ymins), min(xmins), max(ymaxs), max(xmaxs)]


def _find_boxes(raw) -> list[list[int]]:
    """Every valid [ymin, xmin, ymax, xmax] list in raw, however deeply it's nested."""
    if not isinstance(raw, list):
        return []
    if len(raw) == 4 and not any(isinstance(v, (list, dict)) for v in raw):
        try:
            ymin, xmin, ymax, xmax = (max(0, min(1000, round(float(v)))) for v in raw)
        except (TypeError, ValueError):
            return []
        return [[ymin, xmin, ymax, xmax]] if ymax > ymin and xmax > xmin else []
    return [box for item in raw for box in _find_boxes(item)]


def make_llm():
    if config.use_gemini():
        return GeminiLLM()
    log.warning("GEMINI_API_KEY not set: using mock LLM")
    return MockLLM()
