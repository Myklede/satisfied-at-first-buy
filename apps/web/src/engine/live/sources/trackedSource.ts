// LiveSource over a CameraHandle-like frame source: MediaPipe pose tracker (packages/vision) →
// PosePipeline (anatomical angles, One Euro filter, neutral calibration) → LiveFrame.
// Used by the camera and the local video-file sources. Frames are read in memory by MediaPipe
// and never stored or sent; only numbers leave this module.
import {
  CameraError,
  createPoseTracker,
  type CameraHandle,
  type CalibrationProgress,
  type NeutralCalibration,
  type PoseTracker,
  type PoseTrackerFrame,
  type PoseTrackerModel,
  type PoseSegmentationMask,
  type PoseTrackerStats,
  type RecordedPoseFrame,
} from '@satisfy/vision';
import type { AnatomicalPose } from '../../motion/rig.ts';
import { poseWorkerFlags } from './poseWorkerProtocol';
import { CAMERA_BUSY_HELP } from './cameraText';
import { installFastGeometry } from '../fastGeometry';
import { PoseStabilizer } from './poseStabilizer';
import type {
  ImageLandmark,
  LiveFrame,
  LiveSource,
  LiveSourceKind,
  WorldLandmark,
} from '../contract.ts';

/** Where the web app serves the MediaPipe wasm and models (apps/web/public/vision). */
export const VISION_ASSET_BASE = '/vision/';
/** getUserMedia attempts on NotReadableError and the wait between them (device release). */
const CAMERA_BUSY_ATTEMPTS = 3;
const CAMERA_BUSY_RETRY_MS = 400;
/** ?camExposure=auto: below this delivered fps for CAMERA_SLOW_SECONDS, fix the exposure. */
const CAMERA_SLOW_FPS = 24;
const CAMERA_SLOW_SECONDS = 3;
/** Frames the camera produced so far (MediaStreamTrack.stats), or null where not exposed. */
const frameCount = (track: MediaStreamTrack) => {
  const stats = (track as MediaStreamTrack & { stats?: { totalFrames?: number } }).stats;
  return typeof stats?.totalFrames === 'number' ? stats.totalFrames : null;
};
/** ?camExposure=1: longest manual exposure (100 us units) that still fits a 30 fps frame. */
const CAMERA_MAX_EXPOSURE_100US = 333;

/** Extra controls of the tracked sources (camera, video file) beyond the LiveSource contract. */
export interface CalibratableSource extends LiveSource {
  /** Runs the neutral stand: upright, arms relaxed, still for 1 s. Rejects on abort. */
  calibrate(signal?: AbortSignal): Promise<NeutralCalibration>;
  readonly calibrated: boolean;
  /** Progress of a running calibration (null when none runs). */
  readonly calibrationProgress: CalibrationProgress | null;
  stats(): PoseTrackerStats | null;
  useCameraVertical(): void;
  readonly usingCameraVertical: boolean;
}

export const isCalibratable = (source: LiveSource): source is CalibratableSource =>
  typeof (source as Partial<CalibratableSource>).calibrate === 'function';

export type TrackedSourceOptions = {
  model?: PoseTrackerModel;
  delegate?: 'GPU' | 'CPU';
  /**
   * Person segmentation mask on every LiveFrame (AR occlusion). Costs a GPU→CPU readback per
   * frame; the engine turns it on only when an AR renderer is attached.
   */
  segmentation?: boolean;
  /** Video files: hold the current frame while calibrating (pause), resume after. */
  holdForCalibration?: { pause(): void; resume(): void };
  /**
   * ?camHd=1 (cameraSource): the pose worker infers on a copy at most this many px on its longest
   * side; landmarks and the shown frame stay at the camera's full resolution.
   */
  poseInputMaxSide?: number;
};

const quadToImage = (q: number[], width: number, height: number): ImageLandmark => ({
  x: q[0] * width,
  y: q[1] * height,
  visibility: q[3],
});
const quadToWorld = (q: number[]): WorldLandmark => ({
  x: q[0],
  y: q[1],
  z: q[2],
  visibility: q[3],
});

