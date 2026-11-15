// AR overlay constants (agent V2, prompt 14). Every number that changes what the overlay shows or
// how its alignment is judged lives here, with its source. "Heuristic" means chosen by reasoning,
// not calibrated against ground truth; the evaluation (docs/STATUS-tryon-ar.md) reports how they
// behave on the user's videos.
import type { JointName } from '@satisfy/vision';

/**
 * MediaPipe BlazePose landmark index for each posed joint the camera solve can use. The eyes
 * (rig eye.L / eye.R bone heads ↔ MediaPipe 2 / 5) tie the jacket to the FACE: the ≈ 6.3 cm eye
 * spacing is a stable metric scale at kiosk framing (head to hips), and they fix the vertical
 * relation collar ↔ chin (live test: "the collar sits too high"; facing frames had the collar top
 * 0–34 px above the mouth line on the parka video, 36–89 px on the puffer, with the shoulders
 * aligned).
 */
export const LANDMARK_OF_JOINT: Record<string, number> = {
  lEye: 2,
  rEye: 5,
  lShoulder: 11,
  rShoulder: 12,
  lElbow: 13,
  rElbow: 14,
  lWrist: 15,
  rWrist: 16,
  lHip: 23,
  rHip: 24,
  lKnee: 25,
  rKnee: 26,
  lAnkle: 27,
  rAnkle: 28,
};

/**
 * Relative weight of each joint in the camera solve. Heuristic: the torso landmarks are the most
 * stable in MediaPipe and carry the jacket; distal landmarks are noisier (motion blur, small) and
 * the legs are not covered by a jacket.
 */
export const SOLVE_WEIGHT: Record<string, number> = {
  // Eyes: a scale helper only. At 0.8 they pulled the torso off the shoulder landmarks when the
  // rig's head-to-shoulder proportion differs from the person's (replay of the user's live
  // recording: facing alignment 0.85 -> 0.59). The collar height is set by the chin target.
  lEye: 0.3,
  rEye: 0.3,
  // The vertical anchor is the shoulder line (live test: "the collar sits too high").
  lShoulder: 1.6,
  rShoulder: 1.6,
  lHip: 1,
  rHip: 1,
  lElbow: 0.7,
  rElbow: 0.7,
  lWrist: 0.5,
  rWrist: 0.5,
  lKnee: 0.4,
  rKnee: 0.4,
  lAnkle: 0.25,
  rAnkle: 0.25,
};

/**
 * The 3D point matched to MediaPipe's shoulder landmark (11/12): the rig's upper-arm joint moved
 * toward the posed ACROMION (body vertex nearest the asset body's acromion landmark) by this
 * fraction. The rig's upperarm01 joint is 4.4 cm below the acromion (agent CH, 2026-11-13), while
 * MediaPipe's shoulder sits on the shoulder's top outline, higher still on a bulky jacket: matched
 * to the joint, the solve drew the whole body (and the collar) several cm too high.
 * 0.75, measured (lab A/B, fresh page loads, 2026-11-13; face offset = rig eyes vs real eyes, − = rig
 * drawn too high; collar = parka collar top vs chin before any target):
 *   cam-parka facing 1.5–4 s   blend 0 / 0.5 / 0.75 / 1: alignment 0.71 / 0.76 / 0.76 / 0.76, face
 *     −1.6 / −0.7 / −0.4 / +0.1 cm, collar −3.1 / −1.7 / −0.7 / +0.4 cm, post-glue residual
 *     0.6 / 0.4 / 0.6 / 1.7 px; blend 1 binds the glue's scale cap on almost every frame.
 *   cam-tshirt 1–4.5 s   blend 0 / 0.75 / 1: alignment 0.41 / 0.53 / 0.45, residual 4.8 / 2.3 / 0.6 px.
 *   puffer phone video 4–6 s at 0.75: face offset +0.1 ± 1.0 cm.
 */
export const SHOULDER_MARK_BLEND = 0.75;

/**
 * Correspondences NOT scaled by the session's lateral landmark spread: that spread models where
 * MediaPipe puts shoulders and hips relative to the rig's joint centres; the eyes have no such gap.
 */
export const UNSCALED_JOINTS: ReadonlySet<string> = new Set(['lEye', 'rEye']);

/** The landmarks whose reprojection error defines `alignment` (prompt 14 V2 §3). */
export const ALIGNMENT_JOINTS: readonly JointName[] = [
  'lShoulder',
  'rShoulder',
  'lElbow',
  'rElbow',
  'lWrist',
  'rWrist',
  'lHip',
  'rHip',
];

/** A landmark below this MediaPipe visibility is not used (MediaPipe's own 0.5 convention). */
export const MIN_VISIBILITY = 0.5;
/** Fewer usable correspondences than this: no solve, alignment unknown. 4 points = 8 residuals. */
export const MIN_POINTS = 4;

/**
 * Focal-length prior, as a DIAGONAL field of view. A laptop "Integrated Camera" is typically
 * 70–80° diagonal; a phone main camera is 26 mm equivalent (≈ 79° diagonal on the 4:3 sensor,
 * ≈ 70–75° after the 16:9 video crop and stabilisation margin). One prior covers both.
 */
