// Pinhole camera model and its robust solve for the AR overlay (agent V2). Pure, no DOM.
//
// Frames:
//   scene  metres, X = subject's LEFT, Y up, +Z = body front (AGENTS.md §5, motion FORMAT.md).
//   camera OpenCV convention: x right, y DOWN, z forward (into the picture), metres.
//   image  source pixels, origin top-left (contract.ts), u = f·x/z + cx, v = f·y/z + cy.
// Square pixels and no skew. Lens distortion is not modelled; ArTracker measures whether the
// residuals show it (docs/STATUS-tryon-ar.md).
//
// Body → camera: p = R·(X − pivot) + t with R = Rz(roll)·Rx(pitch)·F·Ry(yaw), F = diag(1, −1, −1)
// (a person facing the camera: their front points at the lens, their left is image right).
// `pivot` is the posed mid-hip, so t is where the pelvis sits in front of the lens.
//
// Scale: scaling the whole scene about the lens leaves every pixel unchanged, so the body's metric
// size is not refined; it is the fitted body (its height is known). Depth absorbs the rest.

export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export type Intrinsics = {
  /** Focal length in source pixels (square pixels). */
  f: number;
  /** Principal point in source pixels (the image centre: phones and webcams are not off-axis). */
  cx: number;
  cy: number;
  width: number;
  height: number;
};

/**
 * Rigid body → camera transform. Angles in radians, t in metres (camera frame). `sx` (solve
 * only, default 1) scales the joints' lateral (scene X) offsets from the pivot: it absorbs the
 * gap between MediaPipe's shoulder/hip landmarks and the rig's joint centres, which the solver
 * would otherwise explain by a false ±30° yaw. The jacket is always drawn at sx = 1 (true size).
 */
export type BodyPose = { yaw: number; pitch: number; roll: number; t: Vec3; sx?: number };

export const DEG = Math.PI / 180;

export function focalFromDiagonalFov(width: number, height: number, fovDeg: number) {
  return Math.hypot(width, height) / 2 / Math.tan((fovDeg * DEG) / 2);
}
export function diagonalFovDeg(width: number, height: number, f: number) {
  return (2 * Math.atan(Math.hypot(width, height) / 2 / f)) / DEG;
}
export function horizontalFovDeg(width: number, f: number) {
  return (2 * Math.atan(width / 2 / f)) / DEG;
}
export function centredIntrinsics(width: number, height: number, f: number): Intrinsics {
  return { f, cx: width / 2, cy: height / 2, width, height };
}

/** R = Rz(roll)·Rx(pitch)·F·Ry(yaw), row-major. */
export function rotation(pose: Pick<BodyPose, 'yaw' | 'pitch' | 'roll'>): Mat3 {
  const cy = Math.cos(pose.yaw),
    sy = Math.sin(pose.yaw);
  const cp = Math.cos(pose.pitch),
    sp = Math.sin(pose.pitch);
  const cr = Math.cos(pose.roll),
    sr = Math.sin(pose.roll);
  // F·Ry(yaw): Ry = [[cy,0,sy],[0,1,0],[−sy,0,cy]]; F negates rows 1 and 2.
  const a: Mat3 = [cy, 0, sy, 0, -1, 0, sy, 0, -cy];
  // Rx(pitch)·a
  const b: Mat3 = [
    a[0],
    a[1],
    a[2],
    cp * a[3] - sp * a[6],
    cp * a[4] - sp * a[7],
    cp * a[5] - sp * a[8],
    sp * a[3] + cp * a[6],
    sp * a[4] + cp * a[7],
    sp * a[5] + cp * a[8],
  ];
  // Rz(roll)·b
  return [
    cr * b[0] - sr * b[3],
    cr * b[1] - sr * b[4],
    cr * b[2] - sr * b[5],
    sr * b[0] + cr * b[3],
    sr * b[1] + cr * b[4],
    sr * b[2] + cr * b[5],
    b[6],
    b[7],
    b[8],
  ];
}

