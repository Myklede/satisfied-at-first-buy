import { describe, expect, it } from 'vitest';
import { bafflePhase, isolineSegments, panelBoundarySegments } from './seams';

// Two quads side by side (4 vertices per row): vertices 0..3 bottom row, 4..7 top row.
const triangles = [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6];
const positions = [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0, 3, 1, 0];

describe('panelBoundarySegments', () => {
  it('emits each boundary edge once, between differing panels only', () => {
    const panels = [0, 0, 1, 1, 0, 0, 1, 1];
    const { positions: out, panel } = panelBoundarySegments(triangles, panels, positions);
    // Edges 1-2, 5-6 and the diagonal 1-6 cross the panel change.
    expect(panel.length).toBe(3);
    expect(out.length).toBe(3 * 6);
    expect(Array.from(panel)).toEqual([0, 0, 0]);
  });
  it('lifts points along the normals', () => {
    const panels = [0, 0, 1, 1, 0, 0, 1, 1];
    const normals = positions.map((_, i) => (i % 3 === 2 ? 1 : 0));
    const { positions: out } = panelBoundarySegments(triangles, panels, positions, normals, 0.01);
    expect(out[2]).toBeCloseTo(0.01);
  });
  it('is empty for a single panel', () => {
    expect(panelBoundarySegments(triangles, new Array(8).fill(2), positions).panel.length).toBe(0);
  });
});

describe('bafflePhase', () => {
  const panels = [2, 2, 2, 2, 2, 2, 4, 6];
  const quiltUv = [0, 0.02, 0, 0.1, 0, 0.2, 0, 0.3, 0, 0.4, 0, 0.5, 0, 0.0, 0, 0.1];
  const quilt = Array.from({ length: 8 }, () => [0.2, 0.1, 0.05, 1]).flat();
  const arc = new Array(32).fill(0);
  it('uses (v - yoke) / chamber height and rejects the yoke band and the collar', () => {
    const { phase, valid } = bafflePhase(panels, quiltUv, arc, quilt);
    expect(Array.from(valid)).toEqual([0, 1, 1, 1, 1, 1, 0, 0]);
    expect(phase[1]).toBeCloseTo(0.5);
    expect(phase[5]).toBeCloseTo(4.5);
  });
  it('follows the sleeve material arc when present and drops plain bands', () => {
    const sleeveArc = arc.slice();
    sleeveArc[6 * 4 + 1] = 0.25;
    const plain = quilt.slice();
    plain[3 * 4 + 3] = 0;
    const q = bafflePhase([4, 4, 4, 4, 4, 4, 4, 4], quiltUv, sleeveArc, plain);
    expect(q.valid[3]).toBe(0);
    expect(q.phase[6]).toBeCloseTo((0.25 - 0.05) / 0.1);
  });
});

describe('isolineSegments', () => {
  it('draws one line per integer crossing at the interpolated position', () => {
    // Phase rises along +y from 0 to 1.5: one line where it equals 1, at y = 2/3.
    const phase = [0, 0, 0, 0, 1.5, 1.5, 1.5, 1.5];
    const valid = new Array(8).fill(1);
    const seg = isolineSegments(triangles, phase, valid, positions, undefined, 0, 3);
    expect(seg.length % 6).toBe(0);
    for (let i = 1; i < seg.length; i += 3) expect(seg[i]).toBeCloseTo(2 / 3);
    // Three quads, each crossed once: 6 triangles x one segment each.
    expect(seg.length / 6).toBe(6);
  });
  it('skips invalid triangles and chart jumps', () => {
    const phase = [0, 0, 0, 0, 1.5, 1.5, 1.5, 1.5];
    const valid = [1, 1, 1, 1, 1, 1, 1, 0];
    const some = isolineSegments(triangles, phase, valid, positions, undefined, 0, 3);
    expect(some.length / 6).toBe(4);
    expect(
      isolineSegments(triangles, phase, new Array(8).fill(1), positions, undefined, 0, 1).length,
    ).toBe(0);
  });
});
