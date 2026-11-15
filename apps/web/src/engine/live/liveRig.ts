// Live rig evaluation (prompt 14, V1): AnatomicalPose → Anny's posed skeleton and the 18 driver
// skinning matrices, on the client at camera rate. A faithful port of P1's
// services/body/body_service/motion/rig.py `pose_skeleton` (with angles.clamp_pose and the
// motion/config.py constants it uses), proven against P1's frames.bin in liveRig.test.ts.
//
// Scene frame (FORMAT.md): metres, X = the subject's LEFT, Y up, +Z front, feet on Y = 0.
// Angles are contract degrees (prompts/motion-contract.md). World bone poses are row-major 4×4;
// driver matrices are the top three rows of T = W · R⁻¹ in rig.drivers order, the same layout
// as frames.bin `driver_matrices`, so rig.ts skinVertices consumes them directly. Pure, no DOM.
import { decodeSatb } from '../motion/satb.ts';
import {
  invertAffine,
  parseRig,
  skinVertices,
  type AnatomicalPose,
  type MotionRig,
} from '../motion/rig.ts';

// ---- Constants: mirrors of services/body/body_service/motion/config.py (motion-rig-v1) ------
// Sources are documented there; keep these in step with it (the parity test fails otherwise).

/** Anatomical limits (degrees), config.LIMITS_DEG: AAOS normal ROM, contract ranges. */
export const LIVE_LIMITS_DEG: Record<string, [number, number]> = {
  trunk_flexion: [-25, 90],
  trunk_lateral: [-35, 35],
  trunk_twist: [-45, 45],
  shoulder_plane: [-90, 135],
  shoulder_elevation: [0, 180],
  shoulder_axial: [-90, 90],
  elbow_flexion: [0, 150],
  hip_flexion: [-30, 120],
  knee_flexion: [0, 140],
};
/** The contract DOFs in angles.py field order (clamp reports follow this order). */
export const LIVE_DOFS = [
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
export const LIVE_RIG_VERSION = 'motion-rig-v1';
const PELVIC_FLEXION_SHARE = 0.55; // lumbopelvic rhythm (Esola et al. 1996)
const SPINE_BONES = ['spine05', 'spine04', 'spine03', 'spine02', 'spine01'];
const SPINE_FLEXION_ROM = [36, 29, 24, 33, 31]; // White & Panjabi, per Anny spine bone
const SPINE_LATERAL_ROM = [9, 14, 14, 28, 41];
const SPINE_TWIST_ROM = [3, 4, 4, 14, 57];
const THORAX_BONE = 'spine01';
const TRUNK_SOLVE_ITERATIONS = 8;
const TRUNK_SOLVE_TOLERANCE_DEG = 0.01;
const GIRDLE_SETTING_PHASE_DEG = 30; // Inman et al. 1944
const CLAVICLE_ELEVATION_RATIO = 0.1; // Ludewig et al. 2009
const SOLE_BAND_M = 0.03;
const DEG = Math.PI / 180;

type Vec3 = [number, number, number];
/** 3×3 row-major. */
type M3 = Float64Array;

export type LiveRig = {
  rig: MotionRig;
  parents: Int32Array;
  /** (B, 4, 4) rest world poses, float64 copy of rig.restWorld. */
  rest: Float64Array;
  /** (B, 3, 4) inverse rest poses (top three rows). */
  restInverse: Float64Array;
  /** Bone ids of each bone's subtree (itself included). */
  subtree: Int32Array[];
  index: Map<string, number>;
  /** Calibrated reference frame (scene axes), as build_rig. */
  vertical: Vec3;
  right: Vec3;
  forward: Vec3;
  humerus: Record<'L' | 'R', { frame: M3; flexion: number }>;
  /** Sole candidate vertices for foot planting. */
  footVertices: Uint32Array;
  spineShares: [number[], number[], number[]];
};

export type TrunkSolverState = {
  drive?: Float64Array;
  target?: Float64Array;
  jacobian?: Float64Array | null;
};

export type PoseClamp = { dof: string; requested: number; applied: number };

export type PoseResult = {
  /** Clamped full pose with the solved pelvis_drop_m. */
  pose: AnatomicalPose;
  clamps: PoseClamp[];
  /** (104 × 16) posed world bone matrices, row-major 4×4. */
  world: Float64Array;
  /** (18 × 12) driver skinning matrices T = W · R⁻¹ (top 3 rows), rig.drivers order. */
  drivers: Float64Array;
  rootOffset: [number, number, number];
  /** Live-use notes: missing DOFs filled from neutral, trunk solve not converged, … */
  warnings: string[];
};

// ---- Small vector / matrix helpers ----------------------------------------------------------

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => scale(a, 1 / norm(a));
const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const clip = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

function mul3(a: M3, b: M3): M3 {
  const o = new Float64Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}
function transpose3(a: M3): M3 {
  return Float64Array.of(a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]);
}
const apply3 = (m: M3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const column = (m: M3, c: number): Vec3 => [m[c], m[3 + c], m[6 + c]];
const fromColumns = (a: Vec3, b: Vec3, c: Vec3): M3 =>
  Float64Array.of(a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]);
