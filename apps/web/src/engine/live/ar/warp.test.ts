import { describe, expect, it } from 'vitest';
import {
  createGrid,
  gridFieldAt,
  mlsRigid,
  triangleStretch,
  warpGrid,
  warpGridBounded,
  type Control,
  type WarpGrid,
} from './warp';

/** Every grid triangle's map: smallest area ratio and the largest principal-stretch deviation. */
function gridBounds(grid: WarpGrid) {
  const { cols, rows, source: s, target: t } = grid;
  const P = (a: Float32Array, i: number): [number, number] => [a[i * 2], a[i * 2 + 1]];
  let minDet = Infinity,
    worst = 0;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c,
        b = a + 1,
        d = a + cols + 1,
        e = d + 1;
      for (const [i, j, k] of [
        [a, d, b],
        [b, d, e],
      ]) {
        const m = triangleStretch(P(s, i), P(s, j), P(s, k), P(t, i), P(t, j), P(t, k));
        minDet = Math.min(minDet, m.det);
        worst = Math.max(worst, m.s1 - 1, 1 / Math.max(1e-9, m.s2) - 1);
      }
    }
  return { minDet, worst };
}

const square: [number, number][] = [
  [100, 100],
  [300, 100],
  [300, 300],
  [100, 300],
];

describe('rigid MLS warp', () => {
  it('identity controls leave every point in place', () => {
    const controls: Control[] = square.map((p) => ({ p, q: p }));
    const [x, y] = mlsRigid([180, 250], controls);
    expect(x).toBeCloseTo(180, 9);
    expect(y).toBeCloseTo(250, 9);
  });

  it('reproduces a translation and a rotation exactly', () => {
    const t: Control[] = square.map((p) => ({ p, q: [p[0] + 12, p[1] - 7] }));
    const [x, y] = mlsRigid([150, 220], t);
    expect(x).toBeCloseTo(162, 9);
    expect(y).toBeCloseTo(213, 9);
    const a = 0.3,
      c = [200, 200];
    const rot = (p: [number, number]): [number, number] => [
      c[0] + Math.cos(a) * (p[0] - c[0]) - Math.sin(a) * (p[1] - c[1]),
      c[1] + Math.sin(a) * (p[0] - c[0]) + Math.cos(a) * (p[1] - c[1]),
    ];
    const r: Control[] = square.map((p) => ({ p, q: rot(p) }));
    const [rx, ry] = mlsRigid([150, 260], r);
    const [ex, ey] = rot([150, 260]);
    expect(rx).toBeCloseTo(ex, 6);
    expect(ry).toBeCloseTo(ey, 6);
  });

  it('a control maps exactly onto its target', () => {
    const controls: Control[] = [
      ...square.map((p) => ({ p, q: p })),
      { p: [200, 200], q: [210, 195] },
    ];
    expect(mlsRigid([200, 200], controls)).toEqual([210, 195]);
  });

  it('warps a grid with small residuals, and caps local scale when asked too much', () => {
    const grid = createGrid(400, 400, 16, 16);
    const anchors: Control[] = [
      [0, 0],
      [400, 0],
      [400, 400],
      [0, 400],
    ].map((p) => ({ p: p as [number, number], q: p as [number, number] }));
    const gentle = warpGrid(grid, [...anchors, { p: [200, 200], q: [206, 204] }], 0.15);
    expect(gentle.capBound).toBe(false);
    expect(gentle.maxResidualPx).toBeLessThan(0.5);
    const harsh = warpGrid(
      grid,
      [...anchors, { p: [200, 200], q: [200, 200] }, { p: [210, 200], q: [290, 200] }],
      0.15,
    );
    expect(harsh.capBound).toBe(true);
    expect(harsh.kept).toBeLessThan(1);
    expect(harsh.maxScaleChange).toBeLessThanOrEqual(0.15 + 1e-3);
  });
});

