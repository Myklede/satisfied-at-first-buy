// Public contract of @satisfy/vision. Codex's app imports ONLY these types and the
// functions re-exported from index.ts. Changing a shape here is a breaking change:
// announce it in prompts/ first (AGENTS.md §1).
//
// Privacy: frames never leave the browser and are never written to disk. Only the
// numeric results below may be sent to the local body service (127.0.0.1).

// ---------- Camera ----------
export interface CameraInfo {
  deviceId: string;
  label: string;
  /** Actual negotiated stream size (not the requested one). */
  width: number;
  height: number;
  /** Measured delivered frame rate over the last second. */
  fps: number;
  /** True when frames are rotated 90° in software so the person fills a portrait frame. */
  portrait: boolean;
}

export interface CameraOptions {
  deviceId?: string;
  /** Rotate a landscape device (e.g. a phone streamed via DroidCam) to portrait. */
  rotate?: 0 | 90 | 270;
  /** Request size; the real one is reported in CameraInfo. Default 1280×720 @ 30. */
  width?: number;
  height?: number;
  frameRate?: number;
  /**
   * Opt-in floor for the frame rate (e.g. 24). Webcams in dim light stretch the exposure and drop
   * from 30 to ~17 fps (measured on the demo laptop's Integrated Camera, 2026-11-13), which makes
   * live tracking choppy. After the stream opens, a best-effort `applyConstraints` asks for
   * `frameRate.min`; the driver may then raise gain instead of exposure (a noisier, darker image).
   * If the device refuses, the stream is kept as it is. It is never an error.
   */
  minFrameRate?: number;
}

export interface CameraHandle {
  /** The live <video>; attach it to the DOM only for a preview. */
  readonly video: HTMLVideoElement;
  /**
   * Frame source for inference: the video itself, or a rotated canvas when
   * `rotate` ≠ 0. Already updated for the current frame when onFrame listeners run.
   */
  readonly source: HTMLVideoElement | HTMLCanvasElement;
  /** Called once per new camera frame (requestVideoFrameCallback) with performance.now() ms. */
  onFrame(listener: (frameTime: number) => void): () => void;
  info(): CameraInfo;
  close(): void;
}

export type CameraErrorCode =
  | 'no_camera'
  | 'permission_denied'
  | 'device_busy'
  | 'resolution_too_low'
  | 'unknown';

// ---------- Hands / pinch ----------
export type Handedness = 'left' | 'right';

/** Screen-space pointer in the viewer's normalised device coordinates (-1..1, +y up). */
export interface NdcPoint {
  x: number;
  y: number;
}

export interface PinchEvent {
  type: 'start' | 'move' | 'end';
  hand: Handedness;
  /** Filtered (One Euro) pinch point = midpoint of thumb tip and index tip. */
  ndc: NdcPoint;
  /**
   * Relative depth change since pinch start, in metres-equivalent from apparent hand
   * size. + = hand moved toward the camera. 0 at 'start'. Not an absolute distance.
   */
  depthDelta: number;
  /** performance.now() of the camera frame that produced this event (ms). */
  frameTime: number;
  /** Detection confidence 0..1 from the landmarker. */
  confidence: number;
  /**
   * Which closed grip produced the grab (any closed grip grabs; an open hand releases).
   * Optional for backward compatibility; set by createHandTracker.
   */
  grip?: 'pinch' | 'lateral' | 'fist';
  /** Confidence class the grab started with (see HandFrame). Optional for compatibility. */
  gripConfidence?: 'clear' | 'ambiguous';
}

export interface HandFrame {
  frameTime: number;
  hands: Array<{
    hand: Handedness;
    /** 21 landmarks in NDC with relative z, filtered. */
    landmarks: Array<{ x: number; y: number; z: number }>;
    pinching: boolean;
    /** Normalised pinch distance (thumb-index / hand scale). */
    pinchRatio: number;
    /** 0..1 progress toward a grab, smoothed (no jumps); 1 while grabbing. Draw as a filling ring. */
    grabProgress: number;
    /**
     * 'clear': observable grip, fast grab. 'ambiguous': thumb hidden behind the index, grabs only
     * after a still dwell (~1.4 s). While grabbing: the class the grab started with.
     */
    gripConfidence: 'clear' | 'ambiguous';
  }>;
}

export interface HandTrackerStats {
  /** Landmarker inference rate (Hz). */
  inferenceHz: number;
  /** Mean ms from frame capture timestamp to event emission. */
  latencyMs: number;
  delegate: 'GPU' | 'CPU';
}

export interface HandTrackerOptions {
  /** Mirror x so the on-screen hand moves like a mirror. Default true. */
  mirrored?: boolean;
  maxHands?: 1 | 2;
}

export interface HandTracker {
  onPinch(listener: (event: PinchEvent) => void): () => void;
  onFrame(listener: (frame: HandFrame) => void): () => void;
  start(): void;
  stop(): void;
  stats(): HandTrackerStats;
  close(): void;
}

// ---------- Body scan ----------
/** Names match the body service's KnownMeasurements fields (docs/MEASUREMENTS.md). */
export type ScanMeasurementName =
  | 'shoulder_width_cm'
  | 'chest_cm'
  | 'waist_cm'
  | 'hip_cm'
  | 'arm_length_cm';

export interface ScanMeasurement {
  value_cm: number;
  /** 1-sigma uncertainty from calibration residuals + per-scan spread. Never 0. */
  sigma_cm: number;
  method: string;
}

export type ScanStage = 'front' | 'side' | 'done';

export type ScanIssue =
  | 'no_person'
  | 'multiple_people'
  | 'not_full_body'
  | 'too_close'
  | 'too_far'
  | 'moving'
  | 'arms_not_apart'
  | 'not_side_on'
  | 'loose_clothing_suspected'
  | 'low_light';

export interface ScanGuidance {
  stage: ScanStage;
  ok: boolean;
  issues: ScanIssue[];
  /** 0..1 progress of the current stage's stable-capture window. */
  progress: number;
}

export interface ScanResult {
  height_cm: number;
  sex: 'female' | 'male';
  measurements: Partial<Record<ScanMeasurementName, ScanMeasurement>>;
  /** Frames actually aggregated per stage. */
  frames: { front: number; side: number };
  /** Id of the calibration set used (see packages/vision/CALIBRATION.md). */
  calibration: string;
  warnings: string[];
}

export interface BodyScannerOptions {
  height_cm: number;
  sex: 'female' | 'male';
  /** Seconds of stable capture per stage. Default 2. */
  holdSeconds?: number;
}

export interface BodyScanner {
  onGuidance(listener: (guidance: ScanGuidance) => void): () => void;
  /** Runs front then side capture; resolves when both pass quality checks. */
  run(signal?: AbortSignal): Promise<ScanResult>;
  close(): void;
}
