// Subdivision of fast recorded moves and the sleeve sanity gate (V3, after V1's report of a bare
// raised arm with 84.9 cm "ride-up": the fast arm went through the sleeve).
import { describe, expect, it } from 'vitest';
import type { BakedMotion } from '../../motion/bake.ts';
import { MOTION_IDS } from '../../motion/config.ts';
import { parseFrames, parseRig, type MotionFrames } from '../../motion/rig.ts';
import { fixtureAvailable, fixtureBuffer } from '../../motion/testFixture.ts';
import { checkSleeves } from './RecordedBakedMove.ts';
import { SUBDIVISION, subdivisionFor } from './subdivision.ts';

const DT = 1 / 60;

/** Frames whose four joints (wrist L/R, elbow L/R) follow `at(f)` for the left wrist. */
function frames(count: number, at: (f: number) => [number, number, number]): MotionFrames {
  const joints = new Float32Array(count * 12);
  for (let f = 0; f < count; f++) {
    const [x, y, z] = at(f);
    // wrist.L moves; wrist.R, elbow.L, elbow.R stay put (elbow 25 cm above each wrist).
    joints.set([x, y, z, -0.2, 1, 0, 0.2, 1.25, 0, -0.2, 1.25, 0], f * 12);
  }
  return {
    motion: {
      id: 'custom',
      label: '',
      duration_s: count / 30,
      hold: { start_s: 0, end_s: 0 },
      keyframes: [],
    },
    fps: 30,
    count,
    matrices: new Float32Array(0),
    frames: [],
    poses: [],
    anchors: new Map([['joints', { data: joints, perFrame: 12 }]]),
  };
}

describe('step subdivision', () => {
  it('keeps the presets at the default step (their per-step travel was validated)', () => {
    if (!fixtureAvailable('rig.bin', ...MOTION_IDS.map((m) => `frames-${m}.bin`))) return;
    const rig = parseRig(fixtureBuffer('rig.bin'));
    for (const id of MOTION_IDS) {
      const s = subdivisionFor(
        parseFrames(fixtureBuffer(`frames-${id}.bin`), rig.drivers.length),
        DT,
      );
      expect(s.factor, id).toBe(1);
      expect(s.config).toBeUndefined();
      expect(s.stepTravelM).toBeLessThanOrEqual(SUBDIVISION.stepTravelLimitM);
    }
  });

  it('splits a step when a joint travels further than the validated limit', () => {
    // 10 cm per frame = 3 m/s: 5 cm per default step → 2 sub-steps of 2.5 cm.
    const fast = subdivisionFor(
      frames(10, (f) => [0.2, 1 + 0.1 * f, 0]),
      DT,
    );
    expect(fast.factor).toBe(2);
    expect(fast.config!.dt).toBeCloseTo(DT / 2, 15);
    expect(fast.peakSpeedMs).toBeCloseTo(3, 5);
    expect(fast.peakJoint).toBe('wrist.L');
    expect(fast.stepTravelM).toBeCloseTo(0.025, 6);
    expect(fast.capped).toBe(false);
    // 30 cm per frame = 9 m/s: would need 5, capped at maxFactor (and the sleeve gate decides).
    const capped = subdivisionFor(
      frames(4, (f) => [0.2, 1 + 0.3 * f, 0]),
      DT,
    );
    expect(capped.factor).toBe(SUBDIVISION.maxFactor);
    expect(capped.capped).toBe(true);
  });
});

describe('sleeve sanity gate', () => {
  const cuffs = { cuff_L: [0, 1, 0], cuff_R: [2, 3, 2] }; // closed rings
  /** A 3-frame bake: cuff rings at the wrists, unless `away` moves the left cuff. */
  function bake(away: number, beyond: number[]) {
    const f = frames(3, () => [0.2, 1, 0]);
    const positions = new Float32Array(3 * 4 * 3);
    for (let i = 0; i < 3; i++) {
      const lift = i === 2 ? away : 0;
      positions.set([0.19, 1 + lift, 0, 0.21, 1 + lift, 0, -0.19, 1, 0, -0.21, 1, 0], i * 12);
    }
    const metrics = beyond.map((L) => ({ cuffBeyondWristCm: { L, R: 3 } }));
    return {
      frames: f,
      bake: {
        positions,
        particles: 4,
        metrics,
        frameCount: 3,
        fps: 30,
      } as unknown as BakedMotion,
    };
  }

  it('passes a sleeve that stays on the forearm', () => {
    const { bake: b, frames: f } = bake(0.05, [3, 0, -8]);
    const check = checkSleeves(b, f, { paths: cuffs });
    expect(check.valid).toBe(true);
    expect(check.forearmCm.L).toBeCloseTo(25, 4);
    expect(check.maxRideUpCm.L).toBeCloseTo(11, 4);
    expect(check.reason).toBeNull();
  });

  it('fails a sleeve that rode up past the forearm, or a cuff far from its wrist', () => {
    const rode = bake(0, [3, 3, -30]);
    const a = checkSleeves(rode.bake, rode.frames, { paths: cuffs });
    expect(a).toMatchObject({ valid: false, frame: 2, side: 'L' });
    expect(a.reason).toMatch(/left sleeve came off the arm 0\.1 s into the move/);
    const far = bake(0.4, [3, 3, 3]);
    const b = checkSleeves(far.bake, far.frames, { paths: cuffs });
    expect(b).toMatchObject({ valid: false, frame: 2, side: 'L' });
    expect(b.maxCuffToWristCm.L).toBeCloseTo(40, 3);
  });
});
