// WebXR AR (Android Chrome + ARCore): owns the camera, grabs frames for Gemini, and pins a
// pulsating green cube on the object Gemini located in one of those frames.
// Three.js is only downloaded once an AR session actually starts.

const MAX_FRAME_SIDE = 768;
const SNAPSHOTS_KEPT = 10;
const CAPTURE_TIMEOUT_MS = 500;
const HIT_TEST_FRAMES = 10; // how long to wait for a hit before falling back to a fixed distance
const FALLBACK_DISTANCE_M = 0.6;
const CUBE_MIN_M = 0.05;
const CUBE_MAX_M = 0.4;
const PULSE_HZ = 1.5;
const FOLLOW = 0.15; // per-frame easing toward a new placement, so re-anchoring doesn't jump

let THREE = null;
let session = null;
let renderer, scene, camera, refSpace, gl, glBinding, readFramebuffer;
let cube, cubeFill;
let onEnd = null;

// Pose of the camera for each frame we sent, so a box that arrives seconds later still maps onto
// the world the way it was when the photo was taken.
const snapshots = new Map();
let frameCounter = 0;
let captureWaiters = [];

let placementGen = 0; // bumped on every new placement or clear, so stale async work is dropped
let pending = null; // hit test in progress: { source, frames, origin, dir, box, projection, gen }
let anchor = null;
let target = null; // where the cube should be (THREE.Vector3)
let targetSize = 0.1;
let size = 0.1;

export async function arSupported() {
  try {
    return Boolean(await navigator.xr?.isSessionSupported("immersive-ar"));
  } catch {
    return false;
  }
}

export function inAR() {
  return session !== null;
}

// Must be called from a user gesture. overlayRoot stays interactive on top of the camera view.
export async function startAR(overlayRoot, { onEnd: endCallback } = {}) {
  const xrSession = await navigator.xr.requestSession("immersive-ar", {
    requiredFeatures: ["hit-test", "camera-access"],
    optionalFeatures: ["anchors", "dom-overlay"],
    domOverlay: { root: overlayRoot },
  });
  try {
    THREE ??= await import("three");
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local");
    await renderer.xr.setSession(xrSession);
  } catch (err) {
    xrSession.end().catch(() => {});
    throw err;
  }
  session = xrSession;
  onEnd = endCallback;
  refSpace = renderer.xr.getReferenceSpace();
  gl = renderer.getContext();
  glBinding = new XRWebGLBinding(session, gl);
  readFramebuffer = gl.createFramebuffer();

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(); // replaced by the XR camera while presenting
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 1.5));
  scene.add(makeCube());

  // Taps on the UI shouldn't also count as taps on the AR scene.
  overlayRoot.addEventListener("beforexrselect", (e) => e.preventDefault());
  session.addEventListener("end", handleEnd);
  renderer.setAnimationLoop(onXRFrame);
}

function handleEnd() {
  renderer.setAnimationLoop(null);
  clearCube();
  captureWaiters.forEach((resolve) => resolve(null));
  captureWaiters = [];
  snapshots.clear();
  session = null;
  onEnd?.();
}

