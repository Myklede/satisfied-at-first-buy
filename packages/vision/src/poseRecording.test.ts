import { describe, expect, it } from 'vitest';
import {
  ANATOMICAL_DOFS,
  POSE_LIMITS,
  neutralPose,
  type AnatomicalDof,
  type AnatomicalPose,
  type Vec3,
} from './anatomicalPose';
import { PosePipeline, type PoseTrackerFrame } from './posePipeline';
import {
  landmarkToQuad,
  parsePoseRecording,
  replayPoseRecording,
  serializePoseRecording,
  type PoseRecording,
  type RecordedPoseFrame,
} from './poseRecording';
import { synthesizeLandmarks } from './poseSynth';

const pose = (p: Partial<AnatomicalPose>): AnatomicalPose => ({ ...neutralPose(), ...p });

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const std = (a: number[]) => {
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};

function frameOf(p: AnatomicalPose, t: number, noise?: () => Vec3): RecordedPoseFrame {
  const s = synthesizeLandmarks(p, noise ? { noise } : {});
  return {
    t,
    width: 1280,
    height: 720,
    world: s.world.map(landmarkToQuad),
    image: s.image!.map(landmarkToQuad),
  };
}

function recordingOf(frames: RecordedPoseFrame[]): PoseRecording {
  return {
    format: 'satisfy-pose-recording',
    version: 1,
    createdAt: '2026-11-12T00:00:00Z',
    source: {
      camera: 'synthetic',
      width: 1280,
      height: 720,
      fps: 30,
      delegate: 'CPU',
      model: 'none',
    },
    calibration: null,
    meta: { motion: 'neutral' },
    frames,
  };
}

describe('PosePipeline', () => {
  it('calibrates after 1 s of still neutral standing', () => {
    const p = new PosePipeline();
    let calibratedAt: number | undefined;
    p.onCalibrated(() => (calibratedAt ??= 0));
    p.startCalibration();
    const input = synthesizeLandmarks(neutralPose(), { cameraPitchDeg: 10 });
    let last: PoseTrackerFrame | undefined;
    for (let t = 0; t <= 1100; t += 33) last = p.update(t, input);
    expect(calibratedAt).toBe(0);
    expect(last!.calibrated).toBe(true);
    expect(p.isCalibrating).toBe(false);
    // After calibration, the pitched camera no longer reads as trunk flexion.
    for (let t = 1133; t < 2000; t += 33) last = p.update(t, input);
    expect(Math.abs(last!.pose.trunk_flexion)).toBeLessThan(0.01);
  });

  it('reduces jitter of a still pose under 1 cm landmark noise', () => {
    const r = rng(11);
    const noise = (): Vec3 => [0.01 * gauss(r), 0.01 * gauss(r), 0.01 * gauss(r)];
    const p = new PosePipeline();
    const want = pose({ shoulder_R_elevation: 90, elbow_R_flexion: 60, hip_L_flexion: 30 });
    const raw: Record<string, number[]> = {};
    const filt: Record<string, number[]> = {};
    for (let i = 0; i < 300; i++) {
      const s = synthesizeLandmarks(want, { noise });
      const f = p.update(i * 33.3, s);
      if (i < 60) continue; // settle
      for (const d of [
        'shoulder_R_elevation',
        'elbow_R_flexion',
        'hip_L_flexion',
      ] as AnatomicalDof[]) {
        (raw[d] ??= []).push(f.raw[d]);
        (filt[d] ??= []).push(f.pose[d]);
      }
    }
    const report = Object.keys(raw).map(
      (d) => `${d} ${std(raw[d]).toFixed(2)}→${std(filt[d]).toFixed(2)}°`,
    );
    console.info('[pose filter] jitter std raw→filtered at 30 Hz:', report.join(', '));
    for (const d of Object.keys(raw)) expect(std(filt[d])).toBeLessThan(0.5 * std(raw[d]));
  });

  it('follows a fast arm raise with bounded lag', () => {
    const p = new PosePipeline();
    let maxLag = 0;
    // 0 → 160° in 0.5 s (320 deg/s), sampled at 30 Hz.
    for (let i = 0; i <= 45; i++) {
      const t = i * 33.3;
      const elev = Math.min(160, Math.max(0, (t - 200) * 0.32));
      const f = p.update(t, synthesizeLandmarks(pose({ shoulder_R_elevation: elev })));
      maxLag = Math.max(maxLag, Math.abs(f.pose.shoulder_R_elevation - f.raw.shoulder_R_elevation));
    }
    console.info(
      `[pose filter] max |filtered − raw| during a 320 deg/s raise: ${maxLag.toFixed(1)}°`,
    );
    expect(maxLag).toBeLessThan(25);
  });

  it('reports zero confidence and holds the pose while nobody is seen', () => {
    const p = new PosePipeline();
    const s = synthesizeLandmarks(pose({ elbow_L_flexion: 80, shoulder_L_elevation: 30 }));
    for (let t = 0; t < 1000; t += 33) p.update(t, s);
    const gone = p.update(1033, undefined);
    expect(gone.personDetected).toBe(false);
    expect(Math.max(...ANATOMICAL_DOFS.map((d) => gone.confidence[d]))).toBe(0);
    expect(gone.pose.elbow_L_flexion).toBeCloseTo(80, 0);
  });
});

