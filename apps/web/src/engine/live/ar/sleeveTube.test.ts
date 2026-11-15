import { describe, expect, it } from 'vitest';
import { PANEL } from '../../garmentSurface';
import { seamWeights, TUBE_HEAD_FLARE, TUBE_KEEP, tubeSleeves } from './sleeveTube';

/**
 * A left sleeve hanging along -Y from a shoulder at (0.2, 1.4, 0) to an elbow at (0.2, 1.1, 0):
 * rings of 12 vertices every 3 cm, radius 6 cm, except a balloon of 9 cm at 6-12 cm below the
 * shoulder; a body-panel ring at the shoulder (the seam).
 */
function sleeve() {
  const pos: number[] = [],
    panels: number[] = [],
    tris: number[] = [];
  const rings: number[][] = [];
  for (let k = 0; k <= 10; k++) {
    const y = 1.4 - 0.03 * k;
    const r = k >= 2 && k <= 4 ? 0.09 : 0.06;
    const ring: number[] = [];
    for (let j = 0; j < 12; j++) {
      const a = (j / 12) * 2 * Math.PI;
      ring.push(pos.length / 3);
      pos.push(0.2 + r * Math.cos(a), y, r * Math.sin(a));
      panels.push(k === 0 ? PANEL.frontL : PANEL.sleeveL);
    }
    rings.push(ring);
  }
  for (let k = 0; k < 10; k++)
    for (let j = 0; j < 12; j++) {
      const a = rings[k][j],
        b = rings[k][(j + 1) % 12],
        c = rings[k + 1][j],
        d = rings[k + 1][(j + 1) % 12];
      tris.push(a, b, c, b, d, c);
    }
  const joints = { lShoulder: [0.2, 1.4, 0] as const, lElbow: [0.2, 1.1, 0] as const };
  return { positions: Float32Array.from(pos), panels, tris, rings, joints };
}

const radius = (p: Float32Array, v: number) => Math.hypot(p[v * 3] - 0.2, p[v * 3 + 2]);

describe('sleeve tube (F3, f3shoulder: no balloon, no wider cap over the sleeve)', () => {
  it('pulls a mid upper-arm balloon in to the bicep tube; the seam ring stays', () => {
    const s = sleeve();
    const rest = Float32Array.from(s.positions);
    const seam = seamWeights(s.panels, s.tris, rest);
    const removed = tubeSleeves(s.positions, s.panels, s.joints, seam);
    expect(removed).toBeGreaterThan(0.01);
    // ring 3 (9 cm below the shoulder, t = 0.3): allowed 6 cm x (1 + flare x smooth) + keep
    const v = s.rings[3][0];
    const r = radius(s.positions, v);
    expect(r).toBeLessThan(0.09 - 0.02);
    expect(r).toBeGreaterThan(0.06 * (1 - 1e-6));
    expect(r).toBeLessThanOrEqual(0.06 * (1 + TUBE_HEAD_FLARE) + 0.03 * TUBE_KEEP + 1e-6);
    // the seam ring (body panel) and the bicep band are untouched
    for (const k of [0, 6, 8]) expect(radius(s.positions, s.rings[k][0])).toBeCloseTo(0.06, 6);
  });

  it('does nothing without joints', () => {
    const s = sleeve();
    const seam = seamWeights(s.panels, s.tris, s.positions);
    expect(tubeSleeves(s.positions, s.panels, {}, seam)).toBe(0);
  });
});
