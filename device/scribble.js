// The talking face's look and sound, taken from the feature/ar branch (Cody Nguyen): a hand-drawn
// scribble face with 12 FPS line boil and a mouth that opens with the voice's loudness (or flaps
// at ~6.5 Hz without it), which panics and screams (450 Hz -> 1500 Hz) as it nears the edge of the
// screen and dies cartoonishly (slide whistle, splat, X_X) if it's lost off it. While the object
// thinks of a reply, the face turns into a thought bubble. ar.js draws it onto a texture stuck
// flat on the object.

// The face turning into a thought bubble, and back: one drawing per frame (12 a second), like cel
// animation. Each sizes the face and/or the bubble [x, y], and poof is how far a puff of smoke
// between them has spread.
const TO_BUBBLE = [
  { face: [1, 1] },
  { face: [1.12, 0.84] },
  { face: [0.5, 0.56], poof: 0.25 },
  { poof: 0.6 },
  { bubble: [0.6, 0.6], poof: 0.95 },
  { bubble: [1.12, 1.08] },
  { bubble: [1, 1] },
];
const TO_FACE = [
  { bubble: [1, 1] },
  { bubble: [1.1, 0.86] },
  { bubble: [0.5, 0.55], poof: 0.25 },
  { poof: 0.6 },
  { face: [0.6, 0.6], poof: 0.95 },
  { face: [1.12, 1.08] },
  { face: [1, 1] },
];
// The puffs of smoke: angle, how far each goes, and how big it starts.
const POOF = [[-1.9, 1, 9], [-0.6, 0.85, 7], [0.5, 1, 8], [1.6, 0.8, 6.5], [2.7, 0.95, 8.5]];
// The bubble's cloud is puffs round an ellipse: each one's height, and a nudge to where it starts,
// so it comes out lumpy like a drawn cloud.
const CLOUD_PUFFS = [[15, 0], [12, 0.05], [17, -0.04], [13, 0.03], [16, -0.06], [12, 0.04], [18, 0], [14, -0.03], [13, 0.05]];
// The little puffs trailing off it: x, y, radius, boil seed.
const THOUGHT_TRAIL = [[-30, 48, 8.5, 41], [-45, 65, 5.2, 47]];
// "..." in the bubble shows a dot every 3 frames, holds, then starts over, this many frames a round.
const THINK_BEATS = 18;
// A new face pops in rather than just appearing: its size, one per frame.
const APPEAR = [0.25, 0.7, 1.15, 1.04];


// =========================================================================
// 2. Edge Fear System (R4)
// =========================================================================
export class EdgeFearSystem {
  static PANIC_THRESHOLD = 0.22; // d <= 0.22 enters panic state

  /**
   * Computes normalized distance d to viewport boundaries from normalized (u, v) in [0, 1].
   */
  static computeEdgeDistances(u, v) {
    const dLeft = u;
    const dRight = 1 - u;
    const dTop = v;
    const dBottom = 1 - v;
    const d = Math.min(dLeft, dRight, dTop, dBottom);

    return { d, dLeft, dRight, dTop, dBottom };
  }

  /**
   * Computes panic intensity in [0.0, 1.0].
   * Calm when d > 0.22. Escalates linearly to 1.0 as d -> 0.
   */
  static computePanic(d, threshold = EdgeFearSystem.PANIC_THRESHOLD) {
    if (d > threshold) return 0.0;
    if (d <= 0.0) return 1.0;
    const raw = (threshold - d) / threshold;
    return Math.max(0.0, Math.min(1.0, raw));
  }

  /**
   * Checks if coordinates have exited the screen viewport.
   */
  static isOffscreen(u, v, margin = 0.0, behind = false) {
    if (behind) return true;
    return u < -margin || u > 1 + margin || v < -margin || v > 1 + margin;
  }