export class TrackedSource implements CalibratableSource {
  private tracker?: PoseTracker;
  private listeners = new Set<(frame: LiveFrame) => void>();
  private lastRaw?: RecordedPoseFrame;
  private lastMask?: { mask: PoseSegmentationMask; frameTime: number };
  private progress: CalibrationProgress | null = null;
  private offs: (() => void)[] = [];
  private t0: number | null = null;
  private cameraVertical = false;
  private workerInitAbort?: AbortController;
  private startGeneration = 0;
  /**
   * ?f1stab=1 (agent F1, D9): implausible one-frame landmark jumps (a MediaPipe hypothesis switch)
   * are held before any consumer sees them (poseStabilizer.ts). Accepted frames pass unchanged.
   */
  private readonly stabilizer =
    typeof location !== 'undefined' && new URLSearchParams(location.search).get('f1stab') === '1'
      ? new PoseStabilizer()
      : null;
  private starting?: Promise<void>;

  constructor(
    readonly kind: LiveSourceKind,
    private openHandle: () => Promise<CameraHandle>,
    private options: TrackedSourceOptions = {},
    private onClose?: () => void,
  ) {
    // ?fastGeom=1 (F2, D9): bit-identical typed-array bounding spheres and vertex normals for the
    // per-pose body/jacket/hood updates (fastGeometry.ts). Installed with the live source, the
    // only place these run every frame. Default off.
    if (
      typeof location !== 'undefined' &&
      new URLSearchParams(location.search).get('fastGeom') === '1'
    )
      installFastGeometry();
  }

  private handle?: CameraHandle;
  /** poseSync=1: the canvas holding the frame of the latest pose (shown by the AR instead). */
  private display?: HTMLCanvasElement;
  /** poseSync after a worker failure: repaint the display canvas from the live video. */
  private displayFromVideo?: (video: HTMLVideoElement | HTMLCanvasElement) => void;
  /** Why the opt-in pose worker was replaced by the main-thread tracker (null: it was not). */
  workerFallback: string | null = null;

  get video(): HTMLVideoElement | null {
    return this.handle?.video ?? null;
  }

  /**
   * poseSync=1 (see poseWorkerProtocol.ts): a canvas the AR draws instead of the video
   * (ArCompositor frameShown: hung on the video element as `poseSyncDisplay`), repainted with the
   * exact frame each pose was inferred on, so the jacket never lands on a newer frame than its
   * pose. `video` stays the real element (playback, evaluation). It answers the few video fields
   * a VideoTexture reads (readyState, videoWidth/Height).
   */
  private displayCanvas(width: number, height: number) {
    const canvas = document.createElement('canvas');
    canvas.width = width || 1;
    canvas.height = height || 1;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('poseSync: no 2D canvas context');
    Object.defineProperties(canvas, {
      readyState: { get: () => (painted ? 4 : 0) },
      videoWidth: { get: () => canvas.width },
      videoHeight: { get: () => canvas.height },
    });
    let painted = false;
    const paint = (bitmap: ImageBitmap) => {
      try {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        ctx.drawImage(bitmap, 0, 0);
        painted = true;
      } finally {
        bitmap.close();
      }
    };
    // Fallback (the worker failed): keep the AR's canvas fed with the live video instead.
    const paintVideo = (video: HTMLVideoElement | HTMLCanvasElement) => {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      painted = true;
    };
    return { canvas, paint, paintVideo };
  }

  get calibrated() {
    return this.tracker?.calibration() != null;
  }

  get calibrationProgress() {
    return this.progress;
  }

  start(): Promise<void> {
    if (this.tracker) return Promise.resolve();
    if (this.starting) return this.starting;
    const experiment = poseWorkerFlags(typeof location === 'undefined' ? '' : location.search);
    const generation = ++this.startGeneration;
    const abort = new AbortController();
    this.workerInitAbort = abort;
    const job = this.startTracker(generation, abort, experiment);
    const pending = job.finally(() => {
      if (this.starting === pending) this.starting = undefined;
    });
    this.starting = pending;
    return pending;
  }

