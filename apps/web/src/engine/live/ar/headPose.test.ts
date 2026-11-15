import { describe, expect, it } from 'vitest';
import { RIG_FLEXION_AXIS, rotateAbout, sagittalHeadAngleDeg } from './headPose';

// Rig frame: Y up, +Z front, X = the subject's left.
const upright = {
  lShoulder: [0.18, 1.45, 0],
  rShoulder: [-0.18, 1.45, 0],
  lHip: [0.1, 0.95, 0],
  rHip: [-0.1, 0.95, 0],
  head: [0, 1.62, 0],
  face: [0, 1.66, 0.1],
};

describe('sagittalHeadAngleDeg', () => {
  it('is 0 straight above the shoulders and + when the head is forward', () => {
    expect(sagittalHeadAngleDeg(upright)).toBeCloseTo(0, 6);
    const forward = { ...upright, head: [0, 1.45 + 0.17 * Math.cos(0.3), 0.17 * Math.sin(0.3)] };
    expect(sagittalHeadAngleDeg(forward)).toBeCloseTo((0.3 * 180) / Math.PI, 6);
  });

  it('works in a mirrored, y-down frame (MediaPipe world) from the face side', () => {
    // MediaPipe world: y down, z toward the camera negative; the person faces the camera (−z).
    const mp = {
      lShoulder: [-0.18, -0.45, 0],
      rShoulder: [0.18, -0.45, 0],
      lHip: [-0.1, 0.05, 0],
      rHip: [0.1, 0.05, 0],
      head: [0, -0.62 + 0.02, -0.05],
      face: [0, -0.64, -0.15],
    };
    const deg = sagittalHeadAngleDeg(mp)!;
    expect(deg).toBeGreaterThan(0); // head ahead of the shoulders
    expect(deg).toBeCloseTo((Math.atan2(0.05, 0.15) * 180) / Math.PI, 6);
  });
});

describe('rotateAbout', () => {
  it('tips a point above the neck base forward and down about the rig flexion axis', () => {
    const eye = rotateAbout([0, 1.7, 0.08], [0, 1.5, 0], RIG_FLEXION_AXIS, 20);
    expect(eye[2]).toBeGreaterThan(0.08); // forward
    expect(eye[1]).toBeLessThan(1.7); // down
    expect(Math.hypot(eye[1] - 1.5, eye[2])).toBeCloseTo(Math.hypot(0.2, 0.08), 9); // rigid
  });
});
