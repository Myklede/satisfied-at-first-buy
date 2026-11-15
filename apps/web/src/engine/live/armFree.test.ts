// F3 ?f3armfree=1: the body panels bound without arm/clavicle skinning outside the armhole band.
import { describe, expect, it } from 'vitest';
import { parseRig, skinVertices } from '../motion/rig';
import { decodeSatb } from '../motion/satb';
import { fixtureAvailable, fixtureBuffer, fixtureJson } from '../motion/testFixture';
import {
  ARM_FREE,
  armFreeShare,
  bindGarment,
  skinGarment,
  uniqueEdges,
  type ArmFreeOptions,
} from './garmentSkin';
import { createLiveRig, poseDrivers } from './liveRig';

describe('armFreeShare', () => {
  // A strip of 11 particles 2 cm apart along X; the first two are sleeve (panel 4).
  const n = 11;
  const positions = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) positions[i * 3] = 0.02 * i;
  const panels = Array.from({ length: n }, (_, i) => (i < 2 ? 4 : 0));
  const triangles: number[] = [];
  for (let i = 0; i + 2 < n; i++) triangles.push(i, i + 1, i + 2);
  const share = armFreeShare(panels, uniqueEdges(triangles), positions, 0.08);
  it('is 0 on the sleeve and at the seam side, 1 from the band on, monotone between', () => {
    expect(share[0]).toBe(0);
    expect(share[1]).toBe(0);
    // particle 2 is 2 cm from the sleeve: t = 0.25 -> smoothstep 0.15625
    expect(share[2]).toBeCloseTo(0.15625, 5);
    for (let i = 2; i < n - 1; i++) expect(share[i + 1]).toBeGreaterThanOrEqual(share[i]);
    expect(share[5]).toBe(1); // 8 cm
    expect(share[10]).toBe(1);
  });
  it('treats cloth with no path to a sleeve as free', () => {
    const s = armFreeShare([0, 0, 0], uniqueEdges([0, 1, 2]), new Float64Array(9), 0.08);
    expect(Array.from(s)).toEqual([1, 1, 1]);
  });
});

type Cloth = {
  initial: number[];
  panels: number[];
  triangles: number[];
  body_positions: number[];
  paths: Record<string, number[]>;
};

describe.skipIf(!fixtureAvailable('rig.bin', 'cloth-FB-S.json'))('f3armfree binding', () => {
  it('arms hanging = the plain binding; a swinging arm leaves the body panels in place', () => {
    const buffer = fixtureBuffer('rig.bin');
    const rig = parseRig(buffer);
    const header = decodeSatb(buffer, 'rig').header as unknown as { parents: number[] };
    const live = createLiveRig(rig, header.parents);
    const cloth = fixtureJson<Cloth>('cloth-FB-S.json');
    const neutral = poseDrivers(live, rig.neutralPose);
    const skin0 = skinVertices(rig, neutral.drivers, new Float32Array(rig.vertexCount * 3));
    const bind = (free?: ArmFreeOptions) =>
      bindGarment(
        rig,
        neutral.drivers,
        skin0,
        cloth.body_positions,
        cloth.initial,
        cloth.panels,
        cloth.triangles,
        free,
      );
    const hanging = poseDrivers(live, {
      ...rig.neutralPose,
      shoulder_L_elevation: ARM_FREE.referenceElevationDeg,
      shoulder_R_elevation: ARM_FREE.referenceElevationDeg,
    });
    const base = bind(),
      free = bind({ ...ARM_FREE, reference: hanging.drivers });
    // Arms hanging (the reference): exactly the plain binding's jacket.
    const atRef = new Float32Array(free.count * 3),
      baseRef = new Float32Array(free.count * 3);
    skinGarment(free, hanging.drivers, atRef);
    skinGarment(base, hanging.drivers, baseRef);
    let err = 0;
    for (let i = 0; i < atRef.length; i++) err = Math.max(err, Math.abs(atRef[i] - baseRef[i]));
    expect(err).toBeLessThan(1e-5);

    // Arm swing: the left arm out to 90 deg and forward, the right arm raised to 150 deg.
    const swung = poseDrivers(live, {
      ...rig.neutralPose,
      shoulder_L_elevation: 90,
      shoulder_L_plane: 60,
      shoulder_R_elevation: 150,
    });
    const share = armFreeShare(
      cloth.panels,
      uniqueEdges(cloth.triangles),
      free.bound,
      ARM_FREE.bandM,
    );
    const move = (skin: typeof base) => {
      const p = new Float32Array(skin.count * 3);
      skinGarment(skin, swung.drivers, p);
      let maxOut = 0;
      for (let i = 0; i < skin.count; i++) {
        if (cloth.panels[i] > 3 || share[i] < 1) continue; // body panels outside the band
        const d = Math.hypot(
          p[i * 3] - baseRef[i * 3],
          p[i * 3 + 1] - baseRef[i * 3 + 1],
          p[i * 3 + 2] - baseRef[i * 3 + 2],
        );
        maxOut = Math.max(maxOut, d);
      }
      return { p, maxOut };
    };
    const a = move(base),
      b = move(free);
    console.log(
      `f3armfree: body panels outside the band move ${(a.maxOut * 100).toFixed(1)} cm ` +
        `(base) -> ${(b.maxOut * 100).toFixed(2)} cm with an arm swing`,
    );
    expect(a.maxOut).toBeGreaterThan(0.02);
    expect(b.maxOut).toBeLessThan(0.002);
    // The sleeves still follow their arms exactly as before.
    for (let i = 0; i < free.count; i++)
      if (cloth.panels[i] === 4 || cloth.panels[i] === 5)
        expect(Math.abs(b.p[i * 3 + 1] - a.p[i * 3 + 1])).toBeLessThan(1e-4);
    // No tear at the armhole: the cloth edges stretch no more than the plain binding's own
    // (the 150 deg raise already overstretches the LBS underarm, ~18x on its worst sleeve edge).
    const edges = uniqueEdges(cloth.triangles);
    const stretch = (p: Float32Array) => {
      const r: number[] = [];
      for (let e = 0; e < edges.length; e += 2) {
        const [i, j] = [edges[e] * 3, edges[e + 1] * 3];
        const q = free.bound;
        const l0 = Math.hypot(q[i] - q[j], q[i + 1] - q[j + 1], q[i + 2] - q[j + 2]);
        const l1 = Math.hypot(p[i] - p[j], p[i + 1] - p[j + 1], p[i + 2] - p[j + 2]);
        if (l0 > 1e-4) r.push(l1 / l0);
      }
      r.sort((x, y) => x - y);
      return { p99: r[Math.floor(r.length * 0.99)], max: r[r.length - 1] };
    };
    const sa = stretch(a.p),
      sb = stretch(b.p);
    console.log(
      `f3armfree: edge stretch p99/max ${sa.p99.toFixed(2)}/${sa.max.toFixed(1)} (base) -> ` +
        `${sb.p99.toFixed(2)}/${sb.max.toFixed(1)}`,
    );
    expect(sb.p99).toBeLessThan(sa.p99 * 1.1);
    expect(sb.max).toBeLessThan(sa.max * 1.1);
  });
});
