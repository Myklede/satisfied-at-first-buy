// Anatomical joint angles from MediaPipe Pose world landmarks. Pure (no DOM, no MediaPipe import).
//
// Contract: prompts/motion-contract.md (`AnatomicalPose`, degrees, 0 = relaxed neutral standing).
// Shoulder angles follow the ISB recommendation for the humerus relative to the thorax:
//   Wu G, van der Helm FCT, Veeger HEJ, et al. "ISB recommendation on definitions of joint
//   coordinate systems of various joints for the reporting of human joint motion — Part II:
//   shoulder, elbow, wrist and hand." J Biomech 38(5):981–992, 2005. doi:10.1016/j.jbiomech.2004.05.042
// i.e. a Y-X-Y Euler sequence: plane of elevation (about thorax Y), elevation (about the rotated
// X), axial rotation (about the humerus long axis). The thorax frame is ISB-like: X forward,
// Y up, Z to the subject's right. The left arm is mirrored (Z negated) so both sides share signs:
// plane 0 = abduction in the frontal plane, 90 = forward flexion; axial + = internal rotation.
//
// Coordinates. MediaPipe world landmarks are metres, origin between the hips, x = image right,
// y = image down, z = away from the camera (smaller z = closer). We convert to a right-handed
// camera frame "C": X = image right, Y = up, Z = toward the camera  (C = (x, −y, −z)).
// A person facing the camera then has their front along +Z and their left side along +X.
//
// Gravity. World landmarks carry no gravity direction. The vertical used for trunk flexion /
// lateral bend, hip flexion and pelvis drop is:
//   - after neutral calibration: the mean trunk axis (mid-hip → mid-shoulder) while the user
//     stands upright and still for 1 s. This absorbs camera pitch (laptop lids lean back) and the
//     user's natural posture, so the calibrated stance reads trunk_flexion = 0 as the contract
//     defines ("0 = the relaxed neutral standing pose");
//   - before calibration: the camera's up axis (+Y of C), i.e. an assumed upright, level camera.
//     Confidence of the gravity-referenced DOFs is scaled by UNCALIBRATED_CONFIDENCE then.
//
// Conventions chosen here where the contract is silent (reported to the main session):
//   - trunk_flexion = sagittal angle of the trunk axis from vertical, in the pelvis heading frame:
//     atan2(u·f, u·v); trunk_lateral = asin(u·r) (tilt out of the sagittal plane). This pair is
//     an exact Euler decomposition (flexion first, then lateral bend), valid up to 90° flexion.
//   - trunk_twist = rotation of the shoulder line relative to the hip line about the trunk axis.
//   - hip_flexion = sagittal angle of the thigh from the vertical (gravity), NOT from the trunk,
//     because trunk_flexion already carries the forward bend "at the hips/spine". A straight-leg
//     forward bend therefore reads trunk_flexion ≈ 90, hip_flexion ≈ 0; sitting upright reads
//     trunk_flexion ≈ 0, hip_flexion ≈ 90.
//   - pelvis_drop_m = calibrated standing hip height − current hip height above the lower ankle
//     (feet assumed on the floor, as the contract's rig solves it).

// ---------------------------------------------------------------------------
// Pose DOFs, limits and types
// ---------------------------------------------------------------------------

export const ANATOMICAL_DOFS = [
  'trunk_flexion',
  'trunk_lateral',
  'trunk_twist',
  'shoulder_L_plane',
  'shoulder_L_elevation',
  'shoulder_L_axial',
  'shoulder_R_plane',
  'shoulder_R_elevation',
  'shoulder_R_axial',
  'elbow_L_flexion',
  'elbow_R_flexion',
  'hip_L_flexion',
  'hip_R_flexion',
  'knee_L_flexion',
  'knee_R_flexion',
  'pelvis_drop_m',
] as const;

export type AnatomicalDof = (typeof ANATOMICAL_DOFS)[number];
/** Degrees, except pelvis_drop_m (metres). See prompts/motion-contract.md. */
export type AnatomicalPose = Record<AnatomicalDof, number>;
/** Per-DOF confidence 0..1. */
export type PoseConfidence = Record<AnatomicalDof, number>;

