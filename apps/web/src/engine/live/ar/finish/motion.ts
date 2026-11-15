// Motion compensation of the class mask (agent V4). The multiclass mask comes from a worker and is
// 240–310 ms old when it arrives (ar-finish-v4.json); a moving person has moved on. Each lookup is
// mapped from "now" back to the mask's capture time by the landmarks' motion in between: a
// least-squares affine for the torso (shoulders + hips), a similarity per arm segment (shoulder →
// elbow, elbow → wrist). Pure, no DOM; all in source pixels.
import type { ImageLandmark } from '../../contract';
import { MIN_VISIBILITY } from './config';
import type { Vec2 } from './geometry';

/** x' = a·x + b·y + c, y' = d·x + e·y + f. */
export type Affine = [number, number, number, number, number, number];
export const IDENTITY: Affine = [1, 0, 0, 0, 1, 0];

/** The landmarks a mask's motion is measured from (BlazePose indices). */
export const MOTION_LANDMARKS = [11, 12, 13, 14, 15, 16, 23, 24] as const;
/** Landmark positions at one instant (source px), null where not seen. */
export type LandmarkSnapshot = Record<number, Vec2 | null>;

/** The motion of each region from now back to the mask's time. */
export type MaskMotion = {
  torso: Affine;
  /** [left upper, left fore, right upper, right fore] (geometry.ts arm order); null = torso's. */
  arms: (Affine | null)[];
};

/**
 * Limits of a plausible region motion over a mask's age (≈ 0.3 s): scale ratio and rotation
 * (rad). A fast forearm turns ≈ 300°/s, so up to ≈ 150° is real motion; beyond, or a segment
 * whose length changes by more than 35 %, is a landmark jump and only the translation is kept.
 */
const MAX_SCALE_CHANGE = 0.35;
const MAX_ROTATION = 2.6;

export function snapshot(l: readonly ImageLandmark[] | null): LandmarkSnapshot | null {
  if (!l) return null;
  const out: LandmarkSnapshot = {};
  for (const i of MOTION_LANDMARKS) {
    const p = l[i];
    out[i] = p && p.visibility >= MIN_VISIBILITY ? [p.x, p.y] : null;
  }
  return out;
}

export function applyAffine(T: Affine, p: Vec2): Vec2 {
  return [T[0] * p[0] + T[1] * p[1] + T[2], T[3] * p[0] + T[4] * p[1] + T[5]];
}

/** Translation only. */
export const translation = (dx: number, dy: number): Affine => [1, 0, dx, 0, 1, dy];

/**
 * The similarity (rotation, uniform scale, translation) mapping segment a0→b0 onto a1→b1, or
 * the translation of the midpoints when the change is implausible (a landmark jump).
 */
export function fitSimilarity(a0: Vec2, b0: Vec2, a1: Vec2, b1: Vec2): Affine {
  const u: Vec2 = [b0[0] - a0[0], b0[1] - a0[1]];
  const v: Vec2 = [b1[0] - a1[0], b1[1] - a1[1]];
  const lu = Math.hypot(u[0], u[1]),
    lv = Math.hypot(v[0], v[1]);
  const mid0: Vec2 = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2];
  const mid1: Vec2 = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2];
  const fallback = translation(mid1[0] - mid0[0], mid1[1] - mid0[1]);
  if (lu < 1 || lv < 1) return fallback;
  const s = lv / lu;
  const angle = Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]);
  if (Math.abs(Math.log(s)) > Math.log(1 + MAX_SCALE_CHANGE) || Math.abs(angle) > MAX_ROTATION)
    return fallback;
  const c = s * Math.cos(angle),
    sn = s * Math.sin(angle);
  // x' = R·s·(x − a0) + a1
  return [c, -sn, a1[0] - (c * a0[0] - sn * a0[1]), sn, c, a1[1] - (sn * a0[0] + c * a0[1])];
}

/**
 * Least-squares affine mapping `from` → `to` (≥ 3 non-collinear points), or null when the fit is
 * degenerate or implausible.
 */
export function fitAffine(from: readonly Vec2[], to: readonly Vec2[]): Affine | null {
  const n = from.length;
  if (n < 3 || to.length !== n) return null;
  // Normal equations for [a b c] (x') and [d e f] (y') with design rows [x y 1].
  let sxx = 0,
    sxy = 0,
    syy = 0,
    sx = 0,
    sy = 0;
  let tx = [0, 0, 0],
    ty = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const [x, y] = from[i],
      [X, Y] = to[i];
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sx += x;
    sy += y;
    tx = [tx[0] + x * X, tx[1] + y * X, tx[2] + X];
    ty = [ty[0] + x * Y, ty[1] + y * Y, ty[2] + Y];
  }
  const M = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const solve = (b: number[]) => {
    const det =
      M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
      M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
      M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    if (Math.abs(det) < 1e-6) return null;
    const col = (k: number) => M.map((row, r) => row.map((v, c) => (c === k ? b[r] : v)));
    const d3 = (A: number[][]) =>
      A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
      A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
      A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
    return [d3(col(0)) / det, d3(col(1)) / det, d3(col(2)) / det];
  };
  const r0 = solve(tx),
    r1 = solve(ty);
  if (!r0 || !r1) return null;
  const T: Affine = [r0[0], r0[1], r0[2], r1[0], r1[1], r1[2]];
  // Plausibility: the linear part's singular values within the scale-change limit.
  const det = T[0] * T[4] - T[1] * T[3];
  const norm2 = T[0] ** 2 + T[1] ** 2 + T[3] ** 2 + T[4] ** 2;
  const disc = Math.sqrt(Math.max(0, norm2 * norm2 - 4 * det * det));
  const smax = Math.sqrt((norm2 + disc) / 2),
    smin = Math.sqrt(Math.max(0, (norm2 - disc) / 2));
  const lo = 1 / (1 + MAX_SCALE_CHANGE),
    hi = 1 + MAX_SCALE_CHANGE;
  if (det <= 0 || smax > hi || smin < lo) return null;
  return T;
}

/**
 * The per-region motion from `now` back to `then` (the mask's capture), so that a lookup at a
 * current pixel p reads the mask at T(p). Missing landmarks fall back to the torso's motion, and
 * the torso to the shoulders' similarity or their midpoint's translation.
 */
export function maskMotion(
  now: LandmarkSnapshot | null,
  then: LandmarkSnapshot | null,
): MaskMotion {
  if (!now || !then) return { torso: IDENTITY, arms: [null, null, null, null] };
  const both = (i: number) => (now[i] && then[i] ? ([now[i]!, then[i]!] as const) : null);
  const torsoPts = [11, 12, 23, 24].map(both).filter((x) => x !== null);
  let torso: Affine | null = null;
  if (torsoPts.length >= 3)
    torso = fitAffine(
      torsoPts.map((p) => p![0]),
      torsoPts.map((p) => p![1]),
    );
  const ls = both(11),
    rs = both(12);
  if (!torso && ls && rs) torso = fitSimilarity(ls[0], rs[0], ls[1], rs[1]);
  if (!torso && torsoPts.length) {
    const [p, q] = torsoPts[0]!;
    torso = translation(q[0] - p[0], q[1] - p[1]);
  }
  const arm = (a: number, b: number) => {
    const A = both(a),
      B = both(b);
    return A && B ? fitSimilarity(A[0], B[0], A[1], B[1]) : null;
  };
  return {
    torso: torso ?? IDENTITY,
    arms: [arm(11, 13), arm(13, 15), arm(12, 14), arm(14, 16)],
  };
}
