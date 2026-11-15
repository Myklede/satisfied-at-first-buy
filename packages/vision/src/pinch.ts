// Pure pinch logic: no DOM, no MediaPipe. hands.ts feeds it landmarks; tests and the replay
// harness feed it synthetic or recorded hands.
//
// Per inference frame:
//   1. detections -> isotropic units (image heights); duplicates merged
//   2. detections associated to TRACKS by nearest constant-velocity-predicted palm position
//      (identity = spatial continuity, not MediaPipe's left/right label)
//   3. per track: sticky, time-smoothed handedness label (locked while pinching)
//   4. pinch ratio -> hysteresis + debounce, release made stricter when the hand moves fast
//   5. tracks that vanish keep their pinch for a grace period, emitting damped extrapolated moves
//
// OPERATING RANGE: tuned for pulling at 0.5–1 m from a laptop camera; 1–1.5 m must degrade
// gracefully (never drop a grab or flip hands). Geometry for a ~70° x 43° (16:9) webcam: the frame
// is ~0.79·D metres tall at distance D, so a 9 cm wrist→MCP spans ~0.23 image heights at 0.5 m,
// ~0.11 at 1 m and ~0.08 at 1.5 m; 1 m/s of hand motion is ~2.5, ~1.3 and ~0.85 image heights/s.
//
// Every threshold below is a HEURISTIC starting value. The 2026-11-12 real-hand test (laptop
// Integrated Camera, 1280x720) showed: no jitter at rest; grabs dropped and labels flipped during
// fast motion. The values here target that; they are not yet re-verified on a real hand.

import {
  DEFAULT_GRAB_MODEL,
  fromHandLocal,
  grabSignal,
  gripFeatures,
  handFrame2d,
  naturalGripPoint,
  toHandLocal,
  validateGrabModel,
} from './grip';
import type { GrabModel, GripConfidence, GripType } from './grip';
import { OneEuroFilter, OneEuroVecFilter, validateOneEuroParams } from './oneEuro';
import type { OneEuroParams } from './oneEuro';
import type { HandFrame, Handedness, NdcPoint, PinchEvent } from './types';

// ---------- MediaPipe hand landmark indices (fixed by the model topology) ----------
export const HAND_LANDMARK_COUNT = 21;
export const LM_WRIST = 0;
export const LM_THUMB_TIP = 4;
export const LM_INDEX_TIP = 8;
export const LM_MIDDLE_MCP = 9;
/** Wrist + the four finger MCPs: a rigid set, unaffected by finger motion and less blurred. */
export const PALM_LANDMARKS: readonly number[] = [0, 5, 9, 13, 17];

// ---------- Grab detection ----------
// Since option B (2026-11-12) the levels below apply to the GRIP OPENNESS from grip.ts
// (grabSignal): min of tip ratio, lateral/key-grip and fist hypotheses, all on the tip-ratio
// scale. For a plain tip pinch the openness IS the tip ratio, so the evidence below still holds.
/**
 * Enter when |thumbTip−indexTip| / |wrist−middleMCP| drops below this. Touching tips read about
 * 0.15–0.22. Real-hand test: holding a pinch was detected reliably at 0.25. [heuristic]
 */
export const PINCH_ENTER_RATIO = 0.25;
/**
 * Consecutive frames below ENTER to start (and to re-confirm a pinch during a pending release).
 * Recordings: with 2, a hand passing through the ratio band while opening/closing produced
 * 2-frame dips that started false 100–340 ms grabs; real pinches stayed below ENTER for 5+ frames.
 * 3 removed those (+33 ms start latency at 30 fps). Chosen by leave-one-out (TUNING below).
 */
export const PINCH_ENTER_FRAMES = 4;

// ---------- Release = accumulated time above the exit ratio ----------
// Real recordings (2026-11-12, user's hand, Integrated Camera, 0.5–1 m; test-data/hands) showed:
//   held pinch 0.0–0.25; pinch loosening mid-drag 0.3–0.5 for 1–3 frames; relaxed open hand
//   0.4–0.6; fully open 0.7–0.9. A real release often settles at the RELAXED level (≈0.45) for
//   300 ms+, so a high exit ratio would miss it, while a short frame count splits drags on wobble.
// Rule: time with ratio > EXIT accumulates "release evidence" (×OPEN_RELEASE_WEIGHT when the hand
// is clearly open, ratio > OPEN); a re-confirmed pinch (ENTER_FRAMES consecutive frames below
// ENTER) resets it; anything else, including undetected frames and isolated pinch-looking frames,
// leaves it unchanged. Release when evidence ≥ RELEASE_MS.
/** Ratio above which release evidence accumulates (when slow): the bottom of the relaxed band. */
export const PINCH_EXIT_RATIO = 0.4;
/** Ratio of a clearly open hand: evidence accumulates OPEN_RELEASE_WEIGHT× faster. */
export const PINCH_OPEN_RATIO = 0.65;
/** Evidence multiplier for a clearly open hand: a decisive opening releases in ~70–100 ms. */
export const OPEN_RELEASE_WEIGHT = 3;
/**
 * Release evidence (ms) needed to end a pinch when the hand is slow: ~270 ms (8 frames) at the
 * relaxed level, ~100 ms (3 frames) for a clearly open hand. Leave-one-out choice (TUNING below).
 */
export const RELEASE_MS = 300;
/** Max evidence one frame can add (ms), so one frame after a dropout cannot release alone. */
export const RELEASE_MAX_STEP_MS = 50;

// ---------- Speed-aware release ----------
// Motion blur smears fingertips, so the measured ratio inflates during a fast drag even though
// the fingers stay closed (real-hand test: grabs dropped mid-drag). Between SLOW and FAST speed
// the exit/open ratios and the release time ramp up linearly.
/**
 * Thresholds are in IMAGE speed because motion blur (what inflates the ratio) is proportional to
 * image-space speed, whatever the distance.
 * Palm speed (image heights/s) below which the slow release rule applies: ~0.16 m/s at 0.5 m,
 * ~0.3 m/s at 1 m.
 */
export const RELEASE_SLOW_SPEED = 0.4;
/** Strictest release rule from this palm speed: ~0.6 m/s at 0.5 m, ~1.2 m/s at 1 m. [heuristic] */
export const RELEASE_FAST_SPEED = 1.5;
/**
 * Added to the exit and open ratios at FAST speed (exit 0.40 -> 0.65, open 0.65 -> 0.90). In the
 * recordings, very fast drags read 0.5–0.67 for single frames between 0.1–0.2 frames; 0.15 still
 * split one of them, 0.25 did not. Leave-one-out choice (TUNING below).
 */
