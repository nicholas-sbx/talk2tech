"""Split a growing stream of LLM text into speakable sentences."""

import re

# Sentence end: terminal punctuation, optional closing quotes/brackets/asterisks, then whitespace.
_BOUNDARY = re.compile(r"[.!?…]+[\"')\]*]*\s+")
# Stage directions like *sighs*, audio tags like [laughs], and leftover markdown symbols.
_STAGE_DIRECTION = re.compile(r"\*[^*]*\*")
_AUDIO_TAG = re.compile(r"\[[^\]]*\]")
_MARKDOWN = re.compile(r"[*_#`~]+")


def clean_for_speech(text: str, keep_tags: bool = False) -> str:
    """Remove things the model shouldn't say out loud.

    keep_tags keeps audio tags like [laughs] for voices that act them out (Eleven v3/v4).
    """
    text = _STAGE_DIRECTION.sub("", text)
    if not keep_tags:
        text = _AUDIO_TAG.sub("", text)
    text = _MARKDOWN.sub("", text)
    return re.sub(r"\s{2,}", " ", text).strip()


def strip_leading_tags(text: str) -> str:
    """Drop audio tags from the start of a line, so it opens with words rather than a [sighs]."""
    return re.sub(r"^(\s*\[[^\]]*\])+\s*", "", text)


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
