// Pure math of the padded hood (agent H): where the shell's hood seam is, how the baked hood's
// seam is fitted onto it (similarity + a small seam blend), and how the baked states blend.
// No Three.js here; every function is unit-tested (hoodFit.test.ts).

import { HOOD } from './hoodConfig';

/** Minimal view of the cloth asset this module reads (a structural subset of ClothAsset). */
export interface ShellSeamSource {
  panels: readonly number[];
  triangles: readonly number[];
  paths: Record<string, readonly number[]>;
  maximum_loft_m: number;
}

export type Vec3 = [number, number, number];

/** shell.py panel id of the shell's own hood (docs/requests/Z-to-L2.md, interact/seam.ts). */
export const PANEL_HOOD = 7;

/**
 * Shell vertex ids of the hood attach seam, ordered from the wearer's right front (-X) round the
 * back to the left (the same rule as scripts/blender/hood_reference.py, which baked the hood).
 * Removable hood (puffer): L2's `paths.hood_zip` on the funnel collar's top. Sewn-in hood
 * (parka): the real jacket has no stand collar (spec), so the hood is sewn into the neckline and
 * covers shell.py's 6.5 cm collar band: `paths.neckline` from the front-most angle at which the
 * hood panel joins the collar, round the back. No edge walk: the collar row under the hood has
 * gaps of several cm on some bodies (soak sweep).
 */
export function shellSeamIds(asset: ShellSeamSource, positions: ArrayLike<number>): number[] {
  const zip = asset.paths.hood_zip;
  if (zip && zip.length > 1) return orientRightFirst([...zip], positions);
  const neck = asset.paths.neckline;
  if (!neck || neck.length < 3) throw new Error('This jacket has no neckline path');
  const { panels, triangles } = asset;
  const joint = new Set<number>();
  for (let t = 0; t < triangles.length; t += 3) {
    const tri = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const hood = tri.filter((v) => panels[v] === PANEL_HOOD).length;
    if (hood > 0 && hood < 3) for (const v of tri) if (panels[v] !== PANEL_HOOD) joint.add(v);
  }
  if (!joint.size) throw new Error('This jacket has no hood joined to the collar');
  let cx = 0,
    cz = 0;
  for (const i of neck) {
    cx += positions[i * 3] / neck.length;
    cz += positions[i * 3 + 2] / neck.length;
  }
  // Degrees from the front, negative on the wearer's right (-X).
  const angle = (i: number) =>
    (Math.atan2(positions[i * 3] - cx, positions[i * 3 + 2] - cz) * 180) / Math.PI;
  let corner = 180;
  for (const i of joint) corner = Math.min(corner, Math.abs(angle(i)));
  const key = (i: number) => (angle(i) < 0 ? -angle(i) : 360 - angle(i));
  const seam = neck.filter((i) => Math.abs(angle(i)) >= corner).sort((a, b) => key(a) - key(b));
  if (seam.length < 3) throw new Error('Hood seam has fewer than 3 points');
  return seam;
}

function orientRightFirst(ids: number[], positions: ArrayLike<number>) {
  return positions[ids[0] * 3] > positions[ids[ids.length - 1] * 3] ? ids.reverse() : ids;
}

export function distance(a: Vec3, b: Vec3) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Normalised arc length (0..1) of each polyline point. */
export function arcParams(points: readonly Vec3[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + distance(points[i - 1], points[i]));
  const total = out[out.length - 1] || 1;
  return out.map((v) => v / total);
}

/** Point at normalised arc length `s` along a polyline with params `arc` (from arcParams). */
export function sampleAt(points: readonly Vec3[], arc: readonly number[], s: number): Vec3 {
  if (s <= 0) return [...points[0]];
  if (s >= 1) return [...points[points.length - 1]];
  let i = 1;
  while (i < arc.length - 1 && arc[i] < s) i++;
  const t = (s - arc[i - 1]) / (arc[i] - arc[i - 1] || 1);
  const a = points[i - 1],
    b = points[i];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Similarity transform p -> s R p + t (R row-major 3x3). */
export interface Similarity {
  scale: number;
  rotation: number[];
  translation: Vec3;
  /** Scale the least-squares fit asked for, before clamping. */
  rawScale: number;
}

export function applySimilarity(f: Similarity, p: Vec3): Vec3 {
  const r = f.rotation;
  return [
    f.scale * (r[0] * p[0] + r[1] * p[1] + r[2] * p[2]) + f.translation[0],
    f.scale * (r[3] * p[0] + r[4] * p[1] + r[5] * p[2]) + f.translation[1],
    f.scale * (r[6] * p[0] + r[7] * p[1] + r[8] * p[2]) + f.translation[2],
  ];
}

/**
 * Least-squares similarity (Umeyama 1991) taking `from` onto `to` (paired points), scale
 * clamped to [HOOD.minScale, HOOD.maxScale] (a hood is graded with its jacket, never squashed).
 * The 3x3 SVD is done through the symmetric eigenproblem of H^T H (Jacobi), which is exact
 * enough for a seam of tens of points.
 */
export function fitSimilarity(from: readonly Vec3[], to: readonly Vec3[]): Similarity {
  const n = from.length;
  if (n < 3 || to.length !== n) throw new Error('Similarity fit needs >= 3 paired points');
  const ca = centroid(from),
    cb = centroid(to);
  let varA = 0;
  const h = new Array(9).fill(0); // sum (b - cb)(a - ca)^T
  for (let i = 0; i < n; i++) {
    const a = sub(from[i], ca),
      b = sub(to[i], cb);
    varA += a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) h[r * 3 + c] += b[r] * a[c];
  }
  const { u, s, v } = svd3(h);
  const d = det3(u) * det3(v) < 0 ? -1 : 1;
  const ds = [1, 1, d];
  // R = U diag(1,1,d) V^T
  const rotation = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) rotation[r * 3 + c] += u[r * 3 + k] * ds[k] * v[c * 3 + k];
  const rawScale = (s[0] + s[1] + d * s[2]) / (varA || 1);
  const scale = Math.min(HOOD.maxScale, Math.max(HOOD.minScale, rawScale));
  const rca = applySimilarity({ scale, rotation, translation: [0, 0, 0], rawScale }, ca);
  return { scale, rotation, translation: sub(cb, rca), rawScale };
}

