// Screen-space arm fit (agent V2): corrects the arm DOFs of the smoothed anatomical pose so the
// posed elbows and wrists land on the person's 2D landmarks, i.e. the sleeves follow the REAL arms
// in the picture (live test: "it does not hug the body ... just an image stuck onto me").
//
// Per arm, with the camera of the last AR solve:
//   E' = the point on the camera ray through the elbow landmark at the upper-arm length from the
//        posed shoulder, nearest the posed elbow (keeps the depth the pose had: depth is what one
//        camera cannot see);
//   W' = the same for the wrist, from E', at the forearm length.
// The corrected shoulder→elbow and elbow→wrist directions are expressed in the posed thorax frame
// and converted to contract DOFs (plane, elevation, axial, elbow flexion) with the vision
// package's own ISB inverse (armAnglesFromLocal): the same convention the rig poses with, so the
// mirror, the jacket binding and V3's bake stay consistent. Corrections are limited per frame,
// weighted by landmark visibility, spike-guarded (no smoothing: the engine smooths upstream).
import { armAnglesFromLocal, OneEuroFilter } from '@satisfy/vision';
import type { AnatomicalPose } from '../../motion/rig';
import type { LiveFrame } from '../contract';
import type { ArSolution } from './ArTracker';
import { viewMatrix, type Vec3 } from './cameraModel';
import { MIN_VISIBILITY } from './config';

/** Newton-style correction passes after the first conversion (one FK call each). */
export const SCREEN_FIT_PASSES = 2;
/**
 * Largest change of one fitted arm DOF from one frame to the next (degrees): a wild landmark
 * cannot flip the arm. Relative to the fit's own previous output, NOT to the tracker's pose:
 * capping relative to the tracker held hanging arms ~30° short (plane −86° wanted, −58° sent).
 */
export const MAX_ARM_CORRECTION_DEG = 40;
/**
 * Under the hybrid AR the 2D glue makes the pixel match, so the 3D arm fit is conservative:
 * how much of each correction is applied (priors toward the tracker): plane and axial are poorly
 * observed from one camera and flipped branches live (15:12 recording: |adjusted − raw| 50–70°).
 */
export const ARM_CORRECTION_WEIGHT: Record<string, number> = {
  // Full weight: with partial plane/axial weights (0.5/0.3) hanging, bent arms stayed splayed
  // (cam-tshirt 1.5–2.5 s: plane −83° wanted, −35° sent; elbows 55–105 px, wrists 126–162 px
  // off), beyond what the glue can absorb within its ±15 % scale cap. Flips are prevented by the
  // branch-continuity hints and the per-frame slew, not by under-correcting.
  plane: 1,
  elevation: 1,
  axial: 1,
  flexion: 1,
};

type V = Vec3;
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: V) => Math.sqrt(dot(a, a));
const unit = (a: V): V => mul(a, 1 / (len(a) || 1));

/** The camera ray of image point (u, v): origin (scene m) and unit direction. */
export function cameraRay(s: ArSolution, u: number, v: number): { o: V; d: V } {
  const M = viewMatrix(s.pose, s.pivot);
  // p_cam = R·X + t  ⇒  centre C = −Rᵀt, scene direction = Rᵀ·dir_cam.
  const R = [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]];
  const t: V = [M[3], M[7], M[11]];
  const o: V = [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
  const K = s.intrinsics;
  const c: V = [(u - K.cx) / K.f, (v - K.cy) / K.f, 1];
  const d: V = [
    R[0] * c[0] + R[3] * c[1] + R[6] * c[2],
    R[1] * c[0] + R[4] * c[1] + R[7] * c[2],
    R[2] * c[0] + R[5] * c[1] + R[8] * c[2],
  ];
  return { o, d: unit(d) };
}

/**
 * The point on ray (o, d) at distance `r` from `centre`, nearest `near`; when the ray misses that
 * sphere, the point at distance r from the centre toward the ray's closest approach.
 */
export function reaches(o: V, d: V, centre: V, r: number) {
  const oc = sub(o, centre);
  const b = dot(d, oc);
  return b * b - (dot(oc, oc) - r * r) >= 0;
}

