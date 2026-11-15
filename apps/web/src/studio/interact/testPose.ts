// Test helper: a synthetic pose (numbers only) for the studio interaction tests.
import type { Landmark2D } from '../contract';
import { POSE } from './bodyFrame';

/** 33 pose landmarks of a person facing the camera (normalised, not mirrored). */
export function standingPose(
  opts: {
    cx?: number;
    shoulderY?: number;
    hipY?: number;
    span?: number;
    aspect?: number;
    hips?: boolean;
    roll?: number;
  } = {},
): Landmark2D[] {
  const {
    cx = 0.5,
    shoulderY = 0.35,
    hipY = 0.75,
    span = 0.2,
    aspect = 16 / 9,
    hips = true,
    roll = 0,
  } = opts;
  const pts: Landmark2D[] = Array.from({ length: 33 }, () => ({ x: cx, y: 0.2, visibility: 0.9 }));
  // Points in isotropic units round the shoulder midpoint, then rotated by `roll` (rad).
  const place = (dx: number, dy: number): Landmark2D => {
    const c = Math.cos(roll),
      s = Math.sin(roll),
      x = cx * aspect + dx * c - dy * s,
      y = shoulderY + dx * s + dy * c;
    return { x: x / aspect, y, visibility: 0.95 };
  };
  const half = (span * aspect) / 2; // span is in normalised x; isotropic half width
  // Person's LEFT shoulder (11) appears on image RIGHT in an unmirrored frame.
  pts[POSE.leftShoulder] = place(half, 0);
  pts[POSE.rightShoulder] = place(-half, 0);
  pts[POSE.leftHip] = { ...place(half * 0.7, hipY - shoulderY), visibility: hips ? 0.9 : 0.1 };
  pts[POSE.rightHip] = { ...place(-half * 0.7, hipY - shoulderY), visibility: hips ? 0.9 : 0.1 };
  pts[POSE.nose] = place(0, -0.15);
  return pts;
}
