// AR on phones via the 8th Wall engine (world tracking in plain iOS Safari and Android Chrome),
// rendered with three.js. 8th Wall owns the camera: it draws the feed, tracks the phone's pose,
// and gives us the frames we send to Gemini. When Gemini says where the object is in one of those
// frames, a pulsating green slab is laid flat on its surface in the tracked 3D world.
//
// 8th Wall engine © Niantic Spatial, Inc., used under the XR Engine License Agreement:
// https://github.com/8thwall/engine/blob/main/LICENSE

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
const CUBE_MIN = 0.03;
const CUBE_MAX = 0.6;
const SLAB = 0.25; // thickness, as a fraction of the side: a flattish cube lying on the surface
const PULSE_HZ = 1.5;
const FOLLOW = 0.15; // per-frame easing toward a new placement, so re-locating doesn't jump
const MIN_PLANE_HITS = 4; // fewer hits than this can't give a trustworthy surface angle
const MAX_PLANE_ROUGHNESS = 0.2; // reject fits whose points stray from the plane by more than this share of their spread
// The slab never tilts further than this from facing the camera, so a noisy fit can't turn it
// edge-on (and invisible).
const MAX_TILT = (60 * Math.PI) / 180;
// A new box this close to the current placement (in slab sides) refines it instead of replacing it.
const SAME_SPOT = 2;
const RELOCATE_BLEND = 0.5;
// Between boxes, the surface under the slab is re-checked so it stays on it as tracking refines.
const REFINE_EVERY = 6; // frames
const REFINE_GRID = 4; // hit tests per side, spread over the slab's footprint on screen
const DEPTH_GAIN = 0.3;
// Re-checks only trust hits within this share of the slab's distance, and can never move it further
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
let cube, cubeFill;

// Camera pose, projection and 3D points for each frame we sent, so a box that arrives seconds
// later still maps onto the world the way it was when the photo was taken.
const snapshots = new Map();
let frameCounter = 0;
let captureWaiters = [];
let reality = null; // this frame's tracking output

// ?debug: what the AR pipeline did, shown on screen since phones have no console.
const stats = { sent: 0, unreadable: 0, boxes: 0, lastBox: "none yet", refines: 0, lastRefine: "" };
let statsShown = 0;

