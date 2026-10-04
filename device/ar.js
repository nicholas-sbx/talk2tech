// AR on phones via the 8th Wall engine (world tracking in plain iOS Safari and Android Chrome),
// rendered with three.js. 8th Wall owns the camera: it draws the feed, tracks the phone's pose,
// and gives us the frames we send to Gemini. When Gemini says where the object is in one of those
// frames, a scribbled face (scribble.js) is stuck flat onto its surface in the tracked 3D world. It
// talks while the reply plays, panics and screams as the object nears the edge of the screen, and
// dies if it's lost off it, until Gemini next places it. While a reply is being worked out, it's a
// thought bubble instead.
//
// 8th Wall engine © Niantic Spatial, Inc., used under the XR Engine License Agreement:
// https://github.com/8thwall/engine/blob/main/LICENSE

import { EdgeFearSystem, ProceduralAudio, ScribbleFace } from "./scribble.js";

const ENGINE_URL = "https://cdn.jsdelivr.net/npm/@8thwall/engine-binary@1.0.0/dist/xr.js";
const MAX_FRAME_SIDE = 768;
const SNAPSHOTS_KEPT = 10;
const CAPTURE_TIMEOUT_MS = 1000;
// Hit tests per side of a grid over each frame we send. The engine doesn't expose its tracked points,
// so this samples where the world is; the ones that land on the object give its depth.
const HIT_GRID = 8;
const BOX_CORE = 0.6; // only trust hits in the middle of the box, not its edges
// Scene units are about metres: tracking assumes the phone starts this high above the floor.
const CAMERA_HEIGHT = 1.4;
const FALLBACK_DEPTH = 0.6;
const SMILEY_MIN = 0.02; // diameter limits, in scene units (about metres)
const SMILEY_MAX = 0.8;
// Never smaller than this share of its distance (about a quarter of the screen's width), so it
// can't shrink to a speck on a thin object.
const SMILEY_MIN_VIEW = 0.14;
// Gemini picks the smiley's diameter as a share of the object's visible width; this is used until it does.
const DEFAULT_SMILEY_SIZE = 0.5;
// Gemini's picks read small on the phone, so the face is drawn this much bigger than it asks for.
const SMILEY_GROW = 1.4;
// The face is drawn on a canvas texture: FACE_UNITS of the drawing (eyes, mouth, brows at rest)
// span one smiley diameter, and the plane is FACE_PLANE diameters across so bulging eyes, the
// scream and sweat still fit.
const FACE_UNITS = 110;
const FACE_PLANE = 2.4;
const FACE_PIXELS = 512;
// A light rim around every line (in texture pixels, stamped in this many directions) so the face
// still shows on dark objects.
const OUTLINE_PX = 5;
const OUTLINE_STEPS = 12;
const OUTLINE_COLOR = "#ffffff";
// Calm, the eyes look at the camera: how far they turn per unit of the camera's sideways offset
// over its distance, as seen from the face (1 = fully to the side at 45 degrees).
const GAZE_GAIN = 1.5;
// The mouth opens with the reply's loudness, against the loudest it's been lately (which fades by
// this much per frame), so any voice's volume uses the mouth's full range. Opening is quick and
// closing a little slower, so it reads as speech rather than flicker.
const VOICE_PEAK_FADE = 0.997;
const VOICE_PEAK_MIN = 0.02;
const VOICE_SILENT = 0.005;
const MOUTH_OPEN = 0.6;
const MOUTH_CLOSE = 0.3;
const OFFSCREEN_MARGIN = 0.05; // how far past the screen's edge (share of the screen) counts as lost
// The scream counts as over once the face has been calm this long, so hovering at the edge of the
// panic zone doesn't stutter the speech it pauses.
const SCREAM_HOLD_MS = 300;
const FOLLOW = 0.15; // per-frame easing toward a new placement, so re-locating doesn't jump
const MIN_PLANE_HITS = 4; // fewer hits than this can't give a trustworthy surface angle
const MAX_PLANE_ROUGHNESS = 0.2; // reject fits whose points stray from the plane by more than this share of their spread
// The smiley never tilts further than this from facing the camera, so a noisy fit can't turn it
// edge-on (and invisible).
const MAX_TILT = (60 * Math.PI) / 180;
// A new box this close to the current placement (in smiley diameters) refines it instead of replacing it.
const SAME_SPOT = 2;
const RELOCATE_BLEND = 0.5;
// Between boxes, the surface under the smiley is re-checked so it stays on it as tracking refines.
const REFINE_EVERY = 6; // frames
const REFINE_GRID = 4; // hit tests per side, spread over the smiley's footprint on screen
const DEPTH_GAIN = 0.3;
// Re-checks only trust hits within this share of the smiley's distance, and can never move it further
// than this share of its placed depth from where Gemini's box put it, so stray points can't walk it
// off (or into the camera).
const REFINE_WINDOW = 0.3;
const REFINE_LEASH = 0.3;
const NORMAL_GAIN = 0.15;
const DEBUG = new URLSearchParams(location.search).has("debug");
const CAMERA_FAILURES = {
  DENY_CAMERA: "Camera access was blocked.",
  NO_CAMERA: "No camera found.",
  DENY_MICROPHONE: "Microphone access was blocked.",
};