/** Scene point → camera frame. */
export function toCamera(R: Mat3, t: Vec3, pivot: Vec3, X: Vec3, sx = 1): Vec3 {
  const x = (X[0] - pivot[0]) * sx,
    y = X[1] - pivot[1],
    z = X[2] - pivot[2];
  return [
    R[0] * x + R[1] * y + R[2] * z + t[0],
    R[3] * x + R[4] * y + R[5] * z + t[1],
    R[6] * x + R[7] * y + R[8] * z + t[2],
  ];
}

/** Scene point → [u, v, depth z (m)]. Depth ≤ 0 means behind the lens (u, v meaningless). */
export function project(K: Intrinsics, pose: BodyPose, pivot: Vec3, X: Vec3, R = rotation(pose)) {
  const p = toCamera(R, pose.t, pivot, X, pose.sx ?? 1);
  const z = p[2];
  return [K.f * (p[0] / z) + K.cx, K.f * (p[1] / z) + K.cy, z] as Vec3;
}

/**
 * The scene → camera-world 4×4 (row-major, OpenCV camera axes) for this pose, as used by the
 * renderer: p_cam = M·[X, 1].
 */
export function viewMatrix(pose: BodyPose, pivot: Vec3): number[] {
  const R = rotation(pose);
  const t = pose.t;
  const tx = t[0] - (R[0] * pivot[0] + R[1] * pivot[1] + R[2] * pivot[2]);
  const ty = t[1] - (R[3] * pivot[0] + R[4] * pivot[1] + R[5] * pivot[2]);
  const tz = t[2] - (R[6] * pivot[0] + R[7] * pivot[1] + R[8] * pivot[2]);
  return [R[0], R[1], R[2], tx, R[3], R[4], R[5], ty, R[6], R[7], R[8], tz, 0, 0, 0, 1];
}

// ---------------------------------------------------------------------------------------------
// Levenberg–Marquardt on a small dense problem, numeric (central difference) Jacobian.

export type LmOptions = {
  maxIterations?: number;
  /** Finite-difference step per parameter. */
  steps: number[];
  /** Stop when the relative cost decrease is below this. */
  tolerance?: number;
  /**
   * Optional Jacobian (m×n, row-major) at `p`, for problems with known sparsity; must fill every
   * entry. Default: central differences over every parameter.
   */
  jacobian?: (p: Float64Array, J: Float64Array) => void;
};

export type LmResult = {
  params: Float64Array;
  cost: number;
  iterations: number;
  jtj: Float64Array;
};