  /**
   * Determines which edge is nearest ('left', 'right', 'top', 'bottom').
   */
  static getNearestEdge(u, v) {
    const { dLeft, dRight, dTop, dBottom } = EdgeFearSystem.computeEdgeDistances(u, v);
    const minD = Math.min(dLeft, dRight, dTop, dBottom);
    if (minD === dLeft) return "left";
    if (minD === dRight) return "right";
    if (minD === dTop) return "top";
    return "bottom";
  }
}

// =========================================================================
// 3. Procedural Web Audio Screaming & Death Sound (R4)
// =========================================================================
export class ProceduralAudio {
  constructor(audioContext = null) {
    this.ctx = audioContext;
    this.state = "idle"; // 'idle' | 'panicking' | 'falling' | 'dead'

    this.masterGain = null;
    this.screamOsc = null;
    this.screamLfo = null;
    this.screamLfoGain = null;
    this.screamGain = null;
    this.screamFilter = null;

    this.currentFrequency = 450;
    this.currentPanic = 0;

    this.deathTimer = null;
    this.whistleOsc = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  setupNodes() {
    if (!this.ensureContext() || this.masterGain) return;

    const now = this.ctx.currentTime;
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.7, now);
    this.masterGain.connect(this.ctx.destination);

    // Scream filter (formant/resonant vocal shaping)
    this.screamFilter = this.ctx.createBiquadFilter();
    this.screamFilter.type = "bandpass";
    this.screamFilter.frequency.setValueAtTime(1400, now);
    this.screamFilter.Q.setValueAtTime(1.5, now);

    this.screamGain = this.ctx.createGain();
    this.screamGain.gain.setValueAtTime(0.0001, now);

    this.screamFilter.connect(this.screamGain);
    this.screamGain.connect(this.masterGain);

    // Main scream oscillator: sawtooth wave
    this.screamOsc = this.ctx.createOscillator();
    this.screamOsc.type = "sawtooth";
    this.screamOsc.frequency.setValueAtTime(450, now);

    // Vibrato / vocal flutter LFO
    this.screamLfo = this.ctx.createOscillator();
    this.screamLfo.type = "sine";
    this.screamLfo.frequency.setValueAtTime(14, now); // 14 Hz flutter

    this.screamLfoGain = this.ctx.createGain();
    this.screamLfoGain.gain.setValueAtTime(25, now);

    this.screamLfo.connect(this.screamLfoGain);
    this.screamLfoGain.connect(this.screamOsc.frequency);

    this.screamOsc.connect(this.screamFilter);

    try {
      this.screamOsc.start();
      this.screamLfo.start();
    } catch (e) {
      // Already started or mocked
    }
  }

  /**
   * Updates panic level (0.0 to 1.0). Slides frequency from 450 Hz to 1500 Hz.
   */
  updatePanic(panic) {
    this.currentPanic = Math.max(0, Math.min(1, panic));

    if (this.state === "falling" || this.state === "dead") return;

    if (this.currentPanic <= 0.001) {
      this.currentFrequency = 450;
      if (this.state === "panicking") {
        this.state = "idle";
        if (this.ctx) {
          const now = this.ctx.currentTime;
          if (this.screamGain) {
            this.screamGain.gain.cancelScheduledValues(now);
            this.screamGain.gain.setTargetAtTime(0.0001, now, 0.08);
          }
          if (this.screamOsc) {
            this.screamOsc.frequency.cancelScheduledValues(now);
            this.screamOsc.frequency.setTargetAtTime(450, now, 0.1);
          }
        }
      }
      return;
    }

    this.setupNodes();
    if (!this.ctx || !this.screamOsc || !this.screamGain) return;

    this.state = "panicking";
    const now = this.ctx.currentTime;

    // Frequency sliding: 450 Hz -> 1500 Hz
    const targetFreq = 450 + 1050 * this.currentPanic;
    this.currentFrequency = targetFreq;
    this.screamOsc.frequency.cancelScheduledValues(now);
    this.screamOsc.frequency.setTargetAtTime(targetFreq, now, 0.04);

    // Formant shift with panic
    if (this.screamFilter) {
      this.screamFilter.frequency.cancelScheduledValues(now);
      this.screamFilter.frequency.setTargetAtTime(1200 + 800 * this.currentPanic, now, 0.05);
    }

    // Flutter intensity scales with panic
    if (this.screamLfoGain) {
      this.screamLfoGain.gain.cancelScheduledValues(now);
      this.screamLfoGain.gain.setTargetAtTime(15 + 45 * this.currentPanic, now, 0.05);
    }

    // Volume scaling with panic
    const targetVol = 0.08 + 0.42 * this.currentPanic;
    this.screamGain.gain.cancelScheduledValues(now);
    this.screamGain.gain.setTargetAtTime(targetVol, now, 0.04);
  }