export const FOV_PRIOR_DIAGONAL_DEG = 75;
/**
 * ?f1fov=<deg> (agent F1, lead 19:35 Camo check) pins the diagonal FOV; values outside this range
 * are ignored. Why pin: on the camo-1 and venue replays the keyframe fit (a rig built from each
 * frame's MediaPipe world landmarks, as the posed rig is) needed 24-32 s to leave the prior and
 * then drifted to 54-57° diagonal from a 75° prior (62° from 90°, 51° from 60°): it follows the
 * prior and MediaPipe's flattened depth, not the lens. The Camo iPhone 1× at 16:9 is about
 * 75-80° (24 mm equivalent on the 4:3 sensor = 84° diagonal, 72° horizontal; the 16:9 video crop
 * with the stabilisation margin ≈ 66-68° horizontal ≈ 75-77° diagonal).
 */
export const FIXED_FOV_RANGE_DEG: readonly [number, number] = [30, 120];
/** 1σ of the prior on ln(f): 0.15 ≈ ±15 % focal ≈ ±8° of diagonal FOV around 75°. */
export const FOV_PRIOR_LOG_SIGMA = 0.15;
/** Landmark noise used to weigh priors against pixels (1σ, px at 720 px short side). Heuristic. */
export const LANDMARK_SIGMA_PX = 6;
/** Pseudo-Huber knee: a landmark further off than this many σ counts linearly, not squared. */
export const ROBUST_KNEE_SIGMAS = 2.5;

/** Per-frame camera pitch and roll stay near the session estimate (fixed camera). 1σ, degrees. */
export const PITCH_ROLL_SIGMA_DEG = 2;
/**
 * Before a focal fit, the session tilt follows the per-frame solves with this time constant (s):
 * a fixed camera's pitch and roll do not change, so they are learned slowly, not per frame.
 */
export const SESSION_TILT_TAU_S = 2;
/** Prior on the session pitch / roll before any estimate exists (level camera). 1σ, degrees. */
export const PITCH_ROLL_INITIAL_SIGMA_DEG = 15;
/**
 * ?f1fade=1 (agent F1; lead 17:45 item 5, Anywear A6): tracking loss as a state machine instead of a
 * cut. When the body is lost (no landmarks, too few correspondences, a failed or degenerate solve)
 * the last drawn jacket is held where it was and fades out by at most stepPerFrame per frame; it is
 * dropped after holdMs. When the body comes back, the jacket fades in by stepPerFrame per frame
 * (4 frames: ≤ 0.5 s at ≥ 8 fps). Bar: no single-frame alpha jump > 0.25 (lead), jacket back
 * within 0.5 s of re-entry (venue clip 50–57 s).
 */
export const LOSS = { stepPerFrame: 0.25, holdMs: 1000 } as const;

/**
 * ?f1tilt=1 (agent F1, D9 "rest rotation"). The per-frame 2D solve hardly constrains the camera
 * tilt: the learned session pitch wandered +21 → −1° over the venue clip (F5 window base, case 68),
 * 12.7 → 9.1° inside the still window (head-1335); rest rotation 0.29–0.58° FAIL on all three judge
 * cases. A warm-up with a loose prior made it worse (judge ab1-f1: −28°, 0.78°). Independent
 * evidence says the venue camera is level: MediaPipe's world torso (hips → shoulders) stays within
 * ±7° of upright through the clip and the wall's horizontal slats are level and parallel. With a
 * level prior (σ 3°) and a soft drawn deadband (RC1, 4951b3d) rest rotation passed on the venue
 * (0.29 → 0.000°, 0.58 → 0.044°) but the per-frame pitch still swung −13…+14° with the arms up,
 * crossed or turning (RC1 checkpoints: non-zero on 70 % of frames) - camera pitch absorbing pose
 * mismatch - and cam-still read 0.47° as the pitch left the band at the end of its still window.
 * So with f1tilt the camera is level: the per-frame solve keeps the σ sigmaDeg prior around level
 * and the DRAWN pitch and roll are exactly 0 (the translation re-solve fits the landmarks at that
 * tilt). Never learned, never re-centred by a focal fit. A camera that is really tilted is drawn
 * level (a kiosk or laptop camera is; a phone held at an angle is the known trade-off).
 */
export const TILT = {
  sigmaDeg: 3,
} as const;
/**
 * ?f1close=1 (agent F1; lead U2 19:00, user: "I must stand far from the camera to get the jacket"):
 * close-range framing, head to waist at about 0.8–1 m from a laptop camera, hips and knees out of
 * the frame. The torso is placed and sized from the shoulders (plus the eyes when seen) at the
 * landmark spread learned from full views (hips seen), a bit of the lower body that MediaPipe only
 * extrapolated is not used, and a short MediaPipe loss keeps the jacket drawn.
 *   holdFullMs: a MediaPipe loss shorter than this keeps the last jacket drawn at full opacity
 *     (then ?f1fade's 0.25-per-frame fade). cam-tshirt replay: the loss with the head at the top
 *     edge lasted 140 ms (11.68–11.82 s), the other short ones 1 frame and 190 ms; at the live
 *     camera's 15 fps 300 ms = 4–5 frames.
 *   minDepthM: the nearest drawn pelvis depth (DEPTH_RANGE_M[0] = 0.6 m otherwise, which dropped
 *     a person leaning in to a laptop). At the 75° diagonal prior (960×540: f ≈ 718 px, 68°
 *     horizontal) 0.4 m shoulders fill the frame width at 0.30 m: nearer than 0.35 m no shoulder
 *     line is in the frame.
 *   edgeMarginFrac, lowerMinVisibility: a hip, knee or ankle landmark nearer than edgeMarginFrac ×
 *     frame height to an image edge, or below lowerMinVisibility, is MediaPipe's extrapolation of a
 *     body part out of the frame, not an observation (hips are used as a pair: both or neither).
 *   calibrationHiddenMs: hips hidden this long during the neutral stand (it needs them) ends it at
 *     once with the camera as vertical (the 10 s fallback left the arms unposed at close range).
 *   lowerFadeFrac: a lower-body landmark's solve weight fades in from the edge margin (0) to this
 *     fraction of the frame height from the nearest image edge (full weight), hips by the nearer
 *     of the pair. Live parka replay (user walking in, 65.5–67.4 s): with the hips in the drawn
 *     placement the depth read 1.07 m while the shoulder span, at the spread learned in the full
 *     view, said 0.66–0.85 m (the lean towards the laptop is not in the level-camera pose); when
 *     the hips left the frame the depth switched by 40 % in one frame, the outlier gate held the
 *     wrong size 0.5 s, then the jacket jumped 47 px. Their hips were 20 % of the height from the
 *     bottom at the normal distance (full weight) and 5–11 % on the way in.
 */
