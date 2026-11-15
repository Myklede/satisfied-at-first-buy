// The opt-in pose worker must never take the kiosk down: if it cannot start, or fails while
// running, TrackedSource continues on the main-thread tracker (same camera, same calibration).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraHandle, PoseTracker, PoseTrackerOptions } from '@satisfy/vision';

const made: { kind: string; tracker: PoseTracker; options: unknown }[] = [];
// When set, the main-thread factory waits for this promise (a slow model load).
let mainGate: Promise<void> | undefined;
let workerMode: 'reject' | 'ok' = 'ok';
let workerFailure: ((reason: string) => void) | undefined;

function fakeTracker(kind: string): PoseTracker {
  let calibration: unknown = null;
  let closed = false;
  return {
    onFrame: () => () => undefined,
    onRawFrame: () => () => undefined,
    lastImageLandmarks: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    close: () => void (closed = true),
    calibrate: () => Promise.reject(new Error('n/a')),
    setCalibration: (c) => void (calibration = c),
    calibration: () => calibration as never,
    stats: () => ({
      model: 'full',
      delegate: 'GPU',
      inferenceHz: 0,
      latencyMs: 0,
      inferenceMs: 0,
      framesProcessed: 0,
      framesSkipped: 0,
      lastError: kind + (closed ? ' closed' : ''),
    }),
  };
}

vi.mock('@satisfy/vision', async (orig) => ({
  ...(await orig<typeof import('@satisfy/vision')>()),
  createPoseTracker: vi.fn(async (_h: CameraHandle, options: PoseTrackerOptions) => {
    if (mainGate) await mainGate;
    const tracker = fakeTracker('main');
    made.push({ kind: 'main', tracker, options });
    return tracker;
  }),
}));
vi.mock('./workerPoseTracker', () => ({
  createWorkerPoseTracker: vi.fn(
    async (_h: CameraHandle, options: { onFailure?: (r: string) => void }) => {
      if (workerMode === 'reject') throw new Error('no worker GPU');
      workerFailure = options.onFailure;
      const tracker = fakeTracker('worker');
      made.push({ kind: 'worker', tracker, options });
      return tracker;
    },
  ),
}));

const { TrackedSource } = await import('./trackedSource');

const handle = () =>
  ({
    video: {} as HTMLVideoElement,
    source: {} as HTMLVideoElement,
    onFrame: () => () => undefined,
    info: () => ({ deviceId: 'x', label: 'x', width: 1280, height: 720, fps: 30, portrait: false }),
    close: () => undefined,
  }) as unknown as CameraHandle;

