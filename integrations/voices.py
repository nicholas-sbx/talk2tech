"""Preset ElevenLabs voices the persona call picks from.

These are the current ElevenLabs premade voices, which all work with Eleven v4. Adam is left out
on purpose: he's the narrator of every Reddit story video and kills the bit.
"""

from integrations import config

VOICES = {
    # Women
    "bright_woman": ("hpp4J3VqNfWAUOO0d1Us", "warm, bright, polished middle-aged woman"),
    "confident_woman": ("EXAVITQu4vr4xnSDxMaL", "confident, reassuring young woman"),
    "quirky_woman": ("FGY2WhTYpPnrIDTdsKH5", "sunny, quirky, sassy young woman"),
    "playful_woman": ("cgSgspJ2msm6clMCkdW9", "playful, cute, bubbly young woman"),
    "alto_woman": ("XrExE9yKIg1WjnnlVkGX", "upbeat, knowledgeable woman with a low alto voice"),
    "british_woman": ("Xb7hH8MSUJpSbSDYk0k2", "clear, friendly British woman, like a good teacher"),
    "velvety_woman": ("pFZP5JQG7iQjIQuC4Bku", "velvety, dramatic British actress"),
    # Men
    "young_man": ("TX3LPaxmHKxFdv7VOQHJ", "young, energetic man"),
    "chill_man": ("bIHbv24MWmeRgasZH58o", "chill, laid-back young optimist"),
    "aussie_man": ("IKne3meq5aSn9XLyUdCD", "hyped, confident young Australian man"),
    "warrior_man": ("SOYHLrjzK2X1ezoPC6cr", "rough, fierce young warrior, ready to charge"),
    "casual_man": ("iP95p4xoKVk53GoZ742B", "charming, down-to-earth regular guy"),
    "laid_back_man": ("CwhRBWXzGAHq8TQ4Fs17", "laid-back, resonant, classy middle-aged man"),
    "smooth_man": ("cjVigY5qzO86Huf0OWal", "smooth, trustworthy tenor in his 40s"),
    "deep_man": ("nPczCjzI2devNBz1zQrb", "deep, resonant, comforting middle-aged man"),
    "gruff_man": ("N2lVS1w4EtoT3dr4eOWO", "husky, gravelly trickster with an unsettling edge"),
    "storyteller_man": ("JBFqnCBsd6RMkjVDRZzb", "warm, captivating British storyteller"),
    "broadcaster_man": ("onwK4e9ZLuTAKqWW03F9", "steady, formal British newsreader"),
    "old_man": ("pqHfZKP75CvOlQylNhV4", "wise, mature, friendly old man"),
    # Neither
    "neutral": ("SAz9YHcvj6GT2YYXdXww", "relaxed, calm, gender-neutral voice"),
}


def voice_menu() -> str:
    return "\n".join(f"- {key}: {desc}" for key, (_, desc) in VOICES.items())


def voice_id_for(key: str | None) -> str:
    if key in VOICES:
        return VOICES[key][0]
    return config.ELEVENLABS_DEFAULT_VOICE_ID
