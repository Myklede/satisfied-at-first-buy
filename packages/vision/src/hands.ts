// Hand pinch tracker: MediaPipe HandLandmarker (on-device, main thread) + pure pinch logic.
// Frames are read from the camera source in memory only; nothing is stored, drawn to a persisted
// surface or sent anywhere. Network use: loading the local model and WASM from this origin.

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { HandLandmarkerResult } from '@mediapipe/tasks-vision';
import { frameToObservations } from './handRecording';
import type { RecordedHandFrame, Triple } from './handRecording';
import { PinchTracker } from './pinch';
import type { PinchTuning, TrackedHandFrame } from './pinch';
import type {
  CameraHandle,
  HandTracker,
  HandTrackerOptions,
  HandTrackerStats,
  PinchEvent,
} from './types';
import { installNetworkGuard } from './networkGuard';

/** Served from packages/vision/public (see scripts/fetch-models.mjs). */
export const DEFAULT_HAND_MODEL_PATH = '/models/hand_landmarker.task';
export const DEFAULT_WASM_BASE_PATH = '/mediapipe/wasm';

/**
 * Palm detector threshold for a NEW hand. Kept at MediaPipe's default 0.5 so lowering the two
 * values below does not let new false hands in.
 */
export const MIN_HAND_DETECTION_CONFIDENCE = 0.5;
/**
 * Presence / tracking thresholds for an ALREADY tracked hand (MediaPipe default 0.5). Lowered to
 * 0.3 because the 2026-11-12 real-hand test lost the hand during fast, blurred drags; below the
 * tracking threshold MediaPipe drops the track and must re-detect from scratch. The cost is a
 * hand that lingers slightly longer after leaving. False hands are counted by the smoke bench
 * (fake camera) and shown in the lab. [heuristic]
 */
export const MIN_HAND_PRESENCE_CONFIDENCE = 0.3;
export const MIN_TRACKING_CONFIDENCE = 0.3;

/**
 * MediaPipe's legacy Hands docs say handedness "is determined assuming the input image is
 * mirrored" (selfie view); the tasks-vision typings say labels are the subject's hands and that a
 * mirrored input inverts them. We feed the UNMIRRORED camera frame. Community reports for
 * tasks-vision describe swapped labels on raw webcam frames, so labels are swapped by default.
 * Verified 2026-11-12 on this laptop's Integrated Camera (tasks-vision 1.2.2, unmirrored frames):
 * with the swap enabled the user's hand was labelled the wrong side, so labels are used as-is.
 * The pinch logic does not depend on which hand is which; only the event's `hand` field does.
 */
export const SWAP_MEDIAPIPE_HANDEDNESS = false;

/** Window for the inference-rate stat. */
const RATE_WINDOW_MS = 1000;
/** Number of recent frames averaged for latency / inference time stats. */
const LATENCY_SAMPLES = 60;
/** Warm-up image edge (px): forces shader compilation / allocation before the first real frame. */
const WARMUP_SIZE = 256;

export interface CreateHandTrackerOptions extends HandTrackerOptions {
  /** Preferred delegate. 'GPU' (default) falls back to 'CPU' if it fails to initialise. */
  delegate?: 'GPU' | 'CPU';
  modelAssetPath?: string;
  wasmBasePath?: string;
  /** Overrides for the pinch heuristics (see pinch.ts constants). */
  tuning?: Partial<PinchTuning>;
}

export interface HandTrackerDetailedStats extends HandTrackerStats {
  /** Mean synchronous detectForVideo() duration (ms) over recent frames. */
  inferenceMs: number;
  framesProcessed: number;
  /** Camera frames skipped because the previous inference was still running. */
  framesSkipped: number;
  /** Why GPU was not used, if the GPU delegate failed and CPU was used instead. */
  gpuFallbackReason?: string;
  lastError?: string;
}

/** Backward-compatible superset of HandTracker with lab/tuning extras. */
export interface TunableHandTracker extends HandTracker {
  onFrame(listener: (frame: TrackedHandFrame) => void): () => void;
  /**
   * Raw per-frame landmarker output as numbers (no pixels), for the lab's "Record landmarks".
   * Called synchronously; copy what you keep.
   */
  onRawFrame(listener: (frame: RecordedHandFrame) => void): () => void;
  stats(): HandTrackerDetailedStats;
  tuning(): PinchTuning;
  setTuning(partial: Partial<PinchTuning>): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceSize(source: HTMLVideoElement | HTMLCanvasElement): [number, number] {
  return source instanceof HTMLVideoElement
    ? [source.videoWidth, source.videoHeight]
    : [source.width, source.height];
}

async function createLandmarker(
  fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
  delegate: 'GPU' | 'CPU',
  modelAssetPath: string,
  numHands: number,
): Promise<HandLandmarker> {
  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath, delegate },
    runningMode: 'VIDEO',
    numHands,
    minHandDetectionConfidence: MIN_HAND_DETECTION_CONFIDENCE,
    minHandPresenceConfidence: MIN_HAND_PRESENCE_CONFIDENCE,
    minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
  });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = WARMUP_SIZE;
    canvas.height = WARMUP_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable for warm-up.');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, WARMUP_SIZE, WARMUP_SIZE);
    // Timestamp 0: real frames use performance.now() and are always later.
    landmarker.detectForVideo(canvas, 0);
  } catch (error) {
    landmarker.close();
    throw error;
  }
  return landmarker;
}

const triples = (points: ReadonlyArray<{ x: number; y: number; z: number }>): Triple[] =>
  points.map((p) => [p.x, p.y, p.z]);

/**
 * Landmarker result -> the numbers-only frame format shared with recordings. The handedness
 * score is used as the per-hand confidence: the result exposes no per-hand presence score.
 */