export function rayOnSphere(o: V, d: V, centre: V, r: number, near: V): V {
  const oc = sub(o, centre);
  const b = dot(d, oc);
  const disc = b * b - (dot(oc, oc) - r * r);
  if (disc < 0) {
    const closest = add(o, mul(d, -b));
    return add(centre, mul(unit(sub(closest, centre)), r));
  }
  const q = Math.sqrt(disc);
  const p1 = add(o, mul(d, -b - q)),
    p2 = add(o, mul(d, -b + q));
  return len(sub(p1, near)) <= len(sub(p2, near)) ? p1 : p2;
}

/** Side-local ISB frame of one arm (anatomicalPose.ts): x forward, y up, z lateral (mirrored L). */
export function sideFrame(j: Record<string, V>, side: 'L' | 'R') {
  const up = unit(sub(mid(j.lShoulder, j.rShoulder), mid(j.lHip, j.rHip)));
  const leftRaw = sub(j.lShoulder, j.rShoulder);
  const left = unit(sub(leftRaw, mul(up, dot(leftRaw, up))));
  const forward = cross(left, up); // scene: X left × Y up = +Z front
  const lateral = side === 'L' ? left : mul(left, -1);
  return (v: V): V => [dot(v, forward), dot(v, up), dot(v, lateral)];
}
const mid = (a: V, b: V): V => mul(add(a, b), 0.5);

/**
 * Arm angles with the vision inverse, the gimbal referenced to the PREVIOUS fitted plane: near the
 * gimbal (a hanging arm) the plane is ill-defined and follows its own history instead of jumping
 * (V1 measured elevation p90 33°/frame flips with an "exact" plane). The glue's sleeve layers do
 * the pixel placement of a hanging arm.
 */
function continuousArmAngles(d: V, w: V, previousPlane: number, previousAxial: number) {
  return armAnglesFromLocal(d, w, previousPlane, previousAxial);
}

/**
 * The ray's intersection with the bone sphere on a given BRANCH: −1 = the one nearer the camera,
 * +1 = the farther one. Both project onto the same pixel, so the 2D cannot choose: the previous
 * branch is kept (no flips); without one, the intersection nearest `near`. Where the ray misses
 * the sphere the two branches merge (closest approach, branch 0), so a change there is continuous.
 */
export function rayOnSphereBranch(
  o: V,
  d: V,
  centre: V,
  r: number,
  previous: -1 | 0 | 1 | undefined,
  near: V,
): { point: V; branch: -1 | 0 | 1 } {
  const oc = sub(o, centre);
  const b = dot(d, oc);
  const disc = b * b - (dot(oc, oc) - r * r);
  if (disc < 0) {
    const closest = add(o, mul(d, -b));
    return { point: add(centre, mul(unit(sub(closest, centre)), r)), branch: 0 };
  }
  const q = Math.sqrt(disc);
  const nearP = add(o, mul(d, -b - q)),
    farP = add(o, mul(d, -b + q));
  if (previous === -1 || previous === 1)
    return previous === -1 ? { point: nearP, branch: -1 } : { point: farP, branch: 1 };
  return len(sub(nearP, near)) <= len(sub(farP, near))
    ? { point: nearP, branch: -1 }
    : { point: farP, branch: 1 };
}

/**
 * Depth prior (F3, ?f3arms=1): MediaPipe's world landmarks give each joint's depth relative to
 * its parent (m, + = farther from the lens). Where the two ray–sphere branches lie more than
 * DEPTH_PRIOR_MIN_SPLIT_M apart in depth and the world depth step is beyond DEPTH_PRIOR_MIN_M,
 * the branch whose depth step agrees with it is taken; the previous branch is left only when the
 * other agrees better by DEPTH_PRIOR_HYSTERESIS_M. Without it a forearm crossing the chest could
 * keep the branch it had when the arm hung (where the branches merge) and end up behind, inside
 * the posed torso: its sleeve is then cut by the body's depth (D3). Heuristic thresholds.
 */
