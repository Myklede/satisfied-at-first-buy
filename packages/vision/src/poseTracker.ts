// Real-time webcam pose tracker: MediaPipe PoseLandmarker (VIDEO mode, GPU with CPU fallback) →
// PosePipeline (anatomical angles, per-DOF confidence, One Euro filtering, neutral calibration).
//
// Privacy: frames are read by MediaPipe in memory inside detectForVideo and never stored, written
// or sent. Only numbers leave this module. Assets load from the local dev server (no CDN).

import {
  FilesetResolver,
  PoseLandmarker,
  type Landmark,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';
import type { NeutralCalibration, PoseLandmark } from './anatomicalPose';
import { PosePipeline, type PosePipelineOptions, type PoseTrackerFrame } from './posePipeline';
import { landmarkToQuad, type RecordedPoseFrame } from './poseRecording';
import type { CameraHandle } from './types';
import { installNetworkGuard } from './networkGuard';

export type PoseTrackerModel = 'lite' | 'full' | 'heavy';

/**
 * Default model. Measured with scripts/smoke-pose.mjs (fake camera, RTX 3050 laptop, GPU
 * delegate); see the numbers in that script's output and docs. 'full' keeps camera rate while
 * being more accurate than 'lite'; 'heavy' is for offline/scan use.
 */
export const DEFAULT_POSE_TRACKER_MODEL: PoseTrackerModel = 'full';
/** MediaPipe detection/presence/tracking confidence (library default 0.5). */
export const POSE_TRACKER_MIN_CONFIDENCE = 0.5;
/** Rolling window for latency/inference statistics. */
const STAT_SAMPLES = 30;

/** Person segmentation of one frame: 0..1 per pixel, row 0 = image top (MediaPipe's mask). */
export interface PoseSegmentationMask {
  data: Float32Array;
  width: number;
  height: number;
}

export interface PoseTrackerOptions extends PosePipelineOptions {
  model?: PoseTrackerModel;
  /** Preferred delegate; GPU falls back to CPU if it fails to initialise. Default 'GPU'. */
  delegate?: 'GPU' | 'CPU';
  /** URL prefix where /models and /mediapipe/wasm are served. Default '/'. */
  assetBase?: string;
  /**
   * Opt-in person segmentation (AR occlusion, agent V2). When set, the landmarker also outputs
   * its segmentation mask and this is called with a copy (yours to keep) for every frame with a
   * person, synchronously BEFORE the raw-frame and frame listeners of that frame. The mask is a
   * GPU→CPU readback per frame; leave this unset when you do not need it (the default).
   * Privacy: the mask stays in memory like the frame itself.
   */
  onSegmentationMask?: (mask: PoseSegmentationMask, frameTime: number) => void;
}

export interface PoseTrackerStats {
  model: PoseTrackerModel;
  delegate: 'GPU' | 'CPU';
  /** Landmarker calls completed over the last second. */
  inferenceHz: number;
  /** Mean ms from the camera frame callback to emission (our processing latency). */
  latencyMs: number;
  /** Mean synchronous detectForVideo() duration (ms). */
  inferenceMs: number;
  framesProcessed: number;
  /** Camera frames skipped because the previous inference was still running. */
  framesSkipped: number;
  gpuFallbackReason?: string;
  lastError?: string;
}

export interface PoseTracker {
  /** Filtered pose per processed camera frame: {frameTime, pose, confidence, …}. */
  onFrame(listener: (frame: PoseTrackerFrame) => void): () => void;
  /**
   * Raw landmarker output as numbers (no pixels), for the lab's "Record pose". Called
   * synchronously; copy what you keep.
   */
  onRawFrame(listener: (frame: RecordedPoseFrame) => void): () => void;
  /** Normalised image landmarks of the last frame (for drawing an overlay), or undefined. */
  lastImageLandmarks(): readonly PoseLandmark[] | undefined;
  start(): void;
  stop(): void;
  /**
   * Runs the neutral calibration: stand upright, arms down, still for 1 s. Resolves with the
   * calibration (also applied); rejects on abort. Progress is reported in frame.calibrating.
   */
  calibrate(signal?: AbortSignal): Promise<NeutralCalibration>;
  setCalibration(calibration: NeutralCalibration | null): void;
  calibration(): NeutralCalibration | null;
  stats(): PoseTrackerStats;
  close(): void;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function createLandmarker(
  assetBase: string,
  model: PoseTrackerModel,
  delegate: 'GPU' | 'CPU',
  segmentation: boolean,
): Promise<PoseLandmarker> {
  installNetworkGuard();
  const fileset = await FilesetResolver.forVisionTasks(`${assetBase}mediapipe/wasm`);
  const landmarker = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${assetBase}models/pose_landmarker_${model}.task`, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: POSE_TRACKER_MIN_CONFIDENCE,
    minPosePresenceConfidence: POSE_TRACKER_MIN_CONFIDENCE,
    minTrackingConfidence: POSE_TRACKER_MIN_CONFIDENCE,
    outputSegmentationMasks: segmentation,
  });
  try {
    // Warm-up (also proves the delegate works). Timestamp 1 ms precedes any camera frame.
    const warm = document.createElement('canvas');
    warm.width = 64;
    warm.height = 64;
    warm.getContext('2d')?.fillRect(0, 0, 64, 64);
    landmarker.detectForVideo(warm, 1);
  } catch (error) {
    landmarker.close();
    throw error;
  }
  return landmarker;
}

function sourceSize(source: HTMLVideoElement | HTMLCanvasElement): [number, number] {
  return source instanceof HTMLVideoElement
    ? [source.videoWidth, source.videoHeight]
    : [source.width, source.height];
}

const toPoseLandmark = (l: Landmark | NormalizedLandmark): PoseLandmark => ({
  x: l.x,
  y: l.y,
  z: l.z,
  visibility: l.visibility,
});

export async function createPoseTracker(
  camera: CameraHandle,
  options: PoseTrackerOptions = {},
): Promise<PoseTracker> {
  const model = options.model ?? DEFAULT_POSE_TRACKER_MODEL;
  const assetBase = options.assetBase ?? '/';
  let delegate: 'GPU' | 'CPU' = options.delegate ?? 'GPU';
  let gpuFallbackReason: string | undefined;
  let landmarker: PoseLandmarker;
  const onMask = options.onSegmentationMask;
  const segmentation = !!onMask;
  if (delegate === 'GPU') {
    try {
      landmarker = await createLandmarker(assetBase, model, 'GPU', segmentation);
    } catch (error) {
      gpuFallbackReason = errorMessage(error);
      delegate = 'CPU';
      landmarker = await createLandmarker(assetBase, model, 'CPU', segmentation);
    }
  } else landmarker = await createLandmarker(assetBase, model, 'CPU', segmentation);

  const pipeline = new PosePipeline(options);
  const frameListeners = new Set<(f: PoseTrackerFrame) => void>();
  const rawListeners = new Set<(f: RecordedPoseFrame) => void>();
  const latencies: number[] = [];
  const inferenceTimes: number[] = [];
  const completions: number[] = [];
  let framesProcessed = 0;
  let framesSkipped = 0;
  let lastError: string | undefined;
  let lastTimestamp = 1;
  let lastImage: PoseLandmark[] | undefined;
  let busy = false;
  let closed = false;
  let unsubscribe: (() => void) | undefined;

  const push = (list: number[], v: number) => {
    list.push(v);
    if (list.length > STAT_SAMPLES) list.shift();
  };
  const mean = (list: number[]) =>
    list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
  const safeCall = <T>(set: Set<(x: T) => void>, x: T, what: string) => {
    for (const l of set) {
      try {
        l(x);
      } catch (error) {
        console.error(`[vision/pose] ${what} listener threw`, error);
      }
    }
  };

  const onCameraFrame = (frameTime: number) => {
    if (closed) return;
    if (busy) {
      framesSkipped += 1;
      return;
    }
    const [width, height] = sourceSize(camera.source);
    if (!width || !height) return;
    busy = true;
    try {
      // VIDEO mode requires strictly increasing timestamps (ms).
      const timestamp = Math.max(frameTime, lastTimestamp + 1);
      lastTimestamp = timestamp;
      const t0 = performance.now();
      const result = landmarker.detectForVideo(camera.source, timestamp);
      const t1 = performance.now();
      const world = result.worldLandmarks[0]?.map(toPoseLandmark);
      const image = result.landmarks[0]?.map(toPoseLandmark);
      // Without a callback MediaPipe hands out copies of the masks: copy the data and close them.
      const masks = result.segmentationMasks ?? [];
      try {
        const mask = masks[0];
        if (onMask && mask && image) {
          const copy = {
            data: new Float32Array(mask.getAsFloat32Array()),
            width: mask.width,
            height: mask.height,
          };
          try {
            onMask(copy, frameTime);
          } catch (error) {
            console.error('[vision/pose] segmentation listener threw', error);
          }
        }
      } finally {
        for (const m of masks) m.close();
      }
      lastImage = image;
      const raw: RecordedPoseFrame = { t: frameTime, width, height };
      if (world && image) {
        raw.world = world.map(landmarkToQuad);
        raw.image = image.map(landmarkToQuad);
      }
      const frame = pipeline.update(frameTime, world && image ? { world, image } : undefined);
      framesProcessed += 1;
      const emitTime = performance.now();
      // Latency = emission time − camera frame callback time. Camera exposure, transfer and
      // decode before the callback are NOT included.
      push(latencies, emitTime - frameTime);
      push(inferenceTimes, t1 - t0);
      completions.push(emitTime);
      while (completions.length && emitTime - completions[0] > 1000) completions.shift();
      safeCall(rawListeners, raw, 'raw frame');
      safeCall(frameListeners, frame, 'frame');
    } catch (error) {
      lastError = errorMessage(error);
      console.error('[vision/pose] inference failed', error);
    } finally {
      busy = false;
    }
  };

  const stop = () => {
    unsubscribe?.();
    unsubscribe = undefined;
  };

  return {
    onFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onRawFrame(listener) {
      rawListeners.add(listener);
      return () => rawListeners.delete(listener);
    },
    lastImageLandmarks: () => lastImage,
    start() {
      if (closed) throw new Error('PoseTracker is closed.');
      unsubscribe ??= camera.onFrame(onCameraFrame);
    },
    stop,
    calibrate(signal) {
      return new Promise<NeutralCalibration>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Calibration aborted', 'AbortError'));
        pipeline.startCalibration();
        const off = pipeline.onCalibrated((c) => {
          off();
          signal?.removeEventListener('abort', onAbort);
          resolve(c);
        });
        const onAbort = () => {
          off();
          pipeline.cancelCalibration();
          reject(new DOMException('Calibration aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    setCalibration: (c) => pipeline.setCalibration(c),
    calibration: () => pipeline.calibration,
    stats: () => ({
      model,
      delegate,
      inferenceHz: completions.filter((t) => performance.now() - t <= 1000).length,
      latencyMs: mean(latencies),
      inferenceMs: mean(inferenceTimes),
      framesProcessed,
      framesSkipped,
      gpuFallbackReason,
      lastError,
    }),
    close() {
      if (closed) return;
      closed = true;
      stop();
      pipeline.cancelCalibration();
      frameListeners.clear();
      rawListeners.clear();
      landmarker.close();
    },
  };
}