export const CLOSE = {
  holdFullMs: 300,
  minDepthM: 0.35,
  edgeMarginFrac: 0.02,
  lowerMinVisibility: 0.5,
  calibrationHiddenMs: 1500,
  lowerFadeFrac: 0.15,
} as const;
/**
 * ?f1glue=1 (agent F1, D9 onset; split from ?f1stab=1 before RC1): the glue target filters with a faster derivative cutoff, so a
 * motion's start raises the One Euro cutoff at once instead of after ~150 ms (dCutoff 1 Hz).
 * Replay of the raw venue landmarks (F1 probe, 8 torso/arm points, pure filter): still window
 * 2.5–5.5 s 0.427 → 0.426 px/frame (torso) and 0.417 → 0.435 (arms); error vs the landmark on
 * moving frames (> 150 px/s) 4.5 → 2.1 px RMS (torso), 2.8 → 1.4 px (arms).
 */
export const F1STAB_GLUE = {
  torso: { minCutoff: 1.0, beta: 0.04, dCutoff: 3 },
  arms: { minCutoff: 0.8, beta: 0.06, dCutoff: 4 },
} as const;

/** Focal estimate: keyframes taken at least this far apart (ms), at most this many kept. */
export const FOCAL_KEYFRAME_SPACING_MS = 250;
export const FOCAL_MAX_KEYFRAMES = 24;
/** Re-estimate the focal length when this many new keyframes arrived (and at 6 to start). */
export const FOCAL_MIN_KEYFRAMES = 6;
export const FOCAL_REFIT_EVERY = 6;
/** A keyframe needs this many usable correspondences (perspective needs depth spread). */
export const FOCAL_KEYFRAME_MIN_POINTS = 6;
/**
 * A keyframe must be well explained by the posed body: its RMS reprojection error at most this
 * fraction of the shoulder width. A frame whose arms are mis-posed would push the focal length
 * to absorb the pose error (seen on the parka video: 1366 px vs ≈ 950 px expected). Heuristic.
 */
export const FOCAL_KEYFRAME_MAX_RMS_FRACTION = 0.05;
/**
 * The focal estimate replaces the prior only when the keyframes constrain it: 1σ of ln f below
 * this (≈ ±8 %). Otherwise the prior stays and the lab says the evidence was too weak.
 */
export const FOCAL_MAX_LOG_SIGMA = 0.08;

/**
 * One Euro smoothing of the solved camera (Casiez et al. 2012; filter in @satisfy/vision).
 * Angles in radians, translation in metres. Heuristic: minCutoff 1.2 Hz keeps a still person
 * still (sub-pixel jitter on synthetic 6 px landmark noise, see ArTracker.test.ts); beta lets a
 * turn (≈ 2 rad/s) or a step (≈ 0.5 m/s) raise the cutoff to ≈ 6–8 Hz, so the overlay keeps up.
 */
export const SMOOTH_ANGLE = { minCutoff: 1.2, beta: 3, dCutoff: 1 };
/**
 * The drawn size follows the body's DEPTH, so depth is held: One Euro at 0.25 Hz (a real step at
 * 0.5 m/s raises it to ≈ 1 Hz) and a backlash deadband: the held depth moves only when the
 * filtered depth leaves ±DEPTH_DEADBAND of it (a sustained step), never on noise.
 */
export const SMOOTH_DEPTH = { minCutoff: 0.25, beta: 1.5, dCutoff: 1 };
export const DEPTH_DEADBAND = 0.02;
/**
 * A single-frame depth jump beyond this fraction is a degenerate solve (side view, shoulders
 * overlapping), not a person walking: ignored unless it persists DEPTH_OUTLIER_PERSIST_MS.
 */
export const DEPTH_OUTLIER = 0.3;
/**
 * A person in front of a kiosk or phone camera is between these depths (m). A solve outside is
 * degenerate (side view, shoulders overlapping) and is not drawn: the last good pose is kept.
 */
export const DEPTH_RANGE_M: readonly [number, number] = [0.6, 6];
/**
 * The guard with the glue on and alignment ≥ COLLAR_GUARD_GLUE_MIN_ALIGNMENT (lead, 18:00): it acts
 * only on gross misregistration (the collar more than `over` cm above the mouth line) and shifts at
 * most `shift` cm; otherwise the collar height is the garment's.
 */