export const DEPTH_PRIOR_MIN_SPLIT_M = 0.04;
/** One Euro on the world depth steps (m): ≈ 1 Hz at rest, ≈ 5 Hz for a 1 m/s arm move. */
export const WORLD_STEP_SMOOTH = { minCutoff: 1, beta: 4, dCutoff: 1 };
export const DEPTH_PRIOR_MIN_M = 0.05;
export const DEPTH_PRIOR_HYSTERESIS_M = 0.03;
/**
 * When even the chosen branch's depth step is this far (m) from the world landmarks' step, the
 * rig's limb is longer than the person's in the picture (the fallback body's proportions, or the
 * solve's scale): the ray–sphere hit then fakes the length by foreshortening (a crossed upper arm
 * read 57° of elevation where the world landmarks said ≈ 25°, and the engine's hanging-arm cap
 * then threw the forearm 150 px off). The joint is then placed along the direction to the point
 * on its landmark ray at the world depth: the 2D direction stays exact, its 2D length absorbs the
 * mismatch (which the sleeve glue then takes up). Heuristic.
 */
export const DEPTH_DIRECTION_MIN_M = 0.06;
/**
 * ... and only when the world landmarks put the joint clearly in front of or behind its parent
 * (|step| beyond this, m): for a hanging upper arm the depth is ambiguous and matters little,
 * while its 2D placement matters (the puffer's still window: a 3.7 cm step moved a 2D-exact
 * elbow and left the wrist 80 px off). Heuristic.
 */
export const DEPTH_DIRECTION_MIN_STEP_M = 0.08;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The joint at `length` from `parent`: the ray–sphere `hit` blended toward the direction of the
 * point on the joint's ray at the world depth step, by how clearly the world landmarks place the
 * joint forward/back and how much the hit disagrees (continuous: a hard switch flipped between
 * the two frame to frame and the step gate then held the joint off its ray, 60–80 px).
 */
export function depthBlend(
  hit: V,
  parent: V,
  length: number,
  o: V,
  d: V,
  worldStep: number | null,
  depthOf: (p: V) => number,
): { point: V; weight: number } {
  if (worldStep === null) return { point: hit, weight: 0 };
  const disagree = Math.abs(depthOf(hit) - depthOf(parent) - worldStep);
  const w =
    smoothstep(
      DEPTH_DIRECTION_MIN_STEP_M - 0.02,
      DEPTH_DIRECTION_MIN_STEP_M + 0.02,
      Math.abs(worldStep),
    ) * smoothstep(DEPTH_DIRECTION_MIN_M - 0.03, DEPTH_DIRECTION_MIN_M + 0.03, disagree);
  if (w <= 0) return { point: hit, weight: 0 };
  const at = rayAtDepth(o, d, depthOf(parent) + worldStep, depthOf);
  if (!at) return { point: hit, weight: 0 };
  const a = unit(sub(hit, parent)),
    b = unit(sub(at, parent));
  const dir = unit(add(mul(a, 1 - w), mul(b, w)));
  return { point: add(parent, mul(dir, length)), weight: w };
}

/** The point on ray (o, d) whose camera depth is `depth` (depthOf affine; the lens at depth 0). */
export function rayAtDepth(o: V, d: V, depth: number, depthOf: (p: V) => number): V | null {
  const step = depthOf(add(o, d)) - depthOf(o);
  if (Math.abs(step) < 1e-6) return null;
  const t = (depth - depthOf(o)) / step;
  return t > 0 ? add(o, mul(d, t)) : null;
}

/**
 * In-plane bone (F3, ?f3arms=1; F4T 00:1x: raised sleeves dark): when a bone's 2D length is at
 * least this share of what the rig's bone would project to at its parent's depth, the bone lies
 * near the image plane: it is placed in that plane, along the direction to the closest point of its landmark
 * ray, instead of on a ray–sphere branch or toward MediaPipe's world depth. MediaPipe puts arms
 * held out to the side 10–20 cm in front of the shoulders; the depth prior then pointed the
 * sleeve toward the lens, rendered at a grazing angle to the key light (no key, fill only:
 * luminance 0.40–0.54 vs the torso's 0.78) and stretched onto the arm in 2D. 0.7: the lab body's
 * bones are longer than the person's in the picture, arms held straight out read 0.79–0.81
 * (live-puffer 13.5 s), and a bone tilted 40 deg toward the lens reads 0.77 x that. Heuristic.
 */