  private async startTracker(
    generation: number,
    abort: AbortController,
    experiment: ReturnType<typeof poseWorkerFlags>,
  ) {
    let handle: CameraHandle | undefined;
    let tracker: PoseTracker | undefined;
    const checkActive = () => {
      if (abort.signal.aborted || generation !== this.startGeneration)
        throw new DOMException('Pose source stopped', 'AbortError');
    };
    try {
      handle = await this.openCamera(abort.signal);
      // A stale start (stopped while getUserMedia was pending) closes its own handle in catch and
      // must not overwrite a newer start's pending handle (CX-DAY 17:08), so check first.
      checkActive();
      // Owned from now on: stop() during the (seconds-long) tracker init closes it at once, so the
      // webcam is never held by a cancelled start (one opener per device on Windows).
      this.pendingHandle = handle;
      await this.tuneCamera(handle);
      checkActive();
      const trackerOptions = {
        model: this.options.model ?? 'full',
        delegate: experiment.delegate ?? this.options.delegate ?? 'GPU',
        assetBase: VISION_ASSET_BASE,
        ...(this.options.segmentation
          ? {
              onSegmentationMask: (mask: PoseSegmentationMask, frameTime: number) => {
                this.lastMask = { mask, frameTime };
              },
            }
          : {}),
      } as const;
      let shown =
        experiment.enabled && experiment.sync
          ? this.displayCanvas(handle.info().width, handle.info().height)
          : undefined;
      const opened = handle;
      if (experiment.enabled) {
        try {
          const paint = shown?.paint;
          tracker = await (
            await import('./workerPoseTracker')
          ).createWorkerPoseTracker(handle, {
            ...trackerOptions,
            mode: experiment.mode,
            pipeline: experiment.pipeline,
            inputMaxSide: this.options.poseInputMaxSide,
            frameClock: experiment.clock,
            ...(paint ? { onDisplayFrame: (bitmap: ImageBitmap) => paint(bitmap) } : {}),
            onCapture: (frameTime) => this.announceCapture(opened, frameTime),
            onFailure: (reason) =>
              void this.fallBackToMain(reason, generation, opened, trackerOptions),
            signal: abort.signal,
          });
        } catch (error) {
          checkActive();
          // The opt-in worker could not start: the main-thread tracker keeps the kiosk running.
          this.workerFallback = error instanceof Error ? error.message : String(error);
          console.warn('[live] pose worker unavailable, main-thread tracker used:', error);
          shown = undefined;
          tracker = await createPoseTracker(handle, trackerOptions);
        }
      } else tracker = await createPoseTracker(handle, trackerOptions);
      checkActive();
      this.handle = handle;
      this.tracker = tracker;
      this.display = shown?.canvas;
      this.displayPainter = shown?.paintVideo;
      if (shown)
        Object.defineProperty(handle.video, 'poseSyncDisplay', {
          value: shown.canvas,
          configurable: true,
        });
      this.subscribe(this.tracker);
    } catch (error) {
      tracker?.close();
      handle?.close();
      throw error;
    } finally {
      if (this.pendingHandle === handle) this.pendingHandle = undefined;
    }
  }

  /**
   * Camera diagnostics (read-only numbers): what the device exposes and what was applied.
   * ?camExposure=1 (F2, lead 18:25; default off): the Integrated Camera's auto-exposure goes to
   * 1/16 s in dim light and the camera then delivers 15 fps (probe 18:2x); a manual exposure at
   * the longest step <= 33.3 ms (1/32 s on that camera) keeps 30 fps, at most ~half as bright.
   */
  cameraDiagnostics: {
    capabilities: Record<string, unknown> | null;
    settings: Record<string, unknown> | null;
    exposure: string;
  } | null = null;

