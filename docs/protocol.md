# Device ↔ backend protocol

One WebSocket at `/ws`. Every message is a JSON text frame with a `type` field.
Binary payloads (images, audio) are base64 strings. Agree on changes here before coding them.

## Device → backend

| type | fields | meaning |
|---|---|---|
| `frame` | `image` (b64 JPEG), `frame_id` | Sent when the talk button is pressed. If no object is awake yet, the backend starts creating its persona right away, while the user is still talking. |
| `audio` | `mime`, `data` (b64 audio clip), `image` (b64 JPEG or null), `frame_id` | Push-to-talk clip just ended. `image` is the camera frame from when the button was pressed. |
| `text` | `text`, `image`, `frame_id` | Typed message, same as `audio` but skips speech-to-text. |
| `interrupt` | | User started talking; stop the current reply. |
| `reset` | | Forget the current object; the next turn "wakes up" a new one. |

Frames are JPEG, longest side ≤ 768 px, quality 0.7. `frame_id` is any string the device picks
for that image; the backend echoes it with boxes found in it (in AR, it names the camera pose the
frame was taken from).
Any new `audio` or `text` also interrupts the reply in progress.

## Backend → device

| type | fields | meaning |
|---|---|---|
| `hello` | `session_id`, `llm`, `voice`, `memory` | Sent on connect. Names of the active backends (mock or real). |
| `status` | `state`: `idle` · `transcribing` · `waking` · `thinking` · `speaking` | What the backend is doing. |
| `transcript` | `text` | What the user said. |
| `persona` | `persona`: `{object, name, personality, speaking_style, voice, greeting, box_2d}`, `box`, `frame_id` | A new object woke up. `box` is where it is in frame `frame_id` (or null). |
| `box` | `box`, `frame_id` | The object was found again in a later turn's frame. Sent alongside the reply, at most once per turn. |
| `say` | `text`, `audio` (b64 MP3 or null) | One sentence of the reply, in order. If `audio` is null, the device speaks `text` itself. |
| `done` | | Reply finished. |
| `stop` | | Reply was interrupted; drop any queued audio. |
| `reset` | | Object forgotten. |
| `error` | `message` | Something went wrong; show it and carry on. |

Boxes are Gemini's `box_2d`: `[ymin, xmin, ymax, xmax]`, integers normalized to 0–1000 over the frame.