export const COLLAR_GUARD_GLUE_CM = { over: 2, shift: 2 } as const;
export const COLLAR_GUARD_GLUE_MIN_ALIGNMENT = 0.65;
/** The collar guard never moves the jacket by more than this fraction of the frame height. */
export const COLLAR_GUARD_MAX_FRACTION = 0.08;
export const DEPTH_OUTLIER_PERSIST_MS = 500;
/** The pelvis's image position (px), smoothed on its own so a held depth keeps it on the body. */
export const SMOOTH_PIXEL = { minCutoff: 1.0, beta: 0.02, dCutoff: 1 };
/**
 * 2D landmarks are smoothed BEFORE the solve (px; One Euro). 1.5 Hz still, + 0.02 Hz per px/s:
 * a hand moving 500 px/s gets ≈ 11 Hz, so real moves pass and the still jitter does not.
 * Live user test 2026-11-13: "it still jitters".
 */
export const SMOOTH_LANDMARKS = { minCutoff: 1.5, beta: 0.02, dCutoff: 1 };
/**
 * Body yaw (rad). Near facing the camera the yaw is ill-conditioned (the shoulder width changes
 * only with cos yaw), so landmark noise swings it by ±10°+: the user saw the jacket "skewed and
 * rotating back and forth" while facing the camera. Heavy smoothing (0.4 Hz still; a deliberate
 * turn at 1 rad/s raises it to ≈ 2 Hz) and a soft deadband: within YAW_DEADBAND_DEG of facing
 * (or of the back view) the drawn yaw is exactly 0 (or 180°); beyond, it ramps in smoothly.
 */
export const SMOOTH_YAW = { minCutoff: 0.4, beta: 1.6, dCutoff: 1 };
export const YAW_DEADBAND_DEG: readonly [number, number] = [8, 16];
/** Camera pitch / roll of the drawn pose (rad): a fixed camera, so nearly constant. */
export const SMOOTH_TILT = { minCutoff: 0.5, beta: 0.5, dCutoff: 1 };
/**
 * Front/back stability (user's live recording: drawn yaw p95 174.6° while turning; the solve
 * flipped front/back). A kiosk user faces the camera: the body yaw is limited to ±MAX_YAW_DEG;
 * a frame-to-frame yaw jump over YAW_STEP_LIMIT_DEG is held unless it persists
 * YAW_STEP_PERSIST_MS; beyond FADE_FROM_DEG the overlay fades out (fully at MAX_YAW_DEG), and a
 * back view (2D: MediaPipe's left shoulder at image left and the nose not visible) hides it.
 */
export const MAX_YAW_DEG = 75;
export const FADE_FROM_DEG = 60;
export const YAW_STEP_LIMIT_DEG = 25;
export const YAW_STEP_PERSIST_MS = 300;
/**
 * ?f1turn=1 (agent F1, D1/D2): the jacket is drawn through the whole turn and on the back, no fade
 * (ArTracker.turnThrough, turnHeading.ts). The drawn heading is the front solve near facing and
 * MediaPipe's world-landmark yaw once turned (venue trace: the world yaw is continuous through
 * 0 → ±90 → 180°, the solve under-reads a turn by 10–20°): blended between blendFromDeg and
 * blendToDeg of world yaw. A world jump beyond maxJumpDeg in one frame (a MediaPipe left/right
 * flip) is held up to persistMs unless the 2D back-view detector agrees. Heuristics from that trace
 * (facing world yaw 5–11°, a deliberate turn passes 20° within ~0.3 s). The front solve is also
 * kept within agreeDeg of the world yaw: with the arms up or crossed it read 15–37° on a person
 * the world yaw (2–6°) and the video show facing (F1 probe, 9.4–12.4 s and 22.7–25 s). Replay of
 * that run's solve/world yaws, drawn yaw sd on |world| ≤ 15° frames: agree 8° 3.6°, 6° 2.0°,
 * 5° 1.4°, 4° 1.1° (a run whose solve was right: 1.2 / 0.9 / 0.8 / 0.6°); 5° keeps a facing world
 * bias of +5…+9° from tilting a correctly pinned 0° beyond the yaw deadband.
 * The world yaw is never drawn further from facing (or from the back) than the 2D shoulder span
 * allows: acos(span ÷ expected frontal span) + spanMarginDeg (a close-up with the hips out of
 * the frame has no reliable world yaw, but its shoulders still show their full width).
 */
