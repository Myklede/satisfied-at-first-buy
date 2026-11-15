import { describe, expect, it } from 'vitest';
import type { ClothAsset } from '../cloth/ClothSolver';
import { expandPositions, findCentreFront, findHoodLine, PANEL, splitSeams } from './seam';
import { pairGaps, weldPairs } from './weld';

/**
 * A small closed "jacket" tube: N columns round the body (CF at angle 0 = +Z, x = 0), R rows
 * from the collar top down, panels as shell.py (front L at +X, front R, back), render_uv
 * u = signed arc from CF. A 3 × 2 "hood" patch hangs from the top row at the back.
 */
function tube(N = 12, R = 5, radius = 0.15): ClothAsset {
  const positions: number[] = [],
    panels: number[] = [],
    uv: number[] = [],
    triangles: number[] = [];
  for (let r = 0; r < R; r++)
    for (let j = 0; j < N; j++) {
      const a = (2 * Math.PI * j) / N,
        x = j === 0 ? 0 : radius * Math.sin(a),
        z = radius * Math.cos(a);
      positions.push(x, 1.5 - r * 0.1, z);
      panels.push(z <= 0 ? PANEL.back : x >= 0 ? PANEL.frontL : PANEL.frontR);
      const signed = a > Math.PI ? a - 2 * Math.PI : a;
      uv.push(signed * radius, r * 0.1);
    }
  const id = (r: number, j: number) => r * N + (j % N);
  for (let r = 0; r + 1 < R; r++)
    for (let j = 0; j < N; j++)
      triangles.push(
        id(r, j),
        id(r, j + 1),
        id(r + 1, j + 1),
        id(r, j),
        id(r + 1, j + 1),
        id(r + 1, j),
      );
  // Hood: two rows above the top row's back columns 5..7 (back: z < 0), sharing row 0.
  const hoodStart = positions.length / 3,
    hoodCols = [5, 6, 7];
  for (let h = 1; h <= 2; h++)
    for (const j of hoodCols) {
      positions.push(positions[id(0, j) * 3], 1.5 + h * 0.08, positions[id(0, j) * 3 + 2] - 0.02);
      panels.push(PANEL.hood);
      uv.push(0.3, -h * 0.08);
    }
  const hid = (h: number, c: number) =>
    h === 0 ? id(0, hoodCols[c]) : hoodStart + (h - 1) * 3 + c;
  for (let h = 0; h < 2; h++)
    for (let c = 0; c < 2; c++)
      triangles.push(
        hid(h, c),
        hid(h, c + 1),
        hid(h + 1, c + 1),
        hid(h, c),
        hid(h + 1, c + 1),
        hid(h + 1, c),
      );
  const n = panels.length;
  // Tethers: root (top row) → child; one crosses the CF in front (col 1 → col 11), one does not.
  const tethers = [id(0, 1), id(3, 11), id(0, 1), id(3, 2), id(0, 6), hoodStart + 4];
  return {
    key: 'tube',
    rest: positions.slice(),
    initial: positions.slice(),
    triangles,
    panels,
    elastic: new Array(n).fill(0),
    stitch: new Array(n).fill(0),
    loft: new Array(n).fill(0.01),
    welds: [],
    tethers,
    tether_lengths: [0.4, 0.3, 0.3],
    render_uv: uv,
    paths: {
      neckline: [...Array.from({ length: N }, (_, j) => id(0, j)), id(0, 0)],
      hem: [...Array.from({ length: N }, (_, j) => id(R - 1, j)), id(R - 1, 0)],
      cuff_L: [1, 2, 3],
    },
    landmarks: {},
    config: { substeps: 10, dt: 1 / 60, selfEvery: 4 },
  } as unknown as ClothAsset;
}

function neighbours(triangles: ArrayLike<number>, count: number) {
  const sets = Array.from({ length: count }, () => new Set<number>());
  for (let t = 0; t < triangles.length; t += 3)
    for (let c = 0; c < 3; c++) {
      const a = triangles[t + c],
        b = triangles[t + ((c + 1) % 3)];
      sets[a].add(b);
      sets[b].add(a);
    }
  return sets;
}