const IDENTITY: M3 = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);

/** Rodrigues rotation matrix; `angle` in radians, right-handed about `axis` (rig.axis_angle). */
function axisAngle(axis: Vec3, angle: number): M3 {
  let [x, y, z] = axis;
  const n = Math.sqrt(x * x + y * y + z * z);
  if (n === 0 || angle === 0) return IDENTITY.slice();
  x /= n;
  y /= n;
  z /= n;
  const c = Math.cos(angle),
    s = Math.sin(angle),
    t = 1 - c;
  return Float64Array.of(
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  );
}

/** Right-handed basis, columns [y, f, k]: y = long axis, f = `toward` made perpendicular. */
function frame(longAxis: Vec3, toward: Vec3): M3 {
  const y = unit(longAxis);
  const f0 = sub(toward, scale(y, dot(toward, y)));
  const n = norm(f0);
  if (n < 1e-9)
    throw new Error('Degenerate frame: reference direction is parallel to the long axis');
  const f = scale(f0, 1 / n);
  return fromColumns(y, f, cross(y, f));
}

const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];

/** ISB R = Ry(plane) Rx(−elevation) Ry(axial), degrees in (rig.isb_local). */
function isbLocal(plane: number, elevation: number, axial: number): M3 {
  return mul3(
    mul3(axisAngle(Y, plane * DEG), axisAngle(X, -elevation * DEG)),
    axisAngle(Y, axial * DEG),
  );
}

// ---- Skeleton state -------------------------------------------------------------------------

const head = (world: Float64Array, b: number): Vec3 => [
  world[b * 16 + 3],
  world[b * 16 + 7],
  world[b * 16 + 11],
];

/** Apply [R | pivot − R·pivot] to every bone of the subtree (rig._rotate). */
function rotate(live: LiveRig, world: Float64Array, bone: number, R: M3, pivot: Vec3) {
  const tx = pivot[0] - (R[0] * pivot[0] + R[1] * pivot[1] + R[2] * pivot[2]),
    ty = pivot[1] - (R[3] * pivot[0] + R[4] * pivot[1] + R[5] * pivot[2]),
    tz = pivot[2] - (R[6] * pivot[0] + R[7] * pivot[1] + R[8] * pivot[2]);
  for (const id of live.subtree[bone]) {
    const o = id * 16;
    for (let c = 0; c < 4; c++) {
      const a = world[o + c],
        b = world[o + 4 + c],
        d = world[o + 8 + c];
      world[o + c] = R[0] * a + R[1] * b + R[2] * d;
      world[o + 4 + c] = R[3] * a + R[4] * b + R[5] * d;
      world[o + 8 + c] = R[6] * a + R[7] * b + R[8] * d;
    }
    world[o + 3] += tx;
    world[o + 7] += ty;
    world[o + 11] += tz;
  }
}