/**
 * Clamping limits [min, max]. Sources: AAOS normal range of motion (Greene WB, Heckman JD,
 * "The Clinical Measurement of Joint Motion", AAOS 1994): shoulder flexion/abduction 180,
 * extension 60, horizontal adduction 135, internal 70 / external 90; elbow flexion 150; hip
 * flexion 120, extension 30; knee flexion 135; thoracolumbar extension 25, lateral flexion 35,
 * rotation 45. Where the motion contract's "range used" is wider, the contract wins (trunk
 * flexion 90 includes pelvic tilt at the hips; knee 140; axial ±90; pelvis drop 0..0.6 m).
 * Plane of elevation: −90 (arm reaching straight back = shoulder extension) … 135 (horizontal
 * adduction across the chest), beyond the contract's 0…120 so that crossed arms and arms behind
 * the body stay representable; the rig must accept this range.
 */
export const POSE_LIMITS: Readonly<Record<AnatomicalDof, readonly [number, number]>> = {
  trunk_flexion: [-25, 90],
  trunk_lateral: [-35, 35],
  trunk_twist: [-45, 45],
  shoulder_L_plane: [-90, 135],
  shoulder_L_elevation: [0, 180],
  shoulder_L_axial: [-90, 90],
  shoulder_R_plane: [-90, 135],
  shoulder_R_elevation: [0, 180],
  shoulder_R_axial: [-90, 90],
  elbow_L_flexion: [0, 150],
  elbow_R_flexion: [0, 150],
  hip_L_flexion: [-30, 120],
  hip_R_flexion: [-30, 120],
  knee_L_flexion: [0, 140],
  knee_R_flexion: [0, 140],
  pelvis_drop_m: [0, 0.6],
};

/** A clamp is reported only when the raw value is beyond the limit by more than this. */
export const CLAMP_REPORT_TOLERANCE_DEG = 2;
export const CLAMP_REPORT_TOLERANCE_M = 0.02;

export function neutralPose(): AnatomicalPose {
  return Object.fromEntries(ANATOMICAL_DOFS.map((d) => [d, 0])) as AnatomicalPose;
}
export function zeroConfidence(): PoseConfidence {
  return Object.fromEntries(ANATOMICAL_DOFS.map((d) => [d, 0])) as PoseConfidence;
}

// ---------------------------------------------------------------------------
// Confidence heuristics (all heuristics; tune with real recordings)
// ---------------------------------------------------------------------------

/** Landmark visibility ramp: below LO the landmark counts as unseen, above HI as fully seen. */
export const VISIBILITY_LO = 0.3;
export const VISIBILITY_HI = 0.8;
/** Image landmarks outside [−margin, 1+margin] are out of frame (MediaPipe extrapolates them). */
export const IN_FRAME_MARGIN = 0.02;
/**
 * Depth ambiguity of a segment: fraction of its length lying in the image plane. Below LO
 * (≈ 70° toward/away from the camera) the direction rests mostly on MediaPipe's depth guess.
 */
export const DEPTH_IN_PLANE_LO = 0.35;
export const DEPTH_IN_PLANE_HI = 0.75;
/** Confidence factor kept even for a segment pointing straight at the camera. */
export const DEPTH_FLOOR = 0.3;
/**
 * DOFs whose sensitive direction is along the camera axis (trunk flexion facing the camera,
 * twist) lose up to this share of confidence: factor = 1 − PENALTY·|s·Zcam|².
 */
export const DEPTH_AXIS_PENALTY = 0.5;
/** Humerus plane of elevation is undefined at elevation 0/180 (gimbal lock of Y-X-Y). */
export const GIMBAL_LO_DEG = 8;
export const GIMBAL_HI_DEG = 25;
/** Axial rotation needs a bent elbow (the forearm is the only rotation marker). */
export const AXIAL_ELBOW_LO_DEG = 20;
export const AXIAL_ELBOW_HI_DEG = 45;
/**
 * Upper bounds for DOFs a single RGB camera cannot observe well: humeral axial rotation is read
 * only through the forearm direction (no hand/wrist orientation), and trunk twist only through
 * MediaPipe's per-joint depth of the shoulders. Heuristic caps.
 */