describe('seam split (zip line and hood attachment)', () => {
  it('finds the centre-front chain top to bottom and the hood line round the neck', () => {
    const a = tube();
    expect(findCentreFront(a)).toEqual([0, 12, 24, 36, 48]);
    const line = findHoodLine(a);
    expect(line.sort((x, y) => x - y)).toEqual([5, 6, 7]);
  });

  it('duplicates the CF: the wearer’s right uses the copies, no edge crosses the opened zip', () => {
    const a = tube(),
      split = splitSeams(a, { hood: false }),
      n = a.panels.length;
    expect(split.sourceCount).toBe(n);
    expect(split.asset.panels.length).toBe(n + 5);
    expect(Array.from(split.zip.a)).toEqual([0, 12, 24, 36, 48]);
    expect(Array.from(split.zip.b)).toEqual([n, n + 1, n + 2, n + 3, n + 4]);
    const p = split.asset.initial,
      sets = neighbours(split.asset.triangles, split.asset.panels.length);
    for (let k = 0; k < 5; k++) {
      // Originals touch only the left (x ≥ 0), copies only the right (x ≤ 0).
      for (const j of sets[split.zip.a[k]]) expect(p[j * 3]).toBeGreaterThanOrEqual(0);
      for (const j of sets[split.zip.b[k]]) expect(p[j * 3]).toBeLessThanOrEqual(0);
      expect(sets[split.zip.b[k]].size).toBeGreaterThan(0);
    }
    // Same triangle count and order; per-vertex arrays copied from the source.
    expect(split.asset.triangles.length).toBe(a.triangles.length);
    expect(split.asset.render_uv!.slice(n * 2, n * 2 + 2)).toEqual(a.render_uv!.slice(0, 2));
    // Closed rings crossing the CF are gone; the tether across the CF front is dropped.
    expect(split.asset.paths.neckline).toBeUndefined();
    expect(split.asset.paths.hem).toBeUndefined();
    expect(split.asset.paths.cuff_L).toEqual([1, 2, 3]);
    expect(split.droppedTethers).toBe(1);
    expect(split.asset.tethers).toEqual([1, 38, 6, 12 * 5 + 4]);
    // Arc along the zip from the collar top.
    expect(split.zip.arc[0]).toBe(0);
    expect(split.zip.length).toBeCloseTo(0.4, 9);
    expect(split.asset.key).toBe('tube|split');
  });

  it('detaches the hood: its triangles use copies of the shared top-row vertices', () => {
    const a = tube(),
      split = splitSeams(a, { hood: true }),
      n = a.panels.length;
    expect(split.hood).toBeDefined();
    expect(split.hood!.a.length).toBe(3);
    const sets = neighbours(split.asset.triangles, split.asset.panels.length);
    for (let k = 0; k < 3; k++) {
      const body = split.hood!.a[k],
        hood = split.hood!.b[k];
      expect(hood).toBeGreaterThanOrEqual(n + 5);
      expect(split.asset.panels[hood]).toBe(PANEL.hood);
      for (const j of sets[body]) expect(split.asset.panels[j]).not.toBe(PANEL.hood);
      for (const j of sets[hood]) expect([PANEL.hood]).toContain(split.asset.panels[j]);
    }
    // Hood tethers dropped as well (a detached hood is held by nothing).
    expect(split.droppedTethers).toBe(2);
  });

  it('uses the asset contract paths when present (center_front, hood_zip labelled hood)', () => {
    const a = tube(),
      n = a.panels.length;
    const panels = [...a.panels];
    for (const i of [5, 6, 7]) panels[i] = PANEL.hood;
    const withPaths = {
      ...a,
      panels,
      paths: { ...a.paths, center_front: [48, 36, 24, 12, 0], hood_zip: [5, 6, 7] },
    } as ClothAsset;
    expect(findCentreFront(withPaths)).toEqual([0, 12, 24, 36, 48]);
    expect(findHoodLine(withPaths)).toEqual([5, 6, 7]);
    const split = splitSeams(withPaths, { hood: true }),
      sets = neighbours(split.asset.triangles, split.asset.panels.length);
    for (let k = 0; k < 3; k++) {
      const body = split.hood!.a[k],
        hood = split.hood!.b[k];
      expect(split.asset.panels[body]).toBe(PANEL.collar);
      expect(split.asset.panels[hood]).toBe(PANEL.hood);
      for (const j of sets[body])
        expect(j < n + 5 ? split.asset.panels[j] : -1).not.toBe(PANEL.hood);
    }
    const broken = { ...withPaths, paths: { ...withPaths.paths, center_front: [0, 24, 48] } };
    expect(() => findCentreFront(broken as ClothAsset)).toThrow(/connected/);
  });

  it('expands shell positions into the split numbering', () => {
    const a = tube(),
      split = splitSeams(a, { hood: true }),
      out = expandPositions(split, a.initial);
    for (let i = 0; i < split.source.length; i++)
      for (let c = 0; c < 3; c++) expect(out[i * 3 + c]).toBe(a.initial[split.source[i] * 3 + c]);
  });

  it('refuses a jacket without a zip line instead of faking one', () => {
    const a = tube();
    const noFront = { ...a, panels: a.panels.map(() => PANEL.back) } as ClothAsset;
    expect(() => splitSeams(noFront, { hood: false })).toThrow(/front/);
    expect(() =>
      splitSeams({ ...a, triangles: [] } as unknown as ClothAsset, { hood: true }),
    ).toThrow();
  });
});