export const TURN = {
  blendFromDeg: 20,
  blendToDeg: 45,
  maxJumpDeg: 70,
  persistMs: 300,
  agreeDeg: 5,
  spanMarginDeg: 15,
} as const;
/**
 * ?f1side=1 (agent F1, lead RC5 item 2; judge U5 "uncovered" at side and back): near profile the
 * world yaw under-reads the turn and the 2D shoulder span reads it well. live4 (the user's real
 * Camo run) 7.6-9.6 s in profile: MediaPipe world yaw 69 deg, shoulder span ÷ frontal span 0.21
 * (acos 78 deg; hips 79 deg); drawn at 69 deg the jacket's back edge stopped short of the person's
 * back (dark strip along the back in the RC4 look job). With the flag the drawn turn is at least
 * acos(span ÷ frontal span) − floorMarginDeg once that reading passes fromDeg (near facing acos is
 * ill-conditioned and the world yaw keeps the say); the world yaw keeps the sign and the
 * front/back hemisphere. Replay sims (generic rig): live4 profile 69-70 -> 74-77 deg, camo-1
 * sides 62-70 -> 69-75 and 70-78 -> 73-82 deg; the venue turn (3/4 views, span reading < 55 deg)
 * and every facing frame unchanged.
 *
 * rampDeg (agent F1b, lead 23:25; live5 look jobs 6.3-7.8 / 33.5-36.5 s): the floor used to switch
 * on and off at fromDeg as a step. Turning back to front the floored heading (-72 deg) fell in
 * one frame to the lower world yaw (inferred: the look job logs only the drawn yaw), a jump over
 * YAW_STEP_LIMIT_DEG that the step hold then
 * froze at -71.7 / -68.3 deg for 4-5 frames (6.50-6.90 s, 33.93-34.40 s) while the body was
 * already frontal, then the jacket snapped to 0. Now the floor fades in over rampDeg below fromDeg
 * (smoothstep, no step), and with f1side the step hold never applies within exitMs of the last
 * world-driven (turned) frame: a world label flip is guarded by turnHeading.ts itself. exitMs
 * covers a turn back from profile to facing at the look lane's 9-15 fps (3-4 frames, live5) and
 * at least one frame at 3 fps.
 */
export const SIDE = { fromDeg: 55, floorMarginDeg: 0, rampDeg: 10, exitMs: 400 } as const;
/**
 * ?f1yawfast=1 (agent F1b, lead "F1b RESULT 2"): the yaw step hold (YAW_STEP_LIMIT_DEG for
 * YAW_STEP_PERSIST_MS) guards a solve or world-yaw glitch, but it also froze real fast turns at
 * the look lane's 8-15 fps: live5 replay 44.05-44.33 s (turning away through facing) held
 * -26.4 deg for 4 frames while MediaPipe's world yaw went -4.6 -> +12 deg, then jumped 37 deg
 * (and the drawn depth stepped 7 %); RC5 look job 43.8 s jumped 57 deg in one frame after a hold.
 * With the flag (f1turn) a step is not held when it is a COHERENT turn: MediaPipe's world yaw
 * moved in the step's direction on this frame by at least minWorldStepDeg and on the frame
 * before by at least minPrevStepDeg, or the 2D shoulder span (well conditioned beyond
 * spanFromDeg) reads the new heading within spanAgreeDeg. A one-frame world spike at rest fails
 * both (no motion the frame before; the span does not move), so it is still held.
 */
export const YAWFAST = {
  minWorldStepDeg: 4,
  minPrevStepDeg: 2,
  spanFromDeg: 25,
  spanAgreeDeg: 12,
  /**
   * With f1turnscale: when a turn ends, the drawn depth glides from the held frontal value to the
   * current one (time constant, ms) instead of stepping: live5 replay at half cadence, 35.21 ->
   * 35.39 s, the held 1.417 m stepped to 1.531 m (+8 %, the jacket shrank in one frame).
   */
  depthGlideMs: 200,
  /** The glide ends within this fraction of the current depth. */
  depthGlideEndFrac: 0.005,
} as const;
/**
 * ?f1torso=1 (agent F1, lead 21:5x; user J1 "the parka wobbles like jelly"): a stiff quilted
 * parka's torso is near-rigid. Engine (torsoHold.ts): each trunk DOF that bends or twists the
 * skinned jacket holds while the smoothed estimate stays within bandDeg of the held value; a
 * change beyond the band for sustainMs is real and the value glides to it (time constant
 * glideMs), following until within settleDeg, then holds again; a small settled change (driftMs
 * within the band, mean > driftDeg from the held value) glides too, so no twist is left behind. AR (ArTracker): the drawn depth's
 * backlash widens from DEPTH_DEADBAND to depthDeadband, and the drawn yaw gets a yawHoldDeg
 * backlash (sub-degree yaw shimmer turned the whole torso in 3D: live4 2.5-3.0 s, 0 -> 1.1 -> 0
 * deg while facing). Bands are heuristics sized to the trunk estimate's noise on the user's live
 * recordings; real bends/twists are 15-40 deg. Timing after CX-TRY P29 (the first 200/250 ms
 * version reached 90 % of a 15 deg step only after ~750 ms): live5 replay after the PoseSmoother,
 * added lag 75-150 ms (was 225-500 ms) with the arms-window trunk step p95 0.63 -> 0.00 deg.
 */
/**
 * ?f1turnscale=1 (agent F1, lead 22:1x; user: "when I turn sideways the jacket suddenly gets bigger").
 * live5 (the user's true-RC4 run) RC4 rows: turning to profile the drawn depth fell 1.66 -> 1.54 m
 * (8.4-9.6 s) and 1.62 -> 1.54 m (30.3-30.9 s), i.e. the jacket drawn 5-8 % bigger, while the
 * person stood at the same distance: MediaPipe's 2D shoulder-to-hip length grows ~11 % in profile
 * (297 -> 334 px) and the torso placement fitted it. With the flag, while the drawn turn is more
 * than fromDeg from facing (or from the back), the drawn depth stays at its last frontal value; a
 * change beyond releaseFrac that lasts releaseMs (walking while turned) is accepted.
 */