let THREE = null;
let XR8 = null;
let canvas = null;
let gl = null;
let running = false;
let smiley, faceCanvas, faceTexture;
let inkCanvas, rimCanvas; // the face's lines, and their silhouette in the outline colour
const face = new ScribbleFace();
let voice = null; // analyser on the reply as it plays, while the mouth follows it
let voiceSamples = null;
let voicePeak = VOICE_PEAK_MIN;
let audio = null;
let deathListener = null;
let screamListener = null;
let screaming = false;
let lastScream = 0;
let slapListener = null;
let lastCameraPos = null;
let lastCameraQuat = null;
let isCameraSteady = false;
let steadySince = null;
let lastHandMotion = -Infinity;
let roiBuffer = null;
let prevRoi = null;
let prevBackground = null;
let lastSlapTriggerTime = 0;
const SLAP_OPTICAL_THRESHOLD = 26.0;
const SLAP_DEBOUNCE_MS = 1200;
// Moving the camera changes the whole picture, a slap only the object: the background has to stay
// this still (average brightness change per pixel) for a change on the object to count.
const SLAP_BACKGROUND_STILL = 5.0;
// How long the camera must be held still, by both tracking and the phone's sensors, before watching.
const SLAP_SETTLE_MS = 600;
// The phone's own sensors: more spin (degrees/s) or shove (m/s², gravity removed) than a steady hand.
const SLAP_MAX_SPIN = 15;
const SLAP_MAX_SHOVE = 0.8;
const PATCH = 16;
// Spots away from the face, as fractions of the screen, to watch for the whole picture changing.
const BACKGROUND_SPOTS = [[0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85], [0.5, 0.1], [0.5, 0.9]];

window.addEventListener("devicemotion", (e) => {
  const r = e.rotationRate;
  const a = e.acceleration;
  const spin = r ? Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0) : 0;
  const shove = a ? Math.hypot(a.x || 0, a.y || 0, a.z || 0) : 0;
  if (spin > SLAP_MAX_SPIN || shove > SLAP_MAX_SHOVE) lastHandMotion = performance.now();
});

// Camera pose, projection and 3D points for each frame we sent, so a box that arrives seconds
// later still maps onto the world the way it was when the photo was taken.
const snapshots = new Map();
let frameCounter = 0;
let captureWaiters = [];
let reality = null; // this frame's tracking output

// ?debug: what the AR pipeline did, shown on screen since phones have no console.
const stats = { sent: 0, unreadable: 0, boxes: 0, lastBox: "none yet", refines: 0, lastRefine: "", opticalDiff: "", slaps: 0 };
let statsShown = 0;

// Where the smiley sits: a point on the surface, the surface normal (towards the camera), the
// direction its top should face, and its diameter.
let placement = null;
let targetPosition = null;
let targetQuaternion = null;
let size = 0.1;
let updates = 0; // frames since start, to space out surface re-checks

// World tracking needs a phone's camera and motion sensors.
export function arSupported() {
  const ua = navigator.userAgent;
  const iPad = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return window.isSecureContext && (/Android|iPhone|iPad|iPod/.test(ua) || iPad);
}

// Don't leave a scream ringing while the page is in the background.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") audio?.reset();
});

// The engine is ~6 MB, so start fetching it as soon as the page loads on a phone.
const engine = arSupported() ? loadEngine() : null;
engine?.catch((err) => console.warn(err));

function loadEngine() {
  return new Promise((resolve, reject) => {
    if (window.XR8) return resolve(window.XR8);
    window.addEventListener("xrloaded", () => resolve(window.XR8), { once: true });
    const script = document.createElement("script");
    script.src = ENGINE_URL;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => reject(new Error("Couldn't load the AR engine."));
    document.head.append(script);
  });
}

// iOS only grants motion sensors from inside a tap, so call this first thing in one.
export function requestMotionPermission() {
  const ask = (cls) => (cls?.requestPermission ? cls.requestPermission().catch(() => "denied") : "granted");
  return Promise.all([ask(window.DeviceMotionEvent), ask(window.DeviceOrientationEvent)]);
}

export function inAR() {
  return running;
}

