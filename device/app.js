// talk2tech device client: camera + push-to-talk mic -> backend WebSocket -> spoken replies.
// Message formats: docs/protocol.md

const $ = (sel) => document.querySelector(sel);
const video = $("#cam");
const talkBtn = $("#talk");
const statusEl = $("#status");
const captions = $("#captions");
const textForm = $("#text-form");
const textInput = $("#text-input");

const STATUS_TEXT = {
  idle: "Hold to talk",
  listening: "Listening…",
  transcribing: "Hearing you…",
  waking: "Hold on, it's waking up…",
  thinking: "Thinking…",
  speaking: "Speaking… (hold to interrupt)",
};
const MAX_FRAME_SIDE = 768;
const MIN_CLIP_MS = 300;

let ws;
let camStream = null;
let micStream = null;
let recorder = null;
let recordStart = 0;
let pressFrame = null;
let audioCtx = null;
let playChain = Promise.resolve();
let playGen = 0; // bumped on interrupt so queued audio is dropped
let currentSource = null;
let thingBubble = null;

// ---------- startup ----------

$("#start-btn").addEventListener("click", async () => {
  // Must run inside a tap: iOS only unlocks audio playback and camera from a user gesture.
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    camStream = new MediaStream(stream.getVideoTracks());
    micStream = new MediaStream(stream.getAudioTracks());
    video.srcObject = camStream;
  } catch (err) {
    console.warn(err);
    const why = window.isSecureContext ? err.message : "Camera and mic need HTTPS (or localhost).";
    $("#start-error").textContent = `${why} Typing still works.`;
    textForm.hidden = false;
    await new Promise((r) => setTimeout(r, 1500));
  }
  $("#start").hidden = true;
  connect();
});

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setStatus("idle");
  ws.onclose = () => {
    talkBtn.disabled = true;
    statusEl.textContent = "Reconnecting…";
    setTimeout(connect, 1000);
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---------- server messages ----------

function handle(msg) {
  switch (msg.type) {
    case "hello":
      $("#mode").textContent = `${msg.llm} · ${msg.voice} · memory: ${msg.memory}`;
      break;
    case "status":
      setStatus(msg.state);
      break;
    case "transcript":
      thingBubble = null;
      bubble("user", msg.text);
      break;
    case "persona":
      $("#name").textContent = msg.persona.name;
      $("#object").textContent = msg.persona.object;
      break;
    case "say":
      if (!thingBubble) thingBubble = bubble("thing", "");
      thingBubble.textContent = (thingBubble.textContent + " " + msg.text).trim();
      enqueueSpeech(msg.text, msg.audio);
      break;
    case "done":
      thingBubble = null;
      break;
    case "stop":
      stopSpeech();
      break;
    case "reset":
      $("#name").textContent = "Point at something";
      $("#object").textContent = "Hold the button and say hi";
      captions.replaceChildren();
      break;
    case "error":
      bubble("error", msg.message);
      break;
  }
}

function setStatus(state) {
  talkBtn.disabled = !micStream;
  statusEl.textContent = micStream || state !== "idle" ? STATUS_TEXT[state] || state : "Type below to talk";
}

function bubble(kind, text) {
  const el = document.createElement("div");
  el.className = `bubble ${kind}`;
  el.textContent = text;
  captions.append(el);
  while (captions.children.length > 4) captions.firstChild.remove();
  return el;
}

// ---------- camera frames ----------

function grabFrame() {
  if (!camStream || !video.videoWidth) return null;
  const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
}

// ---------- push to talk ----------

function pickMime() {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  return options.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
}

function startRecording(ev) {
  ev.preventDefault();
  if (!micStream || recorder) return;
  talkBtn.setPointerCapture?.(ev.pointerId);
  stopSpeech();
  send({ type: "interrupt" });
  pressFrame = grabFrame(); // the frame from the moment you start talking
  // Lets a new object start waking up while you're still talking.
  if (pressFrame) send({ type: "frame", image: pressFrame });

  const mime = pickMime();
  const chunks = [];
  recorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    const tooShort = performance.now() - recordStart < MIN_CLIP_MS;
    recorder = null;
    if (tooShort || !chunks.length) return setStatus("idle");
    const blob = new Blob(chunks, { type: chunks[0].type || mime });
    send({ type: "audio", mime: blob.type, data: await toBase64(blob), image: pressFrame });
  };
  recorder.start();
  recordStart = performance.now();
  talkBtn.classList.add("recording");
  setStatus("listening");
}

function stopRecording() {
  talkBtn.classList.remove("recording");
  if (recorder && recorder.state === "recording") recorder.stop();
}

talkBtn.addEventListener("pointerdown", startRecording);
talkBtn.addEventListener("pointerup", stopRecording);
talkBtn.addEventListener("pointercancel", stopRecording);
talkBtn.addEventListener("contextmenu", (e) => e.preventDefault());

function toBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.readAsDataURL(blob);
  });
}

// ---------- typed fallback ----------

$("#keyboard").addEventListener("click", () => {
  textForm.hidden = !textForm.hidden;
  if (!textForm.hidden) textInput.focus();
});

textForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  stopSpeech();
  send({ type: "text", text, image: grabFrame() });
  textInput.value = "";
  textInput.blur();
});

// ---------- show text toggle (off by default, remembered per phone) ----------

const showText = $("#show-text");
try { showText.checked = localStorage.getItem("showText") === "1"; } catch {}
document.body.classList.toggle("show-text", showText.checked);
showText.addEventListener("change", () => {
  document.body.classList.toggle("show-text", showText.checked);
  try { localStorage.setItem("showText", showText.checked ? "1" : "0"); } catch {}
});

$("#reset").addEventListener("click", () => {
  stopSpeech();
  send({ type: "reset" });
});

// ---------- playback ----------

function enqueueSpeech(text, audioB64) {
  const gen = playGen;
  // Decode now, in parallel with whatever is playing; play strictly in order.
  const decoded = audioB64
    ? audioCtx.decodeAudioData(base64ToBuffer(audioB64)).catch(() => null)
    : Promise.resolve(null);
  playChain = playChain.then(async () => {
    if (gen !== playGen) return;
    const buffer = await decoded;
    if (gen !== playGen) return;
    await (buffer ? playBuffer(buffer) : speakLocally(text));
  });
}

function playBuffer(buffer) {
  return new Promise((resolve) => {
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    src.onended = () => {
      if (currentSource === src) currentSource = null;
      resolve();
    };
    currentSource = src;
    src.start();
  });
}

// Fallback when the server sends no audio (mock mode or a TTS error).
function speakLocally(text) {
  if (!window.speechSynthesis) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.onend = u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

function stopSpeech() {
  playGen++;
  playChain = Promise.resolve();
  if (currentSource) {
    try { currentSource.stop(); } catch {}
    currentSource = null;
  }
  window.speechSynthesis?.cancel();
}

function base64ToBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
