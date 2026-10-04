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
        self.personas: list[dict] = []
        self.histories: list[list[dict]] = [[], []]
        self.voice_ids: list[str | None] = [None, None]
        self.persona: dict | None = None  # compatibility alias for the first face
        self.voice_id: str | None = None
        self.history: list[dict] = self.histories[0]
        self._turn: asyncio.Task | None = None
        # Persona generation started early, from the frame sent when the talk button is pressed.
        self._waking: asyncio.Task | None = None
        self._waking_frame: str | None = None  # frame_id of the image the persona is made from
        # Re-finds the object in each turn's frame so the device can re-anchor its AR marker.
        self._locating: asyncio.Task | None = None
        self._turn_start = 0.0
        self._first_audio_ms: float | None = None
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
                    self.personas, self.persona = [], None
                    self.voice_ids, self.histories = [None, None], [[], []]
                    self.voice_id, self.history = None, self.histories[0]
                    await self.send({"type": "reset"})
        except WebSocketDisconnect:
            pass
        finally:
            self._cancel_turn()
            self._cancel_waking()
            self._cancel_locating()

    def _start_waking(
        self,
        image: bytes | None,
        frame_id: str | None,
        focus: str | None = None,
        user_text: str | None = None,
    ) -> None:
        """Begin generating the persona while the user is still talking."""
        if not self.personas and self._waking is None:
            self._waking = asyncio.create_task(self.llm.make_personas(image, focus, user_text))
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
            await self.send({"type": "box", "speaker_id": 0, "box": found["box_2d"], "frame_id": frame_id})
        return False

    def _switch_to(self, focus: str, user_text: str, image: bytes, frame_id: str | None) -> None:
        """Drop the current object and wake up the one the user asked for, answering what they said."""
        self._cancel_waking()
        self.personas, self.persona = [], None
        self.voice_ids, self.histories = [None, None], [[], []]
        self.voice_id, self.history = None, self.histories[0]
        self._start_turn(self._respond(user_text, image, frame_id, focus=focus, echo=False))

    def _start_turn(self, coro) -> None:
        # A new turn interrupts whatever the object was saying.
        self._cancel_turn()
        self._turn_start = time.perf_counter()
        self._first_audio_ms = None
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
            self.memory.log(
                self.id,
                "turn_error",
                self.persona["name"] if self.persona else "unknown",
                {"status": "empty_transcription", "llm": type(self.llm).__name__, "voice": type(self.voice).__name__},
            )
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

        active_speaker = 0

        def say(sentence: str, record: bool = True, speaker_id: int | None = None) -> None:
            sentence = clean_for_speech(sentence)
            if not sentence:
                return
            if record:
                reply.append(sentence)
            speaker = active_speaker if speaker_id is None else speaker_id
            task = asyncio.create_task(self.voice.synthesize(sentence, self.voice_ids[speaker]))
            pending_tts.append(task)
            speech.put_nowait((speaker, sentence, task))

        try:
            if self.persona is None:
                await self._birth(
                    image, frame_id, lambda s, speaker_id=0: say(s, record=False, speaker_id=speaker_id), focus, user_text
                )

            await self.status("thinking")
            model, words = await self.llm.reply_stream(self.personas[0], self.histories[0], user_text, image)
            await self.send({"type": "model", "model": model, "speaker_id": 0})
            buffer = ""
            async for delta in words:
                buffer += delta
                sentences, buffer = pop_sentences(buffer)
                for s in sentences:
                    say(s)
            say(buffer)

            first_reply = " ".join(reply)
            self.histories[0] += [{"role": "user", "text": user_text}, {"role": "model", "text": first_reply}]
            self.histories[0] = self.histories[0][-MAX_HISTORY:]

            # Face 2 hears Face 1's words, not the user's raw turn.
            active_speaker = 1
            second_reply: list[str] = []
            second_input = f"Face 1 said: {first_reply}"
            model, words = await self.llm.reply_stream(self.personas[1], self.histories[1], second_input, image)
            await self.send({"type": "model", "model": model, "speaker_id": 1})
            buffer = ""
            async for delta in words:
                buffer += delta
                sentences, buffer = pop_sentences(buffer)
                for s in sentences:
                    say(s)
                    second_reply.append(clean_for_speech(s))
            if buffer:
                say(buffer)
                second_reply.append(clean_for_speech(buffer))
            speech.put_nowait(None)
            await speaker
        except BaseException as exc:
            speaker.cancel()
            for task in pending_tts:
                task.cancel()
            if isinstance(exc, asyncio.CancelledError):
                status = "interrupted"
            else:
                status = "error"
            self.memory.log(
                self.id,
                "turn_error",
                self.persona["name"] if self.persona else "unknown",
                {
                    "status": status,
                    "error": type(exc).__name__ if status == "error" else None,
                    "llm": type(self.llm).__name__,
                    "voice": type(self.voice).__name__,
                    "duration_ms": round((time.perf_counter() - self._turn_start) * 1000),
                },
            )
            if isinstance(exc, asyncio.CancelledError):
                with contextlib.suppress(Exception):  # the socket may already be closed
                    await self.send({"type": "stop"})
            raise

        reply_text = " ".join(reply)
        self.history = self.histories[0]
        name = self.personas[0]["name"]
        self.memory.log(
            self.id,
            "turn",
            name,
            {
                "user": user_text,
                "reply": reply_text,
                "status": "success",
                "time_to_first_audio_ms": self._first_audio_ms,
                "duration_ms": round((time.perf_counter() - self._turn_start) * 1000),
                "llm": type(self.llm).__name__,
                "voice": type(self.voice).__name__,
            },
        )
        self.histories[1] += [{"role": "user", "text": second_input}, {"role": "model", "text": " ".join(second_reply)}]
        self.histories[1] = self.histories[1][-MAX_HISTORY:]
        self.memory.log(
            self.id,
            "turn",
            self.personas[1]["name"],
            {
                "user": second_input,
                "reply": " ".join(second_reply),
                "status": "success",
                "speaker_id": 1,
                "llm": type(self.llm).__name__,
                "voice": type(self.voice).__name__,
            },
        )

    async def _birth(
        self,
        image: bytes | None,
        frame_id: str | None,
        say,
        focus: str | None = None,
        user_text: str | None = None,
    ) -> None:
        """First sight of an object: identify it and give it a personality and voice."""
        await self.status("waking")
        if user_text and self._waking is not None:
            # The frame message starts persona generation early, before transcription is ready.
            # Restart it once with the user's first words so birth can use that context.
            self._cancel_waking()
        self._start_waking(image, frame_id, focus, user_text)
        try:
            # Shielded so an interrupted turn doesn't throw away a persona that's nearly ready.
            persona = await asyncio.shield(self._waking)
        except asyncio.CancelledError:
            raise
        except Exception:
            self._waking = None  # let the next turn try again
            raise
        self.personas, self._waking = persona, None
        self.persona = self.personas[0]
        self.histories = [[], []]
        self.history = self.histories[0]
        frame_id, self._waking_frame = self._waking_frame, None
        log.info("[timing] persona ready %.2fs after release", time.perf_counter() - self._turn_start)
        self.voice_ids = [voice_id_for(item.get("voice")) for item in self.personas]
        self.voice_id = self.voice_ids[0]
        for speaker_id, persona in enumerate(self.personas):
            await self.send(
                {
                    "type": "persona",
                    "speaker_id": speaker_id,
                    "persona": persona,
                    "box": persona["box_2d"],
                    "frame_id": frame_id,
                }
            )
            self.memory.log(self.id, "object", persona["name"], {**persona, "speaker_id": speaker_id})
            greeting = persona["greeting"]
            sentences, rest = pop_sentences(greeting + " ")
            for s in sentences + ([rest.strip()] if rest.strip() else []):
                say(s, speaker_id=speaker_id)
            self.histories[speaker_id].append({"role": "model", "text": clean_for_speech(greeting)})

    async def _speak_in_order(self, speech: asyncio.Queue) -> None:
        """Send sentences to the device in order, as soon as each one's audio is ready."""
        first = True
        while (item := await speech.get()) is not None:
            speaker_id, sentence, tts = item
            audio = await tts
            if first:
                self._first_audio_ms = round((time.perf_counter() - self._turn_start) * 1000)
                log.info("[timing] first audio %.2fs after release", time.perf_counter() - self._turn_start)
                await self.status("speaking")
                first = False
            await self.send(
                {
                    "type": "say",
                    "speaker_id": speaker_id,
                    "text": sentence,
                    "audio": base64.b64encode(audio).decode() if audio else None,
                }
            )
        await self.send({"type": "done"})
        await self.status("idle")


def _decode(b64: str | None) -> bytes | None:
    return base64.b64decode(b64) if b64 else None