// Resolves once the camera feed is up and tracking has started. Screams play through audioContext.
export async function startAR(audioContext) {
  audio = new ProceduralAudio(audioContext);
  if (!engine) throw new Error("AR needs a phone.");
  XR8 = await engine;
  await XR8.loadChunk("slam");
  if (!XR8.XrDevice.isDeviceBrowserCompatible({ allowedDevices: XR8.XrConfig.device().MOBILE })) {
    throw new Error("This browser can't do AR. Try Safari or Chrome.");
  }
  THREE ??= await import("three");
  window.THREE = THREE; // 8th Wall's three.js module looks for it here

  canvas = document.createElement("canvas");
  canvas.id = "ar-canvas";
  // Must be in the page before the camera starts: the engine puts its video element next to it.
  document.body.append(canvas);
  XR8.XrController.configure({ disableWorldTracking: false });

  await new Promise((resolve, reject) => {
    XR8.addCameraPipelineModules([
      fullWindowModule(),
      XR8.XrController.pipelineModule(),
      XR8.GlTextureRenderer.pipelineModule(), // draws the camera feed
      captureModule(), // runs after the feed is drawn but before the smiley is, so frames are clean
      XR8.Threejs.pipelineModule(),
      sceneModule(),
      {
        name: "talk2tech-start",
        onStart: () => {
          running = true;
          resolve();
        },
        // "failed" covers any error while starting the camera, not just a denied permission.
        onCameraStatusChange: ({ status, reason }) => {
          if (status === "failed") reject(new Error(CAMERA_FAILURES[reason] || `The AR camera didn't start (${reason}).`));
        },
        onException: (err) => (running ? console.warn("[AR]", err) : reject(err)),
      },
    ]);
    // Current three.js is WebGL 2 only. ?debug turns on the engine's own logging.
    XR8.run({ canvas, webgl2: true, verbose: DEBUG });
  }).catch((err) => {
    XR8.stop();
    XR8.clearCameraPipelineModules();
    canvas.remove();
    throw err;
  });
}

// Resolves to { image (b64 JPEG), frameId } from the next AR frame, or null.
export function captureFrame() {
  if (!running) return Promise.resolve(null);
  return new Promise((resolve) => {
    captureWaiters.push(resolve);
    setTimeout(() => {
      const i = captureWaiters.indexOf(resolve);
      if (i >= 0) captureWaiters.splice(i, 1);
      resolve(null);
    }, CAPTURE_TIMEOUT_MS);
  });
}

// box: Gemini box_2d [ymin, xmin, ymax, xmax] (0-1000) for the frame captureFrame() named frameId.
// fit: the smiley's diameter as a share of the object's visible width, as Gemini chose it.
export function placeBox(box, frameId, fit = DEFAULT_SMILEY_SIZE) {
  stats.boxes++;
  if (!running || !box) return;
  // No saved pose (the frame wasn't captured in AR): use the camera as it is now. Close enough
  // unless the phone moved a lot since.
  const snap = snapshots.get(frameId) ?? snapshot();
  if (!snapshots.has(frameId)) frameId = `${frameId} (no saved pose, used current camera)`;
  const [ymin, xmin, ymax, xmax] = box;

  // Hits that land in the middle of the box, as seen from the camera when the frame was taken.
  const cy = (ymin + ymax) / 2;
  const cx = (xmin + xmax) / 2;
  const halfH = ((ymax - ymin) / 2) * BOX_CORE;
  const halfW = ((xmax - xmin) / 2) * BOX_CORE;
  const inBox = (hit) => {
    const at = project(hit.point, snap);
    return at && Math.abs(at.y - cy) <= halfH && Math.abs(at.x - cx) <= halfW ? { ...hit, depth: at.depth } : null;
  };
  const features = snap.points.map(inBox).filter(Boolean);
  const surfaces = snap.surfaces.map(inBox).filter(Boolean);

  // Ray from the camera through the centre of the box.
  const ndc = new THREE.Vector3(cx / 500 - 1, 1 - cy / 500, -1).applyMatrix4(snap.projectionInverse);
  const dirCamera = ndc.normalize();
  const origin = new THREE.Vector3().setFromMatrixPosition(snap.cameraToWorld);
  const dir = dirCamera.clone().transformDirection(snap.cameraToWorld);

  // How far away the object is (feature points on it, else the surfaces under it), and which way
  // its surface faces (a plane through those points, else the surface's own normal, else facing
  // the camera).
  const used = features.length ? features : surfaces;
  const depth = median(used.map((h) => h.depth)) ?? FALLBACK_DEPTH;
  const plane = fitPlane(features.map((h) => h.point));
  let normal;
  let source;
  if (plane) {
    normal = plane.normal;
    source = `${features.length} feature hits, fitted plane`;
  } else if (surfaces.length && !features.length) {
    normal = surfaces.reduce((sum, h) => sum.add(h.normal), new THREE.Vector3()).normalize();
    source = `${surfaces.length} surface hits`;
  } else {
    normal = dir.clone().negate();
    source = used.length ? `${used.length} feature hits, facing camera` : "no hits in box, fixed depth";
  }
  const point = origin.clone().addScaledVector(dir, depth / -dirCamera.z);
  limitTilt(normal, origin.clone().sub(point));

  // Real-world size of the box at that depth; the smiley is Gemini's chosen share of its smaller side.
  const p = snap.projection.elements;
  const width = ((xmax - xmin) / 500) * (depth / p[0]);
  const height = ((ymax - ymin) / 500) * (depth / p[5]);
  const side = THREE.MathUtils.clamp(
    Math.max(Math.min(width, height) * fit * SMILEY_GROW, depth * SMILEY_MIN_VIEW),
    SMILEY_MIN,
    SMILEY_MAX,
  );
  // The camera's up direction when the frame was taken, so the face reads upright to the viewer.
  const up = new THREE.Vector3(0, 1, 0).transformDirection(snap.cameraToWorld);

  // Same object again (a later turn): nudge the smiley rather than jumping to a noisier estimate.
  if (placement && placement.point.distanceTo(point) < SAME_SPOT * Math.max(side, placement.size)) {
    placement.point.lerp(point, RELOCATE_BLEND);
    placement.home.lerp(point, RELOCATE_BLEND);
    placement.leash += (depth * REFINE_LEASH - placement.leash) * RELOCATE_BLEND;
    limitTilt(placement.normal.lerp(normal, RELOCATE_BLEND).normalize(), origin.clone().sub(placement.point));
    placement.size += (side - placement.size) * RELOCATE_BLEND;
    source += ", blended";
  } else {
    // home and leash: where the box put it, and how far re-checks may move it from there.
    placement = { point, normal, up, size: side, home: point.clone(), leash: depth * REFINE_LEASH };
  }
  revive();
  aimMarker();

  const fmt = (v) => v.toArray().map((n) => n.toFixed(2)).join(", ");
  stats.lastBox = `${frameId}: depth ${depth.toFixed(2)} (${source}), diameter ${side.toFixed(2)} (${Math.round(fit * 100)}% of object), normal ${fmt(placement.normal)}`;
}