describe('bounded local warp (F3, D3)', () => {
  it('triangleStretch reads rotation as rigid, and a flip as a negative area', () => {
    const a: [number, number] = [0, 0],
      b: [number, number] = [10, 0],
      c: [number, number] = [0, 10];
    const r = (p: [number, number]): [number, number] => [-p[1], p[0]]; // 90° rotation
    const rot = triangleStretch(a, b, c, r(a), r(b), r(c));
    expect(rot.det).toBeCloseTo(1, 9);
    expect(rot.s1).toBeCloseTo(1, 9);
    expect(rot.s2).toBeCloseTo(1, 9);
    const flip = triangleStretch(a, b, c, a, [-10, 0], c);
    expect(flip.det).toBeLessThan(0);
    const stretch = triangleStretch(a, b, c, a, [20, 0], c);
    expect(stretch.s1).toBeCloseTo(2, 9);
    expect(stretch.s2).toBeCloseTo(1, 9);
  });

  it('a gentle field passes untouched (keep 1 everywhere, same as the plain warp)', () => {
    const grid = createGrid(400, 400, 16, 16);
    const controls: Control[] = [
      { p: [0, 0], q: [0, 0] },
      { p: [400, 0], q: [400, 0] },
      { p: [400, 400], q: [400, 400] },
      { p: [0, 400], q: [0, 400] },
      { p: [200, 200], q: [206, 204] },
    ];
    const r = warpGridBounded(grid, controls, { stretchCap: 0.15 });
    expect(r.minKept).toBe(1);
    expect(r.badTriangles).toBe(0);
    expect(r.capBound).toBe(false);
    const [x, y] = mlsRigid([100, 250], controls);
    const i = 10 * 17 + 4; // grid vertex (100, 250)
    expect(grid.source[i * 2]).toBeCloseTo(100, 6);
    expect(grid.target[i * 2]).toBeCloseTo(x, 3);
    expect(grid.target[i * 2 + 1]).toBeCloseTo(y, 3);
  });

  it('a folding field (crossed controls) never inverts a triangle and stays within the cap', () => {
    const grid = createGrid(400, 400, 20, 20);
    // Two nearby controls pulled past each other: rigid MLS folds the cells between them.
    const controls: Control[] = [
      { p: [180, 200], q: [260, 200] },
      { p: [220, 200], q: [140, 200] },
      { p: [200, 120], q: [200, 120] },
    ];
    const plain = createGrid(400, 400, 20, 20);
    warpGrid(plain, controls, Infinity);
    expect(gridBounds(plain).minDet).toBeLessThan(0); // the uncapped warp folds
    const r = warpGridBounded(grid, controls, { stretchCap: 0.35 });
    const b = gridBounds(grid);
    expect(r.badTriangles).toBe(0);
    expect(b.minDet).toBeGreaterThan(0);
    expect(b.worst).toBeLessThanOrEqual(0.35 + 1e-3);
    expect(r.minKept).toBeLessThan(1);
    // Far from the fold the warp still follows: the corner region keeps most of its motion.
    expect(gridFieldAt(grid, r.keep, [200, 120])).toBeGreaterThan(0);
  });

  it('attenuates locally: a tear in one place does not freeze the whole layer', () => {
    const grid = createGrid(1600, 800, 48, 24);
    // The frame border is fixed (as in the compositor's glue controls).
    const border: Control[] = [
      [0, 0],
      [800, 0],
      [1600, 0],
      [1600, 400],
      [1600, 800],
      [800, 800],
      [0, 800],
      [0, 400],
    ].map(([x, y]) => ({ p: [x, y] as [number, number], q: [x, y] as [number, number] }));
    const controls: Control[] = [
      ...border,
      // Left: a torso moved by 8 px, which the warp can follow.
      { p: [400, 300], q: [408, 302] },
      { p: [400, 500], q: [408, 502] },
      { p: [550, 400], q: [558, 402] },
      // Right: a wrist pulled 150 px past a fixed elbow (would bind a global cap).
      { p: [1100, 400], q: [1100, 400] },
      { p: [1130, 400], q: [1280, 400] },
    ];
    const global = createGrid(1600, 800, 48, 24);
    const g = warpGrid(global, controls, 0.15);
    const r = warpGridBounded(grid, controls, { stretchCap: 0.15 });
    expect(g.kept).toBeLessThan(0.5);
    expect(r.badTriangles).toBe(0);
    expect(gridFieldAt(grid, r.keep, [400, 400])).toBeGreaterThan(0.95);
    expect(gridFieldAt(grid, r.keep, [1130, 400])).toBeLessThan(0.5);
  });

  it('the keep rises back by at most riseLimit a frame (no popping)', () => {
    const grid = createGrid(400, 400, 16, 16);
    const previous = new Float32Array(17 * 17).fill(0);
    const r = warpGridBounded(
      grid,
      [
        { p: [200, 200], q: [204, 200] },
        { p: [0, 0], q: [0, 0] },
      ],
      {
        stretchCap: 0.15,
        previous,
        riseLimit: 0.25,
      },
    );
    expect(Math.max(...r.keep)).toBeLessThanOrEqual(0.25 + 1e-6);
  });

  it('with the same controls every frame the keep never pumps (rises to the bound, then holds)', () => {
    const controls: Control[] = [
      { p: [0, 0], q: [0, 0] },
      { p: [800, 0], q: [800, 0] },
      { p: [800, 400], q: [800, 400] },
      { p: [0, 400], q: [0, 400] },
      { p: [400, 200], q: [400, 200] },
      { p: [430, 200], q: [560, 200] },
    ];
    const fresh = warpGridBounded(createGrid(800, 400, 32, 16), controls, { stretchCap: 0.35 });
    let previous: Float32Array | null = new Float32Array(33 * 17).fill(0);
    const at: number[] = [];
    for (let frame = 0; frame < 8; frame++) {
      const grid = createGrid(800, 400, 32, 16);
      const r = warpGridBounded(grid, controls, { stretchCap: 0.35, previous });
      expect(r.badTriangles).toBe(0);
      at.push(gridFieldAt(grid, r.keep, [430, 200]));
      previous = r.keep;
    }
    for (let k = 1; k < at.length; k++) expect(at[k]).toBeGreaterThanOrEqual(at[k - 1] - 1e-6);
    expect(at.at(-1)).toBeCloseTo(
      gridFieldAt(createGrid(800, 400, 32, 16), fresh.keep, [430, 200]),
      3,
    );
  });
});