export const TURNSCALE = { fromDeg: 25, releaseFrac: 0.12, releaseMs: 800 } as const;
export const TORSO = {
  bandDeg: { trunk_flexion: 4, trunk_lateral: 3, trunk_twist: 6 } as Record<string, number>,
  sustainMs: 80,
  glideMs: 80,
  settleDeg: 0.5,
  driftMs: 400,
  driftDeg: 1.5,
  depthDeadband: 0.04,
  yawHoldDeg: 3,
} as const;
/**
 * Turning read from 2D: the shoulder span ÷ its expected frontal span (learned spread). Below
 * SIDE_SPAN_FADE[0] the overlay starts to fade, fully at SIDE_SPAN_FADE[1] (cos 53°…66°): a side
 * view the solve cannot represent is not drawn (cam-tshirt 6 s: side-on, drawn frontal, offset).
 */
export const SIDE_SPAN_FADE: readonly [number, number] = [0.6, 0.4];
/**
 * Frontal by 2D evidence → the drawn yaw is pinned to 0 (live recording 15:12: facing, nose
 * centred, shoulder span steady, yet the solve read +15…+40° from MediaPipe's depth prior):
 * nose within FRONTAL_NOSE_OFFSET × span of the shoulder midpoint, and the depth-normalised
 * span ≥ FRONTAL_SPAN_OF_MAX × its recent maximum (which decays FRONTAL_MAX_DECAY per second).
 */
export const FRONTAL_NOSE_OFFSET = 0.15;
export const FRONTAL_SPAN_OF_MAX = 0.9;
export const FRONTAL_MAX_DECAY = 0.02;

/** 1σ (degrees) that pins yaw, pitch and roll in the steadied re-solve (translation only). */
export const PIN_SIGMA_DEG = 0.3;
/**
 * Yaw prior from MediaPipe's world landmarks (1σ, degrees). Their depth is noisy, but it tells
 * facing from turned and resolves the sign that 2D widths cannot (cam-tshirt, facing: MediaPipe
 * +3…+10° while the unprimed solve flipped between −63° and +31°).
 */
export const YAW_PRIOR_SIGMA_DEG = 20;
/**
 * Lateral landmark-spread scale (ln sx) prior, 1σ, and its session learning. MediaPipe's shoulder
 * landmarks sat at 0.80–0.88 of the rig's projected shoulder-joint spread on cam-tshirt (facing).
 * Learned from frames that face the camera (|yaw| < 15° by both the solve and MediaPipe).
 */
export const SCALE_PRIOR_SIGMA = 0.15;
/**
 * The same prior once the session spread is learnt (SCALE_WARMUP_SAMPLES facing frames): a turn
 * narrows the shoulders like a smaller spread does, and at 0.15 the free solve preferred the
 * spread (cam-parka 3.1–3.8 s: MediaPipe's world shoulders 12–27 cm apart in depth, raw solve yaw
 * −2..+2°, the drawn turn ~0.7 s late). Heuristic, measured in the lab (yaw lag, facing yaw sd).
 */
export const SCALE_PRIOR_SIGMA_LEARNED = 0.05;
/**
 * The spread is a property of the person and the landmark model, not of the frame: learned
 * quickly over the first SCALE_WARMUP_SAMPLES facing frames, then all but frozen (time constant
 * SCALE_SESSION_TAU_S). Per-frame spread traded off against depth and made the jacket pump
 * ("it keeps scaling bigger and smaller", live test 2026-11-13).
 */
export const SCALE_WARMUP_SAMPLES = 45;
export const SCALE_WARMUP_TAU_S = 1.5;
export const SCALE_SESSION_TAU_S = 30;
export const SCALE_FRONTAL_DEG = 15;
/** Smoothing resets after this long without a solve (a new person must not glide in). */
export const SMOOTH_RESET_MS = 600;

/**
 * Alignment score = 1 − (RMS reprojection error of ALIGNMENT_JOINTS ÷ projected shoulder width) /
 * ALIGNMENT_ZERO_FRACTION, clamped to 0..1. Heuristic: an RMS error of 30 % of the shoulder width
 * (≈ 12 cm on a 40 cm shoulder) is an overlay that is plainly off the body (score 0).
 */
export const ALIGNMENT_ZERO_FRACTION = 0.3;
/**
 * Below this score the AR view says "alignment approximate". 0.6 ⇔ RMS error > 12 % of the
 * shoulder width (≈ 5 cm), about twice MediaPipe's own landmark scatter on a still person.
 */
export const ALIGNMENT_APPROXIMATE_BELOW = 0.6;

/**
 * Hand occluder (real hands in front of the jacket win). The capsule runs from the wrist landmark
 * past the knuckles (index/pinky landmarks) by HAND_REACH × the wrist→knuckle length, with a
 * radius of HAND_RADIUS × the knuckle spread (at least HAND_RADIUS_MIN × that length). Heuristic,
 * from hand proportions (fingers ≈ 1.1 × the palm length; palm width ≈ knuckle spread × 1.2).
 */
export const HAND_REACH = 2.1;
export const HAND_RADIUS = 0.75;
export const HAND_RADIUS_MIN = 0.45;
/**
 * The hand plane sits this far (m) in front of the posed wrist. 12 cm: the real hand (capsule ∩
 * person mask, from the wrist out) wins over the cuff (its front is ≈ 5 cm in front of the wrist),
 * so the hand comes out of the sleeve and covers the cuff's hollow opening (live test: "both cuffs
 * render as hollow open tubes"); a hand behind the back (> 12 cm behind the torso front) still
 * loses to the torso.
 */
export const HAND_DEPTH_MARGIN_M = 0.12;

