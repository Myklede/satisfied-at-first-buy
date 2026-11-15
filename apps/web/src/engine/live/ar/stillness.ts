// Stillness lock for the AR overlay (agent V2; the user, 2026-11-13: "when I stand still the jacket
// keeps moving: a slight rotation, swaying, tiny jitter; even a little reads as fake"). Pure.
//
// A person standing "still" sways a few px and MediaPipe adds 1–3 px of noise (lab A/B: a hard
// hold with a noise-sized deadband engaged on only 5 % of cam-parka's still window, and each
// release would be a visible step). So the lock does not freeze: while the person is slow it
// runs the overlay's outputs through a heavy One Euro (STILLNESS.output: low min-cutoff, a beta
// that lets a real drift through with little lag) and passes them live as soon as they move.
// Engage: the filtered landmark speed stayed under `engageSpeed` for `engageMs`. Release: at
// once when it exceeds `releaseSpeed`, or a raw landmark jumps more than fastK × noise RMS +
// fastFloorPx in one frame; the output then eases to live over `easeMs` (half on the release
// frame: onset lag ≤ 1 frame). The live pipeline keeps running underneath.
import { OneEuroFilter, OneEuroVecFilter } from '@satisfy/vision';

type OneEuro = { minCutoff: number; beta: number; dCutoff: number };

export interface StillnessParams {
  /** Landmark indices watched (shoulders, elbows, wrists, hips, nose). */
  landmarks: readonly number[];
  /** Engage after the speed stayed under engageSpeed for this long, ms. */
  engageMs: number;
  /**
   * Filtered landmark speed (max over the watched ones), px/s at a 200 px shoulder span, measured
   * over the last speedWindowMs (one frame's filtered noise would read as speed).
   */
  engageSpeed: number;
  speedWindowMs: number;
  releaseSpeed: number;
  /** A raw one-frame landmark step beyond fastK × noise RMS + fastFloorPx releases at once. */
  fastK: number;
  fastFloorPx: number;
  /** Ease from the held output to live after a release, ms. */
  easeMs: number;
  /** Noise RMS (EMA of raw − filtered while slow), ms; initial px. */
  noiseTauMs: number;
  noiseInitialPx: number;
  /** One Euro for the watched landmarks (speed estimate). */
  smooth: OneEuro;
  /** Below this visibility a landmark is ignored. */
  minVisibility: number;
  /** One Euro applied to the overlay's outputs while engaged, per unit. */
  output: { px: OneEuro; deg: OneEuro; mm: OneEuro };
}

type Pt = { x: number; y: number; visibility: number };

export interface StillnessState {
  /** True while the outputs are being held (heavily filtered). */
  engaged: boolean;
  /** 1 = the held output, 0 = live; between = easing after a release. */
  hold: number;
  /** Frames since the lock engaged (0 when not engaged). */
  heldFrames: number;
  /** Why the last release happened (lab readout). */
  lastRelease: 'speed' | 'fast' | 'lost' | null;
  /** The filtered landmark speed this frame, px/s at a 200 px span (lab readout). */
  speed: number;
}

export class StillnessLock {
  private filter: OneEuroVecFilter;
  private noise2: Float64Array;
  private lastF?: Float64Array;
  private lastRaw?: Float64Array;
  private history: { t: number; f: Float64Array }[] = [];
  private lastT?: number;
  private slowSince?: number;
  private releasedAt?: number;
  state: StillnessState = { engaged: false, hold: 0, heldFrames: 0, lastRelease: null, speed: 0 };

  constructor(readonly params: StillnessParams) {
    this.filter = new OneEuroVecFilter(params.landmarks.length * 2, params.smooth);
    this.noise2 = new Float64Array(params.landmarks.length).fill(params.noiseInitialPx ** 2);
  }

  reset() {
    this.filter.reset();
    this.lastF = this.lastRaw = undefined;
    this.history = [];
    this.lastT = this.slowSince = this.releasedAt = undefined;
    this.state = { engaged: false, hold: 0, heldFrames: 0, lastRelease: null, speed: 0 };
  }

  /** Noise RMS per watched landmark, px (lab readout). */
  noiseRmsPx(): number[] {
    return Array.from(this.noise2, (v) => Math.sqrt(v));
  }

