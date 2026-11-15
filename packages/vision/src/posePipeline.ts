// Per-frame pose pipeline shared by the live tracker and recording replay. Pure (no DOM, no
// MediaPipe): landmarks in → filtered AnatomicalPose + smoothed per-DOF confidence out.
//
//   estimateAnatomicalPose (raw angles, confidence, holds, clamps)
//   → One Euro filter per DOF (Casiez et al., CHI '12; see oneEuro.ts), per-DOF tuning
//   → confidence smoothed with a first-order low-pass (time constant CONFIDENCE_TAU_MS)
// plus the optional neutral calibration step (NeutralCalibrator, 1 s still and upright).

import {
  ANATOMICAL_DOFS,
  NeutralCalibrator,
  estimateAnatomicalPose,
  neutralPose,
  zeroConfidence,
  type AnatomicalDof,
  type AnatomicalPose,
  type CalibrationProgress,
  type NeutralCalibration,
  type PoseConfidence,
  type PoseLandmarksInput,
} from './anatomicalPose';
import { OneEuroFilter, type OneEuroParams } from './oneEuro';

/**
 * One Euro parameters per DOF (degrees and deg/s; pelvis drop in m and m/s). Heuristics chosen by
 * the paper's procedure on synthetic 1 cm landmark noise (anatomicalPose.test.ts reports ~1–4°
 * raw error): low minCutoff where the raw signal is noisy and slow (twist, axial), higher beta
 * on fast limbs (arm raises reach 200–400 deg/s → cutoff +4–8 Hz). Retune with real recordings.
 */
const ARM: OneEuroParams = { minCutoff: 1.2, beta: 0.02, dCutoff: 1 };
const PLANE: OneEuroParams = { minCutoff: 1.0, beta: 0.01, dCutoff: 1 };
const TRUNK: OneEuroParams = { minCutoff: 0.8, beta: 0.01, dCutoff: 1 };
const SLOW_NOISY: OneEuroParams = { minCutoff: 0.5, beta: 0.005, dCutoff: 1 };
const LEG: OneEuroParams = { minCutoff: 1.0, beta: 0.015, dCutoff: 1 };
export const POSE_FILTER_PARAMS: Readonly<Record<AnatomicalDof, OneEuroParams>> = {
  trunk_flexion: TRUNK,
  trunk_lateral: TRUNK,
  trunk_twist: SLOW_NOISY,
  shoulder_L_plane: PLANE,
  shoulder_L_elevation: ARM,
  shoulder_L_axial: SLOW_NOISY,
  shoulder_R_plane: PLANE,
  shoulder_R_elevation: ARM,
  shoulder_R_axial: SLOW_NOISY,
  elbow_L_flexion: ARM,
  elbow_R_flexion: ARM,
  hip_L_flexion: LEG,
  hip_R_flexion: LEG,
  knee_L_flexion: LEG,
  knee_R_flexion: LEG,
  pelvis_drop_m: { minCutoff: 1.0, beta: 2, dCutoff: 1 },
};

/** Confidence smoothing time constant (ms). Heuristic: removes flicker, follows occlusion fast. */
export const CONFIDENCE_TAU_MS = 150;
/** With no person for this long, filters reset (no slow glide from a stale pose). Heuristic. */
export const LOST_RESET_MS = 500;

export interface PoseTrackerFrame {
  /** performance.now() ms of the camera frame. */
  frameTime: number;
  /** Filtered pose (contract units). Held at the last value while no person is seen. */
  pose: AnatomicalPose;
  /** Smoothed per-DOF confidence 0..1 (0 while no person is seen). */
  confidence: PoseConfidence;
  /** Unfiltered estimate of this frame (diagnostics). */
  raw: AnatomicalPose;
  personDetected: boolean;
  calibrated: boolean;
  /** DOFs clamped to anatomical limits in this frame. */
  clamped: AnatomicalDof[];
  /** Present while a neutral calibration is running. */
  calibrating?: CalibrationProgress;
}

export interface PosePipelineOptions {
  calibration?: NeutralCalibration | null;
  filterParams?: Partial<Record<AnatomicalDof, OneEuroParams>>;
  /** Hold time for calibration (ms); default 1000. */
  calibrationHoldMs?: number;
}

