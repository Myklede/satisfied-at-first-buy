// Two-view webcam body scan: MediaPipe PoseLandmarker (landmarks + person segmentation)
// on every camera frame, quality gates → guidance, a stable-window capture per stage
// (front, then side), median aggregation and calibration.
//
// Privacy: frames and masks are processed in memory inside the MediaPipe callback and are
// never stored, written or sent. Only numbers leave this module. Assets load from the
// local dev server (no CDN).
//
// MediaPipe mask lifetime: with the callback form of detectForVideo, result masks are
// valid only inside the callback. Everything that needs the mask (readback, component
// selection, geometry) runs inside it; we never keep an MPMask, so none needs clone() or
// close(). Only our own copies (person component bytes) outlive the callback.

import {
  FilesetResolver,
  PoseLandmarker,
  type NormalizedLandmark,
  type PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import currentCalibrationJson from '../calibration/current.json';
import {
  SCAN_MEASUREMENT_NAMES,
  applyCalibration,
  parseCalibrationSet,
  type CalibrationSet,
} from './calibration';
import {
  POSE,
  aggregateScan,
  armAbductionDeg,
  measureFrontFrame,
  measureSideFrame,
  personFromMask,
  type FrontFrameMeasure,
  type PixelLandmark,
  type RawMeasurement,
  type SideFrameMeasure,
} from './scanGeometry';
import type {
  BodyScanner,
  BodyScannerOptions,
  CameraHandle,
  ScanGuidance,
  ScanIssue,
  ScanMeasurement,
  ScanMeasurementName,
  ScanResult,
  ScanStage,
} from './types';
import { installNetworkGuard } from './networkGuard';

// ---------------------------------------------------------------------------
// Constants (quality gates are heuristics to tune at the venue; none is a measured optimum)
// ---------------------------------------------------------------------------

/** Accepted stated stature (AGENTS.md §3 physical range). */
export const HEIGHT_RANGE_CM: readonly [number, number] = [120, 220];
/** Default stable-capture seconds per stage (product spec: ~2 s front, ~2 s side). */
export const DEFAULT_HOLD_SECONDS = 2;
export const HOLD_RANGE_S: readonly [number, number] = [0.5, 10];
/** A stage completes only with at least this many accepted frames. Heuristic. */
export const MIN_FRAMES_PER_STAGE = 8;
/** Failed frames shorter than this do not reset the stable window (detector flicker). Heuristic. */
export const GRACE_MS = 300;
/** MediaPipe landmark visibility score required for a landmark to count. Heuristic. */
export const MIN_VISIBILITY = 0.5;
/** MediaPipe Pose detection/presence/tracking confidence (library default 0.5). */
export const POSE_MIN_CONFIDENCE = 0.5;
/** Person must cover at least this share of the image area. Heuristic. */
export const MIN_PERSON_AREA_FRACTION = 0.02;
/**
 * Stature as a share of image height. vision-research.md framing: a 175 cm person at ~2.5 m
 * (landscape, 78° diagonal FOV) or ~1.5 m (portrait) fills roughly 80–90 %. Below 60 % the
 * pixel scale gets coarse; above 95 % there is no margin. Heuristic.
 */
export const MIN_FILL = 0.6;
export const MAX_FILL = 0.95;
/** Absolute resolution floor: below 2 px/cm one pixel is > 0.5 cm on each silhouette edge. */
export const MIN_PX_PER_CM = 2;
/** Mask touching within this share of image height of the top/bottom edge = cut off. Heuristic. */
export const EDGE_MARGIN = 0.005;
/** Landmark motion above this (stature lengths per second ≈ 7 cm/s) = moving. Heuristic. */
export const MAX_BODY_SPEED = 0.04;
export const MOTION_WINDOW_MS = 300;
/** Front pose: upper arm angle from vertical must be within this range (spec: ~30°). Heuristic. */
export const ARM_ABDUCTION_RANGE_DEG: readonly [number, number] = [15, 55];
/**
 * Facing test from the horizontal shoulder-joint separation as a share of stature. Frontal
 * joint-centre separation is ≈ 0.19 of stature (≈ 33 cm / 175 cm, anthropometric rule of
 * thumb); ≤ 0.06 means within ~18° of a true profile. Heuristics.
 */
export const FRONT_MIN_SHOULDER_SEP = 0.12;
export const SIDE_MAX_SHOULDER_SEP = 0.06;
/** Mean luma (0..1) below this = low light. Heuristic. */
export const LOW_LIGHT_LUMA = 0.18;
const LUMA_EVERY_N_FRAMES = 10;

export type PoseModel = 'heavy' | 'full';
export type Delegate = 'GPU' | 'CPU';

// ---------------------------------------------------------------------------
// Public (additive) types; the contract types stay in types.ts
// ---------------------------------------------------------------------------

/** BodyScannerOptions plus lab/tuning knobs. All extra fields are optional. */
export interface BodyScannerLabOptions extends BodyScannerOptions {
  /** Pose model; default 'heavy'. */
  model?: PoseModel;
  /**
   * Preferred delegate. Default 'CPU' (2026-11-13): on this demo laptop (ANGLE/D3D11) the GPU
   * delegate detects people, but its segmentation-mask readback fails every frame
   * (GL_INVALID_OPERATION: glReadPixelsRobustANGLE: invalid format/type), so the scan never saw a
   * person. Creating it succeeds, so it never fell back. Scanning is low-rate (2 s holds), so CPU
   * is fast enough. 'GPU' is opt-in and still falls back to CPU if creation fails.
   */
  delegate?: Delegate;
  /** URL prefix where /models and /mediapipe/wasm are served. Default '/'. */
  assetBase?: string;
  /** Calibration set; default calibration/current.json. */
  calibration?: CalibrationSet;
}

export interface ScanStats {
  model: PoseModel;
  delegate: Delegate;
  /** Landmarker calls per second over the last second. */
  inferenceHz: number;
  /** Mean landmarker time (ms) over the last 30 frames, incl. mask readback. */
  inferMs: number;
  /** Mean geometry time (ms) over the last 30 frames. */
  analysisMs: number;
  maskWidth: number;
  maskHeight: number;
  framesProcessed: number;
}

export interface ScanFrameDebug {
  frameTime: number;
  stage: ScanStage;
  issues: ScanIssue[];
  accepted: boolean;
  /** Person component (our own copy) at mask resolution, 1 = person. */
  mask?: { width: number; height: number; inside: Uint8Array };
  /** Landmarks in mask pixels. */
  landmarks?: PixelLandmark[];
  front?: FrontFrameMeasure;
  side?: SideFrameMeasure;
  /** Horizontal shoulder-joint separation / stature. */
  shoulderSeparation?: number;
  abductionDeg?: { left: number; right: number };
  fill?: number;
  luma?: number;
}

export interface ScanResultDetailed extends ScanResult {
  /** Pre-calibration values with per-scan spread (for calibration pairs). */
  raw: Partial<Record<ScanMeasurementName, RawMeasurement>>;
  model: PoseModel;
  delegate: Delegate;
}

export interface BodyScannerHandle extends BodyScanner {
  run(signal?: AbortSignal): Promise<ScanResultDetailed>;
  /** Per-frame diagnostics for overlays. */
  onDebug(listener: (frame: ScanFrameDebug) => void): () => void;
  stats(): ScanStats;
}

// ---------------------------------------------------------------------------
// Landmarker creation
// ---------------------------------------------------------------------------

async function createLandmarker(
  assetBase: string,
  model: PoseModel,
  preferred: Delegate,
): Promise<{ landmarker: PoseLandmarker; delegate: Delegate }> {
  installNetworkGuard();
  const fileset = await FilesetResolver.forVisionTasks(`${assetBase}mediapipe/wasm`);
  const order: Delegate[] = preferred === 'GPU' ? ['GPU', 'CPU'] : ['CPU'];
  let lastError: unknown;
  for (const delegate of order) {
    let landmarker: PoseLandmarker | undefined;
    try {
      landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${assetBase}models/pose_landmarker_${model}.task`,
          delegate,
        },
        runningMode: 'VIDEO',
        numPoses: 2,
        minPoseDetectionConfidence: POSE_MIN_CONFIDENCE,
        minPosePresenceConfidence: POSE_MIN_CONFIDENCE,
        minTrackingConfidence: POSE_MIN_CONFIDENCE,
        outputSegmentationMasks: true,
      });
      // Warm-up (also proves the delegate works). Timestamp 1 ms precedes any camera frame.
      const warm = document.createElement('canvas');
      warm.width = 64;
      warm.height = 64;
      warm.getContext('2d')?.fillRect(0, 0, 64, 64);
      landmarker.detectForVideo(warm, 1, () => undefined);
      return { landmarker, delegate };
    } catch (error) {
      lastError = error;
      landmarker?.close();
    }
  }
  throw new Error(
    `PoseLandmarker could not be created: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function toPixels(lms: readonly NormalizedLandmark[], w: number, h: number): PixelLandmark[] {
  return lms.map((l) => ({ x: l.x * w, y: l.y * h, visibility: l.visibility ?? 0 }));
}

function validateOptions(o: BodyScannerOptions): { heightCm: number; holdMs: number } {
  const heightCm = o.height_cm;
  if (!(heightCm >= HEIGHT_RANGE_CM[0] && heightCm <= HEIGHT_RANGE_CM[1]))
    throw new RangeError(`height_cm must be ${HEIGHT_RANGE_CM[0]}–${HEIGHT_RANGE_CM[1]}`);
  if (o.sex !== 'female' && o.sex !== 'male')
    throw new RangeError("sex must be 'female' or 'male'");
  const hold = o.holdSeconds ?? DEFAULT_HOLD_SECONDS;
  if (!(hold >= HOLD_RANGE_S[0] && hold <= HOLD_RANGE_S[1]))
    throw new RangeError(`holdSeconds must be ${HOLD_RANGE_S[0]}–${HOLD_RANGE_S[1]}`);
  return { heightCm, holdMs: hold * 1000 };
}

function round(x: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Loads the pose model (GPU, falling back to CPU) and returns a scanner bound to the camera.
 * Inference runs on the main thread only while run() is active.
 */
export async function createBodyScanner(
  camera: CameraHandle,
  options: BodyScannerLabOptions,
): Promise<BodyScannerHandle> {
  const { heightCm, holdMs } = validateOptions(options);
  const model = options.model ?? 'heavy';
  const assetBase = options.assetBase ?? '/';
  const calibration = options.calibration ?? parseCalibrationSet(currentCalibrationJson);
  const { landmarker, delegate } = await createLandmarker(
    assetBase,
    model,
    options.delegate ?? 'CPU',
  );

  const guidanceListeners = new Set<(g: ScanGuidance) => void>();
  const debugListeners = new Set<(d: ScanFrameDebug) => void>();
  let closed = false;
  let lastTs = 1;
  let framesProcessed = 0;
  const callTimes: number[] = [];
  const inferMs: number[] = [];
  const analysisMs: number[] = [];
  let maskSize = { width: 0, height: 0 };

  // Low-light probe on a tiny canvas (in memory only).
  const lumaCanvas = document.createElement('canvas');
  lumaCanvas.width = 32;
  lumaCanvas.height = 18;
  const lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });
  let luma = 1;
  const measureLuma = () => {
    if (!lumaCtx) return;
    lumaCtx.drawImage(camera.source, 0, 0, lumaCanvas.width, lumaCanvas.height);
    const d = lumaCtx.getImageData(0, 0, lumaCanvas.width, lumaCanvas.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    luma = sum / (d.length / 4) / 255;
  };

  let active: {
    stage: ScanStage;
    windowStart: number | null;
    lastGood: number;
    front: FrontFrameMeasure[];
    side: SideFrameMeasure[];
    capture: Array<FrontFrameMeasure | SideFrameMeasure>;
    motion: Array<{ t: number; pts: PixelLandmark[]; stature: number }>;
    finish: (r: ScanResultDetailed) => void;
    fail: (e: unknown) => void;
    unsubscribe: () => void;
  } | null = null;

  const emit = (g: ScanGuidance) => guidanceListeners.forEach((l) => l(g));

  const analyse = (
    result: PoseLandmarkerResult,
    stage: 'front' | 'side',
    frameTime: number,
  ): ScanFrameDebug & { measure?: FrontFrameMeasure | SideFrameMeasure } => {
    const issues: ScanIssue[] = [];
    const dbg: ScanFrameDebug & { measure?: FrontFrameMeasure | SideFrameMeasure } = {
      frameTime,
      stage,
      issues,
      accepted: false,
      luma,
    };
    if (luma < LOW_LIGHT_LUMA) issues.push('low_light');
    const mpMask = result.segmentationMasks?.[0];
    if (result.landmarks.length === 0 || !mpMask) {
      issues.push('no_person');
      return dbg;
    }
    if (result.landmarks.length > 1) issues.push('multiple_people');

    const w = mpMask.width;
    const h = mpMask.height;
    maskSize = { width: w, height: h };
    // GPU→CPU readback happens here; the array is used only within this callback.
    const data = mpMask.getAsFloat32Array();
    const lms = toPixels(result.landmarks[0], w, h);
    dbg.landmarks = lms;
    const person = personFromMask({ width: w, height: h, data }, lms);
    if (!person || person.area < MIN_PERSON_AREA_FRACTION * w * h) {
      issues.push('no_person');
      return dbg;
    }
    dbg.mask = { width: w, height: h, inside: person.inside };

    const vis = (i: number) => lms[i].visibility >= MIN_VISIBILITY;
    const visEither = (a: number, b: number) => vis(a) || vis(b);
    const inFrame = (i: number) => lms[i].x >= 0 && lms[i].x <= w && lms[i].y >= 0 && lms[i].y <= h;
    const margin = EDGE_MARGIN * h;
    const cut = person.bbox.top <= margin || person.bbox.bottom >= h - 1 - margin;
    const feetSeen =
      visEither(POSE.LEFT_HEEL, POSE.RIGHT_HEEL) &&
      (inFrame(POSE.LEFT_HEEL) || inFrame(POSE.RIGHT_HEEL));
    if (cut || !vis(POSE.NOSE) || !feetSeen) issues.push('not_full_body');
    if (stage === 'front') {
      const armsSeen = [
        POSE.LEFT_SHOULDER,
        POSE.RIGHT_SHOULDER,
        POSE.LEFT_ELBOW,
        POSE.RIGHT_ELBOW,
        POSE.LEFT_WRIST,
        POSE.RIGHT_WRIST,
      ].every((i) => vis(i) && inFrame(i));
      if (!armsSeen && !issues.includes('not_full_body')) issues.push('not_full_body');
    }

    let measure: FrontFrameMeasure | SideFrameMeasure | undefined;
    try {
      measure =
        stage === 'front'
          ? measureFrontFrame(person, lms, heightCm)
          : measureSideFrame(person, lms, heightCm);
    } catch {
      issues.push('no_person');
      return dbg;
    }
    const stature = measure.extent.staturePx;
    const fill = stature / h;
    dbg.fill = fill;
    if (fill > MAX_FILL || (person.bbox.top <= margin && person.bbox.bottom >= h - 1 - margin))
      issues.push('too_close');
    if (fill < MIN_FILL || measure.pxPerCm < MIN_PX_PER_CM) issues.push('too_far');

    const sep = Math.abs(lms[POSE.LEFT_SHOULDER].x - lms[POSE.RIGHT_SHOULDER].x) / stature;
    dbg.shoulderSeparation = sep;
    if (stage === 'front') {
      const fm = measure as FrontFrameMeasure;
      dbg.front = fm;
      const abd = { left: armAbductionDeg(lms, 'left'), right: armAbductionDeg(lms, 'right') };
      dbg.abductionDeg = abd;
      const [lo, hi] = ARM_ABDUCTION_RANGE_DEG;
      const armsOk = abd.left >= lo && abd.left <= hi && abd.right >= lo && abd.right <= hi;
      // Facing away from the camera also makes the arms overlap the torso in the image;
      // the contract has no separate "face the camera" issue, so it is reported here.
      if (!armsOk || sep < FRONT_MIN_SHOULDER_SEP) issues.push('arms_not_apart');
    } else {
      dbg.side = measure as SideFrameMeasure;
      if (sep > SIDE_MAX_SHOULDER_SEP) issues.push('not_side_on');
    }

    // Motion: key landmarks vs the latest sample at least MOTION_WINDOW_MS old.
    if (active) {
      const keys = [
        POSE.NOSE,
        POSE.LEFT_SHOULDER,
        POSE.RIGHT_SHOULDER,
        POSE.LEFT_HIP,
        POSE.RIGHT_HIP,
        POSE.LEFT_ELBOW,
        POSE.RIGHT_ELBOW,
        POSE.LEFT_WRIST,
        POSE.RIGHT_WRIST,
        POSE.LEFT_ANKLE,
        POSE.RIGHT_ANKLE,
      ];
      const pts = keys.map((i) => lms[i]);
      const hist = active.motion;
      let ref: (typeof hist)[number] | undefined;
      for (const s of hist) if (frameTime - s.t >= MOTION_WINDOW_MS) ref = s;
      if (ref) {
        let d = 0;
        for (let i = 0; i < pts.length; i++)
          d += Math.hypot(pts[i].x - ref.pts[i].x, pts[i].y - ref.pts[i].y);
        const speed = d / pts.length / stature / ((frameTime - ref.t) / 1000);
        if (speed > MAX_BODY_SPEED) issues.push('moving');
      }
      hist.push({ t: frameTime, pts, stature });
      while (hist.length && frameTime - hist[0].t > 1000) hist.shift();
    }

    dbg.measure = measure;
    return dbg;
  };

  const finishScan = (front: FrontFrameMeasure[], side: SideFrameMeasure[]): ScanResultDetailed => {
    const agg = aggregateScan(front, side);
    const measurements: Partial<Record<ScanMeasurementName, ScanMeasurement>> = {};
    const raw: Partial<Record<ScanMeasurementName, RawMeasurement>> = {};
    const warnings: string[] = [];
    const uncalibrated: ScanMeasurementName[] = [];
    for (const name of SCAN_MEASUREMENT_NAMES) {
      const r = agg.measurements[name];
      if (!r) {
        warnings.push(`${name} not measured: ${agg.missing[name] ?? 'unknown reason'}`);
        continue;
      }
      const c = applyCalibration(calibration, name, r.value_cm, r.spread_cm);
      if (!c.calibrated) uncalibrated.push(name);
      raw[name] = r;
      measurements[name] = {
        value_cm: round(c.value_cm),
        sigma_cm: Math.max(0.1, round(c.sigma_cm)),
        method: `${r.method}; median of ${r.frames} frames; calibration ${calibration.id}${c.calibrated ? '' : ' (uncalibrated)'}`,
      };
    }
    if (calibration.id === 'uncalibrated')
      warnings.unshift(
        'Calibration "uncalibrated": values are raw silhouette geometry (a=1, b=0); sigma is a ' +
          'literature/heuristic estimate, not validated against tape for this camera setup.',
      );
    else if (uncalibrated.length)
      warnings.unshift(
        `No tape pairs for ${uncalibrated.join(', ')} in calibration "${calibration.id}"; those are uncalibrated.`,
      );
    warnings.push(
      'Loose clothing is not detected automatically; loose garments inflate chest/waist/hip.',
    );
    return {
      height_cm: heightCm,
      sex: options.sex,
      measurements,
      frames: { front: front.length, side: side.length },
      calibration: calibration.id,
      warnings,
      raw,
      model,
      delegate,
    };
  };

  const onFrame = (frameTime: number) => {
    const run = active;
    if (!run || closed || run.stage === 'done') return;
    const stage = run.stage;
    const ts = Math.max(frameTime, lastTs + 1);
    lastTs = ts;
    if (framesProcessed % LUMA_EVERY_N_FRAMES === 0) measureLuma();
    framesProcessed++;
    const t0 = performance.now();
    let frame: ReturnType<typeof analyse> | undefined;
    try {
      landmarker.detectForVideo(camera.source, ts, (result) => {
        const t1 = performance.now();
        inferMs.push(t1 - t0);
        frame = analyse(result, stage, frameTime);
        analysisMs.push(performance.now() - t1);
      });
    } catch (error) {
      run.fail(error);
      return;
    }
    callTimes.push(t0);
    while (callTimes.length && t0 - callTimes[0] > 1000) callTimes.shift();
    if (inferMs.length > 30) inferMs.shift();
    if (analysisMs.length > 30) analysisMs.shift();
    if (!frame) return;

    const ok = frame.issues.length === 0 && frame.measure !== undefined;
    frame.accepted = ok;
    if (ok && frame.measure) {
      if (run.windowStart === null) {
        run.windowStart = frameTime;
        run.capture = [];
      }
      run.capture.push(frame.measure);
      run.lastGood = frameTime;
    } else if (run.windowStart !== null && frameTime - run.lastGood > GRACE_MS) {
      run.windowStart = null;
      run.capture = [];
    }
    const progress =
      run.windowStart === null ? 0 : Math.min(1, (frameTime - run.windowStart) / holdMs);
    const { measure: _measure, ...debug } = frame;
    void _measure;
    debugListeners.forEach((l) => l(debug));

    if (progress >= 1 && run.capture.length >= MIN_FRAMES_PER_STAGE) {
      if (stage === 'front') {
        run.front = run.capture as FrontFrameMeasure[];
        run.stage = 'side';
        run.windowStart = null;
        run.capture = [];
        run.motion = [];
        emit({ stage: 'side', ok: false, issues: [], progress: 0 });
        return;
      }
      run.side = run.capture as SideFrameMeasure[];
      run.stage = 'done';
      emit({ stage: 'done', ok: true, issues: [], progress: 1 });
      try {
        run.finish(finishScan(run.front, run.side));
      } catch (error) {
        run.fail(error);
      }
      return;
    }
    emit({ stage, ok, issues: frame.issues, progress });
  };

  return {
    onGuidance(listener) {
      guidanceListeners.add(listener);
      return () => guidanceListeners.delete(listener);
    },
    onDebug(listener) {
      debugListeners.add(listener);
      return () => debugListeners.delete(listener);
    },
    run(signal) {
      if (closed) return Promise.reject(new Error('BodyScanner is closed'));
      if (active) return Promise.reject(new Error('A scan is already running'));
      if (signal?.aborted) return Promise.reject(new DOMException('Scan aborted', 'AbortError'));
      return new Promise<ScanResultDetailed>((resolve, reject) => {
        const cleanup = () => {
          active?.unsubscribe();
          signal?.removeEventListener('abort', onAbort);
          active = null;
        };
        const onAbort = () => {
          cleanup();
          reject(new DOMException('Scan aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        active = {
          stage: 'front',
          windowStart: null,
          lastGood: 0,
          front: [],
          side: [],
          capture: [],
          motion: [],
          finish: (r) => {
            cleanup();
            resolve(r);
          },
          fail: (e) => {
            cleanup();
            reject(e);
          },
          unsubscribe: camera.onFrame(onFrame),
        };
        emit({ stage: 'front', ok: false, issues: [], progress: 0 });
      });
    },
    stats() {
      const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
      return {
        model,
        delegate,
        inferenceHz: callTimes.filter((t) => performance.now() - t <= 1000).length,
        inferMs: mean(inferMs),
        analysisMs: mean(analysisMs),
        maskWidth: maskSize.width,
        maskHeight: maskSize.height,
        framesProcessed,
      };
    },
    close() {
      if (closed) return;
      closed = true;
      active?.fail(new Error('BodyScanner closed'));
      guidanceListeners.clear();
      debugListeners.clear();
      landmarker.close();
    },
  };
}
