// talk2tech device client: camera + push-to-talk mic -> backend WebSocket -> spoken replies.
// Message formats: docs/protocol.md

import { arSupported, requestMotionPermission, startAR, captureFrame, placeBox, clearMarker, inAR, setSpeaking, onDeath, onScream } from "./ar.js";

const $ = (sel) => document.querySelector(sel);
const video = $("#cam");
const talkBtn = $("#talk");
const statusEl = $("#status");
const captions = $("#captions");
const textForm = $("#text-form");
const textInput = $("#text-input");
const dashboardLink = $("#dashboard-link");

const STATUS_TEXT = {
  idle: "Hold to talk",
  listening: "Listening…",
  transcribing: "Hearing you…",
  waking: "Hold on, it's waking up…",
  thinking: "Thinking…",
  speaking: "Speaking… (hold to interrupt)",
};
const PLACEHOLDER = { name: "Point at something", object: "then hold to talk" };
const MAX_FRAME_SIDE = 768;
const MIN_CLIP_MS = 300;
const CAMERA_RETRY_MS = 2000;
const VIDEO = { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } };
const AUDIO = { echoCancellation: true, noiseSuppression: true };
const MIC_REOPEN_MS = 400;
const MAX_CAPTION_LINES = 60;
const TEXT_HIDE_DELAY_MS = 300;
const DEBUG = new URLSearchParams(location.search).has("debug");
const DEBUG_FRAMES_KEPT = 10;
const arAvailable = arSupported();

if (DEBUG) {
  const dashboardUrl = new URL(location.href);
  dashboardUrl.protocol = "http:";
  dashboardUrl.port = "8501";
  dashboardUrl.pathname = "/";
  dashboardUrl.search = "";
  dashboardUrl.hash = "";
  dashboardLink.href = dashboardUrl.href;
  dashboardLink.hidden = false;
}

let ws;
let camStream = null;
let camRetry = null;
let micAllowed = false;
// The mic stays open while idle so pressing records instantly, and closes while a reply plays:
// a live mic puts iOS in "phone call" audio mode, which ducks and pumps the speaker.
let micStream = null;
let micOpening = null;
let micReopen = null;
let recorder = null;
let held = false;
let recordStart = 0;
let frameCounter = 0;
const smileySizes = [undefined, undefined]; // each object's smiley diameter, as a share of its width
const debugFrames = new Map();
let audioCtx = null;
let voice = null; // replies play through this analyser, so the AR face's mouth can follow them
let playChain = Promise.resolve();
let playGen = 0; // bumped on interrupt so queued audio is dropped
let pendingSpeech = 0;
let current = null; // the sentence playing now: { pause, resume, stop }
let screaming = false; // an AR face is screaming, so the microphone stays closed
const speakerNames = ["Face 1", "Face 2"];
const thingLines = [null, null];

// ---------- startup ----------

$("#start-btn").addEventListener("click", async () => {
  // Must run inside a tap: iOS only unlocks audio playback, camera and motion sensors from a user
  // gesture. Motion is asked for before anything awaits, while the tap still counts.
  const motion = arAvailable ? requestMotionPermission() : null;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();
  voice = audioCtx.createAnalyser();
  voice.fftSize = 1024;
  voice.connect(audioCtx.destination);
  // Safari keeps the audio session type across reloads; a leftover "playback" blocks the mic.
  setAudioSession("auto");
  if (arAvailable) return startWithAR(motion);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO, audio: AUDIO });
    useCamera(new MediaStream(stream.getVideoTracks()));
    micAllowed = stream.getAudioTracks().length > 0;
    if (micAllowed) useMic(new MediaStream(stream.getAudioTracks()));
  } catch (err) {
    console.warn(err);
    // One of the two failed: get the mic on its own and keep retrying the camera in the background.
    try {
      useMic(await navigator.mediaDevices.getUserMedia({ audio: AUDIO }));
      micAllowed = true;
    } catch (micErr) {
      console.warn(micErr);
      const why = window.isSecureContext ? micErr.message : "Camera and mic need HTTPS (or localhost).";
      $("#start-error").textContent = `${why} Typing still works.`;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (window.isSecureContext) retryCamera();
  }
  finishStart();
});

