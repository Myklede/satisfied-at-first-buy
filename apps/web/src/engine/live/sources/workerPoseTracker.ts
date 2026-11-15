import {
  PosePipeline,
  type CameraHandle,
  type NeutralCalibration,
  type PoseTracker,
  type PoseTrackerFrame,
  type PoseTrackerOptions,
  type RecordedPoseFrame,
} from '@satisfy/vision';
import type {
  PoseGraphMode,
  PoseWorkerReply,
  PoseWorkerRequest,
  WorkerLandmark,
} from './poseWorkerProtocol';
import { poseInputSize } from './cameraChoice';

/** A narrow transport seam permits Node-only lifecycle tests without a GPU or DOM. */
export interface PoseWorkerPort {
  onmessage: ((event: MessageEvent<PoseWorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(value: PoseWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}
export interface PoseWorkerDependencies {
  createWorker(): PoseWorkerPort;
  /** A bitmap of the current frame, resized when `size` is given (GPU, no CPU readback). */
  capture(
    source: CameraHandle['source'],
    size?: { width: number; height: number },
  ): Promise<ImageBitmap>;
  now(): number;
  /** poseClock=1: runs `callback` at the next display frame (rAF, with a timer fallback). */
  frame?(callback: () => void): void;
}
const browserDependencies: PoseWorkerDependencies = {
  createWorker: () => new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' }),
  // No resize, crop, precision reduction or CPU pixel readback on the main thread.
  capture: (source, size) =>
    size
      ? createImageBitmap(source, {
          resizeWidth: size.width,
          resizeHeight: size.height,
          resizeQuality: 'high',
        })
      : createImageBitmap(source),
  now: () => performance.now(),
  frame: (callback) => {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      callback();
    };
    requestAnimationFrame(run);
    // A hidden or throttled page may starve rAF: never hold a pose longer than this.
    setTimeout(run, FRAME_FALLBACK_MS);
  },
};
/** Consecutive inference errors after which the worker counts as failed (~0.5 s at 30 Hz). */
const WORKER_FAILURE_ERRORS = 15;
/** poseClock=1: longest a ready pose waits for a display frame (rAF) before it is delivered. */
const FRAME_FALLBACK_MS = 50;
// Statistics window follows vision/poseTracker.ts; neither value changes model accuracy.
const STAT_SAMPLES = 30;
const INIT_TIMEOUT_MS = 45_000;
/** A captured camera frame: the inference bitmap, an optional full-resolution display one. */
type Shot = { bitmap: ImageBitmap; display?: ImageBitmap; width: number; height: number };
type Job = {
  id: number;
  generation: number;
  frameTime: number;
  stamp?: unknown;
  width: number;
  height: number;
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const abortError = () => new DOMException('Pose worker stopped', 'AbortError');

export async function createWorkerPoseTracker(
  camera: CameraHandle,
  options: PoseTrackerOptions & {
    mode?: PoseGraphMode;
    signal?: AbortSignal;
    /** posePipe=1: one latest-wins waiting frame so the worker never idles (protocol flags). */
    pipeline?: boolean;
    /**
     * ?camHd=1: the worker infers on a copy whose longest side is at most this (px); landmarks
     * stay in full-resolution source pixels and a poseSync display frame stays full resolution.
     */
    inputMaxSide?: number;
    /**
     * poseClock=1: a finished pose is delivered at the next display frame (rAF), after that
     * frame's camera callback has already sent the next frame to the worker, instead of at once
     * (its listeners' AR render would block that callback and leave the worker idle).
     */
    frameClock?: boolean;
    /**
     * poseSync=1: receives each inferred frame (yours: close it) with its camera frameTime,
     * synchronously before that frame's mask, raw and pose listeners.
     */
    onDisplayFrame?: (bitmap: ImageBitmap, frameTime: number) => void;
    /**
     * Called once when the worker can no longer deliver poses (worker crash, or
     * WORKER_FAILURE_ERRORS inference errors in a row, e.g. a lost GPU context); the tracker is
     * closed first. The caller can fall back to the main-thread tracker.
     */
    onFailure?: (reason: string) => void;
    /**
     * Called synchronously in the camera callback, just before the frame is captured for the
     * worker: a listener's own createImageBitmap(video, …) here gets that very frame (F4: start
     * the class segmentation on the pose's frame instead of after the AR draw).
     */
    onCapture?: (frameTime: number) => void;
  } = {},
  deps: PoseWorkerDependencies = browserDependencies,
): Promise<PoseTracker> {
  if (options.signal?.aborted) throw abortError();
  const port = deps.createWorker();
  const model = options.model ?? 'full';
  let delegate = options.delegate ?? 'GPU';
  let gpuFallbackReason: string | undefined;
  let renderer: string | undefined;
  let lastError: string | undefined;
  let closed = false;
  let generation = 0;
  let nextId = 0;
  // The job in the worker (non-pipelined: from the start of its capture). Never more than one.
  let pending: (Job & { display?: ImageBitmap }) | undefined;
  // Pipelined only: a capture in progress, and ONE captured frame waiting for the worker.
  let capturing = false;
  let waiting: (Shot & { frameTime: number; generation: number; stamp?: unknown }) | undefined;
  // Evaluation only: scripts/ar-eval-rest.mjs stamps each presented frame on the video element
  // (__arCameraFrame) and reads it inside source.onFrame listeners. On the main-thread path that
  // read is synchronous with the frame; here a pose arrives 1-2 frames later, so the stamp taken
  // at capture is put back on the element for the duration of this pose's listeners.
  const video = camera.video as (HTMLVideoElement & { __arCameraFrame?: unknown }) | null;
  const stampNow = () => video?.__arCameraFrame;
  const withStamp = (stamp: unknown, run: () => void) => {
    if (!video || stamp === undefined) return run();
    const current = video.__arCameraFrame;
    video.__arCameraFrame = stamp;
    try {
      run();
    } finally {
      video.__arCameraFrame = current;
    }
  };
  const dropWaiting = () => {
    waiting?.bitmap.close();
    waiting?.display?.close();
    waiting = undefined;
  };
  const sourceSize = (): [number, number] => {
    const src = camera.source as {
      videoWidth?: number;
      videoHeight?: number;
      width?: number;
      height?: number;
    };
    return typeof src.videoWidth === 'number'
      ? [src.videoWidth, src.videoHeight ?? 0]
      : [src.width ?? 0, src.height ?? 0];
  };
  /**
   * The frame for inference (downscaled under inputMaxSide) and, when the worker would only hand
   * back that downscaled copy, a separate full-resolution display bitmap. Both are requested in
   * the same task, so they hold the same camera frame.
   */
  const take = async (): Promise<Shot> => {
    const [width, height] = sourceSize();
    const input = options.inputMaxSide
      ? poseInputSize(width, height, options.inputMaxSide)
      : { width, height, scaled: false };
    if (!input.scaled) return { bitmap: await deps.capture(camera.source), width, height };
    const inferring = deps.capture(camera.source, input);
    const showing = sync ? deps.capture(camera.source) : Promise.resolve(undefined);
    const [bitmap, display] = await Promise.allSettled([inferring, showing]);
    if (bitmap.status === 'rejected') {
      if (display.status === 'fulfilled') display.value?.close();
      throw bitmap.reason;
    }
    if (display.status === 'rejected') {
      bitmap.value.close();
      throw display.reason;
    }
    return { bitmap: bitmap.value, display: display.value, width, height };
  };
  // poseClock: ONE finished pose waiting for the display frame (an older one is delivered first).
  let ready: { deliver: () => void; dispose: () => void } | undefined;
  let flushScheduled = false;
  const dropReady = () => {
    ready?.dispose();
    ready = undefined;
  };
  let offCamera: (() => void) | undefined;
  let lastImage: WorkerLandmark[] | undefined;
  let processed = 0;
  let skipped = 0;
  const latencies: number[] = [];
  const inferences: number[] = [];
  const completions: number[] = [];
  const pipeline = new PosePipeline(options);
  const sync = !!options.onDisplayFrame;
  const frames = new Set<(frame: PoseTrackerFrame) => void>();
  const raws = new Set<(frame: RecordedPoseFrame) => void>();
  const cancelCalibrations = new Set<() => void>();
  const push = (list: number[], value: number) => {
    list.push(value);
    if (list.length > STAT_SAMPLES) list.shift();
  };
  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
  const emit = <T>(listeners: Set<(value: T) => void>, value: T) => {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        console.error('[pose worker] listener threw', error);
      }
    }
  };
  const stop = () => {
    offCamera?.();
    offCamera = undefined;
    generation++;
    dropWaiting();
    dropReady();
    // Keep the in-flight slot occupied until its reply arrives; never queue inference jobs.
    for (const cancel of [...cancelCalibrations]) cancel();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    stop();
    port.onmessage = null;
    port.onerror = null;
    port.terminate();
    options.signal?.removeEventListener('abort', onAbort);
    frames.clear();
    raws.clear();
  };
  let rejectInit: (reason: unknown) => void = () => undefined;
  const onAbort = () => {
    rejectInit(abortError());
    close();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Pose worker initialization timed out.')),
        INIT_TIMEOUT_MS,
      );
      rejectInit = (reason) => {
        clearTimeout(timeout);
        reject(reason);
      };
      port.onerror = (event) => rejectInit(new Error(event.message));
      port.onmessage = ({ data }) => {
        if (data.type === 'error') rejectInit(new Error(data.message));
        if (data.type !== 'ready') return;
        clearTimeout(timeout);
        delegate = data.delegate;
        gpuFallbackReason = data.gpuFallbackReason;
        renderer = data.renderer;
        resolve();
      };
      try {
        port.postMessage({
          type: 'init',
          model,
          delegate,
          mode: options.mode ?? 'VIDEO',
          segmentation: !!options.onSegmentationMask,
          allowCpuFallback: true,
        });
      } catch (error) {
        rejectInit(error);
      }
    });
  } catch (error) {
    close();
    throw error;
  }
  if (closed) throw abortError();

  let errorsInRow = 0;
  const fail = (reason: string) => {
    if (closed) return;
    lastError = reason;
    // A failed worker cannot produce valid future frames; do not display fake success.
    close();
    try {
      options.onFailure?.(reason);
    } catch (error) {
      console.error('[pose worker] failure listener threw', error);
    }
  };
  port.onerror = (event) => fail(event.message || 'pose worker crashed');
  port.onmessage = ({ data }) => {
    const returned = data.type === 'result' ? data.bitmap : undefined;
    if (closed || data.type === 'ready' || !pending || data.id !== pending.id) {
      returned?.close();
      return;
    }
    const capture = pending;
    pending = undefined;
    // Pipelined: hand the waiting frame to the worker before this result's main-thread work.
    const next = waiting;
    waiting = undefined;
    if (next && next.generation === generation && offCamera)
      submit(next, next.frameTime, next.generation, next.stamp);
    else {
      next?.bitmap.close();
      next?.display?.close();
    }
    if (capture.generation !== generation || !offCamera) {
      returned?.close();
      capture.display?.close();
      return;
    }
    if (data.type === 'error') {
      capture.display?.close();
      lastError = data.message;
      if (++errorsInRow >= WORKER_FAILURE_ERRORS) fail(`pose worker: ${data.message}`);
      return;
    }
    errorsInRow = 0;
    const { frameTime, stamp } = capture;
    const { image, world, mask } = data;
    // Full-resolution display frame captured on this thread (inputMaxSide), else the worker's.
    const shown = capture.display ?? returned;
    if (capture.display) returned?.close();
    const deliver = () => {
      lastImage = image;
      if (shown) {
        const returned = shown;
        // The display frame first, so this pose's listeners draw over the very frame it came from.
        if (options.onDisplayFrame)
          try {
            options.onDisplayFrame(returned, frameTime);
          } catch (error) {
            returned.close();
            console.error('[pose worker] display frame listener threw', error);
          }
        else returned.close();
      }
      if (mask && image) {
        try {
          options.onSegmentationMask?.(mask, frameTime);
        } catch (error) {
          console.error('[pose worker] mask listener threw', error);
        }
      }
      const quad = (p: WorkerLandmark): [number, number, number, number] => [
        p.x,
        p.y,
        p.z,
        p.visibility ?? 0,
      ];
      // Landmarks are normalised: full-resolution source pixels even when inference was downscaled.
      const raw: RecordedPoseFrame = {
        t: frameTime,
        width: capture.width || data.width,
        height: capture.height || data.height,
      };
      if (image && world) {
        raw.image = image.map(quad);
        raw.world = world.map(quad);
      }
      // Main camera time, not the worker's independent performance.now() origin.
      const frame = pipeline.update(frameTime, image && world ? { image, world } : undefined);
      processed++;
      push(latencies, deps.now() - frameTime);
      push(inferences, data.inferenceMs);
      completions.push(deps.now());
      while (completions.length && deps.now() - completions[0] > 1000) completions.shift();
      withStamp(stamp, () => {
        emit(raws, raw);
        emit(frames, frame);
      });
    };
    if (!options.frameClock || !deps.frame) {
      deliver();
      return;
    }
    // Never drop a finished pose: an undelivered older one goes out now, in order.
    const older = ready;
    ready = undefined;
    older?.deliver();
    ready = { deliver, dispose: () => shown?.close() };
    if (flushScheduled) return;
    flushScheduled = true;
    deps.frame(() => {
      flushScheduled = false;
      const due = ready;
      ready = undefined;
      if (due && !closed && offCamera) due.deliver();
      else due?.dispose();
    });
  };

  /** Transfers the shot's bitmap to the worker as the in-flight job (closes it on failure). */
  const submit = (shot: Shot, frameTime: number, jobGeneration: number, stamp: unknown) => {
    const job = {
      id: ++nextId,
      generation: jobGeneration,
      frameTime,
      stamp,
      width: shot.width,
      height: shot.height,
      display: shot.display,
    };
    const { bitmap } = shot;
    try {
      port.postMessage(
        {
          type: 'frame',
          id: job.id,
          timestamp: frameTime,
          bitmap,
          // A downscaled inference copy is not worth showing: the display frame is kept here.
          returnBitmap: sync && !shot.display,
        },
        [bitmap],
      );
      pending = job;
    } catch (error) {
      lastError = errorText(error);
      bitmap.close();
      shot.display?.close();
    }
  };
  const notifyCapture = (frameTime: number) => {
    try {
      options.onCapture?.(frameTime);
    } catch (error) {
      console.error('[pose worker] capture listener threw', error);
    }
  };
  const onPipelinedFrame = (frameTime: number) => {
    if (capturing) {
      skipped++;
      return;
    }
    capturing = true;
    notifyCapture(frameTime);
    const jobGeneration = generation;
    const stamp = stampNow();
    void (async () => {
      let shot: Shot | undefined;
      try {
        shot = await take();
        if (closed || jobGeneration !== generation || !offCamera) return;
        const captured = shot;
        shot = undefined;
        if (!pending) submit(captured, frameTime, jobGeneration, stamp);
        else {
          // Latest wins: an older waiting frame is dropped, never queued behind this one.
          if (waiting) skipped++;
          dropWaiting();
          waiting = { ...captured, frameTime, generation: jobGeneration, stamp };
        }
      } catch (error) {
        lastError = errorText(error);
      } finally {
        shot?.bitmap.close();
        shot?.display?.close();
        capturing = false;
      }
    })();
  };

  const onCameraFrame = (frameTime: number) => {
    if (closed) return;
    if (options.pipeline) {
      onPipelinedFrame(frameTime);
      return;
    }
    if (pending) {
      skipped++;
      return;
    }
    const capture: Job & { display?: ImageBitmap } = {
      id: ++nextId,
      generation,
      frameTime,
      stamp: stampNow(),
      width: 0,
      height: 0,
    };
    pending = capture; // Includes asynchronous bitmap creation, not just inference.
    notifyCapture(frameTime);
    void (async () => {
      let shot: Shot | undefined;
      let submitted = false;
      try {
        shot = await take();
        if (closed || capture.generation !== generation || !offCamera) return;
        capture.width = shot.width;
        capture.height = shot.height;
        capture.display = shot.display;
        port.postMessage(
          {
            type: 'frame',
            id: capture.id,
            timestamp: frameTime,
            bitmap: shot.bitmap,
            returnBitmap: sync && !shot.display,
          },
          [shot.bitmap],
        );
        submitted = true;
      } catch (error) {
        lastError = errorText(error);
      } finally {
        // Close a late/cancelled capture or a bitmap whose transfer failed.
        if (!submitted) {
          shot?.bitmap.close();
          shot?.display?.close();
        }
        if (pending === capture && !submitted) pending = undefined;
      }
    })();
  };

  const tracker: PoseTracker & { readonly renderer?: string } = {
    /** Diagnostics: the GPU adapter of MediaPipe's WebGL context in the worker. */
    get renderer() {
      return renderer;
    },
    onFrame(listener) {
      frames.add(listener);
      return () => {
        frames.delete(listener);
      };
    },
    onRawFrame(listener) {
      raws.add(listener);
      return () => {
        raws.delete(listener);
      };
    },
    lastImageLandmarks: () => lastImage,
    start() {
      if (closed) throw new Error('Pose worker tracker is closed.');
      offCamera ??= camera.onFrame(onCameraFrame);
    },
    stop,
    close,
    calibrate(signal) {
      if (closed) return Promise.reject(abortError());
      if (cancelCalibrations.size) return Promise.reject(new Error('Calibration already running.'));
      return new Promise<NeutralCalibration>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        pipeline.startCalibration();
        const cleanup = () => {
          off();
          signal?.removeEventListener('abort', cancel);
          cancelCalibrations.delete(cancel);
        };
        const off = pipeline.onCalibrated((calibration) => {
          cleanup();
          resolve(calibration);
        });
        const cancel = () => {
          cleanup();
          pipeline.cancelCalibration();
          reject(abortError());
        };
        cancelCalibrations.add(cancel);
        signal?.addEventListener('abort', cancel, { once: true });
      });
    },
    setCalibration: (calibration) => pipeline.setCalibration(calibration),
    calibration: () => pipeline.calibration,
    stats: () => ({
      model,
      delegate,
      gpuFallbackReason,
      lastError,
      inferenceHz: completions.filter((t) => deps.now() - t <= 1000).length,
      latencyMs: mean(latencies),
      inferenceMs: mean(inferences),
      framesProcessed: processed,
      framesSkipped: skipped,
    }),
  };
  return tracker;
}
