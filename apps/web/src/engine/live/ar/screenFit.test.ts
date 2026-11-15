import { describe, expect, it } from 'vitest';
import { neutralPose, poseSkeleton } from '@satisfy/vision';
import type { AnatomicalPose } from '../../motion/rig';
import type { ImageLandmark, LiveFrame } from '../contract';
import type { ArSolution } from './ArTracker';
import { centredIntrinsics, project, viewMatrix, type BodyPose, type Vec3 } from './cameraModel';
import {
  ScreenFit,
  cameraRay,
  depthBlend,
  depthPriorBranch,
  IN_PLANE_RATIO,
  inPlaneJoint,
  inPlaneRatio,
  rayOnSphere,
} from './screenFit';

// FK with the vision package's reference skeleton (same ISB conventions as the rig), mapped to
// the scene frame: body (X forward, Y up, Z subject's right) → scene (X left, Y up, Z front).
function fk(pose: AnatomicalPose): Record<string, Vec3> {
  const sk = poseSkeleton(pose as never);
  const out: Record<string, Vec3> = {};
  for (const [k, p] of Object.entries(sk)) out[k] = [-p[2], p[1] + 0.95, p[0]];
  return out;
}

const K = centredIntrinsics(720, 1280, 950);
const camPose: BodyPose = { yaw: 0, pitch: 0, roll: 0, t: [0, -0.1, 2.0] };
const PIVOT: Vec3 = [0, 0.95, 0];
const solution = {
  t: 0,
  intrinsics: K,
  pose: camPose,
  raw: camPose,
  rawRmsPx: 0,
  pivot: PIVOT,
  focal: {} as ArSolution['focal'],
  alignment: null,
  fade: 0,
  backView: false,
} satisfies ArSolution;

function frameOf(pose: AnatomicalPose): LiveFrame {
  const j = fk(pose);
  const l: ImageLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  const put = (i: number, X: Vec3) => {
    const [u, v] = project(K, camPose, PIVOT, X);
    l[i] = { x: u, y: v, visibility: 0.95 };
  };
  put(11, j.lShoulder);
  put(12, j.rShoulder);
  put(13, j.lElbow);
  put(14, j.rElbow);
  put(15, j.lWrist);
  put(16, j.rWrist);
  put(23, j.lHip);
  put(24, j.rHip);
  return {
    t: 0,
    width: 720,
    height: 1280,
    landmarks2d: l,
    world: null,
    pose,
    confidence: {},
    mask: null,
  };
}

function armErrorPx(pose: AnatomicalPose, truth: LiveFrame) {
  const j = fk(pose);
  let e = 0;
  for (const [name, i] of [
    ['lElbow', 13],
    ['rElbow', 14],
    ['lWrist', 15],
    ['rWrist', 16],
  ] as const) {
    const [u, v] = project(K, camPose, PIVOT, j[name]);
    e += Math.hypot(u - truth.landmarks2d![i].x, v - truth.landmarks2d![i].y);
  }
  return e / 4;
}

/** Runs the fit for `n` frames at 30 fps (it is rate-limited and conservative by design). */
function settle(fit: ScreenFit, frame: LiveFrame, start: AnatomicalPose, f: typeof fk, n = 30) {
  for (let i = 0; i < n; i++) fit.adjust({ ...frame, t: i * 33.3 }, start, solution, f);
  return fit.last!;
}