export function clearMarker() {
  placement = null;
  targetPosition = null;
  if (smiley) smiley.visible = false;
  face.setThinking(false, performance.now(), true);
  revive();
}

// While the object works out a reply, its face turns into a thought bubble, and back when it
// answers. Lost in thought, it doesn't notice the edges of the screen: it can't scream or die, so
// it's still thinking when you find it again.
export function setThinking(on) {
  face.setThinking(on, performance.now());
  if (!on) return;
  face.panic = 0;
  audio?.updatePanic(0);
  setScreaming(false);
}

// Where the face is on screen, in CSS pixels, and its radius there; null if there's no face or
// it's behind the camera.
export function faceOnScreen() {
  if (!running || !targetPosition) return null;
  const { camera } = XR8.Threejs.xrScene();
  camera.updateMatrixWorld();
  const centre = smiley.visible ? smiley.position : targetPosition;
  if (centre.clone().applyMatrix4(camera.matrixWorldInverse).z >= 0) return null;
  const side = new THREE.Vector3(1, 0, 0).transformDirection(camera.matrixWorld);
  const edge = centre.clone().addScaledVector(side, (smiley.visible ? size : placement.size) / 2);
  const [c, e] = [centre.clone(), edge].map((v) => {
    v.project(camera);
    return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
  });
  return { x: c.x, y: c.y, r: Math.hypot(e.x - c.x, e.y - c.y) };
}

// Calls back when the face dies, so whatever it was saying can be cut off.
export function onDeath(callback) {
  deathListener = callback;
}

// Calls back with true when the face starts screaming and false when it stops, so speech can
// pause for it.
export function onScream(callback) {
  screamListener = callback;
}

// Calls back when a physical slap / object movement is detected by the camera.
export function onSlap(callback) {
  slapListener = callback;
}

// Triggers visual and procedural audio slap reaction.
export function triggerSlap(angerLevel = 1) {
  audio?.playSlapSound();
  face.triggerSlap(angerLevel);
}

// Plays cartoon vocal "Ow!" exclamation.
export function playOwSound() {
  audio?.playOwSound();
}

function setScreaming(on) {
  if (on === screaming) return;
  screaming = on;
  screamListener?.(on);
}

// Moves the face's mouth while a reply plays. Given the analyser the reply plays through, the mouth
// opens as wide as it's loud; without one (e.g. the browser's own speech) it just flaps.
export function setSpeaking(on, analyser = null) {
  face.speaking = Boolean(on);
  voice = on ? analyser : null;
  face.mouthLevel = voice ? 0 : null;
}

// Back from the dead (or calm again): a fresh placement starts unafraid.
function revive() {
  face.isDead = false;
  face.panic = 0;
  audio?.reset();
  setScreaming(false);
}

// Turns the placement into the smiley's pose: its back flat on the surface, its face along the
// normal, and its top towards `up` (the camera's up when it was placed) as far as the surface allows.
function aimMarker() {
  const { point, normal, up } = placement;
  let top = up.clone().addScaledVector(normal, -up.dot(normal));
  if (top.lengthSq() < 1e-6) top = new THREE.Vector3(0, 0, -1).addScaledVector(normal, normal.z);
  top.normalize();
  const side = top.clone().cross(normal);
  targetQuaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, top, normal));
  targetPosition = point.clone();
}