export const AXIAL_MAX_CONFIDENCE = 0.3;
export const TWIST_MAX_CONFIDENCE = 0.4;
/** Gravity-referenced DOFs without calibration (camera assumed upright). Heuristic. */
export const UNCALIBRATED_CONFIDENCE = 0.6;
/** Pelvis drop without calibrated standing hip height (from live leg lengths). Heuristic. */
export const PELVIS_DROP_UNCALIBRATED_CONFIDENCE = 0.5;
/** Below this confidence the raw value is not trusted and the previous value is held. */
export const HOLD_BELOW_CONFIDENCE = 0.05;

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------

/** MediaPipe Pose (BlazePose 33) indices used here. L/R are the subject's own sides. */
export const PL = {
  nose: 0,
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
  lHeel: 29,
  rHeel: 30,
  lFoot: 31,
  rFoot: 32,
} as const;
export const POSE_LANDMARK_COUNT = 33;

export interface PoseLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/** One frame of MediaPipe output for one person. */
export interface PoseLandmarksInput {
  /** 33 world landmarks (metres, hip-centred, MediaPipe axes). */
  world: readonly PoseLandmark[];
  /** 33 normalised image landmarks (for in-frame tests and visibility), optional. */
  image?: readonly PoseLandmark[];
}

export type Vec3 = [number, number, number];