// The AR engine owns the camera, so only the mic comes from getUserMedia here.
async function startWithAR(motion) {
  await motion;
  try {
    useMic(await navigator.mediaDevices.getUserMedia({ audio: AUDIO }));
    micAllowed = true;
  } catch (err) {
    console.warn(err);
  }
  let arError = null;
  try {
    await startAR(audioCtx);
    document.documentElement.classList.add("ar");
  } catch (err) {
    // Camera or motion access refused, unsupported browser, etc.: carry on with the plain camera view.
    console.warn("AR unavailable", err);
    arError = err;
    navigator.mediaDevices.getUserMedia({ video: VIDEO }).then(useCamera, retryCamera);
  }
  finishStart();
  if (arError) line("error", `AR is off: ${arError.message}`);
}

function finishStart() {
  if ($("#start").hidden) return;
  $("#start").hidden = true;
  document.querySelector('meta[name="theme-color"]').content = "#000000";
  connect();
}

function useCamera(stream) {
  camStream = stream;
  video.srcObject = stream;
  // e.g. another app grabbed the camera: drop it and keep trying to get it back.
  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (camStream === stream) camStream = null;
    retryCamera();
  });
}

function retryCamera() {
  if (camRetry) return;
  camRetry = setTimeout(async () => {
    camRetry = null;
    try {
      useCamera(await navigator.mediaDevices.getUserMedia({ video: VIDEO }));
    } catch (err) {
      console.warn(err);
      retryCamera();
    }
  }, CAMERA_RETRY_MS);
}

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
      $("#mode").hidden = !DEBUG;
      break;
    case "status":
      setStatus(msg.state);
      break;
    case "transcript":
      thingLines.fill(null);
      line("user", msg.text);
      break;
    case "persona":
      {
        const speakerId = msg.speaker_id ?? 0;
        if (speakerId === 0) {
          $("#name").textContent = msg.persona.name;
          $("#object").textContent = msg.persona.object;
        }
        speakerNames[speakerId] = msg.persona.name;
        smileySizes[speakerId] = msg.persona.smiley_size;
        if (msg.box) showBox(msg.box, msg.frame_id, speakerId);
      }
      break;
    case "box":
      showBox(msg.box, msg.frame_id, msg.speaker_id ?? 0);
      break;
    case "model":
      $("#model").textContent = msg.model;
      break;
    case "say":
      {
        const speakerId = msg.speaker_id ?? 0;
        const prefix = `${speakerNames[speakerId]}: `;
        if (!thingLines[speakerId]) thingLines[speakerId] = line("thing", prefix);
        followCaptions(() => {
          const previous = thingLines[speakerId].textContent.startsWith(prefix)
            ? thingLines[speakerId].textContent.slice(prefix.length)
            : "";
          thingLines[speakerId].textContent = `${prefix}${(previous + " " + msg.text).trim()}`;
        });
      }
      enqueueSpeech(msg.text, msg.audio, msg.speaker_id ?? 0);
      break;
    case "done":
      thingLines.fill(null);
      break;
    case "stop":
      stopSpeech();
      break;
    case "reset":
      $("#name").textContent = PLACEHOLDER.name;
      $("#object").textContent = PLACEHOLDER.object;
      clearMarker();
      captions.replaceChildren();
      captions.classList.remove("scrolled");
      break;
    case "error":
      line("error", msg.message);
      break;
  }
}

function setStatus(state) {
  talkBtn.disabled = !micAllowed;
  statusEl.textContent = micAllowed || state !== "idle" ? STATUS_TEXT[state] || state : "Tap the keyboard to type";
}