// Re-checks the surface under the smiley with a few hit tests around where it appears on screen,
// and eases the smiley's depth and angle onto it. Only depth along the line of sight is corrected:
// sideways position comes from Gemini's boxes.
function refineOnSurface(camera) {
  if (!placement || reality?.trackingStatus !== "NORMAL") return;
  camera.updateMatrixWorld();
  const centre = placement.point.clone().project(camera);
  if (centre.z > 1 || Math.abs(centre.x) > 0.9 || Math.abs(centre.y) > 0.9) return; // off screen

  const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const toPoint = placement.point.clone().sub(eye);
  const distance = toPoint.length();
  const sight = toPoint.normalize();

  // The smiley's half-width on screen, in hit-test units (0-1 across the canvas).
  const side = new THREE.Vector3(1, 0, 0).transformDirection(camera.matrixWorld);
  const edge = placement.point.clone().addScaledVector(side, placement.size / 2).project(camera);
  const rx = THREE.MathUtils.clamp(Math.abs(edge.x - centre.x) / 2, 0.01, 0.2);
  const ry = rx * (canvas.width / canvas.height);
  const sx = (centre.x + 1) / 2;
  const sy = (1 - centre.y) / 2;

  // Keep hits near the line of sight to the smiley and near its current depth.
  const reach = placement.size + 0.02;
  const hits = [];
  for (let gy = 0; gy < REFINE_GRID; gy++) {
    for (let gx = 0; gx < REFINE_GRID; gx++) {
      const x = sx + (((gx + 0.5) / REFINE_GRID) * 2 - 1) * rx;
      const y = sy + (((gy + 0.5) / REFINE_GRID) * 2 - 1) * ry;
      for (const hit of XR8.XrController.hitTest(x, y, ["FEATURE_POINT"])) {
        const at = new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z);
        const along = at.clone().sub(eye).dot(sight);
        const off = at.clone().sub(eye).addScaledVector(sight, -along).length();
        if (off < reach && Math.abs(along - distance) < distance * REFINE_WINDOW) hits.push({ at, along });
      }
    }
  }
  if (!hits.length) return;

  const along = median(hits.map((h) => h.along));
  const moved = eye.clone().addScaledVector(sight, distance + (along - distance) * DEPTH_GAIN);
  const offset = moved.clone().sub(placement.home);
  if (offset.length() > placement.leash) moved.copy(placement.home).addScaledVector(offset.normalize(), placement.leash);
  placement.point = moved;
  const plane = fitPlane(hits.map((h) => h.at));
  if (plane) {
    const towardEye = sight.clone().negate();
    limitTilt(plane.normal, towardEye);
    limitTilt(placement.normal.lerp(plane.normal, NORMAL_GAIN).normalize(), towardEye);
  }
  stats.refines++;
  stats.lastRefine = `${hits.length} hits${plane ? ", plane" : ""}`;
  aimMarker();
}

// Points `normal` (in place) toward `toward`'s side, tilted at most MAX_TILT away from it.
function limitTilt(normal, toward) {
  const facing = toward.clone().normalize();
  if (normal.dot(facing) < 0) normal.negate();
  const angle = normal.angleTo(facing);
  if (angle <= MAX_TILT) return normal;
  const axis = facing.clone().cross(normal);
  if (axis.lengthSq() < 1e-9) return normal.copy(facing);
  return normal.copy(facing.applyAxisAngle(axis.normalize(), MAX_TILT));
}

// Least-squares plane through some points: their centroid and the unit normal, or null if there
// are too few, they're all in a line, or they're too scattered to be one surface.
function fitPlane(points) {
  if (points.length < MIN_PLANE_HITS) return null;
  const c = points.reduce((sum, v) => sum.add(v), new THREE.Vector3()).divideScalar(points.length);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const v of points) {
    const x = v.x - c.x, y = v.y - c.y, z = v.z - c.z;
    xx += x * x; xy += x * y; xz += x * z;
    yy += y * y; yz += y * z; zz += z * z;
  }
  // Solve with the axis that's least parallel to the plane, for the best-conditioned answer.
  const detX = yy * zz - yz * yz;
  const detY = xx * zz - xz * xz;
  const detZ = xx * yy - xy * xy;
  const best = Math.max(detX, detY, detZ);
  if (best <= 1e-12) return null;
  const normal =
    best === detX ? new THREE.Vector3(detX, xz * yz - xy * zz, xy * yz - xz * yy)
    : best === detY ? new THREE.Vector3(xz * yz - xy * zz, detY, xy * xz - yz * xx)
    : new THREE.Vector3(xy * yz - xz * yy, xy * xz - yz * xx, detZ);
  normal.normalize();
  // How far the points stray from the plane, against how spread out they are along it.
  let off = 0;
  let spread = 0;
  for (const v of points) {
    const r = v.clone().sub(c);
    const d = r.dot(normal);
    off += d * d;
    spread += r.lengthSq() - d * d;
  }
  if (Math.sqrt(off) > MAX_PLANE_ROUGHNESS * Math.sqrt(spread)) return null;
  return { centroid: c, normal };
}

// A world point as seen from a snapshot's camera: box coordinates (0-1000) and depth, or null if
// it's behind the camera.
function project(point, snap) {
  const v = point.clone().applyMatrix4(snap.worldToCamera);
  if (v.z >= 0) return null;
  const depth = -v.z;
  v.applyMatrix4(snap.projection);
  return { x: (v.x + 1) * 500, y: (1 - v.y) * 500, depth };
}

function median(values) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

// ---------- pipeline modules ----------

