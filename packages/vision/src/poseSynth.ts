// Forward kinematics for AnatomicalPose: angles → a 3D stick skeleton → MediaPipe-style
// landmarks. Pure. Used by
//   - unit tests (synthetic skeletons of known angles, the round trip angles → landmarks → angles),
//   - the lab's stick-figure "avatar", which is redrawn FROM the estimated angles (proving the
//     angles alone carry the pose).
// It mirrors exactly the conventions of anatomicalPose.ts (ISB Y-X-Y humerus, gravity-referenced
// trunk/hip angles). It is not the Anny rig (that is P1's job); it is a reference skeleton.

import {
  POSE_LANDMARK_COUNT,
  PL,
  add,
  cameraToMediapipe,
  forearmDirectionLocal,
  humerusDirectionLocal,
  rotX,
  rotY,
  rotZ,
  scale,
  type AnatomicalPose,
  type PoseLandmark,
  type PoseLandmarksInput,
  type Vec3,
} from './anatomicalPose';

/** Segment lengths (m). Defaults ≈ a 1.75 m adult (Winter, Biomechanics, segment fractions). */
export interface SkeletonSegments {
  /** mid-hip → mid-shoulder */
  trunk: number;
  shoulderHalfWidth: number;
  hipHalfWidth: number;
  upperArm: number;
  forearm: number;
  thigh: number;
  shank: number;
  /** mid-shoulder → nose */
  head: number;
}

export const DEFAULT_SEGMENTS: SkeletonSegments = {
  trunk: 0.5,
  shoulderHalfWidth: 0.19,
  hipHalfWidth: 0.1,
  upperArm: 0.3,
  forearm: 0.26,
  thigh: 0.45,
  shank: 0.43,
  head: 0.25,
};

export type JointName =
  | 'midHip'
  | 'lHip'
  | 'rHip'
  | 'lKnee'
  | 'rKnee'
  | 'lAnkle'
  | 'rAnkle'
  | 'midShoulder'
  | 'lShoulder'
  | 'rShoulder'
  | 'lElbow'
  | 'rElbow'
  | 'lWrist'
  | 'rWrist'
  | 'head';

/** Body-frame skeleton: X forward, Y up (gravity), Z subject's right; origin mid-hip. */
export type Skeleton = Record<JointName, Vec3>;

export const SKELETON_BONES: ReadonlyArray<[JointName, JointName]> = [
  ['lHip', 'rHip'],
  ['midHip', 'midShoulder'],
  ['lShoulder', 'rShoulder'],
  ['midShoulder', 'head'],
  ['lShoulder', 'lElbow'],
  ['lElbow', 'lWrist'],
  ['rShoulder', 'rElbow'],
  ['rElbow', 'rWrist'],
  ['lHip', 'lKnee'],
  ['lKnee', 'lAnkle'],
  ['rHip', 'rKnee'],
  ['rKnee', 'rAnkle'],
];

const RAD = Math.PI / 180;

/**
 * Builds the skeleton for a pose. Trunk orientation Rt = Rz(−flexion)·Rx(lateral)·Ry(twist)
 * (flexion tilts the trunk toward +X, lateral toward +Z = subject's right, twist turns the
 * shoulders toward the subject's left). The pelvis stays gravity-aligned; hip_flexion is the
 * thigh's sagittal angle from vertical; knee flexion bends the shank backward.
 * pelvis_drop_m does not move landmarks (they are hip-centred, like MediaPipe world landmarks);
 * it is implied by the leg angles with the feet on the floor.
 */
