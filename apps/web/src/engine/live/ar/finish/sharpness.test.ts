import { describe, expect, it } from 'vitest';
import { cameraEdgeWidth, matchedSigma, stepWidth } from './sharpness';

/** A step from 40 to 200 at x0, blurred by a Gaussian σ (px), sampled at pixel centres. */
function blurredStep(n: number, x0: number, sigma: number): number[] {
  const erf = (x: number) => {
    // Abramowitz-Stegun 7.1.26
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y =
      1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
        t *
        Math.exp(-x * x);
    return x >= 0 ? y : -y;
  };
  return Array.from({ length: n }, (_, i) => {
    const u = sigma > 0 ? (i + 0.5 - x0) / (sigma * Math.SQRT2) : i + 0.5 - x0;
    const f = sigma > 0 ? 0.5 * (1 + erf(u)) : u > 0 ? 1 : 0;
    return 40 + 160 * f;
  });
}

describe('F4 camera sharpness', () => {
  it('reads a pixel-sharp step as about 1 px and a blurred one as about its 10-90 % width', () => {
    expect(stepWidth(blurredStep(40, 20, 0))).toBeCloseTo(1, 5);
    for (const sigma of [1, 1.5, 2]) {
      const w = stepWidth(blurredStep(40, 20.3, sigma))!;
      expect(w).toBeGreaterThan(2.563 * sigma * 0.85);
      expect(w).toBeLessThan(2.563 * sigma * 1.15);
    }
    expect(stepWidth(new Array(40).fill(100))).toBeNull();
  });

  it('takes the median over the rows of a crop', () => {
    const w = 48,
      h = 8;
    const rgba = new Uint8Array(w * h * 4);
    for (let r = 0; r < h; r++) {
      const row = blurredStep(w, 24 + (r % 3) * 0.3, 1.2);
      for (let x = 0; x < w; x++) {
        const i = (r * w + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = row[x];
        rgba[i + 3] = 255;
      }
    }
    const width = cameraEdgeWidth(rgba, w, h)!;
    expect(width).toBeGreaterThan(2.563 * 1.2 * 0.85);
    expect(width).toBeLessThan(2.563 * 1.2 * 1.15);
  });

  it('matches the camera but never goes softer than the floor', () => {
    // Soft camera (3 px) with a 1.4 px floor: blur only up to the floor.
    expect(matchedSigma(3, 1, 1.4)).toBeCloseTo(Math.sqrt(1.4 ** 2 - 1) / 2.563, 6);
    // Sharp camera (1.1 px): almost no blur.
    expect(matchedSigma(1.1, 1, 1.4)).toBeCloseTo(Math.sqrt(1.21 - 1) / 2.563, 6);
    // Jacket already softer than the target: none.
    expect(matchedSigma(0.8, 1, 1.4)).toBe(0);
  });
});

describe('F4 temporal camera noise', () => {
  it('recovers the per-frame noise sigma from two noisy frames of a static patch', async () => {
    const { temporalSigma } = await import('./sharpness');
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const n = 64 * 64;
    const base = Float32Array.from({ length: n }, (_, i) => 60 + ((i * 37) % 120));
    const frame = (s: number) => {
      const out = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        const v = Math.max(0, Math.min(255, Math.round(base[i] + s * gauss())));
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
        out[i * 4 + 3] = 255;
      }
      return out;
    };
    const s = temporalSigma(frame(2), frame(2))!;
    expect(s).toBeGreaterThan(1.6);
    expect(s).toBeLessThan(2.4);
    const same = frame(0);
    expect(temporalSigma(same, same)).toBeNull();
  });
});
