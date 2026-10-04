// The waking-up spell: magic inked over the camera (above the video, under the controls) while a
// new object comes to life. A curly trail with a star on its tip circles the middle of the screen,
// flicking sparkles off as it goes, and when the object wakes it closes in on the face and pops.
// It's drawn on twos (12 drawings a second) with line boil, in the scribble face's ink and white
// rim, so the spell and the face look drawn by the same hand.

const FRAME_MS = 1000 / 12;
const BOILS = 4; // drawings in the line boil's cycle, as on the face
const INK = "#141414";
const RIM = "#ffffff";
const LINE = 3; // the trail's ink, in CSS pixels
const OUTLINE = 2; // sparkles' ink
const RIM_PX = 2.2; // white edge outside the ink, so it shows over dark and light alike
// Sparkle fills, mostly yellow, printed slightly out of register with their outlines.
const FILLS = ["#ffd23f", "#ffd23f", "#ffd23f", "#ff8fab", "#5ec8f2"];
const MISREGISTER = [1.8, 1.4];

// The trail: a loop round the middle of the screen with curls along it, drawn by a hand that
// speeds up and slows down.
const LAP_S = 3; // seconds per lap
const TRAIL = 0.42; // how much of a lap is inked at once
const GROW_S = 0.45; // how long it takes to draw out to full length
const SAMPLES = 360; // points per lap
const CURLS = 8.4; // per lap; not a whole number, so each lap curls in new places
const CURL = 0.16; // curl radius, as a share of the loop's
const TIP = 11; // the star on its tip, in CSS pixels
const FLICK_EVERY = [3, 7]; // frames between sparkles flicked off the tip: at least, and under
const MAX_SPARKLES = 8;

// Sparkles pop in and out a drawing at a time, one size per frame, and twinkle in between.
const POP_IN = [0.4, 1.3, 1];
const POP_OUT = [1.12, 0.55, 0.2];

// The object woke up: the trail closes in on its face over a few frames, then lines pop out round it.
const LAND = [0.4, 0.75, 1]; // how far the loop has moved onto the face
const LAND_TRAIL = [0.6, 0.35, 0.12]; // and how much of the trail is left
const BURST_FROM = [1.05, 1.25, 1.45, 1.6, 1.7]; // where the lines start, in face radii, per frame
const BURST_LEN = [0.3, 0.5, 0.38, 0.22, 0.1]; // and how long they are
const BURST_INK = [3.2, 3.2, 2.8, 2.2, 1.6];
const BURST_SKEW = [-0.1, 0.07, -0.05, 0.12, -0.09, 0.03, 0.1, -0.07]; // placed by hand, not evenly
const MIN_FACE_PX = 40;
// Nothing woke up: the tail catches up with the tip, and the star goes out.
const LEAVE_TRAIL = [0.6, 0.3, 0.1];
const LEAVE_TIP = [1.1, 0.6, 0.25];

let canvas = null;
let ctx = null;
let mode = null; // "casting", "landing" or "leaving"; null when there's nothing to draw
let since = 0; // when the mode began
let spell = null; // this spell's trail: where its tip is and how it's drawn
let sparkles = [];
let target = null; // what it's landing on: () => {x, y, r} in CSS pixels, or null
let lastSeen = null;
let nextFlick = 0;
let raf = 0;
let drawn = -1; // the frame last drawn

// Starts the spell, or keeps it going.
export function startMagic() {
  if (mode === "casting") return;
  canvas ??= document.getElementById("magic");
  if (!canvas) return;
  ctx ??= canvas.getContext("2d");
  const now = performance.now();
  spell = {
    start: Math.random(), // where on the loop the tip starts, in laps
    dir: Math.random() < 0.5 ? 1 : -1,
    squash: 0.86 + Math.random() * 0.12, // nobody draws a perfect circle
    tilt: (Math.random() - 0.5) * 0.6,
    seed: Math.random() * 100,
    wonk: wonky(),
    length: 0, // how much of a lap was inked when it stopped casting
    flung: false,
  };
  mode = "casting";
  since = now;
  nextFlick = frameAt(now) + 2;
  canvas.hidden = false;
  if (!raf) raf = requestAnimationFrame(tick);
}

// The object woke up: the spell lands on landOn() ({x, y, r} in CSS pixels, or null for the middle
// of the screen) and pops.
export function finishMagic(landOn) {
  if (mode !== "casting") return;
  settle(performance.now());
  target = landOn;
  lastSeen = null;
  mode = "landing";
}

// Nothing woke up: the trail winds itself in and the sparkles twinkle out.
export function stopMagic() {
  if (mode !== "casting") return;
  settle(performance.now());
  mode = "leaving";
}

