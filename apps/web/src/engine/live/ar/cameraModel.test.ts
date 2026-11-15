import { describe, expect, it } from 'vitest';
import {
  DEG,
  centredIntrinsics,
  diagonalFovDeg,
  focalFromDiagonalFov,
  initialPose,
  levenbergMarquardt,
  project,
  rotation,
  solveFocal,
  solvePose,
  viewMatrix,
  type BodyPose,
  type Correspondence,
  type PoseObservation,
  type Vec3,
} from './cameraModel';

// Rest joints of a ~175 cm Anny test body (rig.bin bone heads, scene metres), arms in the display pose.
const REST: Record<string, Vec3> = {
  lShoulder: [0.196, 1.384, 0.018],
  rShoulder: [-0.196, 1.384, 0.018],
  lElbow: [0.336, 1.152, 0.005],
  rElbow: [-0.336, 1.152, 0.005],
  lWrist: [0.451, 0.924, 0.073],
  rWrist: [-0.451, 0.924, 0.073],
  lHip: [0.117, 0.919, -0.009],
  rHip: [-0.117, 0.919, -0.009],
  lKnee: [0.13, 0.52, 0.02],
  rKnee: [-0.13, 0.52, 0.02],
};
const PIVOT: Vec3 = [0, 0.919, -0.009];

/** Arms forward (reach forward): wrists and elbows 0.3–0.5 m in front of the chest. */
function reachForward(): Record<string, Vec3> {
  return {
    ...REST,
    lElbow: [0.2, 1.33, 0.3],
    rElbow: [-0.2, 1.33, 0.3],
    lWrist: [0.18, 1.32, 0.56],
    rWrist: [-0.18, 1.32, 0.56],
  };
}

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rand: () => number) {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

function observe(
  joints: Record<string, Vec3>,
  K: ReturnType<typeof centredIntrinsics>,
  pose: BodyPose,
  noisePx = 0,
  seed = 1,
): PoseObservation {
  const rand = random(seed);
  const points: Correspondence[] = Object.values(joints).map((X) => {
    const [u, v] = project(K, pose, PIVOT, X);
    return { X, u: u + gaussian(rand) * noisePx, v: v + gaussian(rand) * noisePx, weight: 1 };
  });
  return { points, pivot: PIVOT };
}

const ROBUST = { sigmaPx: 6, kneePx: 15 };
const LEVEL = { pitch: 0, roll: 0, sigma: 15 * DEG };

describe('camera model', () => {
  it('maps the body front toward the lens and the subject left to image right', () => {
    const K = centredIntrinsics(1280, 720, 1000);
    const pose: BodyPose = { yaw: 0, pitch: 0, roll: 0, t: [0, 0, 2] };
    const [uL] = project(K, pose, PIVOT, REST.lShoulder);
    const [uR] = project(K, pose, PIVOT, REST.rShoulder);
    expect(uL).toBeGreaterThan(640);
    expect(uR).toBeLessThan(640);
    const front = project(K, pose, PIVOT, [0, 1.2, 0.2])[2];
    const back = project(K, pose, PIVOT, [0, 1.2, -0.2])[2];
    expect(front).toBeLessThan(back);
    // Head above hips: smaller v (image y grows downward).
    expect(project(K, pose, PIVOT, [0, 1.6, 0])[1]).toBeLessThan(project(K, pose, PIVOT, PIVOT)[1]);
  });

  it('rotation is orthonormal and viewMatrix agrees with project', () => {
    const pose: BodyPose = { yaw: 0.7, pitch: -0.2, roll: 0.05, t: [0.1, -0.3, 2.4] };
    const R = rotation(pose);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        let dot = 0;
        for (let k = 0; k < 3; k++) dot += R[i * 3 + k] * R[j * 3 + k];
        expect(dot).toBeCloseTo(i === j ? 1 : 0, 12);
      }
    const M = viewMatrix(pose, PIVOT);
    const X = REST.lWrist;
    const p = [0, 1, 2].map(
      (r) => M[r * 4] * X[0] + M[r * 4 + 1] * X[1] + M[r * 4 + 2] * X[2] + M[r * 4 + 3],
    );
    const K = centredIntrinsics(1280, 720, 900);
    const [u, v, z] = project(K, pose, PIVOT, X);
    expect(z).toBeCloseTo(p[2], 12);
    expect(u).toBeCloseTo((900 * p[0]) / p[2] + 640, 9);
    expect(v).toBeCloseTo((900 * p[1]) / p[2] + 360, 9);
  });

  it('converts focal length and diagonal FOV both ways', () => {
    const f = focalFromDiagonalFov(720, 1280, 75);
    expect(diagonalFovDeg(720, 1280, f)).toBeCloseTo(75, 10);
  });

  it('Levenberg–Marquardt solves a small nonlinear least squares problem', () => {
    // Rosenbrock as residuals: r = [10(y − x²), 1 − x]; minimum at (1, 1).
    const result = levenbergMarquardt(
      [-1.2, 1],
      2,
      (p, out) => {
        out[0] = 10 * (p[1] - p[0] * p[0]);
        out[1] = 1 - p[0];
      },
      { steps: [1e-6, 1e-6], maxIterations: 200, tolerance: 1e-14 },
    );
    expect(result.params[0]).toBeCloseTo(1, 5);
    expect(result.params[1]).toBeCloseTo(1, 5);
  });
});