function toRecordedFrame(
  result: HandLandmarkerResult,
  t: number,
  width: number,
  height: number,
): RecordedHandFrame {
  const hands: RecordedHandFrame['hands'] = [];
  for (let i = 0; i < result.landmarks.length; i++) {
    const category = result.handedness[i]?.[0];
    if (!category) continue;
    const world = result.worldLandmarks[i];
    hands.push({
      label: category.categoryName,
      score: category.score,
      landmarks: triples(result.landmarks[i]),
      world: world ? triples(world) : undefined,
    });
  }
  return { t, width, height, hands };
}

/**
 * Creates a pinch tracker on an open camera. Inference runs on the main thread, once per new
 * camera frame. The camera stays owned by the caller (close() does not close it).
 */
export async function createHandTracker(
  camera: CameraHandle,
  options: CreateHandTrackerOptions = {},
): Promise<TunableHandTracker> {
  const numHands = options.maxHands ?? 2;
  if (numHands !== 1 && numHands !== 2) throw new RangeError('maxHands must be 1 or 2.');
  const modelAssetPath = options.modelAssetPath ?? DEFAULT_HAND_MODEL_PATH;
  installNetworkGuard();
  const fileset = await FilesetResolver.forVisionTasks(
    options.wasmBasePath ?? DEFAULT_WASM_BASE_PATH,
  );

  let delegate: 'GPU' | 'CPU' = options.delegate ?? 'GPU';
  let gpuFallbackReason: string | undefined;
  let landmarker: HandLandmarker;
  if (delegate === 'GPU') {
    try {
      landmarker = await createLandmarker(fileset, 'GPU', modelAssetPath, numHands);
    } catch (error) {
      gpuFallbackReason = errorMessage(error);
      delegate = 'CPU';
      landmarker = await createLandmarker(fileset, 'CPU', modelAssetPath, numHands);
    }
  } else {
    landmarker = await createLandmarker(fileset, 'CPU', modelAssetPath, numHands);
  }

  const tracker = new PinchTracker({
    ...options.tuning,
    mirrored: options.mirrored ?? options.tuning?.mirrored ?? true,
  });
  const pinchListeners = new Set<(event: PinchEvent) => void>();
  const frameListeners = new Set<(frame: TrackedHandFrame) => void>();
  const rawListeners = new Set<(frame: RecordedHandFrame) => void>();
  const completions: number[] = [];
  const latencies: number[] = [];
  const inferenceTimes: number[] = [];
  let framesProcessed = 0;
  let framesSkipped = 0;
  let lastError: string | undefined;
  let lastTimestamp = 0;
  let lastFrameTime = 0;
  let busy = false;
  let closed = false;
  let unsubscribe: (() => void) | undefined;

  const pushSample = (list: number[], value: number) => {
    list.push(value);
    if (list.length > LATENCY_SAMPLES) list.shift();
  };
  const mean = (list: number[]) =>
    list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;

  const emit = (events: PinchEvent[]) => {
    for (const event of events)
      for (const listener of pinchListeners) {
        try {
          listener(event);
        } catch (error) {
          console.error('[vision/hands] pinch listener threw', error);
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
      const raw = toRecordedFrame(result, frameTime, width, height);
      const { events, frame } = tracker.update(
        frameTime,
        width / height,
        frameToObservations(raw, SWAP_MEDIAPIPE_HANDEDNESS),
      );
      lastFrameTime = frameTime;
      framesProcessed += 1;
      const emitTime = performance.now();
      // Latency = event emission time - camera frame callback time. This is our processing
      // latency; camera exposure/transfer/decode before the callback is NOT included.
      pushSample(latencies, emitTime - frameTime);
      pushSample(inferenceTimes, t1 - t0);
      completions.push(emitTime);
      emit(events);
      for (const listener of rawListeners) {
        try {
          listener(raw);
        } catch (error) {
          console.error('[vision/hands] raw frame listener threw', error);
        }
      }
      for (const listener of frameListeners) {
        try {
          listener(frame);
        } catch (error) {
          console.error('[vision/hands] frame listener threw', error);
        }
      }
    } catch (error) {
      lastError = errorMessage(error);
      console.error('[vision/hands] inference failed', error);
    } finally {
      busy = false;
    }
  };

  const stop = () => {
    if (!unsubscribe) return;
    unsubscribe();
    unsubscribe = undefined;
    // Release any held grab so the cloth is never left attached to a vanished hand.
    emit(tracker.endAll(lastFrameTime || performance.now()));
  };

  return {
    onPinch(listener) {
      pinchListeners.add(listener);
      return () => pinchListeners.delete(listener);
    },
    onFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onRawFrame(listener) {
      rawListeners.add(listener);
      return () => rawListeners.delete(listener);
    },
    start() {
      if (closed) throw new Error('HandTracker is closed.');
      if (!unsubscribe) unsubscribe = camera.onFrame(onCameraFrame);
    },
    stop,
    stats() {
      const now = performance.now();
      while (completions.length && now - completions[0] > RATE_WINDOW_MS) completions.shift();
      return {
        inferenceHz: (completions.length * 1000) / RATE_WINDOW_MS,
        latencyMs: mean(latencies),
        delegate,
        inferenceMs: mean(inferenceTimes),
        framesProcessed,
        framesSkipped,
        gpuFallbackReason,
        lastError,
      };
    },
    tuning: () => tracker.tuning(),
    setTuning: (partial) => tracker.setTuning(partial),
    close() {
      if (closed) return;
      stop();
      closed = true;
      pinchListeners.clear();
      frameListeners.clear();
      rawListeners.clear();
      landmarker.close();
    },
  };
}