describe('weld (zip teeth)', () => {
  it('closed pairs re-weld to their midpoint with one velocity; open pairs stay free', () => {
    const a = tube(),
      split = splitSeams(a, { hood: false }),
      m = split.source.length,
      p = expandPositions(split, a.initial),
      v = new Float64Array(m * 3),
      w = new Float64Array(m).fill(1e4);
    // Open the zip: pull the two sides 2 cm apart along x, moving apart at 0.1 m/s.
    for (let k = 0; k < 5; k++) {
      p[split.zip.a[k] * 3] += 0.01;
      p[split.zip.b[k] * 3] -= 0.01;
      v[split.zip.a[k] * 3] = 0.1;
      v[split.zip.b[k] * 3] = -0.1;
    }
    const closed = new Uint8Array(5);
    closed[3] = closed[4] = 1; // slider at pair 3: the bottom two are closed
    weldPairs({ a: split.zip.a, b: split.zip.b, closed }, p, v, w);
    const gaps = pairGaps(split.zip, p);
    expect(gaps[0]).toBeCloseTo(0.02, 12);
    expect(gaps[3]).toBe(0);
    expect(gaps[4]).toBe(0);
    expect(p[split.zip.a[3] * 3]).toBeCloseTo(0, 12);
    expect(v[split.zip.a[3] * 3]).toBe(v[split.zip.b[3] * 3]);
    expect(v[split.zip.a[3] * 3]).toBeCloseTo(0, 12);
  });

  it('a capped weld approaches at most maxStep per call and stops the separation', () => {
    const p = new Float64Array([0, 0, 0, 0.05, 0, 0]),
      v = new Float64Array([-0.2, 0, 0, 0.2, 0, 0]),
      w = new Float64Array([1, 1]),
      set = { a: Int32Array.of(0), b: Int32Array.of(1), closed: Uint8Array.of(1) };
    const left = weldPairs(set, p, v, w, 0.01);
    expect(p[3] - p[0]).toBeCloseTo(0.04, 12);
    expect(left).toBeCloseTo(0.04, 12);
    // Separating relative velocity removed; no approach velocity is invented.
    expect(v[3] - v[0]).toBeCloseTo(0, 12);
    for (let i = 0; i < 4; i++) weldPairs(set, p, v, w, 0.01);
    expect(p[3] - p[0]).toBeCloseTo(0, 12);
  });

  it('a kinematic side holds: the free copy moves onto it', () => {
    const p = new Float64Array([0, 0, 0, 0.004, 0, 0]),
      v = new Float64Array(6),
      w = new Float64Array([0, 1]);
    weldPairs({ a: Int32Array.of(0), b: Int32Array.of(1), closed: Uint8Array.of(1) }, p, v, w);
    expect(Array.from(p)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
