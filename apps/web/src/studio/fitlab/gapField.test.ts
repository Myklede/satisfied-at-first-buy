import { describe, expect, it } from 'vitest';
import type { BodyCollider } from '../../engine/cloth/collider';
import {
  bandShares,
  bindNearest,
  bodyRegions,
  gapParams,
  GapFieldError,
  LiveGapField,
  normalDistances,
  particleRegion,
  restOuterDistances,
  solverGapCm,
} from './gapField';

const P = { layerM: 0.004, loftMinimumRatio: 0.5, collisionMargin: 0.001, neutralSurface: false };

describe('solver gap formula (ClothSolver.snapshot)', () => {
  it('loose particle: the full loft counts, gap = outer − loft − layer', () => {
    // outer 5 cm, loft 1 cm: effective = min(0.01, max(0.005, 0.05 − 0.004 − 0.001)) = 0.01
    expect(solverGapCm(0.05, 0.01, P)).toBeCloseTo((0.05 - 0.01 - 0.004) * 100, 9);
  });
  it('compressed particle: the loft is squashed down to loftMinimumRatio', () => {
    // outer 1 cm: effective = min(0.01, max(0.005, 0.005)) = 0.005 → gap 0.1 cm
    expect(solverGapCm(0.01, 0.01, P)).toBeCloseTo((0.01 - 0.005 - 0.004) * 100, 9);
    // inside the body: effective = loft·ratio → negative gap (tight)
    expect(solverGapCm(0.0, 0.01, P)).toBeCloseTo((0 - 0.005 - 0.004) * 100, 9);
  });
  it('neutral surface: no loft in the shell (the renderer draws it)', () => {
    expect(solverGapCm(0.05, 0.01, { ...P, neutralSurface: true })).toBeCloseTo(
      (0.05 - 0.004) * 100,
      9,
    );
  });
  it('reads its constants from the asset and refuses a missing one', () => {
    expect(
      gapParams({ layer_m: 0.004, config: { loftMinimumRatio: 0.5, collisionMargin: 0.001 } }),
    ).toEqual(P);
    expect(() => gapParams({ layer_m: 0.004, config: { collisionMargin: 0.001 } })).toThrow(
      GapFieldError,
    );
  });
});

describe('rest distances and live binding', () => {
  // A unit-free sphere collider of radius 0.1 m at the origin.
  const sphere: BodyCollider = { distance: (x, y, z) => Math.hypot(x, y, z) - 0.1 };

  it('outer distance = collider distance + SDF bias', () => {
    const out = restOuterDistances([0.15, 0, 0, 0, 0.12, 0], sphere, 0.002);
    expect(out[0]).toBeCloseTo(0.052, 6);
    expect(out[1]).toBeCloseTo(0.022, 6);
  });

  it('binds sleeves to their own arm and body panels to the torso', () => {
    // Body: vertex 0 left arm (x>0), 1 right arm, 2 torso, 3 leg (never bound).
    const body = [0.3, 1.2, 0, -0.3, 1.2, 0, 0.0, 1.2, 0.1, 0.05, 1.21, 0.0];
    const regions = Uint8Array.from([0, 1, 2, 3]);
    // A left-sleeve particle sitting right next to the torso vertex still binds to the left arm.
    const particles = [0.02, 1.2, 0.11, -0.25, 1.2, 0, 0.04, 1.2, 0.0];
    const panels = [4, 5, 0];
    expect(Array.from(bindNearest(particles, panels, body, regions))).toEqual([0, 1, 2]);
    expect(particleRegion(4, 0.2)).toBe(0);
    expect(particleRegion(5, -0.2)).toBe(1);
    expect(particleRegion(1, 0.2)).toBe(2);
  });

  it('classifies body vertices from the rig skin weights', () => {
    const rig = {
      bones: ['spine01', 'upperarm01.L', 'upperarm01.R', 'upperleg01.L'],
      drivers: [0, 1, 2, 3],
      influences: 2,
      vertexCount: 4,
      // v0: 80 % left arm; v1: 60 % right arm; v2: all spine; v3: 70 % leg
      skinWeights: Float32Array.from([0.8, 0.2, 0.6, 0.4, 1, 0, 0.7, 0.3]),
      vertexDrivers: Uint8Array.from([1, 0, 2, 0, 0, 0, 3, 0]),
    };
    expect(Array.from(bodyRegions(rig))).toEqual([0, 1, 2, 3]);
  });

  it('live gap = rest gap at the neutral pose, and follows the normal distance when posed', () => {
    const body = [0, 0, 0.1];
    const normals = [0, 0, 1];
    const bound = Uint32Array.from([0]);
    const neutralJacket = [0, 0, 0.15];
    const reference = normalDistances(neutralJacket, body, normals, bound, new Float32Array(1));
    expect(reference[0]).toBeCloseTo(0.05, 6);
    const outer = Float32Array.from([0.05]);
    const field = new LiveGapField(outer, [0.01], P, bound, reference);
    const rest = solverGapCm(0.05, 0.01, P);
    expect(field.gap[0]).toBeCloseTo(rest, 5);
    expect(field.update(neutralJacket, body, normals)[0]).toBeCloseTo(rest, 5);
    // Body surface moves 2 cm toward the jacket (e.g. a flexed muscle / a bent elbow): 2 cm less gap.
    expect(field.update(neutralJacket, [0, 0, 0.12], normals)[0]).toBeCloseTo(rest - 2, 4);
    // Tangential slide along the surface does not change the gap.
    expect(field.update([0.03, 0, 0.15], body, normals)[0]).toBeCloseTo(rest, 5);
  });

  it('band shares use the service thresholds', () => {
    expect(bandShares([0.2, 1, 2, 3.5], 0.5, 3)).toEqual({ tight: 0.25, good: 0.5, loose: 0.25 });
  });
});