export const IN_PLANE_RATIO = 0.7;

/** The joint at `length` from `parent` toward the closest point of ray (o, d): image-parallel. */
export function inPlaneJoint(o: V, d: V, parent: V, length: number): V {
  const t = dot(sub(parent, o), d);
  const closest = add(o, mul(d, t));
  const dir = sub(closest, parent);
  return len(dir) < 1e-9 ? parent : add(parent, mul(unit(dir), length));
}

/**
 * 2D length of a bone / the rig bone's projected length at the parent's depth (px / px); 0 for a
 * bone pointing more down than sideways in the image (image y grows downward).
 */
export function inPlaneRatio(
  a: { x: number; y: number },
  b: { x: number; y: number },
  length: number,
  depth: number,
  focal: number,
): number {
  if (!(depth > 0.05) || !(length > 0)) return 0;
  // Raised bones only (more sideways or up than down in the image): a hanging arm's depth (in
  // front of / behind the body) is what the depth prior is for (D3, crossed forearms).
  if (b.y - a.y >= Math.abs(b.x - a.x)) return 0;
  return Math.hypot(b.x - a.x, b.y - a.y) / ((length * focal) / depth);
}

/** The branch the depth prior picks (−1 near, +1 far), or undefined (no opinion). */
export function depthPriorBranch(
  depthOf: (p: V) => number,
  o: V,
  d: V,
  centre: V,
  r: number,
  wantStep: number | null,
  previous: -1 | 0 | 1 | undefined,
): -1 | 1 | undefined {
  if (wantStep === null || Math.abs(wantStep) < DEPTH_PRIOR_MIN_M) return undefined;
  const oc = sub(o, centre);
  const b = dot(d, oc);
  const disc = b * b - (dot(oc, oc) - r * r);
  if (disc <= 0) return undefined;
  const q = Math.sqrt(disc);
  const c = depthOf(centre);
  const nearStep = depthOf(add(o, mul(d, -b - q))) - c,
    farStep = depthOf(add(o, mul(d, -b + q))) - c;
  if (Math.abs(farStep - nearStep) < DEPTH_PRIOR_MIN_SPLIT_M) return undefined;
  const eNear = Math.abs(nearStep - wantStep),
    eFar = Math.abs(farStep - wantStep);
  if (previous === -1 && eNear <= eFar + DEPTH_PRIOR_HYSTERESIS_M) return -1;
  if (previous === 1 && eFar <= eNear + DEPTH_PRIOR_HYSTERESIS_M) return 1;
  return eNear <= eFar ? -1 : 1;
}

/** Largest 3D step (m) of a fitted elbow/wrist between frames, beyond what its landmark moved. */
export const MAX_JOINT_STEP_M = 0.08;

export type ArmFitReport = {
  /** Arms corrected this frame. */
  sides: ('L' | 'R')[];
  /** Per arm: did the elbow / wrist landmark ray reach the bone-length sphere (else unreachable). */
  reach: Partial<Record<'L' | 'R', { elbow: boolean; wrist: boolean | null }>>;
  /** Diagnostics: per arm, target DOFs, the DOFs sent, and what the rig produced from them. */
  debug?: Record<string, { target: number[]; sent: number[]; got: number[] }>;
  /** Per joint error after the fit (px). */
  afterJointPx: Partial<Record<'lElbow' | 'rElbow' | 'lWrist' | 'rWrist', number>>;
  /** Mean landmark error of elbows/wrists before and after (px), from one FK check. */
  beforePx: number | null;
  afterPx: number | null;
};

