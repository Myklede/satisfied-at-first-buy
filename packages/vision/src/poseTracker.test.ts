// createPoseTracker's opt-in segmentation (agent V2): off by default, on only with a callback,
// mask copied before the frame listeners run and every MediaPipe mask closed. MediaPipe and the
// DOM are stubbed: this checks the wiring, not the model.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraHandle } from './types';

const created: { options: { outputSegmentationMasks?: boolean } }[] = [];
const closedMasks: number[] = [];
let nextResult: () => unknown = () => ({ landmarks: [], worldLandmarks: [] });

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: async () => ({}) },
  PoseLandmarker: {
    createFromOptions: async (
      _fileset: unknown,
      options: { outputSegmentationMasks?: boolean },
    ) => {
      created.push({ options });
      return {
        detectForVideo: (_source: unknown, timestamp: number) =>
          timestamp === 1 ? { landmarks: [], worldLandmarks: [] } : nextResult(),
        close: () => undefined,
      };
    },
  },
}));

const landmark = (x: number, y: number) => ({ x, y, z: 0, visibility: 0.9 });
const person = () => ({
  landmarks: [Array.from({ length: 33 }, (_, i) => landmark(0.4 + i * 0.005, 0.3 + i * 0.01))],
  worldLandmarks: [Array.from({ length: 33 }, (_, i) => landmark(i * 0.01, -i * 0.02))],
});
function mpMask(id: number, value: number) {
  return {
    width: 2,
    height: 2,
    getAsFloat32Array: () => new Float32Array([value, value, value, value]),
    close: () => closedMasks.push(id),
  };
}

function fakeCamera() {
  const listeners = new Set<(t: number) => void>();
  const source = { width: 4, height: 4 } as unknown as HTMLCanvasElement;
  const camera = {
    video: {} as HTMLVideoElement,
    source,
    onFrame: (l: (t: number) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    info: () => ({ deviceId: '', label: '', width: 4, height: 4, fps: 30, portrait: false }),
    close: () => undefined,
  } satisfies CameraHandle;
  return { camera, tick: (t: number) => listeners.forEach((l) => l(t)) };
}

beforeEach(() => {
  created.length = 0;
  closedMasks.length = 0;
  vi.stubGlobal('HTMLVideoElement', class {});
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ fillRect: () => undefined }),
    }),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createPoseTracker segmentation option', () => {
  it('keeps segmentation off by default', async () => {
    const { createPoseTracker } = await import('./poseTracker');
    const { camera } = fakeCamera();
    const tracker = await createPoseTracker(camera, { delegate: 'CPU' });
    expect(created).toHaveLength(1);
    expect(created[0].options.outputSegmentationMasks).toBe(false);
    tracker.close();
  });

  it('turns it on with a callback, delivers a copy before the frame listeners, closes masks', async () => {
    const { createPoseTracker } = await import('./poseTracker');
    const { camera, tick } = fakeCamera();
    const order: string[] = [];
    let received: { data: Float32Array; width: number; height: number } | undefined;
    const tracker = await createPoseTracker(camera, {
      delegate: 'CPU',
      onSegmentationMask: (mask) => {
        order.push('mask');
        received = mask;
      },
    });
    expect(created[0].options.outputSegmentationMasks).toBe(true);
    tracker.onRawFrame(() => order.push('raw'));
    tracker.onFrame(() => order.push('frame'));
    tracker.start();
    nextResult = () => ({ ...person(), segmentationMasks: [mpMask(1, 0.75)] });
    tick(100);
    expect(order).toEqual(['mask', 'raw', 'frame']);
    expect(received).toMatchObject({ width: 2, height: 2 });
    expect(Array.from(received!.data)).toEqual([0.75, 0.75, 0.75, 0.75]);
    expect(closedMasks).toEqual([1]);
    // No person: no mask callback, but the mask MediaPipe returned is still closed.
    nextResult = () => ({ landmarks: [], worldLandmarks: [], segmentationMasks: [mpMask(2, 0)] });
    order.length = 0;
    tick(200);
    expect(order).toEqual(['raw', 'frame']);
    expect(closedMasks).toEqual([1, 2]);
    tracker.close();
  });
});