export const FAST_EXIT_RATIO_BONUS = 0.25;
/** Extra release evidence (ms) required at FAST speed (250 -> 350 ms). Grid: 100 ≈ 200. */
export const FAST_RELEASE_EXTRA_MS = 100;

// ---------- Dropout grace with extrapolation ----------
/**
 * A track may be undetected this long (ms) before its pinch ends. Measured in the recordings:
 * detection gaps during pinches reached 333–400 ms in fast drags (inference fell to ~16 Hz while
 * MediaPipe re-detected the hand), so 250 ms split drags. 500 ms covers the longest measured gap
 * with margin; a hand that really leaves keeps its grab half a second, with the extrapolated point
 * coming to rest after ~0.2 s (EXTRAPOLATION_TAU_MS).
 */
export const GRACE_MS = 500;

// TUNING (2026-11-12): grid over enterFrames {2,3} × RELEASE_MS {150..300} × fast extra
// {100,200} ms × fast ratio bonus {0.15,0.25} × grace {300,500} ms, scored on the 4 valid
// recordings by 10 × (tracker-induced splits) + |starts − user's expected count|. A "split" is an
// end then start within 1 s with no real release in the raw frames between (no 2 frames ≥ 0.65 and
// < 300 ms at ≥ 0.40 since the last re-confirmed pinch). Leave-one-out picked these values in 3 of
// 4 folds; held-out splits were 0 in all 4 folds. See the replay test for per-file counts.
/**
 * During a dropout the pinch point keeps moving with the last palm velocity, decaying with this
 * time constant: displacement = v·τ·(1 − e^(−t/τ)), at most v·τ. Keeps the cloth following instead
 * of freezing, without flinging it far if the hand actually stopped. [heuristic]
 */
export const EXTRAPOLATION_TAU_MS = 100;
/** Time constant (ms) of the palm velocity estimate used for prediction and extrapolation. */
export const VELOCITY_TAU_MS = 50;

// ---------- Track association (identity by spatial continuity) ----------
/**
 * Minimum association gate around the predicted palm position (image heights). Binds only beyond
 * ~1.1 m (where 1.5 hand sizes < 0.12); in the 0.5–1 m range the hand-size term dominates.
 */
export const GATE_MIN = 0.12;
/**
 * Gate in multiples of the hand's own size (wrist→middle MCP), so it scales with distance:
 * ~0.34 image heights at 0.5 m, ~0.17 at 1 m. Two hands held apart (~30 cm between palms) stay
 * separate: ~0.76 image heights at 0.5 m, ~0.38 at 1 m. [heuristic]
 */
export const GATE_HAND_SCALES = 1.5;
/** Extra gate per (image height/s × s since last seen): prediction error grows with speed·gap. */
export const GATE_SPEED_FACTOR = 0.5;
/**
 * Second-chance gate (image heights) for a detection that matched no track, against a track that
 * matched no detection. Re-acquires a hand after a big unpredicted jump instead of ending the grab
 * and starting a new one. 0.5 image heights ≈ 20 cm at 0.5 m, 40 cm at 1 m. [heuristic]
 */
export const RECOVERY_GATE = 0.5;
/**
 * Two detections whose palms are closer than this many hand sizes are one hand (keep the best).
 * Measured in the one-hand recordings: MediaPipe's duplicate detections of the same hand had palm
 * separations of 0.33–0.81 hand sizes (same or opposite label); 0.5 missed most of them and a
 * duplicate stole a pinch from its track. The only distinct detection was 5.5 hand sizes away.
 * Cost: two real hands closer than ~1 hand length are merged (rare when pulling cloth).
 */
export const DUPLICATE_HAND_SCALES = 1.2;
/** At most this many tracks exist (MediaPipe numHands ≤ 2; also only two labels exist). */
export const MAX_TRACKS = 2;
/**
 * At most this many hands may grab at once. 1 (default): while one hand grabs, another hand cannot
 * start a grab. In recording 04-12-10 the user's other hand, resting curled near the keyboard,
 * started a false grab while the main hand was dragging. (A palm-near-the-border guard was tried
 * instead and rejected: it delayed a real grab by 1.2 s because that user drags low in the frame.)
 * Set 2 to allow two-handed pulling.
 */
export const MAX_CONCURRENT_GRABS = 1;
/**
 * A grab may only START while the palm's speed stayed below this (image heights/s; ≈ 0.4 m/s at
 * 0.5 m, 0.8 m/s at 1 m) over the last START_SPEED_WINDOW_MS. People aim, then close; a waving hand
 * passes through closed shapes in motion. Labelled 2026-11-12: true starts had a 300 ms max palm
 * speed of 0.06–0.49 (one 1.20); wave-point false grabs 1.18, 1.98, 2.20. The start is deferred,
 * not cancelled: a hand that stays closed grabs as soon as it slows. [provisional]
 */
export const START_MAX_SPEED = 1.0;
export const START_SPEED_WINDOW_MS = 300;

// ---------- Dwell-to-confirm for ambiguous grips ----------
// When the index hides the thumb, MediaPipe's world landmarks report thumb-index contact whether or
// not it exists (05-09-00: the user was NOT grabbing at 1.5–2.7 s and 24.3–25.5 s, yet the
// features looked like a pinch; no single feature separates them). Contact is then treated as
// unobservable: grip.ts marks the grip 'ambiguous' and the grab starts only after a still dwell.
// Observable grips ('clear': visible thumb contact or a tight fist) keep the fast path.
/**
 * Extra closed-and-still time (ms) an ambiguous grip needs before it grabs. Leave-one-out over 20
 * recordings: the reviewed false grabs in 05-09-00 were held still for ~1.2 s, so shorter dwells
 * let them through (400 ms: 2 negative-span grabs + 4 false grabs; 1200 ms: 0 + 1; 1400 ms: 0 + 0).
 * 1400 is the shortest with zero; no labelled real grab needed the dwell path (all were 'clear').
 */
