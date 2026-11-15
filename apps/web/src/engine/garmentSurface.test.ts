import { describe, expect, it } from 'vitest';
import type { ClothAsset } from '../api';
import {
  PANEL,
  RELIEF_PROBE,
  droppedCap,
  foldSafeRelief,
  seamDistance,
  sleeveMaterialScale,
} from './garmentSurface';

/**
 * A straight sleeve tube along -Y (rows of m vertices, row spacing `dy`), whose material arc
 * grows `rate` times faster than the shown arc below row `from` (a stacked forearm).
 */
function tube(rows: number, m: number, dy: number, rate: (r: number) => number) {
  const initial: number[] = [],
    uv: number[] = [],
    material: number[] = [],
    panels: number[] = [],
    triangles: number[] = [];
  let a = 0.2;
  for (let r = 0; r < rows; r++) {
    if (r > 0) a += dy * rate(r - 1);
    for (let j = 0; j < m; j++) {
      const t = (2 * Math.PI * j) / m;
      initial.push(0.3 + 0.05 * Math.cos(t), 1.4 - r * dy, 0.05 * Math.sin(t));
      uv.push(j * 0.01, r * dy);
      material.push(a);
      panels.push(PANEL.sleeveL);
    }
  }
  for (let r = 0; r + 1 < rows; r++)
    for (let j = 0; j < m; j++) {
      const p = r * m + j,
        q = r * m + ((j + 1) % m);
      triangles.push(p, q, q + m, p, q + m, p + m);
    }
  const asset = {
    initial,
    render_uv: uv,
    render_material_v: material,
    panels,
    triangles,
  } as unknown as ClothAsset;
  const arc = new Float32Array(panels.length * 4);
  for (let i = 0; i < panels.length; i++) arc.set([0, material[i], 1, -1], i * 4);
  return { asset, arc, m };
}

describe('sleeveMaterialScale', () => {
  it('is 1 where the material arc equals the shown arc', () => {
    const { asset, arc } = tube(10, 16, 0.015, () => 1);
    sleeveMaterialScale(asset, asset.initial, arc);
    for (let i = 0; i < asset.panels.length; i++) expect(arc[i * 4 + 2]).toBeCloseTo(1, 5);
  });

  it('follows the stacking ratio smoothly per vertex', () => {
    // Rows 0-4 unstacked, rows 5+ carry 1.6x material per shown metre.
    const { asset, arc, m } = tube(12, 16, 0.015, (r) => (r < 5 ? 1 : 1.6));
    sleeveMaterialScale(asset, asset.initial, arc);
    const row = (r: number) => arc[r * m * 4 + 2];
    expect(row(2)).toBeCloseTo(1, 5);
    expect(row(9)).toBeCloseTo(1.6, 5);
    // The row on the change averages both sides: no jump from one triangle to the next.
    expect(row(5)).toBeCloseTo(1.3, 5);
  });

  it('leaves vertices without a material arc at 1 and ignores other panels', () => {
    const { asset, arc } = tube(6, 8, 0.015, () => 2);
    for (let i = 0; i < 8; i++) arc[i * 4 + 1] = 0;
    sleeveMaterialScale(asset, asset.initial, arc);
    expect(arc[2]).toBe(1);
    expect(arc[5 * 8 * 4 + 2]).toBeCloseTo(2, 5);
  });
});

describe('foldSafeRelief (L3)', () => {
  // A strip on a 1 cm cylinder (half a turn): outward normals keep every triangle under any
  // displacement; turned inward (concave side), a relief larger than the radius folds it over.
  function strip(inward: boolean) {
    const positions: number[] = [],
      triangles: number[] = [],
      panels: number[] = [],
      m = 12,
      r = 0.01;
    for (let k = 0; k <= m; k++) {
      const a = (Math.PI * k) / m;
      positions.push(r * Math.cos(a), 0, r * Math.sin(a), r * Math.cos(a), 0.02, r * Math.sin(a));
      panels.push(3, 3);
    }
    for (let k = 0; k < m; k++) {
      const [a, b, c, d] = [2 * k, 2 * k + 2, 2 * k + 3, 2 * k + 1];
      if (inward) triangles.push(a, b, c, a, c, d);
      else triangles.push(a, c, b, a, d, c);
    }
    return { asset: { panels, triangles } as unknown as ClothAsset, positions };
  }
  it('keeps the full relief where nothing can fold', () => {
    const { asset, positions } = strip(false);
    expect(Math.min(...foldSafeRelief(asset, positions, 0.0275))).toBe(1);
  });
  it('limits the relief where the displaced triangles would turn over', () => {
    const { asset, positions } = strip(true);
    const safe = foldSafeRelief(asset, positions, 0.0275);
    const middle = safe[12]; // half-way along the strip (both of its triangles' neighbours)
    expect(middle).toBeLessThan(1);
    // The kept relief never reaches the 1 cm radius (0.7 x 2.75 cm x s < 1 cm).
    expect(middle * RELIEF_PROBE * 0.0275).toBeLessThan(0.01);
  });
});

describe('dropped-shoulder cap (L3)', () => {
  it('moves the chart seam from the armhole to the seam ring', () => {
    // Column strip: 0-1 torso, 2-3 sleeve cap (dropped_cap_L), 4-5 sleeve below the seam ring.
    const asset = {
      panels: [0, 0, 4, 4, 4, 4],
      triangles: [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4],
      paths: { dropped_cap_L: [2, 3] },
    } as unknown as ClothAsset; // only panels/triangles/paths are read
    const p = [0, 0, 0, 1, 0, 0, 0, 0.01, 0, 1, 0.01, 0, 0, 0.03, 0, 1, 0.03, 0];
    const cap = droppedCap(asset);
    expect(Array.from(cap)).toEqual([0, 0, 1, 1, 0, 0]);
    const set = seamDistance(asset, p, 0.06);
    const dropped = seamDistance(asset, p, 0.06, cap);
    expect(set[0]).toBe(0); // set-in: the armhole (torso/sleeve) is the seam
    expect(dropped[0]).toBeCloseTo(0.01, 6); // dropped: the armhole is inside the body panel
    expect(dropped[4]).toBe(0); // ...and the seam ring (cap/sleeve) is the seam
  });
});
