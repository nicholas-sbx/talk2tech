# Architecture

```
 phone browser (device/)                 FastAPI (backend/)                      services (integrations/)
 ┌──────────────────────┐   WebSocket   ┌────────────────────────────┐
 │ camera  ─ frame on   │──────────────▶│ Session                    │──▶ ElevenLabs STT
 │          button press │  audio+frame │  1. transcribe             │
 │ mic     ─ push-to-   │              │  2. birth persona (once)   │──▶ Gemini (image → persona JSON)
 │          talk clip    │              │  3. stream reply           │──▶ Gemini (stream, in character)
 │ speaker ◀ MP3 per    │◀──────────────│  4. sentence → TTS, in     │──▶ ElevenLabs TTS (per sentence)
 │          sentence     │  say msgs    │     order, pipelined       │
 └──────────────────────┘              │  5. log in background ─────┼──▶ data/events.jsonl
                                        └────────────────────────────┘
                                                                         dashboard/ (Streamlit) reads the log
```

## Hot path vs slow path

- **Hot path** (every turn): STT → Gemini stream → per-sentence TTS. Each sentence is sent to TTS as
  soon as it is complete, and audio plays while later sentences are still generating.
  Target: under ~1.5 s from end of speech to first audio.
- **Slow path** (once per object): the "birth" call identifies the object and writes a persona.
  Its greeting is spoken first, which covers the wait.
- **Off the path**: memory writes run as background tasks and can never block or break a turn.

## Why frames, not video

Vision LLMs take still images. The device grabs one frame when the talk button is pressed, downscales
it, and attaches it to that turn. It feels live and costs far less than streaming video.

## Mock mode

Every integration has a mock with the same interface (`make_llm`, `make_voice`, `make_memory`).
A missing key switches that service to its mock, and `FORCE_MOCK=1` switches all of them.
In mock voice mode the device speaks replies with the browser's built-in speech synthesis.

## Next steps (build order)

1. ✅ Frame + push-to-talk → Gemini → spoken reply
2. ✅ Personas with preset voices
3. Unique voice per object via ElevenLabs voice design
4. Memory that recognizes an object again (image embeddings) and recalls past chats
5. Dashboard polish
