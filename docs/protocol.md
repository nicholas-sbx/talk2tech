# Device ↔ backend protocol

One WebSocket at `/ws`. Every message is a JSON text frame with a `type` field.
Binary payloads (images, audio) are base64 strings. Agree on changes here before coding them.

## Device → backend

| type | fields | meaning |
|---|---|---|
| `frame` | `image` (b64 JPEG) | Sent when the talk button is pressed. If no object is awake yet, the backend starts creating its persona right away, while the user is still talking. |
| `audio` | `mime`, `data` (b64 audio clip), `image` (b64 JPEG or null) | Push-to-talk clip just ended. `image` is the camera frame from when the button was pressed. |
| `text` | `text`, `image` | Typed message, same as `audio` but skips speech-to-text. |
| `interrupt` | | User started talking; stop the current reply. |
| `reset` | | Forget the current object; the next turn "wakes up" a new one. |

Frames are JPEG, longest side ≤ 768 px, quality 0.7.
Any new `audio` or `text` also interrupts the reply in progress.

## Backend → device

| type | fields | meaning |
|---|---|---|
| `hello` | `session_id`, `llm`, `voice`, `memory` | Sent on connect. Names of the active backends (mock or real). |
| `status` | `state`: `idle` · `transcribing` · `waking` · `thinking` · `speaking` | What the backend is doing. |
| `transcript` | `text` | What the user said. |
| `persona` | `persona`: `{object, name, personality, speaking_style, voice, greeting}` | A new object woke up. |
| `say` | `text`, `audio` (b64 MP3 or null) | One sentence of the reply, in order. If `audio` is null, the device speaks `text` itself. |
| `done` | | Reply finished. |
| `stop` | | Reply was interrupted; drop any queued audio. |
| `reset` | | Object forgotten. |
| `error` | `message` | Something went wrong; show it and carry on. |
