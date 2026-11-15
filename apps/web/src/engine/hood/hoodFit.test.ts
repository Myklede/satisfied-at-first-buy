import { describe, expect, it } from 'vitest';
import {
  applySimilarity,
  arcParams,
  fitSimilarity,
  indexWithoutHood,
  keyWeights,
  liftedAt,
  PANEL_HOOD,
  sampleAt,
  shellSeamIds,
  svd3,
  type Vec3,
} from './hoodFit';
import { HOOD } from './hoodConfig';

/** A U-shaped seam round the back of a neck (right front -> back -> left front). */
function neckSeam(n = 21): Vec3[] {
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI * 0.8 + (1.6 * Math.PI * i) / (n - 1); // 0 = back
    return [0.07 * Math.sin(a), 1.5 + 0.03 * Math.cos(a), -0.06 * Math.cos(a)] as Vec3;
  });
}

function rotationY(angle: number) {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

describe('similarity fit', () => {
  it('recovers a known rotation, scale and translation exactly', () => {
    const from = neckSeam();
    const truth = {
      scale: 1.07,
      rotation: rotationY(0.2),
      translation: [0.01, -0.02, 0.03] as Vec3,
      rawScale: 1.07,
    };
    const to = from.map((p) => applySimilarity(truth, p));
    const fit = fitSimilarity(from, to);
    expect(fit.scale).toBeCloseTo(1.07, 7); // eigen route via H^T H: ~1e-9
    fit.rotation.forEach((v, i) => expect(v).toBeCloseTo(truth.rotation[i], 7));
    for (let i = 0; i < from.length; i++) {
      const q = applySimilarity(fit, from[i]);
      for (let k = 0; k < 3; k++) expect(q[k]).toBeCloseTo(to[i][k], 7);
    }
  });

  it('never returns a reflection, and clamps the scale to the grading bounds', () => {
    const from = neckSeam();
    const big = from.map((p) => p.map((v) => v * 2) as Vec3);
    const fit = fitSimilarity(from, big);
    expect(fit.rawScale).toBeCloseTo(2, 6);
    expect(fit.scale).toBe(HOOD.maxScale);
    const mirrored = from.map((p) => [-p[0], p[1], p[2]] as Vec3);
    const r = fitSimilarity(from, mirrored).rotation;
    const det =
      r[0] * (r[4] * r[8] - r[5] * r[7]) -
      r[1] * (r[3] * r[8] - r[5] * r[6]) +
      r[2] * (r[3] * r[7] - r[4] * r[6]);
    expect(det).toBeCloseTo(1, 9);
  });

  it('svd3 reconstructs a matrix', () => {
    const h = [0.3, -1.2, 0.5, 2.0, 0.1, -0.4, -0.7, 0.9, 1.1];
    const { u, s, v } = svd3(h);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        let x = 0;
        for (let k = 0; k < 3; k++) x += u[r * 3 + k] * s[k] * v[c * 3 + k];
        expect(x).toBeCloseTo(h[r * 3 + c], 9);
      }
    expect(s[0]).toBeGreaterThanOrEqual(s[1]);
    expect(s[1]).toBeGreaterThanOrEqual(s[2]);
  });
});

describe('polyline sampling', () => {
  it('samples by normalised arc length', () => {
    const line: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 3, 0],
    ];
    const arc = arcParams(line);
    expect(arc).toEqual([0, 0.25, 1]);
    expect(sampleAt(line, arc, 0.5)).toEqual([1, 1, 0]);
    expect(sampleAt(line, arc, -1)).toEqual([0, 0, 0]);
    expect(sampleAt(line, arc, 2)).toEqual([1, 3, 0]);
  });
});

describe('detach blending', () => {
  it('key weights are piecewise linear and sum to one', () => {
    const at = HOOD.keyPositions;
    expect(keyWeights(at, 0)).toEqual([1, 0, 0, 0, 0]);
    expect(keyWeights(at, 1)).toEqual([0, 0, 0, 0, 1]);
    const mid = keyWeights(at, 0.6);
    expect(mid[2]).toBeCloseTo(0.6, 9);
    expect(mid[3]).toBeCloseTo(0.4, 9);
    for (const p of [0, 0.1, 0.33, 0.5, 0.77, 1])
      expect(keyWeights(at, p).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it('the zip opens from the wearer right: the right end lifts first, all lifted at the end', () => {
    expect(liftedAt(0, 0)).toBe(0);
    expect(liftedAt(1, 0)).toBe(0);
    expect(liftedAt(0, 0.5)).toBe(1);
    expect(liftedAt(1, 0.5)).toBe(0);
    for (const s of [0, 0.3, 0.7, 1]) expect(liftedAt(s, 1)).toBe(1);
    // Monotonic in progress for a fixed seam point.
    let last = 0;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const v = liftedAt(0.6, p);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });
});

describe('shell seam', () => {
  it('uses the removable hood zip path, right end first', () => {
    const positions = [0.05, 0, 0, 0, 0, -0.05, -0.05, 0, 0];
    expect(
      shellSeamIds(
        { panels: [6, 6, 6], triangles: [], paths: { hood_zip: [0, 1, 2] }, maximum_loft_m: 0 },
        positions,
      ),
    ).toEqual([2, 1, 0]);
  });

  it('a sewn-in hood attaches on the neckline behind the collar seam ends, right first', () => {
    // Neckline ring of 12 points round a neck centred at z = 0 (0 deg = front); collar-top seam
    // ends at +-60 deg, so the kept neckline runs from -60 deg round the back to +60 deg.
    const ring = Array.from({ length: 12 }, (_, k) => (k * 30 * Math.PI) / 180);
    const neck = ring.flatMap((a) => [0.06 * Math.sin(a), 1.45, 0.06 * Math.cos(a)]);
    const ends = [-60, 60].map((d) => (d * Math.PI) / 180);
    const collar = ends.flatMap((a) => [0.06 * Math.sin(a), 1.5, 0.06 * Math.cos(a)]);
    const positions = [...neck, ...collar, 0, 1.55, -0.06];
    const panels = [...ring.map(() => 2), 6, 6, 7];
    // Collar ends 12, 13 joined through the hood vertex 14 (one triangle each side).
    const triangles = [12, 13, 14];
    const ids = shellSeamIds(
      { panels, triangles, paths: { neckline: ring.map((_, k) => k) }, maximum_loft_m: 0 },
      positions,
    );
    // k = 10 (-60 deg), 9 (-90) ... 6 (180) ... 2 (+60)
    expect(ids).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });

  it('drops every shell triangle touching the hood panel', () => {
    const index = indexWithoutHood({
      panels: [6, 6, PANEL_HOOD, 6],
      triangles: [0, 1, 3, 0, 1, 2, 2, 3, 1],
    });
    expect([...index]).toEqual([0, 1, 3]);
  });
});