describe('per-frame pose solve (known intrinsics)', () => {
  const K = centredIntrinsics(1280, 720, 1005); // 65° horizontal FOV at 1280 px
  const truths: BodyPose[] = [
    { yaw: 0, pitch: 0, roll: 0, t: [0.05, 0.1, 2.2] },
    { yaw: 35 * DEG, pitch: 6 * DEG, roll: -2 * DEG, t: [-0.2, 0.25, 1.6] },
    { yaw: -70 * DEG, pitch: -4 * DEG, roll: 3 * DEG, t: [0.3, 0.05, 2.8] },
    { yaw: 170 * DEG, pitch: 2 * DEG, roll: 0, t: [0, 0.15, 2.0] },
  ];
  it.each(truths.map((t, i) => [i, t] as const))(
    'recovers pose %i exactly from exact landmarks',
    (_, truth) => {
      const o = observe(REST, K, truth);
      const start = initialPose(K, o, truth.yaw + 0.3, { pitch: 0, roll: 0 });
      const solved = solvePose(K, o, [start], LEVEL, ROBUST);
      // Not exactly 0: the level-camera prior (15° σ) pulls pitch/roll by a hair.
      expect(solved.rmsPx).toBeLessThan(0.1);
      expect(Math.abs(Math.sin(solved.pose.yaw - truth.yaw))).toBeLessThan(2e-3);
      for (let i = 0; i < 3; i++) expect(solved.pose.t[i]).toBeCloseTo(truth.t[i], 2);
    },
  );

  it('stays within a few pixels with 3 px landmark noise', () => {
    const truth = truths[1];
    const o = observe(REST, K, truth, 3, 7);
    const solved = solvePose(K, o, [initialPose(K, o, 0, { pitch: 0, roll: 0 })], LEVEL, ROBUST);
    const exact = observe(REST, K, truth);
    let worst = 0;
    exact.points.forEach((c) => {
      const [u, v] = project(K, solved.pose, PIVOT, c.X);
      worst = Math.max(worst, Math.hypot(u - c.u, v - c.v));
    });
    expect(worst).toBeLessThan(6);
    expect(Math.abs(solved.pose.t[2] - truth.t[2]) / truth.t[2]).toBeLessThan(0.05);
  });

  it('ignores one gross outlier (robust loss)', () => {
    const truth = truths[0];
    const o = observe(REST, K, truth, 1, 3);
    o.points[4].u += 150; // a wrist landmark snapped to the background
    const solved = solvePose(K, o, [initialPose(K, o, 0, { pitch: 0, roll: 0 })], LEVEL, ROBUST);
    const [u, v] = project(K, solved.pose, PIVOT, REST.lShoulder);
    const [u0, v0] = project(K, truth, PIVOT, REST.lShoulder);
    expect(Math.hypot(u - u0, v - v0)).toBeLessThan(8);
  });
});

describe('focal length from several frames (unknown intrinsics)', () => {
  const width = 1280,
    height = 720;
  const trueF = 1005; // 65° horizontal, ≈ 72° diagonal
  const K = centredIntrinsics(width, height, trueF);
  const truths: { joints: Record<string, Vec3>; pose: BodyPose }[] = [];
  for (let i = 0; i < 12; i++) {
    const yaw = (-75 + (150 * i) / 11) * DEG;
    truths.push({
      joints: i % 2 ? reachForward() : REST,
      pose: { yaw, pitch: 4 * DEG, roll: -1 * DEG, t: [0.1 * Math.sin(i), 0.2, 1.3 + 0.08 * i] },
    });
  }
  const prior = { f: focalFromDiagonalFov(width, height, 75), logSigma: 0.15 };

  it('recovers the focal length from exact landmarks (prior 75° diagonal)', () => {
    const frames = truths.map((t) => {
      const observation = observe(t.joints, K, t.pose);
      return { observation, start: initialPose(K, observation, t.pose.yaw, { pitch: 0, roll: 0 }) };
    });
    const result = solveFocal(width, height, frames, prior, LEVEL, ROBUST);
    expect(Math.abs(result.f / trueF - 1)).toBeLessThan(0.01);
    expect(result.rmsPx).toBeLessThan(0.3);
    expect(result.priorRmsPx).toBeGreaterThan(result.rmsPx);
  });

  it('recovers it within 8 % with 2 px landmark noise, and reports its uncertainty', () => {
    const frames = truths.map((t, i) => {
      const observation = observe(t.joints, K, t.pose, 2, 100 + i);
      return { observation, start: initialPose(K, observation, t.pose.yaw, { pitch: 0, roll: 0 }) };
    });
    const result = solveFocal(width, height, frames, prior, LEVEL, ROBUST);
    expect(Math.abs(result.f / trueF - 1)).toBeLessThan(0.08);
    expect(result.logSigma).toBeGreaterThan(0);
    expect(result.logSigma).toBeLessThan(0.15); // the data constrain it more than the prior alone
  });
});
