// Local video file source: an <video> playing a file the user picked (object URL, never
// uploaded) or a loopback dev URL, wrapped as a CameraHandle so the same pose tracker runs on it.
// Frames come from requestVideoFrameCallback, one callback per presented video frame.
import type { CameraHandle } from '@satisfy/vision';
import { TrackedSource, type TrackedSourceOptions } from './trackedSource.ts';

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback(callback: (now: number) => void): number;
  cancelVideoFrameCallback(handle: number): void;
};

/** CameraHandle over a playing <video> (exported for tests and the labs). */
export function videoHandle(video: HTMLVideoElement, label = 'video file'): CameraHandle {
  const v = video as FrameCallbackVideo;
  if (typeof v.requestVideoFrameCallback !== 'function')
    throw new Error('This browser cannot read video frames (requestVideoFrameCallback missing).');
  const listeners = new Set<(t: number) => void>();
  const times: number[] = [];
  let handle = 0;
  let closed = false;
  const emit = (now: number) => {
    times.push(now);
    while (times.length && now - times[0] > 1000) times.shift();
    for (const l of listeners) l(now);
  };
  const tick = (now: number) => {
    if (closed) return;
    emit(now);
    handle = v.requestVideoFrameCallback(tick);
  };
  handle = v.requestVideoFrameCallback(tick);
  // A paused video presents no new frames: re-emit the held frame at 30 Hz (calibration on a
  // chosen frame, or a still image to inspect).
  const held = setInterval(() => {
    if (!closed && video.paused && video.readyState >= 2) emit(performance.now());
  }, 33);
  return {
    video,
    source: video,
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    info: () => ({
      deviceId: 'file',
      label,
      width: video.videoWidth,
      height: video.videoHeight,
      fps: times.length,
      portrait: video.videoHeight > video.videoWidth,
    }),
    close() {
      closed = true;
      clearInterval(held);
      v.cancelVideoFrameCallback(handle);
      listeners.clear();
      video.pause();
    },
  };
}

export type VideoFileSourceOptions = TrackedSourceOptions & {
  /** Start position (s). */
  startAt?: number;
  loop?: boolean;
  /** Playback rate; 1 = real time. */
  rate?: number;
};

/**
 * A source over a local file (`File` → object URL, revoked on stop) or a URL served from loopback.
 * The <video> is muted and plays inline; the caller may attach `source.video` to the DOM.
 */
export function createVideoFileSource(
  input: File | string,
  options: VideoFileSourceOptions = {},
): TrackedSource {
  const url = typeof input === 'string' ? input : URL.createObjectURL(input);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.loop = options.loop ?? true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  const open = async () => {
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      if (video.readyState >= 2) return resolve();
      video.addEventListener('loadeddata', () => resolve(), { once: true });
      video.addEventListener(
        'error',
        () => reject(new Error('This video file cannot be played in the browser.')),
        { once: true },
      );
    });
    if (options.startAt) video.currentTime = options.startAt;
    video.playbackRate = options.rate ?? 1;
    await video.play();
    return videoHandle(video, typeof input === 'string' ? 'reference video' : input.name);
  };
  const hold = {
    pause: () => video.pause(),
    resume: () => void video.play().catch(() => undefined),
  };
  return new TrackedSource('video-file', open, { holdForCalibration: hold, ...options }, () => {
    video.removeAttribute('src');
    video.load();
    if (typeof input !== 'string') URL.revokeObjectURL(url);
  });
}