export class ScreenFit {
  private previousOut = new Map<string, number>();
  /** The last fitted elbow / wrist (scene m): the branch hint, so the fit continues, not jumps. */
  private previousJoints: Record<string, V> = {};
  /** The ray–sphere branch each elbow / wrist was on last frame. */
  private branches: Record<string, -1 | 0 | 1> = {};
  /** The landmark each elbow / wrist followed last frame (px), for the 3D step gate. */
  private previousLandmark: Record<string, { x: number; y: number }> = {};
  last: ArmFitReport | null = null;
  /** F3 (?f3arms=1): choose ray–sphere branches by MediaPipe's world depth (see above). */
  depthPrior = false;
  /** With depthPrior: in-plane bones (IN_PLANE_RATIO); `?f3plane=0` turns only this off (A/B). */
  inPlane =
    typeof location === 'undefined' || new URLSearchParams(location.search).get('f3plane') !== '0';
  private stepFilters = new Map<string, OneEuroFilter>();
  /** Blend the wrist toward the world depth too (off: measured worse, see adjust()). */
  wristDepthBlend = false;
  /** Branch changes the depth prior made (count; diagnostics). */
  depthPriorSwitches = 0;
  /**
   * Last frame, per arm: the world depth steps used (m; null = not available) and whether the
   * elbow / wrist came from the ray–sphere hit or the world-depth direction (diagnostics).
   */
  depthDebug: Partial<
    Record<'L' | 'R', { se: number | null; ew: number | null; elbow: number; wrist: number }>
  > = {};

  reset() {
    this.previousOut.clear();
    this.stepFilters.clear();
    this.previousJoints = {};
    this.branches = {};
    this.previousLandmark = {};
    this.last = null;
  }