describe('screen-space arm fit', () => {
  it('a ray meets the sphere at the point nearest the hint', () => {
    const p = rayOnSphere([0, 0, -5], [0, 0, 1], [0, 0, 0], 1, [0, 0, -2]);
    expect(p[2]).toBeCloseTo(-1, 9);
    const q = rayOnSphere([0, 0, -5], [0, 0, 1], [0, 0, 0], 1, [0, 0, 3]);
    expect(q[2]).toBeCloseTo(1, 9);
  });

  it('camera rays pass through the projected point', () => {
    const X: Vec3 = [0.2, 1.3, 0.1];
    const [u, v] = project(K, camPose, PIVOT, X);
    const { o, d } = cameraRay(solution, u, v);
    const toX: Vec3 = [X[0] - o[0], X[1] - o[1], X[2] - o[2]];
    const along = toX[0] * d[0] + toX[1] * d[1] + toX[2] * d[2];
    const off = Math.hypot(toX[0] - d[0] * along, toX[1] - d[1] * along, toX[2] - d[2] * along);
    expect(off).toBeLessThan(1e-9);
  });

  it('moves the posed arms onto the real arms (raised arm, bent elbow)', () => {
    const neutral = { ...neutralPose() } as unknown as AnatomicalPose;
    const truth: AnatomicalPose = {
      ...neutral,
      shoulder_R_elevation: 70,
      shoulder_R_plane: 30,
      elbow_R_flexion: 60,
      shoulder_L_elevation: 35,
    };
    const frame = frameOf(truth);
    const start: AnatomicalPose = {
      ...neutral,
      shoulder_R_elevation: 25,
      shoulder_L_elevation: 10,
    };
    const fit = new ScreenFit();
    const out = fit.adjust(frame, start, solution, fk)!;
    expect(out).not.toBeNull();
    const before = armErrorPx(start, frame),
      after = armErrorPx(out, frame);
    expect(before).toBeGreaterThan(60);
    expect(after).toBeLessThan(0.15 * before);
    expect(Math.abs(out.shoulder_R_elevation - 70)).toBeLessThan(8);
    expect(fit.last!.afterPx!).toBeLessThan(fit.last!.beforePx!);
  });

  it('Newton passes cancel a convention gap between the rig and the inverse', () => {
    // A "rig" whose DOFs map to directions with an offset from the vision convention.
    const rig = (p: AnatomicalPose) =>
      fk({
        ...p,
        shoulder_R_elevation: p.shoulder_R_elevation + 6,
        shoulder_R_plane: p.shoulder_R_plane + 8,
        elbow_R_flexion: p.elbow_R_flexion + 5,
      });
    const neutral = { ...neutralPose() } as unknown as AnatomicalPose;
    const truth: AnatomicalPose = {
      ...neutral,
      shoulder_R_elevation: 60,
      shoulder_R_plane: 25,
      elbow_R_flexion: 50,
    };
    const j = rig(truth);
    const frame = frameOf(truth);
    for (const [name, i] of [
      ['rElbow', 14],
      ['rWrist', 16],
    ] as const) {
      const [u, v] = project(K, camPose, PIVOT, j[name]);
      frame.landmarks2d![i] = { x: u, y: v, visibility: 0.95 };
    }
    const start: AnatomicalPose = { ...neutral, shoulder_R_elevation: 20 };
    const last = settle(new ScreenFit(), frame, start, rig);
    // Conservative under the hybrid (8°/frame, half the plane correction): the glue does the rest.
    expect(last.afterPx!).toBeLessThan(0.5 * last.beforePx!);
  });

  it('swings a hanging arm toward the real one (no gimbal hold on the plane)', () => {
    const neutral = { ...neutralPose() } as unknown as AnatomicalPose;
    const truth: AnatomicalPose = {
      ...neutral,
      shoulder_L_elevation: 14,
      shoulder_L_plane: 75,
      elbow_L_flexion: 30,
    };
    const frame = frameOf(truth);
    const start: AnatomicalPose = {
      ...neutral,
      shoulder_L_elevation: 14,
      shoulder_L_plane: 0,
      elbow_L_flexion: 5,
    };
    const last = settle(new ScreenFit(), frame, start, fk);
    expect(last.afterPx!).toBeLessThan(0.75 * last.beforePx!);
  });

  it('stays on one branch: arm toward the camera, 2 px noise, small per-frame changes', () => {
    const neutral = { ...neutralPose() } as unknown as AnatomicalPose;
    // Reaching toward the camera: the elbow ray grazes the sphere, both branches are close.
    const truth: AnatomicalPose = {
      ...neutral,
      shoulder_R_plane: 85,
      shoulder_R_elevation: 70,
      elbow_R_flexion: 20,
    };
    const base = frameOf(truth);
    let seed = 7;
    const noise = () => {
      seed = (seed * 16807) % 2147483647;
      return ((seed / 2147483647) * 2 - 1) * 2;
    };
    const fit = new ScreenFit();
    let prev: AnatomicalPose | null = null;
    const steps: number[] = [];
    for (let i = 0; i < 40; i++) {
      const f = {
        ...base,
        t: i * 33.3,
        landmarks2d: base.landmarks2d!.map((p) => ({ ...p, x: p.x + noise(), y: p.y + noise() })),
      };
      const out: AnatomicalPose = fit.adjust(f, prev ?? truth, solution, fk) ?? prev ?? truth;
      if (prev && i > 5)
        steps.push(
          Math.max(
            Math.abs(out.shoulder_R_elevation - prev.shoulder_R_elevation),
            Math.abs(out.elbow_R_flexion - prev.elbow_R_flexion),
          ),
        );
      prev = out;
    }
    steps.sort((a, b) => a - b);
    expect(steps[Math.floor(steps.length * 0.9)]).toBeLessThan(5);
  });

  it('leaves the pose alone without a camera solve or arm landmarks', () => {
    const neutral = { ...neutralPose() } as unknown as AnatomicalPose;
    expect(new ScreenFit().adjust(frameOf(neutral), neutral, null, fk)).toBeNull();
    const f = frameOf(neutral);
    for (const i of [13, 14]) f.landmarks2d![i].visibility = 0.1;
    expect(new ScreenFit().adjust(f, neutral, solution, fk)).toBeNull();
  });
});

