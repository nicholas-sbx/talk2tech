// AR on phones via the 8th Wall engine (world tracking in plain iOS Safari and Android Chrome),
// rendered with three.js. 8th Wall owns the camera: it draws the feed, tracks the phone's pose,
// and gives us the frames we send to Gemini. When Gemini says where the object is in one of those
// frames, a pulsating green cube is placed on it in the tracked 3D world.
//
// 8th Wall engine © Niantic Spatial, Inc., used under the XR Engine License Agreement:
// https://github.com/8thwall/engine/blob/main/LICENSE

const ENGINE_URL = "https://cdn.jsdelivr.net/npm/@8thwall/engine-binary@1.0.0/dist/xr.js";
const MAX_FRAME_SIDE = 768;
const SNAPSHOTS_KEPT = 10;
const CAPTURE_TIMEOUT_MS = 1000;
const SURFACE_GRID = 5; // surface hit tests per side, a fallback when no tracked points hit the object
const BOX_CORE = 0.6; // only trust tracked points in the middle of the box, not its edges
// Scene units are about metres: tracking assumes the phone starts this high above the floor.
const CAMERA_HEIGHT = 1.4;
const FALLBACK_DEPTH = 0.6;
const CUBE_MIN = 0.03;
const CUBE_MAX = 0.6;
const PULSE_HZ = 1.5;
const FOLLOW = 0.15; // per-frame easing toward a new placement, so re-locating doesn't jump

let THREE = null;
let XR8 = null;
let canvas = null;
let running = false;
let cube, cubeFill;

// Camera pose, projection and 3D points for each frame we sent, so a box that arrives seconds
// later still maps onto the world the way it was when the photo was taken.
const snapshots = new Map();
let frameCounter = 0;
let captureWaiters = [];
let reality = null; // this frame's tracking output

let target = null; // where the cube should be (THREE.Vector3)
let targetSize = 0.1;
let size = 0.1;

// World tracking needs a phone's camera and motion sensors.
export function arSupported() {
  const ua = navigator.userAgent;
  const iPad = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return window.isSecureContext && (/Android|iPhone|iPad|iPod/.test(ua) || iPad);
}

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