  /** One frame. `span` = the image shoulder span in px (scales the thresholds). */
  update(t: number, landmarks: readonly Pt[] | null, span: number): StillnessState {
    const P = this.params;
    if (this.lastT !== undefined && t === this.lastT) return this.state;
    const dt = this.lastT === undefined ? 33 : Math.max(1, t - this.lastT);
    this.lastT = t;
    const n = P.landmarks.length;
    const seen = landmarks
      ? P.landmarks.map((i) => (landmarks[i]?.visibility ?? 0) >= P.minVisibility)
      : [];
    if (!landmarks || seen.filter(Boolean).length < Math.min(4, n)) {
      this.release(t, 'lost');
      this.lastF = this.lastRaw = undefined;
      this.history = [];
      this.slowSince = undefined;
      return this.ease(t);
    }
    const raw = new Float64Array(n * 2);
    P.landmarks.forEach((i, k) => {
      raw[k * 2] = landmarks[i].x;
      raw[k * 2 + 1] = landmarks[i].y;
    });
    const f = Float64Array.from(this.filter.filter(Array.from(raw), t));
    const scale = Math.max(0.25, span / 200);
    let speed = 0,
      fast = false;
    // Windowed speed: the displacement since the oldest frame within speedWindowMs.
    this.history.push({ t, f });
    while (this.history.length > 1 && t - this.history[1].t >= P.speedWindowMs)
      this.history.shift();
    const base = this.history[0];
    const window = (t - base.t) / 1000;
    if (window > 0)
      for (let k = 0; k < n; k++) {
        if (!seen[k]) continue;
        const v =
          Math.hypot(f[k * 2] - base.f[k * 2], f[k * 2 + 1] - base.f[k * 2 + 1]) / window / scale;
        speed = Math.max(speed, v);
      }
    if (this.lastF && this.lastRaw)
      for (let k = 0; k < n; k++) {
        if (!seen[k]) continue;
        const step = Math.hypot(
          raw[k * 2] - this.lastRaw[k * 2],
          raw[k * 2 + 1] - this.lastRaw[k * 2 + 1],
        );
        if (step > P.fastK * Math.sqrt(this.noise2[k]) + P.fastFloorPx * scale) fast = true;
      }
    // Noise: EMA of the raw − filtered residual while slow.
    if (speed < P.releaseSpeed) {
      const a = 1 - Math.exp(-dt / P.noiseTauMs);
      for (let k = 0; k < n; k++) {
        if (!seen[k]) continue;
        const r2 = (raw[k * 2] - f[k * 2]) ** 2 + (raw[k * 2 + 1] - f[k * 2 + 1]) ** 2;
        this.noise2[k] += a * (r2 - this.noise2[k]);
      }
    }
    this.lastF = f;
    this.lastRaw = raw;
    if (this.state.engaged) {
      if (fast) this.release(t, 'fast');
      else if (speed > P.releaseSpeed) this.release(t, 'speed');
      else this.state = { ...this.state, heldFrames: this.state.heldFrames + 1, speed };
      if (!this.state.engaged) this.slowSince = undefined;
    } else {
      if (speed < P.engageSpeed && !fast) this.slowSince ??= t;
      else this.slowSince = undefined;
      if (this.slowSince !== undefined && t - this.slowSince >= P.engageMs) {
        this.releasedAt = undefined;
        this.state = {
          engaged: true,
          hold: 1,
          heldFrames: 0,
          lastRelease: this.state.lastRelease,
          speed,
        };
      }
    }
    this.state = { ...this.state, speed };
    return this.ease(t);
  }

  private release(t: number, why: StillnessState['lastRelease']) {
    if (!this.state.engaged) return;
    this.releasedAt = t;
    this.state = { ...this.state, engaged: false, hold: 1, heldFrames: 0, lastRelease: why };
  }

  private ease(t: number): StillnessState {
    if (this.state.engaged) return this.state;
    const since = this.releasedAt === undefined ? Infinity : t - this.releasedAt;
    const hold = since >= this.params.easeMs ? 0 : 0.5 * (1 - since / this.params.easeMs);
    this.state = { ...this.state, hold };
    return this.state;
  }
}

/**
 * Per-key One Euro filters for the held outputs (glue control points by name, pose values by
 * key). `filter` runs while the lock is engaged; `reset` on release (the next engage starts from
 * live).
 */
export class HeldFilters {
  private filters = new Map<string, OneEuroFilter>();
  constructor(private readonly params: OneEuro) {}
  filter(key: string, value: number, t: number): number {
    let f = this.filters.get(key);
    if (!f) this.filters.set(key, (f = new OneEuroFilter(this.params)));
    return f.filter(value, t);
  }
  reset() {
    this.filters.clear();
  }
}
