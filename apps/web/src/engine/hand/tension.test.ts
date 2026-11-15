import { describe, expect, it } from 'vitest';
import { HAND_TENSION } from './config';
import {
  FollowLog,
  formatFollow,
  parseAssetKey,
  patchFollow,
  TautDetector,
  type TensionSample,
} from './tension';

describe('patchFollow (grab displacement measured on the patch particles)', () => {
  // Three patch particles (ids 1, 3, 4) in a 5-particle array; weights 1, 0.5, 0.35.
  const ids = [1, 3, 4],
    weights = [1, 0.5, 0.35],
    base = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const at = (moves: number[][]) => {
    const p = new Float64Array(15).fill(9); // non-patch particles: ignored
    ids.forEach((id, j) => {
      for (let a = 0; a < 3; a++) p[id * 3 + a] = base[j * 3 + a] + moves[j][a];
    });
    return p;
  };

  it('returns the applied displacement when the patch sits on its targets (base + w·d)', () => {
    const d = [0.012, -0.004, 0.019];
    const f = patchFollow(at(weights.map((w) => d.map((x) => x * w))), ids, weights, base);
    f.forEach((x, a) => expect(x).toBeCloseTo(d[a], 12));
  });

  it('is smaller than the target when the fabric holds the patch back', () => {
    const d = [0, 0, 0.05];
    // Every particle reached only 40 % of its target.
    const f = patchFollow(at(weights.map((w) => d.map((x) => x * w * 0.4))), ids, weights, base);
    expect(f[2]).toBeCloseTo(0.02, 12);
  });

  it('is zero at rest and rejects mismatched sizes', () => {
    expect(
      patchFollow(
        at([
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ]),
        ids,
        weights,
        base,
      ),
    ).toEqual([0, 0, 0]);
    expect(() => patchFollow(new Float64Array(15), ids, [1, 1], base)).toThrow();
    expect(() => patchFollow(new Float64Array(15), ids, weights, [0, 0, 0])).toThrow();
  });
});

describe('TautDetector', () => {
  const run = (samples: TensionSample[]) => {
    const d = new TautDetector();
    return { d, flags: samples.map((s) => d.update(s)) };
  };
  const frames = (n: number, fn: (t: number) => { follow: number; gap: number }) =>
    Array.from({ length: n }, (_, i) => ({ t: i / 60, ...fn(i / 60) }));

  it('is not taut while the fabric keeps following, even with the hand ahead', () => {
    // Fabric gains 3 cm/s (7.5 mm per 0.25 s window) with the hand 2 cm ahead.
    const { d, flags } = run(frames(60, (t) => ({ follow: 0.03 * t, gap: 0.02 })));
    expect(flags.some(Boolean)).toBe(false);
    expect(d.maxFollow).toBeCloseTo(0.03 * (59 / 60), 12);
  });

  it('is not taut on a plateau when the hand is not ahead (hand stopped with the fabric)', () => {
    const { flags } = run(frames(60, () => ({ follow: 0.019, gap: 0.002 })));
    expect(flags.some(Boolean)).toBe(false);
  });

  it('goes taut once the follow has plateaued for a full window with the hand ahead', () => {
    // Follows to 1.9 cm in 0.2 s, then stops; the hand keeps going (gap grows).
    const samples = frames(60, (t) => ({
      follow: Math.min(0.019, 0.095 * t),
      gap: Math.max(0, 0.2 * t - Math.min(0.019, 0.095 * t)),
    }));
    const { d, flags } = run(samples);
    const first = flags.indexOf(true);
    expect(first).toBeGreaterThan(0);
    // Plateau starts at t = 0.2 s; taut needs one full window after it.
    expect(samples[first].t).toBeGreaterThanOrEqual(0.2 + HAND_TENSION.plateauWindowS - 1e-9);
    expect(flags.slice(first).every(Boolean)).toBe(true);
    expect(d.maxFollow).toBeCloseTo(0.019, 12);
    expect(d.tautSamples).toBe(flags.length - first);
  });

  it('stays taut through probe flicker below plateauGrowthM, ends when the hand eases off', () => {
    const flicker = HAND_TENSION.plateauGrowthM * 0.5;
    const samples = [
      ...frames(40, (t) => ({ follow: 0.019 + (Math.round(t * 60) % 2 ? flicker : 0), gap: 0.03 })),
      // Hand comes back to the fabric: gap below the exit threshold.
      ...frames(5, () => ({ follow: 0.019, gap: HAND_TENSION.tautExitGapM * 0.5 })).map((s) => ({
        ...s,
        t: s.t + 40 / 60,
      })),
    ];
    const { flags } = run(samples);
    expect(flags[39]).toBe(true);
    expect(flags[44]).toBe(false);
  });

  it('ends taut when the fabric moves again (e.g. the pull direction changed)', () => {
    const samples = [
      ...frames(30, () => ({ follow: 0.019, gap: 0.03 })),
      ...frames(10, (t) => ({ follow: 0.019 + 0.1 * t, gap: 0.03 })).map((s) => ({
        ...s,
        t: s.t + 0.5,
      })),
    ];
    const { flags } = run(samples);
    expect(flags[29]).toBe(true);
    expect(flags[39]).toBe(false);
  });

  it('rejects non-finite samples and resets', () => {
    const d = new TautDetector();
    expect(() => d.update({ t: 0, follow: NaN, gap: 0 })).toThrow();
    d.update({ t: 0, follow: 0.01, gap: 0 });
    d.reset();
    expect(d.maxFollow).toBe(0);
    expect(d.taut).toBe(false);
  });
});

describe('formatting, asset keys and the per-size log', () => {
  it('formats metres as cm and inches', () => {
    expect(formatFollow(0.019)).toBe('1.9 cm · 0.75 in');
    expect(formatFollow(0.0254)).toBe('2.5 cm · 1.00 in');
    expect(formatFollow(-0.001)).toBe('0.0 cm · 0.00 in');
    expect(formatFollow(NaN)).toBe('—');
  });

  it('parses fit and size from a cloth asset key', () => {
    expect(parseAssetKey('ab12:S:shell-v7:pose-v3')).toEqual({ fit: 'ab12', size: 'S' });
    expect(parseAssetKey('synthetic-table')).toBeUndefined();
    expect(parseAssetKey(':S:a:b')).toBeUndefined();
  });

  it('keeps the largest hand pull and the last standard pull per size, one fit at a time', () => {
    const log = new FollowLog();
    log.recordHand('fit1', 'S', 0.012, false);
    log.recordHand('fit1', 'S', 0.019, true);
    log.recordHand('fit1', 'S', 0.015, false);
    log.recordStandard('fit1', 'M', 0.046, true);
    const order = (s: string[]) => [...s].sort((a, b) => (a === 'S' ? -1 : b === 'S' ? 1 : 0));
    expect(log.entries('fit1', order)).toEqual([
      { size: 'S', handMaxM: 0.019, handTaut: true },
      { size: 'M', standardM: 0.046, standardTaut: true },
    ]);
    expect(log.entries('other')).toEqual([]);
    // Next judge: the previous fit is forgotten.
    log.recordHand('fit2', 'L', 0.03, false);
    expect(log.entries('fit1')).toEqual([]);
    expect(log.entries('fit2')).toEqual([{ size: 'L', handMaxM: 0.03, handTaut: false }]);
    expect(() => log.recordHand('fit2', 'L', NaN, false)).toThrow();
  });
});
