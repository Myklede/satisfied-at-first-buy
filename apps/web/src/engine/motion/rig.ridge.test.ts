// Shoulder-ridge transfer in the TS skinning (rig.ts; mirrors services/body/body_service/motion/
// ridge.py). Synthetic two-vertex rig: drivers 0/1 = clavicle/upper arm L, 2/3 = R.
import { describe, expect, it } from 'vitest';
import {
  DRIVER_STRIDE,
  ridgeFactors,
  skinVertices,
  vertexBlend,
  type MotionRig,
  type RidgeTransfer,
} from './rig';

const rest = Float32Array.from([0.1, 1.5, 0, -0.1, 1.5, 0.05]);
function makeRig(ridged: boolean): MotionRig {
  const ridge: RidgeTransfer = {
    vertices: Uint32Array.from([0, 1]),
    mask: Float32Array.from([1, 0.5]),
    upperWeight: Float32Array.from([0.5, 0.5]),
    side: Uint8Array.from([0, 1]),
    upperDriver: [1, 3],
    clavicleDriver: [0, 2],
    humerusRest: [
      [0, -1, 0],
      [0, -1, 0],
    ],
    rampDeg: [90, 180],
    slot: Int32Array.from([0, 1]),
  };
  // Only the fields the skinning reads; the rest of MotionRig is irrelevant here.
  return {
    influences: 2,
    vertexCount: 2,
    restVertices: rest,
    skinWeights: Float32Array.from([0.5, 0.5, 0.5, 0.5]),
    vertexDrivers: Uint8Array.from([0, 1, 2, 3]),
    ...(ridged ? { ridge } : {}),
  } as unknown as MotionRig;
}

/** Four drivers: identity except the upper arms, rotated about Z by the given angles (deg). */
function drivers(upperL: number, upperR: number) {
  const m = new Float64Array(4 * DRIVER_STRIDE);
  for (let d = 0; d < 4; d++) {
    const a = d === 1 ? upperL : d === 3 ? upperR : 0;
    const c = Math.cos((a * Math.PI) / 180),
      s = Math.sin((a * Math.PI) / 180);
    m.set([c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0], d * DRIVER_STRIDE);
  }
  return m;
}

describe('shoulder-ridge transfer (TS skinning)', () => {
  it('factor is 0 up to 90 degrees, smoothstep to 1 at 180', () => {
    const ridge = makeRig(true).ridge!;
    expect(ridgeFactors(ridge, drivers(0, 0))).toEqual([0, 0]);
    expect(ridgeFactors(ridge, drivers(90, -60))).toEqual([0, 0]);
    const [l, r] = ridgeFactors(ridge, drivers(135, -180));
    expect(l).toBeCloseTo(0.5, 12);
    expect(r).toBeCloseTo(1, 12);
  });

  it('is bit-identical to plain LBS while the arms are at or below 90 degrees', () => {
    for (const m of [drivers(0, 0), drivers(45, -90)]) {
      const plain = skinVertices(makeRig(false), m, new Float64Array(6));
      const ridged = skinVertices(makeRig(true), m, new Float64Array(6));
      expect(Array.from(ridged)).toEqual(Array.from(plain));
    }
  });

  it('moves the masked share of the upper-arm weight to the clavicle', () => {
    const m = drivers(180, -180); // both humeri straight up: factor 1
    const out = skinVertices(makeRig(true), m, new Float64Array(6));
    // Vertex 0: mask 1 × weight 0.5 → all weight on the (identity) clavicle: stays at rest.
    for (let a = 0; a < 3; a++) expect(out[a]).toBeCloseTo(rest[a], 6);
    // Vertex 1: mask 0.5 → weights clavicle 0.75, upper arm 0.25 (upper arm = rotation by 180°).
    const x = rest[3],
      y = rest[4],
      z = rest[5];
    expect(out[3]).toBeCloseTo(0.75 * x + 0.25 * -x, 6);
    expect(out[4]).toBeCloseTo(0.75 * y + 0.25 * -y, 6);
    expect(out[5]).toBeCloseTo(z, 6);
  });

  it('the ids path and vertexBlend agree with the full skin', () => {
    const rig = makeRig(true);
    const m = drivers(150, -120);
    const full = skinVertices(rig, m, new Float64Array(6));
    const sub = skinVertices(rig, m, new Float64Array(6), [1, 0]);
    expect(Array.from(sub)).toEqual([...full.slice(3, 6), ...full.slice(0, 3)]);
    const blend = new Float64Array(12);
    for (let v = 0; v < 2; v++) {
      vertexBlend(rig, v, m, blend);
      for (let a = 0; a < 3; a++) {
        const p =
          blend[a * 4] * rest[v * 3] +
          blend[a * 4 + 1] * rest[v * 3 + 1] +
          blend[a * 4 + 2] * rest[v * 3 + 2] +
          blend[a * 4 + 3];
        expect(p).toBeCloseTo(full[v * 3 + a], 12);
      }
    }
  });
});
