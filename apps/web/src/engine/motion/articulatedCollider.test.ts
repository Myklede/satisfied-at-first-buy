import { describe, expect, it } from 'vitest';
import {
  ArticulatedCollider,
  closestOnTriangle,
  elbowZones,
  parseArticulatedSdf,
} from './articulatedCollider';
import { MOTION_FIT } from './config';
import { frameMatrices, parseFrames, parseRig } from './rig';
import { fixtureAvailable, fixtureBuffer, fixtureJson } from './testFixture';

describe('closest point on a triangle', () => {
  const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0] as const;
  const at = (x: number, y: number, z: number) => {
    const out = new Float64Array(6);
    const region = closestOnTriangle(x, y, z, ...tri, out);
    return { region, point: Array.from(out.slice(0, 3)), bary: Array.from(out.slice(3)) };
  };
  it('face interior', () => {
    const r = at(0.2, 0.3, 0.5);
    expect(r.region).toBe(0);
    r.point.forEach((v, i) => expect(v).toBeCloseTo([0.2, 0.3, 0][i], 12));
    expect(r.bary[0] + r.bary[1] + r.bary[2]).toBeCloseTo(1, 12);
  });
  it('vertices and edges', () => {
    expect(at(-1, -1, 0).region).toBe(1);
    expect(at(2, -0.5, 0).region).toBe(2);
    expect(at(-0.5, 2, 0).region).toBe(3);
    expect(at(0.5, -1, 0).region).toBe(4);
    expect(at(1, 1, 0).region).toBe(5);
    expect(at(-1, 0.5, 0).region).toBe(6);
    expect(at(1, 1, 0).point[0]).toBeCloseTo(0.5, 12);
  });
});

type Reference = {
  cases: {
    motion: string;
    frame: number;
    points: number[][];
    offset_m: number[];
    rigid: (number | null)[];
    zone: (number | null)[];
    distance: number[];
  }[];
};

describe.skipIf(!fixtureAvailable('rig.bin', 'sdf.bin', 'ref-distance.json'))(
  "articulated collider vs P1's collision.body_distance",
  () => {
    const rig = parseRig(fixtureBuffer('rig.bin'));
    // The Python reference uses P1's zone exactly (no elbow rings).
    const sdf = parseArticulatedSdf(fixtureBuffer('sdf.bin'), rig, 0);
    const reference = fixtureJson<Reference>('ref-distance.json');
    for (const c of reference.cases)
      it(`${c.motion} frame ${c.frame}: matches the reference within 0.01 mm`, () => {
        const frames = parseFrames(fixtureBuffer(`frames-${c.motion}.bin`), rig.drivers.length);
        const collider = new ArticulatedCollider(sdf, rig).setFrame(
          frameMatrices(frames, c.frame, new Float64Array(216)),
        );
        let exact = 0;
        const explained = { cap: 0, selfIntersection: 0 };
        c.points.forEach(([x, y, z], i) => {
          const value = collider.exactDistance(x, y, z);
          if (Math.abs(value - c.distance[i]) < 1e-5) exact++;
          // Documented, deliberate differences (see docs/STATUS.md, Fit in motion):
          // 1. beyond the 6 cm zone search the TS returns the lower bound 6 cm;
          else if (value === MOTION_FIT.zoneSearchMaxM && c.distance[i] > value) explained.cap++;
          // 2. inside self-intersecting LBS skin (forearm over chest, seated hip crease) the
          //    reference takes a farther negative zone distance; the TS search is bounded by the
          //    rigid core distance and returns that core's (positive) value.
          else if (c.zone[i] !== null && c.zone[i]! < 0 && Math.abs(value - c.rigid[i]!) < 1e-5)
            explained.selfIntersection++;
          else throw new Error(`Point ${i}: TS ${value} vs Python ${c.distance[i]}`);
        });
        expect(exact / c.points.length).toBeGreaterThan(0.97);
      });
    it('gradient agrees with finite differences; cache error p95 < 0.05 mm', () => {
      const c = reference.cases[0];
      const frames = parseFrames(fixtureBuffer(`frames-${c.motion}.bin`), rig.drivers.length);
      const collider = new ArticulatedCollider(sdf, rig).setFrame(
        frameMatrices(frames, c.frame, new Float64Array(216)),
      );
      const g = new Float64Array(3);
      let agree = 0;
      const cacheErrors: number[] = [];
      c.points.slice(0, 400).forEach(([x, y, z]) => {
        const d = collider.distance(x, y, z, g, 1);
        const h = 1e-4;
        const fd = [0, 1, 2].map((k) => {
          const p = [x, y, z];
          p[k] += h;
          const a = collider.exactDistance(p[0], p[1], p[2]);
          p[k] -= 2 * h;
          return (a - collider.exactDistance(p[0], p[1], p[2])) / (2 * h);
        });
        const cos =
          (g[0] * fd[0] + g[1] * fd[1] + g[2] * fd[2]) /
          (Math.hypot(g[0], g[1], g[2]) * Math.hypot(fd[0], fd[1], fd[2]));
        if (cos > 0.9) agree++;
        // A repeat query 0.5 mm away hits the linearised cache.
        const moved = collider.distance(x + 0.0005, y, z, g, 1);
        cacheErrors.push(Math.abs(moved - collider.exactDistance(x + 0.0005, y, z)));
        void d;
      });
      expect(agree / 400).toBeGreaterThan(0.97);
      cacheErrors.sort((a, b) => a - b);
      // Rare larger errors sit where P1's field itself is discontinuous (a zone point switching
      // to border-rejected): the linearisation cannot see the jump within 1 mm.
      const q = (f: number) => cacheErrors[Math.floor(cacheErrors.length * f)];
      console.log(
        'cache error mm: median/p95/p99/max',
        [0.5, 0.95, 0.99].map((f) => (q(f) * 1000).toFixed(4)).join('/'),
        (cacheErrors.at(-1)! * 1000).toFixed(3),
      );
      expect(q(0.95)).toBeLessThan(5e-5);
      expect(q(0.99)).toBeLessThan(5e-4);
    });
  },
);

describe.skipIf(!fixtureAvailable('rig.bin', 'sdf.bin'))('elbow zone rings (D2, E5)', () => {
  it('keeps P1 faces first, adds rings only around the two elbows, and opens their old borders', () => {
    const rig = parseRig(fixtureBuffer('rig.bin'));
    const p1 = parseArticulatedSdf(fixtureBuffer('sdf.bin'), rig, 0);
    const e5 = parseArticulatedSdf(fixtureBuffer('sdf.bin'), rig, MOTION_FIT.elbowZoneRings);
    const original = Uint32Array.from(p1.zoneFaces, (v) => p1.zoneVertices[v]);
    const elbows = elbowZones(original, rig);
    expect(elbows).toHaveLength(2);
    expect(e5.zoneFaces.length).toBeGreaterThan(p1.zoneFaces.length);
    expect(
      Array.from(e5.zoneFaces.slice(0, p1.zoneFaces.length), (v) => e5.zoneVertices[v]),
    ).toEqual(Array.from(original));
    // Every P1 border vertex of an elbow zone is interior in the extended zone.
    const local = new Map(Array.from(e5.zoneVertices, (v, i) => [v, i]));
    const elbow = new Set(elbows.flat());
    let opened = 0;
    p1.zoneVertices.forEach((v, i) => {
      if (!p1.borderVertex[i] || !elbow.has(v)) return;
      if (!e5.borderVertex[local.get(v)!]) opened++;
    });
    expect(opened).toBeGreaterThan(0);
  });
});
