// Per-frame camera solve for the AR overlay (agent V2). Pure, no DOM: LiveFrame landmarks +
// posed joints in → camera intrinsics, a smoothed body→camera pose and an honest alignment score.
//
//   1. Correspondences: posed joints (LivePosedScene.joints, scene m) ↔ MediaPipe image landmarks
//      (px), visible ones only (config LANDMARK_OF_JOINT, MIN_VISIBILITY, SOLVE_WEIGHT).
//   2. Per frame: robust Levenberg–Marquardt over yaw, pitch, roll and translation (pitch and roll
//      held near the session's camera tilt), started from the previous frame and from the yaw of
//      MediaPipe's world landmarks.
//   3. Focal length: unknown camera, so it is estimated jointly over diverse keyframes with a
//      diagonal-FOV prior (cameraModel.solveFocal), unless the caller pins a calibrated one.
//   4. One Euro smoothing of the six pose parameters.
//   5. Alignment: reprojection error of shoulders, elbows, wrists and hips under the SMOOTHED pose
//      (what is drawn), in px and as a fraction of the projected shoulder width.
import { OneEuroFilter, OneEuroVecFilter } from '@satisfy/vision';
import type { JointName } from '@satisfy/vision';
import type { ImageLandmark, LiveFrame, WorldLandmark } from '../contract';
import {
  ALIGNMENT_APPROXIMATE_BELOW,
  ALIGNMENT_JOINTS,
  ALIGNMENT_ZERO_FRACTION,
  FOCAL_KEYFRAME_MAX_RMS_FRACTION,
  FOCAL_KEYFRAME_MIN_POINTS,
  FOCAL_MAX_LOG_SIGMA,
  FOCAL_KEYFRAME_SPACING_MS,
  FOCAL_MAX_KEYFRAMES,
  FOCAL_MIN_KEYFRAMES,
  FOCAL_REFIT_EVERY,
  FOV_PRIOR_DIAGONAL_DEG,
  FIXED_FOV_RANGE_DEG,
  FOV_PRIOR_LOG_SIGMA,
  LANDMARK_OF_JOINT,
  LANDMARK_SIGMA_PX,
  MIN_POINTS,
  MIN_VISIBILITY,
  PITCH_ROLL_INITIAL_SIGMA_DEG,
  PIN_SIGMA_DEG,
  FADE_FROM_DEG,
  MAX_YAW_DEG,
  YAW_STEP_LIMIT_DEG,
  YAW_STEP_PERSIST_MS,
  SIDE_SPAN_FADE,
  FRONTAL_MAX_DECAY,
  FRONTAL_NOSE_OFFSET,
  FRONTAL_SPAN_OF_MAX,
  SCALE_FRONTAL_DEG,
  SCALE_PRIOR_SIGMA,
  SCALE_PRIOR_SIGMA_LEARNED,
  BACK_VIEW,
  CLOSE,
  SIDE,
  YAWFAST,
  TORSO,
  TURNSCALE,
  FADE_TAU_MS,
  SCALE_SESSION_TAU_S,
  SCALE_WARMUP_SAMPLES,
  SCALE_WARMUP_TAU_S,
  DEPTH_DEADBAND,
  DEPTH_OUTLIER,
  DEPTH_RANGE_M,
  DEPTH_OUTLIER_PERSIST_MS,
  SMOOTH_DEPTH,
  SMOOTH_PIXEL,
  YAW_PRIOR_SIGMA_DEG,
  PITCH_ROLL_SIGMA_DEG,
  ROBUST_KNEE_SIGMAS,
  SESSION_TILT_TAU_S,
  SMOOTH_LANDMARKS,
  SMOOTH_RESET_MS,
  SMOOTH_TILT,
  SMOOTH_YAW,
  SOLVE_WEIGHT,
  LOSS,
  TILT,
  TURN,
  UNSCALED_JOINTS,
  YAW_DEADBAND_DEG,
} from './config';
import { TurnHeading } from './turnHeading';
import {
  DEG,
  centredIntrinsics,
  diagonalFovDeg,
  focalFromDiagonalFov,
  horizontalFovDeg,
  initialPose,
  project,
  rotation,
  toCamera,
  solveFocal,
  solvePose,
  type BodyPose,
  type Correspondence,
  type Intrinsics,
  type PoseObservation,
  type PosePrior,
  type Vec3,
  wrapAngle,
} from './cameraModel';

export type Joints = Record<string, [number, number, number]>;

export type AlignmentReport = {
  /** 0..1 (config ALIGNMENT_ZERO_FRACTION). */
  score: number;
  /** RMS reprojection error of the visible alignment joints (px, source image). */
  rmsPx: number;
  /** rmsPx ÷ projected shoulder width. */
  rmsFraction: number;
  /** The body's shoulder width (posed joints) projected at the pelvis depth (px). */
  shoulderWidthPx: number;
  /** Pixel error per visible joint, and its signed offset (projected − landmark), px. */
  perJoint: Partial<Record<JointName, { errorPx: number; dx: number; dy: number }>>;
  /** True when the score is below ALIGNMENT_APPROXIMATE_BELOW: the view says so. */
  approximate: boolean;
  points: number;
  /**
   * The score above compares the drawn joints with the landmarks after the session's learned
   * landmark spread (ArTracker.landmarkSpread: MediaPipe's shoulder/hip landmarks sit inside the
   * rig's joint centres). The same RMS with no spread correction, at the jacket's true size (px):
   */
  rmsPxTrueSize?: number;
  landmarkSpread?: number;
};

export type FocalEstimate = {
  f: number;
  diagonalFovDeg: number;
  horizontalFovDeg: number;
  /** 1σ of ln f; NaN while only the prior is known. */
  logSigma: number;
  keyframes: number;
  /** 'weak': solved, but the keyframes did not constrain it; the prior is used. */
  source: 'prior' | 'estimated' | 'weak' | 'pinned';
  /** The last joint solve's focal length, also when it was too weak to use (px). */
  solvedF?: number;
  /** RMS over keyframes at the estimate and at the prior focal length (px). */
  rmsPx?: number;
  priorRmsPx?: number;
};

export type ArSolution = {
  t: number;
  intrinsics: Intrinsics;
  /** Smoothed pose (drawn). */
  pose: BodyPose;
  /** This frame's unsmoothed solve. */
  raw: BodyPose;
  rawRmsPx: number;
  pivot: Vec3;
  focal: FocalEstimate;
  alignment: AlignmentReport | null;
  /** 0..1: how much the overlay fades out (turned beyond FADE_FROM_DEG, or a back view). */
  fade: number;
  /**
   * ?f1fade=1: the last drawn solution, held (no landmarks this frame) while it fades out after a
   * tracking loss. The compositor reuses the last glue controls for it.
   */
  held?: boolean;
  /**
   * ?f1close=1: false when the hips were not used this frame (out of the frame, at its edge or
   * below visibility: config CLOSE); the compositor then glues no hip either. Unset without the flag.
   */
  hipsSeen?: boolean;
  /**
   * True when the 2D evidence says the person shows their back. With turnThrough (?f1turn=1):
   * true when the DRAWN heading is beyond ±90° (the jacket's back is drawn, not hidden).
   */
  backView: boolean;
};

export type ArTrackerOptions = {
  /** Largest body yaw drawn (degrees); default config MAX_YAW_DEG (a kiosk user faces it). */
  maxYawDeg?: number;
  /** Diagonal FOV prior (degrees). Default config FOV_PRIOR_DIAGONAL_DEG. */
  fovPriorDeg?: number;
  /** Pin the diagonal FOV (degrees): no self-calibration (default: the page's ?f1fov=<deg>). */
  fixedFovDeg?: number;
  /** Pin the focal length (px at the frame size) when the camera is calibrated. */
  focalPx?: number;
  /**
   * Draw through the whole turn and on the back (config TURN; default: the page's ?f1turn=1).
   * Off: the front hemisphere only, faded beyond FADE_FROM_DEG, hidden on a back view.
   */
  turnThrough?: boolean;
  /** Warm-up of the session tilt and a drawn tilt deadband (config TILT; default ?f1tilt=1). */
  tiltSteady?: boolean;
  /** Fade out / in on tracking loss and re-entry (config LOSS; default ?f1fade=1). */
  lossFade?: boolean;
  /** Near profile, the 2D shoulder span sets the turn's minimum (config SIDE; default ?f1side=1). */
  sideFloor?: boolean;
  /** Near-rigid torso: wider depth backlash and a yaw backlash (config TORSO; ?f1torso=1). */
  torsoRigid?: boolean;
  /** The drawn depth holds its frontal value through a turn (config TURNSCALE; ?f1turnscale=1). */
  turnScale?: boolean;
  /** Close-range framing, head to waist (config CLOSE; default ?f1close=1). */
  closeRange?: boolean;
  /** Coherent turns pass the yaw step hold (config YAWFAST; default ?f1yawfast=1). */
  yawFast?: boolean;
};