describe('depth prior for the ray–sphere branches (F3, D3)', () => {
  const M = viewMatrix(camPose, PIVOT);
  const depthOf = (P: Vec3) => M[8] * P[0] + M[9] * P[1] + M[10] * P[2] + M[11];

  /** A crossed-arms frame with MediaPipe-like world landmarks (z = depth, + away from the lens). */
  function crossed() {
    const neutral = { ...neutralPose() } as unknown as AnatomicalPose;
    const truth: AnatomicalPose = { ...neutral };
    for (const S of ['L', 'R']) {
      truth[`shoulder_${S}_plane`] = 60;
      truth[`shoulder_${S}_elevation`] = 30;
      truth[`shoulder_${S}_axial`] = 70;
      truth[`elbow_${S}_flexion`] = 115;
    }
    const frame = frameOf(truth);
    const j = fk(truth);
    const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
    for (const [i, name] of [
      [11, 'lShoulder'],
      [12, 'rShoulder'],
      [13, 'lElbow'],
      [14, 'rElbow'],
      [15, 'lWrist'],
      [16, 'rWrist'],
    ] as const)
      world[i] = { x: 0, y: 0, z: depthOf(j[name]), visibility: 0.95 };
    return { truth, frame: { ...frame, world }, j };
  }

  it('picks the branch whose depth step matches the world landmarks', () => {
    const { frame, j } = crossed();
    const lw = frame.landmarks2d![15];
    const { o, d } = cameraRay(solution, lw.x, lw.y);
    const r = Math.hypot(...([0, 1, 2].map((k) => j.lWrist[k] - j.lElbow[k]) as Vec3));
    const want = depthOf(j.lWrist) - depthOf(j.lElbow);
    const b = depthPriorBranch(depthOf, o, d, j.lElbow, r, want, undefined);
    // The true wrist is one of the two intersections; the prior names it.
    const near = rayOnSphere(o, d, j.lElbow, r, o);
    const trueIsNear = Math.abs(depthOf(near) - depthOf(j.lWrist)) < 1e-3;
    expect(b).toBe(trueIsNear ? -1 : 1);
    expect(depthPriorBranch(depthOf, o, d, j.lElbow, r, null, undefined)).toBeUndefined();
    expect(depthPriorBranch(depthOf, o, d, j.lElbow, r, 0.01, undefined)).toBeUndefined();
  });

  it('with the prior, a fit locked on the wrong branch recovers the true wrist depth', () => {
    const { frame, j } = crossed();
    const neutral = { ...neutralPose() } as unknown as AnatomicalPose;
    const start: AnatomicalPose = {
      ...neutral,
      shoulder_L_elevation: 30,
      shoulder_R_elevation: 30,
      elbow_L_flexion: 60,
      elbow_R_flexion: 60,
    };
    const run = (prior: boolean) => {
      const fit = new ScreenFit();
      fit.depthPrior = prior;
      // Locked on the branch opposite to the truth (as after a hanging arm's merged branches).
      const lock = (fit as unknown as { branches: Record<string, number> }).branches;
      let out = start;
      for (let i = 0; i < 25; i++) {
        if (i === 0) for (const k of ['lWrist', 'rWrist']) lock[k] = -1;
        out = fit.adjust({ ...frame, t: i * 100 }, start, solution, fk) ?? out;
      }
      const got = fk(out);
      return Math.abs(depthOf(got.lWrist) - depthOf(j.lWrist));
    };
    const without = run(false),
      withPrior = run(true);
    expect(withPrior).toBeLessThan(0.03);
    expect(withPrior).toBeLessThan(without);
  });

  it('a rig arm longer than the person keeps the world depth instead of faking it (D3)', () => {
    const neutral = { ...neutralPose() } as unknown as AnatomicalPose;
    const truth: AnatomicalPose = {
      ...neutral,
      shoulder_R_plane: 90,
      shoulder_R_elevation: 25,
      shoulder_R_axial: -40,
      elbow_R_flexion: 100,
    };
    const frame = frameOf(truth);
    const j = fk(truth);
    // The person's arm is 15 % shorter than the rig's: elbow and wrist pulled to the shoulder.
    const k = 0.85;
    const l = frame.landmarks2d!;
    const sh = l[12];
    const E = { x: sh.x + (l[14].x - sh.x) * k, y: sh.y + (l[14].y - sh.y) * k };
    const W = { x: E.x + (l[16].x - l[14].x) * k, y: E.y + (l[16].y - l[14].y) * k };
    l[14] = { ...l[14], ...E };
    l[16] = { ...l[16], ...W };
    const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
    world[12] = { x: 0, y: 0, z: depthOf(j.rShoulder), visibility: 0.95 };
    world[14] = {
      x: 0,
      y: 0,
      z: depthOf(j.rShoulder) + k * (depthOf(j.rElbow) - depthOf(j.rShoulder)),
      visibility: 0.95,
    };
    world[16] = {
      x: 0,
      y: 0,
      z: world[14].z + k * (depthOf(j.rWrist) - depthOf(j.rElbow)),
      visibility: 0.95,
    };
    const run = (prior: boolean) => {
      const fit = new ScreenFit();
      fit.depthPrior = prior;
      let out = neutral;
      for (let i = 0; i < 20; i++)
        out = fit.adjust({ ...frame, world, t: i * 100 }, neutral, solution, fk) ?? out;
      return out;
    };
    const plain = run(false),
      prior = run(true);
    expect(Math.abs(prior.shoulder_R_elevation - 25)).toBeLessThan(8);
    expect(Math.abs(prior.shoulder_R_elevation - 25)).toBeLessThan(
      Math.abs(plain.shoulder_R_elevation - 25),
    );
  });

  it('blends toward the world depth continuously, never by a switch', () => {
    const S: Vec3 = [0.2, 1.4, 0];
    const hit: Vec3 = [0.2, 1.1, 0]; // straight down, same depth as the shoulder
    const [u, v] = project(K, camPose, PIVOT, hit);
    const { o, d } = cameraRay(solution, u, v);
    expect(depthBlend(hit, S, 0.3, o, d, null, depthOf).weight).toBe(0);
    expect(depthBlend(hit, S, 0.3, o, d, -0.05, depthOf).weight).toBe(0);
    const ws = [-0.07, -0.08, -0.09, -0.1, -0.12].map(
      (st) => depthBlend(hit, S, 0.3, o, d, st, depthOf).weight,
    );
    for (let k = 1; k < ws.length; k++) expect(ws[k]).toBeGreaterThanOrEqual(ws[k - 1]);
    expect(ws[0]).toBeLessThan(0.5);
    expect(ws.at(-1)).toBe(1);
    const full = depthBlend(hit, S, 0.3, o, d, -0.12, depthOf).point;
    // Full weight: on the shoulder's sphere, in front of the shoulder (toward the lens).
    expect(Math.hypot(full[0] - S[0], full[1] - S[1], full[2] - S[2])).toBeCloseTo(0.3, 6);
    expect(depthOf(full)).toBeLessThan(depthOf(S));
  });
});