const frameAt = (ms) => Math.floor(ms / FRAME_MS);

// Fixes where the casting trail's tip has got to and how long it is, for the next mode to carry on from.
function settle(now) {
  const s = (Math.max(0, frameAt(now - since)) * FRAME_MS) / 1000;
  spell.start = castHead(s);
  spell.length = castLength(s);
  since = now;
}

// Where the casting trail's tip is, in laps: it goes round at a hand's uneven pace.
function castHead(s) {
  return spell.start + spell.dir * (s / LAP_S + 0.035 * Math.sin(s * 2.2 + spell.seed));
}

function castLength(s) {
  return Math.min(TRAIL, (TRAIL * s) / GROW_S);
}

function tick(now) {
  if (!mode) {
    raf = 0;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    canvas.hidden = true;
    return;
  }
  raf = requestAnimationFrame(tick);
  // A new drawing 12 times a second; while landing, every frame too, to stay on the face as the
  // camera moves.
  if (frameAt(now) === drawn && mode !== "landing") return;
  drawn = frameAt(now);
  draw(now);
}

function draw(now) {
  fit();
  const w = innerWidth;
  const h = innerHeight;
  ctx.clearRect(0, 0, w, h);
  const frame = frameAt(now);
  const t = Math.max(0, frameAt(now - since)); // drawings into this mode
  const s = (t * FRAME_MS) / 1000;
  const boil = frame % BOILS;
  // The loop goes round a little above the middle, clear of the controls.
  const home = { x: w / 2, y: h * 0.45, r: Math.min(w, h * 0.75) * 0.32 };
  sparkles = sparkles.filter((sp) => frame - sp.born < sp.life);

  let trail = null; // the loop's centre and radius, where its tip is (in laps), and how much is inked
  let tip = 0; // the star on the tip, as a share of TIP
  let burst = -1; // which drawing of the burst, once it's landed
  const at = mode === "landing" ? landingSpot(w, h) : lastSeen;
  if (mode === "casting") {
    trail = { ...home, head: castHead(s), length: castLength(s) };
    tip = Math.floor(t / 2) % 2 ? 0.8 : 1;
  } else if (mode === "landing" && t < LAND.length) {
    const k = LAND[t];
    trail = {
      x: home.x + (at.x - home.x) * k,
      y: home.y + (at.y - home.y) * k,
      r: home.r + (at.r * 0.8 - home.r) * k,
      head: spell.start + (spell.dir * 1.6 * s) / LAP_S,
      length: spell.length * LAND_TRAIL[t],
    };
    tip = 1.1 - t * 0.25;
  } else if (mode === "landing") {
    burst = t - LAND.length;
    if (!spell.flung) fling(at, frame);
  } else if (mode === "leaving" && t < LEAVE_TRAIL.length) {
    trail = { ...home, head: spell.start + (spell.dir * s) / LAP_S, length: spell.length * LEAVE_TRAIL[t] };
    tip = LEAVE_TIP[t];
  }

  const points = trail ? trailPoints(trail, boil) : [];
  const end = points[points.length - 1];
  if (mode === "casting" && end && frame >= nextFlick) {
    if (sparkles.length < MAX_SPARKLES) flick(end, home, frame);
    nextFlick = frame + FLICK_EVERY[0] + Math.floor(Math.random() * (FLICK_EVERY[1] - FLICK_EVERY[0]));
  }

  // Every white rim first, then the ink and colour, so no rim covers another line's ink.
  for (const pass of ["rim", "ink"]) {
    drawTrail(pass, points);
    if (end && tip) star(pass, end[0], end[1], TIP * tip, frame * 0.35, spell.wonk, FILLS[0], boil);
    if (burst >= 0 && burst < BURST_FROM.length) drawBurst(pass, at, burst);
    for (const sp of sparkles) drawSparkle(pass, sp, frame, at ?? home);
  }

  const over = mode === "landing" ? burst >= BURST_FROM.length : mode === "leaving" && t >= LEAVE_TRAIL.length;
  if (over && !sparkles.length) mode = null;
}