/** ?name=1 / ?name=0 on the page, if any (labs and the kiosk); undefined outside a browser. */
function pageFlag(name: string): boolean | undefined {
  if (typeof location === 'undefined') return undefined;
  const value = new URLSearchParams(location.search).get(name);
  return value === '1' ? true : value === '0' ? false : undefined;
}

/**
 * ?f1fov=<deg> (agent F1, lead 19:35 Camo check): pin the camera's DIAGONAL field of view instead
 * of self-calibrating it (config FIXED_FOV_RANGE_DEG); undefined when absent or out of range.
 */
function pageFov(): number | undefined {
  if (typeof location === 'undefined') return undefined;
  const value = Number(new URLSearchParams(location.search).get('f1fov'));
  const [lo, hi] = FIXED_FOV_RANGE_DEG;
  return Number.isFinite(value) && value >= lo && value <= hi ? value : undefined;
}

type Keyframe = {
  observation: PoseObservation;
  start: BodyPose;
  signature: number[];
};

const robust = { sigmaPx: LANDMARK_SIGMA_PX, kneePx: LANDMARK_SIGMA_PX * ROBUST_KNEE_SIGMAS };
/** The torso correspondences that place and size the drawn jacket under f1turn. */
const TORSO_SOLVE: ReadonlySet<string> = new Set([
  'lShoulder',
  'rShoulder',
  'lHip',
  'rHip',
  'lEye',
  'rEye',
]);

/**
 * The observation restricted to TORSO_SOLVE, or the whole one when fewer than MIN_POINTS remain.
 * shouldersSuffice (f1close): both shoulders alone are enough (head cut by the top edge and hips
 * out of the frame): with the angles and the spread pinned they fix the position and the depth,
 * and the arms, which the rig may not match, stay out of the placement.
 */
export function torsoObservation(
  o: PoseObservation,
  names: readonly string[],
  shouldersSuffice = false,
): PoseObservation {
  const kept = names.filter((n) => TORSO_SOLVE.has(n));
  const points = o.points.filter((_, i) => TORSO_SOLVE.has(names[i]));
  if (points.length >= MIN_POINTS) return { ...o, points };
  return shouldersSuffice && kept.includes('lShoulder') && kept.includes('rShoulder')
    ? { ...o, points }
    : o;
}

/** Lower-body correspondences (f1close gates them against MediaPipe's extrapolation). */
const LOWER_BODY = ['lHip', 'rHip', 'lKnee', 'rKnee', 'lAnkle', 'rAnkle'] as const;

/**
 * f1close (config CLOSE): the lower-body joints whose landmark is MediaPipe's extrapolation of a
 * body cut by the BOTTOM of the frame (a close-up), not an observation: below
 * CLOSE.lowerMinVisibility, or below (height − CLOSE.edgeMarginFrac × height). Hips cut that way go
 * as a pair: one hip alone pulls the pelvis sideways. A hip out at a side (a person walking out of
 * the frame) is left to correspondences()' own frame test, as without the flag (venue 50.6 s: with
 * the pair rule there the torso was placed from one shoulder and an arm, 250 px off).
 */
export function extrapolatedLowerBody(
  landmarks: readonly ImageLandmark[],
  height: number,
): Set<string> {
  const m = CLOSE.edgeMarginFrac * height;
  const out = new Set<string>();
  for (const name of LOWER_BODY) {
    const l = landmarks[LANDMARK_OF_JOINT[name]!];
    if (!l || !(l.visibility >= CLOSE.lowerMinVisibility) || l.y > height - m) out.add(name);
  }
  if (out.has('lHip') || out.has('rHip')) out.add('lHip').add('rHip');
  return out;
}

/**
 * f1close (config CLOSE.lowerFadeFrac): the solve weight factor of a lower-body landmark by its
 * distance to the bottom of the frame: 0 at the edge margin, 1 from lowerFadeFrac × height, smooth
 * between. Hips take the nearer of the pair, so the pelvis hands over to the shoulders gradually
 * as a person walks in (no depth switch when the hips leave the frame).
 */
export function lowerEdgeWeights(
  landmarks: readonly ImageLandmark[],
  height: number,
): Record<string, number> {
  const m = CLOSE.edgeMarginFrac;
  const w = (name: string) => {
    const l = landmarks[LANDMARK_OF_JOINT[name]!];
    if (!l) return 0;
    const d = (height - l.y) / height;
    const x = Math.min(1, Math.max(0, (d - m) / (CLOSE.lowerFadeFrac - m)));
    return x * x * (3 - 2 * x);
  };
  const out: Record<string, number> = {};
  for (const name of LOWER_BODY) out[name] = w(name);
  out.lHip = out.rHip = Math.min(out.lHip, out.rHip);
  return out;
}

/** Correspondences not used while the back is shown (f1turn): MediaPipe's eyes are guesses there. */
const BACK_SKIP: ReadonlySet<string> = new Set(['lEye', 'rEye']);
/** f1turn/f1fade: a solve whose RMS residual exceeds this many shoulder widths is degenerate. */
const GARBAGE_RMS_WIDTHS = 1.5;

/** Builds the 2D–3D correspondences of one frame; null when too few are usable. */
export function correspondences(
  landmarks: readonly ImageLandmark[],
  joints: Joints,
  width: number,
  height: number,
  skip?: ReadonlySet<string>,
): { observation: PoseObservation; names: string[] } | null {
  const pivotJoint = joints.midHip ?? mid(joints.lHip, joints.rHip);
  if (!pivotJoint) return null;
  const points: Correspondence[] = [];
  const names: string[] = [];
  for (const [name, index] of Object.entries(LANDMARK_OF_JOINT)) {
    if (skip?.has(name)) continue;
    const X = joints[name];
    const l = landmarks[index];
    if (!X || !l || !(l.visibility >= MIN_VISIBILITY)) continue;
    // Landmarks outside the frame are MediaPipe's extrapolation, not observations.
    if (l.x < 0 || l.y < 0 || l.x > width || l.y > height) continue;
    points.push({
      X: [X[0], X[1], X[2]],
      u: l.x,
      v: l.y,
      weight: (SOLVE_WEIGHT[name] ?? 0.5) * l.visibility,
      lateral: !UNSCALED_JOINTS.has(name),
    });
    names.push(name);
  }
  if (points.length < MIN_POINTS) return null;
  return { observation: { points, pivot: [pivotJoint[0], pivotJoint[1], pivotJoint[2]] }, names };
}

