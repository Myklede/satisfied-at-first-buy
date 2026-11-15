// Detects when the Decart output video visibly changes after a set() call (garment swap latency,
// "approach 3"). Pure logic; the page feeds it small downscaled RGBA frames.
//
// Method: before the swap, consecutive-frame differences give the noise level (person moving,
// codec noise). After set(), each frame is compared with the last pre-swap frame; the change time is
// the first frame of a run of `sustain` frames whose difference exceeds
// max(minThreshold, noiseMean + noiseK * noiseStd). Approximate: ask the person to stand still.

/** Mean absolute luma difference (0..255) between two equal-size RGBA buffers. */
export function meanAbsLumaDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length || a.length % 4 !== 0) throw new Error('frame size mismatch');
  const n = a.length / 4;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const la = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    const lb = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
    sum += Math.abs(la - lb);
  }
  return sum / n;
}

export interface ChangeDetectorOptions {
  /** Floor for the threshold, luma levels. 6/255 is above typical H.264 noise on a still scene. */
  minThreshold?: number;
  noiseK?: number;
  /** Consecutive frames above threshold needed to call it a change. */
  sustain?: number;
}

export class ChangeDetector {
  readonly threshold: number;
  private readonly sustain: number;
  private runStart: number | null = null;
  private runLength = 0;
  private detectedAt: number | null = null;

  constructor(noiseSamples: readonly number[], opts: ChangeDetectorOptions = {}) {
    const minThreshold = opts.minThreshold ?? 6;
    const noiseK = opts.noiseK ?? 4;
    this.sustain = Math.max(1, Math.floor(opts.sustain ?? 3));
    let mean = 0;
    let std = 0;
    if (noiseSamples.length > 0) {
      mean = noiseSamples.reduce((s, x) => s + x, 0) / noiseSamples.length;
      const v = noiseSamples.reduce((s, x) => s + (x - mean) ** 2, 0) / noiseSamples.length;
      std = Math.sqrt(v);
    }
    this.threshold = Math.max(minThreshold, mean + noiseK * std);
  }

  /** Feed one post-swap frame (time in ms, diff vs the pre-swap baseline). Returns the change time
   *  (ms, first frame of the sustained run) once detected, else null. */
  feed(timeMs: number, diffVsBaseline: number): number | null {
    if (this.detectedAt !== null) return this.detectedAt;
    if (diffVsBaseline > this.threshold) {
      if (this.runStart === null) this.runStart = timeMs;
      this.runLength += 1;
      if (this.runLength >= this.sustain) this.detectedAt = this.runStart;
    } else {
      this.runStart = null;
      this.runLength = 0;
    }
    return this.detectedAt;
  }
}