// Keeps the canvas covering the window, at up to twice its CSS resolution.
function fit() {
  const ratio = Math.min(2, devicePixelRatio || 1);
  const width = Math.round(innerWidth * ratio);
  const height = Math.round(innerHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

// Where the spell is landing: the face if it can be seen, else where it was last seen, else the
// middle of the screen.
function landingSpot(w, h) {
  const found = target?.();
  if (found) lastSeen = { x: found.x, y: found.y, r: Math.max(MIN_FACE_PX, found.r ?? Math.min(w, h) * 0.14) };
  return lastSeen ?? { x: w / 2, y: h * 0.45, r: Math.min(w, h) * 0.14 };
}

// ---------- the trail ----------

// The inked stretch of the trail, tail to tip, as [x, y, ink width] points.
function trailPoints(trail, boil) {
  const count = Math.round(trail.length * SAMPLES);
  if (count < 2) return [];
  const head = Math.round(trail.head * SAMPLES);
  const cos = Math.cos(spell.tilt);
  const sin = Math.sin(spell.tilt);
  const points = [];
  for (let i = 0; i <= count; i++) {
    const n = head - spell.dir * (count - i);
    const a = (n / SAMPLES) * Math.PI * 2;
    // Drawn by hand: the loop's never quite round, and its curls are never quite even.
    const wobble = 1 + 0.05 * Math.sin(a * 2 + spell.seed) + 0.03 * Math.sin(a * 5 + spell.seed * 1.7);
    const curl = trail.r * CURL * (1 + 0.2 * Math.sin(a * 3 + spell.seed * 2.3));
    const c = a * CURLS + spell.seed;
    // Line boil: each point has its own wiggle per drawing, so the line shimmers rather than crawls.
    const x =
      trail.r * wobble * Math.cos(a) + curl * Math.cos(c) +
      1.2 * Math.sin(n * 0.23 + boil * 1.7) + 0.5 * Math.sin(n * 0.9 + boil * 4.1);
    const y =
      trail.r * wobble * spell.squash * Math.sin(a) + curl * Math.sin(c) +
      1.2 * Math.cos(n * 0.19 + boil * 2.9) + 0.5 * Math.cos(n * 0.7 + boil * 3.3);
    // The pen presses a little harder and softer, and the tail thins out as it fades.
    const width = LINE * (0.8 + 0.2 * Math.sin(n * 0.09 + spell.seed)) * Math.min(1, i / count / 0.4);
    points.push([trail.x + x * cos - y * sin, trail.y + x * sin + y * cos, width]);
  }
  return points;
}

function drawTrail(pass, points) {
  ctx.strokeStyle = pass === "rim" ? RIM : INK;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1, width] = points[i];
    // The rim thins with the ink, so the tail fades out rather than ending in a white stub.
    ctx.lineWidth = pass === "rim" ? width * (1 + (2 * RIM_PX) / LINE) : width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
}

// ---------- sparkles ----------

// Flicks a sparkle off the trail's tip, away from the middle. Some get a small star, a dot or a
// glint beside them, the way people doodle sparkles.
function flick([tipX, tipY], home, frame) {
  const dx = tipX - home.x;
  const dy = tipY - home.y;
  const d = Math.hypot(dx, dy) || 1;
  const out = 10 + Math.random() * 14;
  const x = tipX + (dx / d) * out + (Math.random() - 0.5) * 10;
  const y = tipY + (dy / d) * out + (Math.random() - 0.5) * 10;
  const main = sparkle({ x, y, size: 7 + Math.random() * 6, born: frame });
  sparkles.push(main);
  const side = Math.random() < 0.5 ? -1 : 1;
  const extra = Math.random();
  if (extra < 0.35) {
    sparkles.push(sparkle({ x: x + side * main.size * 1.5, y: y - main.size * 1.2, size: main.size * 0.5, fill: main.fill, born: frame + 1 }));
  } else if (extra < 0.55) {
    sparkles.push(sparkle({ kind: "dot", x: x - side * main.size * 1.3, y: y + main.size * 1.1, size: 2.6, born: frame + 1 }));
  } else if (extra < 0.68) {
    sparkles.push(sparkle({ kind: "glint", x: x + side * main.size * 1.6, y: y + main.size * 0.6, size: 4.5, born: frame + 1 }));
  }
}

// Throws a few sparkles out from the face as it wakes, between the burst's lines.
function fling(at, frame) {
  spell.flung = true;
  for (let i = 0; i < 4; i++) {
    const a = spell.seed + ((i + 0.25) / 4) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
    sparkles.push(sparkle({
      anchored: true,
      x: Math.cos(a) * at.r * 1.15,
      y: Math.sin(a) * at.r * 1.15,
      vx: Math.cos(a) * at.r * 0.1,
      vy: Math.sin(a) * at.r * 0.1,
      size: 8 + Math.random() * 5,
      born: frame,
      life: 7 + (i % 2) * 2,
    }));
  }
}

// A star unless told otherwise, with its own wonky proportions and lifetime.
function sparkle(props) {
  return {
    kind: "star",
    vx: 0, // drift per frame
    vy: 0,
    anchored: false, // placed relative to the face it's landing on, rather than the screen
    rot: (Math.random() - 0.5) * 0.5,
    fill: FILLS[Math.floor(Math.random() * FILLS.length)],
    wonk: wonky(),
    seed: Math.random() * 10,
    life: 9 + Math.floor(Math.random() * 7),
    ...props,
  };
}

// How much longer each of a star's four points is than it should be.
function wonky() {
  return [0, 0, 0, 0].map(() => 0.85 + Math.random() * 0.3);
}

function drawSparkle(pass, sp, frame, anchor) {
  const age = frame - sp.born;
  if (age < 0) return;
  const k = sparkleSize(sp, age);
  if (!k) return;
  const x = sp.x + sp.vx * age + (sp.anchored ? anchor.x : 0);
  const y = sp.y + sp.vy * age + (sp.anchored ? anchor.y : 0);
  const size = sp.size * k;
  const rot = sp.rot + (Math.floor(age / 2) % 2 ? 0.15 : 0);
  if (sp.kind === "dot") {
    inked(pass, (dx, dy) => {
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, size, 0, Math.PI * 2);
    }, sp.fill);
  } else if (sp.kind === "glint") {
    // A little "+", just ink.
    inked(pass, () => {
      ctx.beginPath();
      for (const a of [rot, rot + Math.PI / 2]) {
        ctx.moveTo(x - Math.cos(a) * size, y - Math.sin(a) * size);
        ctx.lineTo(x + Math.cos(a) * size, y + Math.sin(a) * size);
      }
    }, null);
  } else {
    star(pass, x, y, size, rot, sp.wonk, sp.fill, frame % BOILS, sp.seed);
  }
}

