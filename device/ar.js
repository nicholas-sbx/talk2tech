/**
 * talk2tech AR Module
 * 
 * Features:
 * - R1: WebXR Physical Surface Anchoring with Universal Three.js Fallback
 * - R2: Simplistic Scribble Drawing Aesthetics with 12 FPS Line Boil & Lip-Sync (~6.5 Hz)
 * - R3: Human Body Part Avoidance (Skin Locus Filtering & Comical "Nope!" Rejection)
 * - R4: Screen Edge Fear & Procedural Web Audio Screaming (450 Hz -> 1500 Hz) + Cartoon Death
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AR = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // =========================================================================
  // 1. Skin Locus Detection (R3)
  // =========================================================================
  class SkinDetector {
    /**
     * Determines whether a single RGB triplet falls within the human skin locus.
     * Evaluates in YCbCr color space along with normalized RGB chromaticity constraints
     * and hemoglobin red-excess criteria to reject wood, cardboard, and other brown inanimate surfaces.
     */
    static isSkinPixel(r, g, b) {
      if (r < 38 || g < 20 || b < 12) return false;

      // YCbCr conversion (ITU-R BT.601)
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

      // Primary YCbCr skin locus cluster
      const inYCbCr = cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;

      // Relative chromaticity checks across fair to dark skin tones
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sum = r + g + b;
      const normR = r / sum;
      const normG = g / sum;

      const normCheck = normR > 0.33 && normG > 0.22 && normR > normG && (normR + normG) <= 0.88;
      // Hemoglobin red-excess constraint: human skin exhibits r > g and (r - g) - (g - b) >= 4,
      // whereas inanimate wood, cardboard, and earth tones have yellowish hues where (r - g) <= (g - b).
      const rgbOrdering = (r >= g) && (g >= b || (r - b) > 15) && ((r - g) - (g - b) >= 4) && (max - min) > 15;

      return inYCbCr && normCheck && rgbOrdering;
    }

    /**
     * Samples a patch around (centerX, centerY) from an ImageData or CanvasRenderingContext2D
     * and calculates the fraction of skin pixels.
     */
    static sampleSkinRatio(source, centerX, centerY, radius = 12) {
      if (!source) return 0;

      let width = 0;
      let height = 0;

      if (source.data && source.width && source.height) {
        width = source.width;
        height = source.height;
        const x0 = Math.max(0, Math.floor(centerX - radius));
        const x1 = Math.min(width, Math.ceil(centerX + radius));
        const y0 = Math.max(0, Math.floor(centerY - radius));
        const y1 = Math.min(height, Math.ceil(centerY + radius));
        const w = x1 - x0;
        const h = y1 - y0;
        if (w <= 0 || h <= 0) return 0;

        const data = source.data;
        let skinCount = 0;
        let totalCount = 0;

        for (let py = y0; py < y0 + h; py++) {
          for (let px = x0; px < x0 + w; px++) {
            const idx = (py * width + px) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const a = data[idx + 3];

            if (a > 30) {
              totalCount++;
              if (SkinDetector.isSkinPixel(r, g, b)) {
                skinCount++;
              }
            }
          }
        }
        return totalCount > 0 ? skinCount / totalCount : 0;
      } else if (source.getImageData && source.canvas) {
        width = source.canvas.width;
        height = source.canvas.height;
        const x0 = Math.max(0, Math.floor(centerX - radius));
        const x1 = Math.min(width, Math.ceil(centerX + radius));
        const y0 = Math.max(0, Math.floor(centerY - radius));
        const y1 = Math.min(height, Math.ceil(centerY + radius));
        const w = x1 - x0;
        const h = y1 - y0;
        if (w <= 0 || h <= 0) return 0;
        const imgData = source.getImageData(x0, y0, w, h);
        if (!imgData || !imgData.data.length) return 0;

        const data = imgData.data;
        let skinCount = 0;
        let totalCount = 0;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];

          if (a > 30) {
            totalCount++;
            if (SkinDetector.isSkinPixel(r, g, b)) {
              skinCount++;
            }
          }
        }
        return totalCount > 0 ? skinCount / totalCount : 0;
      }

      return 0;
    }

    /**
     * Rejection check: returns true if human skin is detected (> threshold).
     */
    static isSkinArea(source, centerX, centerY, radius = 12, threshold = 0.35) {
      const ratio = SkinDetector.sampleSkinRatio(source, centerX, centerY, radius);
      return ratio >= threshold;
    }
  }

  // =========================================================================
  // 2. Edge Fear System (R4)
  // =========================================================================
  class EdgeFearSystem {
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
  class ProceduralAudio {
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

    /**
     * Comical "Nope!" rejection sound: a cartoon squawk / boing
     */
    triggerNopeSound() {
      if (!this.ensureContext()) return;
      const now = this.ctx.currentTime;

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = "square";
      osc.frequency.setValueAtTime(320, now);
      osc.frequency.exponentialRampToValueAtTime(160, now + 0.12);
      osc.frequency.setValueAtTime(240, now + 0.13);
      osc.frequency.exponentialRampToValueAtTime(140, now + 0.26);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

      const filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(900, now);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain || this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.3);
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
  class ScribbleFace {
    constructor() {
      this.boilFPS = 12;
      this.boilInterval = 1000 / this.boilFPS; // ~83.33ms
      this.lastBoilTime = 0;
      this.boilFrame = 0; // 0, 1, 2, 3 cycle

      // Emotion / Animation state
      this.panic = 0; // 0.0 to 1.0
      this.speaking = false;
      this.lipSyncPhase = 0;
      this.isDead = false;
      this.gazeDirection = { x: 0, y: 0 }; // Looking direction

      // Comical "Nope!" rejection reaction state
      this.nopeState = null; // { x, y, startTime, duration }

      // Pre-cached scribble jitter tables for deterministic 12 FPS boil
      this.boilTables = this.generateBoilTables();
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

    triggerNope(x, y) {
      this.nopeState = {
        x,
        y,
        startTime: performance.now(),
        duration: 1300,
      };
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
        ctx.scale(scale, scale);

        // Line style: hand-drawn sketchy ink
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = "#141414";
        ctx.fillStyle = "#ffffff";

        if (this.isDead) {
          this.drawDeadFace(ctx);
        } else {
          this.drawLivingFace(ctx);
        }

        ctx.restore();
      }

      // Draw comical "Nope!" rejection pop if active
      if (this.nopeState) {
        const elapsed = now - this.nopeState.startTime;
        if (elapsed < this.nopeState.duration) {
          const alpha = 1.0 - Math.pow(elapsed / this.nopeState.duration, 2);
          this.drawNopeReaction(ctx, this.nopeState.x, this.nopeState.y, alpha, elapsed);
        } else {
          this.nopeState = null;
        }
      }
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
      let pupilOffsetX = this.gazeDirection.x * 6;
      let pupilOffsetY = this.gazeDirection.y * 6;

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
        // Reactive lip-sync flapping during spoken reply (~6.5 Hz)
        const flap = 0.5 + 0.5 * Math.sin(this.lipSyncPhase);
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

    /**
     * Comical "Nope!" rejection pop animation
     */
    drawNopeReaction(ctx, x, y, alpha, elapsed) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

      // Head shake oscillation
      const shake = Math.sin(elapsed / 35) * 12 * Math.exp(-elapsed / 800);
      const rx = x + shake;
      const ry = y - 30;

      // Speech bubble
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#111111";
      ctx.lineWidth = 3.0;

      const bubbleW = 100;
      const bubbleH = 46;
      const bx = rx - bubbleW / 2;
      const by = ry - bubbleH - 20;

      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(bx, by, bubbleW, bubbleH, 12);
      } else {
        ctx.rect(bx, by, bubbleW, bubbleH);
      }
      ctx.fill();
      ctx.stroke();

      // Bubble tail pointing down
      ctx.beginPath();
      ctx.moveTo(rx - 8, by + bubbleH);
      ctx.lineTo(rx, by + bubbleH + 12);
      ctx.lineTo(rx + 8, by + bubbleH);
      ctx.fill();
      ctx.stroke();

      // "Nope!" text
      ctx.font = "bold 20px 'Geist', system-ui, sans-serif";
      ctx.fillStyle = "#e11d48";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Nope!", rx, by + bubbleH / 2);

      // Annoyed / skeptical doodle face under bubble with 12 FPS line boil
      ctx.strokeStyle = "#111111";
      ctx.lineWidth = 2.5;

      const be1 = this.getBoil(3);
      const be2 = this.getBoil(15);
      const bb1 = this.getBoil(7);
      const bb2 = this.getBoil(23);
      const bm1 = this.getBoil(11);
      const bm2 = this.getBoil(29);
      const bmMid = this.getBoil(19);

      // Annoyed horizontal slit eyes with sketch boil
      ctx.beginPath();
      ctx.moveTo(rx - 16 + be1.dx, ry + be1.dy);
      ctx.lineTo(rx - 6 + be1.dx, ry + be1.dy);
      ctx.moveTo(rx + 6 + be2.dx, ry + be2.dy);
      ctx.lineTo(rx + 16 + be2.dx, ry + be2.dy);
      ctx.stroke();

      // Annoyed cocked eyebrows with sketch boil
      ctx.beginPath();
      ctx.moveTo(rx - 18 + bb1.dx, ry - 6 + bb1.dy);
      ctx.lineTo(rx - 4 + bb1.dx, ry - 10 + bb1.dy);
      ctx.moveTo(rx + 4 + bb2.dx, ry - 6 + bb2.dy);
      ctx.lineTo(rx + 18 + bb2.dx, ry - 4 + bb2.dy);
      ctx.stroke();

      // Squiggly skeptical mouth with authentic hand-drawn curve
      ctx.beginPath();
      ctx.moveTo(rx - 10 + bm1.dx, ry + 12 + bm1.dy);
      ctx.quadraticCurveTo(rx + bmMid.dx * 1.2, ry + 15 + bmMid.dy * 1.2, rx + 10 + bm2.dx, ry + 11 + bm2.dy);
      ctx.stroke();

      ctx.restore();
    }
  }

  // =========================================================================
  // 5. AR Manager & Universal Surface Anchoring (R1, R2, R3, R4)
  // =========================================================================
  class ARManager {
    constructor(canvas, videoElement, audioContext = null) {
      this.canvas = canvas;
      this.ctx = canvas ? canvas.getContext("2d") : null;
      this.video = videoElement;

      this.audio = new ProceduralAudio(audioContext);
      this.face = new ScribbleFace();

      // Anchoring & Tracking state
      this.isAnchored = false;
      this.isDead = false;
      this.persona = null;

      // 3D Anchor coordinates in world/camera space
      this.anchorWorldPos = { x: 0, y: 0, z: -1.2 };
      this.screenPos = { x: 0, y: 0, u: 0.5, v: 0.5 };
      this.currentPanic = 0;

      // WebXR State
      this.xrSession = null;
      this.xrRefSpace = null;
      this.xrHitTestSource = null;
      this.xrAnchor = null;
      this.lastHitTestResults = null;
      this.mode = "fallback"; // 'webxr' | 'fallback'

      // Three.js universal fallback camera & projection
      this.threeCamera = null;
      this.threeScene = null;
      this.initThreeFallback();

      // Device gyro & interactive pan tracking
      this.baseOrientation = null;
      this.panAngleX = 0;
      this.panAngleY = 0;
      this.gyroPitch = 0;
      this.gyroRoll = 0;

      // Touch / pointer tracking state (single active pointer to prevent multi-touch scrambling)
      this.activePointerId = null;
      this.isDragging = false;
      this.dragStart = { x: 0, y: 0 };
      this.dragDistance = 0;

      // Cached sample canvas to avoid DOM thrashing during skin locus checks
      this._sampleCanvas = null;
      this._sampleCtx = null;

      this.setupListeners();

      // Animation loop
      this.animFrameId = null;
      this.isRunning = false;
    }

    initThreeFallback() {
      if (typeof window !== "undefined" && window.THREE) {
        const THREE = window.THREE;
        const w = this.canvas ? this.canvas.width || 640 : 640;
        const h = this.canvas ? this.canvas.height || 480 : 480;
        this.threeCamera = new THREE.PerspectiveCamera(60, w / h, 0.01, 100);
        this.threeCamera.position.set(0, 0, 0);
        this.threeScene = new THREE.Scene();
      }
    }

    setupListeners() {
      if (typeof window === "undefined") return;

      window.addEventListener("deviceorientation", (ev) => {
        if (ev.beta !== null) {
          if (!this.baseOrientation) {
            this.baseOrientation = { beta: ev.beta, gamma: ev.gamma || 0 };
          }
          // Beta is pitch (tilt front/back, rotation around X axis)
          // Gamma is roll (tilt left/right, rotation around Y axis)
          this.gyroPitch = (ev.beta - this.baseOrientation.beta) * (Math.PI / 180);
          this.gyroRoll = ((ev.gamma || 0) - this.baseOrientation.gamma) * (Math.PI / 180);
        }
      });

      if (this.canvas) {
        this.canvas.addEventListener("pointerdown", (ev) => {
          // Reject secondary fingers to prevent multi-touch jumping
          if (this.activePointerId !== null) return;

          this.activePointerId = ev.pointerId;
          try {
            this.canvas.setPointerCapture?.(ev.pointerId);
          } catch (e) {}

          this.isDragging = true;
          this.dragStart = { x: ev.clientX, y: ev.clientY };
          this.dragDistance = 0;
        });

        window.addEventListener("pointermove", (ev) => {
          if (!this.isDragging || ev.pointerId !== this.activePointerId) return;

          const dx = ev.clientX - this.dragStart.x;
          const dy = ev.clientY - this.dragStart.y;
          this.dragDistance += Math.hypot(dx, dy);
          this.dragStart = { x: ev.clientX, y: ev.clientY };

          // Pan camera angle
          const rect = this.canvas.getBoundingClientRect();
          const w = rect.width || this.canvas.width || 640;
          const h = rect.height || this.canvas.height || 480;
          this.panAngleX += (dx / w) * 1.6;
          this.panAngleY -= (dy / h) * 1.6;
        });

        const handlePointerEnd = (ev) => {
          if (ev.pointerId !== this.activePointerId) return;

          try {
            this.canvas.releasePointerCapture?.(ev.pointerId);
          } catch (e) {}

          const wasDragging = this.isDragging;
          const dist = this.dragDistance;

          this.isDragging = false;
          this.activePointerId = null;

          if (wasDragging && dist < 10 && ev.type !== "pointercancel") {
            this.handleTap(ev);
          }
        };

        window.addEventListener("pointerup", handlePointerEnd);
        window.addEventListener("pointercancel", handlePointerEnd);
      }
    }

    /**
     * Start WebXR session with dom-overlay and hit-test if supported,
     * otherwise seamlessly fall back to overlay canvas projection.
     */
    async start() {
      this.isRunning = true;

      let xrSupported = false;
      if (typeof navigator !== "undefined" && navigator.xr && navigator.xr.isSessionSupported) {
        try {
          xrSupported = await navigator.xr.isSessionSupported("immersive-ar");
        } catch (e) {
          xrSupported = false;
        }
      }

      if (xrSupported) {
        try {
          const sessionInit = {
            optionalFeatures: ["hit-test", "anchors", "dom-overlay"],
            domOverlay: { root: document.body },
          };
          this.xrSession = await navigator.xr.requestSession("immersive-ar", sessionInit);
          this.mode = "webxr";

          // Optional WebGL baseLayer setup for immersive sessions
          try {
            const glCanvas = document.createElement("canvas");
            const gl = glCanvas.getContext("webgl", { xrCompatible: true });
            if (gl && window.XRWebGLLayer) {
              await gl.makeXRCompatible?.();
              this.xrSession.updateRenderState({
                baseLayer: new window.XRWebGLLayer(this.xrSession, gl),
              });
            }
          } catch (glErr) {
            // Some platforms render dom-overlay without explicit GL layer
          }

          this.xrRefSpace = await this.xrSession.requestReferenceSpace("local").catch(() =>
            this.xrSession.requestReferenceSpace("viewer")
          );

          try {
            const viewerSpace = await this.xrSession.requestReferenceSpace("viewer");
            if (this.xrSession.requestHitTestSource) {
              this.xrHitTestSource = await this.xrSession.requestHitTestSource({ space: viewerSpace });
            }
          } catch (hitErr) {
            console.warn("Hit-test source creation error:", hitErr);
          }

          this.xrSession.addEventListener("end", () => {
            this.mode = "fallback";
            this.xrSession = null;
            if (this.isRunning) this.startFallbackLoop();
          });

          this.xrSession.requestAnimationFrame((time, frame) => this.onXRFrame(time, frame));
          return "webxr";
        } catch (err) {
          console.warn("WebXR request failed, falling back to overlay canvas:", err);
          this.mode = "fallback";
        }
      } else {
        this.mode = "fallback";
      }

      // Universal fallback animation loop
      this.startFallbackLoop();
      return this.mode;
    }

    startFallbackLoop() {
      const loop = (now) => {
        if (!this.isRunning) return;
        this.renderFallbackFrame(now);
        this.animFrameId = requestAnimationFrame(loop);
      };
      this.animFrameId = requestAnimationFrame(loop);
    }

    stop() {
      this.isRunning = false;
      if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
      if (this.xrSession) {
        this.xrSession.end().catch(() => {});
        this.xrSession = null;
      }
      this.audio.reset();
    }

    /**
     * Projects 3D position to 2D screen coordinates using Three.js or standard perspective math
     */
    projectToScreen(worldPos, canvasWidth, canvasHeight) {
      const totalRotY = -(this.panAngleX + this.gyroRoll);
      const totalRotX = -(this.panAngleY + this.gyroPitch);

      if (this.threeCamera && window.THREE) {
        const THREE = window.THREE;
        const aspect = canvasWidth / canvasHeight;
        if (Math.abs(this.threeCamera.aspect - aspect) > 0.001) {
          this.threeCamera.aspect = aspect;
          this.threeCamera.updateProjectionMatrix();
        }
        this.threeCamera.rotation.set(totalRotX, totalRotY, 0, "YXZ");
        this.threeCamera.updateMatrixWorld(true);

        const vCam = new THREE.Vector3(worldPos.x, worldPos.y, worldPos.z);
        vCam.applyMatrix4(this.threeCamera.matrixWorldInverse);
        const isBehind = vCam.z >= -0.05;

        const v = new THREE.Vector3(worldPos.x, worldPos.y, worldPos.z);
        v.project(this.threeCamera);

        const u = isBehind ? -2.0 : (v.x * 0.5) + 0.5;
        const vNorm = isBehind ? -2.0 : (-v.y * 0.5) + 0.5;

        return {
          x: isBehind ? -999 : u * canvasWidth,
          y: isBehind ? -999 : vNorm * canvasHeight,
          u: u,
          v: vNorm,
          behind: isBehind,
        };
      }

      // Mathematical perspective rotation fallback matching Three.js YXZ camera inverse
      const cosY = Math.cos(totalRotY);
      const sinY = Math.sin(totalRotY);
      const cosX = Math.cos(totalRotX);
      const sinX = Math.sin(totalRotX);

      // Inverse rotation around Y (by -totalRotY)
      const rx = worldPos.x * cosY - worldPos.z * sinY;
      const ry0 = worldPos.y;
      const rz0 = worldPos.x * sinY + worldPos.z * cosY;

      // Inverse rotation around X (by -totalRotX)
      const xCam = rx;
      const yCam = ry0 * cosX + rz0 * sinX;
      const zCam = -ry0 * sinX + rz0 * cosX;

      const isBehind = zCam >= -0.05;
      if (isBehind) {
        return {
          x: -999,
          y: -999,
          u: -2.0,
          v: -2.0,
          behind: true,
        };
      }

      const fov = 60 * (Math.PI / 180);
      const aspect = canvasWidth / canvasHeight;
      const f = 1.0 / Math.tan(fov / 2);

      const z = Math.abs(zCam) < 0.001 ? -0.001 : zCam;
      const ndcX = (xCam * f / aspect) / -z;
      const ndcY = (yCam * f) / -z;

      const u = (ndcX * 0.5) + 0.5;
      const vNorm = (-ndcY * 0.5) + 0.5;

      return {
        x: u * canvasWidth,
        y: vNorm * canvasHeight,
        u: u,
        v: vNorm,
        behind: false,
      };
    }

    /**
     * Unprojects screen touch (u, v) into a 3D camera-space anchor point
     */
    unprojectFromScreen(u, v, targetDepth = -1.2) {
      const ndcX = (u - 0.5) * 2;
      const ndcY = -(v - 0.5) * 2;

      const canvasWidth = this.canvas ? this.canvas.width : 640;
      const canvasHeight = this.canvas ? this.canvas.height : 480;
      const aspect = canvasWidth / canvasHeight;

      const totalRotY = -(this.panAngleX + this.gyroRoll);
      const totalRotX = -(this.panAngleY + this.gyroPitch);

      // WebXR Mode unprojection using lastXRView
      if (this.mode === "webxr" && this.lastXRView && window.THREE) {
        const THREE = window.THREE;
        const proj = this.lastXRView.projectionMatrix;
        const fFallback = 1.0 / Math.tan((60 * Math.PI / 180) / 2);
        const fx = (proj && proj[0]) ? proj[0] : fFallback / aspect;
        const fy = (proj && proj[5]) ? proj[5] : fFallback;
        const camX = (ndcX * -targetDepth) / fx;
        const camY = (ndcY * -targetDepth) / fy;
        const p = new THREE.Vector3(camX, camY, targetDepth);
        const m = new THREE.Matrix4();
        m.fromArray(this.lastXRView.transform.matrix);
        p.applyMatrix4(m);
        return { x: p.x, y: p.y, z: p.z };
      }

      // Three.js universal fallback unprojection
      if (this.threeCamera && window.THREE) {
        const THREE = window.THREE;
        if (Math.abs(this.threeCamera.aspect - aspect) > 0.001) {
          this.threeCamera.aspect = aspect;
          this.threeCamera.updateProjectionMatrix();
        }
        this.threeCamera.rotation.set(totalRotX, totalRotY, 0, "YXZ");
        this.threeCamera.updateMatrixWorld(true);

        const fov = (this.threeCamera.fov || 60) * (Math.PI / 180);
        const f = 1.0 / Math.tan(fov / 2);
        const camX = (ndcX * -targetDepth * aspect) / f;
        const camY = (ndcY * -targetDepth) / f;
        const p = new THREE.Vector3(camX, camY, targetDepth);
        p.applyMatrix4(this.threeCamera.matrixWorld);
        return { x: p.x, y: p.y, z: p.z };
      }

      // Mathematical perspective rotation fallback with camera-to-world rotation
      const fov = 60 * (Math.PI / 180);
      const f = 1.0 / Math.tan(fov / 2);
      const camX = (ndcX * -targetDepth * aspect) / f;
      const camY = (ndcY * -targetDepth) / f;
      const camZ = targetDepth;

      const cosY = Math.cos(totalRotY);
      const sinY = Math.sin(totalRotY);
      const cosX = Math.cos(totalRotX);
      const sinX = Math.sin(totalRotX);

      // Rotation around X (by +totalRotX)
      const x1 = camX;
      const y1 = camY * cosX - camZ * sinX;
      const z1 = camY * sinX + camZ * cosX;

      // Rotation around Y (by +totalRotY)
      const rx_world = x1 * cosY + z1 * sinY;
      const ry_world = y1;
      const rz_world = -x1 * sinY + z1 * cosY;

      return { x: rx_world, y: ry_world, z: rz_world };
    }

    /**
     * Handle user tap on screen/canvas:
     * - Check skin locus filtering
     * - If skin detected: reject with comical "Nope!"
     * - If inanimate object: anchor face
     */
    handleTap(ev) {
      if (!this.canvas) return;

      const rect = this.canvas.getBoundingClientRect();
      const clientX = ev.clientX - rect.left;
      const clientY = ev.clientY - rect.top;

      const u = Math.max(0, Math.min(1, clientX / (rect.width || 1)));
      const v = Math.max(0, Math.min(1, clientY / (rect.height || 1)));

      const canvasX = u * this.canvas.width;
      const canvasY = v * this.canvas.height;

      // Sample pixel buffer from video to detect skin
      const isSkin = this.checkSkinAt(clientX, clientY, rect.width, rect.height);

      if (isSkin) {
        // R3: Rejection on human skin
        this.face.triggerNope(canvasX, canvasY);
        this.audio.triggerNopeSound();
        return;
      }

      // Anchor to physical object surface
      this.anchorAt(u, v);
    }

    /**
     * Checks skin locus at screen pixel (x, y) taking CSS object-fit: cover into account.
     */
    checkSkinAt(x, y, displayW = null, displayH = null) {
      if (this.video && this.video.videoWidth > 0 && this.video.videoHeight > 0) {
        try {
          if (!this._sampleCanvas) {
            this._sampleCanvas = document.createElement("canvas");
            this._sampleCanvas.width = 32;
            this._sampleCanvas.height = 32;
            this._sampleCtx = this._sampleCanvas.getContext("2d", { willReadFrequently: true });
          }

          const sCtx = this._sampleCtx;
          const vWidth = this.video.videoWidth;
          const vHeight = this.video.videoHeight;
          const screenW = displayW || (this.canvas ? this.canvas.clientWidth || this.canvas.width : 640);
          const screenH = displayH || (this.canvas ? this.canvas.clientHeight || this.canvas.height : 480);

          // CSS object-fit: cover coordinate transformation
          const videoAspect = vWidth / vHeight;
          const screenAspect = screenW / screenH;

          let vidX, vidY;
          if (screenAspect > videoAspect) {
            // Screen is wider than video: cropped vertically
            const scale = screenW / vWidth;
            const scaledH = vHeight * scale;
            const cropOffsetY = (scaledH - screenH) / 2;
            vidX = x / scale;
            vidY = (y + cropOffsetY) / scale;
          } else {
            // Screen is taller than video (portrait mobile): cropped horizontally
            const scale = screenH / vHeight;
            const scaledW = vWidth * scale;
            const cropOffsetX = (scaledW - screenW) / 2;
            vidX = (x + cropOffsetX) / scale;
            vidY = y / scale;
          }

          // Clamp sample bounding box so drawImage never exceeds video buffer boundaries
          const patch = 32;
          const actualPatchW = Math.min(patch, vWidth);
          const actualPatchH = Math.min(patch, vHeight);
          const sx = Math.max(0, Math.min(vWidth - actualPatchW, Math.floor(vidX - actualPatchW / 2)));
          const sy = Math.max(0, Math.min(vHeight - actualPatchH, Math.floor(vidY - actualPatchH / 2)));

          sCtx.clearRect(0, 0, patch, patch);
          sCtx.drawImage(this.video, sx, sy, actualPatchW, actualPatchH, 0, 0, actualPatchW, actualPatchH);

          return SkinDetector.isSkinArea(sCtx, actualPatchW / 2, actualPatchH / 2, 12, 0.35);
        } catch (e) {
          // Security / tainted canvas fallback
        }
      }

      if (this.ctx) {
        return SkinDetector.isSkinArea(this.ctx, x, y, 12, 0.35);
      }

      return false;
    }

    anchorAt(u, v) {
      if (this.mode === "webxr" && this.lastHitTestResults && this.lastHitTestResults.length > 0) {
        const hit = this.lastHitTestResults[0];
        const hitPose = hit.getPose(this.xrRefSpace);
        if (hitPose) {
          this.anchorWorldPos = {
            x: hitPose.transform.position.x,
            y: hitPose.transform.position.y,
            z: hitPose.transform.position.z,
          };
          if (hit.createAnchor) {
            hit.createAnchor().then((anchor) => {
              this.xrAnchor = anchor;
            }).catch(() => {});
          }
        } else {
          this.anchorWorldPos = this.unprojectFromScreen(u, v);
        }
      } else {
        this.anchorWorldPos = this.unprojectFromScreen(u, v);
      }

      this.isAnchored = true;
      this.isDead = false;
      this.face.isDead = false;
      this.audio.reset();
    }

    setSpeaking(speaking) {
      this.face.speaking = Boolean(speaking);
    }

    setPersona(persona) {
      this.persona = persona;
      if (!this.isAnchored || this.isDead) {
        this.isDead = false;
        this.face.isDead = false;
        // Auto-anchor to center if not manually anchored yet or dead
        this.anchorAt(0.5, 0.45);
      }
    }

    reset() {
      this.isAnchored = false;
      this.isDead = false;
      this.face.isDead = false;
      this.face.speaking = false;
      this.audio.reset();
      this.currentPanic = 0;
      this.xrAnchor = null;
    }

    /**
     * WebXR Frame callback
     */
    onXRFrame(time, frame) {
      if (!this.xrSession || !this.isRunning) return;

      const session = frame.session;
      session.requestAnimationFrame((t, f) => this.onXRFrame(t, f));

      // 1. Hit-test polling
      if (this.xrHitTestSource) {
        this.lastHitTestResults = frame.getHitTestResults(this.xrHitTestSource);
      }

      // 2. Track anchor if available
      if (this.xrAnchor && frame.getPose) {
        const anchorPose = frame.getPose(this.xrAnchor.anchorSpace, this.xrRefSpace);
        if (anchorPose) {
          this.anchorWorldPos = {
            x: anchorPose.transform.position.x,
            y: anchorPose.transform.position.y,
            z: anchorPose.transform.position.z,
          };
        }
      }

      // 3. Query viewer camera pose
      const pose = frame.getViewerPose(this.xrRefSpace);
      if (pose && pose.views && pose.views.length > 0) {
        this.lastXRView = pose.views[0];
        this.renderXRFrame(time, frame, pose.views[0]);
      } else {
        this.renderFallbackFrame(time);
      }
    }

    /**
     * Renders AR frame with WebXR camera projection
     */
    renderXRFrame(now, frame, view) {
      if (!this.canvas || !this.ctx) return;

      const w = this.canvas.width;
      const h = this.canvas.height;
      this.ctx.clearRect(0, 0, w, h);

      if (!this.isAnchored) {
        if (this.face.nopeState) {
          this.face.draw(this.ctx, 0, 0, 1.0, now, false);
        }
        return;
      }

      // Project world position via WebXR view matrix & projection matrix
      const proj = this.projectXRView(this.anchorWorldPos, view, w, h);
      this.screenPos = proj;

      this.processEdgeFearAndRender(now, proj.u, proj.v, proj.x, proj.y, w, h, proj.behind);
    }

    projectXRView(worldPos, view, canvasWidth, canvasHeight) {
      if (window.THREE && this.threeCamera) {
        const THREE = window.THREE;
        const cam = new THREE.Camera();
        cam.matrixWorldInverse.fromArray(view.transform.inverse.matrix);
        cam.projectionMatrix.fromArray(view.projectionMatrix);

        const v = new THREE.Vector3(worldPos.x, worldPos.y, worldPos.z);
        v.applyMatrix4(cam.matrixWorldInverse);
        const isBehind = v.z >= -0.05;
        v.applyMatrix4(cam.projectionMatrix);

        const u = isBehind ? -2.0 : (v.x * 0.5) + 0.5;
        const vNorm = isBehind ? -2.0 : (-v.y * 0.5) + 0.5;

        return {
          x: isBehind ? -999 : u * canvasWidth,
          y: isBehind ? -999 : vNorm * canvasHeight,
          u: u,
          v: vNorm,
          behind: isBehind,
        };
      }

      return this.projectToScreen(worldPos, canvasWidth, canvasHeight);
    }

    processEdgeFearAndRender(now, u, v, screenX, screenY, w, h, behind = false) {
      // Compute edge fear
      const { d } = EdgeFearSystem.computeEdgeDistances(u, v);
      const offscreen = EdgeFearSystem.isOffscreen(u, v, 0.05, behind);

      if (offscreen && !this.isDead) {
        // R4: Cartoon Death Sequence if lost offscreen!
        this.isDead = true;
        this.face.isDead = true;
        this.audio.triggerDeathSequence(() => {
          // Death complete
        });
      } else if (!this.isDead) {
        this.currentPanic = EdgeFearSystem.computePanic(d);
        this.face.panic = this.currentPanic;

        // Eye gaze looks terrified toward the threatening edge
        const nearest = EdgeFearSystem.getNearestEdge(u, v);
        if (nearest === "left") this.face.gazeDirection = { x: -1, y: 0 };
        else if (nearest === "right") this.face.gazeDirection = { x: 1, y: 0 };
        else if (nearest === "top") this.face.gazeDirection = { x: 0, y: -1 };
        else this.face.gazeDirection = { x: 0, y: 1 };

        // Audio pitch-sliding scream: 450 Hz -> 1500 Hz
        this.audio.updatePanic(this.currentPanic);
      }

      // Suppress drawing face if point is behind camera (prevents phantom doodle at (40, 40))
      let drawX = screenX;
      let drawY = screenY;
      const shouldDrawFace = !behind;
      if (this.isDead) {
        drawX = Math.max(40, Math.min(w - 40, drawX));
        drawY = Math.max(40, Math.min(h - 40, drawY));
      }

      // Draw scribble doodle face with 12 FPS line boil
      this.face.draw(this.ctx, drawX, drawY, 1.0, now, shouldDrawFace);
    }

    /**
     * Fallback render loop frame
     */
    renderFallbackFrame(now = performance.now()) {
      if (!this.canvas || !this.ctx) return;

      const w = this.canvas.width;
      const h = this.canvas.height;
      this.ctx.clearRect(0, 0, w, h);

      if (!this.isAnchored) {
        if (this.face.nopeState) {
          this.face.draw(this.ctx, 0, 0, 1.0, now, false);
        }
        return;
      }

      // Compute projected screen position
      this.screenPos = this.projectToScreen(this.anchorWorldPos, w, h);
      this.processEdgeFearAndRender(now, this.screenPos.u, this.screenPos.v, this.screenPos.x, this.screenPos.y, w, h, this.screenPos.behind);
    }
  }

  return {
    SkinDetector,
    EdgeFearSystem,
    ProceduralAudio,
    ScribbleFace,
    ARManager,
    instance: null,
    init: function (canvas, video, audioContext) {
      this.instance = new ARManager(canvas, video, audioContext);
      return this.instance;
    },
  };
});