/**
 * Collar guard (live test: "the 3D collar sits too high, against my chin and mouth"): the
 * drawn collar top must not project above the mouth line (MediaPipe mouth corners 9/10); when it
 * does, the drawn pose moves down by the excess (smoothed over COLLAR_GUARD_TAU_S) and the
 * trigger is counted. Collar top = the highest jacket point within COLLAR_HALF_WIDTH_M of the
 * front centre line.
 */
export const COLLAR_HALF_WIDTH_M = 0.06;
/**
 * Collar target, per product (users' videos; agent CH's measurements on the user's body,
 * 2026-11-13). The visible collar top (the asset's `collar_top` path near the front centre line;
 * never the hood panel's hidden rim strips) goes to a face point below the mouth line:
 *   parka (attached hood, collar stand): the CHIN (user: "the zipped collar reaches only to my
 *     chin");
 *   puffer (removable hood = funnel collar, asset path `hood_zip`): the LOWER LIP (user's video at
 *     5, 16 and 38-44 s: the zipped funnel covers the chin up to the lower lip).
 * MediaPipe has no chin or lip: face point = mouth line (corners 9/10) + factor × the nose → mouth
 * vertical distance. Chin factor 1.4: CH measured the user's chin at 1.4 nose–mouth distances
 * below the mouth line (phone video, 31 s; Anny's face is 2.0); the old 0.9 put the chin 1.3–2.7 cm
 * too high. Lower-lip factor 0.35: ESTIMATE from typical proportions (lower-lip height ≈ 0.9 cm
 * below the lips' meeting line vs nose tip → mouth ≈ 2.5 cm), not measured.
 * A per-session vertical offset of the drawn jacket (learned on facing frames with
 * COLLAR_TARGET_TAU_S, clamped to ±COLLAR_TARGET_MAX_M) puts the collar top there; the mouth-line
 * guard stays as the safety net. Eye spacing for cm readouts: EYE_SPACING_M.
 */
export const COLLAR_TARGET_FROM_MOUTH = { chin: 1.4, lowerLip: 0.35 } as const;
export type CollarTargetKind = keyof typeof COLLAR_TARGET_FROM_MOUTH;
export const COLLAR_TARGET_TAU_S = 2;
export const COLLAR_TARGET_MAX_M = 0.05;
export const EYE_SPACING_M = 0.063;
export const COLLAR_GUARD_TAU_S = 0.3;

/**
 * Exposure / white-balance match to the video (live test: "it looks pasted on"). Every
 * MATCH_EVERY_FRAMES frames the torso region of a tiny copy of the frame gives its mean sRGB
 * luma and colour cast. Exposure = kiosk exposure × (luma / MATCH_REFERENCE_LUMA)^MATCH_GAMMA,
 * clamped to MATCH_EXPOSURE_RANGE; the light rig is tinted MATCH_TINT of the way toward the cast
 * (gray-world). Smoothed with MATCH_TAU_S. Heuristic look values, not a light estimate.
 */
export const MATCH_EVERY_FRAMES = 10;
export const MATCH_REFERENCE_LUMA = 0.5;
export const MATCH_GAMMA = 0.7;
export const MATCH_EXPOSURE_RANGE: readonly [number, number] = [0.55, 1.3];
export const MATCH_TINT = 0.6;
export const MATCH_TAU_S = 1;

/**
 * Glue (hybrid AR): the rendered jacket is warped so its keypoints land on the person's
 * (warp.ts, glue.ts). Grid columns; local scale cap (lead: ±15 %); landmark-target smoothing
 * (One Euro, px). Importance weights: torso joints 1, arms 1, collar→chin 0.5, anchors 1.
 */
export const GLUE_COLUMNS = 24;
export const GLUE_SCALE_CAP = 0.15;
/**
 * Coverage: a jacket side edge must reach at least this far (m) outside the person's silhouette
 * at chest and waist rows, a conservative stand-in for ease + loft (heuristic, 1 cm).
 */
export const GLUE_EASE_M = 0.01;
export const SMOOTH_GLUE_TARGETS = { minCutoff: 1.5, beta: 0.02, dCutoff: 1 };
/**
 * Glue size hold (V5 scoreboard 27519c7: drawn scale step p95 2.2 %, target < 0.5 %): the glue's
 * torso targets (shoulders, hips) follow the landmarks, whose spread jitters 1–2 % frame to frame.
 * Their spread about their centroid is held with a backlash of GLUE_SIZE_DEADBAND (it moves only
 * when the real size changes by more, e.g. a step toward the camera); the centroid follows.
 * Arm targets (elbows, wrists) get their own, heavier One Euro (SMOOTH_GLUE_ARMS, px).
 */
export const GLUE_SIZE_DEADBAND = 0.015;
// beta 0.04 Hz per px/s: an arm moving at 200 px/s gets ≈ 9 Hz (≈ 18 ms), so moves pass without
// lag (the user's main complaint was "the jacket moves slower than my arms"); a still arm keeps 0.8 Hz.
export const SMOOTH_GLUE_ARMS = { minCutoff: 0.8, beta: 0.04, dCutoff: 1 };

/** Depth-only body prepass: polygon offset (pushes the body back) so the jacket never z-fights. */
export const BODY_DEPTH_OFFSET = { factor: 2, units: 4 };
/** Person mask texture is downsampled to at most this width (upload cost; edges are feathered). */
export const MASK_MAX_WIDTH = 384;

