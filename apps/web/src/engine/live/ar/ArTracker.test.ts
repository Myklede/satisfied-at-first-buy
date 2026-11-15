import { describe, expect, it } from 'vitest';
import type { ImageLandmark, LiveFrame } from '../contract';
import {
  ArTracker,
  alignmentReport,
  deadbandYaw,
  extrapolatedLowerBody,
  lowerEdgeWeights,
  softDeadband,
  torsoAlignmentScore,
  yawFromWorld,
  type Joints,
} from './ArTracker';
import {
  DEG,
  centredIntrinsics,
  project,
  type BodyPose,
  type Intrinsics,
  type Vec3,
} from './cameraModel';
import { LANDMARK_OF_JOINT } from './config';

const REST: Joints = {
  midHip: [0, 0.919, -0.009],
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
const REACH: Joints = {
  ...REST,
  lElbow: [0.2, 1.33, 0.3],
  rElbow: [-0.2, 1.33, 0.3],
  lWrist: [0.18, 1.32, 0.56],
  rWrist: [-0.18, 1.32, 0.56],
};

function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussian = (rand: () => number) =>
  Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

function frame(
  t: number,
  K: Intrinsics,
  pose: BodyPose,
  joints: Joints,
  noise: number,
  rand: () => number,
): LiveFrame {
  const pivot = joints.midHip as Vec3;
  const landmarks: ImageLandmark[] = Array.from({ length: 33 }, () => ({
    x: 0,
    y: 0,
    visibility: 0,
  }));
  for (const [name, index] of Object.entries(LANDMARK_OF_JOINT)) {
    const X = joints[name];
    if (!X) continue;
    const [u, v] = project(K, pose, pivot, X);
    landmarks[index!] = {
      x: u + gaussian(rand) * noise,
      y: v + gaussian(rand) * noise,
      visibility: 0.95,
    };
  }
  // MediaPipe world landmarks: camera-aligned, hip-centred; enough for the yaw start.
  const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  const c = Math.cos(pose.yaw),
    s = Math.sin(pose.yaw);
  world[11] = { x: 0.2 * c, y: -0.5, z: 0.2 * s, visibility: 0.9 };
  world[12] = { x: -0.2 * c, y: -0.5, z: -0.2 * s, visibility: 0.9 };
  return {
    t,
    width: K.width,
    height: K.height,
    landmarks2d: landmarks,
    world,
    pose: {}, // tracked: the posed joints come from this frame
    confidence: {},
    mask: null,
  };
}

describe('ArTracker', () => {
  const K = centredIntrinsics(720, 1280, 960);

  it('reads the yaw from MediaPipe world landmarks', () => {
    const f = frame(0, K, { yaw: 0.6, pitch: 0, roll: 0, t: [0, 0, 2] }, REST, 0, random(1));
    expect(yawFromWorld(f.world)).toBeCloseTo(0.6, 6);
  });

  it('holds a still person still: < 1.5 px jitter of the drawn shoulders with 3 px noise', () => {
    const tracker = new ArTracker({ focalPx: 960 });
    const truth: BodyPose = { yaw: 5 * DEG, pitch: 3 * DEG, roll: 0, t: [0.02, 0.1, 1.6] };
    const rand = random(42);
    const us: number[] = [];
    for (let i = 0; i < 90; i++) {
      const solution = tracker.update(frame(i * 33.3, K, truth, REST, 3, rand), REST);
      expect(solution).not.toBeNull();
      if (i < 30) continue;
      us.push(project(K, solution!.pose, solution!.pivot, REST.lShoulder as Vec3)[0]);
    }
    const mean = us.reduce((a, b) => a + b, 0) / us.length;
    const sd = Math.sqrt(us.reduce((a, b) => a + (b - mean) ** 2, 0) / us.length);
    expect(sd).toBeLessThan(1.5);
    expect(
      Math.abs(mean - project(K, truth, REST.midHip as Vec3, REST.lShoulder as Vec3)[0]),
    ).toBeLessThan(3);
    const a = tracker.last!.alignment!;
    expect(a.score).toBeGreaterThan(0.85);
    expect(a.approximate).toBe(false);
  });

  it('reports poor alignment honestly when the posed arms do not match the person', () => {
    const truth: BodyPose = { yaw: 0, pitch: 0, roll: 0, t: [0, 0.1, 1.8] };
    const f = frame(0, K, truth, REACH, 0, random(3));
    // The overlay's body still has its arms down: elbows and wrists are far from the landmarks.
    const report = alignmentReport(K, truth, REST.midHip as Vec3, f.landmarks2d!, REST)!;
    expect(report.rmsFraction).toBeGreaterThan(0.2);
    expect(report.approximate).toBe(true);
    const good = alignmentReport(K, truth, REST.midHip as Vec3, f.landmarks2d!, REACH)!;
    expect(good.rmsPx).toBeLessThan(1e-6);
    expect(good.score).toBeCloseTo(1, 6);
  });

  it('estimates an unknown focal length from a session with turns and reaches', () => {
    const trueF = 1005;
    const Kt = centredIntrinsics(1280, 720, trueF);
    const tracker = new ArTracker(); // prior: 75° diagonal ≈ 957 px at 1280×720
    const rand = random(9);
    for (let i = 0; i < 160; i++) {
      const yaw = 60 * DEG * Math.sin(i / 12);
      const joints = Math.floor(i / 20) % 2 ? REACH : REST;
      const pose: BodyPose = {
        yaw,
        pitch: 4 * DEG,
        roll: 0,
        t: [0.05, 0.15, 1.4 + 0.3 * Math.sin(i / 30)],
      };
      tracker.update(frame(i * 66, Kt, pose, joints, 1.5, rand), joints);
    }
    const focal = tracker.focalEstimate!;
    expect(focal.source).toBe('estimated');
    expect(focal.keyframes).toBeGreaterThanOrEqual(12);
    expect(Math.abs(focal.f / trueF - 1)).toBeLessThan(0.08);
    expect(Math.abs(tracker.cameraTiltDeg.pitch - 4)).toBeLessThan(2);
  });

  it('f1fov: a pinned diagonal FOV is kept through the same session (no keyframes, no fit)', () => {
    const Kt = centredIntrinsics(1280, 720, 1005);
    const tracker = new ArTracker({ fixedFovDeg: 75 });
    const rand = random(9);
    for (let i = 0; i < 160; i++) {
      const joints = Math.floor(i / 20) % 2 ? REACH : REST;
      const pose: BodyPose = {
        yaw: 60 * DEG * Math.sin(i / 12),
        pitch: 4 * DEG,
        roll: 0,
        t: [0.05, 0.15, 1.4 + 0.3 * Math.sin(i / 30)],
      };
      tracker.update(frame(i * 66, Kt, pose, joints, 1.5, rand), joints);
    }
    const focal = tracker.focalEstimate!;
    expect(tracker.fovPinned).toBe(true);
    expect(focal.source).toBe('pinned');
    expect(focal.keyframes).toBe(0);
    expect(focal.diagonalFovDeg).toBeCloseTo(75, 6);
  });

  it('keeps mis-posed frames out of the focal estimate (no bias from pose errors)', () => {
    const Kt = centredIntrinsics(1280, 720, 1005);
    const tracker = new ArTracker();
    const rand = random(5);
    for (let i = 0; i < 120; i++) {
      const yaw = 60 * DEG * Math.sin(i / 12);
      const pose: BodyPose = { yaw, pitch: 4 * DEG, roll: 0, t: [0.05, 0.15, 1.5] };
      // The person reaches forward, the overlay body keeps its arms down: never a keyframe.
      tracker.update(frame(i * 66, Kt, pose, REACH, 1, rand), REST);
    }
    expect(tracker.focalEstimate!.keyframes).toBe(0);
    expect(tracker.focalEstimate!.source).toBe('prior');
  });

  it('deadband: facing (or back view) snaps exactly, a real turn passes, smooth in between', () => {
    expect(deadbandYaw(5 * DEG)).toBe(0);
    expect(deadbandYaw(-7 * DEG)).toBeCloseTo(0, 12);
    expect(deadbandYaw(30 * DEG)).toBeCloseTo(30 * DEG, 12);
    expect(Math.abs(deadbandYaw(178 * DEG))).toBeCloseTo(Math.PI, 12);
    const mid = deadbandYaw(12 * DEG) / DEG;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(12);
  });

  it('facing the camera with 4 px landmark noise: drawn yaw std < 2°, outline steps < 1.5 px', () => {
    const tracker = new ArTracker({ focalPx: 960 });
    const truth: BodyPose = { yaw: 0, pitch: 2 * DEG, roll: 0, t: [0.02, 0.1, 1.6] };
    const rand = random(77);
    const yaws: number[] = [];
    const xs: number[] = [];
    for (let i = 0; i < 120; i++) {
      const s = tracker.update(frame(i * 33.3, K, truth, REST, 4, rand), REST);
      if (i < 30 || !s) continue;
      yaws.push(s.pose.yaw / DEG);
      xs.push(project(K, s.pose, s.pivot, REST.lShoulder as Vec3)[0]);
    }
    const mean = yaws.reduce((a, b) => a + b, 0) / yaws.length;
    const sd = Math.sqrt(yaws.reduce((a, b) => a + (b - mean) ** 2, 0) / yaws.length);
    expect(sd).toBeLessThan(2);
    let step = 0;
    for (let i = 1; i < xs.length; i++) step += Math.abs(xs[i] - xs[i - 1]);
    expect(step / (xs.length - 1)).toBeLessThan(1.5);
  });

  it('landmarks 15 % narrower than the rig, facing: no false ±30° yaw (live test failure)', () => {
    // cam-tshirt: MediaPipe's shoulder/hip landmarks spread 0.80–0.88 of the rig's joints while the
    // person faced the camera; the unprimed solve explained it as yaw ±30°, flipping sign.
    const narrow: Joints = Object.fromEntries(
      Object.entries(REST).map(([k, v]) => [k, [v[0] * 0.85, v[1], v[2]]]),
    );
    const tracker = new ArTracker({ focalPx: 960 });
    const truth: BodyPose = { yaw: 0, pitch: 0, roll: 0, t: [0, 0.1, 1.7] };
    const rand = random(91);
    const yaws: number[] = [];
    for (let i = 0; i < 150; i++) {
      // Landmarks from the narrow skeleton; the overlay body is the full-width rig.
      const s = tracker.update(frame(i * 33.3, K, truth, narrow, 3, rand), REST);
      if (i >= 40 && s) yaws.push(s.pose.yaw / DEG);
    }
    expect(Math.max(...yaws.map(Math.abs))).toBeLessThan(5);
    expect(tracker.landmarkSpread).toBeGreaterThan(0.8);
    expect(tracker.landmarkSpread).toBeLessThan(0.9);
  });

  it('never draws a back-facing yaw; fades out past 60°; hides a back view', () => {
    const tracker = new ArTracker({ focalPx: 960 });
    const rand = random(55);
    let maxDrawn = 0;
    let fadeAtSide = 0;
    for (let i = 0; i < 200; i++) {
      // Turn steadily from facing to showing the back (0 → 180° over 200 frames).
      const yaw = (180 * DEG * i) / 199;
      const s = tracker.update(
        frame(i * 33.3, K, { yaw, pitch: 0, roll: 0, t: [0, 0.1, 1.8] }, REST, 1, rand),
        REST,
      );
      if (!s) continue;
      maxDrawn = Math.max(maxDrawn, Math.abs(s.pose.yaw) / DEG);
      if (yaw > 85 * DEG && yaw < 95 * DEG) fadeAtSide = Math.max(fadeAtSide, s.fade);
    }
    expect(maxDrawn).toBeLessThanOrEqual(75 + 1e-6);
    expect(fadeAtSide).toBeGreaterThan(0.5);
    // A flipped shoulder order with the face hidden: the face cue abstains, so this alone is not
    // called a back view (a close-up can flip MediaPipe's shoulders); the yaw stays front-folded.
    const back = frame(
      0,
      K,
      { yaw: Math.PI, pitch: 0, roll: 0, t: [0, 0.1, 1.8] },
      REST,
      0,
      random(1),
    );
    back.landmarks2d![0] = { x: 360, y: 300, visibility: 0.1 };
    const s = new ArTracker({ focalPx: 960 }).update(back, REST);
    if (s) {
      expect(s.backView).toBe(false);
      expect(Math.abs(s.pose.yaw) / DEG).toBeLessThanOrEqual(75 + 1e-6);
    }
  });

  it('back view with the face still "visible" (MediaPipe): faded, held, released', () => {
    // MediaPipe keeps the nose at visibility ~0.99 on a person's back; the cues are the flipped
    // shoulder order, the nose behind the shoulders (world z) and the raw solve's yaw.
    const withFace = (f: LiveFrame, noseZ: number): LiveFrame => {
      const l = f.landmarks2d!;
      const cx = (l[11].x + l[12].x) / 2;
      l[0] = { x: cx, y: l[11].y - 120, visibility: 0.99 };
      l[7] = { x: cx + 30, y: l[11].y - 130, visibility: 0.99 };
      l[8] = { x: cx - 30, y: l[11].y - 130, visibility: 0.99 };
      f.world![0] = { x: 0, y: -0.7, z: noseZ, visibility: 0.99 };
      return f;
    };
    const tracker = new ArTracker({ focalPx: 960 });
    const rand = random(91);
    const at = (i: number, yaw: number, noseZ: number) =>
      tracker.update(
        withFace(
          frame(i * 33.3, K, { yaw, pitch: 0, roll: 0, t: [0, 0.1, 1.8] }, REST, 1, rand),
          noseZ,
        ),
        REST,
      );
    // Facing first: never a back view, heading ~0.
    let s = null;
    for (let i = 0; i < 40; i++) {
      s = at(i, 0, -0.15);
      expect(s?.backView ?? false).toBe(false);
    }
    expect(Math.abs(tracker.headingDeg!)).toBeLessThan(3);
    // The back: detected within 2 frames, fully faded, heading near ±180.
    for (let i = 40; i < 50; i++) s = at(i, Math.PI, 0.12);
    expect(s!.backView).toBe(true);
    expect(s!.fade).toBe(1);
    expect(Math.abs(tracker.headingDeg!)).toBeGreaterThan(150);
    // A 2-frame frontal glitch does not release it (hold).
    for (let i = 50; i < 52; i++) s = at(i, 0, -0.15);
    expect(s!.backView).toBe(true);
    // Frontal evidence for > 300 ms releases it.
    for (let i = 52; i < 70; i++) s = at(i, 0, -0.15);
    expect(s!.backView).toBe(false);
  });

  it('a facing close-up with the head cut off is not a back view (V4 re-shoot, cam-tshirt 12.5 s)', () => {
    const tracker = new ArTracker({ focalPx: 960 });
    const rand = random(23);
    let s = null;
    for (let i = 0; i < 40; i++) {
      const f = frame(i * 33.3, K, { yaw: 0, pitch: 0, roll: 0, t: [0, 0.3, 1.0] }, REST, 1, rand);
      const l = f.landmarks2d!;
      // MediaPipe's garbage on a cut-off head: the shoulders swapped and the nose (above the
      // frame) "behind" the shoulders in world z.
      [l[11], l[12]] = [l[12], l[11]];
      l[0] = { x: (l[11].x + l[12].x) / 2, y: -60, visibility: 0.99 };
      l[7] = { x: l[0].x + 30, y: -70, visibility: 0.99 };
      l[8] = { x: l[0].x - 30, y: -70, visibility: 0.99 };
      f.world![0] = { x: 0, y: -0.7, z: 0.12, visibility: 0.99 };
      s = tracker.update(f, REST);
      if (s) expect(s.backView).toBe(false);
    }
    expect(tracker.backEvidence?.faceSeen).toBe(false);
  });

  it('a one-frame span glitch does not flash the overlay off (fade smoothed in time)', () => {
    const tracker = new ArTracker({ focalPx: 960 });
    const rand = random(5);
    let s = null;
    for (let i = 0; i < 40; i++)
      s = tracker.update(
        frame(i * 33.3, K, { yaw: 0, pitch: 0, roll: 0, t: [0, 0.1, 1.8] }, REST, 1, rand),
        REST,
      );
    expect(s!.fade).toBeLessThan(0.05);
    // One frame whose shoulders collapse to a side view's span, then facing again.
    const glitch = frame(
      40 * 33.3,
      K,
      { yaw: 0, pitch: 0, roll: 0, t: [0, 0.1, 1.8] },
      REST,
      1,
      rand,
    );
    const l = glitch.landmarks2d!;
    const cx = (l[11].x + l[12].x) / 2;
    l[11] = { ...l[11], x: cx + 10 };
    l[12] = { ...l[12], x: cx - 10 };
    s = tracker.update(glitch, REST);
    if (s) expect(s.fade).toBeLessThan(0.35);
  });

  it('a side view (90°, nose level with the shoulders) is not a back view', () => {
    const tracker = new ArTracker({ focalPx: 960 });
    const rand = random(17);
    let s = null;
    for (let i = 0; i < 60; i++) {
      const f = frame(i * 33.3, K, { yaw: 0, pitch: 0, roll: 0, t: [0, 0.1, 1.8] }, REST, 1, rand);
      s = tracker.update(f, REST);
    }
    for (let i = 60; i < 80; i++) {
      const f = frame(
        i * 33.3,
        K,
        { yaw: 88 * DEG, pitch: 0, roll: 0, t: [0, 0.1, 1.8] },
        REST,
        1,
        rand,
      );
      f.world![0] = { x: 0.1, y: -0.7, z: 0.0, visibility: 0.99 };
      s = tracker.update(f, REST);
      if (s) expect(s.backView).toBe(false);
    }
  });

  it('torso alignment ignores the arms (collar-guard gate)', () => {
    const report = {
      score: 0.3,
      rmsPx: 60,
      rmsFraction: 0.2,
      shoulderWidthPx: 200,
      perJoint: {
        lShoulder: { errorPx: 6, dx: 6, dy: 0 },
        rShoulder: { errorPx: 6, dx: -6, dy: 0 },
        lHip: { errorPx: 6, dx: 0, dy: 6 },
        rHip: { errorPx: 6, dx: 0, dy: -6 },
        lWrist: { errorPx: 150, dx: 150, dy: 0 },
      },
      approximate: true,
      points: 5,
    };
    // 6 px RMS on a 200 px shoulder = 3 % of the width; zero at 30 % → 0.9.
    expect(torsoAlignmentScore(report)).toBeCloseTo(0.9, 6);
    expect(
      torsoAlignmentScore({ ...report, perJoint: { lShoulder: report.perJoint.lShoulder } }),
    ).toBeNull();
  });

  it('a real turn still shows: 40° turned reads 40° ± 5°', () => {
    const tracker = new ArTracker({ focalPx: 960 });
    const truth: BodyPose = { yaw: 40 * DEG, pitch: 0, roll: 0, t: [0, 0.1, 1.8] };
    const rand = random(78);
    let s = null;
    for (let i = 0; i < 90; i++) s = tracker.update(frame(i * 33.3, K, truth, REST, 2, rand), REST);
    expect(Math.abs(s!.pose.yaw / DEG - 40)).toBeLessThan(5);
  });

  it('f1turn: draws through a whole turn to the back, never faded, heading follows the body', () => {
    const tracker = new ArTracker({ focalPx: 960, turnThrough: true });
    const rand = random(56);
    let worst = 0;
    let maxFade = 0;
    let last = null;
    for (let i = 0; i < 260; i++) {
      // Facing for 40 frames, then a steady turn 0 → 180° (≈ 30°/s), then the back.
      const yaw = (180 * DEG * Math.min(1, Math.max(0, i - 40) / 180)) % (2 * Math.PI);
      const s = tracker.update(
        frame(i * 33.3, K, { yaw, pitch: 0, roll: 0, t: [0, 0.1, 1.8] }, REST, 1, rand),
        REST,
      );
      expect(s).not.toBeNull();
      maxFade = Math.max(maxFade, s!.fade);
      const truth = yaw / DEG;
      const err = Math.abs(((tracker.headingDeg! - truth + 540) % 360) - 180);
      if (truth > 50 && truth < 170) worst = Math.max(worst, err);
      last = s;
    }
    expect(maxFade).toBe(0);
    expect(worst).toBeLessThan(15);
    expect(last!.backView).toBe(true);
    expect(Math.abs(tracker.headingDeg!)).toBeGreaterThan(170);
  });

  it('f1tilt: the drawn camera is level: exactly 0 pitch/roll, also for a tilted camera', () => {
    const run = (pitchDeg: number, rollDeg: number) => {
      const tracker = new ArTracker({ focalPx: 960, tiltSteady: true });
      const rand = random(64);
      const truth: BodyPose = {
        yaw: 0,
        pitch: pitchDeg * DEG,
        roll: rollDeg * DEG,
        t: [0.02, 0.1, 1.6],
      };
      const p: number[] = [],
        r: number[] = [];
      for (let i = 0; i < 90; i++) {
        const s = tracker.update(frame(i * 66, K, truth, REST, 3, rand), REST)!;
        if (i * 66 >= 2500) {
          p.push(s.pose.pitch / DEG);
          r.push(s.pose.roll / DEG);
        }
      }
      const stat = (v: number[]) => {
        const m = v.reduce((x, y) => x + y, 0) / v.length;
        return { m, sd: Math.sqrt(v.reduce((x, y) => x + (y - m) ** 2, 0) / v.length) };
      };
      return { pitch: stat(p), roll: stat(r) };
    };
    // A level kiosk camera (the venue): exactly level, no rotation at rest.
    const level = run(1, 0.5);
    expect(level.pitch.sd).toBe(0);
    expect(level.roll.sd).toBe(0);
    expect(Math.abs(level.pitch.m)).toBe(0);
    // A camera tilted 9° is drawn level too (the documented trade-off): never a rotating jacket.
    const tilted = run(9, 1);
    expect(tilted.pitch.sd).toBe(0);
    expect(tilted.pitch.m).toBe(0);
  });

  it('softDeadband: zero inside, untouched outside, monotone between', () => {
    expect(softDeadband(1 * DEG, [1.5, 4])).toBe(0);
    expect(softDeadband(-5 * DEG, [1.5, 4])).toBeCloseTo(-5 * DEG, 12);
    const mid = softDeadband(3 * DEG, [1.5, 4]) / DEG;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(3);
  });

  it('f1turn: a fast turn through the side (26° per tracked frame) is not held back', () => {
    const tracker = new ArTracker({ focalPx: 960, turnThrough: true });
    const rand = random(12);
    for (let i = 0; i < 30; i++)
      tracker.update(
        frame(i * 66, K, { yaw: 0, pitch: 0, roll: 0, t: [0, 0.1, 1.8] }, REST, 1, rand),
        REST,
      );
    let worst = 0;
    for (let k = 1; k <= 7; k++) {
      const yaw = 26 * k * DEG;
      tracker.update(
        frame(30 * 66 + k * 150, K, { yaw, pitch: 0, roll: 0, t: [0, 0.1, 1.8] }, REST, 1, rand),
        REST,
      );
      if (k >= 3) worst = Math.max(worst, Math.abs(tracker.headingDeg! - 26 * k));
    }
    expect(worst).toBeLessThan(15);
  });

  it('f1turn: a wrong world yaw (40°) on a facing person is limited by the full 2D shoulder width', () => {
    const tracker = new ArTracker({ focalPx: 960, turnThrough: true });
    const rand = random(81);
    const yaws: number[] = [];
    for (let i = 0; i < 100; i++) {
      const f = frame(i * 66, K, { yaw: 0, pitch: 0, roll: 0, t: [0, 0.2, 1.2] }, REST, 2, rand);
      if (i >= 30) {
        // A close-up's garbage world landmarks: 40° turned, the image shows full-width shoulders.
        f.world![11] = { x: 0.2 * Math.cos(0.7), y: -0.5, z: 0.2 * Math.sin(0.7), visibility: 0.9 };
        f.world![12] = {
          x: -0.2 * Math.cos(0.7),
          y: -0.5,
          z: -0.2 * Math.sin(0.7),
          visibility: 0.9,
        };
      }
      const s = tracker.update(f, REST);
      if (i >= 40 && s) yaws.push(Math.abs(s.pose.yaw / DEG));
    }
    expect(Math.max(...yaws)).toBeLessThan(18);
  });

  it('f1turnscale: turning to profile at the same distance keeps the drawn depth (size)', () => {
    const depths = (turnScale: boolean) => {
      const tracker = new ArTracker({
        focalPx: 960,
        turnThrough: true,
        tiltSteady: true,
        turnScale,
      });
      const rand = random(89);
      let frontal = 0;
      const turned: number[] = [];
      for (let i = 0; i < 160; i++) {
        const yaw = i < 50 ? 0 : Math.min(75, (i - 50) * 6) * DEG;
        const f = frame(i * 50, K, { yaw, pitch: 0, roll: 0, t: [0, 0.2, 1.8] }, REST, 1, rand);
        // MediaPipe in profile: the hips read ~11 % further below the shoulders (live5 297 -> 334 px).
        if (yaw > 40 * DEG) {
          const l = f.landmarks2d!;
          const sy = (l[11].y + l[12].y) / 2;
          for (const k of [23, 24]) l[k] = { ...l[k], y: sy + (l[k].y - sy) * 1.11 };
        }
        const s = tracker.update(f, REST);
        if (i === 49) frontal = s!.pose.t[2];
        if (i >= 100 && s) turned.push(s.pose.t[2] / frontal);
      }
      return Math.min(...turned);
    };
    // Without the flag the profile fit pulls the jacket closer (drawn bigger).
    expect(depths(false)).toBeLessThan(0.97);
    expect(depths(true)).toBeGreaterThan(0.99);
  });

  it('f1torso: a held 40° turn with landmark noise: the drawn yaw and depth stop shimmering', () => {
    const changes = (torsoRigid: boolean) => {
      const tracker = new ArTracker({ focalPx: 960, turnThrough: true, torsoRigid });
      const rand = random(87);
      let yawSteps = 0,
        depthSteps = 0,
        prev: BodyPose | null = null;
      for (let i = 0; i < 150; i++) {
        const yaw = Math.min(40, i * 4) * DEG;
        const f = frame(i * 50, K, { yaw, pitch: 0, roll: 0, t: [0, 0.2, 1.8] }, REST, 3, rand);
        const s = tracker.update(f, REST);
        if (i >= 60 && s && prev) {
          if (Math.abs(s.pose.yaw - prev.yaw) > 1e-9) yawSteps++;
          if (Math.abs(s.pose.t[2] - prev.t[2]) > 1e-9) depthSteps++;
        }
        if (s) prev = s.pose;
      }
      return { yawSteps, depthSteps };
    };
    const off = changes(false),
      on = changes(true);
    expect(on.yawSteps).toBeLessThan(off.yawSteps);
    expect(on.yawSteps).toBeLessThanOrEqual(5);
    expect(on.depthSteps).toBeLessThanOrEqual(off.depthSteps);
  });

  it('f1side: in profile the 2D shoulder span lifts a world yaw that under-reads the turn', () => {
    const drawn = (sideFloor: boolean) => {
      const tracker = new ArTracker({ focalPx: 960, turnThrough: true, sideFloor });
      const rand = random(83);
      const yaws: number[] = [];
      for (let i = 0; i < 140; i++) {
        // Facing for 2 s (the spread is learned), then a turn to 80° held; MediaPipe's world yaw
        // reads 68° there (live4 7.6-9.6 s: world 69°, shoulder span acos 78°).
        const yaw = i < 30 ? 0 : Math.min(80, (i - 30) * 8) * DEG;
        const f = frame(i * 66, K, { yaw, pitch: 0, roll: 0, t: [0, 0.2, 1.8] }, REST, 1, rand);
        const wy = i < 30 ? 0 : Math.min(68, (i - 30) * 8) * DEG;
        f.world![11] = { x: 0.2 * Math.cos(wy), y: -0.5, z: 0.2 * Math.sin(wy), visibility: 0.9 };
        f.world![12] = { x: -0.2 * Math.cos(wy), y: -0.5, z: -0.2 * Math.sin(wy), visibility: 0.9 };
        const s = tracker.update(f, REST);
        if (i >= 110 && s) yaws.push(Math.abs(s.pose.yaw / DEG));
      }
      return yaws.reduce((a, b) => a + b, 0) / yaws.length;
    };
    expect(drawn(false)).toBeLessThan(71);
    expect(drawn(true)).toBeGreaterThan(76);
    expect(drawn(true)).toBeLessThan(84);
  });

  it('f1side: a fast turn back to front is followed with no hold and no snap', () => {
    // live5 6.5-7.1 s (F1b): profile held, then back to facing in 3 frames at a 10 fps cadence;
    // the floored heading used to freeze at the profile value until YAW_STEP_PERSIST_MS ran out.
    const tracker = new ArTracker({ focalPx: 960, turnThrough: true, sideFloor: true });
    const rand = random(91);
    const back = [80, 50, 22, 0, 0, 0];
    const lags: number[] = [];
    for (let i = 0; i < 70 + back.length; i++) {
      const deg = i < 30 ? 0 : i < 70 ? Math.min(80, (i - 30) * 8) : back[i - 70];
      const wdeg = i < 30 ? 0 : i < 70 ? Math.min(68, (i - 30) * 8) : Math.min(68, back[i - 70]);
      const f = frame(
        i * 100,
        K,
        { yaw: deg * DEG, pitch: 0, roll: 0, t: [0, 0.2, 1.8] },
        REST,
        1,
        rand,
      );
      const wy = wdeg * DEG;
      f.world![11] = { x: 0.2 * Math.cos(wy), y: -0.5, z: 0.2 * Math.sin(wy), visibility: 0.9 };
      f.world![12] = { x: -0.2 * Math.cos(wy), y: -0.5, z: -0.2 * Math.sin(wy), visibility: 0.9 };
      const s = tracker.update(f, REST);
      if (i >= 71 && s) lags.push(Math.abs(s.pose.yaw / DEG) - deg);
    }
    // Every frame of the turn back is drawn within 25° of the body (the old hold: 40-80°).
    expect(Math.max(...lags)).toBeLessThan(25);
    // Facing again two frames after the body is.
    expect(Math.abs(lags[lags.length - 1])).toBeLessThan(1);
  });

  it('f1yawfast: a fast coherent turn away is followed every frame; a world spike is held', () => {
    // live5 43.8 s (F1b): turning away at an 8 fps cadence the step hold froze the heading, then
    // it jumped 57 deg in one frame.
    const run = (yawFast: boolean, spike: boolean) => {
      const tracker = new ArTracker({ focalPx: 960, turnThrough: true, yawFast });
      const rand = random(97);
      const errs: number[] = [];
      for (let i = 0; i < 40; i++) {
        const deg = spike ? 0 : i < 30 ? 0 : Math.min(75, (i - 30) * 30);
        const f = frame(
          i * 125,
          K,
          { yaw: deg * DEG, pitch: 0, roll: 0, t: [0, 0.2, 1.8] },
          REST,
          1,
          rand,
        );
        // spike: MediaPipe's world yaw alone reads 40 deg for one frame on a facing person.
        const wy = (spike && i === 32 ? 40 : deg) * DEG;
        f.world![11] = { x: 0.2 * Math.cos(wy), y: -0.5, z: 0.2 * Math.sin(wy), visibility: 0.9 };
        f.world![12] = { x: -0.2 * Math.cos(wy), y: -0.5, z: -0.2 * Math.sin(wy), visibility: 0.9 };
        const s = tracker.update(f, REST);
        if (i >= 30 && s) errs.push(Math.abs(Math.abs(s.pose.yaw / DEG) - deg));
      }
      return Math.max(...errs);
    };
    expect(run(false, false)).toBeGreaterThan(25);
    expect(run(true, false)).toBeLessThan(25);
    // The one-frame spike stays held with the flag (no motion the frame before, span unmoved).
    expect(run(true, true)).toBeLessThan(5);
  });

  it('f1turn: arms the rig has not matched do not move the drawn depth (torso-only placement)', () => {
    const truth: BodyPose = { yaw: 0, pitch: 0, roll: 0, t: [0, 0.1, 1.6] };
    const depths = (on: boolean) => {
      const tracker = new ArTracker({ focalPx: 960, turnThrough: on });
      const rand = random(19);
      const out: number[] = [];
      for (let i = 0; i < 80; i++) {
        // Arms reach forward in the image from frame 40; the overlay body keeps its arms down.
        const joints = i < 40 ? REST : REACH;
        const s = tracker.update(frame(i * 66, K, truth, joints, 1, rand), REST);
        if (i >= 50 && s) out.push(s.pose.t[2]);
      }
      return out;
    };
    const on = depths(true);
    expect(Math.max(...on.map((z) => Math.abs(z / 1.6 - 1)))).toBeLessThan(0.03);
  });

  it('f1turn: facing stays exactly facing; a one-frame world flip is not drawn', () => {
    const tracker = new ArTracker({ focalPx: 960, turnThrough: true });
    const rand = random(31);
    const yaws: number[] = [];
    for (let i = 0; i < 120; i++) {
      const f = frame(i * 33.3, K, { yaw: 0, pitch: 0, roll: 0, t: [0, 0.1, 1.7] }, REST, 3, rand);
      // A MediaPipe left/right flip of the world landmarks on one frame (yaw 180° for a frame).
      if (i === 80) [f.world![11], f.world![12]] = [f.world![12], f.world![11]];
      const s = tracker.update(f, REST);
      if (i >= 30 && s) yaws.push(s.pose.yaw / DEG);
      if (s) expect(s.fade).toBe(0);
    }
    expect(Math.max(...yaws.map(Math.abs))).toBeLessThan(5);
  });

  it('f1fade: a lost body fades out by 0.25 per frame (held pose), a returning one fades in', () => {
    const tracker = new ArTracker({ focalPx: 960, lossFade: true });
    const rand = random(7);
    const truth: BodyPose = { yaw: 0, pitch: 0, roll: 0, t: [0, 0.1, 1.6] };
    const fades: number[] = [];
    for (let i = 0; i < 10; i++)
      fades.push(tracker.update(frame(i * 66, K, truth, REST, 1, rand), REST)!.fade);
    // Fade in from nothing: 0.75, 0.5, 0.25, 0, then 0.
    expect(fades.slice(0, 5).map((f) => +f.toFixed(2))).toEqual([0.75, 0.5, 0.25, 0, 0]);
    const lost = (i: number) =>
      tracker.update({ ...frame(i * 66, K, truth, REST, 1, rand), landmarks2d: null }, REST);
    const out = [10, 11, 12, 13].map(lost);
    expect(out.slice(0, 3).map((s) => +s!.fade.toFixed(2))).toEqual([0.25, 0.5, 0.75]);
    expect(out.slice(0, 3).every((s) => s!.held)).toBe(true);
    expect(out[3]).toBeNull();
    // Back after the loss: fades in again within 4 frames, never a jump > 0.25.
    const back = [14, 15, 16, 17].map(
      (i) => tracker.update(frame(i * 66, K, truth, REST, 1, rand), REST)!.fade,
    );
    expect(back.map((f) => +f.toFixed(2))).toEqual([0.75, 0.5, 0.25, 0]);
    // Without the flag: no person, nothing drawn at once.
    const plain = new ArTracker({ focalPx: 960 });
    plain.update(frame(0, K, truth, REST, 1, rand), REST);
    expect(
      plain.update({ ...frame(66, K, truth, REST, 1, rand), landmarks2d: null }, REST),
    ).toBeNull();
  });

  // f1close (lead U2): a laptop camera at shoulder height, 960×540, f 718 px (75° diagonal prior).
  const KL = centredIntrinsics(960, 540, 718);
  // The rig with eyes; MediaPipe's shoulders/hips spread 0.88 of the rig's joints (cam-tshirt),
  // the eyes are unscaled (config UNSCALED_JOINTS).
  const HEAD: Joints = { ...REST, lEye: [0.032, 1.6, 0.09], rEye: [-0.032, 1.6, 0.09] };
  const SEEN: Joints = Object.fromEntries(
    Object.entries(HEAD).map(([k, v]) => [k, /Eye$/.test(k) ? v : [v[0] * 0.88, v[1], v[2]]]),
  );
  /** Walks in from 2.2 m (full view) to 0.9 m (head to waist: hips and wrists out), then stands. */
  const walkIn = (i: number): BodyPose => {
    const a = Math.min(1, Math.max(0, (i - 60) / 60));
    return { yaw: 0, pitch: 0, roll: 0, t: [0, 0.1 + a * 0.32, 2.2 - a * 1.3] };
  };

  it('f1close: head to waist at 0.9 m (hips out of the frame): drawn every frame, right size, steady', () => {
    const run = (closeRange: boolean, edgeHips: boolean) => {
      const tracker = new ArTracker({
        focalPx: 718,
        turnThrough: true,
        tiltSteady: true,
        closeRange,
      });
      const rand = random(23);
      const depths: number[] = [];
      const full: number[] = [];
      const shoulders: number[][] = [];
      let drawn = 0,
        hipsSeen: boolean | undefined;
      for (let i = 0; i < 240; i++) {
        const f = frame(i * 33.3, KL, walkIn(i), SEEN, 1, rand);
        const l = f.landmarks2d!;
        if (i >= 150) {
          // The pose of the close-up: hips below the frame, MediaPipe's guess for them.
          expect(l[23].y).toBeGreaterThan(540);
          expect(l[11].y).toBeGreaterThan(0);
          // MediaPipe extrapolates the cut hips to the bottom edge, still "visible".
          if (edgeHips) for (const k of [23, 24]) l[k] = { ...l[k], y: 538, visibility: 0.6 };
        }
        const sol = tracker.update(f, HEAD);
        if (i >= 30 && i < 60 && sol) full.push(sol.pose.t[2] / 2.2);
        if (i < 150) continue;
        if (sol) drawn++;
        hipsSeen = sol?.hipsSeen;
        if (i < 180 || !sol) continue;
        depths.push(sol.pose.t[2]);
        shoulders.push(project(KL, sol.pose, sol.pivot, HEAD.lShoulder as Vec3));
      }
      const steps = shoulders
        .slice(1)
        .map((p, k) => Math.hypot(p[0] - shoulders[k][0], p[1] - shoulders[k][1]));
      // The drawn size relative to the full view's (whose own depth carries the session spread's
      // bias): the close-up keeps the size learned with the hips in view.
      const ref = full.reduce((a, b) => a + b, 0) / full.length;
      return {
        drawn,
        hipsSeen,
        depthErr: Math.max(...depths.map((z) => Math.abs(z / 0.9 / ref - 1))),
        stepP95: steps.sort((a, b) => a - b)[Math.floor(0.95 * steps.length)],
      };
    };
    const close = run(true, true);
    expect(close.drawn).toBe(90);
    expect(close.hipsSeen).toBe(false);
    // Measured 2.6 %: the shoulders alone at the session spread (not yet converged) and the 2 %
    // depth deadband; the eyes, which agree in this synthetic body, are not used at close range.
    expect(close.depthErr).toBeLessThan(0.03);
    // About as steady as the plain tracker on the same close-up without the edge hips (1 px
    // noise). Measured 0.344 vs 0.300 px: 4 torso points (shoulders, eyes) instead of 6 average
    // less noise. The glue and the stillness lock act after this.
    const clean = run(false, false);
    expect(close.stepP95).toBeLessThan(1.25 * clean.stepP95);
    // Without the flag the extrapolated edge hips are observations: the jacket is pulled.
    const plain = run(false, true);
    expect(plain.hipsSeen).toBeUndefined();
    expect(plain.depthErr).toBeGreaterThan(0.04);
  });

  it('f1close: shoulders alone place the jacket (head and hips cut, arms the rig has not matched)', () => {
    const sizeErr = (closeRange: boolean) => {
      const tracker = new ArTracker({
        focalPx: 718,
        turnThrough: true,
        tiltSteady: true,
        closeRange,
      });
      const rand = random(29);
      const depths: number[] = [];
      const full: number[] = [];
      const REACHED: Joints = Object.fromEntries(
        Object.entries({ ...SEEN, lElbow: [0.2, 1.33, 0.3], rElbow: [-0.2, 1.33, 0.3] }),
      );
      for (let i = 0; i < 240; i++) {
        const close = i >= 150;
        const f = frame(i * 33.3, KL, walkIn(i), close ? REACHED : SEEN, 1, rand);
        // Head cut by the top edge: no eyes; MediaPipe still has the person.
        if (close) for (const k of [2, 5]) f.landmarks2d![k] = { x: 480, y: -20, visibility: 0.3 };
        const sol = tracker.update(f, HEAD);
        if (close) expect(sol).not.toBeNull();
        if (i >= 30 && i < 60 && sol) full.push(sol.pose.t[2] / 2.2);
        if (i >= 180 && sol) depths.push(sol.pose.t[2] / 0.9);
      }
      const ref = full.reduce((a, b) => a + b, 0) / full.length;
      return Math.max(...depths.map((z) => Math.abs(z / ref - 1)));
    };
    // Measured: 3.2 % (the session spread is still converging) vs 5.3 % with the arms in the
    // placement (f1turn alone falls back to the whole observation when the eyes are gone).
    expect(sizeErr(true)).toBeLessThan(0.04);
    expect(sizeErr(false)).toBeGreaterThan(0.045);
  });

  it('f1close: a short MediaPipe loss keeps the jacket at full opacity, a long one fades (f1fade)', () => {
    const tracker = new ArTracker({ focalPx: 718, closeRange: true, lossFade: true });
    const rand = random(37);
    const truth: BodyPose = { yaw: 0, pitch: 0, roll: 0, t: [0, 0.1, 2.0] };
    for (let i = 0; i < 10; i++) tracker.update(frame(i * 66, KL, truth, SEEN, 1, rand), HEAD);
    const lost = (i: number) =>
      tracker.update({ ...frame(i * 66, KL, truth, SEEN, 1, rand), landmarks2d: null }, HEAD);
    // 15 fps: four lost frames = 264 ms <= CLOSE.holdFullMs: drawn as it was, not faded.
    const short = [10, 11, 12, 13].map(lost);
    expect(short.every((s) => s !== null && s.fade === 0 && s.held)).toBe(true);
    expect(tracker.update(frame(14 * 66, KL, truth, SEEN, 1, rand), HEAD)!.fade).toBe(0);
    // A long loss: held 300 ms, then f1fade's 0.25-per-frame fade, then gone.
    const long = [15, 16, 17, 18, 19, 20, 21, 22, 23].map(lost);
    const fades = long.map((s) => (s ? +s.fade.toFixed(2) : null));
    expect(fades).toEqual([0, 0, 0, 0, 0.25, 0.5, 0.75, null, null]);
  });

  it('extrapolatedLowerBody: bottom edge and low visibility; hips as a pair; sides untouched', () => {
    const l: ImageLandmark[] = Array.from({ length: 33 }, () => ({
      x: 480,
      y: 300,
      visibility: 0.9,
    }));
    expect([...extrapolatedLowerBody(l, 540)]).toEqual([]);
    l[24] = { x: 470, y: 535, visibility: 0.9 }; // within 2 % of the bottom edge
    expect([...extrapolatedLowerBody(l, 540)].sort()).toEqual(['lHip', 'rHip']);
    l[24] = { x: 470, y: 400, visibility: 0.9 };
    l[25] = { x: 470, y: 700, visibility: 0.9 }; // left knee below the frame
    l[28] = { x: 470, y: 400, visibility: 0.2 }; // right ankle not visible
    expect([...extrapolatedLowerBody(l, 540)].sort()).toEqual(['lKnee', 'rAnkle']);
    // A person walking out at a side (venue 50.7 s): the hip past the side is the frame test's,
    // the other hip stays an observation.
    l[25] = l[28] = { x: 470, y: 400, visibility: 0.9 };
    l[24] = { x: -47, y: 400, visibility: 0.92 };
    expect([...extrapolatedLowerBody(l, 540)]).toEqual([]);
  });

  it('lowerEdgeWeights: hips fade out towards the bottom edge, by the nearer of the pair', () => {
    const l: ImageLandmark[] = Array.from({ length: 33 }, () => ({
      x: 480,
      y: 300,
      visibility: 0.9,
    }));
    expect(lowerEdgeWeights(l, 540).lHip).toBe(1);
    l[23] = { x: 500, y: 540 - 0.085 * 540, visibility: 0.9 }; // halfway through the fade band
    const w = lowerEdgeWeights(l, 540);
    expect(w.lHip).toBeCloseTo(0.5, 2);
    expect(w.rHip).toBe(w.lHip);
    l[23] = { x: 500, y: 535, visibility: 0.9 };
    expect(lowerEdgeWeights(l, 540).rHip).toBe(0);
  });

  it('returns null and an unknown alignment when no person is tracked', () => {
    const tracker = new ArTracker();
    const f = frame(0, K, { yaw: 0, pitch: 0, roll: 0, t: [0, 0, 2] }, REST, 0, random(1));
    expect(tracker.update({ ...f, landmarks2d: null }, REST)).toBeNull();
    expect(tracker.alignment).toBeNull();
  });
});