  /**
   * The pose with its arm DOFs corrected toward the landmarks, or null (nothing to correct).
   * `fk` = LiveAvatar.fkJoints: posed joint positions of a candidate pose (no skinning).
   */
  adjust(
    frame: LiveFrame,
    pose: AnatomicalPose,
    solution: ArSolution | null,
    fk: (pose: AnatomicalPose) => Record<string, V>,
  ): AnatomicalPose | null {
    const l = frame.landmarks2d;
    // No camera, or a degenerate one (a person is 0.6–6 m from the lens): leave the pose alone.
    if (!l || !solution || solution.pose.t[2] < 0.6 || solution.pose.t[2] > 6) {
      this.last = null;
      return null;
    }
    const joints = fk(pose);
    if (!joints.lShoulder || !joints.rShoulder || !joints.lHip || !joints.rHip) return null;
    const out: AnatomicalPose = { ...pose };
    const sides: ('L' | 'R')[] = [];
    type Target = {
      side: 'L' | 'R';
      dofs: [string, number, boolean][];
      weight: number;
      local: (v: V) => V;
    };
    const targets: Target[] = [];
    const reach: ArmFitReport['reach'] = {};
    for (const side of ['L', 'R'] as const) {
      const lower = side.toLowerCase();
      const S = joints[`${lower}Shoulder`],
        E = joints[`${lower}Elbow`],
        W = joints[`${lower}Wrist`];
      const le = l[side === 'L' ? 13 : 14],
        lw = l[side === 'L' ? 15 : 16];
      if (!S || !E || !W || !le || le.visibility < MIN_VISIBILITY) continue;
      if (le.x < 0 || le.y < 0 || le.x > frame.width || le.y > frame.height) continue;
      const upper = len(sub(E, S)),
        fore = len(sub(W, E));
      const re = cameraRay(solution, le.x, le.y);
      const hintE = this.previousJoints[`${lower}Elbow`] ?? E,
        hintW = this.previousJoints[`${lower}Wrist`];
      // Continuity: same ray–sphere branch as last frame, and no 3D step larger than the landmark's
      // own motion allows (+ MAX_JOINT_STEP_M).
      const gate = (key: string, P: V, lm: { x: number; y: number }, prev: V | undefined): V => {
        const last = this.previousLandmark[key];
        this.previousLandmark[key] = { x: lm.x, y: lm.y };
        if (!prev || !last) return P;
        const M = viewMatrix(solution.pose, solution.pivot);
        const z = Math.max(0.3, M[8] * P[0] + M[9] * P[1] + M[10] * P[2] + M[11]);
        const moved = (Math.hypot(lm.x - last.x, lm.y - last.y) * z) / solution.intrinsics.f;
        const allowed = MAX_JOINT_STEP_M + 1.5 * moved;
        const step = len(sub(P, prev));
        return step <= allowed ? P : add(prev, mul(sub(P, prev), allowed / step));
      };
      // F3 depth prior: the world landmarks' depth step shoulder → elbow and elbow → wrist.
      const world = this.depthPrior ? frame.world : null;
      // World depth steps, One Euro filtered per joint pair: MediaPipe's z jitters by 2–3 cm a
      // frame at rest, which moved the depth blend and so the sleeves of a still person (F3 rest
      // check, cam-still: distinct-frame diff p90 2.8 -> 4.4 with the raw steps).
      const step = (a: number, b: number) => {
        const wa = world?.[a],
          wb = world?.[b];
        if (!wa || !wb || Math.min(wa.visibility, wb.visibility) < MIN_VISIBILITY) return null;
        const key = `${a}-${b}`;
        let f = this.stepFilters.get(key);
        if (!f) this.stepFilters.set(key, (f = new OneEuroFilter(WORLD_STEP_SMOOTH)));
        return f.filter(wb.z - wa.z, frame.t);
      };
      const Mv = viewMatrix(solution.pose, solution.pivot);
      const depthOf = (P: V) => Mv[8] * P[0] + Mv[9] * P[1] + Mv[10] * P[2] + Mv[11];
      const preferE = this.depthPrior
        ? depthPriorBranch(
            depthOf,
            re.o,
            re.d,
            S,
            upper,
            step(side === 'L' ? 11 : 12, side === 'L' ? 13 : 14),
            this.branches[`${lower}Elbow`],
          )
        : undefined;
      if (preferE !== undefined && preferE !== this.branches[`${lower}Elbow`]) {
        this.branches[`${lower}Elbow`] = preferE;
        this.depthPriorSwitches++;
      }
      const hitE = rayOnSphereBranch(re.o, re.d, S, upper, this.branches[`${lower}Elbow`], hintE);
      this.branches[`${lower}Elbow`] = hitE.branch;
      const stepSE = this.depthPrior ? step(side === 'L' ? 11 : 12, side === 'L' ? 13 : 14) : null;
      const blendE = depthBlend(hitE.point, S, upper, re.o, re.d, stepSE, depthOf);
      const ls = l[side === 'L' ? 11 : 12];
      const planeE =
        this.depthPrior && this.inPlane && !!ls && ls.visibility >= MIN_VISIBILITY
          ? inPlaneRatio(ls, le, upper, depthOf(S), solution.intrinsics.f) >= IN_PLANE_RATIO
          : false;
      const elbowAt = planeE ? inPlaneJoint(re.o, re.d, S, upper) : blendE.point;
      const dbg = { se: stepSE, ew: null as number | null, elbow: blendE.weight, wrist: 0 };
      if (this.depthPrior) this.depthDebug[side] = dbg;
      const E2 = gate(`${lower}Elbow`, elbowAt, le, this.previousJoints[`${lower}Elbow`]);
      reach[side] = { elbow: reaches(re.o, re.d, S, upper), wrist: null };
      let W2: V;
      const wristSeen =
        !!lw &&
        lw.visibility >= MIN_VISIBILITY &&
        lw.x >= 0 &&
        lw.y >= 0 &&
        lw.x <= frame.width &&
        lw.y <= frame.height;
      if (wristSeen) {
        const rw = cameraRay(solution, lw.x, lw.y);
        const preferW = this.depthPrior
          ? depthPriorBranch(
              depthOf,
              rw.o,
              rw.d,
              E2,
              fore,
              step(side === 'L' ? 13 : 14, side === 'L' ? 15 : 16),
              this.branches[`${lower}Wrist`],
            )
          : undefined;
        if (preferW !== undefined && preferW !== this.branches[`${lower}Wrist`]) {
          this.branches[`${lower}Wrist`] = preferW;
          this.depthPriorSwitches++;
        }
        const hitW = rayOnSphereBranch(
          rw.o,
          rw.d,
          E2,
          fore,
          this.branches[`${lower}Wrist`],
          hintW ?? add(W, sub(E2, E)),
        );
        this.branches[`${lower}Wrist`] = hitW.branch;
        const stepEW = this.depthPrior
          ? step(side === 'L' ? 13 : 14, side === 'L' ? 15 : 16)
          : null;
        dbg.ew = stepEW;
        // The wrist keeps its 2D-exact hit (the world depth only picks its branch, above): a
        // wrist blend left resting hands 60 px off on the puffer still (the forearm's world step
        // −10 cm disagreed with the rig's) while the sleeve is judged in 2D.
        // The forearm only with a raised upper arm: crossed forearms (upper arm down) keep the
        // depth prior that puts them in front of the chest.
        const planeW =
          planeE &&
          inPlaneRatio(le, lw, fore, depthOf(E2), solution.intrinsics.f) >= IN_PLANE_RATIO;
        const wristAt = planeW
          ? inPlaneJoint(rw.o, rw.d, E2, fore)
          : this.wristDepthBlend
            ? depthBlend(hitW.point, E2, fore, rw.o, rw.d, stepEW, depthOf).point
            : hitW.point;
        W2 = gate(`${lower}Wrist`, wristAt, lw, hintW);
        reach[side]!.wrist = reaches(rw.o, rw.d, E2, fore);
      } else W2 = add(E2, sub(W, E)); // forearm keeps its direction
      const local = sideFrame(joints, side);
      const angles = continuousArmAngles(
        local(sub(E2, S)),
        local(sub(W2, E2)),
        this.previousOut.get(`shoulder_${side}_plane`) ?? pose[`shoulder_${side}_plane`] ?? 0,
        this.previousOut.get(`shoulder_${side}_axial`) ?? pose[`shoulder_${side}_axial`] ?? 0,
      );
      targets.push({
        side,
        local,
        weight: Math.min(1, le.visibility),
        dofs: [
          [`shoulder_${side}_plane`, angles.plane, true],
          [`shoulder_${side}_elevation`, angles.elevation, true],
          [`shoulder_${side}_axial`, angles.axial, wristSeen],
          [`elbow_${side}_flexion`, angles.elbowFlexion, wristSeen],
        ],
      });
      sides.push(side);
    }
    // Newton-style passes: pose the candidate, read the directions the RIG actually produced, and
    // correct the DOFs by the angle gap (cancels any convention difference between the rig and the
    // vision package's inverse). One FK call per pass.
    const wrap = (d: number) => ((d + 540) % 360) - 180;
    const cur: AnatomicalPose = { ...pose };
    for (const t of targets)
      for (const [dof, target, on] of t.dofs) if (on && cur[dof] !== undefined) cur[dof] = target;
    for (let pass = 0; pass < SCREEN_FIT_PASSES && targets.length; pass++) {
      const jk = fk(cur);
      for (const t of targets) {
        const lower = t.side.toLowerCase();
        const Sk = jk[`${lower}Shoulder`],
          Ek = jk[`${lower}Elbow`],
          Wk = jk[`${lower}Wrist`];
        if (!Sk || !Ek || !Wk) continue;
        const got = continuousArmAngles(
          t.local(sub(Ek, Sk)),
          t.local(sub(Wk, Ek)),
          cur[`shoulder_${t.side}_plane`] ?? 0,
          cur[`shoulder_${t.side}_axial`] ?? 0,
        );
        const gotOf: Record<string, number> = {
          [`shoulder_${t.side}_plane`]: got.plane,
          [`shoulder_${t.side}_elevation`]: got.elevation,
          [`shoulder_${t.side}_axial`]: got.axial,
          [`elbow_${t.side}_flexion`]: got.elbowFlexion,
        };
        for (const [dof, target, on] of t.dofs) {
          if (!on || cur[dof] === undefined) continue;
          const gap =
            dof.endsWith('plane') || dof.endsWith('axial')
              ? wrap(target - gotOf[dof])
              : target - gotOf[dof];
          cur[dof] += gap;
        }
      }
    }
    for (const t of targets)
      for (const [dof, , on] of t.dofs) {
        const was = pose[dof];
        if (!on || was === undefined) continue;
        const circular = dof.endsWith('plane') || dof.endsWith('axial');
        // Visibility-weighted blend from the tracker's value toward the fitted one…
        const kind = dof.endsWith('plane')
          ? 'plane'
          : dof.endsWith('axial')
            ? 'axial'
            : dof.endsWith('elevation')
              ? 'elevation'
              : 'flexion';
        const w = t.weight * ARM_CORRECTION_WEIGHT[kind];
        let target = was + (circular ? wrap(cur[dof] - was) : cur[dof] - was) * w;
        // …limited per frame relative to the fit's own previous output (spike guard).
        const prev = this.previousOut.get(dof);
        if (prev !== undefined) {
          const step = circular ? wrap(target - prev) : target - prev;
          target = prev + Math.max(-MAX_ARM_CORRECTION_DEG, Math.min(MAX_ARM_CORRECTION_DEG, step));
        }
        // No smoothing filter and no slew here: they put 330–370 ms of lag between the engine's
        // smoothed pose and the adjusted one (V1, user's 15:18 recording). The engine smooths
        // upstream; this is only a spike guard (> MAX_ARM_CORRECTION_DEG per frame).
        // Circular DOFs stay continuous frame to frame (NOT wrapped to ±180: a wrapped output
        // that crossed ±180 made the engine's linear median/slew filter swing the long way round,
        // fit error 53-99 -> 109-229 px at the arms-up onset in every f3 judge run, 7.2-7.5 s).
        // The engine's capFit must compare them wrap-aware (requested from F1).
        const value = target;
        this.previousOut.set(dof, value);
        out[dof] = value;
      }
    if (!sides.length) {
      this.last = { sides, reach, afterJointPx: {}, beforePx: null, afterPx: null };
      return null;
    }
    // One FK check: the elbows' and wrists' landmark error before and after (honest readout).
    const after = fk(out);
    const debug: NonNullable<ArmFitReport['debug']> = {};
    for (const t of targets) {
      const lower = t.side.toLowerCase();
      const Sa = after[`${lower}Shoulder`],
        Ea = after[`${lower}Elbow`],
        Wa = after[`${lower}Wrist`];
      if (!Sa || !Ea || !Wa) continue;
      const g = continuousArmAngles(
        t.local(sub(Ea, Sa)),
        t.local(sub(Wa, Ea)),
        out[`shoulder_${t.side}_plane`] ?? 0,
        out[`shoulder_${t.side}_axial`] ?? 0,
      );
      debug[t.side] = {
        target: t.dofs.map(([, v]) => Math.round(v)),
        sent: t.dofs.map(([d]) => Math.round(out[d] ?? NaN)),
        got: [g.plane, g.elevation, g.axial, g.elbowFlexion].map(Math.round),
      };
    }
    for (const side of sides) {
      const lower = side.toLowerCase();
      if (after[`${lower}Elbow`]) this.previousJoints[`${lower}Elbow`] = after[`${lower}Elbow`];
      if (after[`${lower}Wrist`]) this.previousJoints[`${lower}Wrist`] = after[`${lower}Wrist`];
    }
    const afterJointPx: ArmFitReport['afterJointPx'] = {};
    armError(after, l, solution, afterJointPx);
    this.last = {
      sides,
      reach,
      afterJointPx,
      debug,
      beforePx: armError(joints, l, solution),
      afterPx: armError(after, l, solution),
    };
    return out;
  }
}

function armError(
  j: Record<string, V>,
  l: NonNullable<LiveFrame['landmarks2d']>,
  s: ArSolution,
  perJoint?: ArmFitReport['afterJointPx'],
) {
  const M = viewMatrix(s.pose, s.pivot);
  const K = s.intrinsics;
  let sum = 0,
    n = 0;
  for (const [name, i] of [
    ['lElbow', 13],
    ['rElbow', 14],
    ['lWrist', 15],
    ['rWrist', 16],
  ] as const) {
    const X = j[name],
      p = l[i];
    if (!X || !p || p.visibility < MIN_VISIBILITY) continue;
    const x = M[0] * X[0] + M[1] * X[1] + M[2] * X[2] + M[3];
    const y = M[4] * X[0] + M[5] * X[1] + M[6] * X[2] + M[7];
    const z = M[8] * X[0] + M[9] * X[1] + M[10] * X[2] + M[11];
    if (z <= 0) continue;
    const e = Math.hypot((K.f * x) / z + K.cx - p.x, (K.f * y) / z + K.cy - p.y);
    if (perJoint) perJoint[name] = e;
    sum += e;
    n++;
  }
  return n ? sum / n : null;
}