function mid(a?: [number, number, number], b?: [number, number, number]): Vec3 | null {
  if (!a || !b) return null;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/** The rig's shoulder midpoint (f1close's placement anchor), or null. */
function shoulderMid(joints: Joints): Vec3 | null {
  return mid(joints.lShoulder, joints.rShoulder);
}

/** The person's yaw from MediaPipe world landmarks (camera-aligned axes), or null. */
export function yawFromWorld(world: readonly WorldLandmark[] | null): number | null {
  if (!world) return null;
  let dx = 0,
    dz = 0,
    n = 0;
  for (const [l, r] of [
    [11, 12],
    [23, 24],
  ]) {
    const a = world[l],
      b = world[r];
    if (!a || !b || a.visibility < MIN_VISIBILITY || b.visibility < MIN_VISIBILITY) continue;
    dx += a.x - b.x;
    dz += a.z - b.z;
    n++;
  }
  if (!n || Math.hypot(dx, dz) < 1e-6) return null;
  return Math.atan2(dz, dx);
}

/**
 * The alignment score of the torso joints only (shoulders, hips), same scale as `score`; null when
 * fewer than 3 are visible. The arms are fitted separately (screen fit, sleeve glue), so a gate on
 * the body's registration (the collar guard) reads this one.
 */
export function torsoAlignmentScore(report: AlignmentReport | null): number | null {
  if (!report || !(report.shoulderWidthPx > 0)) return null;
  const errors = (['lShoulder', 'rShoulder', 'lHip', 'rHip'] as const)
    .map((j) => report.perJoint[j]?.errorPx)
    .filter((e): e is number => e !== undefined);
  if (errors.length < 3) return null;
  const rms = Math.sqrt(errors.reduce((a, e) => a + e * e, 0) / errors.length);
  return Math.max(0, Math.min(1, 1 - rms / report.shoulderWidthPx / ALIGNMENT_ZERO_FRACTION));
}

/** Reprojection report for the drawn pose. */
export function alignmentReport(
  K: Intrinsics,
  pose: BodyPose,
  pivot: Vec3,
  landmarks: readonly ImageLandmark[],
  joints: Joints,
): AlignmentReport | null {
  const ls = joints.lShoulder,
    rs = joints.rShoulder;
  if (!ls || !rs) return null;
  const R = rotation(pose);
  const perJoint: AlignmentReport['perJoint'] = {};
  let s = 0,
    n = 0;
  for (const name of ALIGNMENT_JOINTS) {
    const X = joints[name];
    const l = landmarks[LANDMARK_OF_JOINT[name]!];
    if (!X || !l || !(l.visibility >= MIN_VISIBILITY)) continue;
    if (l.x < 0 || l.y < 0 || l.x > K.width || l.y > K.height) continue;
    const [u, v] = project(K, pose, pivot, X, R);
    const dx = u - l.x,
      dy = v - l.y;
    const e = Math.hypot(dx, dy);
    perJoint[name] = { errorPx: e, dx, dy };
    s += e * e;
    n++;
  }
  if (n < 3) return null;
  const width3d = Math.hypot(ls[0] - rs[0], ls[1] - rs[1], ls[2] - rs[2]);
  const shoulderWidthPx = (K.f * width3d) / Math.max(pose.t[2], 0.1);
  const rmsPx = Math.sqrt(s / n);
  const rmsFraction = rmsPx / shoulderWidthPx;
  const score = Math.max(0, Math.min(1, 1 - rmsFraction / ALIGNMENT_ZERO_FRACTION));
  return {
    score,
    rmsPx,
    rmsFraction,
    shoulderWidthPx,
    perJoint,
    approximate: score < ALIGNMENT_APPROXIMATE_BELOW,
    points: n,
  };
}

/** The body's shoulder width projected at the pelvis depth (px), or null. */
function shoulderWidthPx(K: Intrinsics, pose: BodyPose, joints: Joints) {
  const ls = joints.lShoulder,
    rs = joints.rShoulder;
  if (!ls || !rs) return null;
  return (K.f * Math.hypot(ls[0] - rs[0], ls[1] - rs[1], ls[2] - rs[2])) / Math.max(pose.t[2], 0.1);
}

/**
 * Soft yaw deadband around facing the camera (0) and the back view (π): within the inner bound
 * the yaw is exactly the pole, beyond the outer bound it is untouched, smooth in between.
 */
export function deadbandYaw(yaw: number, [inner, outer] = YAW_DEADBAND_DEG) {
  const y = wrapAngle(yaw);
  const pole = Math.abs(y) > Math.PI / 2 ? Math.sign(y) * Math.PI : 0;
  const d = wrapAngle(y - pole);
  const a = inner * DEG,
    b = outer * DEG;
  const x = Math.min(1, Math.max(0, (Math.abs(d) - a) / (b - a)));
  const w = x * x * (3 - 2 * x);
  return pole + d * w;
}

/** A soft deadband on an angle difference (rad): 0 within [inner] deg, untouched beyond [outer]. */
export function softDeadband(d: number, [inner, outer]: readonly [number, number]) {
  const x = Math.min(1, Math.max(0, (Math.abs(d) / DEG - inner) / (outer - inner)));
  return d * x * x * (3 - 2 * x);
}

/** Normalised 2D layout (+ yaw) of a frame, to keep focal keyframes diverse. */
function signature(o: PoseObservation, yaw: number): number[] {
  let cu = 0,
    cv = 0;
  for (const c of o.points) {
    cu += c.u;
    cv += c.v;
  }
  cu /= o.points.length;
  cv /= o.points.length;
  let scale = 0;
  for (const c of o.points) scale += Math.hypot(c.u - cu, c.v - cv);
  scale = scale / o.points.length || 1;
  const out = [yaw];
  for (const c of o.points) out.push((c.u - cu) / scale, (c.v - cv) / scale);
  return out;
}

function distinct(a: number[], b: number[]) {
  const yaw = Math.abs(Math.atan2(Math.sin(a[0] - b[0]), Math.cos(a[0] - b[0]))) / (10 * DEG);
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 1; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  const layout = d / (a.length - 1) / 0.06;
  return Math.max(yaw, layout);
}

export class ArTracker {
  private readonly fovPriorDeg: number;
  /** ?f1fov=<deg>: the diagonal FOV is pinned (fovPriorDeg holds it); no keyframes, no focal fit. */
  readonly fovPinned: boolean;
  private readonly pinnedFocal?: number;
  private size?: { width: number; height: number };
  private focal?: FocalEstimate;
  private keyframes: Keyframe[] = [];
  private lastKeyframeT = -Infinity;
  private fittedAt = 0;
  private session = { pitch: 0, roll: 0, sigma: PITCH_ROLL_INITIAL_SIGMA_DEG * DEG };
  private yawFilter = new OneEuroFilter(SMOOTH_YAW);
  private tiltFilter = new OneEuroVecFilter(2, SMOOTH_TILT);
  private depthFilter = new OneEuroFilter(SMOOTH_DEPTH);
  private pixelFilter = new OneEuroVecFilter(2, SMOOTH_PIXEL);
  private heldDepth?: number;
  private lastDepth?: number;
  private outlierSince?: number;
  private scaleSamples = 0;
  private landmarkFilter = new OneEuroVecFilter(66, SMOOTH_LANDMARKS);
  private focalFitted = false;
  private lastTiltT?: number;
  /** ?f1tilt=1 (config TILT): warm-up of the session tilt and a drawn tilt deadband around it. */
  readonly tiltSteady: boolean;
  /** Session ln(sx): MediaPipe landmark spread vs the rig's joint spread (see config). */
  private lnScale = 0;
  private lastScaleT?: number;
  /** The learned lateral spread ratio (landmarks ÷ rig joints), for the lab readout. */
  get landmarkSpread() {
    return Math.exp(this.lnScale);
  }
  private previous?: { t: number; raw: BodyPose; smoothed: BodyPose; filteredYaw: number };
  /** The last solution (null while nothing is tracked). */
  last: ArSolution | null = null;
  /** True when this frame's solve was degenerate (depth outside DEPTH_RANGE_M) and skipped. */
  degenerate = false;
  private degenerateSince?: number;
  /** ?f1fade=1 (config LOSS): fade on tracking loss and re-entry instead of a cut. */
  readonly lossFade: boolean;
  /** ?f1side=1 (config SIDE): the 2D shoulder span floors the drawn turn near profile. */
  readonly sideFloor: boolean;
  /** ?f1torso=1 (config TORSO): drawn depth and yaw move only beyond their backlash bands. */
  readonly torsoRigid: boolean;
  private heldYaw?: number;
  /** ?f1turnscale=1 (config TURNSCALE): the drawn depth through a turn = the last frontal one. */
  readonly turnScale: boolean;
  private frontalDepth?: number;
  private turnReleaseSince?: number;
  /** ?f1close=1 (config CLOSE): close-range framing, head to waist. */
  readonly closeRange: boolean;
  /** The nearest pelvis depth drawn (config DEPTH_RANGE_M; CLOSE.minDepthM under f1close). */
  private get minDepth() {
    return this.closeRange ? CLOSE.minDepthM : DEPTH_RANGE_M[0];
  }
  /** f1fade: the drawn jacket opacity (1 − fade) and the last good solution. */
  private alpha = 0;
  private lastGood?: { solution: ArSolution; t: number };

  private readonly maxYaw: number;
  /** Draw through the whole turn and on the back (config TURN; ?f1turn=1). */
  readonly turnThrough: boolean;
  private readonly turn = new TurnHeading(TURN);
  /** Lab readout of the f1turn heading fusion (null when off). */
  get f1Debug() {
    return this.turnThrough ? this.turn.debug : null;
  }
  private yawJumpSince?: number;
  /** f1side: the time of the last world-driven heading (turned past TURN.blendToDeg). */
  private worldDrivenT?: number;
  /** ?f1yawfast=1 (config YAWFAST): coherent turns pass the yaw step hold. */
  readonly yawFast: boolean;
  /** f1yawfast: MediaPipe's world yaw on the last two frames (rad, newest first). */
  private worldHist: [number | undefined, number | undefined] = [undefined, undefined];
  /** f1yawfast: this frame's turn magnitude read from the 2D shoulder span (rad), if any. */
  private spanTurn?: number;
  /** f1yawfast + f1turnscale: the drawn depth gliding out of a turn-scale hold. */
  private depthGlide?: { z: number; t: number };
  /** Recent maximum of the depth-normalised 2D shoulder span (frontal reference). */
  private spanMax?: { value: number; t: number };
  /** True when this frame was judged frontal by 2D evidence (yaw pinned to 0). */
  frontal2d = false;
  /** The turn/side fade smoothed in time (config FADE_TAU_MS). */
  private smoothFade = 0;
  private lastFadeT?: number;
  /** Back-view state with its hold (backEvidence / backFrom; config BACK_VIEW). */
  private back = { on: false, frontSince: undefined as number | undefined };
  /** This frame's back-view evidence, for the lab (votes 0..3 and the cues). */
  backEvidence: {
    votes: number;
    order: number;
    noseBehindM: number | null;
    rawYawDeg: number;
    faceSeen: boolean;
  } | null = null;

  constructor(options: ArTrackerOptions = {}) {
    this.maxYaw = (options.maxYawDeg ?? MAX_YAW_DEG) * DEG;
    const fixedFov = options.fixedFovDeg ?? pageFov();
    this.fovPinned = fixedFov !== undefined;
    this.fovPriorDeg = fixedFov ?? options.fovPriorDeg ?? FOV_PRIOR_DIAGONAL_DEG;
    this.pinnedFocal = options.focalPx;
    this.turnThrough = options.turnThrough ?? pageFlag('f1turn') ?? false;
    this.tiltSteady = options.tiltSteady ?? pageFlag('f1tilt') ?? false;
    this.lossFade = options.lossFade ?? pageFlag('f1fade') ?? false;
    this.closeRange = options.closeRange ?? pageFlag('f1close') ?? false;
    this.sideFloor = options.sideFloor ?? pageFlag('f1side') ?? false;
    this.torsoRigid = options.torsoRigid ?? pageFlag('f1torso') ?? false;
    this.turnScale = options.turnScale ?? pageFlag('f1turnscale') ?? false;
    this.yawFast = options.yawFast ?? pageFlag('f1yawfast') ?? false;
    this.turn.flipGuard = this.yawFast;
    if (this.tiltSteady) this.session = { pitch: 0, roll: 0, sigma: TILT.sigmaDeg * DEG };
  }

  get alignment(): number | null {
    return this.last?.alignment?.score ?? null;
  }

  /**
   * The person's whole-body heading about the vertical, degrees in (−180, 180]: 0 = facing the
   * camera, + = turned to the person's left (the solve's yaw sign), ±180 = back to the camera.
   * The back-view detector resolves the front/back ambiguity: on a back view the front-folded
   * drawn yaw is unfolded. null when nothing is tracked. For V6's LiveDeformContext.rootYawDeg.
   */
  get headingDeg(): number | null {
    const s = this.last;
    if (!s) return null;
    const yaw = (wrapAngle(s.pose.yaw) * 180) / Math.PI;
    // f1turn draws the full heading already (the back at ±180°): nothing to unfold.
    if (!s.backView || this.turnThrough) return yaw;
    const h = yaw >= 0 ? 180 - yaw : -180 - yaw;
    return h === -180 ? 180 : h;
  }

  get focalEstimate(): FocalEstimate | undefined {
    return this.focal;
  }

  reset() {
    this.keyframes = [];
    this.lastKeyframeT = -Infinity;
    this.fittedAt = 0;
    this.focal = undefined;
    this.size = undefined;
    this.session = this.tiltSteady
      ? { pitch: 0, roll: 0, sigma: TILT.sigmaDeg * DEG }
      : { pitch: 0, roll: 0, sigma: PITCH_ROLL_INITIAL_SIGMA_DEG * DEG };
    this.focalFitted = false;
    this.lastTiltT = undefined;
    this.lnScale = 0;
    this.lastScaleT = undefined;
    this.scaleSamples = 0;
    this.resetSmoothing();
    this.last = null;
  }

  /** Forget the smoothing state (a seek in a video: the next frame is shown as solved). */
  resetSmoothing() {
    this.yawFilter.reset();
    this.tiltFilter.reset();
    this.degenerateSince = undefined;
    this.depthFilter.reset();
    this.pixelFilter.reset();
    this.heldDepth = undefined;
    this.heldYaw = undefined;
    this.worldDrivenT = undefined;
    this.worldHist = [undefined, undefined];
    this.depthGlide = undefined;
    this.frontalDepth = undefined;
    this.turnReleaseSince = undefined;
    this.lastDepth = undefined;
    this.outlierSince = undefined;
    this.landmarkFilter.reset();
    this.previous = undefined;
    this.back = { on: false, frontSince: undefined };
    this.smoothFade = 0;
    this.lastFadeT = undefined;
    this.turn.reset();
  }

  /** One Euro on the 33 landmarks' pixel positions (visibility passes through). */
  private smoothLandmarks(t: number, l: readonly ImageLandmark[]): ImageLandmark[] {
    if (l.length !== 33) return l.slice();
    const xy = new Array<number>(66);
    for (let i = 0; i < 33; i++) {
      xy[i * 2] = l[i].x;
      xy[i * 2 + 1] = l[i].y;
    }
    const f = this.landmarkFilter.filter(xy, t);
    return l.map((p, i) => ({ x: f[i * 2], y: f[i * 2 + 1], visibility: p.visibility }));
  }

  private ensureFocal(width: number, height: number): FocalEstimate {
    if (this.size && (this.size.width !== width || this.size.height !== height)) this.reset();
    this.size = { width, height };
    if (!this.focal) {
      const f = this.pinnedFocal ?? focalFromDiagonalFov(width, height, this.fovPriorDeg);
      this.focal = {
        f,
        diagonalFovDeg: diagonalFovDeg(width, height, f),
        horizontalFovDeg: horizontalFovDeg(width, f),
        logSigma: NaN,
        keyframes: 0,
        source: this.pinnedFocal || this.fovPinned ? 'pinned' : 'prior',
      };
    }
    return this.focal;
  }

  /**
   * Back view (config BACK_VIEW). MediaPipe keeps its face landmarks "visible" on a person's back
   * (0.97–0.99 on the user's videos), so face visibility is no cue. A back view needs BOTH:
   *   the shoulder order flipped in the image (left shoulder 11 on the image left), with a span
   *     that is not a side view's;
   *   an independent face cue: the nose BEHIND the shoulders in MediaPipe's world landmarks.
   * The face cue abstains when the nose, or both the ears and the eyes, are out of the frame or
   * below MIN_VISIBILITY (a close-up with the head cut off: V4's re-shoot, cam-tshirt 12.5 s, read
   * as a back view). The raw solve's yaw follows the shoulder order (a left/right swap reads as a
   * back-facing solve), so it is reported, not voted. Leaving needs frontal evidence (order, and
   * the nose in front when the face is seen) for BACK_VIEW.releaseMs (no flicker).
   */
  private backView(
    frame: LiveFrame,
    landmarks: readonly ImageLandmark[],
    span: number,
    rawYaw: number,
    f: number,
    depth: number,
  ): boolean {
    const B = BACK_VIEW;
    const ls = landmarks[11],
      rs = landmarks[12];
    if (!ls || !rs || ls.visibility < MIN_VISIBILITY || rs.visibility < MIN_VISIBILITY) {
      this.backEvidence = null;
      return this.back.on;
    }
    const seen = (i: number) => {
      const p = landmarks[i];
      return (
        !!p &&
        p.visibility >= MIN_VISIBILITY &&
        p.x >= 0 &&
        p.y >= 0 &&
        p.x <= frame.width &&
        p.y <= frame.height
      );
    };
    const faceSeen = seen(0) && ((seen(7) && seen(8)) || (seen(2) && seen(5)));
    const order = (ls.x - rs.x) / Math.max(1, span);
    const w = frame.world;
    const noseBehindM =
      faceSeen && w && w[0] && w[11] && w[12] ? w[0].z - (w[11].z + w[12].z) / 2 : null;
    const spanM = (span * depth) / f;
    const wide = !this.spanMax || spanM >= B.minSpanOfMax * this.spanMax.value;
    const rawDeg = (wrapAngle(rawYaw) * 180) / Math.PI;
    const flipped = order < -B.order && wide;
    const behind = noseBehindM !== null && noseBehindM > B.noseBehindM;
    const votes = (flipped ? 1 : 0) + (behind ? 1 : 0);
    this.backEvidence = { votes, order, noseBehindM, rawYawDeg: rawDeg, faceSeen };
    const b = this.back;
    if (flipped && behind) {
      b.on = true;
      b.frontSince = undefined;
    } else if (b.on) {
      const front =
        order > B.order && (noseBehindM === null || noseBehindM < -B.noseFrontM) && !behind;
      if (!front) b.frontSince = undefined;
      else {
        b.frontSince ??= frame.t;
        if (frame.t - b.frontSince >= B.releaseMs) {
          b.on = false;
          b.frontSince = undefined;
        }
      }
    }
    return b.on;
  }

  /** Solves one frame. Returns null (and alignment unknown) when the person is not tracked. */
  update(frame: LiveFrame, joints: Joints): ArSolution | null {
    const { width, height } = frame;
    const focal = this.ensureFocal(width, height);
    // A gap or a backward jump (a seek, a new source) starts the smoothing afresh.
    if (this.previous && Math.abs(frame.t - this.previous.t) > SMOOTH_RESET_MS)
      this.resetSmoothing();
    const landmarks = frame.landmarks2d && this.smoothLandmarks(frame.t, frame.landmarks2d);
    // f1turn: on the back MediaPipe's eye landmarks are guesses (visibility stays ~0.98; venue
    // trace: they pulled the solve 15–25° off the back and its depth from 1.5 to 2.1 m): unused.
    const fromBack =
      this.turnThrough &&
      this.previous !== undefined &&
      Math.abs(wrapAngle(this.previous.smoothed.yaw)) > Math.PI / 2;
    // f1close: the lower body MediaPipe only extrapolated (a close-up's hips) is not observed.
    const lowerOut = this.closeRange && landmarks ? extrapolatedLowerBody(landmarks, height) : null;
    const skip =
      lowerOut || fromBack
        ? new Set<string>([...(lowerOut ?? []), ...(fromBack ? BACK_SKIP : [])])
        : undefined;
    const built = landmarks && correspondences(landmarks, joints, width, height, skip);
    if (!built) return this.lost(frame);
    // f1close: hips not cut by the bottom of the frame (the compositor may glue them).
    const hipsSeen = !lowerOut?.has('lHip');
    const bothHips = built.names.includes('lHip') && built.names.includes('rHip');
    if (lowerOut) {
      // The hips hand over to the shoulders as they near the frame edge, and the eyes go with
      // them: in a close-up the eyes-to-shoulders gap is not the rig's (live parka replay 67–68 s:
      // 71 px where the rig at the shoulders' depth projects 230 px; the head bent to the laptop),
      // and with the eyes in the placement the drawn shoulders sat 45–55 px below the landmarks.
      const fade = lowerEdgeWeights(landmarks, height);
      const eyes = hipsSeen ? fade.lHip : 0;
      built.observation.points.forEach((p, i) => {
        const name = built.names[i];
        const k = name === 'lEye' || name === 'rEye' ? eyes : fade[name];
        if (k !== undefined) p.weight *= k;
      });
    }
    const { observation } = built;
    const K = centredIntrinsics(width, height, focal.f);
    const mpYawRaw = yawFromWorld(frame.world);
    // Front hemisphere only (kiosk): MediaPipe's own yaw clamped to ±maxYaw as the prior; f1turn:
    // the full circle (the world yaw is continuous through a turn, see turnHeading.ts).
    const mpYaw =
      mpYawRaw === null
        ? null
        : this.turnThrough
          ? wrapAngle(mpYawRaw)
          : Math.max(-this.maxYaw, Math.min(this.maxYaw, wrapAngle(mpYawRaw)));
    // Back view from 2D evidence: left shoulder (11) at image LEFT of the right one, nose hidden.
    const ls2 = landmarks[11],
      rs2 = landmarks[12],
      nose = landmarks[0];
    const span = Math.hypot(ls2.x - rs2.x, ls2.y - rs2.y);
    const prior: PosePrior = {
      ...this.session,
      yaw: mpYaw ?? undefined,
      yawSigma: YAW_PRIOR_SIGMA_DEG * DEG,
      lnScale: this.lnScale,
      // Once the session spread is learnt, a per-frame spread change is not cheaper than a turn:
      // at σ 0.15 the free solve absorbed a 40–55° turn as a 25 % narrower spread (yaw lag).
      scaleSigma:
        this.scaleSamples >= SCALE_WARMUP_SAMPLES ? SCALE_PRIOR_SIGMA_LEARNED : SCALE_PRIOR_SIGMA,
    };
    const starts: BodyPose[] = [];
    if (this.previous) starts.push({ ...this.previous.raw, t: [...this.previous.raw.t] });
    // The flipped-yaw start: near facing, ±yaw are the two minima of the 2D widths.
    if (this.previous)
      starts.push({
        ...this.previous.raw,
        yaw: -this.previous.raw.yaw,
        t: [...this.previous.raw.t],
      });
    if (mpYaw !== null) starts.push(initialPose(K, observation, mpYaw, prior));
    if (!this.previous && mpYaw === null) starts.push(initialPose(K, observation, 0, prior));
    let solved;
    try {
      solved = solvePose(K, observation, starts, prior, robust);
    } catch {
      return this.lost(frame);
    }
    // A degenerate solve (depth outside a person's range in front of a camera) is not drawn.
    const widthPx = shoulderWidthPx(K, solved.pose, joints);
    // f1turn/f1fade: a solve that cannot explain the landmarks at all is degenerate too (laptop
    // close-up, head out of frame: cam-tshirt 5.3–6.6 s solved at RMS 1e8 px and drew the jacket at
    // the 6 m depth clamp, i.e. invisible, for 1.3 s). Normal solves stay below 0.3 shoulder widths.
    const garbage =
      (this.turnThrough || this.lossFade) && !(solved.rmsPx <= GARBAGE_RMS_WIDTHS * (widthPx ?? 0));
    this.degenerate =
      garbage || solved.pose.t[2] < this.minDepth || solved.pose.t[2] > DEPTH_RANGE_M[1];
    if (this.degenerate) {
      // Keep the last good pose only to fade it out: a degenerate frame is never drawn as truth.
      // f1turn: the body is still tracked (a side view can solve degenerate): the last good pose
      // stays drawn, unfaded, for up to SMOOTH_RESET_MS of degenerate frames, then fades.
      this.degenerateSince ??= frame.t;
      const hold = this.turnThrough && frame.t - this.degenerateSince < SMOOTH_RESET_MS;
      // f1fade: the held pose fades out by steps instead of vanishing at the end of the hold.
      if ((this.lossFade || this.closeRange) && !hold) return this.lost(frame);
      this.last = this.previous && this.last ? { ...this.last, fade: hold ? 0 : 1 } : null;
      return this.last;
    }
    this.degenerateSince = undefined;
    // Only frames posed from this very frame's tracking, and well explained by the posed body,
    // may inform the focal length (a stale or mis-posed body would bias it).
    // f1close: full views only (hips seen): a close-up's eyes-to-shoulders proportion is the rig's.
    const fullView = !this.closeRange || bothHips;
    if (
      fullView &&
      frame.pose &&
      widthPx &&
      solved.rmsPx <= FOCAL_KEYFRAME_MAX_RMS_FRACTION * widthPx
    )
      this.collectKeyframe(frame.t, observation, solved.pose);
    // Re-read: collectKeyframe may have refined the focal length.
    const Kf = centredIntrinsics(width, height, this.focal!.f);
    const raw =
      Kf.f === K.f ? solved.pose : solvePose(Kf, observation, [solved.pose], prior, robust).pose;
    // Learn the landmark-spread scale from frames that face the camera by both estimates.
    const facing = (y: number) => Math.abs(wrapAngle(y)) < SCALE_FRONTAL_DEG * DEG;
    // f1close: the spread is learned from full views only (the prior for a close-up, where the
    // free solve's spread trades off against the rig's head-to-shoulder proportion).
    if (
      fullView &&
      raw.sx &&
      mpYaw !== null &&
      facing(raw.yaw) &&
      facing(mpYaw) &&
      widthPx &&
      solved.rmsPx <= 0.15 * widthPx
    ) {
      const dt = this.lastScaleT === undefined ? 0 : (frame.t - this.lastScaleT) / 1000;
      const tau =
        this.scaleSamples < SCALE_WARMUP_SAMPLES ? SCALE_WARMUP_TAU_S : SCALE_SESSION_TAU_S;
      const a = this.lastScaleT === undefined ? 0.2 : 1 - Math.exp(-Math.max(0, dt) / tau);
      this.lnScale += a * (Math.log(raw.sx) - this.lnScale);
      this.lastScaleT = frame.t;
      this.scaleSamples++;
    }
    // A fixed camera: until a focal fit sets it, learn the session tilt slowly from good frames.
    // f1tilt (config TILT): the session tilt is a fixed level-camera prior, never learned.
    if (!this.tiltSteady && !this.focalFitted && widthPx && solved.rmsPx <= 0.1 * widthPx) {
      const dt = this.lastTiltT === undefined ? 0 : (frame.t - this.lastTiltT) / 1000;
      const a =
        this.lastTiltT === undefined ? 1 : 1 - Math.exp(-Math.max(0, dt) / SESSION_TILT_TAU_S);
      this.session = {
        pitch: this.session.pitch + a * (raw.pitch - this.session.pitch),
        roll: this.session.roll + a * (raw.roll - this.session.roll),
        sigma: PITCH_ROLL_SIGMA_DEG * DEG,
      };
      this.lastTiltT = frame.t;
    }
    const backView = this.backView(frame, landmarks, span, raw.yaw, Kf.f, raw.t[2]);
    // Front hemisphere: a back-facing solve is folded to its mirror yaw, then limited.
    let yawIn = wrapAngle(raw.yaw);
    // Frontal by 2D evidence: pin the yaw to 0 (no side panel the person does not show).
    const spanM = (span * raw.t[2]) / Kf.f;
    const prevMax = this.spanMax
      ? this.spanMax.value *
        Math.pow(1 - FRONTAL_MAX_DECAY, Math.max(0, frame.t - this.spanMax.t) / 1000)
      : 0;
    if (Number.isFinite(spanM) && spanM > prevMax) this.spanMax = { value: spanM, t: frame.t };
    else if (this.spanMax) this.spanMax = { value: prevMax, t: frame.t };
    const mid = (ls2.x + rs2.x) / 2;
    this.frontal2d =
      !backView &&
      // f1turn: on the back the nose is centred and the span full too (venue trace 44–48 s).
      !(this.turnThrough && mpYaw !== null && Math.abs(mpYaw) > TURN.blendToDeg * DEG) &&
      (nose?.visibility ?? 0) >= MIN_VISIBILITY &&
      Math.abs(nose.x - mid) <= FRONTAL_NOSE_OFFSET * span &&
      !!this.spanMax &&
      spanM >= FRONTAL_SPAN_OF_MAX * this.spanMax.value;
    if (this.frontal2d) yawIn = 0;
    if (Math.abs(yawIn) > Math.PI / 2) yawIn = Math.sign(yawIn) * Math.PI - yawIn;
    yawIn = Math.max(-this.maxYaw, Math.min(this.maxYaw, yawIn));
    // f1turn: the front yaw hands over to MediaPipe's world yaw once turned (turnHeading.ts).
    this.spanTurn = undefined;
    if (this.turnThrough)
      yawIn = this.turn.update(
        frame.t,
        yawIn,
        mpYaw === null ? null : this.spanLimited(mpYaw, span, joints, Kf.f, raw.t[2]),
        backView,
      );
    // Continuity: a jump > YAW_STEP_LIMIT_DEG is held unless it persists. f1turn: not for a
    // world-driven heading (turnHeading guards its own label flips): on the venue turn a real
    // 49° step through the side view (world −115 → −66° in 0.29 s) was held at −112° for 0.3 s
    // and the translation re-solve under that wrong yaw drew the jacket 17 % too small.
    const worldDriven = this.turnThrough && (this.turn.debug?.weight ?? 0) >= 1;
    // f1side (config SIDE.exitMs): the frames right after a world-driven turn are not held either;
    // turning back to front the steps from the turned heading are real (the hold froze a frontal
    // body's jacket at 3/4 for 4-5 frames, then snapped).
    if (worldDriven) this.worldDrivenT = frame.t;
    const exitTurn =
      this.sideFloor &&
      this.worldDrivenT !== undefined &&
      frame.t >= this.worldDrivenT &&
      frame.t - this.worldDrivenT <= SIDE.exitMs;
    // f1yawfast (config YAWFAST): a step that a coherent turn explains is not held either.
    const coherent = this.yawFast && this.coherentTurn(mpYaw, yawIn);
    if (mpYaw !== null) this.worldHist = [wrapAngle(mpYaw), this.worldHist[0]];
    else this.worldHist = [undefined, undefined];
    if (exitTurn || coherent) this.yawJumpSince = undefined;
    else if (this.previous && !worldDriven) {
      const prev = this.previous.filteredYaw;
      if (Math.abs(wrapAngle(yawIn - prev)) > YAW_STEP_LIMIT_DEG * DEG) {
        this.yawJumpSince ??= frame.t;
        if (frame.t - this.yawJumpSince < YAW_STEP_PERSIST_MS) yawIn = prev;
      } else this.yawJumpSince = undefined;
    }
    // f1turn: the drawn pose's translation and depth come from the torso only (shoulders, hips,
    // eyes). With the yaw pinned near facing, crossed arms the rig had not matched pulled the depth
    // 15 % in 0.3 s (judge ab1-f1 puffer 23.38–23.71 s: 1.44 → 1.22 m) and the sleeves tore.
    const drawnObs =
      this.turnThrough || this.closeRange
        ? torsoObservation(observation, built.names, this.closeRange)
        : observation;
    const anchor = this.closeRange ? shoulderMid(joints) : null;
    const smoothed = this.smooth(
      frame.t,
      { ...raw, yaw: yawIn },
      Kf,
      drawnObs,
      anchor ?? undefined,
    );
    const turned = Math.abs(wrapAngle(smoothed.yaw)) / DEG;
    const x = Math.min(
      1,
      Math.max(0, (turned - FADE_FROM_DEG) / (this.maxYaw / DEG - FADE_FROM_DEG)),
    );
    // Turning from 2D: the shoulder span against its expected frontal span.
    const ls3 = joints.lShoulder,
      rs3 = joints.rShoulder;
    let sideFade = 0;
    if (ls3 && rs3 && ls2.visibility >= MIN_VISIBILITY && rs2.visibility >= MIN_VISIBILITY) {
      const frontal =
        (Kf.f *
          Math.exp(this.lnScale) *
          Math.hypot(ls3[0] - rs3[0], ls3[1] - rs3[1], ls3[2] - rs3[2])) /
        Math.max(0.3, smoothed.t[2]);
      const ratio = span / Math.max(1, frontal);
      const y = Math.min(
        1,
        Math.max(0, (SIDE_SPAN_FADE[0] - ratio) / (SIDE_SPAN_FADE[0] - SIDE_SPAN_FADE[1])),
      );
      sideFade = y * y * (3 - 2 * y);
    }
    // Turn and side fades are smoothed in time (FADE_TAU_MS): a single noisy frame (a close-up's
    // span or order glitch) no longer flashes the overlay off. A back view hides at once.
    const turnFade = Math.max(x * x * (3 - 2 * x), sideFade);
    const fdt = this.lastFadeT === undefined ? Infinity : Math.max(0, frame.t - this.lastFadeT);
    const fa = Number.isFinite(fdt) ? 1 - Math.exp(-fdt / FADE_TAU_MS) : 1;
    this.smoothFade += fa * (turnFade - this.smoothFade);
    this.lastFadeT = frame.t;
    // f1turn: drawn on every tracked frame (only a degenerate solve, above, is faded); the back
    // view is reported for what is drawn (the jacket's back), not hidden.
    const fade = this.turnThrough ? 0 : backView ? 1 : this.smoothFade;
    const shownBack = this.turnThrough ? Math.abs(wrapAngle(smoothed.yaw)) > Math.PI / 2 : backView;
    const spread = Math.exp(this.lnScale);
    const alignment = frame.landmarks2d
      ? alignmentReport(
          Kf,
          { ...smoothed, sx: spread },
          observation.pivot,
          frame.landmarks2d,
          joints,
        )
      : null;
    const trueSize = frame.landmarks2d
      ? alignmentReport(Kf, smoothed, observation.pivot, frame.landmarks2d, joints)
      : null;
    if (alignment) {
      alignment.rmsPxTrueSize = trueSize?.rmsPx;
      alignment.landmarkSpread = spread;
    }
    // f1fade: a jacket that was gone (start, re-entry) fades in by LOSS.stepPerFrame per frame.
    if (this.lossFade) this.alpha = Math.min(1, this.alpha + LOSS.stepPerFrame);
    this.last = {
      t: frame.t,
      intrinsics: Kf,
      pose: smoothed,
      raw,
      rawRmsPx: solved.rmsPx,
      pivot: observation.pivot,
      focal: this.focal!,
      alignment,
      fade: this.lossFade ? Math.max(fade, 1 - this.alpha) : fade,
      backView: shownBack,
      ...(this.closeRange ? { hipsSeen } : {}),
    };
    if (this.lossFade || this.closeRange) this.lastGood = { solution: this.last, t: frame.t };
    return this.last;
  }

  /**
   * f1fade: no solution this frame. Without the flag: nothing is drawn. With it: the last good
   * solution is held in place and fades out by LOSS.stepPerFrame per frame (dropped after
   * LOSS.holdMs or once fully faded); the compositor reuses its last glue controls.
   */
  private lost(frame: LiveFrame): ArSolution | null {
    const g = this.lastGood;
    // f1close: a short MediaPipe loss (a close-up's head at the top edge) keeps the jacket drawn.
    if (this.closeRange && g && frame.t >= g.t && frame.t - g.t <= CLOSE.holdFullMs) {
      this.last = { ...g.solution, t: frame.t, held: true };
      return this.last;
    }
    if (!this.lossFade || !g || frame.t < g.t || frame.t - g.t > LOSS.holdMs) {
      this.alpha = 0;
      this.last = null;
      return null;
    }
    this.alpha = Math.max(0, this.alpha - LOSS.stepPerFrame);
    if (this.alpha <= 0) {
      this.last = null;
      return null;
    }
    this.last = { ...g.solution, t: frame.t, fade: 1 - this.alpha, held: true };
    return this.last;
  }

  /**
   * f1turn: the world yaw limited by the 2D shoulder span (config TURN.spanMarginDeg): its turn
   * away from facing (or from the back) is at most acos(span ÷ expected frontal span) + margin.
   * The expected frontal span = the rig's shoulder joints at the last drawn depth, with the
   * learned landmark spread. Unchanged when the shoulders are not both seen.
   */
  private spanLimited(
    world: number,
    span: number,
    joints: Joints,
    f: number,
    rawDepth: number,
  ): number {
    const ls = joints.lShoulder,
      rs = joints.rShoulder;
    // The last drawn depth; right after a smoothing reset (re-entry) this frame's solve depth.
    const depth = this.previous?.smoothed.t[2] ?? rawDepth;
    if (!ls || !rs || !depth || !(span > 0)) return world;
    const frontal =
      (f * Math.exp(this.lnScale) * Math.hypot(ls[0] - rs[0], ls[1] - rs[1], ls[2] - rs[2])) /
      Math.max(0.3, depth);
    if (!(frontal > 0)) return world;
    const fromSpan = Math.acos(Math.min(1, span / frontal));
    this.spanTurn = fromSpan;
    const allowed = fromSpan + TURN.spanMarginDeg * DEG;
    const w = wrapAngle(world);
    const back = Math.abs(w) > Math.PI / 2;
    const folded = back ? Math.PI - Math.abs(w) : Math.abs(w);
    const sign = Math.sign(w) || 1;
    // f1side: near profile the span reads the turn better than the world yaw (config SIDE).
    // The floor fades in over SIDE.rampDeg below fromDeg (no step when the reading crosses it).
    if (this.sideFloor) {
      const x = Math.min(
        1,
        Math.max(0, (fromSpan - (SIDE.fromDeg - SIDE.rampDeg) * DEG) / (SIDE.rampDeg * DEG)),
      );
      const k = x * x * (3 - 2 * x);
      const floor = fromSpan - SIDE.floorMarginDeg * DEG;
      if (k > 0 && folded < floor) {
        const turned = Math.min(allowed, folded + k * (floor - folded));
        return sign * (back ? Math.PI - turned : turned);
      }
    }
    if (folded <= allowed) return w;
    return sign * (back ? Math.PI - allowed : allowed);
  }

  /**
   * f1yawfast (config YAWFAST): true when the step from the last filtered yaw to `yawIn` is a
   * coherent turn: the world yaw moved the same way on this frame and the one before, or the 2D
   * shoulder span (where well conditioned) reads the new heading's turn.
   */
  private coherentTurn(mpYaw: number | null, yawIn: number): boolean {
    if (!this.turnThrough || !this.previous || mpYaw === null) return false;
    const step = wrapAngle(yawIn - this.previous.filteredYaw);
    const [w1, w2] = this.worldHist;
    if (w1 !== undefined && w2 !== undefined) {
      const d0 = wrapAngle(wrapAngle(mpYaw) - w1),
        d1 = wrapAngle(w1 - w2);
      if (
        Math.sign(d0) === Math.sign(step) &&
        Math.sign(d1) === Math.sign(step) &&
        Math.abs(d0) >= YAWFAST.minWorldStepDeg * DEG &&
        Math.abs(d1) >= YAWFAST.minPrevStepDeg * DEG
      )
        return true;
    }
    const s = this.spanTurn;
    if (s === undefined || s < YAWFAST.spanFromDeg * DEG) return false;
    const fold = (y: number) => Math.min(Math.abs(wrapAngle(y)), Math.PI - Math.abs(wrapAngle(y)));
    return Math.abs(fold(yawIn) - s) <= YAWFAST.spanAgreeDeg * DEG;
  }

  /** f1tilt (config TILT): the drawn camera is level; the per-frame pitch/roll are not drawn. */
  private steadyTilt(): [number, number] {
    return [0, 0];
  }

  /**
   * The drawn pose: yaw smoothed heavily then deadbanded, pitch/roll smoothed, then translation
   * re-solved with those three angles pinned (so the overlay stays on the landmarks) and smoothed.
   */
  private smooth(
    t: number,
    raw: BodyPose,
    K: Intrinsics,
    observation: PoseObservation,
    anchor?: Vec3,
  ): BodyPose {
    // Unwrap the yaw next to the previous filtered value so the filter never sees a 2π jump.
    let yaw = raw.yaw;
    if (this.previous) {
      const prev = this.previous.filteredYaw;
      yaw = prev + wrapAngle(yaw - prev);
    }
    const filteredYaw = this.yawFilter.filter(yaw, t);
    let [pitch, roll] = this.tiltFilter.filter([raw.pitch, raw.roll], t);
    if (this.tiltSteady) [pitch, roll] = this.steadyTilt();
    // f1torso: a yaw backlash (config TORSO.yawHoldDeg): sub-degree shimmer never turns the torso.
    let shownYaw = filteredYaw;
    if (this.torsoRigid) {
      const band = TORSO.yawHoldDeg * DEG;
      const h = this.heldYaw ?? filteredYaw;
      const d = filteredYaw - h;
      this.heldYaw = Math.abs(d) > band ? filteredYaw - Math.sign(d) * band : h;
      shownYaw = this.heldYaw;
    }
    const drawnYaw = deadbandYaw(shownYaw);
    const pin = PIN_SIGMA_DEG * DEG;
    let tr: Vec3 = raw.t;
    try {
      tr = solvePose(
        K,
        observation,
        [{ yaw: drawnYaw, pitch, roll, t: [...raw.t], sx: Math.exp(this.lnScale) }],
        {
          pitch,
          roll,
          sigma: pin,
          yaw: drawnYaw,
          yawSigma: pin,
          // The SESSION spread, not this frame's: a per-frame spread trades off against depth.
          lnScale: this.lnScale,
          scaleSigma: 0.005,
        },
        robust,
      ).pose.t;
    } catch {
      // keep the free solve's translation
    }
    // Depth (the drawn size) held; the pelvis's pixel smoothed on its own; x, y re-derived at the
    // held depth so the jacket stays on the body without changing size.
    let z = Math.min(DEPTH_RANGE_M[1], Math.max(this.minDepth, tr[2]));
    // Depth outlier gate: a one-frame jump is a degenerate solve; a sustained one is real.
    const ref = this.lastDepth;
    if (ref !== undefined && Math.abs(z - ref) / ref > DEPTH_OUTLIER) {
      this.outlierSince ??= t;
      if (t - this.outlierSince < DEPTH_OUTLIER_PERSIST_MS) z = ref;
      else {
        this.outlierSince = undefined;
        this.depthFilter.reset();
        this.heldDepth = undefined;
      }
    } else this.outlierSince = undefined;
    this.lastDepth = z;
    // The anchor's offset from the pelvis in camera axes (zero: the pelvis is the anchor).
    // f1close: the shoulders' midpoint. In a close-up the pelvis is far below the frame, so the
    // held depth (deadband, lag) re-derived about it moved the drawn shoulders 14–35 px off their
    // landmarks (live parka replay 66.5–68 s); about the shoulders it moves only the cropped hem.
    const d: Vec3 = anchor
      ? toCamera(rotation({ yaw: drawnYaw, pitch, roll }), [0, 0, 0], observation.pivot, anchor)
      : [0, 0, 0];
    const [u, v] = this.pixelFilter.filter(
      [(K.f * (tr[0] + d[0])) / (z + d[2]) + K.cx, (K.f * (tr[1] + d[1])) / (z + d[2]) + K.cy],
      t,
    );
    let zf = this.depthFilter.filter(z, t);
    // f1turnscale: turned (folded drawn yaw beyond TURNSCALE.fromDeg) the depth is the frontal one.
    const yawAbs = Math.abs(wrapAngle(drawnYaw));
    const turnedAway = Math.min(yawAbs, Math.PI - yawAbs) > TURNSCALE.fromDeg * DEG;
    if (this.turnScale && turnedAway && this.frontalDepth !== undefined) {
      if (Math.abs(zf / this.frontalDepth - 1) > TURNSCALE.releaseFrac) {
        this.turnReleaseSince ??= t;
        if (t - this.turnReleaseSince >= TURNSCALE.releaseMs) this.frontalDepth = zf;
      } else this.turnReleaseSince = undefined;
      zf = this.frontalDepth;
      this.depthGlide = this.yawFast ? { z: zf, t } : undefined;
    } else {
      this.turnReleaseSince = undefined;
      // f1yawfast (config YAWFAST.depthGlideMs): the end of a turn-scale hold glides, no step.
      const g = this.depthGlide;
      if (g && this.turnScale && t > g.t) {
        const a = 1 - Math.exp(-(t - g.t) / YAWFAST.depthGlideMs);
        const z1 = g.z + a * (zf - g.z);
        this.depthGlide =
          Math.abs(z1 / zf - 1) <= YAWFAST.depthGlideEndFrac ? undefined : { z: z1, t };
        zf = z1;
      }
    }
    let held = this.heldDepth ?? zf;
    const band = this.torsoRigid ? TORSO.depthDeadband : DEPTH_DEADBAND;
    if (zf > held * (1 + band)) held = zf / (1 + band);
    else if (zf < held * (1 - band)) held = zf / (1 - band);
    this.heldDepth = held;
    if (this.turnScale && !turnedAway) this.frontalDepth = held;
    const za = held + d[2];
    const ts: Vec3 = [((u - K.cx) * za) / K.f - d[0], ((v - K.cy) * za) / K.f - d[1], held];
    const smoothed: BodyPose = { yaw: drawnYaw, pitch, roll, t: ts };
    this.previous = { t, raw, smoothed, filteredYaw };
    return smoothed;
  }

  private collectKeyframe(t: number, observation: PoseObservation, pose: BodyPose) {
    if (this.pinnedFocal || this.fovPinned || !this.size) return;
    if (this.keyframes.length >= FOCAL_MAX_KEYFRAMES) return;
    if (observation.points.length < FOCAL_KEYFRAME_MIN_POINTS) return;
    if (t - this.lastKeyframeT < FOCAL_KEYFRAME_SPACING_MS) return;
    const sig = signature(observation, pose.yaw);
    if (this.keyframes.some((k) => distinct(k.signature, sig) < 1)) return;
    this.keyframes.push({
      observation: { pivot: observation.pivot, points: observation.points.map((c) => ({ ...c })) },
      start: { ...pose, t: [...pose.t] },
      signature: sig,
    });
    this.lastKeyframeT = t;
    const n = this.keyframes.length;
    if (n >= FOCAL_MIN_KEYFRAMES && n - this.fittedAt >= (this.fittedAt ? FOCAL_REFIT_EVERY : 0))
      this.fitFocal();
  }

  /** Joint focal solve over the keyframes (also re-centres the session pitch / roll). */
  fitFocal() {
    if (!this.size || !this.keyframes.length || this.pinnedFocal || this.fovPinned) return;
    const { width, height } = this.size;
    const result = solveFocal(
      width,
      height,
      this.keyframes.map((k) => ({ observation: k.observation, start: k.start })),
      { f: focalFromDiagonalFov(width, height, this.fovPriorDeg), logSigma: FOV_PRIOR_LOG_SIGMA },
      { pitch: 0, roll: 0, sigma: PITCH_ROLL_INITIAL_SIGMA_DEG * DEG },
      robust,
    );
    const median = (values: number[]) => {
      const s = values.slice().sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    if (!this.tiltSteady)
      this.session = {
        pitch: median(result.poses.map((p) => p.pitch)),
        roll: median(result.poses.map((p) => p.roll)),
        sigma: PITCH_ROLL_SIGMA_DEG * DEG,
      };
    this.keyframes.forEach((k, i) => (k.start = result.poses[i]));
    this.fittedAt = this.keyframes.length;
    this.focalFitted = true;
    const usable = result.logSigma <= FOCAL_MAX_LOG_SIGMA;
    const f = usable ? result.f : focalFromDiagonalFov(width, height, this.fovPriorDeg);
    this.focal = {
      f,
      diagonalFovDeg: diagonalFovDeg(width, height, f),
      horizontalFovDeg: horizontalFovDeg(width, f),
      logSigma: result.logSigma,
      keyframes: this.keyframes.length,
      source: usable ? 'estimated' : 'weak',
      solvedF: result.f,
      rmsPx: result.rmsPx,
      priorRmsPx: result.priorRmsPx,
    };
  }

  /** Session camera tilt (pitch, roll in degrees) as currently estimated. */
  get cameraTiltDeg() {
    return { pitch: this.session.pitch / DEG, roll: this.session.roll / DEG };
  }
}