export class PosePipeline {
  private filters: Record<AnatomicalDof, OneEuroFilter>;
  private cal: NeutralCalibration | null;
  private calibrator: NeutralCalibrator;
  private calibrating = false;
  private calibrationListeners = new Set<(c: NeutralCalibration) => void>();
  private lastRaw: AnatomicalPose | null = null;
  private lastPose: AnatomicalPose = neutralPose();
  private conf: PoseConfidence = zeroConfidence();
  private lastTime: number | undefined;
  private lastSeen: number | undefined;

  constructor(options: PosePipelineOptions = {}) {
    this.cal = options.calibration ?? null;
    this.calibrator = new NeutralCalibrator(options.calibrationHoldMs);
    const params = { ...POSE_FILTER_PARAMS, ...options.filterParams };
    this.filters = Object.fromEntries(
      ANATOMICAL_DOFS.map((d) => [d, new OneEuroFilter(params[d])]),
    ) as Record<AnatomicalDof, OneEuroFilter>;
  }

  get calibration(): NeutralCalibration | null {
    return this.cal;
  }

  setCalibration(calibration: NeutralCalibration | null): void {
    this.cal = calibration;
    this.resetFilters();
  }

  /** Starts a neutral calibration: the next 1 s of still upright frames set vertical + hip height. */
  startCalibration(): void {
    this.calibrator.reset();
    this.calibrating = true;
  }

  cancelCalibration(): void {
    this.calibrating = false;
    this.calibrator.reset();
  }

  get isCalibrating(): boolean {
    return this.calibrating;
  }

  onCalibrated(listener: (c: NeutralCalibration) => void): () => void {
    this.calibrationListeners.add(listener);
    return () => this.calibrationListeners.delete(listener);
  }

  private resetFilters(): void {
    for (const d of ANATOMICAL_DOFS) this.filters[d].reset();
    this.lastRaw = null;
  }

  /** Processes one frame. `input` undefined = no person detected. */
  update(frameTime: number, input: PoseLandmarksInput | undefined): PoseTrackerFrame {
    const dt = this.lastTime === undefined ? 0 : Math.max(0, frameTime - this.lastTime);
    this.lastTime = frameTime;
    let calibrating: CalibrationProgress | undefined;
    if (this.calibrating) {
      calibrating = this.calibrator.update(frameTime, input);
      if (calibrating.done) {
        this.calibrating = false;
        this.setCalibration(calibrating.done);
        for (const l of this.calibrationListeners) l(calibrating.done);
      }
    }
    const k = dt > 0 ? 1 - Math.exp(-dt / CONFIDENCE_TAU_MS) : 1;

    if (!input) {
      if (this.lastSeen === undefined || frameTime - this.lastSeen > LOST_RESET_MS)
        this.resetFilters();
      // No person: nothing is observed, so confidence drops to 0 at once and ramps up again later.
      this.conf = zeroConfidence();
      return {
        frameTime,
        pose: { ...this.lastPose },
        confidence: zeroConfidence(),
        raw: { ...this.lastPose },
        personDetected: false,
        calibrated: this.cal !== null,
        clamped: [],
        calibrating,
      };
    }
    if (this.lastSeen !== undefined && frameTime - this.lastSeen > LOST_RESET_MS)
      this.resetFilters();
    this.lastSeen = frameTime;

    const est = estimateAnatomicalPose(input, {
      calibration: this.cal,
      previous: this.lastRaw ?? this.lastPose,
    });
    this.lastRaw = est.pose;
    const pose = neutralPose();
    for (const d of ANATOMICAL_DOFS) {
      pose[d] = this.filters[d].filter(est.pose[d], frameTime);
      this.conf[d] += k * (est.confidence[d] - this.conf[d]);
    }
    this.lastPose = pose;
    return {
      frameTime,
      pose: { ...pose },
      confidence: { ...this.conf },
      raw: est.pose,
      personDetected: true,
      calibrated: this.cal !== null,
      clamped: est.clamped,
      calibrating,
    };
  }
}
