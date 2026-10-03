"""Split a growing stream of LLM text into speakable sentences."""

import re

# Sentence end: terminal punctuation, optional closing quotes/brackets/asterisks, then whitespace.
_BOUNDARY = re.compile(r"[.!?…]+[\"')\]*]*\s+")
# Stage directions like *sighs* or [laughs], and leftover markdown symbols.
_STAGE_DIRECTION = re.compile(r"\*[^*]*\*|\[[^\]]*\]")
_MARKDOWN = re.compile(r"[*_#`~]+")


def clean_for_speech(text: str) -> str:
    """Remove things the model shouldn't say out loud."""
    text = _MARKDOWN.sub("", _STAGE_DIRECTION.sub("", text))
    return re.sub(r"\s{2,}", " ", text).strip()


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