function line(kind, text) {
  const el = document.createElement("div");
  el.className = `line ${kind}`;
  el.textContent = text;
  followCaptions(() => {
    captions.append(el);
    while (captions.children.length > MAX_CAPTION_LINES) captions.firstChild.remove();
  });
  return el;
}

// Keeps the newest caption in view, unless you've scrolled up to read older ones.
function followCaptions(mutate) {
  const atBottom = captions.scrollHeight - captions.scrollTop - captions.clientHeight < 24;
  mutate();
  if (atBottom) captions.scrollTop = captions.scrollHeight;
}

captions.addEventListener("scroll", () => captions.classList.toggle("scrolled", captions.scrollTop > 0));

// ---------- camera frames ----------

// Resolves to { image (b64 JPEG or null), frameId }. The backend echoes frameId with any box it
// finds, so the box can be matched to the camera pose of the moment the frame was taken.
async function grabFrame() {
  const frame = inAR() ? await captureFrame() : grabVideoFrame();
  if (!frame?.image) return { image: null, frameId: null };
  if (DEBUG) {
    debugFrames.set(frame.frameId, frame.image);
    while (debugFrames.size > DEBUG_FRAMES_KEPT) debugFrames.delete(debugFrames.keys().next().value);
  }
  return frame;
}

function grabVideoFrame() {
  if (!camStream || !video.videoWidth) return null;
  const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return { image: canvas.toDataURL("image/jpeg", 0.7).split(",")[1], frameId: `cam${++frameCounter}` };
}

// Where Gemini found the object: stick the AR smiley there, and with ?debug draw it on the sent frame.
function showBox(box, frameId, speakerId = 0) {
  placeBox(box, frameId, smileySizes[speakerId], speakerId);
  const image = debugFrames.get(frameId);
  if (!DEBUG || !image) return;
  const img = new Image();
  img.onload = () => {
    const canvas = $("#debug-frame");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const [ymin, xmin, ymax, xmax] = box;
    ctx.strokeStyle = "#22ff66";
    ctx.lineWidth = 4;
    ctx.strokeRect(
      (xmin / 1000) * img.width,
      (ymin / 1000) * img.height,
      ((xmax - xmin) / 1000) * img.width,
      ((ymax - ymin) / 1000) * img.height,
    );
    canvas.hidden = false;
  };
  img.src = `data:image/jpeg;base64,${image}`;
}

// ---------- push to talk ----------

function pickMime() {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  return options.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
}

// Safari 17+: say explicitly whether we're recording, so playback isn't treated like a call.
function setAudioSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch {}
}

addEventListener("pagehide", () => setAudioSession("auto"));
// iOS ends capture in the background; get the mic back when the page returns.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleMicReopen();
});

function micLive() {
  return micStream?.getAudioTracks().some((t) => t.readyState === "live");
}

function useMic(stream) {
  micStream = stream;
  stream.getAudioTracks()[0]?.addEventListener("ended", () => {
    if (micStream === stream) micStream = null;
  });
}

// Resolves to an open mic stream, opening one if needed.
function getMic() {
  if (micLive()) return Promise.resolve(micStream);
  if (!micOpening) {
    // "auto" becomes play-and-record on its own once capture starts.
    setAudioSession("auto");
    micOpening = navigator.mediaDevices
      .getUserMedia({ audio: AUDIO })
      .catch(async (err) => {
        // Safari can reject capture while the "playback" session is still being swapped out; retry once.
        if (!navigator.audioSession) throw err;
        console.warn(err);
        await new Promise((r) => setTimeout(r, 250));
        return navigator.mediaDevices.getUserMedia({ audio: AUDIO });
      })
      .then((stream) => {
        // A reply (or scream) started playing while we were opening: don't hold the mic over it.
        if (outLoud() && !recorder && !held) {
          stream.getTracks().forEach((t) => t.stop());
          setAudioSession("playback");
          return null;
        }
        useMic(stream);
        return stream;
      })
      .finally(() => (micOpening = null));
  }
  return micOpening;
}

