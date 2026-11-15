// Node-only lifecycle tests of the opt-in pose worker adapter (?poseWorker=1): a fake worker port
// and a fake camera; no GPU, DOM or MediaPipe. Checks the one-in-flight slot, main-clock frame
// times, mask-before-frame order, stale replies after stop, and the URL flag parsing.
import { describe, expect, it } from 'vitest';
import { neutralPose, synthesizeLandmarks, type CameraHandle } from '@satisfy/vision';
import { createWorkerPoseTracker, type PoseWorkerPort } from './workerPoseTracker';
import {
  poseWorkerFlags,
  type PoseWorkerReply,
  type PoseWorkerRequest,
} from './poseWorkerProtocol';

class FakePort implements PoseWorkerPort {
  onmessage: ((event: MessageEvent<PoseWorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  sent: PoseWorkerRequest[] = [];
  terminated = false;
  postMessage(value: PoseWorkerRequest) {
    this.sent.push(value);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: PoseWorkerReply) {
    this.onmessage?.({ data } as MessageEvent<PoseWorkerReply>);
  }
  frames() {
    return this.sent.filter(
      (m): m is Extract<PoseWorkerRequest, { type: 'frame' }> => m.type === 'frame',
    );
  }
}

function fakeCamera() {
  const listeners = new Set<(t: number) => void>();
  const handle = {
    video: null,
    source: {} as HTMLVideoElement,
    onFrame(listener: (t: number) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    info: () => ({ deviceId: 'x', label: 'x', width: 1280, height: 720, fps: 30, portrait: false }),
    close() {},
  } as unknown as CameraHandle;
  return { handle, tick: (t: number) => [...listeners].forEach((l) => l(t)) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const bitmap = () => ({ width: 1280, height: 720, close() {} }) as unknown as ImageBitmap;

async function setup(withMask = false, pipeline = false) {
  const port = new FakePort();
  const camera = fakeCamera();
  let now = 0;
  const masks: number[] = [];
  const pending = createWorkerPoseTracker(
    camera.handle,
    { pipeline, ...(withMask ? { onSegmentationMask: (_m, t) => masks.push(t) } : {}) },
    { createWorker: () => port, capture: async () => bitmap(), now: () => now },
  );
  await flush();
  expect(port.sent[0]).toMatchObject({
    type: 'init',
    model: 'full',
    delegate: 'GPU',
    mode: 'VIDEO',
  });
  port.reply({ type: 'ready', delegate: 'GPU' });
  const tracker = await pending;
  return { port, camera, tracker, masks, setNow: (t: number) => (now = t) };
}

const landmarks = () => {
  const { image, world } = synthesizeLandmarks(neutralPose());
  if (!image) throw new Error('synthetic image landmarks missing');
  return { image: image.map((p) => ({ ...p })), world: world.map((p) => ({ ...p })) };
};

describe('createWorkerPoseTracker', () => {
  it('keeps one frame in flight and counts the frames it skips', async () => {
    const { port, camera, tracker } = await setup();
    tracker.start();
    camera.tick(100);
    await flush();
    camera.tick(133);
    camera.tick(166);
    await flush();
    expect(port.frames().map((f) => f.timestamp)).toEqual([100]);
    expect(tracker.stats().framesSkipped).toBe(2);
    port.reply({
      type: 'result',
      id: port.frames()[0].id,
      width: 1280,
      height: 720,
      inferenceMs: 20,
    });
    camera.tick(200);
    await flush();
    expect(port.frames().map((f) => f.timestamp)).toEqual([100, 200]);
    tracker.close();
    expect(port.terminated).toBe(true);
  });

  it('emits raw then filtered frames on the main camera clock, mask first', async () => {
    const { port, camera, tracker, masks, setNow } = await setup(true);
    const order: string[] = [];
    const raws: number[] = [];
    const frames: number[] = [];
    tracker.onRawFrame((r) => {
      order.push('raw');
      raws.push(r.t);
      expect(r.image?.length).toBe(33);
    });
    tracker.onFrame((f) => {
      order.push('frame');
      frames.push(f.frameTime);
    });
    tracker.start();
    camera.tick(5000);
    await flush();
    setNow(5025);
    const mask = { width: 4, height: 2, data: new Float32Array(8) };
    port.reply({
      type: 'result',
      id: port.frames()[0].id,
      width: 1280,
      height: 720,
      ...landmarks(),
      mask,
      inferenceMs: 21,
    });
    expect(masks).toEqual([5000]);
    expect(raws).toEqual([5000]);
    expect(frames).toEqual([5000]);
    expect(order).toEqual(['raw', 'frame']);
    expect(tracker.stats().latencyMs).toBe(25);
    expect(tracker.stats().inferenceMs).toBe(21);
    expect(tracker.lastImageLandmarks()?.length).toBe(33);
    tracker.close();
  });

  it('drops a reply that arrives after stop, and keeps the slot until it does', async () => {
    const { port, camera, tracker } = await setup();
    let emitted = 0;
    tracker.onFrame(() => emitted++);
    tracker.start();
    camera.tick(100);
    await flush();
    tracker.stop();
    tracker.start();
    camera.tick(133);
    await flush();
    // The old job still occupies the worker: no second frame is queued behind it.
    expect(port.frames()).toHaveLength(1);
    port.reply({
      type: 'result',
      id: port.frames()[0].id,
      width: 1280,
      height: 720,
      ...landmarks(),
      inferenceMs: 20,
    });
    expect(emitted).toBe(0);
    camera.tick(166);
    await flush();
    expect(port.frames()).toHaveLength(2);
    tracker.close();
  });

  it('records a worker error without emitting a fake frame', async () => {
    const { port, camera, tracker } = await setup();
    let emitted = 0;
    tracker.onFrame(() => emitted++);
    tracker.start();
    camera.tick(100);
    await flush();
    port.reply({ type: 'error', id: port.frames()[0].id, message: 'boom' });
    expect(emitted).toBe(0);
    expect(tracker.stats().lastError).toBe('boom');
    tracker.close();
  });

  it('rejects initialisation when the worker reports an error', async () => {
    const port = new FakePort();
    const pending = createWorkerPoseTracker(
      fakeCamera().handle,
      {},
      {
        createWorker: () => port,
        capture: async () => bitmap(),
        now: () => 0,
      },
    );
    await flush();
    port.reply({ type: 'error', message: 'no GPU' });
    await expect(pending).rejects.toThrow('no GPU');
    expect(port.terminated).toBe(true);
  });
});

describe('createWorkerPoseTracker, pipelined (posePipe=1)', () => {
  it('sends the newest waiting frame the moment the worker is free, dropping older ones', async () => {
    const { port, camera, tracker } = await setup(false, true);
    const closed: number[] = [];
    let frameTimes: number[] = [];
    tracker.onFrame((f) => frameTimes.push(f.frameTime));
    tracker.start();
    camera.tick(100);
    await flush();
    expect(port.frames().map((f) => f.timestamp)).toEqual([100]);
    camera.tick(133);
    await flush();
    camera.tick(166);
    await flush();
    // 133 waited and was replaced by 166 (closed, counted skipped); nothing queued in the worker.
    expect(port.frames().map((f) => f.timestamp)).toEqual([100]);
    expect(tracker.stats().framesSkipped).toBe(1);
    port.reply({
      type: 'result',
      id: port.frames()[0].id,
      width: 1280,
      height: 720,
      ...landmarks(),
      inferenceMs: 30,
    });
    expect(port.frames().map((f) => f.timestamp)).toEqual([100, 166]);
    expect(frameTimes).toEqual([100]);
    frameTimes = [];
    port.reply({
      type: 'result',
      id: port.frames()[1].id,
      width: 1280,
      height: 720,
      ...landmarks(),
      inferenceMs: 30,
    });
    expect(frameTimes).toEqual([166]);
    // Idle worker: the next frame goes straight through.
    camera.tick(200);
    await flush();
    expect(port.frames().map((f) => f.timestamp)).toEqual([100, 166, 200]);
    void closed;
    tracker.close();
  });

  it('closes the waiting frame on stop and never sends it', async () => {
    const port = new FakePort();
    const camera = fakeCamera();
    const bitmaps: { closed: boolean }[] = [];
    const pending = createWorkerPoseTracker(
      camera.handle,
      { pipeline: true },
      {
        createWorker: () => port,
        capture: async () => {
          const b = {
            width: 1,
            height: 1,
            closed: false,
            close() {
              b.closed = true;
            },
          };
          bitmaps.push(b);
          return b as unknown as ImageBitmap;
        },
        now: () => 0,
      },
    );
    await flush();
    port.reply({ type: 'ready', delegate: 'GPU' });
    const tracker = await pending;
    tracker.start();
    camera.tick(100);
    await flush();
    camera.tick(133);
    await flush();
    expect(bitmaps.map((b) => b.closed)).toEqual([false, false]);
    tracker.stop();
    expect(bitmaps[1].closed).toBe(true);
    port.reply({ type: 'result', id: port.frames()[0].id, width: 1, height: 1, inferenceMs: 1 });
    expect(port.frames()).toHaveLength(1);
    tracker.close();
  });
});

describe('createWorkerPoseTracker, frame-synced display (poseSync=1)', () => {
  it('asks for the frame back and shows it before the pose listeners; closes stale ones', async () => {
    const port = new FakePort();
    const camera = fakeCamera();
    const order: string[] = [];
    const shown: number[] = [];
    const pending = createWorkerPoseTracker(
      camera.handle,
      {
        onDisplayFrame: (b, t) => {
          order.push('display');
          shown.push(t);
          b.close();
        },
      },
      { createWorker: () => port, capture: async () => bitmap(), now: () => 0 },
    );
    await flush();
    port.reply({ type: 'ready', delegate: 'GPU' });
    const tracker = await pending;
    tracker.onFrame(() => order.push('frame'));
    tracker.start();
    camera.tick(100);
    await flush();
    expect(port.frames()[0].returnBitmap).toBe(true);
    let closedStale = false;
    const back = {
      width: 1280,
      height: 720,
      close() {},
    } as unknown as ImageBitmap;
    port.reply({
      type: 'result',
      id: port.frames()[0].id,
      width: 1280,
      height: 720,
      ...landmarks(),
      bitmap: back,
      inferenceMs: 20,
    });
    expect(order).toEqual(['display', 'frame']);
    expect(shown).toEqual([100]);
    camera.tick(133);
    await flush();
    tracker.stop();
    const stale = {
      width: 1,
      height: 1,
      close: () => (closedStale = true),
    } as unknown as ImageBitmap;
    port.reply({
      type: 'result',
      id: port.frames()[1].id,
      width: 1,
      height: 1,
      bitmap: stale,
      inferenceMs: 20,
    });
    expect(closedStale).toBe(true);
    expect(shown).toEqual([100]);
    tracker.close();
  });
});

describe('createWorkerPoseTracker, display-frame clock (poseClock=1)', () => {
  it('delivers a finished pose at the next display frame, after the next capture', async () => {
    const port = new FakePort();
    const camera = fakeCamera();
    const frames: (() => void)[] = [];
    const pending = createWorkerPoseTracker(
      camera.handle,
      { pipeline: true, frameClock: true },
      {
        createWorker: () => port,
        capture: async () => bitmap(),
        now: () => 0,
        frame: (cb) => void frames.push(cb),
      },
    );
    await flush();
    port.reply({ type: 'ready', delegate: 'GPU' });
    const tracker = await pending;
    const got: number[] = [];
    tracker.onFrame((f) => got.push(f.frameTime));
    tracker.start();
    camera.tick(100);
    await flush();
    port.reply({
      type: 'result',
      id: port.frames()[0].id,
      width: 1,
      height: 1,
      ...landmarks(),
      inferenceMs: 1,
    });
    expect(got).toEqual([]);
    // The display frame's camera callback sends the next frame first, then the pose is shown.
    camera.tick(133);
    await flush();
    expect(port.frames().map((f) => f.timestamp)).toEqual([100, 133]);
    frames.shift()?.();
    expect(got).toEqual([100]);
    // Two poses before one display frame: the older is delivered at once, none is lost.
    port.reply({
      type: 'result',
      id: port.frames()[1].id,
      width: 1,
      height: 1,
      ...landmarks(),
      inferenceMs: 1,
    });
    camera.tick(166);
    await flush();
    port.reply({
      type: 'result',
      id: port.frames()[2].id,
      width: 1,
      height: 1,
      ...landmarks(),
      inferenceMs: 1,
    });
    expect(got).toEqual([100, 133]);
    frames.shift()?.();
    expect(got).toEqual([100, 133, 166]);
    tracker.close();
  });
});

describe('createWorkerPoseTracker, evaluation frame stamps', () => {
  it('shows listeners the capture-time __arCameraFrame stamp, then restores the live one', async () => {
    const port = new FakePort();
    const camera = fakeCamera();
    const video = { __arCameraFrame: { index: 1 } } as unknown as HTMLVideoElement & {
      __arCameraFrame: { index: number };
    };
    (camera.handle as { video: unknown }).video = video;
    const pending = createWorkerPoseTracker(
      camera.handle,
      { pipeline: true },
      {
        createWorker: () => port,
        capture: async () => bitmap(),
        now: () => 0,
      },
    );
    await flush();
    port.reply({ type: 'ready', delegate: 'GPU' });
    const tracker = await pending;
    const seen: number[] = [];
    tracker.onFrame(() => seen.push(video.__arCameraFrame.index));
    tracker.start();
    camera.tick(100);
    await flush();
    video.__arCameraFrame = { index: 3 }; // the camera moved on while the worker inferred
    port.reply({
      type: 'result',
      id: port.frames()[0].id,
      width: 1,
      height: 1,
      ...landmarks(),
      inferenceMs: 1,
    });
    expect(seen).toEqual([1]);
    expect(video.__arCameraFrame.index).toBe(3);
    tracker.close();
  });
});

describe('createWorkerPoseTracker, failure', () => {
  it('reports a failure after repeated inference errors and on a worker crash', async () => {
    for (const crash of [false, true]) {
      const port = new FakePort();
      const camera = fakeCamera();
      const reasons: string[] = [];
      const pending = createWorkerPoseTracker(
        camera.handle,
        { onFailure: (r) => reasons.push(r) },
        { createWorker: () => port, capture: async () => bitmap(), now: () => 0 },
      );
      await flush();
      port.reply({ type: 'ready', delegate: 'GPU' });
      const tracker = await pending;
      tracker.start();
      if (crash) port.onerror?.({ message: 'boom' } as ErrorEvent);
      else
        for (let i = 0; i < 15; i++) {
          camera.tick(100 + i * 33);
          await flush();
          port.reply({ type: 'error', id: port.frames().at(-1)!.id, message: 'context lost' });
        }
      expect(reasons).toEqual([crash ? 'boom' : 'pose worker: context lost']);
      expect(port.terminated).toBe(true);
    }
  });
});

describe('createWorkerPoseTracker, capture hook', () => {
  it('announces each captured frame synchronously, before its bitmap is taken', async () => {
    for (const pipeline of [false, true]) {
      const port = new FakePort();
      const camera = fakeCamera();
      const order: string[] = [];
      const pending = createWorkerPoseTracker(
        camera.handle,
        { pipeline, onCapture: (t) => order.push(`capture ${t}`) },
        {
          createWorker: () => port,
          capture: async () => {
            order.push('bitmap');
            return bitmap();
          },
          now: () => 0,
        },
      );
      await flush();
      port.reply({ type: 'ready', delegate: 'GPU' });
      const tracker = await pending;
      tracker.start();
      camera.tick(100);
      expect(order).toEqual(['capture 100', 'bitmap']);
      tracker.close();
    }
  });
});

describe('createWorkerPoseTracker, downscaled inference (camHd)', () => {
  it('infers on a <= 960 px copy, keeps full-resolution landmarks and display frame', async () => {
    const port = new FakePort();
    const camera = fakeCamera();
    (camera.handle as { source: unknown }).source = { videoWidth: 1920, videoHeight: 1080 };
    const sizes: (string | null)[] = [];
    const shown: { width: number }[] = [];
    const pending = createWorkerPoseTracker(
      camera.handle,
      {
        inputMaxSide: 960,
        onDisplayFrame: (b) => {
          shown.push({ width: b.width });
          b.close();
        },
      },
      {
        createWorker: () => port,
        capture: async (_s, size) => {
          sizes.push(size ? `${size.width}x${size.height}` : null);
          return {
            width: size?.width ?? 1920,
            height: size?.height ?? 1080,
            close() {},
          } as unknown as ImageBitmap;
        },
        now: () => 0,
      },
    );
    await flush();
    port.reply({ type: 'ready', delegate: 'GPU' });
    const tracker = await pending;
    const raws: { width: number; height: number }[] = [];
    tracker.onRawFrame((r) => raws.push({ width: r.width, height: r.height }));
    tracker.start();
    camera.tick(100);
    await flush();
    expect(sizes).toEqual(['960x540', null]);
    expect(port.frames()[0].returnBitmap).toBe(false);
    port.reply({
      type: 'result',
      id: port.frames()[0].id,
      width: 960,
      height: 540,
      ...landmarks(),
      inferenceMs: 1,
    });
    expect(raws).toEqual([{ width: 1920, height: 1080 }]);
    expect(shown).toEqual([{ width: 1920 }]);
    tracker.close();
  });
});

describe('poseWorkerFlags', () => {
  it('is off by default and parses the experiment flags', () => {
    expect(poseWorkerFlags('')).toEqual({
      enabled: false,
      mode: 'VIDEO',
      delegate: undefined,
      pipeline: false,
      sync: false,
      clock: false,
    });
    expect(poseWorkerFlags('?poseWorker=1&poseClock=1').clock).toBe(true);
    expect(poseWorkerFlags('?poseClock=1').clock).toBe(false);
    expect(poseWorkerFlags('?poseSync=1').sync).toBe(false);
    expect(poseWorkerFlags('?poseWorker=1&poseSync=1').sync).toBe(true);
    expect(poseWorkerFlags('?poseWorker=1')).toMatchObject({ enabled: true, mode: 'VIDEO' });
    expect(poseWorkerFlags('?poseWorker=1&poseMode=image')).toMatchObject({
      enabled: true,
      mode: 'IMAGE',
    });
    expect(poseWorkerFlags('?poseWorker=1&posePipe=1&poseDelegate=cpu')).toMatchObject({
      pipeline: true,
      delegate: 'CPU',
    });
    // The pipeline needs the worker; the delegate applies to either path.
    expect(poseWorkerFlags('?posePipe=1&poseDelegate=gpu')).toMatchObject({
      enabled: false,
      pipeline: false,
      delegate: 'GPU',
    });
    expect(() => poseWorkerFlags('?poseMode=image')).toThrow();
  });
});
