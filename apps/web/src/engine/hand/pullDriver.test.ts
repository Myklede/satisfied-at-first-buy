import { describe, expect, it } from 'vitest';
import { ClothSolver, type BodyCollider, type ClothAsset } from '../cloth/ClothSolver';
import { HAND_PULL } from './config';
import { PullDriver } from './pullDriver';
import { selectPatch, vertexAdjacency } from './mapping';

// Synthetic cloth only: a 0.6 m square sheet (1.5 cm grid) lying on a table (plane y = 1).
// Small-steps settings mirror SHELL_CLOTH_CONFIG; material values are uncalibrated.
const N = 41,
  D = 0.015,
  TABLE = 1,
  LIFT = 0.003 + 0.002; // layer_m + collisionMargin

function tableSheet() {
  const rest: number[] = [],
    triangles: number[] = [];
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) rest.push((i - 20) * D, TABLE + LIFT, (j - 20) * D);
  for (let j = 0; j < N - 1; j++)
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i;
      triangles.push(a, a + 1, a + N + 1, a, a + N + 1, a + N);
    }
  const zeros = new Array<number>(N * N).fill(0);
  const asset = {
    key: 'synthetic-table',
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
      substeps: 10,
      iterations: 2,
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
      maxSeconds: 0,
      particleMass: 0.0001,
      bendMaxCorrection: 0.003,
      bendRestEdgeFraction: 0.25,
      velocityLimit: 2,
      collarCompression: 0.9,
      selfEvery: 4,
      surfaceContactPasses: 6,
      surfaceCorrectionLimit: 0.02,
      strainPolishPasses: 24,
      loftMinimumRatio: 0.25,
      loftCompliance: 0.3,
      ringCorrectionLimit: 0.002,
      hardRingContactIterations: 3,
      smallSteps: 1,
      strainLimitPasses: 2,
      hingeCompliance: 1e-3,
      dampingPerSecond: 3,
      guides: 0,
    },
    rest_measurements_cm: {},
    colour: '#ffffff',
    finish: 'satin_matte',
    layer_m: 0.003,
    stretch_max_source: 'synthetic test',
    build_ms: 0,
  } as unknown as ClothAsset;
  const table: BodyCollider = {
    distance(_x, y, _z, gradient) {
      if (gradient) gradient.set([0, 1, 0]);
      return y - TABLE;
    },
  };
  const solver = new ClothSolver(asset, new Float32Array(8).fill(10));
  solver.setCollider(table);
  return { solver, asset };
}

describe('hand pull driver (local region + strain clamp)', () => {
  it('pulls a patch within the fabric limit, keeps the remainder still and springs back', () => {
    const { solver, asset } = tableSheet();
    for (let f = 0; f < 30; f++) solver.step();
    const centre = 20 * N + 20,
      p = solver.positions,
      point = [p[centre * 3], p[centre * 3 + 1], p[centre * 3 + 2]];
    const patch = selectPatch(p, vertexAdjacency(asset.triangles, N * N), [centre], point);
    expect(patch.ids.length).toBeGreaterThan(5);
    const before = p.slice(),
      driver = new PullDriver(solver);
    driver.begin(patch.ids, patch.weights, point);
    const region = solver.activeRegion!;
    expect(region.particles.length).toBeLessThan(N * N);
    const outside = Array.from({ length: N * N }, (_, i) => i).filter(
      (i) => !region.particles.includes(i),
    );
    let worst = -Infinity,
      resisted = false;
    // Lift 10 cm over 0.5 s, hold 1 s (a sheet held at 18 cm cannot follow: it must slip).
    for (let f = 1; f <= 90; f++) {
      driver.setRequest([0, Math.min(1, f / 30) * 0.1, 0]);
      const frame = driver.tick()!;
      worst = Math.max(worst, frame.strain.maxExcess);
      expect(frame.overClamp).toBeLessThanOrEqual(1e-6);
      resisted ||= frame.resisting;
      expect(frame.applied).toBeLessThanOrEqual(frame.requested + 1e-12);
      expect(solver.positions.every(Number.isFinite)).toBe(true);
    }
    expect(worst).toBeLessThanOrEqual(HAND_PULL.strainMargin + 1e-9);
    expect(resisted).toBe(true);
    const lifted = solver.centroid(patch.ids, patch.weights)[1] - point[1];
    expect(lifted).toBeGreaterThan(0.01);
    for (const i of outside)
      for (let a = 0; a < 3; a++) expect(p[i * 3 + a]).toBe(before[i * 3 + a]);
    driver.end();
    let frames = 0;
    while (driver.phase !== 'idle') {
      driver.tick();
      frames++;
      expect(frames).toBeLessThanOrEqual(Math.ceil(HAND_PULL.releaseMaxS * 60) + 1);
    }
    expect(solver.activeRegion).toBeUndefined();
    const back = solver.centroid(patch.ids, patch.weights)[1] - point[1];
    expect(Math.abs(back)).toBeLessThan(0.003);
  });

  it('holds the clamp while the fabric still swings from an earlier release', () => {
    const { solver, asset } = tableSheet();
    for (let f = 0; f < 30; f++) solver.step();
    const centre = 20 * N + 20,
      p = solver.positions,
      point = [p[centre * 3], p[centre * 3 + 1], p[centre * 3 + 2]];
    const patch = selectPatch(p, vertexAdjacency(asset.triangles, N * N), [centre], point);
    const driver = new PullDriver(solver);
    driver.begin(patch.ids, patch.weights, point);
    // Motion the hand did not cause (residual swing after a release, grabbed again before it
    // settled): every other region particle flung 1.5 m/s up, its neighbours down.
    const ids = solver.activeRegion!.particles;
    ids.forEach((id, k) => {
      const v = (k % 2 ? -1 : 1) * 1.5;
      solver.velocity[id * 3 + 1] = v;
      solver.previous[id * 3 + 1] = p[id * 3 + 1] - v * asset.config.dt;
    });
    let held = 0;
    for (let f = 1; f <= 30; f++) {
      driver.setRequest([0, Math.min(1, f / 10) * 0.05, 0]);
      const frame = driver.tick()!;
      expect(frame.overClamp).toBeLessThanOrEqual(1e-6);
      if (frame.applied < frame.requested) held++;
      expect(solver.positions.every(Number.isFinite)).toBe(true);
    }
    expect(held).toBeGreaterThan(0);
  });

  it('rejects patches outside the region and invalid input', () => {
    const { solver } = tableSheet();
    const driver = new PullDriver(solver);
    expect(() => driver.begin([], [], [0, 1, 0])).toThrow();
    expect(() => driver.begin([0], [1], [5, 5, 5])).toThrow(/region|centre/i);
    driver.begin([20 * N + 20], [1], [0, TABLE + LIFT, 0]);
    expect(() => driver.setRequest([NaN, 0, 0])).toThrow();
    driver.setRequest([0, 1, 0]); // capped at maxReachM
    const frame = driver.tick()!;
    expect(frame.requested).toBeCloseTo(HAND_PULL.maxReachM, 12);
    driver.stop();
    expect(driver.tick()).toBeNull();
  });
});