function releaseMic() {
  clearTimeout(micReopen);
  if (recorder || held || !micStream) return;
  micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  setAudioSession("playback");
}

function scheduleMicReopen() {
  clearTimeout(micReopen);
  if (!micAllowed) return;
  micReopen = setTimeout(() => {
    if (!outLoud()) getMic().catch((err) => console.warn(err));
  }, MIC_REOPEN_MS);
}

async function startRecording(ev) {
  ev.preventDefault();
  if (!micAllowed || held || recorder) return;
  held = true;
  talkBtn.setPointerCapture?.(ev.pointerId);
  stopSpeech();
  audioCtx?.resume();
  send({ type: "interrupt" });
  // The frame from the moment you start talking, grabbed while the mic comes up.
  const framing = grabFrame().then((frame) => {
    // Lets a new object start waking up while you're still talking.
    if (frame.image) send({ type: "frame", image: frame.image, frame_id: frame.frameId });
    return frame;
  });
  talkBtn.classList.add("recording");
  setStatus("listening");

  // Instant when idle; only after interrupting a reply does the mic need to reopen first.
  let stream;
  try {
    stream = await getMic();
  } catch (err) {
    console.warn(err);
    talkBtn.classList.remove("recording");
    held = false;
    line("error", `Mic unavailable: ${err.message}`);
    return setStatus("idle");
  }
  if (!held || recorder) return setStatus("idle"); // let go before the mic came up

  const mime = pickMime();
  const chunks = [];
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    const tooShort = performance.now() - recordStart < MIN_CLIP_MS;
    recorder = null;
    if (tooShort || !chunks.length) return setStatus("idle");
    const blob = new Blob(chunks, { type: chunks[0].type || mime });
    const [data, frame] = await Promise.all([toBase64(blob), framing]);
    send({ type: "audio", mime: blob.type, data, image: frame.image, frame_id: frame.frameId });
  };
  recorder.start();
  recordStart = performance.now();
}

function stopRecording() {
  held = false;
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

// Opened with a tap, the text box only exists while focused: losing focus hides it.
// Opened with a mouse (or keyboard), it stays until the keyboard button is clicked again.
// Decided per press, so touchscreen laptops get whichever fits how you pressed it.
const keyboardBtn = $("#keyboard");
let keyboardPointer = "";
let textSticky = false;

keyboardBtn.addEventListener("pointerdown", (e) => (keyboardPointer = e.pointerType));
keyboardBtn.addEventListener("click", () => {
  const tapped = keyboardPointer === "touch" || keyboardPointer === "pen";
  keyboardPointer = "";
  if (!tapped && textSticky && !textForm.hidden) {
    textForm.hidden = true;
    return;
  }
  textSticky = !tapped;
  textForm.hidden = false;
  textInput.focus();
});

// Hiding waits a moment: iOS doesn't focus a tapped button, so tapping Send blurs the input
// (relatedTarget null) before the click arrives, and hiding right away would swallow the send.
textForm.addEventListener("focusout", (e) => {
  if (textSticky || textForm.contains(e.relatedTarget)) return;
  setTimeout(() => {
    if (!textSticky && !textForm.contains(document.activeElement)) textForm.hidden = true;
  }, TEXT_HIDE_DELAY_MS);
});

// Where the browser allows it, keep focus in the input when pressing Send.
textForm.querySelector("button").addEventListener("mousedown", (e) => e.preventDefault());

textForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  stopSpeech();
  textInput.value = "";
  if (!textSticky) textInput.blur(); // dismiss the on-screen keyboard
  const frame = await grabFrame();
  send({ type: "text", text, image: frame.image, frame_id: frame.frameId });
});

// ---------- show text toggle (off by default, remembered per phone) ----------