/** World rotation applied to `bone` so far: posed[:3,:3] · rest[:3,:3]ᵀ (rig._accumulated). */
function accumulated(live: LiveRig, world: Float64Array, bone: number): M3 {
  const o = bone * 16,
    r = live.rest,
    out = new Float64Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      out[i * 3 + j] =
        world[o + i * 4] * r[o + j * 4] +
        world[o + i * 4 + 1] * r[o + j * 4 + 1] +
        world[o + i * 4 + 2] * r[o + j * 4 + 2];
  return out;
}

const bone = (live: LiveRig, label: string) => {
  const b = live.index.get(label);
  if (b === undefined) throw new Error(`Rig has no bone ${label}`);
  return b;
};

// ---- Rig construction (rig.build_rig, from the exported rest data) --------------------------

export function loadLiveRig(buffer: ArrayBuffer): LiveRig {
  const rig = parseRig(buffer);
  const header = decodeSatb(buffer, 'rig').header as { parents?: unknown };
  if (!Array.isArray(header.parents)) throw new Error('Rig header has no parents');
  return createLiveRig(rig, header.parents as number[]);
}

export function createLiveRig(rig: MotionRig, parents: ArrayLike<number>): LiveRig {
  const B = rig.bones.length;
  if (parents.length !== B) throw new Error('Rig parents do not match its bones');
  const rest = Float64Array.from(rig.restWorld);
  const restInverse = new Float64Array(B * 12);
  for (let b = 0; b < B; b++) invertAffine(rest, b * 16, restInverse, b * 12);
  const children: number[][] = Array.from({ length: B }, () => []);
  const par = Int32Array.from(parents);
  for (let i = 0; i < B; i++) if (par[i] >= 0) children[par[i]].push(i);
  const subtree: Int32Array[] = [];
  for (let i = 0; i < B; i++) {
    const out: number[] = [],
      stack = [i];
    while (stack.length) {
      const j = stack.pop()!;
      out.push(j);
      stack.push(...children[j]);
    }
    subtree.push(Int32Array.from(out));
  }
  const index = new Map(rig.bones.map((label, i) => [label, i]));
  const partial = { rig, parents: par, rest, restInverse, subtree, index } as LiveRig;
  const at = (label: string) => head(rest, bone(partial, label));

  const humerus = {} as LiveRig['humerus'];
  for (const side of ['L', 'R'] as const) {
    const shoulder = at(`upperarm01.${side}`),
      elbow = at(`lowerarm01.${side}`),
      wrist = at(`wrist.${side}`);
    const upper = sub(elbow, shoulder),
      fore = sub(wrist, elbow);
    humerus[side] = {
      frame: frame(upper, fore),
      flexion: Math.acos(clip(dot(upper, fore) / norm(upper) / norm(fore), -1, 1)),
    };
  }

  // Sole candidates: (fully foot-weighted OR dominant bone under lowerleg02) AND near the floor.
  const V = rig.vertexCount,
    K = rig.influences,
    W = rig.skinWeights,
    I = rig.skinIndices,
    P = rig.restVertices;
  const inFeet = new Uint8Array(B),
    inFootBones = new Uint8Array(B);
  for (const s of ['L', 'R']) {
    for (const b of subtree[bone(partial, `lowerleg02.${s}`)]) inFeet[b] = 1;
    for (const b of subtree[bone(partial, `foot.${s}`)]) inFootBones[b] = 1;
  }
  let floor = Infinity;
  for (let v = 0; v < V; v++) floor = Math.min(floor, P[v * 3 + 1]);
  const feet: number[] = [];
  for (let v = 0; v < V; v++) {
    if (!(P[v * 3 + 1] < floor + SOLE_BAND_M)) continue;
    let footWeight = 0,
      best = -Infinity,
      dominant = 0;
    for (let k = 0; k < K; k++) {
      const w = W[v * K + k],
        b = I[v * K + k];
      if (inFootBones[b]) footWeight += w;
      if (w > best) {
        best = w;
        dominant = b;
      }
    }
    if (footWeight > 1 - 1e-6 || inFeet[dominant]) feet.push(v);
  }

  const hipL = at('upperleg01.L'),
    hipR = at('upperleg01.R');
  const vertical = unit(sub(mid(at('upperarm01.L'), at('upperarm01.R')), mid(hipL, hipR)));
  const hipLine = sub(hipR, hipL);
  const right = unit(sub(hipLine, scale(vertical, dot(hipLine, vertical))));
  const forward = cross(vertical, right);
  const shares = (rom: number[]) => {
    const total = rom.reduce((a, b) => a + b, 0);
    return rom.map((r) => r / total);
  };
  return Object.assign(partial, {
    vertical,
    right,
    forward,
    humerus,
    footVertices: Uint32Array.from(feet),
    spineShares: [
      shares(SPINE_FLEXION_ROM),
      shares(SPINE_LATERAL_ROM),
      shares(SPINE_TWIST_ROM),
    ] as [number[], number[], number[]],
  });
}

