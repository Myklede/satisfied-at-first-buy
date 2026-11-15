import { describe, expect, it } from 'vitest';
import type { ClothAsset } from '../api';
import { garmentCoordinates, seamDistance } from './garmentSurface';
import { anchorAt, swooshPullGeometry } from './garmentDetails';
import { weaveHeight } from './garmentMaterials';
import { garmentUniformValues, sleeveAxis, sleeveEndCircumference } from './garmentShader';
import { detailEstimates, look } from './garmentLook';

/** Two closed torso rows of n columns on a circle, uv as shell.py writes it. */
function ringAsset(n = 16, r = 0.15) {
  const positions: number[] = [],
    uv: number[] = [],
    panels: number[] = [],
    s = 2 * r * Math.sin(Math.PI / n);
  for (let row = 0; row < 2; row++)
    for (let j = 0; j < n; j++) {
      const a = (2 * Math.PI * j) / n;
      positions.push(r * Math.cos(a), 1.4 - row * 0.02, r * Math.sin(a));
      uv.push((j - n / 4) * s, 0.05 + row * 0.02);
      panels.push(Math.sin(a) < -1e-9 ? 2 : Math.cos(a) >= 0 ? 0 : 1);
    }
  const triangles: number[] = [];
  for (let j = 0; j < n; j++) {
    const a = j,
      b = (j + 1) % n,
      c = n + ((j + 1) % n),
      d = n + j;
    triangles.push(a, b, c, a, c, d);
  }
  const asset = {
    panels,
    render_uv: uv,
    triangles,
    paths: { neckline: [] },
    initial: positions,
  } as unknown as ClothAsset; // only the fields read by garmentCoordinates
  return { asset, positions, s, n };
}

describe('garmentCoordinates', () => {
  it('measures arc from centre front and back without a seam at the side', () => {
    const { asset, positions, s, n } = ringAsset();
    const { arc } = garmentCoordinates(asset, positions);
    expect(arc[(n / 4) * 4]).toBeCloseTo(0, 6); // centre front column
    expect(arc[((3 * n) / 4) * 4]).toBeCloseTo((n / 2) * s, 6); // centre back = half round
    expect(arc[((3 * n) / 4) * 4 + 1]).toBeCloseTo(0, 6); // dCB at CB
    // Across the shell's u wrap (columns n-1 and 0) dCF changes by one column, not a lap.
    expect(Math.abs(arc[(n - 1) * 4] - arc[0])).toBeCloseTo(s, 6);
    // Right side seam (front-right -> back) lies a quarter round from CF.
    expect(arc[2]).toBeCloseTo((n / 4 + 0.5) * s, 6);
  });
});