// Where the slab rests: a point on the surface, the surface normal (towards the camera), a
// direction in the surface for the slab's edges to follow, and its side length.
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
  // Must be in the page before the camera starts: the engine puts its video element next to it.
  document.body.append(canvas);
  XR8.XrController.configure({ disableWorldTracking: false });

  await new Promise((resolve, reject) => {
    XR8.addCameraPipelineModules([
      fullWindowModule(),
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
export function placeBox(box, frameId) {
  const snap = snapshots.get(frameId);
  stats.boxes++;
  if (!running || !box) return;
  if (!snap) {
    stats.lastBox = `${frameId}: no saved pose for that frame`;
    return;
  }
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

  // Real-world size of the box at that depth; the slab matches its smaller side.
  const p = snap.projection.elements;
  const width = ((xmax - xmin) / 500) * (depth / p[0]);
  const height = ((ymax - ymin) / 500) * (depth / p[5]);
  const side = THREE.MathUtils.clamp(Math.min(width, height), CUBE_MIN, CUBE_MAX);
  const right = new THREE.Vector3(1, 0, 0).transformDirection(snap.cameraToWorld);

  // Same object again (a later turn): nudge the slab rather than jumping to a noisier estimate.
  if (placement && placement.point.distanceTo(point) < SAME_SPOT * Math.max(side, placement.size)) {
    placement.point.lerp(point, RELOCATE_BLEND);
    placement.home.lerp(point, RELOCATE_BLEND);
    placement.leash += (depth * REFINE_LEASH - placement.leash) * RELOCATE_BLEND;
    limitTilt(placement.normal.lerp(normal, RELOCATE_BLEND).normalize(), origin.clone().sub(placement.point));
    placement.size += (side - placement.size) * RELOCATE_BLEND;
    source += ", blended";
  } else {
    // home and leash: where the box put it, and how far re-checks may move it from there.
    placement = { point, normal, right, size: side, home: point.clone(), leash: depth * REFINE_LEASH };
  }
  aimSlab();

  const fmt = (v) => v.toArray().map((n) => n.toFixed(2)).join(", ");
  stats.lastBox = `${frameId}: depth ${depth.toFixed(2)} (${source}), side ${side.toFixed(2)}, normal ${fmt(placement.normal)}`;
}

export function clearCube() {
  placement = null;
  targetPosition = null;
  if (cube) cube.visible = false;
}

// Turns the placement into the slab's pose: lying on the surface, its face along the normal and
// its edges lined up with `right` (the camera's sideways direction when it was placed).
function aimSlab() {
  const { point, normal, right } = placement;
  let x = right.clone().addScaledVector(normal, -right.dot(normal));
  if (x.lengthSq() < 1e-6) x = new THREE.Vector3(0, 0, 1).cross(normal);
  x.normalize();
  const z = x.clone().cross(normal);
  targetQuaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, normal, z));
  targetPosition = point.clone().addScaledVector(normal, (placement.size * SLAB) / 2);
}

// Re-checks the surface under the slab with a few hit tests around where it appears on screen,
// and eases the slab's depth and angle onto it. Only depth along the line of sight is corrected:
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

  // The slab's half-width on screen, in hit-test units (0-1 across the canvas).
  const side = new THREE.Vector3(1, 0, 0).transformDirection(camera.matrixWorld);
  const edge = placement.point.clone().addScaledVector(side, placement.size / 2).project(camera);
  const rx = THREE.MathUtils.clamp(Math.abs(edge.x - centre.x) / 2, 0.01, 0.2);
  const ry = rx * (canvas.width / canvas.height);
  const sx = (centre.x + 1) / 2;
  const sy = (1 - centre.y) / 2;

  // Keep hits near the line of sight to the slab and near its current depth.
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
  aimSlab();
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
  if (pixels[3] === 0) return null; // nothing drawn yet

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
  const cubeState = placement ? `shown, ${stats.refines} surface re-checks (last: ${stats.lastRefine || "none"})` : "not placed";
  el.textContent = [
    `tracking: ${tracking}`,
    `frames sent: ${stats.sent}, unreadable: ${stats.unreadable}, boxes: ${stats.boxes}`,
    `last box: ${stats.lastBox}`,
    `cube: ${cubeState}`,
  ].join("\n");
  el.hidden = false;
}

// Called in onRender, after the three.js module has moved its camera to this frame's pose, so
// placement uses exactly the camera the cube is drawn with.
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
      scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 1.5));
      scene.add(makeCube());
      camera.position.set(0, CAMERA_HEIGHT, 0);
      XR8.XrController.updateCameraProjectionMatrix({ origin: camera.position, facing: camera.quaternion });
    },
    onUpdate: () => {
      if (++updates % REFINE_EVERY === 0) refineOnSurface(XR8.Threejs.xrScene().camera);
      animateCube(performance.now());
    },
  };
}

// ---------- the cube ----------

function makeCube() {
  // Unit side, flattened: its local Y is the surface normal.
  const geometry = new THREE.BoxGeometry(1, SLAB, 1);
  cubeFill = new THREE.MeshStandardMaterial({
    color: 0x22ff66,
    emissive: 0x22ff66,
    emissiveIntensity: 0.6,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    side: THREE.DoubleSide, // still visible if the camera ends up inside it
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
  if (!targetPosition) return;
  if (!cube.visible) {
    cube.position.copy(targetPosition);
    cube.quaternion.copy(targetQuaternion);
    size = placement.size;
    cube.visible = true;
  } else {
    cube.position.lerp(targetPosition, FOLLOW);
    cube.quaternion.slerp(targetQuaternion, FOLLOW);
    size += (placement.size - size) * FOLLOW;
  }
  const seconds = time / 1000;
  const pulse = Math.sin(seconds * 2 * Math.PI * PULSE_HZ);
  cube.scale.setScalar(size * (1 + 0.08 * pulse));
  cubeFill.emissiveIntensity = 0.6 + 0.4 * pulse;
  cubeFill.opacity = 0.35 + 0.15 * pulse;
}
