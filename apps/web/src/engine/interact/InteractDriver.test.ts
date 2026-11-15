import { describe, expect, it } from 'vitest';
import { ClothSolver, type ClothAsset } from '../cloth/ClothSolver';
import { selectPatch, vertexAdjacency } from '../hand/mapping';
import { fixtureAvailable, fixtureBuffer, fixtureJson } from '../motion/testFixture';
import { HOOD_DEFAULT } from './config';
import { InteractDriver, rotationBetween } from './InteractDriver';
import { PANEL } from './seam';
import { pairGaps } from './weld';

/** FNV-1a over the bytes of a float64 array (bit identity). */
function fnv(values: Float64Array) {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);
  return hash >>> 0;
}

function settledBase(size: string) {
  const asset = fixtureJson<ClothAsset>(`cloth-DQ-${size}.json`);
  const grid = new Float32Array(fixtureBuffer(`sdf-${asset.sdf.sdf_id}.bin`));
  const base = new ClothSolver(asset, grid);
  base.positions.set(asset.initial);
  base.previous.set(asset.initial);
  for (let f = 0; f < 20; f++) base.step();
  return base;
}

// Real puffer shell (DQ4920-206, P2 fixture): the zip opens and closes, the hood comes off and
// goes back on, and the measured (base) solver is never touched.
describe.skipIf(!fixtureAvailable('cloth-DQ-S.json'))(
  'interactive zip and hood on the shell',
  () => {
    it('opens the zip to the hem, re-welds it, and leaves the base solver bit-identical', () => {
      const base = settledBase('S'),
        before = fnv(base.positions),
        beforePrev = fnv(base.previous),
        drv = new InteractDriver(base, { hood: true }),
        s = drv.solver,
        zip = drv.split.zip;
      expect(zip.a.length).toBeGreaterThan(30);
      drv.setSlider(10);
      let last = drv.tick(() => 0);
      for (let f = 0; f < 90; f++) last = drv.tick(() => 0);
      expect(last.openTeeth).toBe(zip.a.length);
      // The fronts separated (the collar top flares; measured 5–8 cm on S/M).
      expect(last.maxGapM).toBeGreaterThan(0.02);
      expect(last.restful).toBe(false);
      drv.setSlider(0);
      for (let f = 0; f < 120; f++) last = drv.tick(() => 0);
      expect(last.openTeeth).toBe(0);
      const gaps = pairGaps(zip, s.positions);
      expect(Math.max(...gaps)).toBeLessThan(1e-9);
      expect(s.positions.every(Number.isFinite)).toBe(true);
      expect(fnv(base.positions)).toBe(before);
      expect(fnv(base.previous)).toBe(beforePrev);
    }, 120000);

    it('pulls the hood off (detached, held where let go) and zips it back on', () => {
      const base = settledBase('S'),
        before = fnv(base.positions),
        drv = new InteractDriver(base, { hood: true }),
        s = drv.solver,
        p = s.positions,
        homePositions = p.slice();
      let seed = -1;
      for (let i = 0; i < s.panels.length; i++)
        if (
          drv.split.asset.panels[i] === PANEL.hood &&
          (seed < 0 || p[i * 3 + 2] < p[seed * 3 + 2])
        )
          seed = i;
      const point = [p[seed * 3], p[seed * 3 + 1], p[seed * 3 + 2]];
      expect(point.every(Number.isFinite)).toBe(true);
      const adjacency = vertexAdjacency(drv.split.asset.triangles, s.panels.length);
      const patch = selectPatch(p, adjacency, [seed], point, 0.03);
      drv.grabBegin('hood', patch.ids, patch.weights);
      let f = drv.tick(() => 0);
      for (let k = 1; k <= 60; k++) {
        drv.grabMove([0, 0.1 * Math.min(1, k / 30), -0.3 * Math.min(1, k / 30)]);
        f = drv.tick(() => 0);
      }
      expect(f.hood).toBe('detached');
      expect(f.hoodProgress).toBe(1);
      // Semi-rigid: the hood keeps its shape (pairwise distances), it is not free cloth.
      const hood: number[] = [];
      for (let i = 0; i < s.panels.length; i++)
        if (drv.split.asset.panels[i] === PANEL.hood) hood.push(i);
      const dist = (q: ArrayLike<number>, i: number, j: number) =>
        Math.hypot(q[i * 3] - q[j * 3], q[i * 3 + 1] - q[j * 3 + 1], q[i * 3 + 2] - q[j * 3 + 2]);
      let worst = 0;
      for (let k = 0; k < hood.length; k += 7) {
        const i = hood[k],
          j = hood[(k * 13 + 5) % hood.length];
        worst = Math.max(worst, Math.abs(dist(p, i, j) - dist(homePositions, i, j)));
      }
      expect(worst).toBeLessThan(1e-9);
      // Taking the hood off does not drag the jacket along (no cloth is welded to it).
      let body = 0;
      for (let i = 0; i < s.panels.length; i++)
        if (drv.split.asset.panels[i] !== PANEL.hood)
          body = Math.max(body, Math.abs(p[i * 3 + 1] - homePositions[i * 3 + 1]));
      expect(body).toBeLessThan(0.03);
      // The frame's rigid transform (for H's authored hood) maps the hood's home onto it.
      const M = f.hoodMatrix!;
      for (const i of [hood[0], hood[hood.length >> 1]])
        for (let r = 0; r < 3; r++) {
          const x = homePositions,
            q = M[r * 4] * x[i * 3] + M[r * 4 + 1] * x[i * 3 + 1] + M[r * 4 + 2] * x[i * 3 + 2];
          expect(q + M[r * 4 + 3]).toBeCloseTo(p[i * 3 + r], 9);
        }
      expect(Math.hypot(p[seed * 3] - point[0], p[seed * 3 + 2] - point[2])).toBeGreaterThan(0.1);
      drv.grabEnd();
      f = drv.tick(() => 0);
      expect(f.hooked).toBe(true);
      // Let go fully off, it is set down beside the jacket at hip height (not in mid-air).
      for (let k = 0; k < 90; k++) f = drv.tick(() => 0);
      {
        let hx = 0,
          hy = 0,
          minX = Infinity,
          minY = Infinity,
          n = 0;
        for (let i = 0; i < s.panels.length; i++)
          if (drv.split.asset.panels[i] === PANEL.hood) {
            hx += p[i * 3];
            hy += p[i * 3 + 1];
            n++;
          } else {
            minX = Math.min(minX, homePositions[i * 3]);
            minY = Math.min(minY, homePositions[i * 3 + 1]);
          }
        expect(hx / n).toBeLessThan(minX);
        expect(hy / n).toBeLessThan(minY + 0.3);
      }
      // Bring it back from where it rests: the hand moves it by the opposite of its offset.
      const off = [...f.hoodHand];
      const again = [p[seed * 3], p[seed * 3 + 1], p[seed * 3 + 2]];
      const patch2 = selectPatch(p, adjacency, [seed], again, 0.03);
      drv.grabBegin('hood', patch2.ids, patch2.weights);
      for (let k = 1; k <= 90; k++) {
        const t = Math.min(1, k / 45);
        drv.grabMove([-off[0] * t, -off[1] * t, -off[2] * t]);
        f = drv.tick(() => 0);
      }
      expect(f.hood).toBe('attached');
      expect(f.hoodProgress).toBe(0);
      drv.grabEnd();
      for (let k = 0; k < 30; k++) f = drv.tick(() => 0);
      expect(f.hooked).toBe(false);
      expect(s.positions.every(Number.isFinite)).toBe(true);
      expect(fnv(base.positions)).toBe(before);
    }, 120000);
  },
);