describe('seamDistance', () => {
  it('is zero on triangles that mix coordinate charts and grows along edges', () => {
    // Strip of 4 vertices: 0-1 torso, 2-3 sleeve; triangles bridge them.
    const asset = {
      panels: [0, 0, 4, 4, 4, 4],
      triangles: [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4],
    } as unknown as ClothAsset; // only panels/triangles are read
    const p = [0, 0, 0, 1, 0, 0, 0, 0.01, 0, 1, 0.01, 0, 0, 0.03, 0, 1, 0.03, 0];
    const d = seamDistance(asset, p, 0.06);
    expect(Array.from(d.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(d[4]).toBeCloseTo(0.02, 6);
  });
});

describe('anchorAt', () => {
  it('returns barycentric weights that reproduce the requested chart point', () => {
    const tri = [0, 1, 2, 1, 3, 2];
    const L = [0, 1, 0, 1],
      V = [0, 0, 1, 1];
    const hit = anchorAt(tri, L, V, () => true, 0.7, 0.6)!;
    const ids = tri.slice(hit.tri * 3, hit.tri * 3 + 3);
    const l = ids.reduce((sum, v, k) => sum + L[v] * hit.bary[k], 0),
      v = ids.reduce((sum, i, k) => sum + V[i] * hit.bary[k], 0);
    expect(l).toBeCloseTo(0.7, 9);
    expect(v).toBeCloseTo(0.6, 9);
    expect(anchorAt(tri, L, V, () => true, 3, 3)).toBeUndefined();
  });
});

describe('weaveHeight', () => {
  it('raises ripstop reinforcement threads on a 5 mm grid (8 cells per 4 cm tile)', () => {
    const size = 256,
      cell = size / 8;
    expect(weaveHeight(true, 0, cell / 2, size)).toBeGreaterThan(
      weaveHeight(true, cell / 2, cell / 2, size) + 0.5,
    );
    expect(weaveHeight(true, 3, 7, size)).toBeCloseTo(
      weaveHeight(true, 3 + cell, 7 + cell, size),
      9,
    );
  });
});

describe('sleeveAxis', () => {
  it('points from the armhole row to the cuff row of the shown sleeve', () => {
    // Left sleeve tube along (sin 40deg, -cos 40deg, 0): 5 rows of 6 vertices, v = arc from armhole.
    const dir = [Math.sin((40 * Math.PI) / 180), -Math.cos((40 * Math.PI) / 180), 0];
    const initial: number[] = [],
      uv: number[] = [],
      panels: number[] = [];
    for (let row = 0; row < 5; row++)
      for (let j = 0; j < 6; j++) {
        const a = (2 * Math.PI * j) / 6,
          v = row * 0.1;
        initial.push(0.2 + dir[0] * v, 1.4 + dir[1] * v + 0.05 * Math.cos(a), 0.05 * Math.sin(a));
        uv.push(j * 0.05, v);
        panels.push(4);
      }
    const asset = { panels, render_uv: uv, initial } as unknown as ClothAsset; // fields read only
    const axis = sleeveAxis(asset, 4);
    axis.forEach((x, k) => expect(x).toBeCloseTo(dir[k], 6));
    expect(sleeveAxis(asset, 5)).toEqual([0, -1, 0]); // no right sleeve: fallback
  });
});

describe('cuff tab width (L3)', () => {
  // One sleeve tube: 3 rows of 8 vertices, server u = arc round the ring, v = arc along it.
  function tube(circumference: number, loft: number) {
    const uv: number[] = [],
      panels: number[] = [];
    for (let row = 0; row < 3; row++)
      for (let j = 0; j < 8; j++) {
        uv.push((j * circumference) / 8, row * 0.1);
        panels.push(4);
      }
    uv[uv.length - 2] = circumference; // the ring's wrap vertex carries the full arc
    return {
      panels,
      render_uv: uv,
      initial: [],
      finish: 'glossy_ripstop',
      maximum_loft_m: loft,
    } as unknown as ClothAsset; // fields read only
  }
  it('reads the end ring circumference from the server sleeve u', () => {
    expect(sleeveEndCircumference(tube(0.22, 0.0275), 4)).toBeCloseTo(0.22, 9);
    expect(sleeveEndCircumference(tube(0.22, 0.0275), 5)).toBe(0); // no right sleeve
  });
  it('charts the tab on the inner arc so it measures its photo width on the lofted outside', () => {
    const c = 0.22,
      loft = 0.0275;
    const u = garmentUniformValues(tube(c, loft), 0);
    const inner = u.gTab,
      outer = (inner * (c + 2 * Math.PI * look.cuffTabRelief * loft)) / c;
    expect(outer).toBeCloseTo(look.cuffTabArcM, 9);
    expect(inner).toBeLessThan(look.cuffTabArcM);
  });
});

describe('swooshPullGeometry (L3)', () => {
  it('hangs below its origin and spans the photo-estimated pull', () => {
    const g = swooshPullGeometry();
    g.computeBoundingBox();
    const b = g.boundingBox!;
    const z = detailEstimates.pufferZip;
    expect(b.max.y).toBeLessThanOrEqual(1e-6);
    expect(-b.min.y).toBeCloseTo(0.75 * z.sliderLengthM + z.pullLengthM, 3);
    expect(b.max.x - b.min.x).toBeGreaterThanOrEqual(z.pullWidthM);
    expect(b.max.x - b.min.x).toBeLessThan(z.pullWidthM * 1.4);
  });
});