function captureModule() {
  return {
    name: "talk2tech-capture",
    onStart: ({ GLctx }) => {
      gl = GLctx;
    },
    onUpdate: ({ processCpuResult }) => {
      reality = processCpuResult.reality || null;
      if (DEBUG) showStats();
    },
    onRender: () => {
      if (!captureWaiters.length || !reality?.intrinsics) return;
      const image = readCanvas();
      if (!image) {
        stats.unreadable++; // try again next frame
        return;
      }
      stats.sent++;
      const frameId = `ar${++frameCounter}`;
      snapshots.set(frameId, snapshot());
      while (snapshots.size > SNAPSHOTS_KEPT) snapshots.delete(snapshots.keys().next().value);
      const waiters = captureWaiters;
      captureWaiters = [];
      waiters.forEach((resolve) => resolve({ image, frameId }));
    },
  };
}

// The camera feed as drawn this frame, as a JPEG. Same crop as the screen, which is also the space
// the tracking's projection and hit tests use. Read straight from GL: drawImage() of a WebGL canvas
// is unreliable on iOS.
function readCanvas() {
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  const pixels = new Uint8Array(width * height * 4);
  const bound = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(gl.FRAMEBUFFER, bound);
  // Nothing drawn yet if it's all black. (Not alpha: iOS can read the feed back with zero alpha.)
  let lit = false;
  for (let i = 0; i < pixels.length && !lit; i += 4 * 101) lit = pixels[i] + pixels[i + 1] + pixels[i + 2] > 0;
  if (!lit) return null;
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255; // or the JPEG comes out black

  // readPixels is bottom-up; images are top-down.
  const full = document.createElement("canvas");
  full.width = width;
  full.height = height;
  const ctx = full.getContext("2d");
  const imageData = ctx.createImageData(width, height);
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    imageData.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  }
  ctx.putImageData(imageData, 0, 0);

  const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(width, height));
  const out = document.createElement("canvas");
  out.width = Math.round(width * scale);
  out.height = Math.round(height * scale);
  out.getContext("2d").drawImage(full, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.7).split(",")[1];
}

function showStats() {
  const now = performance.now();
  if (now - statsShown < 500) return;
  statsShown = now;
  const el = document.getElementById("ar-debug");
  if (!el) return;
  const tracking = reality ? `${reality.trackingStatus} ${reality.trackingReason}` : "no tracking yet";
  let markerState = "not placed";
  if (placement && smiley) {
    const { camera } = XR8.Threejs.xrScene();
    const at = smiley.position.clone().project(camera);
    const onScreen = at.z < 1 && Math.abs(at.x) <= 1 && Math.abs(at.y) <= 1;
    const where = `screen ${Math.round((at.x + 1) * 50)}%, ${Math.round((1 - at.y) * 50)}%${onScreen ? "" : " (off screen)"}`;
    const mood = face.isDead ? "dead" : `panic ${face.panic.toFixed(2)}`;
    markerState = `${where}, ${mood}, ${stats.refines} surface re-checks (last: ${stats.lastRefine || "none"})`;
  }
  const motionState = `camera: ${isCameraSteady ? "steady" : "moving"}, diff: ${stats.opticalDiff || "0"}, slaps: ${stats.slaps || 0}`;
  el.textContent = [
    `tracking: ${tracking} (${motionState})`,
    `frames sent: ${stats.sent}, unreadable: ${stats.unreadable}, boxes: ${stats.boxes}`,
    `last box: ${stats.lastBox}`,
    `smiley: ${markerState}`,
  ].join("\n");
  el.hidden = false;
}

// Called in onRender, after the three.js module has moved its camera to this frame's pose, so
// placement uses exactly the camera the smiley is drawn with.
function snapshot() {
  const { camera } = XR8.Threejs.xrScene();
  camera.updateMatrixWorld();
  const cameraToWorld = camera.matrixWorld.clone();
  const projection = camera.projectionMatrix.clone();
  const points = [];
  const surfaces = [];
  for (let gy = 0; gy < HIT_GRID; gy++) {
    for (let gx = 0; gx < HIT_GRID; gx++) {
      const hits = XR8.XrController.hitTest((gx + 0.5) / HIT_GRID, (gy + 0.5) / HIT_GRID, [
        "FEATURE_POINT",
        "ESTIMATED_SURFACE",
        "DETECTED_SURFACE",
      ]);
      for (const hit of hits) {
        const point = new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z);
        if (hit.type === "FEATURE_POINT") {
          points.push({ point });
        } else {
          const { x, y, z, w } = hit.rotation;
          const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(x, y, z, w));
          surfaces.push({ point, normal });
        }
      }
    }
  }
  return {
    cameraToWorld,
    worldToCamera: cameraToWorld.clone().invert(),
    projection,
    projectionInverse: projection.clone().invert(),
    points,
    surfaces,
  };
}

// Keeps the canvas covering the window (the engine's own FullWindowCanvas is deprecated).
function fullWindowModule() {
  const fill = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  return {
    name: "talk2tech-fullwindow",
    onAttach: fill,
    // Wait a frame: the new window size lands after the orientation event.
    onDeviceOrientationChange: () => requestAnimationFrame(fill),
  };
}