describe('in-plane bones (F3 f3arms: raised sleeves lit like the torso)', () => {
  it('inPlaneJoint puts the joint at full length, perpendicular to its view ray', () => {
    // Camera at the origin looking down -Z; shoulder 2 m away; the elbow's ray points slightly
    // right of the shoulder.
    const o: [number, number, number] = [0, 0, 0];
    const d = (() => {
      const v = [0.14, 0, -2];
      const n = Math.hypot(v[0], v[1], v[2]);
      return [v[0] / n, v[1] / n, v[2] / n] as [number, number, number];
    })();
    const S: [number, number, number] = [0, 0, -2];
    const E = inPlaneJoint(o, d, S, 0.28);
    expect(Math.hypot(E[0] - S[0], E[1] - S[1], E[2] - S[2])).toBeCloseTo(0.28, 9);
    const dir = [E[0] - S[0], E[1] - S[1], E[2] - S[2]];
    expect(Math.abs(dir[0] * d[0] + dir[1] * d[1] + dir[2] * d[2])).toBeLessThan(1e-9);
  });
  it('inPlaneRatio: a bone held out sideways reads ~1, one pointed at the lens reads low', () => {
    // 0.28 m bone at 2 m, focal 1000 px: 140 px when in the image plane.
    expect(inPlaneRatio({ x: 0, y: 0 }, { x: 140, y: 0 }, 0.28, 2, 1000)).toBeCloseTo(1, 9);
    expect(inPlaneRatio({ x: 0, y: 0 }, { x: 70, y: 0 }, 0.28, 2, 1000)).toBeLessThan(
      IN_PLANE_RATIO,
    );
    expect(inPlaneRatio({ x: 0, y: 0 }, { x: 140, y: 0 }, 0.28, 0, 1000)).toBe(0);
    // a hanging bone (pointing down in the image) is left to the depth prior
    expect(inPlaneRatio({ x: 0, y: 0 }, { x: 20, y: 138 }, 0.28, 2, 1000)).toBe(0);
  });
});
