import { afterEach, expect, it, vi } from 'vitest';
import type { CameraHandle } from '@satisfy/vision';
import { recordRoutine } from './record';

// Encoder/device transport fixtures only. Real raw-video encoding is checked with fake Chrome.
class FakeStream {
  track = Object.assign(new EventTarget(), { readyState: 'live' });
  getVideoTracks() {
    return [this.track];
  }
}
class FakeRecorder {
  static last: FakeRecorder;
  static isTypeSupported() {
    return true;
  }
  state: RecordingState = 'inactive';
  mimeType: string;
  videoBitsPerSecond: number;
  onstart: MediaRecorder['onstart'] = null;
  onstop: MediaRecorder['onstop'] = null;
  ondataavailable: MediaRecorder['ondataavailable'] = null;
  onerror: MediaRecorder['onerror'] = null;
  constructor(
    readonly stream: MediaStream,
    options: MediaRecorderOptions,
  ) {
    FakeRecorder.last = this;
    this.mimeType = options.mimeType!;
    this.videoBitsPerSecond = options.videoBitsPerSecond!;
  }
  start() {
    this.state = 'recording';
    this.onstart?.call(this as unknown as MediaRecorder, new Event('start'));
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.call(
      this as unknown as MediaRecorder,
      { data: new Blob(['synthetic encoder data']) } as BlobEvent,
    );
    this.onstop?.call(this as unknown as MediaRecorder, new Event('stop'));
  }
}
function fixture() {
  vi.useFakeTimers({
    toFake: ['performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  const network = vi.fn(() => {
    throw Error('Network is forbidden during capture');
  });
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('XMLHttpRequest', network);
  vi.stubGlobal('navigator', { sendBeacon: network });
  const stream = new FakeStream();
  let request = 0;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const video = {
    srcObject: stream,
    currentTime: 1,
    requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
      const id = ++request;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          video.currentTime += 0.033;
          callback(performance.now(), {
            mediaTime: video.currentTime,
          } as VideoFrameCallbackMetadata);
        }, 33),
      );
      return id;
    },
    cancelVideoFrameCallback(id: number) {
      clearTimeout(timers.get(id));
      timers.delete(id);
    },
  };
  const camera = {
    video,
    info: () => ({ label: 'synthetic camera', width: 1280, height: 720 }),
  } as unknown as CameraHandle;
  const abort = new AbortController();
  const options = {
    jacket: 'Synthetic test garment',
    build: { commit: 'a'.repeat(40), dirty: false },
    signal: abort.signal,
    onProgress: vi.fn(),
  };
  return { camera, stream, abort, options, network };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('records the exact raw camera stream, measured cue/frame times, and makes no network calls', async () => {
  const f = fixture();
  const pending = recordRoutine(f.camera, f.options);
  await vi.advanceTimersByTimeAsync(74600);
  const result = await pending;
  expect(FakeRecorder.last.stream).toBe(f.stream);
  expect(result.manifest.encoding.requestedBitsPerSecond).toBeGreaterThanOrEqual(5_000_000);
  expect(result.manifest.encoding.recorderBitsPerSecond).toBe(7_000_000);
  expect(result.manifest.encoding.actualBitsPerSecond).toBeLessThan(7_000_000);
  expect(result.manifest.steps).toHaveLength(12);
  expect(result.manifest.frames.length).toBeGreaterThan(2000);
  expect(result.manifest.camera.fps).toBeCloseTo(1000 / 33);
  expect(await result.video.text()).toBe('synthetic encoder data');
  expect(f.network).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels recording and all callbacks without exporting a partial video', async () => {
  const f = fixture();
  const pending = recordRoutine(f.camera, f.options);
  f.abort.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(FakeRecorder.last.state).toBe('inactive');
  expect(vi.getTimerCount()).toBe(0);
  expect(f.network).not.toHaveBeenCalled();
});
it('rejects a camera ending mid-routine and tears down the encoder', async () => {
  const f = fixture();
  const pending = recordRoutine(f.camera, f.options);
  f.stream.track.dispatchEvent(new Event('ended'));
  await expect(pending).rejects.toThrow('camera stopped');
  expect(FakeRecorder.last.state).toBe('inactive');
  expect(vi.getTimerCount()).toBe(0);
});
