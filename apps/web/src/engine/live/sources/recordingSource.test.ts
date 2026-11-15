import { describe, expect, it } from 'vitest';
import {
  NeutralCalibrator,
  neutralPose,
  synthesizeLandmarks,
  type AnatomicalPose,
  type NeutralCalibration,
  type PoseRecording,
} from '@satisfy/vision';
import { decodeSatb } from '../../motion/satb';
import { parseRig } from '../../motion/rig';
import { fixtureAvailable, fixtureBuffer } from '../../motion/testFixture';
import { createLiveRig, poseDrivers } from '../liveRig';
import { gatePose } from '../livePose';
import { recordingFrames } from './recordingSource';

type Quad = [number, number, number, number];
const quads = (
  points: readonly { x: number; y: number; z: number; visibility?: number }[],
): Quad[] => points.map((p) => [p.x, p.y, p.z, p.visibility ?? 1]);

function calibration(): NeutralCalibration {
  const cal = new NeutralCalibrator(1000);
  const input = synthesizeLandmarks(neutralPose());
  for (let t = 0; t <= 1100; t += 33) {
    const r = cal.update(t, input);
    if (r.done) return r.done;
  }
  throw new Error('synthetic calibration did not finish');
}

/** A numbers-only recording of the subject raising the RIGHT arm (vision's synthetic body). */
function raiseRightArm(): PoseRecording {
  const frames = [];
  for (let i = 0; i < 60; i++) {
    const want: AnatomicalPose = {
      ...neutralPose(),
      shoulder_R_elevation: Math.min(150, i * 5),
      shoulder_R_plane: 30,
    };
    const input = synthesizeLandmarks(want);
    frames.push({
      t: 1000 + i * 33,
      width: 1280,
      height: 720,
      world: quads(input.world),
      image: quads(input.image ?? input.world),
    });
  }
  return {
    format: 'satisfy-pose-recording',
    version: 1,
    createdAt: '2026-11-13T00:00:00Z',
    source: {
      camera: 'synthetic',
      width: 1280,
      height: 720,
      fps: 30,
      delegate: 'CPU',
      model: 'full',
    },
    calibration: calibration(),
    meta: {},
    frames,
  } as PoseRecording;
}

describe('recordingFrames', () => {
  it('replays a recording as LiveFrames with the true anatomical sides', () => {
    const frames = recordingFrames(raiseRightArm());
    expect(frames).toHaveLength(60);
    expect(frames[0].t).toBe(0);
    const last = frames[frames.length - 1];
    expect(last.pose).not.toBeNull();
    expect(last.landmarks2d).toHaveLength(33);
    // Image landmarks are in source pixels.
    expect(Math.max(...last.landmarks2d!.map((l) => l.x))).toBeGreaterThan(1);
    expect(last.pose!.shoulder_R_elevation).toBeGreaterThan(100);
    expect(last.pose!.shoulder_L_elevation).toBeLessThan(30);
  });

  it.skipIf(!fixtureAvailable('rig.bin'))(
    'drives the rig so the subject’s right wrist (−X in the scene) rises',
    () => {
      const buffer = fixtureBuffer('rig.bin');
      const rig = parseRig(buffer);
      const header = decodeSatb(buffer, 'rig').header as unknown as { parents: number[] };
      const live = createLiveRig(rig, header.parents);
      const last = recordingFrames(raiseRightArm()).at(-1)!;
      const { pose } = gatePose(last.pose!, last.confidence, rig.neutralPose);
      const posed = poseDrivers(live, pose);
      const index = (name: string) => live.index.get(name)! * 16;
      const y = (name: string) => posed.world[index(name) + 7];
      const x = (name: string) => posed.world[index(name) + 3];
      expect(y('wrist.R')).toBeGreaterThan(y('upperarm01.R'));
      expect(y('wrist.L')).toBeLessThan(y('upperarm01.L'));
      expect(x('wrist.R')).toBeLessThan(0);
    },
  );
});
