import { describe, expect, it } from 'vitest';
import { ClothSolver, type ClothAsset } from './ClothSolver';

// Synthetic hinge above a planar collider; no personal data or garment targets.
function hinge(): ClothAsset {
  const values = new Float32Array(4 * 4 * 4);
  for (let x = 0; x < 4; x++)
    for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) values[(x * 4 + y) * 4 + z] = y * 0.007;
  const rest = [0, 1, 0, 0.02, 1, 0, 0, 1.02, 0.01, 0.02, 0.98, 0.01];
  return {
    key: 'synthetic',
    pose: 'test',
    fabric_surface: 'outer',
    maximum_loft_m: 0,
    rest,
    initial: rest.slice(),
    triangles: [0, 1, 2, 1, 0, 3],
    panels: [0, 0, 0, 0],
    elastic: [0, 0, 0, 0],
    stitch: [0, 0, 0, 0],
    loft: [0, 0, 0, 0],
    welds: [],
    paths: {},
    landmarks: {},
    body_landmarks: {},
    body_positions: [],
    body_triangles: [],
    sdf: {
      distance_bias_m: 0,
      origin: [0, 0, 0],
      dimensions: [4, 4, 4],
      spacing: 0.007,
      sdf_id: '0'.repeat(64),
      byte_length: values.byteLength,
    },
    config: {
      dt: 1 / 60,
      substeps: 2,
      iterations: 2,
      gravity: -9.81,
      damping: 0.985,
      stretchCompliance: 1e-8,
      bendCompliance: 2e-4,
      seamBendCompliance: 2e-2,
      elasticCompliance: 2e-5,
      stretchMax: 1.03,
      friction: 0.35,
      collisionMargin: 0.004,
      selfRadius: 0.008,
      kineticEpsilon: 1e-5,
      maxSeconds: 4,
      particleMass: 0.0001,
      bendMaxCorrection: 0.003,
      bendRestEdgeFraction: 0.25,
      velocityLimit: 2,
      collarCompression: 0.9,
      selfEvery: 2,
      surfaceContactPasses: 6,
      surfaceCorrectionLimit: 0.02,
      strainPolishPasses: 24,
      loftMinimumRatio: 0.25,
      loftCompliance: 0.3,
      ringCorrectionLimit: 0.002,
      hardRingContactIterations: 3,
    },
    rest_measurements_cm: {},
    colour: '#ffffff',
    finish: 'satin_matte',
    layer_m: 0,
    stretch_max_source: 'synthetic test',
    build_ms: 0,
  };
}
function solverForHinge() {
  const values = new Float32Array(64);
  for (let x = 0; x < 4; x++)
    for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) values[(x * 4 + y) * 4 + z] = y * 0.007;
  return new ClothSolver(hinge(), values);
}

describe('shared XPBD solver', () => {
  it('derives trilinear SDF gradients from the same corners', () => {
    const solver = solverForHinge(),
      g = new Float64Array(3);
    const point = [0.004, 0.009, 0.012],
      epsilon = 1e-7;
    solver.sampleSdf(point[0], point[1], point[2], g);
    for (let axis = 0; axis < 3; axis++) {
      const p = point.slice();
      p[axis] += epsilon;
      const plus = solver.sampleSdf(p[0], p[1], p[2]);
      p[axis] -= epsilon * 2;
      const minus = solver.sampleSdf(p[0], p[1], p[2]);
      expect(g[axis]).toBeCloseTo((plus - minus) / (2 * epsilon), 5);
    }
  });
  it('matches the signed dihedral gradient to central differences', () => {
    const s = solverForHinge();
    s.positions[11] += 0.005;
    s['angle'](s.positions, 0, true);
    const gradient = s['bendGradient'].slice();
    for (let corner = 0; corner < 4; corner++)
      for (let axis = 0; axis < 3; axis++) {
        const index = s.bends[corner] * 3 + axis,
          epsilon = 1e-7;
        s.positions[index] += epsilon;
        const plus = s['angle'](s.positions, 0);
        s.positions[index] -= 2 * epsilon;
        const minus = s['angle'](s.positions, 0);
        s.positions[index] += epsilon;
        expect(gradient[corner * 3 + axis]).toBeCloseTo((plus - minus) / (2 * epsilon), 4);
      }
  });
  it('is deterministic and finite; grabs move and release real particles', () => {
    const a = solverForHinge(),
      b = solverForHinge();
    for (let i = 0; i < 8; i++) {
      a.step();
      b.step();
    }
    expect(a.positions).toEqual(b.positions);
    expect(a.positions.every(Number.isFinite)).toBe(true);
    a.grab([0], [0.01, 1.01, 0.01]);
    a.step();
    expect(Array.from(a.positions.slice(0, 3))).toEqual([0.01, 1.01, 0.01]);
    a.move([0], [0.02, 1.02, 0.02]);
    a.step();
    expect(a.positions[0]).toBe(0.02);
    a.release();
    expect(a.inverseMass[0]).toBeGreaterThan(0);
    expect(() => a.grab([500], [0, 0, 0])).toThrow('Invalid particle');
  });
  it('keeps hardware offsets out of the physical cloth dynamics', () => {
    const make = (relief: number) => {
      const asset = hinge();
      asset.fabric_surface = 'neutral';
      asset.triangles = [0, 1, 2];
      asset.panels[3] = 8;
      asset.rest = [0, 1, 0, 0.02, 1, 0, 0, 1.02, 0, 0.01, 1.01, relief];
      asset.initial = asset.rest.slice();
      asset.attachments = [3, 0, 1, 2];
      asset.attachment_offsets = [0.01, 0.01, relief];
      return new ClothSolver(asset, new Float32Array(64).fill(1));
    };
    const a = make(0.003),
      b = make(0.3);
    for (let i = 0; i < 20; i++) {
      a.step();
      b.step();
    }
    expect(a.positions.slice(0, 9)).toEqual(b.positions.slice(0, 9));
    expect(a.energy).toBe(b.energy);
    expect(a.positions[11]).not.toBe(b.positions[11]);
  });
  it('bounds a free ring circumference without translating its centre or inflating compression', () => {
    const asset = hinge();
    asset.fabric_surface = 'neutral';
    asset.paths.neckline = [0, 1, 2, 0];
    const s = new ClothSolver(asset, new Float32Array(64).fill(1));
    const centre = [0, 1, 2].map(
      (k) => (s.positions[k] + s.positions[k + 3] + s.positions[k + 6]) / 3,
    );
    for (let i = 0; i < 9; i++)
      s.positions[i] = centre[i % 3] + (s.positions[i] - centre[i % 3]) * 2;
    s['constrainRings'](1 / 120);
    const after = [0, 1, 2].map(
      (k) => (s.positions[k] + s.positions[k + 3] + s.positions[k + 6]) / 3,
    );
    after.forEach((v, k) => expect(v).toBeCloseTo(centre[k], 12));
    const p = s.positions.slice();
    s['constrainRings'](1 / 120);
    s.positions.forEach((value, i) => expect(value).toBeCloseTo(p[i], 12));
  });
});
