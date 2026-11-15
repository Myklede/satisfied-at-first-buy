import { describe, expect, it } from 'vitest';
import type { LiveFrame } from '../contract.ts';
import { MIN_DOF_CONFIDENCE } from '../livePose.ts';
import { RECORD } from './config.ts';
import {
  heldLabels,
  longestGap,
  RECORDED_DOFS,
  recordedPoses,
  RecordingError,
} from './recordedPoses.ts';

const ALL = Object.fromEntries(RECORDED_DOFS.map((d) => [d, 0.9]));

/** A tracked frame at t ms: every DOF = `value(dof)`, confidence 0.9 unless overridden. */
function frame(
  t: number,
  value: (dof: string) => number,
  confidence: Record<string, number> = {},
): LiveFrame {
  return {
    t,
    width: 720,
    height: 1280,
    landmarks2d: [],
    world: [],
    pose: Object.fromEntries([...RECORDED_DOFS, 'pelvis_drop_m'].map((d) => [d, value(d)])),
    confidence: { ...ALL, ...confidence },
    mask: null,
  };
}
const lost = (t: number): LiveFrame => ({ ...frame(t, () => 0), pose: null, confidence: {} });
const ramp = (t: number) => (dof: string) => (dof.includes('elevation') ? 20 + t / 50 : 5);