  /**
   * Triggers comical cartoon death sequence:
   * 1. Falling slide whistle (1500 Hz -> 150 Hz)
   * 2. Comical splat/crash sound
   */
  triggerDeathSequence(onComplete) {
    if (this.state === "falling" || this.state === "dead") return;
    this.state = "falling";

    this.setupNodes();
    if (!this.ctx) {
      this.state = "dead";
      onComplete?.();
      return;
    }

    const now = this.ctx.currentTime;

    // Silence ongoing scream and reset frequency back to 450 Hz
    this.currentFrequency = 450;
    if (this.screamGain) {
      this.screamGain.gain.cancelScheduledValues(now);
      this.screamGain.gain.setValueAtTime(0.0001, now);
    }
    if (this.screamOsc) {
      this.screamOsc.frequency.cancelScheduledValues(now);
      this.screamOsc.frequency.setValueAtTime(450, now);
    }

    // Falling whistle oscillator
    this.whistleOsc = this.ctx.createOscillator();
    const whistleGain = this.ctx.createGain();
    this.whistleOsc.type = "sine";
    this.whistleOsc.frequency.setValueAtTime(1500, now);
    this.whistleOsc.frequency.exponentialRampToValueAtTime(150, now + 0.55);

    whistleGain.gain.setValueAtTime(0.35, now);
    whistleGain.gain.linearRampToValueAtTime(0.4, now + 0.45);
    whistleGain.gain.exponentialRampToValueAtTime(0.001, now + 0.58);

    this.whistleOsc.connect(whistleGain);
    whistleGain.connect(this.masterGain || this.ctx.destination);

    try {
      this.whistleOsc.start(now);
      this.whistleOsc.stop(now + 0.6);
    } catch (e) {}

    // Splat sound at whistle end
    this.deathTimer = setTimeout(() => {
      this.deathTimer = null;
      if (this.state === "falling") {
        this.playSplatSound();
        this.state = "dead";
        onComplete?.();
      }
    }, 550);
  }

  /**
   * Cartoon splat / crash sound
   */
  playSplatSound() {
    if (!this.ensureContext()) return;
    const now = this.ctx.currentTime;

    // Low resonant thump
    const thump = this.ctx.createOscillator();
    const thumpGain = this.ctx.createGain();
    thump.type = "triangle";
    thump.frequency.setValueAtTime(110, now);
    thump.frequency.exponentialRampToValueAtTime(35, now + 0.25);

    thumpGain.gain.setValueAtTime(0.6, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

    thump.connect(thumpGain);
    thumpGain.connect(this.masterGain || this.ctx.destination);

    try {
      thump.start(now);
      thump.stop(now + 0.3);
    } catch (e) {}

    // Noise burst for wet splat texture
    const sampleRate = (this.ctx && this.ctx.sampleRate) ? this.ctx.sampleRate : 44100;
    const bufferSize = Math.max(1, Math.floor(sampleRate * 0.2));
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.25));
    }

    const whiteNoise = this.ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;

    const splatFilter = this.ctx.createBiquadFilter();
    splatFilter.type = "lowpass";
    splatFilter.frequency.setValueAtTime(800, now);

    const splatGain = this.ctx.createGain();
    splatGain.gain.setValueAtTime(0.4, now);
    splatGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    whiteNoise.connect(splatFilter);
    splatFilter.connect(splatGain);
    splatGain.connect(this.masterGain || this.ctx.destination);

    try {
      whiteNoise.start(now);
      whiteNoise.stop(now + 0.25);
    } catch (e) {}
  }

  reset() {
    if (this.deathTimer) {
      clearTimeout(this.deathTimer);
      this.deathTimer = null;
    }
    if (this.whistleOsc) {
      try {
        this.whistleOsc.stop();
        this.whistleOsc.disconnect();
      } catch (e) {}
      this.whistleOsc = null;
    }
    if (this.ctx) {
      const now = this.ctx.currentTime;
      if (this.screamGain) {
        this.screamGain.gain.cancelScheduledValues(now);
        this.screamGain.gain.setValueAtTime(0.0001, now);
      }
      if (this.screamOsc) {
        this.screamOsc.frequency.cancelScheduledValues(now);
        this.screamOsc.frequency.setValueAtTime(450, now);
      }
    }
    this.state = "idle";
    this.currentPanic = 0;
    this.currentFrequency = 450;
  }
}

