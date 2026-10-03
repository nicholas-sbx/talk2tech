"""Split a growing stream of LLM text into speakable sentences."""

import re

# Sentence end: terminal punctuation, optional closing quotes/brackets, then whitespace.
_BOUNDARY = re.compile(r"[.!?…]+[\"')\]]*\s+")


def pop_sentences(buffer: str) -> tuple[list[str], str]:
    """Return the complete sentences in `buffer` and the unfinished remainder."""
    sentences = []
    start = 0
    for match in _BOUNDARY.finditer(buffer):
        sentence = buffer[start : match.end()].strip()
        if sentence:
            sentences.append(sentence)
        start = match.end()
    return sentences, buffer[start:]
