import { describe, expect, it } from 'vitest';
import { blendFrames, bodyFrameFromPose, fromBody, POSE, toBody } from './bodyFrame';
import { standingPose } from './testPose';
import { BODY } from './config';

describe('bodyFrameFromPose', () => {
  it('uses the hips for the torso length and points across toward the left shoulder', () => {
    const f = bodyFrameFromPose(standingPose(), 16 / 9)!;
    expect(f.fromHips).toBe(true);
    expect(f.torso).toBeCloseTo(0.4, 6);
    expect(f.ax).toBeCloseTo(1, 6);
    expect(f.by).toBeCloseTo(1, 6);
    // Shoulder line: v = 0; hip line: v = 1; image right = +u (the person's left).
    expect(toBody(f, { x: 0.5, y: 0.35 }).v).toBeCloseTo(0, 6);
    expect(toBody(f, { x: 0.5, y: 0.75 }).v).toBeCloseTo(1, 6);
    expect(toBody(f, { x: 0.6, y: 0.35 }).u).toBeGreaterThan(0);
  });

  it('falls back to the shoulder span when the hips are not seen', () => {
    const f = bodyFrameFromPose(standingPose({ hips: false }), 16 / 9)!;
    expect(f.fromHips).toBe(false);
    expect(f.torso).toBeCloseTo(0.2 * (16 / 9) * BODY.torsoPerShoulder, 6);
  });

  it('returns null without both shoulders', () => {
    const pose = standingPose();
    pose[POSE.leftShoulder] = { ...pose[POSE.leftShoulder], visibility: 0.1 };
    expect(bodyFrameFromPose(pose, 16 / 9)).toBeNull();
    expect(bodyFrameFromPose(standingPose(), 0)).toBeNull();
  });

  it('is scale, position and roll invariant (same body point -> same u, v)', () => {
    const a = bodyFrameFromPose(standingPose(), 16 / 9)!;
    const b = bodyFrameFromPose(
      standingPose({ cx: 0.4, shoulderY: 0.3, hipY: 0.5, span: 0.1, roll: 0.25 }),
      16 / 9,
    )!;
    for (const [u, v] of [
      [0, 0.5],
      [0.3, -0.4],
      [-0.2, 1.1],
    ]) {
      const back = toBody(b, fromBody(b, u, v));
      expect(back.u).toBeCloseTo(u, 6);
      expect(back.v).toBeCloseTo(v, 6);
      const again = toBody(a, fromBody(a, u, v));
      expect(again.v).toBeCloseTo(v, 6);
    }
    // Rolled 0.25 rad: the down axis follows the torso.
    expect(Math.atan2(-b.bx, b.by)).toBeCloseTo(0.25, 6);
  });

  it('blends frames and keeps unit axes', () => {
    const a = bodyFrameFromPose(standingPose(), 16 / 9)!;
    const b = bodyFrameFromPose(standingPose({ cx: 0.6, roll: 0.3 }), 16 / 9)!;
    const m = blendFrames(a, b, 0.5);
    expect(Math.hypot(m.ax, m.ay)).toBeCloseTo(1, 9);
    expect(Math.hypot(m.bx, m.by)).toBeCloseTo(1, 9);
    expect(m.ox).toBeCloseTo((a.ox + b.ox) / 2, 9);
    expect(blendFrames(null, b, 0.5)).toBe(b);
  });
});