// Pops in a size too big, twinkles on twos, and shrinks to a speck on the way out.
function sparkleSize(sp, age) {
  if (age < POP_IN.length) return POP_IN[age];
  const left = sp.life - age;
  if (left <= 0) return 0;
  if (left <= POP_OUT.length) return POP_OUT[POP_OUT.length - left];
  return Math.floor(age / 2) % 2 ? 0.84 : 1;
}

function star(pass, x, y, size, rot, wonk, fill, boil, seed = 0) {
  if (size < 0.5) return;
  const points = wonk.map((v, i) => v + 0.06 * Math.sin(boil * 2.3 + i * 1.9 + seed));
  inked(pass, (dx, dy) => starPath(x + dx, y + dy, size, rot, points), fill);
}

// A four-point sparkle: long points up and down, shorter ones across, its sides pinched in.
function starPath(x, y, size, rot, wonk) {
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const a = rot + (i * Math.PI) / 2;
    const reach = size * (i % 2 ? 0.7 : 1) * wonk[i % 4];
    const px = x + Math.sin(a) * reach;
    const py = y - Math.cos(a) * reach;
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      const pinch = a - Math.PI / 4;
      ctx.quadraticCurveTo(x + Math.sin(pinch) * size * 0.14, y - Math.cos(pinch) * size * 0.14, px, py);
    }
  }
  ctx.closePath();
}

// Draws a shape for this pass: a white rim round it, or its colour (printed a little out of
// register) under an ink outline. path(dx, dy) traces the shape, shifted by that much.
function inked(pass, path, fill) {
  if (pass === "rim") {
    path(0, 0);
    ctx.fillStyle = ctx.strokeStyle = RIM;
    ctx.lineWidth = OUTLINE + RIM_PX * 2;
    ctx.fill();
    ctx.stroke();
    return;
  }
  if (fill) {
    path(MISREGISTER[0], MISREGISTER[1]);
    ctx.fillStyle = fill;
    ctx.fill();
  }
  path(0, 0);
  ctx.strokeStyle = INK;
  ctx.lineWidth = OUTLINE;
  ctx.stroke();
}

// ---------- the landing ----------

// Lines popping out round the face as it wakes, like a cartoon "ta-da". Every other one's shorter.
function drawBurst(pass, at, step) {
  const ink = BURST_INK[step];
  ctx.strokeStyle = pass === "rim" ? RIM : INK;
  ctx.lineWidth = pass === "rim" ? ink + RIM_PX * 2 : ink;
  BURST_SKEW.forEach((skew, i) => {
    const a = spell.seed + (i / BURST_SKEW.length) * Math.PI * 2 + skew;
    const from = at.r * BURST_FROM[step];
    const to = from + at.r * BURST_LEN[step] * (i % 2 ? 0.65 : 1);
    ctx.beginPath();
    ctx.moveTo(at.x + Math.cos(a) * from, at.y + Math.sin(a) * from);
    ctx.lineTo(at.x + Math.cos(a) * to, at.y + Math.sin(a) * to);
    ctx.stroke();
  });
}