export const DWELL_MS = 1400;
/** The dwell only accumulates while the palm is slower than this (image heights/s). */
export const DWELL_MAX_SPEED = 0.5;
/** While not closed (or too fast) the hold time decays at this multiple of real time (smooth). */
export const DWELL_DECAY = 2;
/** Consecutive closed 'clear' frames needed for the fast path (wave-point had isolated ones). */
export const CLEAR_MIN_FRAMES = 2;
/** Nominal frame time (ms, 30 fps) used to express enterFrames as time in the progress value. */
export const NOMINAL_FRAME_MS = 1000 / 30;
/** Time constant (ms) smoothing the displayed grabProgress, so it never jumps or flickers. */
export const PROGRESS_TAU_MS = 50;

// ---------- Sticky handedness ----------
/**
 * Time constant (ms) of the per-track handedness evidence, an EMA of ±(2·score−1) votes
 * (+ = right). A burst of wrong labels shorter than ~200 ms barely moves it. [heuristic]
 */
export const LABEL_EVIDENCE_TAU_MS = 200;
/** The opposite label must lead by this much evidence (0..1)... */
export const LABEL_SWITCH_MARGIN = 0.3;
/** ...continuously for this long (ms) before the track's label switches. Never while pinching. */
export const LABEL_SWITCH_HOLD_MS = 400;

// ---------- Filtering (One Euro; units are image heights per second) ----------
/**
 * Pinch point. minCutoff 1 Hz / beta 5: real-hand test reported no jitter at rest with these.
 * At 1 image-height/s the cutoff rises to ~6 Hz (lag < ~30 ms). [heuristic; tune in lab]
 */
export const POINT_ONE_EURO: OneEuroParams = { minCutoff: 1.0, beta: 5.0, dCutoff: 1.0 };
/** All 21 landmarks for display (HandFrame). Same as the pinch point. [heuristic] */
export const LANDMARK_ONE_EURO: OneEuroParams = { minCutoff: 1.0, beta: 5.0, dCutoff: 1.0 };
/** Hand distance (m). Size-from-depth is noisy (1 px of an ~80 px palm ≈ 1.2 cm at 1 m). */
export const DEPTH_ONE_EURO: OneEuroParams = { minCutoff: 0.5, beta: 1.0, dCutoff: 1.0 };

// ---------- Depth from apparent hand size (pinhole model) ----------
/**
 * Assumed field of view along the sensor's LONG side, degrees. Typical laptop webcams quote ~78°
 * diagonal; for 16:9 that is ≈ 70° horizontal. Not measured for the demo camera. An error here
 * scales depthDelta by a constant factor (no drift).
 */
export const ASSUMED_CAMERA_FOV_LONG_SIDE_DEG = 70;
/**
 * Assumed wrist→middle-finger-MCP distance (landmarks 0→9) of an adult hand, metres. Palm length is
 * ~10 cm on average; MediaPipe's wrist point sits distal of the crease. Scales depthDelta.
 * [UNVERIFIED anthropometric approximation]
 */
export const ASSUMED_HAND_SCALE_M = 0.09;

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export interface PinchTuning {
  enterRatio: number;
  exitRatio: number;
  enterFrames: number;
  openRatio: number;
  openReleaseWeight: number;
  releaseMs: number;
  releaseMaxStepMs: number;
  releaseSlowSpeed: number;
  releaseFastSpeed: number;
  fastExitRatioBonus: number;
  fastReleaseExtraMs: number;
  graceMs: number;
  extrapolationTauMs: number;
  velocityTauMs: number;
  gateMin: number;
  gateHandScales: number;
  gateSpeedFactor: number;
  recoveryGate: number;
  duplicateHandScales: number;
  maxConcurrentGrabs: 1 | 2;
  startMaxSpeed: number;
  dwellMs: number;
  dwellMaxSpeed: number;
  dwellDecay: number;
  clearMinFrames: number;
  labelEvidenceTauMs: number;
  labelSwitchMargin: number;
  labelSwitchHoldMs: number;
  pointFilter: OneEuroParams;
  landmarkFilter: OneEuroParams;
  depthFilter: OneEuroParams;
  /** Mirror x so the on-screen cursor moves like a mirror image of the user. */
  mirrored: boolean;
  cameraFovDeg: number;
  handScaleM: number;
  /** Grip classifier parameters (grip.ts). PROVISIONAL until fitted on labelled recordings. */
  grabModel: GrabModel;
}

export const DEFAULT_PINCH_TUNING: Readonly<PinchTuning> = Object.freeze({
  enterRatio: PINCH_ENTER_RATIO,
  exitRatio: PINCH_EXIT_RATIO,
  enterFrames: PINCH_ENTER_FRAMES,
  openRatio: PINCH_OPEN_RATIO,
  openReleaseWeight: OPEN_RELEASE_WEIGHT,
  releaseMs: RELEASE_MS,
  releaseMaxStepMs: RELEASE_MAX_STEP_MS,
  releaseSlowSpeed: RELEASE_SLOW_SPEED,
  releaseFastSpeed: RELEASE_FAST_SPEED,
  fastExitRatioBonus: FAST_EXIT_RATIO_BONUS,
  fastReleaseExtraMs: FAST_RELEASE_EXTRA_MS,
  graceMs: GRACE_MS,
  extrapolationTauMs: EXTRAPOLATION_TAU_MS,
  velocityTauMs: VELOCITY_TAU_MS,
  gateMin: GATE_MIN,
  gateHandScales: GATE_HAND_SCALES,
  gateSpeedFactor: GATE_SPEED_FACTOR,
  recoveryGate: RECOVERY_GATE,
  duplicateHandScales: DUPLICATE_HAND_SCALES,
  maxConcurrentGrabs: MAX_CONCURRENT_GRABS,
  startMaxSpeed: START_MAX_SPEED,
  dwellMs: DWELL_MS,
  dwellMaxSpeed: DWELL_MAX_SPEED,
  dwellDecay: DWELL_DECAY,
  clearMinFrames: CLEAR_MIN_FRAMES,
  labelEvidenceTauMs: LABEL_EVIDENCE_TAU_MS,
  labelSwitchMargin: LABEL_SWITCH_MARGIN,
  labelSwitchHoldMs: LABEL_SWITCH_HOLD_MS,
  pointFilter: POINT_ONE_EURO,
  landmarkFilter: LANDMARK_ONE_EURO,
  depthFilter: DEPTH_ONE_EURO,
  mirrored: true,
  cameraFovDeg: ASSUMED_CAMERA_FOV_LONG_SIDE_DEG,
  handScaleM: ASSUMED_HAND_SCALE_M,
  grabModel: DEFAULT_GRAB_MODEL,
});