function sceneModule() {
  return {
    name: "talk2tech-scene",
    onStart: () => {
      const { scene, camera } = XR8.Threejs.xrScene();
      scene.add(makeSmiley());
      camera.position.set(0, CAMERA_HEIGHT, 0);
      XR8.XrController.updateCameraProjectionMatrix({ origin: camera.position, facing: camera.quaternion });
    },
    onUpdate: () => {
      const { camera } = XR8.Threejs.xrScene();
      checkCameraStability(camera);
      if (++updates % REFINE_EVERY === 0) refineOnSurface(camera);
      animateMarker(performance.now(), camera);
      detectObjectPhysicalMotion(camera);
    },
  };
}

function checkCameraStability(camera) {
  if (!THREE || !camera) return;
  camera.updateMatrixWorld();
  const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const camQuat = new THREE.Quaternion().setFromRotationMatrix(camera.matrixWorld);
  if (!lastCameraPos) {
    lastCameraPos = camPos.clone();
    lastCameraQuat = camQuat.clone();
    return;
  }
  const linearVel = camPos.distanceTo(lastCameraPos);
  const dot = Math.min(1, Math.max(-1, camQuat.dot(lastCameraQuat)));
  const angularVel = 2 * Math.acos(Math.abs(dot));
  const now = performance.now();
  const still = linearVel < 0.008 && angularVel < 0.015 && now - lastHandMotion > SLAP_SETTLE_MS;
  if (!still) steadySince = null;
  else steadySince ??= now;
  isCameraSteady = steadySince !== null && now - steadySince > SLAP_SETTLE_MS;
  lastCameraPos.copy(camPos);
  lastCameraQuat.copy(camQuat);
}

function detectObjectPhysicalMotion(camera) {
  if (!running || !gl || !placement || !smiley || !smiley.visible || !isCameraSteady) {
    prevRoi = null;
    prevBackground = null;
    return;
  }
  camera.updateMatrixWorld();
  const at = smiley.position.clone().project(camera);
  if (at.z >= 1 || Math.abs(at.x) > 0.95 || Math.abs(at.y) > 0.95) {
    prevRoi = null;
    prevBackground = null;
    return;
  }
  const u = (at.x + 1) / 2;
  const v = (1 - at.y) / 2;

  const bound = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!roiBuffer) roiBuffer = new Uint8Array(PATCH * PATCH * 4);
  readPatch(u, v, roiBuffer);
  // Only spots well clear of the face, so the object itself moving doesn't count as background.
  const background = BACKGROUND_SPOTS.map(([bu, bv]) =>
    Math.hypot(bu - u, bv - v) < 0.3 ? null : readPatch(bu, bv, new Uint8Array(PATCH * PATCH * 4)),
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, bound);

  if (prevRoi && prevBackground) {
    const avgDiff = patchDiff(roiBuffer, prevRoi);
    let backgroundDiff = 0;
    let spotsSeen = 0;
    background.forEach((patch, i) => {
      if (!patch || !prevBackground[i]) return;
      backgroundDiff = Math.max(backgroundDiff, patchDiff(patch, prevBackground[i]));
      spotsSeen++;
    });
    stats.opticalDiff = `${avgDiff.toFixed(1)} (background ${backgroundDiff.toFixed(1)})`;

    const now = performance.now();
    const objectMoved = avgDiff > SLAP_OPTICAL_THRESHOLD;
    const pictureStill = spotsSeen >= 2 && backgroundDiff < SLAP_BACKGROUND_STILL;
    if (objectMoved && pictureStill && now - lastSlapTriggerTime > SLAP_DEBOUNCE_MS) {
      lastSlapTriggerTime = now;
      stats.slaps = (stats.slaps || 0) + 1;
      slapListener?.();
    }
  }
  if (!prevRoi) prevRoi = new Uint8Array(PATCH * PATCH * 4);
  prevRoi.set(roiBuffer);
  prevBackground = background;
}

// Reads the PATCH x PATCH square of the screen centred on (u, v), as fractions from the top left.
function readPatch(u, v, out) {
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  const x = Math.max(0, Math.min(width - PATCH, Math.floor(u * width) - PATCH / 2));
  const y = Math.max(0, Math.min(height - PATCH, Math.floor((1 - v) * height) - PATCH / 2));
  gl.readPixels(x, y, PATCH, PATCH, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out;
}

// Average change in brightness per pixel between two patches.
function patchDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs((a[i] + a[i + 1] + a[i + 2]) / 3 - (b[i] + b[i + 1] + b[i + 2]) / 3);
  }
  return sum / (PATCH * PATCH);
}

// ---------- the smiley ----------