// ---- Clamping (angles.clamp_pose) -----------------------------------------------------------

const limitKey = (dof: string) => dof.replace('_L_', '_').replace('_R_', '_');

export function clampPose(pose: AnatomicalPose): { pose: AnatomicalPose; clamps: PoseClamp[] } {
  const out: AnatomicalPose = { ...pose };
  const clamps: PoseClamp[] = [];
  for (const dof of LIVE_DOFS) {
    if (dof === 'pelvis_drop_m') continue;
    const value = out[dof] ?? 0;
    const limit = LIVE_LIMITS_DEG[limitKey(dof)];
    const applied = Math.min(Math.max(value, limit[0]), limit[1]);
    if (applied !== value) clamps.push({ dof, requested: value, applied });
    out[dof] = applied;
  }
  return { pose: out, clamps };
}

// ---- Trunk ----------------------------------------------------------------------------------

/** Columns [forward, up, right] from the posed joints (rig.thorax_frame). */
function thoraxFrame(live: LiveRig, world: Float64Array): M3 {
  const hip = mid(head(world, bone(live, 'upperleg01.L')), head(world, bone(live, 'upperleg01.R')));
  const left = head(world, bone(live, 'upperarm01.L')),
    rightJ = head(world, bone(live, 'upperarm01.R'));
  const up = unit(sub(mid(left, rightJ), hip));
  const line = sub(rightJ, left);
  const side = unit(sub(line, scale(up, dot(line, up))));
  return fromColumns(cross(up, side), up, side);
}

/** (flexion, lateral, twist) in degrees, measured as P3 does (rig.measure_trunk). */
function measureTrunk(live: LiveRig, world: Float64Array): Vec3 {
  const { vertical: v, forward: f, right: r } = live;
  const thorax = thoraxFrame(live, world);
  const u = column(thorax, 1),
    ts = column(thorax, 2);
  const hips = sub(
    head(world, bone(live, 'upperleg01.R')),
    head(world, bone(live, 'upperleg01.L')),
  );
  const hipLine = unit(sub(hips, scale(u, dot(hips, u))));
  return [
    Math.atan2(dot(u, f), dot(u, v)) / DEG,
    Math.asin(clip(dot(u, r), -1, 1)) / DEG,
    Math.atan2(dot(cross(hipLine, ts), u), dot(hipLine, ts)) / DEG,
  ];
}

/** Pelvic tilt + distributed spine rotation + clavicle shrug for raw drive angles (rig._trunk). */
function trunk(live: LiveRig, drive: ArrayLike<number>, elevL: number, elevR: number) {
  const world = live.rest.slice();
  const flexion = drive[0] * DEG,
    lateral = drive[1] * DEG,
    twist = drive[2] * DEG;
  const hips = mid(
    head(live.rest, bone(live, 'upperleg01.L')),
    head(live.rest, bone(live, 'upperleg01.R')),
  );
  const minusRight = scale(live.right, -1);
  rotate(live, world, 0, axisAngle(minusRight, flexion * PELVIC_FLEXION_SHARE), hips);
  const spinal = flexion * (1 - PELVIC_FLEXION_SHARE);
  const [sf, sl, st] = live.spineShares;
  SPINE_BONES.forEach((label, i) => {
    const b = bone(live, label);
    const local = mul3(
      mul3(axisAngle(minusRight, spinal * sf[i]), axisAngle(live.forward, lateral * sl[i])),
      axisAngle(live.vertical, twist * st[i]),
    );
    const a = accumulated(live, world, live.parents[b]);
    rotate(live, world, b, mul3(mul3(a, local), transpose3(a)), head(world, b));
  });
  const a = accumulated(live, world, bone(live, THORAX_BONE));
  const axis = apply3(a, live.forward);
  for (const [side, sign, elevation] of [
    ['L', 1, elevL],
    ['R', -1, elevR],
  ] as const) {
    const lift = CLAVICLE_ELEVATION_RATIO * Math.max(0, elevation - GIRDLE_SETTING_PHASE_DEG);
    const clavicle = bone(live, `clavicle.${side}`);
    rotate(live, world, clavicle, axisAngle(axis, sign * lift * DEG), head(world, clavicle));
  }
  return world;
}