describe('TrackedSource pose-worker fallback', () => {
  beforeEach(() => {
    made.length = 0;
    workerFailure = undefined;
    vi.stubGlobal('location', { search: '?poseWorker=1' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('starts on the main-thread tracker when the worker cannot start', async () => {
    workerMode = 'reject';
    const source = new TrackedSource('camera', async () => handle());
    await source.start();
    expect(made.map((m) => m.kind)).toEqual(['main']);
    expect(source.workerFallback).toBe('no worker GPU');
    source.stop();
  });

  it('swaps to the main-thread tracker when the worker fails, keeping the calibration', async () => {
    workerMode = 'ok';
    const source = new TrackedSource('camera', async () => handle());
    await source.start();
    expect(made.map((m) => m.kind)).toEqual(['worker']);
    const calibration = { neutral: true };
    made[0].tracker.setCalibration(calibration as never);
    workerFailure?.('GPU context lost');
    await new Promise((r) => setTimeout(r, 0));
    expect(made.map((m) => m.kind)).toEqual(['worker', 'main']);
    expect(made[1].tracker.calibration()).toBe(calibration);
    expect(source.workerFallback).toBe('GPU context lost');
    expect(source.stats()?.lastError).toBe('main');
    source.stop();
  });
});

describe('TrackedSource camera busy', () => {
  it('turns NotReadableError (device_busy) into the actionable Retry message', async () => {
    const { CameraError } = await import('@satisfy/vision');
    const { CAMERA_BUSY_HELP } = await import('./cameraText');
    const source = new TrackedSource('camera', async () => {
      throw new CameraError('device_busy', 'The camera is in use by another application.');
    });
    await expect(source.start()).rejects.toThrow(CAMERA_BUSY_HELP);
    // Retry = start() again: a fresh getUserMedia attempt, no page reload.
    await expect(source.start()).rejects.toThrow(CAMERA_BUSY_HELP);
  });
});

describe('TrackedSource camera lifecycle', () => {
  beforeEach(() => {
    made.length = 0;
    vi.stubGlobal('location', { search: '' });
  });
  afterEach(() => {
    mainGate = undefined;
    vi.unstubAllGlobals();
  });

  it('stop() during a pending tracker init closes the camera at once, not after the init', async () => {
    let release!: () => void;
    mainGate = new Promise<void>((r) => (release = r));
    const closes: number[] = [];
    const camera = { ...handle(), close: () => void closes.push(Date.now()) } as CameraHandle;
    const source = new TrackedSource('camera', async () => camera);
    const started = source.start();
    await new Promise((r) => setTimeout(r, 0)); // camera opened, model still loading
    expect(closes).toHaveLength(0);
    source.stop();
    expect(closes).toHaveLength(1); // released now: the next getUserMedia can open the device
    release();
    await expect(started).rejects.toThrow('stopped');
    expect(source.stats()).toBeNull();
  });

  it("a stale getUserMedia resolving late never hides a newer start's pending camera", async () => {
    let release!: () => void;
    mainGate = new Promise<void>((r) => (release = r));
    const closes = { old: 0, fresh: 0 };
    let resolveOld!: (h: CameraHandle) => void;
    const opens = [
      () => new Promise<CameraHandle>((r) => (resolveOld = r)),
      async () => ({ ...handle(), close: () => void closes.fresh++ }) as CameraHandle,
    ];
    let n = 0;
    const source = new TrackedSource('camera', () => opens[n++]());
    const first = source.start();
    source.stop(); // getUserMedia #1 still pending
    const second = source.start();
    await new Promise((r) => setTimeout(r, 0)); // #2 open, its tracker init pending
    resolveOld({ ...handle(), close: () => void closes.old++ } as CameraHandle);
    await expect(first).rejects.toThrow('stopped');
    expect(closes.old).toBe(1);
    source.stop(); // must release #2's camera now, before its init settles
    expect(closes.fresh).toBe(1);
    release();
    await expect(second).rejects.toThrow('stopped');
  });

  it('retries a briefly busy camera (previous screen still releasing it)', async () => {
    const { CameraError } = await import('@satisfy/vision');
    let calls = 0;
    const source = new TrackedSource('camera', async () => {
      if (++calls < 3) throw new CameraError('device_busy', 'busy');
      return handle();
    });
    await source.start();
    expect(calls).toBe(3);
    expect(made.map((m) => m.kind)).toEqual(['main']);
    source.stop();
  });
});

describe('TrackedSource ?camExposure=1', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('sets a manual exposure that fits 30 fps when the camera exposes it, and records diagnostics', async () => {
    const applied: unknown[] = [];
    class FakeStream {
      constructor(private track: unknown) {}
      getVideoTracks() {
        return [this.track];
      }
    }
    vi.stubGlobal('MediaStream', FakeStream);
    vi.stubGlobal('location', { search: '?camExposure=1' });
    const track = {
      getCapabilities: () => ({
        exposureMode: ['continuous', 'manual'],
        exposureTime: { min: 2.44, max: 1250 },
      }),
      getSettings: () => ({ frameRate: 30, exposureMode: 'manual' }),
      applyConstraints: async (c: unknown) => void applied.push(c),
    };
    const cam = {
      ...handle(),
      video: { srcObject: new FakeStream(track) },
    } as unknown as CameraHandle;
    const source = new TrackedSource('camera', async () => cam);
    await source.start();
    expect(applied).toEqual([{ advanced: [{ exposureMode: 'manual', exposureTime: 333 }] }]);
    expect(source.cameraDiagnostics?.exposure).toBe('manual 333 (100 us units)');
    source.stop();
  });
});

describe('TrackedSource ?camExposure=auto', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('keeps auto exposure at 30 fps and fixes it after 3 s below 24 fps', async () => {
    vi.useFakeTimers();
    const applied: unknown[] = [];
    class FakeStream {
      constructor(private track: unknown) {}
      getVideoTracks() {
        return [this.track];
      }
    }
    vi.stubGlobal('MediaStream', FakeStream);
    vi.stubGlobal('location', { search: '?camExposure=auto' });
    const track = {
      readyState: 'live',
      stats: { totalFrames: 0 },
      getCapabilities: () => ({
        exposureMode: ['continuous', 'manual'],
        exposureTime: { min: 2.44, max: 1250 },
      }),
      getSettings: () => ({ frameRate: 30 }),
      applyConstraints: async (c: unknown) => void applied.push(c),
    };
    const cam = {
      ...handle(),
      video: { srcObject: new FakeStream(track) },
    } as unknown as CameraHandle;
    const source = new TrackedSource('camera', async () => cam);
    await source.start();
    const second = async (fps: number) => {
      track.stats.totalFrames += fps;
      await vi.advanceTimersByTimeAsync(1000);
    };
    for (let i = 0; i < 5; i++) await second(30);
    expect(applied).toEqual([]);
    await second(15);
    await second(15);
    expect(applied).toEqual([]);
    await second(15);
    expect(applied).toEqual([{ advanced: [{ exposureMode: 'manual', exposureTime: 333 }] }]);
    expect(source.cameraDiagnostics?.exposure).toBe(
      'manual 333 (100 us units) after 3 s at 15 fps',
    );
    source.stop();
  });
});
