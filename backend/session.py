"""One connected device: its current object persona, conversation history, and the turn loop.

Message formats are documented in docs/protocol.md.
"""

import asyncio
import base64
import contextlib
import logging
import uuid

from fastapi import WebSocket, WebSocketDisconnect

from backend.sentences import clean_for_speech, pop_sentences
from integrations.voices import voice_id_for

log = logging.getLogger(__name__)

MAX_HISTORY = 12


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
                if kind == "audio":
                    self._start_turn(self._audio_turn(msg))
                elif kind == "text":
                    self._start_turn(self._respond(msg.get("text", "").strip(), _decode(msg.get("image"))))
                elif kind == "interrupt":
                    self._cancel_turn()
                elif kind == "reset":
                    self._cancel_turn()
                    self.persona, self.voice_id, self.history = None, None, []
                    await self.send({"type": "reset"})
        except WebSocketDisconnect:
            pass
        finally:
            self._cancel_turn()

    def _start_turn(self, coro) -> None:
        # A new turn interrupts whatever the object was saying.
        self._cancel_turn()
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
        if not text:
            await self.send({"type": "error", "message": "Didn't catch that. Try again?"})
            await self.status("idle")
            return
        await self._respond(text, _decode(msg.get("image")))

    async def _respond(self, user_text: str, image: bytes | None) -> None:
        if not user_text:
            return
        await self.send({"type": "transcript", "text": user_text})

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
                await self._birth(image, lambda s: say(s, record=False))

            await self.status("thinking")
            buffer = ""
            async for delta in self.llm.reply_stream(self.persona, self.history, user_text, image):
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

    async def _birth(self, image: bytes | None, say) -> None:
        """First sight of an object: identify it and give it a personality and voice."""
        await self.status("waking")
        self.persona = await self.llm.make_persona(image)
        self.voice_id = voice_id_for(self.persona.get("voice"))
        await self.send({"type": "persona", "persona": self.persona})
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