// =========================================================================
// 4. Simplistic Scribble Drawing Aesthetics with 12 FPS Line Boil (R2)
// =========================================================================
export class ScribbleFace {
  constructor() {
    this.boilFPS = 12;
    this.boilInterval = 1000 / this.boilFPS; // ~83.33ms
    this.lastBoilTime = 0;
    this.boilFrame = 0; // 0, 1, 2, 3 cycle

    // Emotion / Animation state
    this.panic = 0; // 0.0 to 1.0
    this.speaking = false;
    this.lipSyncPhase = 0;
    this.mouthLevel = null; // 0-1 from the voice's loudness; null flaps the mouth on its own
    this.isDead = false;
    this.gazeDirection = { x: 0, y: 0 }; // Looking direction
    this.thinking = false; // shown as a thought bubble instead of a face
    this.morphStart = -Infinity; // when it last started turning into the bubble, or back
    this.appearStart = -Infinity; // when it last popped into view

    // Pre-cached scribble jitter tables for deterministic 12 FPS boil
    this.boilTables = this.generateBoilTables();
  }

  /**
   * Turns the face into a thought bubble, or back, from whichever drawing it's got to.
   * instant skips the animation.
   */
  setThinking(on, now = performance.now(), instant = false) {
    on = Boolean(on);
    if (on !== this.thinking) {
      const last = TO_BUBBLE.length - 1;
      const done = Math.min(last, Math.floor((now - this.morphStart) / this.boilInterval));
      this.thinking = on;
      // Changing its mind part-way runs the other way from the matching drawing.
      this.morphStart = now - (last - done) * this.boilInterval;
    }
    if (instant) this.morphStart = -Infinity;
  }

  /**
   * Pops the face into view, a size too big before it settles.
   */
  appear(now = performance.now()) {
    this.appearStart = now;
  }

  generateBoilTables() {
    const frames = 4;
    const count = 64;
    const tables = [];

    for (let f = 0; f < frames; f++) {
      const offsets = [];
      for (let i = 0; i < count; i++) {
        const angle = (i * 1.6180339887) % (Math.PI * 2);
        const rad = 1.2 + ((i + f * 7) % 5) * 0.6;
        offsets.push({
          dx: Math.cos(angle + f) * rad,
          dy: Math.sin(angle + f * 1.3) * rad,
        });
      }
      tables.push(offsets);
    }
    return tables;
  }

  update(now = performance.now()) {
    if (now - this.lastBoilTime >= this.boilInterval) {
      this.boilFrame = (this.boilFrame + 1) % 4;
      this.lastBoilTime = now;
    }

    if (this.speaking) {
      // Mouth flaps at ~6.5 Hz human speech rate (2 * PI * 6.5 / 1000 rad/ms)
      const omega = (6.5 * 2 * Math.PI) / 1000;
      this.lipSyncPhase = (now * omega) % (Math.PI * 2);
    } else {
      this.lipSyncPhase = 0;
    }
  }