const maxAbs = (e: ArrayLike<number>) => Math.max(Math.abs(e[0]), Math.abs(e[1]), Math.abs(e[2]));

/** Solve J·x = e (3×3, row-major) by Cramer's rule; null when singular. */
function solve3(J: Float64Array, e: ArrayLike<number>): Vec3 | null {
  const [a, b, c, d, f, g, h, i, j] = J;
  const det = a * (f * j - g * i) - b * (d * j - g * h) + c * (d * i - f * h);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const [x, y, z] = [e[0], e[1], e[2]];
  return [
    (x * (f * j - g * i) - b * (y * j - g * z) + c * (y * i - f * z)) / det,
    (a * (y * j - g * z) - x * (d * j - g * h) + c * (d * z - y * h)) / det,
    (a * (f * z - y * i) - b * (d * z - y * h) + x * (d * i - f * h)) / det,
  ];
}

/**
 * Drive angles whose MEASURED trunk angles equal `target` (quasi-Newton, rig.solve_trunk).
 * Warm-starts from `state` along a motion. Unlike P1 it never throws: a non-converged solve
 * returns the best drive found and a warning (live input can be noisy).
 */
function solveTrunk(
  live: LiveRig,
  target: Vec3,
  elevL: number,
  elevR: number,
  state: TrunkSolverState,
  warnings: string[],
): Float64Array {
  let drive: Float64Array =
    state.drive && state.target
      ? Float64Array.from([0, 1, 2], (k) => state.drive![k] + (target[k] - state.target![k]))
      : Float64Array.from(target);
  let world = trunk(live, drive, elevL, elevR);
  const measured = measureTrunk(live, world);
  let error: Vec3 = sub(target, measured);
  let jacobian = state.jacobian ?? null;
  if (jacobian === null && maxAbs(error) >= TRUNK_SOLVE_TOLERANCE_DEG) {
    jacobian = new Float64Array(9);
    for (let k = 0; k < 3; k++) {
      const step = drive.slice();
      step[k] += 1;
      const m = measureTrunk(live, trunk(live, step, elevL, elevR));
      for (let r = 0; r < 3; r++) jacobian[r * 3 + k] = m[r] - measured[r];
    }
  }
  let best = { world, drive, residual: maxAbs(error) };
  for (let it = 0; it < TRUNK_SOLVE_ITERATIONS; it++) {
    if (maxAbs(error) < TRUNK_SOLVE_TOLERANCE_DEG) break;
    const step = jacobian ? solve3(jacobian, error) : null;
    if (!step) break;
    drive = Float64Array.from([0, 1, 2], (k) => drive[k] + step[k]);
    world = trunk(live, drive, elevL, elevR);
    error = sub(target, measureTrunk(live, world));
    const residual = maxAbs(error);
    if (!(residual >= best.residual)) best = { world, drive, residual };
  }
  if (!(maxAbs(error) < TRUNK_SOLVE_TOLERANCE_DEG)) {
    warnings.push(`trunk solve residual ${best.residual.toFixed(3)} deg`);
    world = best.world;
    drive = best.drive;
    // A stale Jacobian may be why: recompute it next frame.
    jacobian = null;
  }
  if (drive.every(Number.isFinite)) {
    state.drive = drive;
    state.target = Float64Array.from(target);
    state.jacobian = jacobian;
  } else {
    delete state.drive;
    delete state.target;
    state.jacobian = null;
  }
  return world;
}

