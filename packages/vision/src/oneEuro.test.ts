import { describe, expect, it } from 'vitest';
import { OneEuroFilter, OneEuroVecFilter, smoothingFactor } from './oneEuro';

/** Deterministic pseudo-random noise in [-1, 1] (LCG) so tests are reproducible. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

function std(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
}

const FRAME_MS = 1000 / 30;

describe('smoothingFactor', () => {
  it('matches alpha = 1 / (1 + tau/Te)', () => {
    const tau = 1 / (2 * Math.PI * 2);
    expect(smoothingFactor(2, 0.05)).toBeCloseTo(1 / (1 + tau / 0.05), 12);
  });
  it('approaches 1 for very high cutoff', () => {
    expect(smoothingFactor(1e6, 1 / 30)).toBeGreaterThan(0.999);
  });
});

describe('OneEuroFilter', () => {
  it('passes the first sample through and holds a constant input', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0.5, dCutoff: 1 });
    expect(f.filter(3.5, 0)).toBe(3.5);
    for (let i = 1; i < 30; i++) expect(f.filter(3.5, i * FRAME_MS)).toBeCloseTo(3.5, 12);
  });

  it('with beta = 0 equals a fixed exponential low-pass at minCutoff', () => {
    const f = new OneEuroFilter({ minCutoff: 1.5, beta: 0, dCutoff: 1 });
    const inputs = [0, 1, 1, 0.5, 2, -1];
    let expected = inputs[0];
    f.filter(inputs[0], 0);
    for (let i = 1; i < inputs.length; i++) {
      const a = smoothingFactor(1.5, FRAME_MS / 1000);
      expected += a * (inputs[i] - expected);
      expect(f.filter(inputs[i], i * FRAME_MS)).toBeCloseTo(expected, 12);
    }
  });

  it('removes most jitter from a stationary noisy signal', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0.5, dCutoff: 1 });
    const n = noise(42);
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      const v = 0.5 + 0.004 * n();
      raw.push(v);
      out.push(f.filter(v, i * FRAME_MS));
    }
    // Skip the warm-up; measure steady state.
    expect(std(out.slice(60))).toBeLessThan(0.3 * std(raw.slice(60)));
  });

  it('lags less on a fast ramp when beta is higher', () => {
    const lagFor = (beta: number) => {
      const f = new OneEuroFilter({ minCutoff: 1, beta, dCutoff: 1 });
      let out = 0;
      for (let i = 0; i <= 60; i++) out = f.filter(i * FRAME_MS * 0.001, i * FRAME_MS); // 1 unit/s
      return 60 * FRAME_MS * 0.001 - out;
    };
    const slow = lagFor(0);
    const fast = lagFor(10);
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(0);
    expect(fast).toBeLessThan(0.25 * slow);
  });

  it('keeps the previous estimate on a duplicate or out-of-order timestamp', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: 1 });
    f.filter(0, 0);
    const y = f.filter(1, 100);
    expect(f.filter(5, 100)).toBe(y);
    expect(f.filter(5, 50)).toBe(y);
  });

  it('restarts after reset', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: 1 });
    f.filter(0, 0);
    f.filter(1, 100);
    f.reset();
    expect(f.value).toBeUndefined();
    expect(f.filter(7, 200)).toBe(7);
  });

  it('rejects invalid parameters and input', () => {
    expect(() => new OneEuroFilter({ minCutoff: 0, beta: 0, dCutoff: 1 })).toThrow(RangeError);
    expect(() => new OneEuroFilter({ minCutoff: 1, beta: -1, dCutoff: 1 })).toThrow(RangeError);
    expect(() => new OneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: NaN })).toThrow(RangeError);
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: 1 });
    expect(() => f.filter(NaN, 0)).toThrow(RangeError);
  });
});

describe('OneEuroVecFilter', () => {
  it('with dim 1 matches the scalar filter exactly', () => {
    const params = { minCutoff: 0.8, beta: 3, dCutoff: 1 };
    const s = new OneEuroFilter(params);
    const v = new OneEuroVecFilter(1, params);
    const n = noise(7);
    for (let i = 0; i < 100; i++) {
      const x = Math.sin(i / 10) + 0.01 * n();
      expect(v.filter([x], i * FRAME_MS)[0]).toBeCloseTo(s.filter(x, i * FRAME_MS), 12);
    }
  });

  it('is isotropic: the same motion along x or along a diagonal lags by the same distance', () => {
    const params = { minCutoff: 1, beta: 5, dCutoff: 1 };
    const run = (dir: [number, number]) => {
      const f = new OneEuroVecFilter(2, params);
      let out = [0, 0];
      for (let i = 0; i <= 30; i++) {
        const d = i * 0.02;
        out = f.filter([dir[0] * d, dir[1] * d], i * FRAME_MS);
      }
      const target = 30 * 0.02;
      return Math.hypot(dir[0] * target - out[0], dir[1] * target - out[1]);
    };
    const h = Math.SQRT1_2;
    expect(run([1, 0])).toBeCloseTo(run([h, h]), 10);
  });

  it('rejects a wrong vector length', () => {
    const f = new OneEuroVecFilter(2, { minCutoff: 1, beta: 0, dCutoff: 1 });
    expect(() => f.filter([1, 2, 3], 0)).toThrow(RangeError);
    expect(() => new OneEuroVecFilter(0, { minCutoff: 1, beta: 0, dCutoff: 1 })).toThrow(
      RangeError,
    );
  });
});