  private async tuneCamera(handle: CameraHandle) {
    const stream = handle.video?.srcObject;
    const track =
      typeof MediaStream !== 'undefined' && stream instanceof MediaStream
        ? stream.getVideoTracks()[0]
        : undefined;
    if (!track) return;
    const caps = (track.getCapabilities?.() ?? null) as
      | (MediaTrackCapabilities & {
          exposureMode?: string[];
          exposureTime?: { min: number; max: number };
        })
      | null;
    let exposure = 'auto (default)';
    const mode =
      typeof location === 'undefined'
        ? null
        : new URLSearchParams(location.search).get('camExposure');
    const range = caps?.exposureTime;
    const canManual = !!(caps?.exposureMode?.includes('manual') && range);
    // exposureTime is in 100 us units; <= 333.3 keeps a 30 fps frame budget.
    const fixExposure = async (why: string) => {
      if (!canManual || !range) return 'manual exposure not exposed by this camera';
      const time = Math.max(range.min, Math.min(range.max, CAMERA_MAX_EXPOSURE_100US));
      try {
        await track.applyConstraints({
          advanced: [{ exposureMode: 'manual', exposureTime: time } as MediaTrackConstraintSet],
        });
        return `manual ${time} (100 us units)${why}`;
      } catch (error) {
        return `manual refused: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    if (mode === '1') exposure = await fixExposure('');
    else if (mode === 'auto' && canManual) {
      // ?camExposure=auto: keep the camera's own exposure while it delivers >= 24 fps; after
      // CAMERA_SLOW_SECONDS below that (dim light), fix the exposure at <= 33.3 ms once.
      exposure = 'auto, watching delivered fps';
      let last = frameCount(track) ?? handle.info().fps;
      let slow = 0;
      const timer = setInterval(() => {
        if (track.readyState === 'ended') return clearInterval(timer);
        const now = frameCount(track);
        const fps = now === null ? handle.info().fps : now - last;
        if (now !== null) last = now;
        slow = fps < CAMERA_SLOW_FPS ? slow + 1 : 0;
        if (slow < CAMERA_SLOW_SECONDS) return;
        clearInterval(timer);
        void fixExposure(` after ${CAMERA_SLOW_SECONDS} s at ${fps} fps`).then((applied) => {
          if (this.cameraDiagnostics) this.cameraDiagnostics.exposure = applied;
          console.info(`[live] camera exposure: ${applied}`);
        });
      }, 1000);
      this.offs.push(() => clearInterval(timer));
    }
    this.cameraDiagnostics = {
      capabilities: caps as Record<string, unknown> | null,
      settings: track.getSettings() as Record<string, unknown>,
      exposure,
    };
  }

  /** A start's camera handle between getUserMedia and the tracker being ready (see stop()). */
  private pendingHandle?: CameraHandle;

  /**
   * getUserMedia, retried briefly on NotReadableError: the previous screen's camera (body scan)
   * may still be releasing the device for a moment after its tracks stopped. A device that stays
   * busy gets the actionable message (another tab or app holds it; Retry camera).
   */
  private async openCamera(signal: AbortSignal): Promise<CameraHandle> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.openHandle();
      } catch (error) {
        const busy = error instanceof CameraError && error.code === 'device_busy';
        if (!busy) throw error;
        if (attempt >= CAMERA_BUSY_ATTEMPTS) throw new CameraError('device_busy', CAMERA_BUSY_HELP);
        await new Promise((r) => setTimeout(r, CAMERA_BUSY_RETRY_MS));
        if (signal.aborted) throw new DOMException('Pose source stopped', 'AbortError');
      }
    }
  }

  /**
   * Worker path: tells listeners on the source <video> that this camera frame is being captured
   * for a pose ('posecapture', detail { frameTime, t }; t = the LiveFrame.t its pose will carry).
   * Dispatched synchronously in the camera callback, so createImageBitmap(video, …) in a listener
   * reads the same frame (F4's class segmentation on the pose's own frame).
   */
  private announceCapture(handle: CameraHandle, frameTime: number) {
    this.t0 ??= frameTime;
    handle.video?.dispatchEvent?.(
      new CustomEvent('posecapture', { detail: { frameTime, t: frameTime - this.t0 } }),
    );
  }

  private subscribe(tracker: PoseTracker) {
    this.offs.push(
      tracker.onRawFrame((raw) => {
        this.lastRaw = raw;
      }),
      tracker.onFrame((frame) => this.emit(frame)),
    );
    tracker.start();
  }

  /**
   * The worker failed at runtime (crash, lost GPU context): the main-thread tracker takes over
   * on the same camera, keeping the calibration; a poseSync canvas is fed from the live video.
   */
  private async fallBackToMain(
    reason: string,
    generation: number,
    handle: CameraHandle,
    options: Parameters<typeof createPoseTracker>[1],
  ) {
    if (generation !== this.startGeneration || this.handle !== handle) return;
    console.warn('[live] pose worker failed, main-thread tracker takes over:', reason);
    this.workerFallback = reason;
    const calibration = this.tracker?.calibration() ?? null;
    for (const off of this.offs.splice(0)) off();
    this.tracker?.close();
    this.tracker = undefined;
    try {
      const tracker = await createPoseTracker(handle, options);
      if (generation !== this.startGeneration || this.handle !== handle) {
        tracker.close();
        return;
      }
      if (calibration) tracker.setCalibration(calibration);
      this.tracker = tracker;
      if (this.display) this.displayFromVideo = this.displayPainter;
      this.subscribe(tracker);
    } catch (error) {
      console.error('[live] main-thread pose fallback failed', error);
    }
  }
  private displayPainter?: (video: HTMLVideoElement | HTMLCanvasElement) => void;

  private emit(f: PoseTrackerFrame) {
    if (this.displayFromVideo && this.handle) this.displayFromVideo(this.handle.source);
    this.progress = f.calibrating ?? null;
    const raw = this.lastRaw;
    const width = raw?.width ?? this.handle?.info().width ?? 0;
    const height = raw?.height ?? this.handle?.info().height ?? 0;
    this.t0 ??= f.frameTime;
    const tracked = f.personDetected && raw?.image && raw.world;
    const pose: AnatomicalPose | null =
      tracked && (f.calibrated || this.cameraVertical)
        ? { ...(f.pose as unknown as AnatomicalPose) }
        : null;
    let landmarks2d = tracked ? raw.image!.map((q) => quadToImage(q, width, height)) : null;
    let world = tracked ? raw.world!.map(quadToWorld) : null;
    if (this.stabilizer) {
      const gated = this.stabilizer.update(f.frameTime, landmarks2d, world);
      landmarks2d = gated.landmarks2d;
      world = gated.world;
    }
    const frame: LiveFrame = {
      t: f.frameTime - this.t0,
      width,
      height,
      landmarks2d,
      world,
      pose,
      confidence: tracked ? { ...(f.confidence as unknown as Record<string, number>) } : {},
      // The mask arrives synchronously before this frame's listeners, with the same frameTime.
      mask: tracked && this.lastMask?.frameTime === f.frameTime ? { ...this.lastMask.mask } : null,
    };
    for (const listener of this.listeners) {
      try {
        listener(frame);
      } catch (error) {
        console.error('[live] frame listener threw', error);
      }
    }
  }

  async calibrate(signal?: AbortSignal) {
    if (!this.tracker) throw new Error('Source not started');
    this.cameraVertical = false;
    const hold = this.options.holdForCalibration;
    hold?.pause();
    try {
      return await this.tracker.calibrate(signal);
    } finally {
      hold?.resume();
    }
  }

  /**
   * Fallback when the neutral stand cannot complete (e.g. a shaky phone video): estimate the pose
   * against the camera's up axis instead of a calibrated vertical. The engine says so on screen.
   */
  useCameraVertical() {
    this.tracker?.setCalibration(null);
    this.cameraVertical = true;
  }

  get usingCameraVertical() {
    return this.cameraVertical;
  }

  stats() {
    return this.tracker?.stats() ?? null;
  }

  /** What the device actually delivers (negotiated size, measured fps), for diagnostics. */
  cameraInfo() {
    return this.handle?.info() ?? null;
  }

  onFrame(callback: (frame: LiveFrame) => void) {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /** Turns the segmentation mask on or off; applies at the next start(). */
  setSegmentation(on: boolean) {
    this.options = { ...this.options, segmentation: on };
  }

  get segmentation() {
    return this.options.segmentation ?? false;
  }

  stop() {
    this.startGeneration++;
    this.starting = undefined;
    this.workerInitAbort?.abort();
    this.workerInitAbort = undefined;
    this.lastMask = undefined;
    if (this.display && this.handle)
      delete (this.handle.video as { poseSyncDisplay?: unknown }).poseSyncDisplay;
    this.display = undefined;
    this.displayPainter = undefined;
    this.displayFromVideo = undefined;
    this.stabilizer?.reset();
    for (const off of this.offs.splice(0)) off();
    this.tracker?.close();
    this.tracker = undefined;
    this.handle?.close();
    this.handle = undefined;
    // A start still initialising: release its camera now (its own cleanup closes it again,
    // idempotently, when the pending init settles).
    this.pendingHandle?.close();
    this.pendingHandle = undefined;
    this.onClose?.();
  }
}