function centroid(points: readonly Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const p of points) for (let k = 0; k < 3; k++) c[k] += p[k] / points.length;
  return c;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function det3(m: number[]) {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

/** SVD of a 3x3 (row-major): H = U diag(s) V^T, s descending, via Jacobi on H^T H. */
export function svd3(h: number[]): { u: number[]; s: number[]; v: number[] } {
  const a = new Array(9).fill(0); // H^T H
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) a[r * 3 + c] += h[k * 3 + r] * h[k * 3 + c];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      const apq = a[p * 3 + q];
      off += apq * apq;
      if (Math.abs(apq) < 1e-30) continue;
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1),
        s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p],
          akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k],
          aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p],
          vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
    if (off < 1e-30) break;
  }
  const order = [0, 1, 2].sort((i, j) => a[j * 4] - a[i * 4]);
  const vs = new Array(9).fill(0);
  const s = order.map((i) => Math.sqrt(Math.max(0, a[i * 4])));
  order.forEach((i, col) => {
    for (let r = 0; r < 3; r++) vs[r * 3 + col] = v[r * 3 + i];
  });
  // U columns = H v / s (Gram-Schmidt for a rank-deficient H).
  const u = new Array(9).fill(0);
  const cols: Vec3[] = [];
  for (let col = 0; col < 3; col++) {
    let w: Vec3 = [0, 0, 0];
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) w[r] += h[r * 3 + k] * vs[k * 3 + col];
    for (const prev of cols) {
      const d = w[0] * prev[0] + w[1] * prev[1] + w[2] * prev[2];
      w = [w[0] - d * prev[0], w[1] - d * prev[1], w[2] - d * prev[2]];
    }
    let len = Math.hypot(...w);
    if (len < 1e-12) {
      // Complete the basis: cross of the previous two (or any perpendicular).
      w =
        cols.length === 2 ? cross(cols[0], cols[1]) : perpendicular(cols[0] ?? ([1, 0, 0] as Vec3));
      len = Math.hypot(...w);
    }
    cols.push([w[0] / len, w[1] / len, w[2] / len]);
  }
  cols.forEach((c, col) => {
    for (let r = 0; r < 3; r++) u[r * 3 + col] = c[r];
  });
  return { u, s, v: vs };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function perpendicular(a: Vec3): Vec3 {
  return Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]);
}

export function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * How far a seam point at `sigma` has lifted off the collar when the hood's zip is open over
 * `progress` (0 on .. 1 off), opened from the wearer's right as Z's hood_zip order. The same
 * frontier as the baked peel keys (scripts/blender/hood_geometry.py `peel`).
 */
export function liftedAt(sigma: number, progress: number, width = HOOD.peelWidth) {
  const front = progress * (1 + width);
  return smoothstep(front, front - width, sigma);
}

/**
 * Weights of the baked keys for a detach progress (0 = down .. 1 = detached): piecewise linear
 * between neighbouring keys placed at `positions` (ascending, first 0, last 1).
 */
export function keyWeights(positions: readonly number[], progress: number): number[] {
  const p = Math.min(1, Math.max(0, progress));
  const w = positions.map(() => 0);
  for (let i = 1; i < positions.length; i++) {
    if (p <= positions[i] || i === positions.length - 1) {
      const t = (p - positions[i - 1]) / (positions[i] - positions[i - 1] || 1);
      w[i - 1] = 1 - Math.min(1, Math.max(0, t));
      w[i] = Math.min(1, Math.max(0, t));
      return w;
    }
  }
  w[0] = 1;
  return w;
}

/** Index buffer of the shell without its own hood panel (every triangle touching panel 7). */
export function indexWithoutHood(asset: Pick<ShellSeamSource, 'panels' | 'triangles'>) {
  const keep: number[] = [];
  const { panels, triangles } = asset;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t],
      b = triangles[t + 1],
      c = triangles[t + 2];
    if (panels[a] !== PANEL_HOOD && panels[b] !== PANEL_HOOD && panels[c] !== PANEL_HOOD)
      keep.push(a, b, c);
  }
  return Uint32Array.from(keep);
}