export function validatePinchTuning(t: PinchTuning): void {
  const fail = (msg: string) => {
    throw new RangeError(`Invalid pinch tuning: ${msg}`);
  };
  const nonNeg = (v: number) => Number.isFinite(v) && v >= 0;
  const pos = (v: number) => Number.isFinite(v) && v > 0;
  if (!pos(t.enterRatio)) fail('enterRatio must be > 0.');
  if (!(pos(t.exitRatio) && t.exitRatio > t.enterRatio))
    fail('exitRatio must be greater than enterRatio (hysteresis).');
  if (!Number.isInteger(t.enterFrames) || t.enterFrames < 1) fail('enterFrames must be int >= 1.');
  if (!(pos(t.openRatio) && t.openRatio >= t.exitRatio)) fail('openRatio must be >= exitRatio.');
  if (!(Number.isFinite(t.openReleaseWeight) && t.openReleaseWeight >= 1))
    fail('openReleaseWeight must be >= 1.');
  if (!pos(t.releaseMs)) fail('releaseMs must be > 0.');
  if (!pos(t.releaseMaxStepMs)) fail('releaseMaxStepMs must be > 0.');
  if (!nonNeg(t.fastReleaseExtraMs)) fail('fastReleaseExtraMs must be >= 0.');
  if (!(nonNeg(t.releaseSlowSpeed) && t.releaseFastSpeed > t.releaseSlowSpeed))
    fail('releaseFastSpeed must exceed releaseSlowSpeed >= 0.');
  if (!nonNeg(t.fastExitRatioBonus)) fail('fastExitRatioBonus must be >= 0.');
  if (!nonNeg(t.graceMs)) fail('graceMs must be >= 0.');
  if (!pos(t.extrapolationTauMs)) fail('extrapolationTauMs must be > 0.');
  if (!pos(t.velocityTauMs)) fail('velocityTauMs must be > 0.');
  if (!pos(t.gateMin) || !nonNeg(t.gateHandScales) || !nonNeg(t.gateSpeedFactor))
    fail('gates must be positive.');
  if (!nonNeg(t.recoveryGate)) fail('recoveryGate must be >= 0.');
  if (!nonNeg(t.duplicateHandScales)) fail('duplicateHandScales must be >= 0.');
  if (t.maxConcurrentGrabs !== 1 && t.maxConcurrentGrabs !== 2)
    fail('maxConcurrentGrabs must be 1 or 2.');
  if (!pos(t.startMaxSpeed)) fail('startMaxSpeed must be > 0.');
  if (!nonNeg(t.dwellMs)) fail('dwellMs must be >= 0.');
  if (!pos(t.dwellMaxSpeed)) fail('dwellMaxSpeed must be > 0.');
  if (!pos(t.dwellDecay)) fail('dwellDecay must be > 0.');
  if (!Number.isInteger(t.clearMinFrames) || t.clearMinFrames < 1)
    fail('clearMinFrames must be int >= 1.');
  if (!pos(t.labelEvidenceTauMs)) fail('labelEvidenceTauMs must be > 0.');
  if (!(t.labelSwitchMargin >= 0 && t.labelSwitchMargin < 1))
    fail('labelSwitchMargin must be in [0, 1).');
  if (!nonNeg(t.labelSwitchHoldMs)) fail('labelSwitchHoldMs must be >= 0.');
  if (!(t.cameraFovDeg > 10 && t.cameraFovDeg < 170)) fail('cameraFovDeg must be in (10, 170).');
  if (!(t.handScaleM > 0.03 && t.handScaleM < 0.2)) fail('handScaleM must be in (0.03, 0.2) m.');
  validateOneEuroParams(t.pointFilter);
  validateOneEuroParams(t.landmarkFilter);
  validateOneEuroParams(t.depthFilter);
  validateGrabModel(t.grabModel);
}

// ---------- Pure geometry ----------
type Vec2 = [number, number];

