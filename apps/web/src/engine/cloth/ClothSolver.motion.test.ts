import { describe, expect, it } from 'vitest';
import { ClothSolver, type BodyCollider, type ClothAsset } from './ClothSolver';
import { MOTION_FIT } from '../motion/config';

// Synthetic cloth only (no body or garment data): the motion-bake solver settings (agent S2,
// docs/STATUS.md "Cloth physics pass 2"). Material values are uncalibrated.
const SHELL = {
  smallSteps: 1,
  substeps: 10,
  iterations: 2,
  strainLimitPasses: 2,
  oneWayTethers: 1,
  hingeCompliance: 1e-3,
  dampingPerSecond: 3,
  guides: 0,
  selfEvery: 4,
  gravity: 0,
};

/** Closed tube around the Z axis: `around` columns × `rows` rings, radius r, ring spacing d. */
function tube(around: number, rows: number, r: number, d: number, config: Record<string, number>) {
  const rest: number[] = [],
    triangles: number[] = [],
    index = (i: number, j: number) => j * around + (i % around);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < around; i++) {
      const t = (i / around) * Math.PI * 2;
      rest.push(r * Math.cos(t), r * Math.sin(t), j * d);
    }
  for (let j = 0; j < rows - 1; j++)
    for (let i = 0; i < around; i++)
      triangles.push(
        index(i, j),
        index(i + 1, j),
        index(i + 1, j + 1),
        index(i, j),
        index(i + 1, j + 1),
        index(i, j + 1),
      );
  const n = around * rows,
    zeros = new Array<number>(n).fill(0);
  const asset = {
    key: 'synthetic-tube',
    pose: 'test',
    fabric_surface: 'neutral',
    maximum_loft_m: 0,
    rest,
    initial: rest.slice(),
    triangles,
    panels: zeros.slice(),
    elastic: zeros.slice(),
    stitch: zeros.slice(),
    loft: zeros.slice(),
    welds: [],
    tethers: [],
    tether_lengths: [],
    paths: {},
    landmarks: {},
    body_landmarks: {},
    body_positions: [],
    body_triangles: [],
    sdf: {
      distance_bias_m: 0,
      origin: [-5, -5, -5],
      dimensions: [2, 2, 2],
      spacing: 10,
      sdf_id: '0'.repeat(64),
      byte_length: 32,
    },
    config: {
      dt: 1 / 60,
      substeps: 2,
      iterations: 1,
      gravity: -9.81,
      damping: 0.985,
      stretchCompliance: 1e-8,
      bendCompliance: 2e-4,
      seamBendCompliance: 2e-2,
      elasticCompliance: 2e-5,
      stretchMax: 1.03,
      friction: 0.35,
      collisionMargin: 0.002,
      selfRadius: 0.001,
      kineticEpsilon: 1e-5,
      maxSeconds: 1.5,
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
      ...config,
    },
    rest_measurements_cm: {},
    colour: '#ffffff',
    finish: 'satin_matte',
    layer_m: 0.003,
    stretch_max_source: 'synthetic test',
    build_ms: 0,
  } as unknown as ClothAsset;
  return new ClothSolver(asset, new Float32Array(8).fill(10));
}

/** Infinite cylinder of radius `radius()` around the Z axis (the posed "arm"). */
function cylinder(radius: () => number, motionBound?: () => number): BodyCollider {
  return {
    distance(x, y, _z, gradient) {
      const l = Math.hypot(x, y) || 1e-12;
      if (gradient) gradient.set([x / l, y / l, 0]);
      return l - radius();
    },
    get motionBound() {
      return motionBound?.();
    },
  };
}

function maxRatio(s: ClothSolver) {
  let worst = 0;
  const p = s.positions;
  for (let e = 0; e < s.restLengths.length; e++) {
    const a = s.edges[e * 2] * 3,
      b = s.edges[e * 2 + 1] * 3;
    worst = Math.max(
      worst,
      Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]) / s.restLengths[e],
    );
  }
  return worst;
}

describe('motion-bake solver settings', () => {
  // A 4 cm sleeve tube on a limb that swells from 3 cm to 4 cm radius: with the 0.5 cm contact
  // clearance the tube would need 1.125× its rest circumference (a garment too small for the
  // posed body: the S bicep has −0.2 cm inner ease). Contact projected last always wins.
  const grow = (config: Record<string, number>, swell = 0.01) => {
    const s = tube(32, 12, 0.04, 0.01, config);
    let r = 0.03;
    const limb = cylinder(() => r);
    for (let f = 0; f < 60; f++) {
      r = 0.03 + swell * Math.min(1, f / 30);
      s.setCollider(limb);
      s.step();
    }
    let deepest = 0;
    for (let i = 0; i < s.positions.length; i += 3)
      deepest = Math.max(deepest, r - Math.hypot(s.positions[i], s.positions[i + 1]));
    return { ratio: maxRatio(s), deepest, finite: s.positions.every(Number.isFinite) };
  };

  it('root cause: with contact projected last a too-small sleeve stretches far past 10 %', () => {
    // Measured 1.21 (and 1.46 for a 1.5 cm swell).
    expect(grow(SHELL).ratio).toBeGreaterThan(1.15);
  });

  it('motion settings: the fabric limit wins, the limb sinks in at most the hard floor', () => {
    const { ratio, deepest, finite } = grow({ ...SHELL, ...MOTION_FIT.solver });
    expect(finite).toBe(true);
    expect(ratio).toBeLessThanOrEqual(1.1); // measured 1.09
    // Cloth mid-surface never deeper than |contactHardMin| (+ the margin and layer it targets).
    expect(deepest).toBeLessThanOrEqual(-MOTION_FIT.solver.contactHardMin + 0.0105);
    // An extreme 1.5 cm swell still stretches (contactCompliance 0.3 trades this for grip):
    // measured 1.19 vs 1.46 with the static settings.
    expect(grow({ ...SHELL, ...MOTION_FIT.solver }, 0.015).ratio).toBeLessThan(1.25);
  });

  it('a re-posed collider with a motion bound keeps contact conservative (no deep penetration)', () => {
    const run = (bounded: boolean) => {
      const s = tube(24, 6, 0.04, 0.01, { ...SHELL, ...MOTION_FIT.solver, contactPlaneRadius: 0 });
      let r = 0.02,
        step = 0;
      const collider = cylinder(() => r, bounded ? () => (step ? 0.002 : 0) : undefined);
      for (step = 0; step < 40; step++) {
        r = Math.min(0.034, 0.02 + 0.002 * step);
        s.setCollider(collider);
        s.step();
      }
      return s.positions;
    };
    const bounded = run(true),
      reset = run(false);
    for (let i = 0; i < bounded.length; i += 3)
      expect(Math.hypot(bounded[i], bounded[i + 1])).toBeGreaterThan(0.034 - 0.0045);
    // Same contact outcome as re-querying everything (slack only skips particles it proves clear).
    for (let i = 0; i < bounded.length; i++) expect(bounded[i]).toBeCloseTo(reset[i], 6);
  });

  it('setCuffPaths validates its input', () => {
    const s = tube(8, 3, 0.04, 0.01, SHELL);
    expect(s.cuffPathNames).toEqual([]);
    expect(() => s.setCuffPaths([new Float64Array(3)])).toThrow('Cuff path count mismatch');
  });
});
