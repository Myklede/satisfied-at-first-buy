import { describe, expect, it } from 'vitest';
import type { Vec2 } from './geometry';
import {
  applyAffine,
  fitAffine,
  fitSimilarity,
  IDENTITY,
  maskMotion,
  type Affine,
  type LandmarkSnapshot,
} from './motion';

const close = (p: Vec2, q: Vec2, d = 1e-6) => {
  expect(p[0]).toBeCloseTo(q[0], -Math.log10(d));
  expect(p[1]).toBeCloseTo(q[1], -Math.log10(d));
};

describe('mask motion compensation', () => {
  it('similarity maps one arm segment onto its later position', () => {
    const a0: Vec2 = [100, 100],
      b0: Vec2 = [100, 200];
    // The forearm swung 30° about a moved elbow, 10 % longer.
    const ang = Math.PI / 6;
    const a1: Vec2 = [120, 90],
      b1: Vec2 = [120 - 110 * Math.sin(ang), 90 + 110 * Math.cos(ang)];
    const T = fitSimilarity(a0, b0, a1, b1);
    close(applyAffine(T, a0), a1);
    close(applyAffine(T, b0), b1);
    // An implausible jump (scale × 3) falls back to the midpoints' translation.
    const J = fitSimilarity(a0, b0, [0, 0], [0, 300]);
    expect(J[0]).toBe(1);
    expect(J[4]).toBe(1);
  });

  it('affine recovers a known torso motion from four landmarks; collinear points are rejected', () => {
    const T: Affine = [1.05, 0.08, 12, -0.06, 0.97, -7];
    const from: Vec2[] = [
      [400, 200],
      [560, 205],
      [420, 420],
      [540, 418],
    ];
    const to = from.map((p) => applyAffine(T, p));
    const F = fitAffine(from, to)!;
    F.forEach((v, i) => expect(v).toBeCloseTo(T[i], 6));
    expect(
      fitAffine(
        [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
        [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      ),
    ).toBeNull();
  });

  it('per-region motion: a lookup now reads the mask where the body part was', () => {
    // Then: standing; now: the whole body moved 20 px right and the left forearm swung up.
    const then: LandmarkSnapshot = {
      11: [580, 180],
      12: [380, 180],
      13: [600, 290],
      14: [360, 290],
      15: [610, 390],
      16: [350, 390],
      23: [540, 400],
      24: [420, 400],
    };
    const now: LandmarkSnapshot = Object.fromEntries(
      Object.entries(then).map(([k, p]) => [k, [p![0] + 20, p![1]]]),
    );
    now[15] = [720, 300]; // forearm raised sideways
    const m = maskMotion(now, then);
    // Torso: the translation back.
    close(applyAffine(m.torso, [500, 300]), [480, 300], 1e-3);
    // Left forearm: the current wrist maps to the old wrist, the current elbow to the old elbow.
    close(applyAffine(m.arms[1]!, now[15]!), then[15]!, 1e-3);
    close(applyAffine(m.arms[1]!, now[13]!), then[13]!, 1e-3);
    // Missing landmarks: identity for the torso, null arms.
    expect(maskMotion(null, then)).toEqual({ torso: IDENTITY, arms: [null, null, null, null] });
  });
});
