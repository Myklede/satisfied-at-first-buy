import type { CameraHandle } from '@satisfy/vision';
import {
  buildSchema,
  jacketSchema,
  makeManifest,
  type CaptureBuild,
  type CaptureFrame,
  type CaptureManifest,
} from './manifest';
import { captureBase, routineAt, VIDEO_BITS_PER_SECOND, type CaptureStep } from './routine';

export interface CaptureResult {
  base: string;
  video: Blob;
  manifest: CaptureManifest;
}

/** Record the camera's raw MediaStream, never a canvas, composited view or screenshot.
 * Caller owns camera.close() on completion, cancellation and unmount. No network or storage API.
 */
export async function recordRoutine(
  camera: CameraHandle,
  options: {
    jacket: string;
    build: CaptureBuild;
    signal: AbortSignal;
    onProgress: (progress: ReturnType<typeof routineAt>) => void;
  },
): Promise<CaptureResult> {
  const jacket = jacketSchema.parse(options.jacket),
    build = buildSchema.parse(options.build);
  if (options.signal.aborted) throw new DOMException('Capture cancelled', 'AbortError');
  const stream = camera.video.srcObject;
  if (
    !(stream instanceof MediaStream) ||
    !stream.getVideoTracks().some((track) => track.readyState === 'live')
  )
    throw Error('Start the camera before recording.');
  if (typeof camera.video.requestVideoFrameCallback !== 'function')
    throw Error('This browser cannot timestamp camera frames. Use Chrome for capture.');
  if (typeof MediaRecorder === 'undefined')
    throw Error('Camera recording is unavailable in this browser.');
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
  if (!mimeType) throw Error('This browser cannot record WebM. Use Chrome for capture.');
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
  });
  if (recorder.videoBitsPerSecond < 5_000_000)
    throw Error('The browser did not accept the minimum 5 Mbit/s encoding target.');
  const info = camera.info();
  const chunks: Blob[] = [],
    frames: CaptureFrame[] = [],
    steps: CaptureStep[] = [];
  let started = 0,
    ended = 0,
    cameraMediaStartMs = 0;
  let createdAt = new Date();
  let frameRequest = 0,
    timer: ReturnType<typeof setInterval> | undefined;
  let finishing = false,
    settled = false,
    lastCue = '';
  let active: CaptureStep | undefined;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearInterval(timer);
      camera.video.cancelVideoFrameCallback(frameRequest);
      options.signal.removeEventListener('abort', abort);
      stream.getVideoTracks().forEach((track) => track.removeEventListener('ended', cameraEnded));
      recorder.onstart = recorder.onstop = recorder.ondataavailable = recorder.onerror = null;
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      finishing = true;
      cleanup();
      chunks.length = 0;
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          /* already stopped by a device error */
        }
      }
      reject(error);
    };
    const abort = () => fail(new DOMException('Capture cancelled', 'AbortError'));
    const cameraEnded = () => fail(Error('The camera stopped during the routine. Please retry.'));
    const observe: VideoFrameRequestCallback = (now, metadata) => {
      if (finishing) return;
      const tMs = now - started;
      if (tMs >= 0 && (!frames.length || tMs > frames[frames.length - 1].tMs))
        frames.push({ tMs, mediaTimeMs: metadata.mediaTime * 1000 });
      frameRequest = camera.video.requestVideoFrameCallback(observe);
    };
    const tick = () => {
      if (finishing) return;
      const elapsed = performance.now() - started,
        next = routineAt(elapsed);
      const key = `${next.kind}:${next.kind === 'move' ? next.name : next.step}`;
      if (key !== lastCue) {
        if (active) {
          active.endMs = elapsed;
          active = undefined;
        }
        if (next.kind === 'move') {
          if (steps.length !== next.segmentIndex)
            return fail(
              Error(
                'The routine skipped a cue while the page was paused. Retry in the foreground.',
              ),
            );
          active = { name: next.name, startMs: elapsed, endMs: elapsed };
          steps.push(active);
        }
        lastCue = key;
      }
      options.onProgress(next);
      if (next.kind === 'done') {
        finishing = true;
        ended = elapsed;
        clearInterval(timer);
        camera.video.cancelVideoFrameCallback(frameRequest);
        try {
          recorder.stop();
        } catch (error) {
          fail(error);
        }
      }
    };
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onerror = () => fail(Error('The browser camera encoder failed. Please retry.'));
    recorder.onstart = () => {
      started = performance.now();
      createdAt = new Date();
      cameraMediaStartMs = camera.video.currentTime * 1000;
      frameRequest = camera.video.requestVideoFrameCallback(observe);
      tick();
      timer = setInterval(tick, 50);
    };
    recorder.onstop = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        if (!finishing || !ended)
          throw Error('The recording ended before the routine was complete.');
        const video = new Blob(chunks, { type: recorder.mimeType });
        chunks.length = 0;
        const base = captureBase(createdAt);
        const manifest = makeManifest({
          createdAt,
          videoFilename: `${base}.webm`,
          build,
          jacket,
          camera: { label: info.label, width: info.width, height: info.height },
          durationMs: ended,
          cameraMediaStartMs,
          steps,
          frames,
          mimeType: recorder.mimeType,
          recorderBitsPerSecond: recorder.videoBitsPerSecond,
          bytes: video.size,
        });
        resolve({ base, video, manifest });
      } catch (error) {
        reject(error);
      }
    };
    options.signal.addEventListener('abort', abort, { once: true });
    stream.getVideoTracks().forEach((track) => track.addEventListener('ended', cameraEnded));
    try {
      recorder.start(1000);
    } catch (error) {
      fail(error);
    }
  });
}