/** Sagittal angle from the vertical, + forward, degrees (rig.sagittal_angle). */
const sagittalAngle = (live: LiveRig, v: Vec3) =>
  Math.atan2(dot(v, live.forward), -dot(v, live.vertical)) / DEG;

// ---- Pose → drivers (rig.pose_skeleton) -----------------------------------------------------

/**
 * The posed skeleton and the 18 driver matrices for a contract pose. DOFs missing from `input`
 * (or non-finite) take the body's neutral (display) pose value, then the pose is clamped to
 * the anatomical limits. `state` carries the trunk solver between frames (warm start).
 */
export function poseDrivers(
  live: LiveRig,
  input: AnatomicalPose,
  state: TrunkSolverState = {},
): PoseResult {
  const warnings: string[] = [];
  const full: AnatomicalPose = {};
  const missing: string[] = [];
  for (const dof of LIVE_DOFS) {
    const value = input[dof];
    if (value !== undefined && Number.isFinite(value)) full[dof] = value;
    else {
      full[dof] = live.rig.neutralPose[dof] ?? 0;
      if (dof !== 'pelvis_drop_m') missing.push(dof);
    }
  }
  if (missing.length) warnings.push(`neutral used for ${missing.join(', ')}`);
  const { pose, clamps } = clampPose(full);
  const p = pose;

  // 1-2. Trunk (pelvis + spine + shoulder girdle), solved to the measured contract angles.
  const world = solveTrunk(
    live,
    [p.trunk_flexion, p.trunk_lateral, p.trunk_twist],
    p.shoulder_L_elevation,
    p.shoulder_R_elevation,
    state,
    warnings,
  );

  // 3. Legs: thigh sagittal angle = hip flexion; 3D thigh-shank angle = knee flexion; feet flat.
  for (const side of ['L', 'R'] as const) {
    const thigh = bone(live, `upperleg01.${side}`),
      knee = bone(live, `lowerleg01.${side}`),
      foot = bone(live, `foot.${side}`);
    const restThigh = sub(head(live.rest, knee), head(live.rest, thigh));
    const turn = axisAngle(
      live.right,
      (p[`hip_${side}_flexion`] - sagittalAngle(live, restThigh)) * DEG,
    );
    rotate(
      live,
      world,
      thigh,
      mul3(turn, transpose3(accumulated(live, world, thigh))),
      head(world, thigh),
    );
    const t = sub(head(world, knee), head(world, thigh));
    const current = sub(head(world, foot), head(world, knee));
    let axis = cross(t, current);
    if (norm(axis) < 1e-9 * norm(current) * norm(t))
      axis = scale(sub(live.right, scale(t, dot(live.right, t) / dot(t, t))), -1);
    const cosine = dot(current, t) / norm(current) / norm(t);
    const bend = p[`knee_${side}_flexion`] * DEG - Math.acos(clip(cosine, -1, 1));
    rotate(live, world, knee, axisAngle(axis, bend), head(world, knee));
    const correction = transpose3(accumulated(live, world, foot));
    rotate(live, world, foot, correction, head(world, foot));
  }

  // 4. Arms: ISB Y-X-Y relative to the posed thorax frame, left side mirrored.
  const thorax = thoraxFrame(live, world);
  for (const [side, zSign] of [
    ['L', -1],
    ['R', 1],
  ] as const) {
    const local = thorax.slice();
    local[2] *= zSign;
    local[5] *= zSign;
    local[8] *= zSign;
    const lr = mul3(
      local,
      isbLocal(
        p[`shoulder_${side}_plane`],
        p[`shoulder_${side}_elevation`],
        p[`shoulder_${side}_axial`],
      ),
    );
    const desired = frame(scale(column(lr, 1), -1), column(lr, 0));
    const upper = bone(live, `upperarm01.${side}`);
    const { frame: restFrame, flexion: restFlexion } = live.humerus[side];
    const current = mul3(accumulated(live, world, upper), restFrame);
    rotate(live, world, upper, mul3(desired, transpose3(current)), head(world, upper));
    const lower = bone(live, `lowerarm01.${side}`);
    const bend = p[`elbow_${side}_flexion`] * DEG - restFlexion;
    rotate(live, world, lower, axisAngle(column(desired, 2), bend), head(world, lower));
  }

  // 5. Support: plant the feet (lowest sole vertex on Y = 0, rest mid-foot x/z).
  const drivers = driverMatrices(live, world, new Float64Array(live.rig.drivers.length * 12));
  const sole = skinVertices(
    live.rig,
    drivers,
    new Float64Array(live.footVertices.length * 3),
    live.footVertices,
  );
  let lowest = Infinity;
  for (let i = 1; i < sole.length; i += 3) lowest = Math.min(lowest, sole[i]);
  const footL = bone(live, 'foot.L'),
    footR = bone(live, 'foot.R');
  const midRest = mid(head(live.rest, footL), head(live.rest, footR));
  const midNow = mid(head(world, footL), head(world, footR));
  const offset: [number, number, number] = [
    midRest[0] - midNow[0],
    -lowest,
    midRest[2] - midNow[2],
  ];
  for (let b = 0; b < live.rig.bones.length; b++) {
    world[b * 16 + 3] += offset[0];
    world[b * 16 + 7] += offset[1];
    world[b * 16 + 11] += offset[2];
  }
  for (let d = 0; d < live.rig.drivers.length; d++) {
    drivers[d * 12 + 3] += offset[0];
    drivers[d * 12 + 7] += offset[1];
    drivers[d * 12 + 11] += offset[2];
  }
  return {
    pose: { ...pose, pelvis_drop_m: Math.max(0, -offset[1]) },
    clamps,
    world,
    drivers,
    rootOffset: offset,
    warnings,
  };
}