export function distance3(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * MediaPipe normalised landmarks use x ∈ [0,1] of the image WIDTH, y ∈ [0,1] of the HEIGHT and z
 * on "roughly the same scale as x". Converting to image-height units (x·aspect, y, z·aspect) makes
 * distances isotropic, so a pinch reads the same horizontally and vertically on a 16:9 frame.
 */
export function toIsotropic(lm: Landmark, aspect: number): Landmark {
  return { x: lm.x * aspect, y: lm.y, z: lm.z * aspect };
}

/**
 * Normalised pinch distance |lm4 − lm8| / |lm0 − lm9|. Points must be isotropic (image-height
 * units, or MediaPipe world landmarks in metres). Scale-invariant. Returns Infinity for a
 * degenerate (zero-size) hand, which reads as "not pinching".
 */
export function pinchRatio(points: readonly Landmark[]): number {
  const scale = distance3(points[LM_WRIST], points[LM_MIDDLE_MCP]);
  if (!(scale > 0)) return Infinity;
  return distance3(points[LM_THUMB_TIP], points[LM_INDEX_TIP]) / scale;
}

/**
 * Normalised image coords (0..1, y down) -> NDC (-1..1, +y up). Mirrored: x is flipped so moving
 * the hand to the user's right moves the cursor right, like a mirror.
 */
export function normalizedToNdc(x: number, y: number, mirrored: boolean): NdcPoint {
  return { x: (mirrored ? 1 - x : x) * 2 - 1, y: 1 - y * 2 };
}

/** Pinhole focal length in image-height units, FOV taken along the sensor's long side. */
export function focalLengthImageHeights(aspect: number, fovLongSideDeg: number): number {
  const longSide = Math.max(aspect, 1);
  return longSide / 2 / Math.tan(((fovLongSideDeg / 2) * Math.PI) / 180);
}

/**
 * Hand-to-camera distance in metres from apparent size: D = f · S_real / s_image, using the 3D
 * isotropic wrist→middle-MCP length. Absolute value depends on the FOV and hand-size assumptions;
 * use it for deltas.
 */
export function estimateHandDistanceM(
  iso: readonly Landmark[],
  aspect: number,
  fovLongSideDeg: number = ASSUMED_CAMERA_FOV_LONG_SIDE_DEG,
  handScaleM: number = ASSUMED_HAND_SCALE_M,
): number {
  const s = distance3(iso[LM_WRIST], iso[LM_MIDDLE_MCP]);
  if (!(s > 0)) return Infinity;
  return (focalLengthImageHeights(aspect, fovLongSideDeg) * handScaleM) / s;
}

/** Damped constant-velocity displacement after `dtMs`: v·τ·(1 − e^(−dt/τ)), per axis. */
export function dampedDisplacement(velocity: Vec2, dtMs: number, tauMs: number): Vec2 {
  if (!(dtMs > 0)) return [0, 0];
  const k = (tauMs / 1000) * (1 - Math.exp(-dtMs / tauMs));
  return [velocity[0] * k, velocity[1] * k];
}

/** Linear 0..1 position of `speed` between slow and fast (clamped). */
export function fastness(speed: number, slow: number, fast: number): number {
  return Math.min(1, Math.max(0, (speed - slow) / (fast - slow)));
}

function palmCentre(iso: readonly Landmark[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const i of PALM_LANDMARKS) {
    x += iso[i].x;
    y += iso[i].y;
  }
  return [x / PALM_LANDMARKS.length, y / PALM_LANDMARKS.length];
}

const dist2 = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const other = (h: Handedness): Handedness => (h === 'left' ? 'right' : 'left');

// ---------- Tracker types ----------
export interface HandObservation {
  /** MediaPipe's handedness label for the subject's hand (after any swap by the caller). */
  hand: Handedness;
  /** Handedness classification score 0..1 (the only per-hand confidence MediaPipe exposes). */
  score: number;
  /** 21 normalised image landmarks of the UNMIRRORED frame. */
  landmarks: readonly Landmark[];
  /** Optional 21 metric world landmarks; if present the pinch ratio is computed from them. */
  worldLandmarks?: readonly Landmark[];
}

export type TrackedHand = HandFrame['hands'][number] & {
  /** Stable id of the physical hand track (survives label flips). */
  trackId: number;
  /** Filtered pinch point, NDC. */
  pinchNdc: NdcPoint;
  /** Unfiltered pinch point for this frame, NDC (lab jitter comparison). */
  rawPinchNdc: NdcPoint;
  /** Filtered hand distance estimate, metres (assumption-dependent; see constants). */
  distanceM: number;
  /** Handedness score of this frame's detection. */
  confidence: number;
  /** MediaPipe's raw label this frame (the track's `hand` is the smoothed one). */
  rawLabel: Handedness;
  /** Smoothed label evidence −1 (left) .. +1 (right). */
  labelEvidence: number;
  /** Palm speed, image heights per second. */
  speed: number;
  /** Grip openness on the tip-ratio scale (grip.ts): < enter = closed grip, > open = clearly open. */
  openness: number;
  /** Grip hypothesis closest to closed this frame. */
  grip: GripType;
  /**
   * 0..1 progress toward a grab (1 while grabbing), smoothed: draw it as a filling ring. Rises in
   * ~enterFrames for a clear grip, over the extra dwell for an ambiguous one; decays smoothly when
   * the hand opens or moves fast.
   */
  grabProgress: number;
  /** 'clear' (fast grab) or 'ambiguous' (dwell); while grabbing, the class the grab started with. */
  gripConfidence: GripConfidence;
};

/**
 * PinchEvent plus the grip type. Proposed for types.ts as an optional `grip?` field; until then
 * the extra property travels at runtime and is typed here.
 */
export type GrabEvent = PinchEvent & { grip: GripType; gripConfidence: GripConfidence };

export interface TrackedHandFrame extends HandFrame {
  hands: TrackedHand[];
  /** Pinching hands not detected this frame whose point was extrapolated (dropout grace). */
  extrapolated: Handedness[];
}

export interface PinchUpdate {
  events: GrabEvent[];
  frame: TrackedHandFrame;
}

interface EmittedPayload {
  ndc: NdcPoint;
  depthDelta: number;
  confidence: number;
}

interface Track {
  id: number;
  label: Handedness;
  labelEvidence: number;
  labelSwitchSince: number | undefined;
  phase: 'idle' | 'pinching';
  enterCount: number;
  /** Accumulated time (ms, weighted) with the ratio above the exit ratio; see RELEASE_MS. */
  releaseEvidenceMs: number;
  /** lastSeenMs before the current frame (for per-frame time steps). */
  prevSeenMs: number;
  lastSeenMs: number;
  palm: Vec2;
  palmVel: Vec2;
  /** |wrist − middle MCP| in image heights. */
  handScale: number;
  /** Raw pinch point used last time the hand was observed (image heights). */
  lastRawPoint: Vec2;
  /** Grab point in the hand-local frame (grip.ts handFrame2d), fixed for the whole grab. */
  anchorLocal: Vec2;
  /** Recent [frameTime, palm speed] samples (START_SPEED_WINDOW_MS) for the start gate. */
  recentSpeeds: Array<[number, number]>;
  /** Grip type of the last observed frame. */
  grip: GripType;
  /** Closed-and-slow time (ms) toward the dwell; decays smoothly (DWELL_DECAY) otherwise. */
  holdMs: number;
  /** Consecutive closed frames classified 'clear'. */
  clearRun: number;
  /** Smoothed grabProgress. */
  progress: number;
  /** Confidence of the current frame (idle) or of the grab start (grabbing). */
  gripConfidence: GripConfidence;
  pointFilter: OneEuroVecFilter;
  depthFilter: OneEuroFilter;
  landmarkFilters: OneEuroVecFilter[];
  startDistanceM: number;
  emitted: EmittedPayload;
}

interface Detection {
  obs: HandObservation;
  iso: Landmark[];
  palm: Vec2;
  handScale: number;
}

function checkLandmarks(points: readonly Landmark[], what: string): void {
  if (points.length !== HAND_LANDMARK_COUNT)
    throw new RangeError(
      `${what}: expected ${HAND_LANDMARK_COUNT} landmarks, got ${points.length}.`,
    );
}

/**
 * Multi-hand pinch tracker. Call update() once per inference frame with every detected hand (an
 * empty list when none). Per frame, each track emits at most one event; lost tracks first, then
 * tracks in ascending id order.
 */
export class PinchTracker {
  private cfg: PinchTuning;
  private tracks: Track[] = [];
  private nextId = 1;

  constructor(tuning: Partial<PinchTuning> = {}) {
    this.cfg = { ...DEFAULT_PINCH_TUNING, ...tuning };
    validatePinchTuning(this.cfg);
  }

  tuning(): PinchTuning {
    return { ...this.cfg };
  }

  setTuning(partial: Partial<PinchTuning>): void {
    const next = { ...this.cfg, ...partial };
    validatePinchTuning(next);
    this.cfg = next;
    for (const t of this.tracks) {
      t.pointFilter.setParams(next.pointFilter);
      t.depthFilter.setParams(next.depthFilter);
      for (const f of t.landmarkFilters) f.setParams(next.landmarkFilter);
    }
  }

  /** Hands currently holding a pinch (including ones inside the dropout grace period). */
  pinchingHands(): Handedness[] {
    return this.tracks.filter((t) => t.phase === 'pinching').map((t) => t.label);
  }

  update(frameTime: number, aspect: number, observations: readonly HandObservation[]): PinchUpdate {
    if (!Number.isFinite(frameTime)) throw new RangeError('frameTime must be finite.');
    if (!(aspect > 0 && Number.isFinite(aspect))) throw new RangeError('aspect must be > 0.');
    const cfg = this.cfg;
    const events: GrabEvent[] = [];
    const hands: TrackedHand[] = [];
    const extrapolated: Handedness[] = [];

    const detections = this.prepareDetections(observations, aspect);
    const matches = this.associate(detections, frameTime);

    // 1) Unmatched tracks: grace with damped extrapolation, then end.
    for (const t of [...this.tracks]) {
      if (matches.has(t)) continue;
      const missingMs = frameTime - t.lastSeenMs;
      t.enterCount = 0; // a pinch must be confirmed on consecutive *visible* frames
      if (missingMs > cfg.graceMs) {
        if (t.phase === 'pinching') events.push(this.event('end', t, frameTime, t.emitted));
        this.removeTrack(t);
      } else if (t.phase === 'pinching') {
        const d = dampedDisplacement(t.palmVel, missingMs, cfg.extrapolationTauMs);
        const raw: Vec2 = [t.lastRawPoint[0] + d[0], t.lastRawPoint[1] + d[1]];
        const [fu, fv] = t.pointFilter.filter(raw, frameTime);
        t.emitted = { ...t.emitted, ndc: normalizedToNdc(fu / aspect, fv, cfg.mirrored) };
        events.push(this.event('move', t, frameTime, t.emitted));
        extrapolated.push(t.label);
      }
    }

    // 2) New tracks for unmatched detections (evicting stale tracks if over capacity).
    for (const det of detections) {
      if ([...matches.values()].includes(det)) continue;
      if (this.tracks.length >= MAX_TRACKS) {
        const stale = this.tracks
          .filter((t) => !matches.has(t))
          .sort((a, b) => a.lastSeenMs - b.lastSeenMs)[0];
        if (!stale) continue; // both tracks matched: an extra detection cannot be a third hand
        if (stale.phase === 'pinching')
          events.push(this.event('end', stale, frameTime, stale.emitted));
        this.removeTrack(stale);
      }
      const t = this.createTrack(det, frameTime);
      this.tracks.push(t);
      matches.set(t, det);
    }

    // 3) Update matched tracks: motion, handedness.
    for (const [t, det] of matches) this.updateMotionAndLabel(t, det, frameTime);
    this.enforceUniqueLabels(matches);

    // 4) Pinch state machine for observed tracks.
    const observed = [...matches.entries()].sort((a, b) => a[0].id - b[0].id);
    for (const [t, det] of observed) {
      const { obs, iso } = det;
      const features = gripFeatures(obs.worldLandmarks ?? iso, iso);
      const signal = grabSignal(features, cfg.grabModel);
      // Every threshold below (enter/exit/open "ratio") applies to this tip-ratio-scale openness.
      const ratio = signal.openness;
      t.grip = signal.grip;
      const speed = Math.hypot(t.palmVel[0], t.palmVel[1]);
      t.recentSpeeds.push([frameTime, speed]);
      while (t.recentSpeeds.length && frameTime - t.recentSpeeds[0][0] > START_SPEED_WINDOW_MS)
        t.recentSpeeds.shift();
      const f = fastness(speed, cfg.releaseSlowSpeed, cfg.releaseFastSpeed);
      const exitRatio = cfg.exitRatio + f * cfg.fastExitRatioBonus;
      const openRatio = cfg.openRatio + f * cfg.fastExitRatioBonus;
      const releaseMs = cfg.releaseMs + f * cfg.fastReleaseExtraMs;

      // Hover: the natural grip point (thumb tip <-> nearest index point), continuous across grip
      // types. While grabbing: that point frozen in the hand-local frame at grab start, so it
      // follows the rigid hand and never jumps when the grip type, the fingers or blur change.
      const hand2d = handFrame2d(iso);
      const natural = naturalGripPoint(iso);
      const rawPoint: Vec2 =
        t.phase === 'pinching' ? fromHandLocal(t.anchorLocal, hand2d) : natural;
      t.lastRawPoint = rawPoint;
      const [fu, fv] = t.pointFilter.filter(rawPoint, frameTime);
      const ndc = normalizedToNdc(fu / aspect, fv, cfg.mirrored);
      const rawNdc = normalizedToNdc(rawPoint[0] / aspect, rawPoint[1], cfg.mirrored);
      const rawDistance = estimateHandDistanceM(iso, aspect, cfg.cameraFovDeg, cfg.handScaleM);
      const distanceM = Number.isFinite(rawDistance)
        ? t.depthFilter.filter(rawDistance, frameTime)
        : (t.depthFilter.value ?? rawDistance);
      const landmarks = iso.map((p, i) => {
        const [x, y, z] = t.landmarkFilters[i].filter([p.x, p.y, p.z], frameTime);
        const n = normalizedToNdc(x / aspect, y, cfg.mirrored);
        // z: MediaPipe relative depth (wrist = 0, smaller = closer), in its native x-scale.
        return { x: n.x, y: n.y, z: z / aspect };
      });
      const depthDelta = Number.isFinite(distanceM) ? t.startDistanceM - distanceM : 0;

      const stepMs = Math.min(cfg.releaseMaxStepMs, Math.max(0, frameTime - t.prevSeenMs));
      let progressTarget = 1;
      if (t.phase === 'idle') {
        t.releaseEvidenceMs = 0;
        const closedNow = ratio < cfg.enterRatio;
        t.enterCount = closedNow ? t.enterCount + 1 : 0;
        t.clearRun = closedNow && signal.confidence === 'clear' ? t.clearRun + 1 : 0;
        t.gripConfidence = signal.confidence;
        if (closedNow && speed <= cfg.dwellMaxSpeed) t.holdMs += stepMs;
        else t.holdMs = Math.max(0, t.holdMs - stepMs * cfg.dwellDecay);
        const baseMs = cfg.enterFrames * NOMINAL_FRAME_MS;
        const otherGrabs = this.tracks.filter((o) => o !== t && o.phase === 'pinching').length;
        const gates =
          t.enterCount >= cfg.enterFrames &&
          otherGrabs < cfg.maxConcurrentGrabs &&
          Math.max(...t.recentSpeeds.map(([, v]) => v)) <= cfg.startMaxSpeed &&
          Number.isFinite(distanceM);
        const fast = t.clearRun >= cfg.clearMinFrames;
        const dwelled = t.holdMs >= baseMs + cfg.dwellMs;
        progressTarget = closedNow
          ? Math.min(
              1,
              fast
                ? Math.min(t.enterCount, cfg.enterFrames) / cfg.enterFrames
                : t.holdMs / (baseMs + cfg.dwellMs),
            )
          : Math.min(1, t.holdMs / (baseMs + cfg.dwellMs));
        if (gates && (fast || dwelled)) {
          t.gripConfidence = fast ? 'clear' : 'ambiguous';
          t.holdMs = 0;
          t.clearRun = 0;
          progressTarget = 1;
          t.progress = 1;
          t.phase = 'pinching'; // label is now locked until the pinch ends
          t.labelSwitchSince = undefined;
          t.enterCount = 0;
          t.startDistanceM = distanceM;
          t.anchorLocal = toHandLocal(natural, hand2d);
          t.emitted = { ndc, depthDelta: 0, confidence: obs.score };
          events.push(this.event('start', t, frameTime, t.emitted));
        }
      } else {
        const step = Math.min(cfg.releaseMaxStepMs, Math.max(0, frameTime - t.prevSeenMs));
        // A pending release is cancelled only by a RE-CONFIRMED pinch (enterFrames consecutive
        // clear frames, the same rule that starts one). Isolated pinch-looking frames inside a
        // relaxed release (seen in the recordings) leave the evidence unchanged.
        t.enterCount = ratio < cfg.enterRatio ? t.enterCount + 1 : 0;
        if (t.enterCount >= cfg.enterFrames) t.releaseEvidenceMs = 0;
        else if (ratio > openRatio && signal.extension > openRatio)
          t.releaseEvidenceMs += step * cfg.openReleaseWeight; // decisive: fingers extend too
        else if (ratio > exitRatio) t.releaseEvidenceMs += step;
        t.emitted = { ndc, depthDelta, confidence: obs.score };
        if (t.releaseEvidenceMs >= releaseMs) {
          events.push(this.event('end', t, frameTime, t.emitted));
          t.phase = 'idle';
          t.releaseEvidenceMs = 0;
          t.holdMs = 0;
          t.clearRun = 0;
          progressTarget = 0;
        } else {
          events.push(this.event('move', t, frameTime, t.emitted));
        }
      }
      if (t.phase === 'pinching') t.progress = 1;
      else t.progress += (progressTarget - t.progress) * (1 - Math.exp(-stepMs / PROGRESS_TAU_MS));

      hands.push({
        hand: t.label,
        landmarks,
        pinching: t.phase === 'pinching',
        pinchRatio: features.tipRatio,
        trackId: t.id,
        pinchNdc: ndc,
        rawPinchNdc: rawNdc,
        distanceM,
        confidence: obs.score,
        rawLabel: obs.hand,
        labelEvidence: t.labelEvidence,
        speed,
        openness: ratio,
        grip: signal.grip,
        grabProgress: t.progress,
        gripConfidence: t.gripConfidence,
      });
    }

    return { events, frame: { frameTime, hands, extrapolated } };
  }

  /** Ends every active pinch (e.g. on stop()) so no grab is left dangling. Clears all tracks. */
  endAll(frameTime: number): GrabEvent[] {
    const events = this.tracks
      .filter((t) => t.phase === 'pinching')
      .map((t) => this.event('end', t, frameTime, t.emitted));
    this.tracks = [];
    return events;
  }

  // ---------- internals ----------
  private prepareDetections(observations: readonly HandObservation[], aspect: number) {
    const all: Detection[] = observations.map((obs) => {
      checkLandmarks(obs.landmarks, 'landmarks');
      if (obs.worldLandmarks) checkLandmarks(obs.worldLandmarks, 'worldLandmarks');
      const iso = obs.landmarks.map((l) => toIsotropic(l, aspect));
      return {
        obs,
        iso,
        palm: palmCentre(iso),
        handScale: distance3(iso[LM_WRIST], iso[LM_MIDDLE_MCP]),
      };
    });
    // Merge duplicates: MediaPipe occasionally reports one hand twice.
    all.sort((a, b) => b.obs.score - a.obs.score);
    const kept: Detection[] = [];
    for (const d of all) {
      const dup = kept.some(
        (k) =>
          dist2(k.palm, d.palm) < this.cfg.duplicateHandScales * Math.max(k.handScale, d.handScale),
      );
      if (!dup) kept.push(d);
    }
    return kept;
  }

  private predictedPalm(t: Track, frameTime: number): Vec2 {
    const d = dampedDisplacement(t.palmVel, frameTime - t.lastSeenMs, this.cfg.extrapolationTauMs);
    return [t.palm[0] + d[0], t.palm[1] + d[1]];
  }

  /**
   * Globally optimal assignment (≤ 2 tracks × ≤ 2 detections, brute force): maximise the number of
   * gated matches, then minimise total distance to the predicted palm. Then a second chance with
   * the wider recovery gate for whatever is left.
   */
  private associate(detections: Detection[], frameTime: number): Map<Track, Detection> {
    const cfg = this.cfg;
    const cost = (t: Track, d: Detection, gate: (t: Track) => number) => {
      const dist = dist2(this.predictedPalm(t, frameTime), d.palm);
      return dist <= gate(t) ? dist : Infinity;
    };
    const strictGate = (t: Track) => {
      const speed = Math.hypot(t.palmVel[0], t.palmVel[1]);
      const dt = Math.max(0, frameTime - t.lastSeenMs) / 1000;
      return (
        Math.max(cfg.gateMin, cfg.gateHandScales * t.handScale) + cfg.gateSpeedFactor * speed * dt
      );
    };
    const best = { count: -1, total: Infinity, pairs: [] as Array<[Track, Detection]> };
    const search = (
      i: number,
      used: Set<Track>,
      pairs: Array<[Track, Detection]>,
      total: number,
    ) => {
      if (i === detections.length) {
        if (pairs.length > best.count || (pairs.length === best.count && total < best.total)) {
          best.count = pairs.length;
          best.total = total;
          best.pairs = [...pairs];
        }
        return;
      }
      search(i + 1, used, pairs, total);
      for (const t of this.tracks) {
        if (used.has(t)) continue;
        const c = cost(t, detections[i], strictGate);
        if (!Number.isFinite(c)) continue;
        used.add(t);
        pairs.push([t, detections[i]]);
        search(i + 1, used, pairs, total + c);
        pairs.pop();
        used.delete(t);
      }
    };
    search(0, new Set(), [], 0);
    const matches = new Map<Track, Detection>(best.pairs);

    // Recovery: nearest remaining (track, detection) pairs within the wide gate.
    const usedDets = new Set(matches.values());
    const candidates: Array<[number, Track, Detection]> = [];
    for (const t of this.tracks) {
      if (matches.has(t)) continue;
      for (const d of detections) {
        if (usedDets.has(d)) continue;
        const c = cost(t, d, () => cfg.recoveryGate);
        if (Number.isFinite(c)) candidates.push([c, t, d]);
      }
    }
    candidates.sort((a, b) => a[0] - b[0]);
    for (const [, t, d] of candidates) {
      if (matches.has(t) || usedDets.has(d)) continue;
      matches.set(t, d);
      usedDets.add(d);
    }
    return matches;
  }

  private updateMotionAndLabel(t: Track, det: Detection, frameTime: number): void {
    const cfg = this.cfg;
    const dtMs = frameTime - t.lastSeenMs;
    if (dtMs > 0) {
      const a = 1 - Math.exp(-dtMs / cfg.velocityTauMs);
      const vx = ((det.palm[0] - t.palm[0]) * 1000) / dtMs;
      const vy = ((det.palm[1] - t.palm[1]) * 1000) / dtMs;
      t.palmVel = [t.palmVel[0] + a * (vx - t.palmVel[0]), t.palmVel[1] + a * (vy - t.palmVel[1])];
      const b = 1 - Math.exp(-dtMs / cfg.labelEvidenceTauMs);
      t.labelEvidence += b * (labelVote(det.obs) - t.labelEvidence);
    }
    t.palm = det.palm;
    t.handScale = det.handScale;
    t.prevSeenMs = t.lastSeenMs;
    t.lastSeenMs = frameTime;

    const desired: Handedness = t.labelEvidence >= 0 ? 'right' : 'left';
    if (
      t.phase === 'idle' &&
      desired !== t.label &&
      Math.abs(t.labelEvidence) >= cfg.labelSwitchMargin
    ) {
      t.labelSwitchSince ??= frameTime;
      if (frameTime - t.labelSwitchSince >= cfg.labelSwitchHoldMs) {
        t.label = desired;
        t.labelSwitchSince = undefined;
      }
    } else {
      t.labelSwitchSince = undefined;
    }
  }

  /**
   * Two tracks must not share a label (consumers key grabs by hand). A pinching track keeps its
   * locked label; otherwise an unseen idle track is dropped (it is most likely the same hand,
   * re-acquired as a new track), else the track with weaker evidence for the label yields.
   */
  private enforceUniqueLabels(matches: Map<Track, Detection>): void {
    if (this.tracks.length < 2) return;
    const [a, b] = this.tracks;
    if (a.label !== b.label) return;
    const label = a.label;
    const sign = label === 'right' ? 1 : -1;
    for (const [stale, fresh] of [
      [a, b],
      [b, a],
    ]) {
      if (!matches.has(stale) && stale.phase === 'idle' && matches.has(fresh)) {
        this.removeTrack(stale);
        return;
      }
    }
    let yielder: Track;
    if (a.phase === 'pinching') yielder = b;
    else if (b.phase === 'pinching') yielder = a;
    else yielder = a.labelEvidence * sign < b.labelEvidence * sign ? a : b;
    yielder.label = other(label);
    yielder.labelSwitchSince = undefined;
  }

  private createTrack(det: Detection, frameTime: number): Track {
    const mid = naturalGripPoint(det.iso);
    return {
      id: this.nextId++,
      label: det.obs.hand,
      labelEvidence: labelVote(det.obs),
      labelSwitchSince: undefined,
      phase: 'idle',
      enterCount: 0,
      releaseEvidenceMs: 0,
      prevSeenMs: frameTime,
      lastSeenMs: frameTime,
      palm: det.palm,
      palmVel: [0, 0],
      handScale: det.handScale,
      lastRawPoint: mid,
      anchorLocal: [0, 0],
      grip: 'pinch',
      recentSpeeds: [],
      holdMs: 0,
      clearRun: 0,
      progress: 0,
      gripConfidence: 'clear',
      pointFilter: new OneEuroVecFilter(2, this.cfg.pointFilter),
      depthFilter: new OneEuroFilter(this.cfg.depthFilter),
      landmarkFilters: Array.from(
        { length: HAND_LANDMARK_COUNT },
        () => new OneEuroVecFilter(3, this.cfg.landmarkFilter),
      ),
      startDistanceM: 0,
      emitted: { ndc: { x: 0, y: 0 }, depthDelta: 0, confidence: 0 },
    };
  }

  private removeTrack(t: Track): void {
    this.tracks = this.tracks.filter((x) => x !== t);
  }

  private event(
    type: PinchEvent['type'],
    t: Track,
    frameTime: number,
    p: EmittedPayload,
  ): GrabEvent {
    return {
      type,
      grip: t.grip,
      gripConfidence: t.gripConfidence,
      hand: t.label,
      ndc: { ...p.ndc },
      depthDelta: p.depthDelta,
      frameTime,
      confidence: p.confidence,
    };
  }
}

/** Handedness vote in [-1, 1]: + right, − left, weighted by how far the score is above chance. */
function labelVote(obs: HandObservation): number {
  const w = Math.min(1, Math.max(0, 2 * obs.score - 1));
  return obs.hand === 'right' ? w : -w;
}