// Resolves to { image (b64 JPEG), frameId } from the next AR frame, or null.
export function captureFrame() {
  if (!session) return Promise.resolve(null);
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
export async function placeBox(box, frameId) {
  const snap = snapshots.get(frameId);
  if (!session || !snap || !box) return;
  const gen = ++placementGen;
  cancelPending();

  // Ray from the camera, as it was when the frame was taken, through the centre of the box.
  const [ymin, xmin, ymax, xmax] = box;
  const ndc = new THREE.Vector4((xmin + xmax) / 1000 - 1, 1 - (ymin + ymax) / 1000, -1, 1);
  const projection = new THREE.Matrix4().fromArray(snap.projection);
  const cameraToWorld = new THREE.Matrix4().fromArray(snap.transform);
  ndc.applyMatrix4(projection.clone().invert());
  const dir = new THREE.Vector3(ndc.x, ndc.y, ndc.z).divideScalar(ndc.w).transformDirection(cameraToWorld);
  const origin = new THREE.Vector3().setFromMatrixPosition(cameraToWorld);

  const offsetRay = new XRRay({ ...origin, w: 1 }, { ...dir, w: 0 });
  let source = null;
  try {
    source = await session.requestHitTestSource({ space: refSpace, offsetRay, entityTypes: ["point", "plane"] });
  } catch {
    try {
      source = await session.requestHitTestSource({ space: refSpace, offsetRay });
    } catch (err) {
      console.warn("hit test unavailable", err);
    }
  }
  if (gen !== placementGen || !session) return source?.cancel();
  pending = { source, frames: 0, origin, dir, box, projection, gen };
}

export function clearCube() {
  placementGen++;
  cancelPending();
  anchor?.delete();
  anchor = null;
  target = null;
  if (cube) cube.visible = false;
}

function cancelPending() {
  pending?.source?.cancel();
  pending = null;
}

// ---------- per frame ----------

function onXRFrame(time, frame) {
  if (frame) {
    const pose = frame.getViewerPose(refSpace);
    if (pose && captureWaiters.length) serveCaptures(pose.views[0]);
    if (pending) resolvePlacement(frame);
    followAnchor(frame);
  }
  animateCube(time);
  renderer.render(scene, camera);
}

function serveCaptures(view) {
  const waiters = captureWaiters;
  captureWaiters = [];
  let result = null;
  try {
    result = capture(view);
  } catch (err) {
    console.warn("camera capture failed", err);
  }
  waiters.forEach((resolve) => resolve(result));
}

function capture(view) {
  if (!view.camera) return null;
  const image = readCameraImage(view.camera);
  const frameId = `ar${++frameCounter}`;
  snapshots.set(frameId, {
    transform: Array.from(view.transform.matrix),
    projection: Array.from(view.projectionMatrix),
  });
  while (snapshots.size > SNAPSHOTS_KEPT) snapshots.delete(snapshots.keys().next().value);
  return { image, frameId };
}

// The camera image is a GPU texture only valid during this frame: read it back and JPEG it.
function readCameraImage(xrCamera) {
  const { width, height } = xrCamera;
  const texture = glBinding.getCameraImage(xrCamera);
  gl.bindFramebuffer(gl.FRAMEBUFFER, readFramebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  renderer.resetState(); // we touched GL behind three's back

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

function resolvePlacement(frame) {
  const results = pending.source ? frame.getHitTestResults(pending.source) : [];
  if (!results.length && ++pending.frames < HIT_TEST_FRAMES) return;
  const { origin, dir, box, projection, gen } = pending;
  cancelPending();

  const hitPose = results[0]?.getPose(refSpace);
  const hit = hitPose
    ? new THREE.Vector3().copy(hitPose.transform.position)
    : origin.clone().addScaledVector(dir, FALLBACK_DISTANCE_M);
  const distance = hit.distanceTo(origin);

  // Real-world size of the box at that distance; the cube matches its smaller side.
  const [ymin, xmin, ymax, xmax] = box;
  const width = ((xmax - xmin) / 500) * (distance / projection.elements[0]);
  const height = ((ymax - ymin) / 500) * (distance / projection.elements[5]);
  targetSize = THREE.MathUtils.clamp(Math.min(width, height), CUBE_MIN_M, CUBE_MAX_M);

  // The hit is on the object's front surface (or what's behind it): sit the cube's centre inside it.
  const position = hit.addScaledVector(dir, targetSize / 2);
  target = position.clone();

  // An anchor keeps the spot fixed as ARCore refines its map of the room.
  if (!frame.createAnchor) return; // "anchors" wasn't granted: the cube just stays at this position
  frame
    .createAnchor(new XRRigidTransform({ x: position.x, y: position.y, z: position.z }), refSpace)
    .then((created) => {
      if (gen !== placementGen) return created.delete();
      anchor?.delete();
      anchor = created;
    })
    .catch((err) => console.warn("anchor failed", err));
}

function followAnchor(frame) {
  if (!anchor || !target || !frame.trackedAnchors?.has(anchor)) return;
  const pose = frame.getPose(anchor.anchorSpace, refSpace);
  if (pose) target.copy(pose.transform.position);
}

// ---------- the cube ----------

function makeCube() {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  cubeFill = new THREE.MeshStandardMaterial({
    color: 0x22ff66,
    emissive: 0x22ff66,
    emissiveIntensity: 0.6,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0x7dffa8 }),
  );
  cube = new THREE.Group();
  cube.add(new THREE.Mesh(geometry, cubeFill), edges);
  cube.visible = false;
  return cube;
}

function animateCube(time) {
  if (!target) return;
  if (!cube.visible) {
    cube.position.copy(target);
    size = targetSize;
    cube.visible = true;
  } else {
    cube.position.lerp(target, FOLLOW);
    size += (targetSize - size) * FOLLOW;
  }
  const seconds = time / 1000;
  const pulse = Math.sin(seconds * 2 * Math.PI * PULSE_HZ);
  cube.scale.setScalar(size * (1 + 0.12 * pulse));
  cube.rotation.y = seconds * 0.6;
  cubeFill.emissiveIntensity = 0.6 + 0.4 * pulse;
  cubeFill.opacity = 0.35 + 0.15 * pulse;
}
