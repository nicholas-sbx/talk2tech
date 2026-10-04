"""Preset ElevenLabs voices the persona call picks from.

These are ElevenLabs premade voice IDs. Check they exist in your account's Voice Library
(some legacy premades are hidden on newer accounts) and swap in any IDs you like.
Later upgrade: generate a unique voice per object with ElevenLabs voice design.
"""

from integrations import config

VOICES = {
    "warm_woman": ("21m00Tcm4TlvDq8ikWAM", "calm, warm young woman"),
    "bold_woman": ("AZnzlk1XvdvUeBnXmlld", "strong, confident, slightly sassy woman"),
    "soft_woman": ("EXAVITQu4vr4xnSDxMaL", "soft, gentle, friendly woman"),
    "deep_man": ("pNInz6obpgDQGcFmaJgB", "deep, steady middle-aged man"),
    "young_man": ("TX3LPaxmHKxFdv7VOQHJ", "young, energetic man"),
    "friendly_man": ("ErXwobaYiN019PkySvjV", "well-rounded, friendly man"),
    "gruff_man": ("VR6AewLTigWG4xSOukaG", "gruff, crisp, older man"),
}


def voice_menu() -> str:
    return "\n".join(f"- {key}: {desc}" for key, (_, desc) in VOICES.items())


def voice_id_for(key: str | None) -> str:
    if key in VOICES:
        return VOICES[key][0]
    return config.ELEVENLABS_DEFAULT_VOICE_ID