// ---------------------------------------------------------------------------
// Small vector helpers
// ---------------------------------------------------------------------------

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 1e-9 ? scale(a, 1 / n) : [0, 0, 0];
}
/** Component of a perpendicular to unit vector n. */
export const reject = (a: Vec3, n: Vec3): Vec3 => sub(a, scale(n, dot(a, n)));
export const mid = (a: Vec3, b: Vec3): Vec3 => scale(add(a, b), 0.5);
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
export function smoothstep(lo: number, hi: number, x: number): number {
  const t = clamp01((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
}
/** Unsigned angle between two vectors, degrees. */
export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const na = norm(a);
  const nb = norm(b);
  if (na < 1e-9 || nb < 1e-9) return 0;
  return Math.acos(clamp(dot(a, b) / (na * nb), -1, 1)) * DEG;
}
/** Signed angle from a to b about unit axis n (right-hand rule), degrees; a, b ⟂ n ideally. */
export function signedAngleDeg(a: Vec3, b: Vec3, n: Vec3): number {
  return Math.atan2(dot(cross(a, b), n), dot(a, b)) * DEG;
}

/** Rotation about +X by a (radians): y' = y cos a − z sin a, z' = y sin a + z cos a. */
export function rotX(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}
/** Rotation about +Y by a (radians): x' = x cos a + z sin a, z' = −x sin a + z cos a. */
export function rotY(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}
/** Rotation about +Z by a (radians): x' = x cos a − y sin a, y' = x sin a + y cos a. */
export function rotZ(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

/** MediaPipe world (x right, y down, z away) → camera frame C (X right, Y up, Z toward camera). */
export const mediapipeToCamera = (p: PoseLandmark): Vec3 => [p.x, -p.y, -p.z];
/** Inverse of mediapipeToCamera. */
export const cameraToMediapipe = (c: Vec3): PoseLandmark => ({ x: c[0], y: -c[1], z: -c[2] });

/** Camera axis toward the viewer in C. */
const CAMERA_Z: Vec3 = [0, 0, 1];
/** Assumed gravity "up" in C before calibration (upright, level camera). */
export const UNCALIBRATED_UP: Vec3 = [0, 1, 0];

// ---------------------------------------------------------------------------
// ISB humerus angles (Y-X-Y) — forward and inverse, in a side-local mirrored frame
// ---------------------------------------------------------------------------
// Local frame of one shoulder: x = thorax forward, y = thorax up, z = lateral (subject's right for
// the right arm; the LEFT arm is mirrored so z points to the subject's left). Humerus orientation
// R(φ, θ, ψ) = Ry(φ) · Rx(−θ) · Ry(ψ) applied to the neutral humerus (arm hanging, long axis −y,
// forearm pointing +x when the elbow is bent). φ = plane of elevation, θ = elevation, ψ = axial
// rotation (+ = internal). Hence:
//   humerus direction d(φ, θ) = (sin θ sin φ, −cos θ, sin θ cos φ)
//   forearm direction w      = R(φ, θ, ψ) · (sin e, −cos e, 0),  e = elbow flexion
// Note the Y-X-Y gimbal: at θ = 0 only φ + ψ is defined (ISB, Wu 2005, §2.3.2 notes).

/** Humerus direction (shoulder → elbow, unit) in the side-local frame. */
export function humerusDirectionLocal(planeDeg: number, elevationDeg: number): Vec3 {
  const p = planeDeg * RAD;
  const t = elevationDeg * RAD;
  return [Math.sin(t) * Math.sin(p), -Math.cos(t), Math.sin(t) * Math.cos(p)];
}

/** Applies R(φ, θ, ψ) = Ry(φ)·Rx(−θ)·Ry(ψ) to a vector of the neutral humerus frame. */
export function humerusRotate(
  v: Vec3,
  planeDeg: number,
  elevationDeg: number,
  axialDeg: number,
): Vec3 {
  return rotY(rotX(rotY(v, axialDeg * RAD), -elevationDeg * RAD), planeDeg * RAD);
}

/** Forearm direction (elbow → wrist, unit) in the side-local frame. */
export function forearmDirectionLocal(
  planeDeg: number,
  elevationDeg: number,
  axialDeg: number,
  elbowFlexionDeg: number,
): Vec3 {
  const e = elbowFlexionDeg * RAD;
  return humerusRotate([Math.sin(e), -Math.cos(e), 0], planeDeg, elevationDeg, axialDeg);
}

export interface ArmAngles {
  plane: number;
  elevation: number;
  axial: number;
  elbowFlexion: number;
  /** Raw (unblended) plane, for diagnostics. */
  planeRaw: number;
  /** 0..1 how well the plane is defined (gimbal factor). */
  planeDefined: number;
  /** 0..1 how well axial rotation is defined (elbow bend factor × gimbal-free). */
  axialDefined: number;
}

/**
 * Inverse of the forward model above. `d` = shoulder→elbow, `w` = elbow→wrist, both in the
 * side-local frame (any length). Near the gimbal (elevation ≈ 0/180) the plane is blended toward
 * `previousPlane` (default 0 = frontal plane) by the gimbal factor; axial rotation is then
 * computed relative to that blended plane, so the composed orientation stays consistent.
 * With a straight elbow the forearm carries no rotation information: axial blends toward
 * `previousAxial` (default 0).
 */
export function armAnglesFromLocal(
  d: Vec3,
  w: Vec3,
  previousPlane = 0,
  previousAxial = 0,
): ArmAngles {
  const dn = normalize(d);
  const elevation = Math.acos(clamp(-dn[1], -1, 1)) * DEG;
  const planeRaw = Math.atan2(dn[0], dn[2]) * DEG;
  const planeDefined = smoothstep(
    GIMBAL_LO_DEG,
    GIMBAL_HI_DEG,
    Math.min(elevation, 180 - elevation),
  );
  const plane = previousPlane + planeDefined * wrapDeg(planeRaw - previousPlane);
  const elbowFlexion = angleBetweenDeg(d, w);
  // Reference forearm direction at ψ = 0 for this (φ, θ), projected ⟂ to the actual humerus.
  const ref = reject(humerusRotate([1, 0, 0], plane, elevation, 0), dn);
  const wp = reject(normalize(w), dn);
  const axisUp = scale(dn, -1); // ISB humerus Y axis: elbow → shoulder
  const axialRaw = norm(ref) > 1e-6 && norm(wp) > 1e-6 ? signedAngleDeg(ref, wp, axisUp) : 0;
  const axialDefined = smoothstep(AXIAL_ELBOW_LO_DEG, AXIAL_ELBOW_HI_DEG, elbowFlexion);
  const axial = previousAxial + axialDefined * wrapDeg(axialRaw - previousAxial);
  return {
    plane: wrapDeg(plane),
    elevation,
    axial: wrapDeg(axial),
    elbowFlexion,
    planeRaw,
    planeDefined,
    axialDefined,
  };
}

/** Wraps degrees into (−180, 180]. */
export function wrapDeg(a: number): number {
  let x = ((a + 180) % 360) - 180;
  if (x <= -180) x += 360;
  return x;
}

// ---------------------------------------------------------------------------
// Neutral calibration
// ---------------------------------------------------------------------------

export interface NeutralCalibration {
  /** Gravity "up" in camera frame C (unit), from the mean trunk axis while standing. */
  up: Vec3;
  /** Mid-hip height above the lower ankle while standing (m), or null if feet were not seen. */
  standingHipHeightM: number | null;
  /** Frames averaged. */
  frames: number;
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

export interface PoseEstimate {
  pose: AnatomicalPose;
  confidence: PoseConfidence;
  /** DOFs whose raw value exceeded POSE_LIMITS by more than the report tolerance. */
  clamped: AnatomicalDof[];
  /** DOFs that kept the previous value because their confidence was below HOLD_BELOW_CONFIDENCE. */
  held: AnatomicalDof[];
}

export interface EstimateOptions {
  calibration?: NeutralCalibration | null;
  /** Previous estimate (unfiltered or filtered) for gimbal blending and holds. */
  previous?: AnatomicalPose | null;
}

interface Seen {
  p: Vec3;
  /** 0..1 visibility × in-frame factor. */
  q: number;
}

function landmarkQuality(world: PoseLandmark, image?: PoseLandmark): number {
  const vis = image?.visibility ?? world.visibility;
  let q = vis === undefined ? 1 : smoothstep(VISIBILITY_LO, VISIBILITY_HI, vis);
  if (image) {
    const m = IN_FRAME_MARGIN;
    if (image.x < -m || image.x > 1 + m || image.y < -m || image.y > 1 + m) q = 0;
  }
  return q;
}

/** Confidence factor for a segment from how much of it lies in the image plane. */
export function segmentDepthFactor(seg: Vec3): number {
  const n = norm(seg);
  if (n < 1e-9) return 0;
  const inPlane = Math.hypot(seg[0], seg[1]) / n;
  return (
    DEPTH_FLOOR + (1 - DEPTH_FLOOR) * smoothstep(DEPTH_IN_PLANE_LO, DEPTH_IN_PLANE_HI, inPlane)
  );
}

/** Confidence factor for a DOF whose sensitive direction is unit vector s (C frame). */
export function axisDepthFactor(s: Vec3): number {
  const c = dot(s, CAMERA_Z);
  return 1 - DEPTH_AXIS_PENALTY * c * c;
}

/** Mid-hip height above the lower visible ankle, along `up`; null if no ankle is usable. */
export function hipHeightAboveFeet(
  lm: (i: number) => Seen,
  up: Vec3,
): { height: number; q: number } | null {
  const midHip = mid(lm(PL.lHip).p, lm(PL.rHip).p);
  const hipQ = Math.min(lm(PL.lHip).q, lm(PL.rHip).q);
  let best: { height: number; q: number } | null = null;
  for (const i of [PL.lAnkle, PL.rAnkle]) {
    const a = lm(i);
    if (a.q < HOLD_BELOW_CONFIDENCE) continue;
    const h = dot(sub(midHip, a.p), up);
    if (!best || h > best.height) best = { height: h, q: Math.min(a.q, hipQ) };
  }
  return best;
}

function accessor(input: PoseLandmarksInput): (i: number) => Seen {
  if (input.world.length < POSE_LANDMARK_COUNT)
    throw new RangeError(
      `Pose input needs ${POSE_LANDMARK_COUNT} world landmarks (got ${input.world.length}).`,
    );
  if (input.image && input.image.length < POSE_LANDMARK_COUNT)
    throw new RangeError(`Pose input image landmarks: expected ${POSE_LANDMARK_COUNT}.`);
  return (i) => ({
    p: mediapipeToCamera(input.world[i]),
    q: landmarkQuality(input.world[i], input.image?.[i]),
  });
}

/** Trunk up axis (mid-hip → mid-shoulder, unit) in C. */
export function trunkUp(input: PoseLandmarksInput): Vec3 {
  const lm = accessor(input);
  return normalize(
    sub(mid(lm(PL.lShoulder).p, lm(PL.rShoulder).p), mid(lm(PL.lHip).p, lm(PL.rHip).p)),
  );
}

/**
 * Estimates the anatomical pose of one frame. Pure. Values are clamped to POSE_LIMITS; DOFs whose
 * confidence is below HOLD_BELOW_CONFIDENCE keep `previous` (or 0) instead of a guessed value.
 */
export function estimateAnatomicalPose(
  input: PoseLandmarksInput,
  options: EstimateOptions = {},
): PoseEstimate {
  const lm = accessor(input);
  const prev = options.previous ?? null;
  const cal = options.calibration ?? null;
  const v: Vec3 = cal ? normalize(cal.up) : UNCALIBRATED_UP;
  const gravityConf = cal ? 1 : UNCALIBRATED_CONFIDENCE;

  const ls = lm(PL.lShoulder);
  const rs = lm(PL.rShoulder);
  const lh = lm(PL.lHip);
  const rh = lm(PL.rHip);
  const torsoQ = Math.min(ls.q, rs.q, lh.q, rh.q);
  const midHip = mid(lh.p, rh.p);
  const midShoulder = mid(ls.p, rs.p);
  const u = normalize(sub(midShoulder, midHip));

  // Pelvis heading frame (gravity-aligned): r_p = hip line made horizontal, f_p = v × r_p.
  let rp = normalize(reject(sub(rh.p, lh.p), v));
  if (norm(rp) < 0.5) rp = normalize(reject(sub(rs.p, ls.p), v)); // hips vertical (lying): fall back
  const fp = cross(v, rp);

  // Thorax frame (ISB-like): Y = u, Z = shoulder line ⟂ u (subject's right), X = Y × Z (forward).
  const ts = normalize(reject(sub(rs.p, ls.p), u));
  const tf = cross(u, ts);

  const raw = neutralPose();
  const conf = zeroConfidence();

  // --- Trunk ---
  raw.trunk_flexion = Math.atan2(dot(u, fp), dot(u, v)) * DEG;
  raw.trunk_lateral = Math.asin(clamp(dot(u, rp), -1, 1)) * DEG;
  conf.trunk_flexion = torsoQ * gravityConf * axisDepthFactor(fp);
  conf.trunk_lateral = torsoQ * gravityConf * axisDepthFactor(rp);
  const hipLine = normalize(reject(sub(rh.p, lh.p), u));
  raw.trunk_twist = norm(hipLine) > 0.5 ? signedAngleDeg(hipLine, ts, u) : 0;
  // Twist moves the shoulders along the thorax forward axis: mostly depth when facing the camera.
  conf.trunk_twist = Math.min(TWIST_MAX_CONFIDENCE, torsoQ * axisDepthFactor(tf));

  // --- Arms (thorax frame, left mirrored) ---
  const arm = (side: 'L' | 'R') => {
    const S = side === 'L' ? ls : rs;
    const E = lm(side === 'L' ? PL.lElbow : PL.rElbow);
    const W = lm(side === 'L' ? PL.lWrist : PL.rWrist);
    const zSign = side === 'L' ? -1 : 1;
    const local = (a: Vec3): Vec3 => [dot(a, tf), dot(a, u), zSign * dot(a, ts)];
    const dC = sub(E.p, S.p);
    const wC = sub(W.p, E.p);
    const angles = armAnglesFromLocal(
      local(dC),
      local(wC),
      prev?.[`shoulder_${side}_plane`] ?? 0,
      prev?.[`shoulder_${side}_axial`] ?? 0,
    );
    const torsoArmQ = Math.min(ls.q, rs.q, lh.q, rh.q, S.q, E.q);
    const upperDepth = segmentDepthFactor(dC);
    const foreDepth = segmentDepthFactor(wC);
    raw[`shoulder_${side}_plane`] = angles.plane;
    raw[`shoulder_${side}_elevation`] = angles.elevation;
    raw[`shoulder_${side}_axial`] = angles.axial;
    raw[`elbow_${side}_flexion`] = angles.elbowFlexion;
    conf[`shoulder_${side}_elevation`] = torsoArmQ * upperDepth;
    // The plane moves the elbow along ∂d/∂φ ∝ (cos φ, 0, −sin φ) (local): for sideways abduction
    // facing the camera that is the thorax forward axis, i.e. pure depth.
    const p = angles.plane * (Math.PI / 180);
    const planeSens = add(scale(tf, Math.cos(p)), scale(ts, -zSign * Math.sin(p)));
    conf[`shoulder_${side}_plane`] =
      torsoArmQ * upperDepth * angles.planeDefined * axisDepthFactor(planeSens);
    conf[`shoulder_${side}_axial`] = Math.min(
      AXIAL_MAX_CONFIDENCE,
      Math.min(torsoArmQ, W.q) * Math.min(upperDepth, foreDepth) * angles.axialDefined,
    );
    conf[`elbow_${side}_flexion`] = Math.min(S.q, E.q, W.q) * Math.min(upperDepth, foreDepth);
  };
  arm('L');
  arm('R');

  // --- Legs (gravity-aligned pelvis heading frame) ---
  const leg = (side: 'L' | 'R') => {
    const H = side === 'L' ? lh : rh;
    const K = lm(side === 'L' ? PL.lKnee : PL.rKnee);
    const A = lm(side === 'L' ? PL.lAnkle : PL.rAnkle);
    const thigh = sub(K.p, H.p);
    const shank = sub(A.p, K.p);
    raw[`hip_${side}_flexion`] = Math.atan2(dot(thigh, fp), -dot(thigh, v)) * DEG;
    raw[`knee_${side}_flexion`] = angleBetweenDeg(thigh, shank);
    conf[`hip_${side}_flexion`] =
      Math.min(lh.q, rh.q, K.q) * segmentDepthFactor(thigh) * gravityConf;
    conf[`knee_${side}_flexion`] =
      Math.min(H.q, K.q, A.q) * Math.min(segmentDepthFactor(thigh), segmentDepthFactor(shank));
  };
  leg('L');
  leg('R');

  // --- Pelvis drop ---
  const hh = hipHeightAboveFeet(lm, v);
  if (hh) {
    if (cal?.standingHipHeightM != null) {
      raw.pelvis_drop_m = cal.standingHipHeightM - hh.height;
      conf.pelvis_drop_m = hh.q;
    } else {
      // No calibrated stance: standing hip height ≈ thigh + shank length of the lower leg seen now.
      const legLen = (h: number, k: number, a: number) =>
        norm(sub(lm(k).p, lm(h).p)) + norm(sub(lm(a).p, lm(k).p));
      const standing = Math.max(
        legLen(PL.lHip, PL.lKnee, PL.lAnkle),
        legLen(PL.rHip, PL.rKnee, PL.rAnkle),
      );
      raw.pelvis_drop_m = standing - hh.height;
      conf.pelvis_drop_m = hh.q * PELVIS_DROP_UNCALIBRATED_CONFIDENCE * gravityConf;
    }
  }

  // --- Holds and clamping ---
  const pose = neutralPose();
  const clamped: AnatomicalDof[] = [];
  const held: AnatomicalDof[] = [];
  for (const dof of ANATOMICAL_DOFS) {
    let value = raw[dof];
    const c = clamp01(Number.isFinite(conf[dof]) ? conf[dof] : 0);
    conf[dof] = c;
    if (c < HOLD_BELOW_CONFIDENCE || !Number.isFinite(value)) {
      value = prev?.[dof] ?? 0;
      held.push(dof);
    }
    const [lo, hi] = POSE_LIMITS[dof];
    const tol = dof === 'pelvis_drop_m' ? CLAMP_REPORT_TOLERANCE_M : CLAMP_REPORT_TOLERANCE_DEG;
    if (value < lo - tol || value > hi + tol) clamped.push(dof);
    pose[dof] = clamp(value, lo, hi);
  }
  return { pose, confidence: conf, clamped, held };
}

// ---------------------------------------------------------------------------
// Neutral calibration (pure accumulator; the tracker feeds it frames)
// ---------------------------------------------------------------------------

/** Seconds of still, upright standing required (task spec: 1 s). */
export const CALIBRATION_HOLD_MS = 1000;
/** Max speed of any torso/arm landmark (m/s) to count as still. Heuristic. */
export const CALIBRATION_MAX_SPEED_MS = 0.25;
/**
 * The speed is measured over this window, not frame to frame. MediaPipe's world landmarks jitter
 * by about 1 cm per frame even on a held identical image. At 30 Hz that is ~0.3 m/s frame to frame,
 * above the limit, so calibration never completed (agent V1, 2026-11-13, on the user's video).
 * Over 250 ms the same jitter is ~0.04 m/s, while a real arm movement still exceeds 0.25 m/s.
 */
export const CALIBRATION_SPEED_WINDOW_MS = 250;
/** Trunk axis must be within this angle of the camera's up axis. Heuristic (laptop lid tilt). */
export const CALIBRATION_MAX_TILT_DEG = 25;
/** Arms must hang: humerus within this angle of the trunk's down axis. Heuristic. */
export const CALIBRATION_MAX_ARM_ELEVATION_DEG = 35;
/** Torso landmarks must be at least this well seen. Heuristic. */
export const CALIBRATION_MIN_QUALITY = 0.5;

export type CalibrationIssue =
  | 'no_person'
  | 'moving'
  | 'not_upright'
  | 'arms_not_down'
  | 'torso_hidden';

export interface CalibrationProgress {
  progress: number;
  issues: CalibrationIssue[];
  done?: NeutralCalibration;
}

const STILL_IDS = [
  PL.lShoulder,
  PL.rShoulder,
  PL.lElbow,
  PL.rElbow,
  PL.lWrist,
  PL.rWrist,
  PL.lHip,
  PL.rHip,
];

/** Accumulates a 1 s still upright window and produces a NeutralCalibration. */
export class NeutralCalibrator {
  private windowStart: number | undefined;
  private ups: Vec3[] = [];
  private hipHeights: number[] = [];
  /** Recent landmark samples (oldest first), kept for CALIBRATION_SPEED_WINDOW_MS plus one sample. */
  private history: { t: number; pts: Vec3[] }[] = [];

  constructor(private readonly holdMs = CALIBRATION_HOLD_MS) {}

  reset(): void {
    this.windowStart = undefined;
    this.ups = [];
    this.hipHeights = [];
    this.history = [];
  }

  update(timeMs: number, input: PoseLandmarksInput | undefined): CalibrationProgress {
    if (!input) {
      this.reset();
      return { progress: 0, issues: ['no_person'] };
    }
    const lm = accessor(input);
    const issues: CalibrationIssue[] = [];
    const pts = STILL_IDS.map((i) => lm(i).p);
    if (
      Math.min(...[PL.lShoulder, PL.rShoulder, PL.lHip, PL.rHip].map((i) => lm(i).q)) <
      CALIBRATION_MIN_QUALITY
    )
      issues.push('torso_hidden');
    // Speed over a ~250 ms window: compare with the newest sample at least that old. The
    // per-frame jitter averages out over the window, while real motion does not.
    const ref = [...this.history]
      .reverse()
      .find((h) => timeMs - h.t >= CALIBRATION_SPEED_WINDOW_MS);
    if (ref && timeMs > ref.t) {
      const dt = (timeMs - ref.t) / 1000;
      const speed = Math.max(...pts.map((p, k) => norm(sub(p, ref.pts[k])) / dt));
      if (speed > CALIBRATION_MAX_SPEED_MS) issues.push('moving');
    }
    if (this.history.length && timeMs < this.history[this.history.length - 1].t) this.history = [];
    this.history.push({ t: timeMs, pts });
    // Keep one sample older than the window, plus everything inside it.
    while (this.history.length > 2 && timeMs - this.history[1].t >= CALIBRATION_SPEED_WINDOW_MS)
      this.history.shift();
    const u = trunkUp(input);
    if (angleBetweenDeg(u, UNCALIBRATED_UP) > CALIBRATION_MAX_TILT_DEG) issues.push('not_upright');
    const down = scale(u, -1);
    const armUp = Math.max(
      angleBetweenDeg(sub(lm(PL.lElbow).p, lm(PL.lShoulder).p), down),
      angleBetweenDeg(sub(lm(PL.rElbow).p, lm(PL.rShoulder).p), down),
    );
    if (armUp > CALIBRATION_MAX_ARM_ELEVATION_DEG) issues.push('arms_not_down');
    if (issues.length) {
      this.windowStart = undefined;
      this.ups = [];
      this.hipHeights = [];
      return { progress: 0, issues };
    }
    this.windowStart ??= timeMs;
    this.ups.push(u);
    const hh = hipHeightAboveFeet(lm, u);
    if (hh && hh.q >= CALIBRATION_MIN_QUALITY) this.hipHeights.push(hh.height);
    const progress = clamp01((timeMs - this.windowStart) / this.holdMs);
    if (progress < 1) return { progress, issues };
    const up = normalize(this.ups.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3));
    // Hip height measured along the final mean up axis would need the raw points; the per-frame
    // heights along each frame's trunk axis differ from it by < 1 − cos(5°) ≈ 0.4 % while still.
    const standingHipHeightM =
      this.hipHeights.length >= this.ups.length / 2 ? median(this.hipHeights) : null;
    const done: NeutralCalibration = { up, standingHipHeightM, frames: this.ups.length };
    this.reset();
    return { progress: 1, issues: [], done };
  }
}

export function median(values: readonly number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
