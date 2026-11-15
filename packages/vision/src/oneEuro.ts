// One Euro filter: Casiez, Roussel, Vogel, "1€ Filter: A Simple Speed-based Low-pass Filter for
// Noisy Input in Interactive Systems", CHI '12, doi:10.1145/2207676.2208639.
//
// An adaptive exponential low-pass: at rest the cutoff is `minCutoff` (kills jitter), and it rises
// with the (low-passed) speed by `beta` (kills lag when moving fast). Timestamp-based, so it stays
// correct when the inference rate varies or frames are skipped.
//
// Tuning procedure from the paper: set beta = 0, lower minCutoff until jitter at rest is gone,
// then raise beta until lag during fast motion is acceptable. dCutoff = 1 Hz is the paper default.

export interface OneEuroParams {
  /** Minimum cutoff frequency in Hz. Lower = less jitter at rest, more lag. Must be > 0. */
  minCutoff: number;
  /** Speed coefficient: extra cutoff Hz per (unit/s) of speed. Higher = less lag. Must be >= 0. */
  beta: number;
  /** Cutoff in Hz of the low-pass applied to the speed estimate. Must be > 0. Paper: 1 Hz. */
  dCutoff: number;
}

export function validateOneEuroParams(params: OneEuroParams): void {
  const { minCutoff, beta, dCutoff } = params;
  if (!(Number.isFinite(minCutoff) && minCutoff > 0))
    throw new RangeError(`OneEuro minCutoff must be a finite number > 0 (got ${minCutoff}).`);
  if (!(Number.isFinite(beta) && beta >= 0))
    throw new RangeError(`OneEuro beta must be a finite number >= 0 (got ${beta}).`);
  if (!(Number.isFinite(dCutoff) && dCutoff > 0))
    throw new RangeError(`OneEuro dCutoff must be a finite number > 0 (got ${dCutoff}).`);
}

/**
 * Exponential smoothing factor for a first-order low-pass with cutoff `cutoffHz` sampled after
 * `dtSeconds`: alpha = 1 / (1 + tau / Te), tau = 1 / (2π fc)  (paper, eq. 2–3).
 */
export function smoothingFactor(cutoffHz: number, dtSeconds: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
}

/** Scalar One Euro filter. Timestamps are in milliseconds (performance.now()). */
export class OneEuroFilter {
  private params: OneEuroParams;
  private x: number | undefined;
  private dx = 0;
  private lastTimeMs: number | undefined;

  constructor(params: OneEuroParams) {
    validateOneEuroParams(params);
    this.params = { ...params };
  }

  setParams(params: OneEuroParams): void {
    validateOneEuroParams(params);
    this.params = { ...params };
  }

  /** Last filtered value, or undefined before the first sample. */
  get value(): number | undefined {
    return this.x;
  }

  reset(): void {
    this.x = undefined;
    this.dx = 0;
    this.lastTimeMs = undefined;
  }

  filter(value: number, timeMs: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(timeMs))
      throw new RangeError(
        `OneEuroFilter.filter needs finite input (value=${value}, t=${timeMs}).`,
      );
    if (this.x === undefined || this.lastTimeMs === undefined) {
      this.x = value;
      this.dx = 0;
      this.lastTimeMs = timeMs;
      return value;
    }
    const dt = (timeMs - this.lastTimeMs) / 1000;
    // Duplicate or out-of-order timestamp: no new information about time, keep the estimate.
    if (dt <= 0) return this.x;
    this.lastTimeMs = timeMs;
    // Speed is measured against the previous *filtered* value, as in the reference implementation.
    const rawDx = (value - this.x) / dt;
    this.dx += smoothingFactor(this.params.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(this.dx);
    this.x += smoothingFactor(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/**
 * Vector One Euro filter with one *shared* cutoff driven by the speed magnitude |dx/dt|.
 * Filtering x and y independently (the paper's per-axis form) makes the lag direction-dependent:
 * a diagonal move would be smoothed differently from a horizontal one. A shared cutoff keeps the
 * filter isotropic, which matters for a 2D/3D cursor. With dim = 1 it equals OneEuroFilter.
 * Components must be in the same units (e.g. image heights, not mixed width/height units).
 */
export class OneEuroVecFilter {
  readonly dim: number;
  private params: OneEuroParams;
  private x: number[] | undefined;
  private dx: number[];
  private lastTimeMs: number | undefined;

  constructor(dim: number, params: OneEuroParams) {
    if (!Number.isInteger(dim) || dim < 1)
      throw new RangeError(`OneEuroVecFilter dim must be an integer >= 1 (got ${dim}).`);
    validateOneEuroParams(params);
    this.dim = dim;
    this.params = { ...params };
    this.dx = new Array<number>(dim).fill(0);
  }

  setParams(params: OneEuroParams): void {
    validateOneEuroParams(params);
    this.params = { ...params };
  }

  /** Last filtered vector (a copy), or undefined before the first sample. */
  get value(): number[] | undefined {
    return this.x ? [...this.x] : undefined;
  }

  reset(): void {
    this.x = undefined;
    this.dx.fill(0);
    this.lastTimeMs = undefined;
  }

  filter(values: readonly number[], timeMs: number): number[] {
    if (values.length !== this.dim)
      throw new RangeError(`OneEuroVecFilter expected ${this.dim} values, got ${values.length}.`);
    if (!Number.isFinite(timeMs) || values.some((v) => !Number.isFinite(v)))
      throw new RangeError('OneEuroVecFilter.filter needs finite input.');
    if (this.x === undefined || this.lastTimeMs === undefined) {
      this.x = [...values];
      this.dx.fill(0);
      this.lastTimeMs = timeMs;
      return [...this.x];
    }
    const dt = (timeMs - this.lastTimeMs) / 1000;
    if (dt <= 0) return [...this.x];
    this.lastTimeMs = timeMs;
    const aD = smoothingFactor(this.params.dCutoff, dt);
    let speedSq = 0;
    for (let i = 0; i < this.dim; i++) {
      const rawDx = (values[i] - this.x[i]) / dt;
      this.dx[i] += aD * (rawDx - this.dx[i]);
      speedSq += this.dx[i] * this.dx[i];
    }
    const cutoff = this.params.minCutoff + this.params.beta * Math.sqrt(speedSq);
    const a = smoothingFactor(cutoff, dt);
    for (let i = 0; i < this.dim; i++) this.x[i] += a * (values[i] - this.x[i]);
    return [...this.x];
  }
}
