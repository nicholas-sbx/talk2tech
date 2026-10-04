"""Tests for backend protocols, MockLLM, and persona normalization."""

import asyncio
import unittest

from backend.sentences import clean_for_speech, pop_sentences
from integrations.llm import BIRTH_PROMPT, MockLLM, _normalize_persona, persona_system_prompt


class TestBackendProtocol(unittest.TestCase):
    def test_birth_prompt_rejects_human_body_parts(self):
        """Verify prompt explicitly restricts selection to inanimate objects and forbids human body parts."""
        self.assertIn("inanimate physical object", BIRTH_PROMPT.lower())
        self.assertIn("human body parts", BIRTH_PROMPT.lower())
        self.assertIn("hands", BIRTH_PROMPT.lower())
        self.assertIn("arms", BIRTH_PROMPT.lower())
        self.assertIn("faces", BIRTH_PROMPT.lower())

    def test_persona_system_prompt_enforces_inanimate(self):
        persona = {
            "name": "Toasty",
            "object": "toaster",
            "personality": "Warm and enthusiastic.",
            "speaking_style": "Fast and punchy.",
        }
        prompt = persona_system_prompt(persona)
        self.assertIn("Toasty", prompt)
        self.assertIn("toaster", prompt)
        self.assertIn("strictly an inanimate object", prompt)

    def test_normalize_persona_defaults(self):
        """Verify _normalize_persona handles empty or partial dictionary safely."""
        norm = _normalize_persona({})
        self.assertEqual(norm["object"], "thing")
        self.assertEqual(norm["name"], "Thing")
        self.assertIsNotNone(norm["personality"])
        self.assertIsNotNone(norm["speaking_style"])
        self.assertIsNone(norm["voice"])
        self.assertEqual(norm["greeting"], "Oh! Hello there.")

    def test_normalize_persona_preserves_valid(self):
        raw = {
            "object": "desk lamp",
            "name": "Luxo",
            "personality": "Curious and bright.",
            "speaking_style": "Soft and reflective.",
            "voice": "gruff_man",
            "greeting": "Let there be light!",
        }
        norm = _normalize_persona(raw)
        self.assertEqual(norm["object"], "desk lamp")
        self.assertEqual(norm["name"], "Luxo")
        self.assertEqual(norm["voice"], "gruff_man")
        self.assertEqual(norm["greeting"], "Let there be light!")

    def test_normalize_persona_rejects_human_body_parts(self):
        """Verify _normalize_persona replaces human body parts with inanimate defaults."""
        for part in [
            "hand", "left arm", "my finger", "human face", "wrist",
            "person's thumb", "human ear", "left forearm", "fist",
            "knuckles", "someone's nose", "child's eye", "tongue",
            "white teeth", "stomach", "thigh", "guy", "dude"
        ]:
            raw = {"object": part, "name": "Handy"}
            norm = _normalize_persona(raw)
            self.assertEqual(norm["object"], "thing")
            self.assertEqual(norm["name"], "Thing")

    def test_normalize_persona_rejects_body_parts_in_name(self):
        """Verify _normalize_persona sanitizes when body part appears in name even if object is inanimate."""
        for name in ["Human Face", "Someone's Hand", "My Finger", "Little Boy", "Smiling Guy"]:
            raw = {"object": "mug", "name": name}
            norm = _normalize_persona(raw)
            self.assertEqual(norm["object"], "thing")
            self.assertEqual(norm["name"], "Thing")

    def test_mock_llm_persona_is_inanimate(self):
        """MockLLM persona should represent an inanimate object."""
        mock = MockLLM()
        persona = asyncio.run(mock.make_persona(None))
        self.assertEqual(persona["object"], "coffee mug")
        self.assertEqual(persona["name"], "Mugsy")
        self.assertIn("veteran", persona["personality"])
        self.assertIsNotNone(persona["greeting"])

    def test_mock_llm_reply_stream(self):
        mock = MockLLM()
        persona = {"name": "Mugsy", "object": "coffee mug"}

        async def collect():
            tokens = []
            async for token in mock.reply_stream(persona, [], "Hello mug!", None):
                tokens.append(token)
            return "".join(tokens)

        full_reply = asyncio.run(collect())
        self.assertIn("You said: Hello mug!", full_reply)
        self.assertIn("coffee", full_reply)

    def test_clean_for_speech_and_pop_sentences(self):
        text = "Hello there! This is a test. How are you?"
        sentences, rest = pop_sentences(text)
        self.assertEqual(len(sentences), 2)
        self.assertEqual(sentences[0], "Hello there!")
        self.assertEqual(sentences[1], "This is a test.")
        self.assertEqual(rest, "How are you?")

        cleaned = clean_for_speech("**Hello!** [laughs]")
        self.assertEqual(cleaned, "Hello!")


if __name__ == "__main__":
    unittest.main()