export function poseSkeleton(
  pose: AnatomicalPose,
  segments: SkeletonSegments = DEFAULT_SEGMENTS,
): Skeleton {
  const s = segments;
  const trunkRot = (v: Vec3): Vec3 =>
    rotZ(
      rotX(rotY(v, pose.trunk_twist * RAD), pose.trunk_lateral * RAD),
      -pose.trunk_flexion * RAD,
    );
  const tf = trunkRot([1, 0, 0]);
  const tu = trunkRot([0, 1, 0]);
  const ts = trunkRot([0, 0, 1]);
  const midHip: Vec3 = [0, 0, 0];
  const midShoulder = scale(tu, s.trunk);
  const lShoulder = add(midShoulder, scale(ts, -s.shoulderHalfWidth));
  const rShoulder = add(midShoulder, scale(ts, s.shoulderHalfWidth));
  const toBody = (l: Vec3, side: 'L' | 'R'): Vec3 => {
    const z = side === 'L' ? -l[2] : l[2];
    return add(add(scale(tf, l[0]), scale(tu, l[1])), scale(ts, z));
  };
  const arm = (side: 'L' | 'R', shoulder: Vec3) => {
    const d = humerusDirectionLocal(
      pose[`shoulder_${side}_plane`],
      pose[`shoulder_${side}_elevation`],
    );
    const w = forearmDirectionLocal(
      pose[`shoulder_${side}_plane`],
      pose[`shoulder_${side}_elevation`],
      pose[`shoulder_${side}_axial`],
      pose[`elbow_${side}_flexion`],
    );
    const elbow = add(shoulder, scale(toBody(d, side), s.upperArm));
    const wrist = add(elbow, scale(toBody(w, side), s.forearm));
    return { elbow, wrist };
  };
  const la = arm('L', lShoulder);
  const ra = arm('R', rShoulder);
  const leg = (side: 'L' | 'R') => {
    const hip: Vec3 = [0, 0, side === 'L' ? -s.hipHalfWidth : s.hipHalfWidth];
    const h = pose[`hip_${side}_flexion`] * RAD;
    const k = pose[`knee_${side}_flexion`] * RAD;
    const knee = add(hip, scale([Math.sin(h), -Math.cos(h), 0], s.thigh));
    const ankle = add(knee, scale([Math.sin(h - k), -Math.cos(h - k), 0], s.shank));
    return { hip, knee, ankle };
  };
  const ll = leg('L');
  const rl = leg('R');
  return {
    midHip,
    lHip: ll.hip,
    rHip: rl.hip,
    lKnee: ll.knee,
    rKnee: rl.knee,
    lAnkle: ll.ankle,
    rAnkle: rl.ankle,
    midShoulder,
    lShoulder,
    rShoulder,
    lElbow: la.elbow,
    rElbow: ra.elbow,
    lWrist: la.wrist,
    rWrist: ra.wrist,
    head: add(midShoulder, scale(tu, s.head)),
  };
}

/** Standing hip height above the ankles for these segments (straight legs). */
export const standingHipHeight = (s: SkeletonSegments = DEFAULT_SEGMENTS) => s.thigh + s.shank;

export interface SynthOptions {
  segments?: SkeletonSegments;
  /** Person's heading relative to the camera, degrees; + = turned to their left. */
  yawDeg?: number;
  /** Camera pitch, degrees (rotation of the whole scene about the camera X axis). */
  cameraPitchDeg?: number;
  /** Per-landmark visibility override (index → visibility). Default 1. */
  visibility?: Partial<Record<number, number>>;
  /** Deterministic noise: function returning a 3-vector offset (m) per landmark index. */
  noise?: (index: number) => Vec3;
  /** Orthographic image scale (normalised image units per metre). */
  imageScale?: number;
}

/** Body frame (X fwd, Y up, Z right) → camera frame C for a person facing the camera. */
export function bodyToCamera(b: Vec3, yawDeg = 0, cameraPitchDeg = 0): Vec3 {
  // Facing the camera: forward = +Z_C, up = +Y_C, subject's right = −X_C.
  const c: Vec3 = [-b[2], b[1], b[0]];
  return rotX(rotY(c, yawDeg * RAD), cameraPitchDeg * RAD);
}

/** Synthetic MediaPipe output (33 world + image landmarks) for a pose. */
export function synthesizeLandmarks(
  pose: AnatomicalPose,
  options: SynthOptions = {},
): PoseLandmarksInput {
  const sk = poseSkeleton(pose, options.segments);
  const at: Vec3[] = new Array<Vec3>(POSE_LANDMARK_COUNT).fill(sk.head);
  const set = (i: number, p: Vec3) => (at[i] = p);
  set(PL.lShoulder, sk.lShoulder);
  set(PL.rShoulder, sk.rShoulder);
  set(PL.lElbow, sk.lElbow);
  set(PL.rElbow, sk.rElbow);
  set(PL.lWrist, sk.lWrist);
  set(PL.rWrist, sk.rWrist);
  for (const i of [17, 19, 21]) set(i, sk.lWrist);
  for (const i of [18, 20, 22]) set(i, sk.rWrist);
  set(PL.lHip, sk.lHip);
  set(PL.rHip, sk.rHip);
  set(PL.lKnee, sk.lKnee);
  set(PL.rKnee, sk.rKnee);
  set(PL.lAnkle, sk.lAnkle);
  set(PL.rAnkle, sk.rAnkle);
  set(PL.lHeel, add(sk.lAnkle, [-0.05, -0.05, 0]));
  set(PL.rHeel, add(sk.rAnkle, [-0.05, -0.05, 0]));
  set(PL.lFoot, add(sk.lAnkle, [0.15, -0.06, 0]));
  set(PL.rFoot, add(sk.rAnkle, [0.15, -0.06, 0]));
  const imageScale = options.imageScale ?? 0.4;
  const world: PoseLandmark[] = [];
  const image: PoseLandmark[] = [];
  at.forEach((b, i) => {
    let c = bodyToCamera(b, options.yawDeg, options.cameraPitchDeg);
    if (options.noise) c = add(c, options.noise(i));
    const visibility = options.visibility?.[i] ?? 1;
    world.push({ ...cameraToMediapipe(c), visibility });
    image.push({
      x: 0.5 + c[0] * imageScale,
      y: 0.5 - c[1] * imageScale,
      z: -c[2] * imageScale,
      visibility,
    });
  });
  return { world, image };
}