// A unit-diameter face: a transparent square, FACE_PLANE diameters across, facing +Z at z = 0 with
// the scribble face drawn on it, so it can be stuck flat onto a surface.
function makeSmiley() {
  [faceCanvas, inkCanvas, rimCanvas] = [0, 0, 0].map(() => {
    const c = document.createElement("canvas");
    c.width = c.height = FACE_PIXELS;
    return c;
  });
  faceTexture = new THREE.CanvasTexture(faceCanvas);
  faceTexture.colorSpace = THREE.SRGBColorSpace;
  // Drawn last and over everything (there's no real-world occlusion anyway), so nothing in the GL
  // state left by the camera feed can hide it.
  const material = new THREE.MeshBasicMaterial({
    map: faceTexture,
    transparent: true,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(FACE_PLANE, FACE_PLANE), material);
  mesh.renderOrder = 10;
  mesh.frustumCulled = false;
  smiley = new THREE.Group();
  smiley.add(mesh);
  smiley.visible = false;
  return smiley;
}

function animateMarker(time, camera) {
  if (!targetPosition) return;
  if (!smiley.visible) {
    smiley.position.copy(targetPosition);
    smiley.quaternion.copy(targetQuaternion);
    size = placement.size;
    smiley.visible = true;
    face.appear(time);
  } else {
    smiley.position.lerp(targetPosition, FOLLOW);
    smiley.quaternion.slerp(targetQuaternion, FOLLOW);
    size += (placement.size - size) * FOLLOW;
  }
  smiley.scale.setScalar(size);
  feelTheEdges(camera, time);
  if (voice) listen();
  drawFace(time);
}

// The face, with its silhouette stamped in a ring behind it as an outline.
function drawFace(time) {
  const ink = inkCanvas.getContext("2d");
  ink.clearRect(0, 0, FACE_PIXELS, FACE_PIXELS);
  face.draw(ink, FACE_PIXELS / 2, FACE_PIXELS / 2, FACE_PIXELS / (FACE_UNITS * FACE_PLANE), time);

  const rim = rimCanvas.getContext("2d");
  rim.clearRect(0, 0, FACE_PIXELS, FACE_PIXELS);
  rim.drawImage(inkCanvas, 0, 0);
  rim.globalCompositeOperation = "source-in";
  rim.fillStyle = OUTLINE_COLOR;
  rim.fillRect(0, 0, FACE_PIXELS, FACE_PIXELS);
  rim.globalCompositeOperation = "source-over";

  const ctx = faceCanvas.getContext("2d");
  ctx.clearRect(0, 0, FACE_PIXELS, FACE_PIXELS);
  for (let i = 0; i < OUTLINE_STEPS; i++) {
    const angle = (i / OUTLINE_STEPS) * Math.PI * 2;
    ctx.drawImage(rimCanvas, Math.cos(angle) * OUTLINE_PX, Math.sin(angle) * OUTLINE_PX);
  }
  ctx.drawImage(inkCanvas, 0, 0);
  faceTexture.needsUpdate = true;
}

// Sets how far the mouth is open from how loud the reply is right now.
function listen() {
  if (voiceSamples?.length !== voice.fftSize) voiceSamples = new Float32Array(voice.fftSize);
  voice.getFloatTimeDomainData(voiceSamples);
  let sum = 0;
  for (const s of voiceSamples) sum += s * s;
  const loudness = Math.sqrt(sum / voiceSamples.length);
  voicePeak = Math.max(loudness, voicePeak * VOICE_PEAK_FADE, VOICE_PEAK_MIN);
  const target = loudness < VOICE_SILENT ? 0 : Math.min(1, loudness / voicePeak);
  const level = face.mouthLevel ?? 0;
  face.mouthLevel = level + (target - level) * (target > level ? MOUTH_OPEN : MOUTH_CLOSE);
}

// Which way the eyes turn to look at the camera, from the face's point of view: x right, y down,
// at most 1 in any direction.
function gazeAtCamera(camera) {
  smiley.updateMatrixWorld();
  const you = smiley.worldToLocal(new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld));
  if (you.z <= 0) return { x: 0, y: 0 }; // seen from behind
  const x = (you.x / you.z) * GAZE_GAIN;
  const y = (-you.y / you.z) * GAZE_GAIN;
  const length = Math.max(1, Math.hypot(x, y));
  return { x: x / length, y: y / length };
}

// Where the face is on screen: calm, it looks at you; near an edge it panics, looks at that edge
// and screams; past it (or behind the camera) it dies.
function feelTheEdges(camera, time) {
  if (face.isDead || face.thinking) return;
  camera.updateMatrixWorld();
  const behind = smiley.position.clone().applyMatrix4(camera.matrixWorldInverse).z >= 0;
  const at = smiley.position.clone().project(camera);
  const u = (at.x + 1) / 2;
  const v = (1 - at.y) / 2;
  if (EdgeFearSystem.isOffscreen(u, v, OFFSCREEN_MARGIN, behind)) {
    face.isDead = true;
    audio?.triggerDeathSequence();
    deathListener?.();
    setScreaming(false);
    return;
  }
  face.panic = EdgeFearSystem.computePanic(EdgeFearSystem.computeEdgeDistances(u, v).d);
  const edges = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };
  const edge = edges[EdgeFearSystem.getNearestEdge(u, v)];
  const you = gazeAtCamera(camera);
  face.gazeDirection = {
    x: you.x + (edge.x - you.x) * face.panic,
    y: you.y + (edge.y - you.y) * face.panic,
  };
  audio?.updatePanic(face.panic);
  if (face.panic > 0) {
    lastScream = time;
    setScreaming(true);
  } else if (time - lastScream > SCREAM_HOLD_MS) {
    setScreaming(false);
  }
}