/** Top three rows of W · R⁻¹ for every driver bone, rig.drivers order. */
function driverMatrices(live: LiveRig, world: Float64Array, out: Float64Array) {
  live.rig.drivers.forEach((b, d) => {
    const w = b * 16,
      r = b * 12,
      o = d * 12,
      inv = live.restInverse;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 4; j++) {
        let v =
          world[w + i * 4] * inv[r + j] +
          world[w + i * 4 + 1] * inv[r + 4 + j] +
          world[w + i * 4 + 2] * inv[r + 8 + j];
        if (j === 3) v += world[w + i * 4 + 3];
        out[o + i * 4 + j] = v;
      }
  });
  return out;
}

// ---- Joints ---------------------------------------------------------------------------------

/** JointName (packages/vision poseSynth) → Anny bone whose head is that joint. */
const JOINT_BONES: Record<string, string> = {
  lHip: 'upperleg01.L',
  rHip: 'upperleg01.R',
  lKnee: 'lowerleg01.L',
  rKnee: 'lowerleg01.R',
  lAnkle: 'foot.L',
  rAnkle: 'foot.R',
  lShoulder: 'upperarm01.L',
  rShoulder: 'upperarm01.R',
  lElbow: 'lowerarm01.L',
  rElbow: 'lowerarm01.R',
  lWrist: 'wrist.L',
  rWrist: 'wrist.R',
  // poseSynth's head sits 0.25 m up the trunk from mid-shoulder; Anny's `head` bone head is
  // the skull base (top of the neck), the closest rig joint.
  head: 'head',
};
const RAW_JOINTS = [
  ...['upperarm01', 'lowerarm01', 'wrist', 'upperleg01', 'lowerleg01', 'foot'].flatMap((n) => [
    `${n}.L`,
    `${n}.R`,
  ]),
  'root',
  'spine01',
  'neck01',
  'head',
];

/**
 * Posed joint positions (scene metres): every poseSynth JointName (midHip / midShoulder are the
 * midpoints of the pairs) plus rig.py joint_positions' raw Anny keys.
 */
export function jointPositions(
  live: LiveRig,
  world: Float64Array,
): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  for (const [name, label] of Object.entries(JOINT_BONES))
    out[name] = head(world, bone(live, label));
  out.midHip = mid(out.lHip, out.rHip);
  out.midShoulder = mid(out.lShoulder, out.rShoulder);
  for (const label of RAW_JOINTS) out[label] = head(world, bone(live, label));
  return out;
}