describe('recorded sequence → poses', () => {
  it('keeps the tracked DOFs as measured, shifts time to the first pose, never sends pelvis drop', () => {
    const frames = Array.from({ length: 31 }, (_, i) => frame(1000 + i * 33, ramp(i * 33)));
    const { poses, trace } = recordedPoses(frames);
    expect(poses).toHaveLength(31);
    expect(poses[0].t).toBe(0);
    expect(poses[30].t).toBe(990);
    expect(poses[10].pose.shoulder_L_elevation).toBe(20 + 330 / 50); // no smoothing, no rounding
    expect(Object.keys(poses[0].pose).sort()).toEqual([...RECORDED_DOFS].sort());
    expect('pelvis_drop_m' in poses[0].pose).toBe(false);
    expect(trace).toMatchObject({ frames: 31, tracked: 31, used: 31, neutral: [], clamped: 0 });
    expect(trace.message).toContain('every joint tracked');
  });

  it('holds a DOF estimated too rarely at neutral for the whole move, and says so', () => {
    // Axial rotation: confidence 0.05 (< minConfidence) in every frame; knees: missing in 30 %.
    const frames = Array.from({ length: 30 }, (_, i) =>
      frame(i * 33, ramp(i * 33), {
        shoulder_L_axial: 0.05,
        shoulder_R_axial: 0.05,
        knee_L_flexion: i % 10 < 3 ? 0 : 0.9,
      }),
    );
    expect(MIN_DOF_CONFIDENCE).toBeGreaterThan(0.05);
    const { poses, trace } = recordedPoses(frames);
    const held = trace.neutral.map((n) => n.dof);
    expect(held).toEqual(['shoulder_L_axial', 'shoulder_R_axial', 'knee_L_flexion']);
    expect(trace.neutral[2].share).toBeCloseTo(0.7);
    for (const p of poses)
      for (const dof of held) expect(dof in p.pose, `${dof} must be left out`).toBe(false);
    expect(poses).toHaveLength(30); // nothing else was missing: no frame skipped
    expect(trace.message).toMatch(/kept at rest: arm rotation, left knee.$/);
  });

  it('skips a short dropout of a kept DOF as a whole frame (bridged by the service)', () => {
    const frames = Array.from({ length: 30 }, (_, i) =>
      frame(i * 33, ramp(i * 33), i === 12 || i === 13 ? { elbow_R_flexion: 0 } : {}),
    );
    const { poses, trace } = recordedPoses(frames);
    expect(trace.kept).toContain('elbow_R_flexion');
    expect(poses).toHaveLength(28);
    expect(poses.map((p) => p.t)).not.toContain(12 * 33);
    expect(trace.longestGapMs).toBe(99);
  });

  it('holds a DOF at neutral when its own dropout is longer than maxGapMs', () => {
    const frames = Array.from({ length: 60 }, (_, i) =>
      frame(i * 33, ramp(i * 33), i >= 20 && i < 29 ? { elbow_R_flexion: 0 } : {}),
    );
    const { trace } = recordedPoses(frames);
    expect(trace.neutral.map((n) => n.dof)).toEqual(['elbow_R_flexion']);
    expect(trace.neutral[0].longestGapMs).toBeGreaterThan(RECORD.maxGapMs);
  });

  it('fails honestly when the person is lost for too long or never tracked', () => {
    const gap = [
      ...Array.from({ length: 10 }, (_, i) => frame(i * 33, () => 10)),
      ...Array.from({ length: 10 }, (_, i) => lost(330 + i * 33)),
      ...Array.from({ length: 10 }, (_, i) => frame(660 + i * 33, () => 10)),
    ];
    expect(() => recordedPoses(gap)).toThrow(RecordingError);
    expect(() => recordedPoses(gap)).toThrow(/Lost you for 0\.\d s/);
    expect(() => recordedPoses([lost(0), lost(33)])).toThrow(/No one was tracked/);
    const nothing = Array.from({ length: 10 }, (_, i) =>
      frame(i * 33, () => 10, Object.fromEntries(RECORDED_DOFS.map((d) => [d, 0]))),
    );
    expect(() => recordedPoses(nothing)).toThrow(/not tracked well enough/);
  });

  it("keeps the person's own sides (no mirror) and windows by time", () => {
    const frames = Array.from({ length: 30 }, (_, i) =>
      frame(i * 33, (d) => (d === 'shoulder_R_elevation' ? 150 : d === 'trunk_lateral' ? 8 : 5)),
    );
    const { poses } = recordedPoses(frames, { startMs: 330, endMs: 660 });
    expect(poses[0].pose.shoulder_R_elevation).toBe(150);
    expect(poses[0].pose.shoulder_L_elevation).toBe(5);
    expect(poses[0].pose.trunk_lateral).toBe(8);
    expect(poses).toHaveLength(11);
  });

  it('clamps values outside the anatomical limits and counts them', () => {
    const frames = Array.from({ length: 10 }, (_, i) =>
      frame(i * 33, (d) => (d === 'shoulder_L_elevation' ? 180.4 : 5)),
    );
    const { poses, trace } = recordedPoses(frames);
    expect(poses[0].pose.shoulder_L_elevation).toBe(180);
    expect(trace.clamped).toBe(10);
  });

  it('names complete groups as one word on screen', () => {
    expect(
      heldLabels([
        'trunk_twist',
        'hip_L_flexion',
        'hip_R_flexion',
        'knee_L_flexion',
        'knee_R_flexion',
      ]),
    ).toEqual(['legs', 'trunk twist']);
    expect(heldLabels(['shoulder_L_axial', 'hip_L_flexion'])).toEqual([
      'left arm rotation',
      'left hip',
    ]);
  });

  it('refuses a limb that jumps faster than a person moves (the tracker lost it)', () => {
    // Left arm overhead, then read 100 deg lower one frame later (as on the user's video).
    const frames = Array.from({ length: 30 }, (_, i) =>
      frame(i * 33, (d) =>
        d === 'shoulder_L_elevation' ? (i < 15 ? 128 : 28) : d === 'shoulder_L_plane' ? 40 : 5,
      ),
    );
    expect(() => recordedPoses(frames)).toThrow(RecordingError);
    expect(() => recordedPoses(frames)).toThrow(/lost your left arm .* 0.5 s in/);
  });

  it('does not count a plane flip near gimbal lock as a jump (humerus direction barely moves)', () => {
    // Arm hanging at 5 deg: the plane of elevation swings 180 deg between frames.
    const frames = Array.from({ length: 30 }, (_, i) =>
      frame(i * 33, (d) =>
        d === 'shoulder_R_elevation' ? 5 : d === 'shoulder_R_plane' ? (i % 2 ? 90 : -90) : 5,
      ),
    );
    const { trace } = recordedPoses(frames);
    expect(trace.peakJointSpeed.degS).toBeLessThan(RECORD.maxJointSpeedDegS);
    expect(trace.peakJointSpeed.degS).toBeCloseTo(10 / 0.033, 0);
  });

  it('measures gaps including the window edges', () => {
    expect(longestGap([100, 150, 400], 0, 450)).toBe(250);
    expect(longestGap([], 0, 450)).toBe(450);
  });
});
