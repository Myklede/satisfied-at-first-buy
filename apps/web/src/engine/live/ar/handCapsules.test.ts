import { describe, expect, it } from 'vitest';
import type { ImageLandmark, LiveFrame } from '../contract';
import type { ArSolution } from './ArTracker';
import { handCapsules } from './ArCompositor';
import { centredIntrinsics, type BodyPose } from './cameraModel';
import { HAND_DEPTH_MARGIN_M, HAND_REACH } from './config';

function frameWith(points: Record<number, [number, number, number]>): LiveFrame {
  const l: ImageLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  for (const [i, [x, y, v]] of Object.entries(points)) l[Number(i)] = { x, y, visibility: v };
  return {
    t: 0,
    width: 720,
    height: 1280,
    landmarks2d: l,
    world: null,
    pose: null,
    confidence: {},
    mask: null,
  };
}

const pose: BodyPose = { yaw: 0, pitch: 0, roll: 0, t: [0, 0, 1.5] };
const solution = {
  t: 0,
  intrinsics: centredIntrinsics(720, 1280, 950),
  pose,
  raw: pose,
  rawRmsPx: 0,
  pivot: [0, 0.92, 0],
  focal: {} as ArSolution['focal'],
  alignment: null,
  fade: 0,
  backView: false,
} satisfies ArSolution;

describe('hand occluder capsules', () => {
  it('runs from the wrist past the knuckles at the posed wrist depth, minus the margin', () => {
    // Left hand: wrist (15), pinky knuckle (17), index knuckle (19).
    const frame = frameWith({ 15: [400, 700, 0.9], 17: [390, 740, 0.9], 19: [420, 740, 0.9] });
    // Posed left wrist 0.25 m in front of the pelvis (+Z front, camera at 1.5 m).
    const [h] = handCapsules(frame, solution, { lWrist: [0.2, 1.1, 0.25] });
    expect(h.a).toEqual([400, 700]);
    expect(h.b[0]).toBeCloseTo(400 + 5 * HAND_REACH, 6);
    expect(h.b[1]).toBeCloseTo(700 + 40 * HAND_REACH, 6);
    expect(h.depth).toBeCloseTo(1.5 - 0.25 - HAND_DEPTH_MARGIN_M, 6);
    expect(h.radius).toBeGreaterThan(15);
  });

  it('skips a hand whose landmarks are not visible or whose wrist is not posed', () => {
    const frame = frameWith({ 15: [400, 700, 0.3], 17: [390, 740, 0.9], 19: [420, 740, 0.9] });
    expect(handCapsules(frame, solution, { lWrist: [0.2, 1.1, 0.25] })).toEqual([]);
    const seen = frameWith({ 16: [300, 700, 0.9], 18: [290, 740, 0.9], 20: [320, 740, 0.9] });
    expect(handCapsules(seen, solution, {})).toEqual([]);
  });
});