  getBoil(index) {
    const frame = Math.max(0, Math.min(3, this.boilFrame || 0));
    const table = this.boilTables[frame] || this.boilTables[0];
    const i = Math.floor(Math.abs(index || 0)) % table.length;
    return table[i] || { dx: 0, dy: 0 };
  }

  /**
   * Draws a hand-drawn squigglevision doodle path through points with smooth periodic closed curves
   */
  drawScribbleLoop(ctx, cx, cy, rx, ry, pointCount = 8, jitterMultiplier = 1.0, seedOffset = 0) {
    const frame = Math.max(0, Math.min(3, this.boilFrame || 0));
    const boil = this.boilTables[frame] || this.boilTables[0];

    const points = [];
    for (let i = 0; i < pointCount; i++) {
      const theta = (i / pointCount) * Math.PI * 2;
      const idx = Math.floor(Math.abs(i * 3 + frame * 5 + seedOffset)) % boil.length;
      const b = boil[idx] || { dx: 0, dy: 0 };
      const jx = b.dx * jitterMultiplier;
      const jy = b.dy * jitterMultiplier;

      const px = cx + (rx + jx) * Math.cos(theta);
      const py = cy + (ry + jy) * Math.sin(theta);
      points.push({ x: px, y: py });
    }

    ctx.beginPath();
    // Seamless periodic closed spline wrapping smoothly around the loop
    const last = points[pointCount - 1];
    ctx.moveTo((last.x + points[0].x) / 2, (last.y + points[0].y) / 2);
    for (let i = 0; i < pointCount; i++) {
      const next = points[(i + 1) % pointCount];
      const midX = (points[i].x + next.x) / 2;
      const midY = (points[i].y + next.y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
    }
    ctx.closePath();
    ctx.stroke();
  }

  /**
   * Main rendering method on 2D context at (cx, cy)
   */
  draw(ctx, cx, cy, scale = 1.0, now = performance.now(), drawFace = true) {
    this.update(now);

    if (drawFace) {
      ctx.save();

      // Panicked frantic jitter shaking
      let shakeX = 0;
      let shakeY = 0;
      if (this.panic > 0.05 && !this.isDead) {
        const shakeMag = this.panic * 16 * scale;
        shakeX = (Math.random() - 0.5) * shakeMag;
        shakeY = (Math.random() - 0.5) * shakeMag;
      }

      ctx.translate(cx + shakeX, cy + shakeY);
      const appearing = APPEAR[Math.floor((now - this.appearStart) / this.boilInterval)] ?? 1;
      ctx.scale(scale * appearing, scale * appearing);

      // Line style: hand-drawn sketchy ink
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "#141414";
      ctx.fillStyle = "#ffffff";

      if (this.isDead) {
        this.drawDeadFace(ctx);
      } else {
        this.drawMorph(ctx, now);
      }

      ctx.restore();
    }
  }

  /**
   * The living face, the thought bubble, or one of the drawings between them.
   */
  drawMorph(ctx, now) {
    const drawings = this.thinking ? TO_BUBBLE : TO_FACE;
    const frame = Math.min(drawings.length - 1, Math.floor((now - this.morphStart) / this.boilInterval));
    const { face, bubble, poof } = drawings[frame];
    if (face) this.drawSized(ctx, face, () => this.drawLivingFace(ctx));
    if (bubble) this.drawSized(ctx, bubble, () => this.drawThoughtBubble(ctx, now));
    if (poof) this.drawPoof(ctx, poof);
  }

  drawSized(ctx, [sx, sy], drawing) {
    ctx.save();
    ctx.scale(sx, sy);
    drawing();
    ctx.restore();
  }

  /**
   * A thought bubble: a lumpy cloud trailing little puffs, with "..." appearing in it a dot at a time.
   */
  drawThoughtBubble(ctx, now) {
    const cy = -14;

    ctx.save();
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    this.cloudPath(ctx, 0, cy, 54, 36);
    ctx.fill();
    ctx.stroke();
    // A second, lighter line just inside, like the eyes' double strokes, so it reads as sketched.
    ctx.lineWidth = 2.0;
    ctx.strokeStyle = "#2b2b2b";
    this.cloudPath(ctx, 1, cy + 1, 50, 33, 19);
    ctx.stroke();

    ctx.lineWidth = 3;
    ctx.strokeStyle = "#141414";
    for (const [x, y, r, seed] of THOUGHT_TRAIL) {
      this.drawScribbleLoop(ctx, x, y, r, r * 0.9, 7, 0.8, seed);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    // The dots start once the bubble has popped up; each pops in a size too big.
    const beat = Math.floor((now - this.morphStart) / this.boilInterval) - (TO_BUBBLE.length - 1);
    if (!this.thinking || beat < 0) return;
    const step = beat % THINK_BEATS;
    ctx.fillStyle = "#141414";
    for (let i = 0; i < 3; i++) {
      const shows = 1 + i * 3;
      if (step < shows || step >= THINK_BEATS - 2) continue;
      const r = step === shows ? 8.5 : 6.5;
      this.drawScribbleLoop(ctx, (i - 1) * 22, cy + 2, r, r, 6, 0.5, 50 + i * 7);
      ctx.fill();
    }
  }

  /**
   * The cloud's outline: lumpy puffs round an ellipse, boiling like the rest of the face.
   */
  cloudPath(ctx, cx, cy, rx, ry, seed = 0) {
    const n = CLOUD_PUFFS.length;
    const corner = (i) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2 + CLOUD_PUFFS[i % n][1];
      const b = this.getBoil((i % n) * 5 + seed);
      return { a, x: cx + rx * Math.cos(a) + b.dx * 0.6, y: cy + ry * Math.sin(a) + b.dy * 0.6 };
    };
    ctx.beginPath();
    let p = corner(0);
    ctx.moveTo(p.x, p.y);
    for (let i = 0; i < n; i++) {
      const q = corner(i + 1);
      // Push the curve out from the ellipse, and a little past its corners so the puff comes out round.
      const mid = (p.a + q.a) / 2;
      let nx = Math.cos(mid) / rx;
      let ny = Math.sin(mid) / ry;
      const len = Math.hypot(nx, ny);
      nx /= len;
      ny /= len;
      const push = CLOUD_PUFFS[i][0] * 1.33;
      const sx = (q.x - p.x) * 0.15;
      const sy = (q.y - p.y) * 0.15;
      const b = this.getBoil(i * 7 + seed + 3);
      ctx.bezierCurveTo(
        p.x + nx * push - sx + b.dx * 0.5, p.y + ny * push - sy + b.dy * 0.5,
        q.x + nx * push + sx - b.dy * 0.5, q.y + ny * push + sy + b.dx * 0.5,
        q.x, q.y,
      );
      p = q;
    }
    ctx.closePath();
  }

  /**
   * A puff of smoke between the face and the bubble: little clouds flung out, shrinking as they go.
   */
  drawPoof(ctx, spread) {
    ctx.save();
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.lineWidth = 2.5;
    POOF.forEach(([angle, reach, size], i) => {
      const d = 16 + reach * 46 * spread;
      const r = size * (1.15 - spread * 0.75);
      this.drawScribbleLoop(ctx, Math.cos(angle) * d, Math.sin(angle) * d, r, r * 0.9, 6, 0.8, 60 + i * 9);
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
  }

  drawLivingFace(ctx) {
    // Bulge eyes proportional to panic (up to 2.2x scale)
    const bulge = 1.0 + this.panic * 1.25;
    const eyeSpacing = 36 * (1.0 + this.panic * 0.15);
    const eyeRadiusX = 16 * bulge;
    const eyeRadiusY = (19 + Math.sin(this.boilFrame) * 1.5) * bulge;

    const leftEyeX = -eyeSpacing;
    const rightEyeX = eyeSpacing;
    const eyeY = -12;

    // 1. Sketched eye loops
    // Outer sketchy fill
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    this.drawScribbleLoop(ctx, leftEyeX, eyeY, eyeRadiusX, eyeRadiusY, 8, 1.2 + this.panic * 2, 0);
    ctx.fill();
    this.drawScribbleLoop(ctx, rightEyeX, eyeY, eyeRadiusX, eyeRadiusY, 8, 1.2 + this.panic * 2, 23);
    ctx.fill();

    // Double sketch strokes for authentic hand-drawn scribble texture
    ctx.save();
    ctx.lineWidth = 2.0;
    ctx.strokeStyle = "#2b2b2b";
    this.drawScribbleLoop(ctx, leftEyeX, eyeY, eyeRadiusX * 0.95, eyeRadiusY * 0.95, 7, 1.5, 7);
    this.drawScribbleLoop(ctx, rightEyeX, eyeY, eyeRadiusX * 0.95, eyeRadiusY * 0.95, 7, 1.5, 31);
    ctx.restore();

    // 2. Looking pupils
    // When panicking, pupils pinpoint / shrink and dart frantically
    const pupilRadius = Math.max(3.0, (7.0 - this.panic * 4.0));
    let pupilOffsetX = this.gazeDirection.x * 8;
    let pupilOffsetY = this.gazeDirection.y * 8;

    if (this.panic > 0.2) {
      // Frantic darting
      pupilOffsetX += (Math.sin(this.boilFrame * 2.5) * 4) * this.panic;
      pupilOffsetY += (Math.cos(this.boilFrame * 3.1) * 4) * this.panic;
    }

    ctx.fillStyle = "#111111";
    this.drawScribbleLoop(ctx, leftEyeX + pupilOffsetX, eyeY + pupilOffsetY, pupilRadius, pupilRadius, 6, 0.8, 5);
    ctx.fill();
    this.drawScribbleLoop(ctx, rightEyeX + pupilOffsetX, eyeY + pupilOffsetY, pupilRadius, pupilRadius, 6, 0.8, 29);
    ctx.fill();

    // 3. Tiltable eyebrows (with asymmetric boil seed offset for authentic sketchiness)
    // Neutral: slight slope. Panicked: steeply arched upward in terror!
    const browY = eyeY - eyeRadiusY - 10;
    const browTilt = this.panic > 0.1 ? 0.65 * this.panic : 0.08;

    this.drawEyebrow(ctx, leftEyeX, browY, -browTilt, 1.0 + this.panic * 0.5, 0);
    this.drawEyebrow(ctx, rightEyeX, browY, browTilt, 1.0 + this.panic * 0.5, 17);

    // 4. Expressive mouth with reactive lip-sync flapping or screaming
    const mouthY = 28 + this.panic * 6;
    if (this.panic > 0.15) {
      // Panicked scream mouth: wide gaping trembling oval
      const mouthW = 22 + this.panic * 20;
      const mouthH = 16 + this.panic * 26;
      ctx.fillStyle = "#1e1e1e";
      this.drawScribbleLoop(ctx, 0, mouthY, mouthW, mouthH, 8, 2.0 + this.panic * 3, 11);
      ctx.fill();

      // Shaking tongue inside scream
      ctx.fillStyle = "#d33a3a";
      this.drawScribbleLoop(ctx, 0, mouthY + mouthH * 0.45, mouthW * 0.45, mouthH * 0.35, 6, 1.5, 19);
      ctx.fill();
    } else if (this.speaking) {
      // Opens as wide as the voice is loud, or flaps at ~6.5 Hz when there's no audio to follow
      const flap = this.mouthLevel ?? 0.5 + 0.5 * Math.sin(this.lipSyncPhase);
      const mouthW = 18 + flap * 6;
      const mouthH = 5 + flap * 14;

      ctx.fillStyle = "#222222";
      this.drawScribbleLoop(ctx, 0, mouthY, mouthW, mouthH, 8, 1.4, 13);
      ctx.fill();
    } else {
      // Calm resting scribble smile with line boil across entire stroke
      const b1 = this.getBoil(12);
      const b2 = this.getBoil(24);
      const b3 = this.getBoil(36);
      ctx.beginPath();
      ctx.moveTo(-18 + b1.dx, mouthY - 4 + b1.dy);
      ctx.quadraticCurveTo(b2.dx * 1.5, mouthY + 12 + b2.dy * 1.5, 18 + b3.dx, mouthY - 4 + b3.dy);
      ctx.stroke();
    }

    // 5. Sweat droplets when scared
    if (this.panic > 0.3) {
      this.drawSweatDrop(ctx, rightEyeX + eyeRadiusX + 8, browY - 6);
    }
  }

  drawEyebrow(ctx, cx, cy, tiltAngle, scaleFactor, seedOffset = 0) {
    const b = this.getBoil(Math.floor(cx) + seedOffset);
    const bMid = this.getBoil(Math.floor(cx + 11) + seedOffset);
    const len = 18 * scaleFactor;

    ctx.save();
    ctx.translate(cx + b.dx, cy + b.dy);
    ctx.rotate(tiltAngle);

    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.quadraticCurveTo(bMid.dx * 0.8, -5 * scaleFactor + bMid.dy * 0.8, len, 0);
    ctx.stroke();
    ctx.restore();
  }

  drawSweatDrop(ctx, x, y) {
    const b = this.getBoil(7);
    ctx.save();
    ctx.fillStyle = "#38bdf8";
    ctx.strokeStyle = "#0284c7";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(x + b.dx, y - 8 + b.dy);
    ctx.quadraticCurveTo(x + 7 + b.dx, y + 2 + b.dy, x + b.dx, y + 8 + b.dy);
    ctx.quadraticCurveTo(x - 7 + b.dx, y + 2 + b.dy, x + b.dx, y - 8 + b.dy);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /**
   * "X_X" Doodle face when dead
   */
  drawDeadFace(ctx) {
    const eyeSpacing = 36;
    const eyeY = -10;
    const crossSize = 14;

    // Crossed out "X" eyes with asymmetric boil seed offsets
    this.drawCrossEye(ctx, -eyeSpacing, eyeY, crossSize, 0);
    this.drawCrossEye(ctx, eyeSpacing, eyeY, crossSize, 19);

    // Limp squiggly dead mouth with sticking out tongue
    const mouthY = 32;
    const b1 = this.getBoil(9);
    const b2 = this.getBoil(18);
    ctx.beginPath();
    ctx.moveTo(-22 + b1.dx, mouthY + b1.dy);
    ctx.lineTo(-6 + b2.dx, mouthY + 2 + b1.dy);
    ctx.lineTo(6 + b1.dx, mouthY - 2 + b2.dy);
    ctx.lineTo(22 + b2.dx, mouthY + b2.dy);
    ctx.stroke();

    // Cartoon dead tongue
    const bt = this.getBoil(27);
    ctx.fillStyle = "#e11d48";
    ctx.beginPath();
    ctx.arc(6 + bt.dx, mouthY + 8 + bt.dy, 7, 0, Math.PI);
    ctx.fill();
    ctx.stroke();

    // Cartoon halo / spiral stars above head with line boil
    const bh = this.getBoil(33);
    ctx.font = "bold 15px monospace";
    ctx.fillStyle = "#666";
    ctx.textAlign = "center";
    ctx.fillText("X _ X", bh.dx, -42 + bh.dy);
  }

  drawCrossEye(ctx, cx, cy, size, seedOffset = 0) {
    const b1 = this.getBoil(Math.floor(cx) + seedOffset);
    const b2 = this.getBoil(Math.floor(cx + 6) + seedOffset);
    const b3 = this.getBoil(Math.floor(cx + 12) + seedOffset);
    const b4 = this.getBoil(Math.floor(cx + 18) + seedOffset);

    ctx.beginPath();
    ctx.moveTo(cx - size + b1.dx, cy - size + b1.dy);
    ctx.lineTo(cx + size + b2.dx, cy + size + b2.dy);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx + size + b3.dx, cy - size + b3.dy);
    ctx.lineTo(cx - size + b4.dx, cy + size + b4.dy);
    ctx.stroke();
  }
}
