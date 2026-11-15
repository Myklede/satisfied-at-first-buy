import { describe, expect, it } from 'vitest';
import { neutralPose, synthesizeLandmarks, type AnatomicalPose } from '@satisfy/vision';
import type { LiveFrame } from '../../engine/live/contract';
import type { Perception } from '../contract';
import { PerceptionSource, type PoseFrame } from './perceptionSource';

class FakePerception implements Pick<Perception, 'onPose'> {
  fn?: (f: PoseFrame) => void;
  onPose(fn: (f: PoseFrame) => void) {
    this.fn = fn;
    return () => (this.fn = undefined);
  }
  emit(timeMs: number, pose: AnatomicalPose | null) {
    if (!pose) return this.fn?.({ timeMs, image: [] });
    const input = synthesizeLandmarks(pose);
    this.fn?.({
      timeMs,
      image: (input.image ?? input.world).map((p) => ({ x: p.x, y: p.y, visibility: 1 })),
      world: input.world.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    });
  }
}

describe('PerceptionSource (Perception.onPose → PosePipeline → LiveFrame)', () => {
  it('calibrates on the neutral stand, then emits poses; pixels follow the frame size', async () => {
    const perception = new FakePerception();
    const source = new PerceptionSource(perception, () => ({ width: 1000, height: 500 }));
    const frames: LiveFrame[] = [];
    source.onFrame((f) => frames.push(f));
    await source.start();
    expect(source.calibrated).toBe(false);
    const calibrated = source.calibrate();
    for (let t = 0; t <= 1400; t += 33) perception.emit(t, neutralPose());
    await expect(calibrated).resolves.toBeTruthy();
    expect(source.calibrated).toBe(true);
    // Before calibration: tracked landmarks but no pose (never invented).
    expect(frames[0].landmarks2d).not.toBeNull();
    expect(frames[0].pose).toBeNull();
    const raised: AnatomicalPose = {
      ...neutralPose(),
      shoulder_R_elevation: 90,
      shoulder_R_plane: 20,
    };
    for (let t = 1433; t <= 3000; t += 33) perception.emit(t, raised);
    const last = frames[frames.length - 1];
    expect(last.pose).not.toBeNull();
    expect(last.pose!.shoulder_R_elevation).toBeGreaterThan(70);
    expect(last.width).toBe(1000);
    const nose = synthesizeLandmarks(raised).image![0];
    expect(last.landmarks2d![0].x).toBeCloseTo(nose.x * 1000, 6);
    expect(last.landmarks2d![0].y).toBeCloseTo(nose.y * 500, 6);
    // Time from the first frame (t = 0): the last emitted frame is at 1433 + 47·33 = 2984 ms.
    expect(last.t).toBe(2984);
  });

  it('nobody seen → no landmarks and no pose; camera vertical gives poses without calibration', async () => {
    const perception = new FakePerception();
    const source = new PerceptionSource(perception, () => ({ width: 1280, height: 720 }));
    const frames: LiveFrame[] = [];
    source.onFrame((f) => frames.push(f));
    await source.start();
    perception.emit(0, null);
    expect(frames[0].landmarks2d).toBeNull();
    expect(frames[0].pose).toBeNull();
    source.useCameraVertical();
    perception.emit(33, neutralPose());
    expect(frames[1].pose).not.toBeNull();
    expect(source.usingCameraVertical).toBe(true);
  });

  it('paused: frames stop reaching the engine (the avatar holds); stop unsubscribes', async () => {
    const perception = new FakePerception();
    const source = new PerceptionSource(perception, () => ({ width: 1280, height: 720 }));
    let count = 0;
    source.onFrame(() => count++);
    await source.start();
    perception.emit(0, neutralPose());
    source.setPaused(true);
    perception.emit(33, neutralPose());
    source.setPaused(false);
    perception.emit(66, neutralPose());
    expect(count).toBe(2);
    source.stop();
    expect(perception.fn).toBeUndefined();
  });

  it('calibration aborts with an AbortError (the engine then uses the camera vertical)', async () => {
    const source = new PerceptionSource(new FakePerception(), () => ({ width: 1280, height: 720 }));
    const controller = new AbortController();
    const pending = source.calibrate(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