const showTextBtn = $("#show-text");
function setShowText(on) {
  showTextBtn.setAttribute("aria-pressed", String(on));
  document.body.classList.toggle("show-text", on);
  captions.scrollTop = captions.scrollHeight;
}
try { setShowText(localStorage.getItem("showText") === "1"); } catch { setShowText(false); }
showTextBtn.addEventListener("click", () => {
  const on = showTextBtn.getAttribute("aria-pressed") !== "true";
  setShowText(on);
  try { localStorage.setItem("showText", on ? "1" : "0"); } catch {}
});

// The face died (lost off screen): it stops mid-sentence and the rest of the reply is dropped.
onDeath(() => {
  stopSpeech();
  send({ type: "interrupt" });
});

// Fear is independent from dialogue. The face can scream while idle or while either persona is
// speaking; only the microphone is closed so the phone does not feed the scream back to the server.
onScream((on) => {
  screaming = on;
  if (on) {
    releaseMic();
  } else {
    scheduleMicReopen();
  }
});

$("#reset").addEventListener("click", () => {
  stopSpeech();
  send({ type: "reset" });
});

// ---------- playback ----------

function speaking() {
  return pendingSpeech > 0;
}

// Something's playing that an open mic would muffle.
function outLoud() {
  return speaking() || screaming;
}

function enqueueSpeech(text, audioB64, speakerId = 0) {
  const gen = playGen;
  pendingSpeech++;
  releaseMic();
  // Decode now, in parallel with whatever is playing; play strictly in order.
  const decoded = audioB64
    ? audioCtx.decodeAudioData(base64ToBuffer(audioB64)).catch(() => null)
    : Promise.resolve(null);
  playChain = playChain.then(async () => {
    if (gen !== playGen) return;
    const buffer = await decoded;
    if (gen !== playGen) return;
    setSpeaking(true, buffer ? voice : null, speakerId);
    await (buffer ? playBuffer(buffer) : speakLocally(text));
  }).finally(() => {
    if (gen !== playGen) return;
    // Reply finished: reopen the mic so the next press is instant.
    if (--pendingSpeech === 0) {
      setSpeaking(false);
      scheduleMicReopen();
    }
  });
}

// A buffer source can't pause, so pausing stops it and resuming starts a new one where it got to.
function playBuffer(buffer) {
  if (audioCtx.state !== "running") audioCtx.resume();
  return new Promise((resolve) => {
    let src = null;
    let offset = 0; // seconds played before the last pause
    let startedAt = 0;
    const play = () => {
      const s = audioCtx.createBufferSource();
      s.buffer = buffer;
      s.connect(voice);
      s.onended = () => s === src && finish();
      src = s;
      startedAt = audioCtx.currentTime;
      s.start(0, offset);
    };
    const halt = () => {
      const s = src;
      src = null; // first, so its onended doesn't count as the sentence finishing
      try { s?.stop(); } catch {}
    };
    const player = {
      voice,
      pause: () => {
        if (!src) return;
        offset += audioCtx.currentTime - startedAt;
        halt();
      },
      resume: () => src || play(),
      stop: () => {
        halt();
        finish();
      },
    };
    const finish = () => {
      if (current === player) current = null;
      resolve();
    };
    current = player;
    play();
  });
}

// Fallback when the server sends no audio (mock mode or a TTS error).
function speakLocally(text) {
  if (!window.speechSynthesis) return Promise.resolve();
  return new Promise((resolve) => {
    const player = {
      voice: null,
      pause: () => speechSynthesis.pause(),
      resume: () => speechSynthesis.resume(),
      stop: () => {
        speechSynthesis.cancel();
        finish();
      },
    };
    const finish = () => {
      if (current === player) current = null;
      resolve();
    };
    const u = new SpeechSynthesisUtterance(text);
    u.onend = u.onerror = finish;
    current = player;
    speechSynthesis.speak(u);
  });
}

function stopSpeech() {
  playGen++;
  pendingSpeech = 0;
  playChain = Promise.resolve();
  setSpeaking(false);
  scheduleMicReopen();
  current?.stop();
  window.speechSynthesis?.cancel();
}

function base64ToBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
