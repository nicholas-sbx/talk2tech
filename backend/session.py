"""One connected device: its current object persona, conversation history, and the turn loop.

Message formats are documented in docs/protocol.md.
"""

import asyncio
import base64
import contextlib
import logging
import re
import time
import uuid

from fastapi import WebSocket, WebSocketDisconnect

from backend.sentences import clean_for_speech, pop_sentences
from integrations.voices import voice_id_for

log = logging.getLogger(__name__)

MAX_HISTORY = 12
# Words that suggest the user wants a different object. For these, the reply waits until we know
# whether to switch, so the old object doesn't start answering first. Other turns don't wait.
SWITCH_HINT = re.compile(
    r"\b(switch|track|look at|talk to|speak to|focus|instead|another|other|different|this one|that one|wake)\b",
    re.IGNORECASE,
)


class Session:
    def __init__(self, ws: WebSocket, llm, voice, memory) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.ws = ws
        self.llm = llm
        self.voice = voice
        self.memory = memory
        self.persona: dict | None = None
        self.voice_id: str | None = None
        self.history: list[dict] = []
        self._turn: asyncio.Task | None = None
        # Persona generation started early, from the frame sent when the talk button is pressed.
        self._waking: asyncio.Task | None = None
        self._waking_frame: str | None = None  # frame_id of the image the persona is made from
        # Re-finds the object in each turn's frame so the device can re-anchor its AR marker.
        self._locating: asyncio.Task | None = None
        self._turn_start = 0.0
        self._send_lock = asyncio.Lock()

    async def send(self, msg: dict) -> None:
        async with self._send_lock:
            await self.ws.send_json(msg)

    async def status(self, state: str) -> None:
        await self.send({"type": "status", "state": state})

    async def run(self) -> None:
        await self.send(
            {
                "type": "hello",
                "session_id": self.id,
                "llm": type(self.llm).__name__,
                "voice": type(self.voice).__name__,
                "memory": self.memory.name,
            }
        )
        try:
            while True:
                msg = await self.ws.receive_json()
                kind = msg.get("type")
                if kind == "frame":
                    self._start_waking(_decode(msg.get("image")), msg.get("frame_id"))
                elif kind == "audio":
                    self._start_turn(self._audio_turn(msg))
                elif kind == "text":
                    image, frame_id = _decode(msg.get("image")), msg.get("frame_id")
                    self._start_turn(self._respond(msg.get("text", "").strip(), image, frame_id))
                elif kind == "interrupt":
                    self._cancel_turn()
                elif kind == "reset":
                    self._cancel_turn()
                    self._cancel_waking()
                    self._cancel_locating()
                    self.persona, self.voice_id, self.history = None, None, []
                    await self.send({"type": "reset"})
        except WebSocketDisconnect:
            pass
        finally:
            self._cancel_turn()
            self._cancel_waking()
            self._cancel_locating()

    def _start_waking(self, image: bytes | None, frame_id: str | None, focus: str | None = None) -> None:
        """Begin generating the persona while the user is still talking."""
        if self.persona is None and self._waking is None:
            self._waking = asyncio.create_task(self.llm.make_persona(image, focus))
            self._waking_frame = frame_id if image else None

    def _cancel_waking(self) -> None:
        if self._waking:
            self._waking.cancel()
            self._waking = None
        self._waking_frame = None

    def _start_locating(self, image: bytes, frame_id: str | None, user_text: str) -> None:
        """Find the object in this turn's frame, alongside the reply (or switch to another one)."""
        self._cancel_locating()
        self._locating = asyncio.create_task(self._locate(image, frame_id, user_text))

    def _cancel_locating(self) -> None:
        if self._locating and not self._locating.done():
            self._locating.cancel()

    async def _locate(self, image: bytes, frame_id: str | None, user_text: str) -> bool:
        """Returns True if the user asked for a different object and it's now waking up."""
        try:
            found = await self.llm.focus(image, self.persona["object"], user_text)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("locate failed", exc_info=True)  # only the AR marker misses an update
            return False
        if found["switch"]:
            log.info("switching from %s to %s", self.persona["object"], found["object"])
            self._switch_to(found["object"], user_text, image, frame_id)
            return True
        if found["box_2d"]:
            await self.send({"type": "box", "box": found["box_2d"], "frame_id": frame_id})
        return False

    def _switch_to(self, focus: str, user_text: str, image: bytes, frame_id: str | None) -> None:
        """Drop the current object and wake up the one the user asked for, answering what they said."""
        self._cancel_waking()
        self.persona, self.voice_id, self.history = None, None, []
        self._start_turn(self._respond(user_text, image, frame_id, focus=focus, echo=False))

    def _start_turn(self, coro) -> None:
        # A new turn interrupts whatever the object was saying.
        self._cancel_turn()
        self._turn_start = time.perf_counter()
        self._turn = asyncio.create_task(self._guarded(coro))

    def _cancel_turn(self) -> None:
        if self._turn and not self._turn.done():
            self._turn.cancel()

    async def _guarded(self, coro) -> None:
        try:
            await coro
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("turn failed")
            await self.send({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
            await self.status("idle")

    async def _audio_turn(self, msg: dict) -> None:
        await self.status("transcribing")
        text = await self.voice.transcribe(_decode(msg.get("data")) or b"", msg.get("mime", ""))
        log.info("[timing] speech-to-text %.2fs", time.perf_counter() - self._turn_start)
        if not text:
            await self.send({"type": "error", "message": "Didn't catch that. Try again?"})
            await self.status("idle")
            return
        await self._respond(text, _decode(msg.get("image")), msg.get("frame_id"))

    async def _respond(
        self,
        user_text: str,
        image: bytes | None,
        frame_id: str | None = None,
        focus: str | None = None,
        echo: bool = True,
    ) -> None:
        if not user_text:
            return
        if echo:
            await self.send({"type": "transcript", "text": user_text})
        if self.persona is not None and image:
            self._start_locating(image, frame_id, user_text)
            if SWITCH_HINT.search(user_text):
                await self.status("thinking")
                # Shielded: if it switches, it cancels this turn and starts the new object's.
                if await asyncio.shield(self._locating):
                    return

        speech: asyncio.Queue = asyncio.Queue()
        speaker = asyncio.create_task(self._speak_in_order(speech))
        pending_tts: list[asyncio.Task] = []

        reply: list[str] = []

        def say(sentence: str, record: bool = True) -> None:
            sentence = clean_for_speech(sentence)
            if not sentence:
                return
            if record:
                reply.append(sentence)
            task = asyncio.create_task(self.voice.synthesize(sentence, self.voice_id))
            pending_tts.append(task)
            speech.put_nowait((sentence, task))

        try:
            if self.persona is None:
                await self._birth(image, frame_id, lambda s: say(s, record=False), focus)

            await self.status("thinking")
            model, words = await self.llm.reply_stream(self.persona, self.history, user_text, image)
            await self.send({"type": "model", "model": model})
            buffer = ""
            async for delta in words:
                buffer += delta
                sentences, buffer = pop_sentences(buffer)
                for s in sentences:
                    say(s)
            say(buffer)

            speech.put_nowait(None)
            await speaker
        except BaseException as exc:
            speaker.cancel()
            for task in pending_tts:
                task.cancel()
            if isinstance(exc, asyncio.CancelledError):
                with contextlib.suppress(Exception):  # the socket may already be closed
                    await self.send({"type": "stop"})
            raise

        reply_text = " ".join(reply)
        self.history += [{"role": "user", "text": user_text}, {"role": "model", "text": reply_text}]
        self.history = self.history[-MAX_HISTORY:]
        name = self.persona["name"]
        self.memory.log(self.id, "turn", name, {"user": user_text, "reply": reply_text})

    async def _birth(self, image: bytes | None, frame_id: str | None, say, focus: str | None = None) -> None:
        """First sight of an object: identify it and give it a personality and voice."""
        await self.status("waking")
        self._start_waking(image, frame_id, focus)  # no-op if the button press already started it
        try:
            # Shielded so an interrupted turn doesn't throw away a persona that's nearly ready.
            persona = await asyncio.shield(self._waking)
        except asyncio.CancelledError:
            raise
        except Exception:
            self._waking = None  # let the next turn try again
            raise
        self.persona, self._waking = persona, None
        frame_id, self._waking_frame = self._waking_frame, None
        log.info("[timing] persona ready %.2fs after release", time.perf_counter() - self._turn_start)
        self.voice_id = voice_id_for(self.persona.get("voice"))
        # box is where the object sits in frame frame_id, so the device can pin its AR marker there.
        await self.send({"type": "persona", "persona": self.persona, "box": persona["box_2d"], "frame_id": frame_id})
        self.memory.log(self.id, "object", self.persona["name"], self.persona)

        greeting = self.persona["greeting"]
        sentences, rest = pop_sentences(greeting + " ")
        for s in sentences + ([rest.strip()] if rest.strip() else []):
            say(s)
        self.history.append({"role": "model", "text": clean_for_speech(greeting)})

    async def _speak_in_order(self, speech: asyncio.Queue) -> None:
        """Send sentences to the device in order, as soon as each one's audio is ready."""
        first = True
        while (item := await speech.get()) is not None:
            sentence, tts = item
            audio = await tts
            if first:
                log.info("[timing] first audio %.2fs after release", time.perf_counter() - self._turn_start)
                await self.status("speaking")
                first = False
            await self.send(
                {
                    "type": "say",
                    "text": sentence,
                    "audio": base64.b64encode(audio).decode() if audio else None,
                }
            )
        await self.send({"type": "done"})
        await self.status("idle")


def _decode(b64: str | None) -> bytes | None:
    return base64.b64decode(b64) if b64 else None
