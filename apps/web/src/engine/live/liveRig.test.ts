import { describe, expect, it } from 'vitest';
import { parseFrames, skinVertices, type AnatomicalPose } from '../motion/rig';
import { fixtureAvailable, fixtureBuffer } from '../motion/testFixture';
import {
  clampPose,
  jointPositions,
  LIVE_DOFS,
  loadLiveRig,
  poseDrivers,
  type TrunkSolverState,
} from './liveRig';

const PRESETS = [
  'reach_up_both',
  'reach_up_one',
  'reach_forward',
  'cross_arms',
  'sit',
  'bend_tie_shoes',
];

describe('clampPose', () => {
  it('clamps every angle DOF to the anatomical limits and reports each change', () => {
    const { pose, clamps } = clampPose({
      trunk_flexion: 120,
      shoulder_L_elevation: -5,
      shoulder_R_plane: 140,
      elbow_L_flexion: 10,
      pelvis_drop_m: 0.1,
    });
    expect(pose.trunk_flexion).toBe(90);
    expect(pose.shoulder_L_elevation).toBe(0);
    expect(pose.shoulder_R_plane).toBe(135);
    expect(pose.elbow_L_flexion).toBe(10);
    expect(pose.pelvis_drop_m).toBe(0.1);
    expect(clamps.map((c) => c.dof)).toEqual([
      'trunk_flexion',
      'shoulder_L_elevation',
      'shoulder_R_plane',
    ]);
    expect(clamps[0]).toEqual({ dof: 'trunk_flexion', requested: 120, applied: 90 });
  });
});

describe.skipIf(!fixtureAvailable('rig.bin', ...PRESETS.map((p) => `frames-${p}.bin`)))(
  'live rig parity with P1 frames.bin',
  () => {
    const live = loadLiveRig(fixtureBuffer('rig.bin'));
    const rig = live.rig;

    it('reproduces the calibrated vertical of the rig header', () => {
      const header = rig.calibratedVertical;
      for (let k = 0; k < 3; k++) expect(live.vertical[k]).toBeCloseTo(header[k], 6);
    });

    it.each(PRESETS)('matches the driver matrices of %s', (preset) => {
      const frames = parseFrames(fixtureBuffer(`frames-${preset}.bin`), rig.drivers.length);
      const n = rig.drivers.length * 12;
      const state: TrunkSolverState = {};
      const ours = new Float32Array(rig.vertexCount * 3),
        theirs = new Float32Array(rig.vertexCount * 3);
      let rot = 0,
        trans = 0,
        vertex = 0,
        drop = 0,
        ms = 0;
      for (let f = 0; f < frames.count; f++) {
        const started = performance.now();
        const result = poseDrivers(live, frames.poses[f], state);
        ms += performance.now() - started;
        expect(result.warnings).toEqual([]);
        const ref = frames.matrices.subarray(f * n, (f + 1) * n);
        for (let k = 0; k < n; k++) {
          const d = Math.abs(result.drivers[k] - ref[k]);
          if (k % 4 === 3) trans = Math.max(trans, d);
          else rot = Math.max(rot, d);
        }
        drop = Math.max(drop, Math.abs(result.pose.pelvis_drop_m - frames.poses[f].pelvis_drop_m));
        if (f % 5 === 0 || f === frames.count - 1) {
          skinVertices(rig, result.drivers, ours);
          skinVertices(rig, ref, theirs);
          for (let v = 0; v < rig.vertexCount; v++)
            vertex = Math.max(
              vertex,
              Math.hypot(
                ours[v * 3] - theirs[v * 3],
                ours[v * 3 + 1] - theirs[v * 3 + 1],
                ours[v * 3 + 2] - theirs[v * 3 + 2],
              ),
            );
        }
      }
      console.log(
        `[liveRig parity] ${preset}: ${frames.count} frames, max |dR| ${rot.toExponential(2)}, ` +
          `max |dt| ${(trans * 1000).toFixed(4)} mm, max vertex ${(vertex * 1000).toFixed(4)} mm, ` +
          `max |d pelvis_drop| ${(drop * 1000).toFixed(4)} mm, ${(ms / frames.count).toFixed(3)} ms/frame`,
      );
      expect(rot).toBeLessThan(1e-3);
      expect(trans).toBeLessThan(5e-4);
      expect(vertex).toBeLessThan(1e-3);
    });

    it('fills missing DOFs from the neutral pose and reports joints', () => {
      const result = poseDrivers(live, { shoulder_R_elevation: 90 });
      const neutral = poseDrivers(live, { ...rig.neutralPose, shoulder_R_elevation: 90 });
      for (let k = 0; k < result.drivers.length; k++)
        expect(result.drivers[k]).toBeCloseTo(neutral.drivers[k], 9);
      expect(result.warnings[0]).toMatch(/neutral used for/);
      for (const dof of LIVE_DOFS) expect(Number.isFinite(result.pose[dof])).toBe(true);
      const joints = jointPositions(live, result.world);
      // Right arm abducted to 90: the right wrist is out at shoulder height on the subject's right
      // (scene −X), the left wrist hangs below the left shoulder.
      expect(joints.rWrist[1]).toBeGreaterThan(joints.rShoulder[1] - 0.08);
      expect(joints.rWrist[0]).toBeLessThan(joints.rShoulder[0] - 0.3);
      expect(joints.lWrist[1]).toBeLessThan(joints.lShoulder[1] - 0.3);
      expect(joints.midHip[1]).toBeGreaterThan(0.7);
    });

    it('never throws on extreme or garbage input', () => {
      const state: TrunkSolverState = {};
      const poses: AnatomicalPose[] = [
        { trunk_flexion: 400, trunk_twist: -400, shoulder_L_elevation: 1000 },
        { trunk_lateral: Number.NaN, elbow_R_flexion: Number.POSITIVE_INFINITY },
        { trunk_flexion: 90, trunk_lateral: 35, trunk_twist: 45 },
        { trunk_flexion: -25, trunk_lateral: -35, trunk_twist: -45 },
      ];
      for (const pose of poses) {
        const result = poseDrivers(live, pose, state);
        expect(result.drivers.every(Number.isFinite)).toBe(true);
      }
    });
  },
);