/**
 * Contour fit (glue, contour.ts; lead 2026-11-13: "the sides of the jacket sit exactly on the body
 * edge"). Rows as fractions from the shoulder line (0) to the hip line (1): below the armpits
 * (~0.25), down to the hips; the hem below the hips and the hood are never driven (V6/V7's sway
 * stays). Hold: a row's shift changes only beyond ±CONTOUR_DEADBAND_PX (no outline pumping), and
 * is limited to ±CONTOUR_CAP_PX. An arm within CONTOUR_ARM_RADIUS_M of the person edge skips
 * that side (≈ an upper arm's radius 4.5 cm + 1.5 cm margin). Heuristics, to be measured.
 */
export const CONTOUR_ROWS = [0.3, 0.45, 0.6, 0.75, 0.9] as const;
export const CONTOUR_DEADBAND_PX = 1.5;
export const CONTOUR_CAP_PX = 40;
export const CONTOUR_ARM_RADIUS_M = 0.06;

/**
 * Back view (ArTracker.backView). The user's videos (lab trace, 2026-11-13): MediaPipe's face
 * visibilities stay 0.97–0.99 on the person's back, so they are no cue. Both are needed:
 *   shoulder order (11.x − 12.x) / span: +1 facing, −1 on the back; flipped below −order, unless
 *     the span is under minSpanOfMax of its frontal maximum (a side view, where order is noise);
 *   nose z − mid-shoulder z (MediaPipe world, m; − = toward the camera): facing −0.08..−0.21,
 *     side −0.03..+0.03, back +0.05..+0.21; behind above noseBehindM. It abstains when the face
 *     is out of the frame or below visibility (a close-up with the head cut off).
 * Leave after frontal evidence (order > order, nose in front by noseFrontM when seen) for
 * releaseMs.
 */
export const BACK_VIEW = {
  order: 0.5,
  minSpanOfMax: 0.3,
  noseBehindM: 0.05,
  noseFrontM: 0.03,
  releaseMs: 300,
} as const;

/**
 * Forward-head flexion for the AR registration (ArCompositor.headFlexed, headPose.ts; lead's B1).
 * The person's head angle ahead of the torso axis (MediaPipe world: ears' midpoint over the
 * shoulders, hips → shoulders as the axis) minus the rig's (skull base over its shoulder joints)
 * minus `offsetDeg` (the ears sit forward of the skull base: calibrated so that upright, facing
 * clips read ~0; measured in the lab). Clamped to `rangeDeg` (head extension 10°, flexion 45°,
 * well inside the cervical range); unsure (ears, nose, shoulders or hips under `minVisibility`,
 * or the body turned more than `maxTurnDeg`) → 0. One Euro smoothed, low lag.
 */
// Calibration run (lab, 2026-11-13). Person − rig angle on upright clips: cam-parka +4.1°, puffer
// −4.2° / −15.0° (median −4.2° = offsetDeg); cam-tshirt −0.9°. So the T-shirt clip shows NO more
// forward head than the upright clips: its face offset is not a head flexion. The per-clip spread
// (±10°) is as large as the effect, and "on" moved the puffer's shoulders off by 4–6 px and the
// funnel 0.4–3.3 cm, so B1 stays OFF (ArCompositor.headFlexionOn).
export const HEAD_FLEXION = {
  rangeDeg: [-10, 45] as const,
  offsetDeg: -4.2,
  minVisibility: 0.5,
  maxTurnDeg: 30,
  smooth: { minCutoff: 1, beta: 0.05, dCutoff: 1 },
} as const;

/**
 * Time constant of the turn/side fade (ms). On cam-tshirt's close-up (10.6–12.8 s) single frames
 * with a glitched shoulder span or order faded the overlay fully for one frame (a flash); at 120 ms
 * a one-frame spike reaches ~0.25 and a real turn (> 300 ms) still fades fully. Back views are not
 * smoothed (they hide at once).
 */
export const FADE_TAU_MS = 120;

/**
 * Stillness lock (stillness.ts; the user, 2026-11-13: "standing still, the jacket keeps moving").
 * Watched: nose, shoulders, elbows, wrists, hips (One Euro filtered). Lab A/B of a hard hold
 * (cam-parka, cam-tshirt, puffer still windows): MediaPipe's noise RMS ~1 px, but natural sway
 * broke a noise-sized deadband (held on 5–8 % of frames). So: engage when the filtered landmark
 * speed stays under 25 px/s (at a 200 px shoulder span) for 250 ms; release when it exceeds
 * 60 px/s or a raw landmark jumps more than 6× noise + 6 px in one frame; ease to live in 66 ms.
 * While engaged the outputs run through a heavy One Euro (min cutoff 0.1 Hz; beta lets a real
 * drift through). Heuristics, measured in the lab (control motion, rotation RMS, onset lag).
 */
export const STILLNESS = {
  landmarks: [0, 11, 12, 13, 14, 15, 16, 23, 24],
  engageMs: 250,
  engageSpeed: 25,
  speedWindowMs: 200,
  releaseSpeed: 60,
  fastK: 6,
  fastFloorPx: 6,
  easeMs: 66,
  noiseTauMs: 1000,
  noiseInitialPx: 2,
  smooth: { minCutoff: 1, beta: 0.05, dCutoff: 1 },
  minVisibility: 0.5,
  output: {
    px: { minCutoff: 0.1, beta: 0.01, dCutoff: 1 },
    deg: { minCutoff: 0.1, beta: 0.02, dCutoff: 1 },
    mm: { minCutoff: 0.1, beta: 0.005, dCutoff: 1 },
  },
} as const;