describe('pose recordings', () => {
  it('serialises, parses and replays like the live pipeline', () => {
    const frames: RecordedPoseFrame[] = [];
    for (let i = 0; i < 60; i++)
      frames.push(
        i === 20
          ? { t: i * 33, width: 1280, height: 720 }
          : frameOf(pose({ elbow_R_flexion: i * 2 }), i * 33),
      );
    const rec = recordingOf(frames);
    const parsed = parsePoseRecording(JSON.parse(serializePoseRecording(rec)));
    expect(parsed.frames).toHaveLength(60);
    expect(parsed.frames[20].world).toBeUndefined();
    const live = new PosePipeline();
    const liveOut = rec.frames.map((f) =>
      live.update(
        f.t,
        f.world
          ? {
              world: f.world.map(([x, y, z, visibility]) => ({ x, y, z, visibility })),
              image: f.image!.map(([x, y, z, visibility]) => ({ x, y, z, visibility })),
            }
          : undefined,
      ),
    );
    const replay = replayPoseRecording(parsed);
    for (let i = 0; i < 60; i++)
      expect(replay[i].pose.elbow_R_flexion).toBeCloseTo(liveOut[i].pose.elbow_R_flexion, 2);
  });

  it('rejects malformed files', () => {
    expect(() => parsePoseRecording({ format: 'x' })).toThrow(/format/);
    const bad = JSON.parse(serializePoseRecording(recordingOf([frameOf(neutralPose(), 0)])));
    bad.frames[0].world = bad.frames[0].world.slice(0, 10);
    expect(() => parsePoseRecording(bad)).toThrow(/33/);
    const badMotion = JSON.parse(serializePoseRecording(recordingOf([])));
    badMotion.meta.motion = 'dance';
    expect(() => parsePoseRecording(badMotion)).toThrow(/meta.motion/);
  });
});

// ---------- Real recordings (packages/vision/test-data/pose/*.json, gitignored) ----------
const realFiles = import.meta.glob('../test-data/pose/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;
const realEntries = Object.entries(realFiles);

/**
 * Loose expectations on arm DOFs (the reliable ones) per motion; peaks over frames whose
 * confidence for that DOF is ≥ 0.5. Legs/trunk are only reported (depth-ambiguous facing a camera).
 */
const MOTION_CHECKS: Partial<Record<string, Array<[AnatomicalDof, number]>>> = {
  reach_up_both: [
    ['shoulder_L_elevation', 120],
    ['shoulder_R_elevation', 120],
  ],
  reach_up_one: [['shoulder_R_elevation', 120]],
  cross_arms: [
    ['elbow_L_flexion', 60],
    ['elbow_R_flexion', 60],
  ],
};

describe('real pose recordings (test-data/pose)', () => {
  if (realEntries.length === 0) {
    it.skip('no recordings found: use "Record pose" in lab/pose.html', () => {});
    return;
  }
  for (const [file, json] of realEntries) {
    const name = file.split('/').pop();
    const rec = parsePoseRecording(json);
    if (rec.meta.invalid) {
      it.skip(`${name}: marked invalid (${rec.meta.invalidReason ?? 'no reason given'})`, () => {});
      continue;
    }
    it(`replays ${name}`, () => {
      const out = replayPoseRecording(rec);
      const seen = out.filter((f) => f.personDetected);
      const peak: Record<string, number> = {};
      const meanConf: Record<string, number> = {};
      for (const d of ANATOMICAL_DOFS) {
        const [lo, hi] = POSE_LIMITS[d];
        for (const f of out) {
          expect(Number.isFinite(f.pose[d])).toBe(true);
          expect(f.pose[d]).toBeGreaterThanOrEqual(lo - 1e-9);
          expect(f.pose[d]).toBeLessThanOrEqual(hi + 1e-9);
          expect(f.confidence[d]).toBeGreaterThanOrEqual(0);
          expect(f.confidence[d]).toBeLessThanOrEqual(1);
        }
        const good = seen.filter((f) => f.confidence[d] >= 0.5);
        peak[d] = good.length ? Math.max(...good.map((f) => f.pose[d])) : NaN;
        meanConf[d] = seen.length ? seen.reduce((s, f) => s + f.confidence[d], 0) / seen.length : 0;
      }
      const span = ((rec.frames.at(-1)?.t ?? 0) - (rec.frames[0]?.t ?? 0)) / 1000;
      console.info(
        `[pose replay] ${name} motion=${rec.meta.motion ?? '-'} ${rec.frames.length} frames / ${span.toFixed(1)} s, ` +
          `person in ${seen.length}, calibrated=${rec.calibration !== null}\n` +
          ANATOMICAL_DOFS.map(
            (d) =>
              `  ${d.padEnd(22)} peak ${peak[d].toFixed(d === 'pelvis_drop_m' ? 2 : 0).padStart(6)}  mean conf ${meanConf[d].toFixed(2)}`,
          ).join('\n'),
      );
      for (const [d, min] of MOTION_CHECKS[rec.meta.motion ?? ''] ?? [])
        expect(peak[d], `${name}: peak ${d}`).toBeGreaterThan(min);
    });
  }
});
