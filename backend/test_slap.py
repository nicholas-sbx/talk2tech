"""Tests for physical force ('slap') interaction and progressive anger responses."""

import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock

from backend.session import Session
from integrations.llm import MockLLM
from integrations.memory import make_memory
from integrations.voice import MockVoice


class TestSlapInteraction(unittest.TestCase):
    def test_mock_llm_slap_escalation(self):
        """Verify MockLLM returns progressive anger responses for slaps."""
        mock = MockLLM()
        persona = {"name": "Mugsy", "object": "coffee mug"}

        async def get_reply(prompt: str) -> str:
            chunks = []
            async for token in mock.reply_stream(persona, [], prompt, None):
                chunks.append(token)
            return "".join(chunks).strip()

        # Level 1: First slap
        r1 = asyncio.run(get_reply("*I just slapped you!*"))
        self.assertIn("Ow!", r1)
        self.assertIn("glaze is delicate", r1)

        # Level 2: Second slap
        r2 = asyncio.run(get_reply("*I just slapped you again!*"))
        self.assertIn("Stop hitting me", r2)
        self.assertIn("hands to yourself", r2)

        # Level 3: Repeated slaps
        r3 = asyncio.run(get_reply("*I slapped you repeatedly!*"))
        self.assertIn("monster", r3)
        self.assertIn("cracking on purpose", r3)

    def test_session_slap_message_handling(self):
        """Verify Session processes slap messages, births if needed, and speaks reaction."""
        sent_messages = []

        fake_ws = AsyncMock()
        fake_ws.send_json = AsyncMock(side_effect=lambda msg: sent_messages.append(msg))

        # Feed a slap message then disconnect
        messages = [
            {"type": "slap", "anger_level": 1, "image": None, "frame_id": "frame1"},
        ]

        async def fake_receive_json():
            if messages:
                return messages.pop(0)
            while session._turn and not session._turn.done():
                await asyncio.sleep(0.05)
            from fastapi import WebSocketDisconnect
            raise WebSocketDisconnect()

        fake_ws.receive_json = AsyncMock(side_effect=fake_receive_json)

        llm = MockLLM()
        voice = MockVoice()
        memory = make_memory()

        session = Session(fake_ws, llm, voice, memory)
        asyncio.run(session.run())

        # Check that persona was created, say message sent, and done sent
        types = [m["type"] for m in sent_messages]
        self.assertIn("hello", types)
        self.assertIn("persona", types)
        self.assertIn("say", types)
        self.assertIn("done", types)

        say_texts = [m["text"] for m in sent_messages if m["type"] == "say"]
        combined_speech = " ".join(say_texts)
        self.assertIn("Ow!", combined_speech)

    def test_session_slap_escalation_sequence(self):
        """Verify successive slaps at anger levels 1, 2, and 3 produce appropriate reactions."""
        sent_messages = []

        fake_ws = AsyncMock()
        fake_ws.send_json = AsyncMock(side_effect=lambda msg: sent_messages.append(msg))

        messages = [
            {"type": "slap", "anger_level": 1, "image": None, "frame_id": "f1"},
            {"type": "slap", "anger_level": 2, "image": None, "frame_id": "f2"},
            {"type": "slap", "anger_level": 3, "image": None, "frame_id": "f3"},
        ]

        async def fake_receive_json():
            # Wait for previous turn to finish before feeding next slap
            while session._turn and not session._turn.done():
                await asyncio.sleep(0.02)
            if messages:
                return messages.pop(0)
            from fastapi import WebSocketDisconnect
            raise WebSocketDisconnect()

        fake_ws.receive_json = AsyncMock(side_effect=fake_receive_json)

        llm = MockLLM()
        voice = MockVoice()
        memory = make_memory()

        session = Session(fake_ws, llm, voice, memory)
        asyncio.run(session.run())

        say_texts = " ".join(m["text"] for m in sent_messages if m["type"] == "say")
        self.assertIn("Ow!", say_texts)
        self.assertIn("Stop hitting me", say_texts)
        self.assertIn("monster", say_texts)

    def test_session_slap_with_resume_flag_does_not_cancel_turn(self):
        """Verify slap with resume=True preserves the active dialogue turn."""
        sent_messages = []

        fake_ws = AsyncMock()
        fake_ws.send_json = AsyncMock(side_effect=lambda msg: sent_messages.append(msg))

        messages = [
            {"type": "text", "text": "Tell me a story", "image": None, "frame_id": "f1"},
            {"type": "slap", "anger_level": 1, "resume": True, "image": None, "frame_id": "f2"},
        ]

        async def fake_receive_json():
            if messages:
                msg = messages.pop(0)
                if msg["type"] == "slap":
                    # Give the previous turn a moment to begin executing
                    await asyncio.sleep(0.05)
                return msg
            while session._turn and not session._turn.done():
                await asyncio.sleep(0.02)
            from fastapi import WebSocketDisconnect
            raise WebSocketDisconnect()

        fake_ws.receive_json = AsyncMock(side_effect=fake_receive_json)

        llm = MockLLM()
        voice = MockVoice()
        memory = make_memory()

        session = Session(fake_ws, llm, voice, memory)
        asyncio.run(session.run())

        say_texts = " ".join(m["text"] for m in sent_messages if m["type"] == "say")
        # Ensure the original dialogue was not killed by the slap
        self.assertIn("Tell me a story", say_texts)


if __name__ == "__main__":
    unittest.main()