// Resolves once the camera feed is up and tracking has started.
export async function startAR() {
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
  XR8.XrController.configure({ disableWorldTracking: false });

  await new Promise((resolve, reject) => {
    XR8.addCameraPipelineModules([
      XR8.FullWindowCanvas.pipelineModule(),
      XR8.XrController.pipelineModule(),
      XR8.GlTextureRenderer.pipelineModule(), // draws the camera feed
      captureModule(), // runs after the feed is drawn but before the cube is, so frames are clean
      XR8.Threejs.pipelineModule(),
      sceneModule(),
      {
        name: "talk2tech-start",
        onStart: () => {
          running = true;
          resolve();
        },
        onCameraStatusChange: ({ status }) => {
          if (status === "failed") reject(new Error("Camera access was blocked."));
        },
        onException: (err) => (running ? console.warn("[AR]", err) : reject(err)),
      },
    ]);
    XR8.run({ canvas, webgl2: true }); // current three.js is WebGL 2 only
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
export function placeBox(box, frameId) {
  const snap = snapshots.get(frameId);
  if (!running || !snap || !box) return;
  const [ymin, xmin, ymax, xmax] = box;

  // How far away the object is: tracked points that land inside the box, as seen from the camera
  // when the frame was taken; failing that, the estimated surfaces under the box.
  const cy = (ymin + ymax) / 2;
  const cx = (xmin + xmax) / 2;
  const halfH = ((ymax - ymin) / 2) * BOX_CORE;
  const halfW = ((xmax - xmin) / 2) * BOX_CORE;
  const inBox = (p) => Math.abs(p.y - cy) <= halfH && Math.abs(p.x - cx) <= halfW;
  const depthIn = (points) => median(points.map((p) => project(p, snap)).filter((p) => p && inBox(p)).map((p) => p.depth));
  const depth = depthIn(snap.points) ?? depthIn(snap.surfaces) ?? FALLBACK_DEPTH;

  // Ray from the camera through the centre of the box, out to that depth.
  const ndc = new THREE.Vector3(cx / 500 - 1, 1 - cy / 500, -1).applyMatrix4(snap.projectionInverse);
  const dirCamera = ndc.normalize();
  const along = depth / -dirCamera.z;
  const origin = new THREE.Vector3().setFromMatrixPosition(snap.cameraToWorld);
  const dir = dirCamera.clone().transformDirection(snap.cameraToWorld);

  // Real-world size of the box at that depth; the cube matches its smaller side.
  const p = snap.projection.elements;
  const width = ((xmax - xmin) / 500) * (depth / p[0]);
  const height = ((ymax - ymin) / 500) * (depth / p[5]);
  targetSize = THREE.MathUtils.clamp(Math.min(width, height), CUBE_MIN, CUBE_MAX);

  // The points are on the object's front surface: sit the cube's centre inside it.
  target = origin.addScaledVector(dir, along + targetSize / 2);
}

export function clearCube() {
  target = null;
  if (cube) cube.visible = false;
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
    onUpdate: ({ processCpuResult }) => {
      reality = processCpuResult.reality || null;
    },
    onRender: () => {
      if (!captureWaiters.length || !reality?.intrinsics) return;
      const image = readCanvas();
      if (!image) return; // iOS sometimes can't read the canvas this frame; try the next one
      const frameId = `ar${++frameCounter}`;
      snapshots.set(frameId, snapshot(reality));
      while (snapshots.size > SNAPSHOTS_KEPT) snapshots.delete(snapshots.keys().next().value);
      const waiters = captureWaiters;
      captureWaiters = [];
      waiters.forEach((resolve) => resolve({ image, frameId }));
    },
  };
}

// The camera feed as drawn this frame, as a JPEG. Same crop as the screen, which is also the space
// the tracking's projection and hit tests use.
function readCanvas() {
  const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(canvas.width, canvas.height));
  const out = document.createElement("canvas");
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  const ctx = out.getContext("2d");
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  if (ctx.getImageData(0, 0, 1, 1).data[3] === 0) return null;
  return out.toDataURL("image/jpeg", 0.7).split(",")[1];
}

function snapshot({ position, rotation, intrinsics, worldPoints = [] }) {
  const cameraToWorld = new THREE.Matrix4().compose(
    new THREE.Vector3(position.x, position.y, position.z),
    new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
    new THREE.Vector3(1, 1, 1),
  );
  const projection = new THREE.Matrix4().fromArray(intrinsics);
  const surfaces = [];
  for (let gy = 0; gy < SURFACE_GRID; gy++) {
    for (let gx = 0; gx < SURFACE_GRID; gx++) {
      const x = (gx + 0.5) / SURFACE_GRID;
      const y = (gy + 0.5) / SURFACE_GRID;
      const hit = XR8.XrController.hitTest(x, y, ["ESTIMATED_SURFACE", "DETECTED_SURFACE"])[0];
      if (hit) surfaces.push(new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z));
    }
  }
  return {
    cameraToWorld,
    worldToCamera: cameraToWorld.clone().invert(),
    projection,
    projectionInverse: projection.clone().invert(),
    points: worldPoints.map(({ position: p }) => new THREE.Vector3(p.x, p.y, p.z)),
    surfaces,
  };
}

function sceneModule() {
  return {
    name: "talk2tech-scene",
    onStart: () => {
      const { scene, camera } = XR8.Threejs.xrScene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 1.5));
      scene.add(makeCube());
      camera.position.set(0, CAMERA_HEIGHT, 0);
      XR8.XrController.updateCameraProjectionMatrix({ origin: camera.position, facing: camera.quaternion });
    },
    onUpdate: () => animateCube(performance.now()),
  };
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