describe.skipIf(!fixtureAvailable('cloth-DQ-S.json'))('hood default off-resting', () => {
  it('starts the hood off beside the right foot and zips it back on from there', () => {
    expect(HOOD_DEFAULT).toBe('attached'); // the user decides later (config.ts)
    const base = settledBase('S'),
      before = fnv(base.positions),
      drv = new InteractDriver(base, { hood: true }),
      s = drv.solver,
      p = s.positions,
      panels = drv.split.asset.panels;
    drv.setHoodOff();
    let f = drv.tick(() => 0);
    expect(f.hood).toBe('detached');
    expect(f.hooked).toBe(true);
    expect(f.hoodProgress).toBe(1);
    let hx = 0,
      minX = Infinity,
      n = 0;
    for (let i = 0; i < panels.length; i++)
      if (panels[i] === PANEL.hood) {
        hx += p[i * 3];
        n++;
      } else minX = Math.min(minX, p[i * 3]);
    expect(hx / n).toBeLessThan(minX); // beside the wearer's right (−X), clear of the jacket
    // The judge picks it up and brings it back to the collar.
    const off = [...f.hoodHand],
      seed = panels.indexOf(PANEL.hood);
    drv.grabBegin('hood', [seed], [1]);
    for (let k = 1; k <= 90; k++) {
      const t = Math.min(1, k / 45);
      drv.grabMove([-off[0] * t, -off[1] * t, -off[2] * t]);
      f = drv.tick(() => 0);
    }
    expect(f.hood).toBe('attached');
    drv.grabEnd();
    f = drv.tick(() => 0);
    expect(f.hooked).toBe(false);
    expect(fnv(base.positions)).toBe(before);
  }, 120000);
});

describe('rotationBetween', () => {
  it('turns a onto b and keeps lengths (Rodrigues)', () => {
    const R = rotationBetween([1, 0, 0], [0, 2, 0]);
    const apply = (v: number[]) =>
      [0, 1, 2].map((r) => R[r * 3] * v[0] + R[r * 3 + 1] * v[1] + R[r * 3 + 2] * v[2]);
    const out = apply([1, 0, 0]);
    expect(out[0]).toBeCloseTo(0, 12);
    expect(out[1]).toBeCloseTo(1, 12);
    expect(Math.hypot(...apply([0.3, -0.2, 0.9]))).toBeCloseTo(Math.hypot(0.3, -0.2, 0.9), 12);
    expect(rotationBetween([0, 0, 1], [0, 0, 3])).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});