/** Solves A·x = b (n×n, row-major) in place by Gaussian elimination with partial pivoting. */
export function solveLinear(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  for (let c = 0; c < n; c++) {
    let pivot = c,
      best = Math.abs(A[c * n + c]);
    for (let r = c + 1; r < n; r++) {
      const v = Math.abs(A[r * n + c]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-14) return null;
    if (pivot !== c) {
      for (let k = 0; k < n; k++) {
        const tmp = A[c * n + k];
        A[c * n + k] = A[pivot * n + k];
        A[pivot * n + k] = tmp;
      }
      const tmp = b[c];
      b[c] = b[pivot];
      b[pivot] = tmp;
    }
    const d = A[c * n + c];
    for (let r = c + 1; r < n; r++) {
      const m = A[r * n + c] / d;
      if (!m) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= m * A[c * n + k];
      b[r] -= m * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}

/** Inverts a symmetric positive-definite n×n matrix (row-major); null when singular. */
export function invert(A: Float64Array, n: number): Float64Array | null {
  const out = new Float64Array(n * n);
  for (let c = 0; c < n; c++) {
    const e = new Float64Array(n);
    e[c] = 1;
    const x = solveLinear(Float64Array.from(A), e, n);
    if (!x) return null;
    for (let r = 0; r < n; r++) out[r * n + c] = x[r];
  }
  return out;
}

/**
 * Minimises ½‖r(p)‖². `residuals(p, out)` fills `out` (length m). Returns the parameters, the
 * final cost ½‖r‖² and JᵀJ at the solution (for uncertainty).
 */
export function levenbergMarquardt(
  initial: ArrayLike<number>,
  m: number,
  residuals: (p: Float64Array, out: Float64Array) => void,
  options: LmOptions,
): LmResult {
  const n = initial.length;
  const p = Float64Array.from(initial);
  const r = new Float64Array(m),
    rPlus = new Float64Array(m),
    rMinus = new Float64Array(m),
    trial = new Float64Array(m);
  const J = new Float64Array(m * n);
  const jtj = new Float64Array(n * n),
    jtr = new Float64Array(n);
  const maxIterations = options.maxIterations ?? 30;
  const tolerance = options.tolerance ?? 1e-9;
  const cost = (v: Float64Array) => {
    let s = 0;
    for (let i = 0; i < m; i++) s += v[i] * v[i];
    return 0.5 * s;
  };
  residuals(p, r);
  let current = cost(r);
  let lambda = 1e-3;
  let iterations = 0;
  const jacobian = () => {
    if (options.jacobian) options.jacobian(p, J);
    else
      for (let j = 0; j < n; j++) {
        const h = options.steps[j];
        const keep = p[j];
        p[j] = keep + h;
        residuals(p, rPlus);
        p[j] = keep - h;
        residuals(p, rMinus);
        p[j] = keep;
        for (let i = 0; i < m; i++) J[i * n + j] = (rPlus[i] - rMinus[i]) / (2 * h);
      }
    jtj.fill(0);
    jtr.fill(0);
    for (let i = 0; i < m; i++) {
      const row = i * n;
      const ri = r[i];
      for (let a = 0; a < n; a++) {
        const ja = J[row + a];
        if (!ja) continue;
        jtr[a] += ja * ri;
        for (let b = a; b < n; b++) jtj[a * n + b] += ja * J[row + b];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) jtj[a * n + b] = jtj[b * n + a];
  };
  jacobian();
  const candidate = new Float64Array(n);
  for (; iterations < maxIterations; iterations++) {
    let improved = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const A = Float64Array.from(jtj);
      for (let a = 0; a < n; a++) A[a * n + a] += lambda * (jtj[a * n + a] + 1e-9);
      const rhs = new Float64Array(n);
      for (let a = 0; a < n; a++) rhs[a] = -jtr[a];
      const step = solveLinear(A, rhs, n);
      if (!step) {
        lambda *= 10;
        continue;
      }
      for (let a = 0; a < n; a++) candidate[a] = p[a] + step[a];
      residuals(candidate, trial);
      const next = cost(trial);
      if (Number.isFinite(next) && next < current) {
        const decrease = (current - next) / Math.max(current, 1e-30);
        p.set(candidate);
        r.set(trial);
        current = next;
        lambda = Math.max(lambda / 10, 1e-9);
        improved = true;
        if (decrease < tolerance) {
          jacobian();
          return { params: p, cost: current, iterations: iterations + 1, jtj };
        }
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
    jacobian();
  }
  return { params: p, cost: current, iterations, jtj };
}

// ---------------------------------------------------------------------------------------------
// The body–camera problem.

/** One 2D–3D correspondence: a posed joint (scene m) and its landmark (source px). */
export type Correspondence = {
  X: Vec3;
  u: number;
  v: number;
  /** Relative weight (joint weight × landmark visibility). */
  weight: number;
  /** False: not scaled by the lateral landmark spread (BodyPose.sx). Default true. */
  lateral?: boolean;
};

export type PoseObservation = {
  points: Correspondence[];
  pivot: Vec3;
};

export type PosePrior = {
  pitch: number;
  roll: number;
  /** 1σ (radians) of the per-frame pitch / roll around the prior. */
  sigma: number;
  /** Optional yaw prior (radians) and its 1σ: pins the yaw in the steadied re-solve. */
  yaw?: number;
  yawSigma?: number;
  /**
   * When set, the solve has a 7th parameter ln(sx) (BodyPose.sx) with this prior mean and 1σ
   * (`scaleSigma`). Unset: 6 parameters, sx = 1.
   */
  lnScale?: number;
  scaleSigma?: number;
};

export type RobustOptions = {
  /** Landmark 1σ in px: priors are expressed in these units. */
  sigmaPx: number;
  /** Pseudo-Huber knee in px (residuals beyond it grow linearly). */
  kneePx: number;
};

/** Pseudo-Huber: the residual 2-vector (dx, dy) is scaled so its squared norm is 2k²(√(1+e²/k²)−1). */
function robustScale(e2: number, k: number) {
  if (e2 < 1e-18) return 1;
  const rho = 2 * k * k * (Math.sqrt(1 + e2 / (k * k)) - 1);
  return Math.sqrt(rho / e2);
}

/** Residual count of one observation: 2 per point + 4 prior terms (pitch, roll, yaw, scale). */
export const observationResiduals = (o: PoseObservation) => o.points.length * 2 + 4;

/** Fills the residuals of one observation for pose params [yaw, pitch, roll, tx, ty, tz]. */
export function poseResiduals(
  params: ArrayLike<number>,
  offset: number,
  f: number,
  K: Intrinsics,
  o: PoseObservation,
  prior: PosePrior,
  robust: RobustOptions,
  out: Float64Array,
  at: number,
) {
  const pose: BodyPose = {
    yaw: params[offset],
    pitch: params[offset + 1],
    roll: params[offset + 2],
    t: [params[offset + 3], params[offset + 4], params[offset + 5]],
  };
  const scaled = prior.lnScale !== undefined;
  const lnScale = scaled ? params[offset + 6] : 0;
  const sx = Math.exp(lnScale);
  const R = rotation(pose);
  let k = at;
  for (const c of o.points) {
    const p = toCamera(R, pose.t, o.pivot, c.X, c.lateral === false ? 1 : sx);
    const z = Math.max(p[2], 0.05); // never divide by ~0: a point at the lens is just far off
    const dx = f * (p[0] / z) + K.cx - c.u;
    const dy = f * (p[1] / z) + K.cy - c.v;
    const s = robustScale(dx * dx + dy * dy, robust.kneePx) * Math.sqrt(c.weight);
    out[k++] = dx * s;
    out[k++] = dy * s;
  }
  out[k++] = ((pose.pitch - prior.pitch) / prior.sigma) * robust.sigmaPx;
  out[k++] = ((pose.roll - prior.roll) / prior.sigma) * robust.sigmaPx;
  out[k++] =
    prior.yaw === undefined
      ? 0
      : (wrapAngle(pose.yaw - prior.yaw) / (prior.yawSigma ?? prior.sigma)) * robust.sigmaPx;
  out[k++] = scaled ? ((lnScale - prior.lnScale!) / (prior.scaleSigma ?? 0.1)) * robust.sigmaPx : 0;
  return k;
}

const POSE_STEPS = [1e-4, 1e-4, 1e-4, 1e-5, 1e-5, 1e-5];

/**
 * A starting pose from the 2D landmarks: the yaw from the caller (MediaPipe world landmarks or
 * the previous frame), depth from the ratio of the 3D to the 2D spread of the points, and the
 * pivot placed on its pixel.
 */
export function initialPose(
  K: Intrinsics,
  o: PoseObservation,
  yaw: number,
  prior: Pick<PosePrior, 'pitch' | 'roll'>,
): BodyPose {
  // Mean pairwise distances, 3D (m) and 2D (px); the vertical spread dominates for a person,
  // which does not depend on yaw.
  let d3 = 0,
    d2 = 0;
  const pts = o.points;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i],
        b = pts[j];
      d3 += Math.abs(a.X[1] - b.X[1]) + 0.5 * Math.hypot(a.X[0] - b.X[0], a.X[2] - b.X[2]);
      d2 += Math.abs(a.v - b.v) + 0.5 * Math.abs(a.u - b.u);
    }
  const z = d2 > 1e-6 ? (K.f * d3) / d2 : 2.5;
  // Pivot pixel: the weighted mean landmark shifted by the mean 3D offset from the pivot.
  let su = 0,
    sv = 0,
    sx = 0,
    sy = 0,
    w = 0;
  for (const c of pts) {
    su += c.u * c.weight;
    sv += c.v * c.weight;
    sx += (c.X[0] - o.pivot[0]) * c.weight;
    sy += (c.X[1] - o.pivot[1]) * c.weight;
    w += c.weight;
  }
  const u0 = su / w,
    v0 = sv / w;
  // In the camera frame the 3D offset is about (±x, −y) for an upright person.
  const tx = ((u0 - K.cx) * z) / K.f - (Math.cos(yaw) * sx) / w;
  const ty = ((v0 - K.cy) * z) / K.f + sy / w;
  return { yaw, pitch: prior.pitch, roll: prior.roll, t: [tx, ty, z] };
}

export type PoseSolve = {
  pose: BodyPose;
  /** Weighted RMS reprojection error of the points (px), robust weights excluded. */
  rmsPx: number;
  cost: number;
  iterations: number;
};

/** RMS reprojection error (px) of the given points at a pose. */
export function reprojectionRms(K: Intrinsics, pose: BodyPose, o: PoseObservation) {
  const R = rotation(pose);
  let s = 0,
    w = 0;
  for (const c of o.points) {
    const [u, v] = project(K, c.lateral === false ? { ...pose, sx: 1 } : pose, o.pivot, c.X, R);
    s += c.weight * ((u - c.u) ** 2 + (v - c.v) ** 2);
    w += c.weight;
  }
  return w ? Math.sqrt(s / w) : NaN;
}

/** Solves one frame's pose with the focal length known. Tries each start, keeps the best. */
export function solvePose(
  K: Intrinsics,
  o: PoseObservation,
  starts: BodyPose[],
  prior: PosePrior,
  robust: RobustOptions,
): PoseSolve {
  const m = observationResiduals(o);
  let best: PoseSolve | null = null;
  const scaled = prior.lnScale !== undefined;
  for (const start of starts) {
    const initial = [start.yaw, start.pitch, start.roll, ...start.t];
    if (scaled) initial.push(Math.log(start.sx ?? Math.exp(prior.lnScale!)));
    const result = levenbergMarquardt(
      initial,
      m,
      (p, out) => poseResiduals(p, 0, K.f, K, o, prior, robust, out, 0),
      { steps: scaled ? [...POSE_STEPS, 1e-4] : POSE_STEPS, maxIterations: 40 },
    );
    const q = result.params;
    const pose: BodyPose = { yaw: q[0], pitch: q[1], roll: q[2], t: [q[3], q[4], q[5]] };
    if (scaled) pose.sx = Math.exp(q[6]);
    if (pose.t[2] <= 0.1) continue; // behind or at the lens: not a person in front of a camera
    if (!best || result.cost < best.cost)
      best = {
        pose,
        rmsPx: reprojectionRms(K, pose, o),
        cost: result.cost,
        iterations: result.iterations,
      };
  }
  if (!best) throw new Error('No camera pose puts the body in front of the lens');
  best.pose.yaw = wrapAngle(best.pose.yaw);
  return best;
}

export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export type FocalSolve = {
  f: number;
  /** 1σ of ln(f) from the Gauss–Newton covariance (prior included). */
  logSigma: number;
  poses: BodyPose[];
  rmsPx: number;
  /** Same frames solved at the prior focal length, for comparison. */
  priorRmsPx: number;
};

/**
 * Joint solve of one focal length and every keyframe's pose: params [ln f, 6 per frame], with a
 * Gaussian prior on ln f (FOV prior). Perspective (depth spread within the body, turns) is what
 * makes f observable; the prior keeps it sane when the evidence is weak, and logSigma says how
 * much the data constrained it.
 */
export function solveFocal(
  width: number,
  height: number,
  frames: { observation: PoseObservation; start: BodyPose }[],
  focalPrior: { f: number; logSigma: number },
  posePrior: PosePrior,
  robust: RobustOptions,
): FocalSolve {
  if (!frames.length) throw new Error('No keyframes for the focal solve');
  const K0 = centredIntrinsics(width, height, focalPrior.f);
  // Each frame first at the prior focal length (good starts for the joint problem).
  const starts = frames.map((fr) => solvePose(K0, fr.observation, [fr.start], posePrior, robust));
  const n = 1 + 6 * frames.length;
  const m = 1 + frames.reduce((s, fr) => s + observationResiduals(fr.observation), 0);
  const initial = new Float64Array(n);
  initial[0] = Math.log(focalPrior.f);
  starts.forEach((s, i) => {
    initial.set([s.pose.yaw, s.pose.pitch, s.pose.roll, ...s.pose.t], 1 + 6 * i);
  });
  const steps = [1e-4];
  for (let i = 0; i < frames.length; i++) steps.push(...POSE_STEPS);
  const residuals = (p: Float64Array, out: Float64Array) => {
    const f = Math.exp(p[0]);
    const K = centredIntrinsics(width, height, f);
    let k = 0;
    frames.forEach((fr, i) => {
      k = poseResiduals(p, 1 + 6 * i, f, K, fr.observation, posePrior, robust, out, k);
    });
    out[k] = ((p[0] - Math.log(focalPrior.f)) / focalPrior.logSigma) * robust.sigmaPx;
  };
  // Block-sparse Jacobian: a frame's six parameters move only that frame's residuals, so each
  // column is differenced on its own block instead of all m residuals. With the single-entry
  // covariance below, 24 keyframes take 22 ms instead of 275 ms. Column 0 (ln f) touches every row.
  const rows: number[] = [];
  let at = 0;
  for (const fr of frames) {
    rows.push(at);
    at += observationResiduals(fr.observation);
  }
  const plus = new Float64Array(m),
    minus = new Float64Array(m);
  const jacobian = (p: Float64Array, J: Float64Array) => {
    J.fill(0);
    const h0 = steps[0],
      keep0 = p[0];
    p[0] = keep0 + h0;
    residuals(p, plus);
    p[0] = keep0 - h0;
    residuals(p, minus);
    p[0] = keep0;
    for (let i = 0; i < m; i++) J[i * n] = (plus[i] - minus[i]) / (2 * h0);
    const f = Math.exp(p[0]);
    const K = centredIntrinsics(width, height, f);
    frames.forEach((fr, i) => {
      const o = 1 + 6 * i,
        r0 = rows[i],
        count = observationResiduals(fr.observation);
      for (let j = 0; j < 6; j++) {
        const c = o + j,
          h = steps[c],
          keep = p[c];
        p[c] = keep + h;
        poseResiduals(p, o, f, K, fr.observation, posePrior, robust, plus, 0);
        p[c] = keep - h;
        poseResiduals(p, o, f, K, fr.observation, posePrior, robust, minus, 0);
        p[c] = keep;
        for (let k = 0; k < count; k++) J[(r0 + k) * n + c] = (plus[k] - minus[k]) / (2 * h);
      }
    });
  };
  const result = levenbergMarquardt(initial, m, residuals, {
    steps,
    maxIterations: 60,
    jacobian,
  });
  const q = result.params;
  const f = Math.exp(q[0]);
  const K = centredIntrinsics(width, height, f);
  const poses = frames.map((_, i) => {
    const o = 1 + 6 * i;
    return {
      yaw: wrapAngle(q[o]),
      pitch: q[o + 1],
      roll: q[o + 2],
      t: [q[o + 3], q[o + 4], q[o + 5]],
    } as BodyPose;
  });
  // Covariance ≈ σ²(JᵀJ)⁻¹ with the residuals in units of σ_px; only its (ln f, ln f) entry is
  // needed: one solve against e₀ (the full inverse was n solves, 0.3 s at 24 keyframes).
  const e0 = new Float64Array(n);
  e0[0] = 1;
  const column = solveLinear(Float64Array.from(result.jtj), e0, n);
  const logSigma = column ? Math.sqrt(Math.max(column[0], 0)) * robust.sigmaPx : NaN;
  const rms = (Kx: Intrinsics, ps: BodyPose[]) => {
    let s = 0,
      c = 0;
    frames.forEach((fr, i) => {
      const e = reprojectionRms(Kx, ps[i], fr.observation);
      s += e * e;
      c++;
    });
    return Math.sqrt(s / c);
  };
  return {
    f,
    logSigma,
    poses,
    rmsPx: rms(K, poses),
    priorRmsPx: rms(
      K0,
      starts.map((s) => s.pose),
    ),
  };
}
