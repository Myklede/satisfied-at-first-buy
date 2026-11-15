// Particle LBS local frames (agent V7). A live jacket particle is skinned as
//   p(pose) = B_i(pose) · rest_i,   B_i = Σ_k w_ik · M[d_ik]   (3×4, garmentSkin.ts)
// so a cloth offset Δ (solved − skinned, world metres) is stored as B_i⁻¹·Δ (the inverse of the
// blend's 3×3 linear part: offsets are directions, translation does not apply) and played back as
// B_i(now)·local. That makes a stored correction follow the body the way the skinned jacket does
// (rotations of the trunk, the arm, the bend of the elbow). Pure, no DOM. Scene frame: metres,
// X = the subject's LEFT, Y up, +Z front.
import { DRIVER_STRIDE } from '../../../motion/rig.ts';

/** What the local-frame maths needs of a skin binding (LiveGarmentBinding has these fields). */
export type SkinArrays = {
  count: number;
  skinDrivers: Uint8Array;
  skinWeights: Float32Array;
};

/** Influences per particle in a binding: skinDrivers.length / count (GARMENT_INFLUENCES = 4). */
export const influencesOf = (skin: SkinArrays) => {
  const g = skin.skinDrivers.length / skin.count;
  if (!Number.isInteger(g) || g < 1 || skin.skinWeights.length !== skin.skinDrivers.length)
    throw new Error('Skin binding arrays do not match its particle count');
  return g;
};

/** Blended 3×4 transform of particle i (row-major) into out[o..o+11]. */
export function particleBlend(
  skin: SkinArrays,
  G: number,
  i: number,
  m: ArrayLike<number>,
  out: Float64Array,
  o = 0,
) {
  for (let j = 0; j < 12; j++) out[o + j] = 0;
  for (let k = 0; k < G; k++) {
    const w = skin.skinWeights[i * G + k];
    if (!w) continue;
    const d = skin.skinDrivers[i * G + k] * DRIVER_STRIDE;
    for (let j = 0; j < 12; j++) out[o + j] += w * m[d + j];
  }
  return out;
}

/** Inverse of the 3×3 linear part of a 3×4 at b[o..], written as a 3×3 into out[0..8]. */
function invertLinear(b: Float64Array, o: number, out: Float64Array) {
  const a = b[o],
    c1 = b[o + 1],
    c2 = b[o + 2],
    d = b[o + 4],
    e = b[o + 5],
    f = b[o + 6],
    g = b[o + 8],
    h = b[o + 9],
    k = b[o + 10];
  const A = e * k - f * h,
    B = -(d * k - f * g),
    C = d * h - e * g;
  const det = a * A + c1 * B + c2 * C;
  if (!(Math.abs(det) > 1e-9)) throw new Error('Singular particle skin transform');
  const r = 1 / det;
  out[0] = A * r;
  out[1] = -(c1 * k - c2 * h) * r;
  out[2] = (c1 * f - c2 * e) * r;
  out[3] = B * r;
  out[4] = (a * k - c2 * g) * r;
  out[5] = -(a * f - c2 * d) * r;
  out[6] = C * r;
  out[7] = -(a * h - c1 * g) * r;
  out[8] = (a * e - c1 * d) * r;
  return out;
}

/**
 * World offsets → particle-local offsets: out_i = B_i(m)⁻¹ · delta_i (linear part). `delta` and
 * `out` are N·3 and may be the same array.
 */
export function toLocal<T extends Float32Array | Float64Array>(
  skin: SkinArrays,
  m: ArrayLike<number>,
  delta: ArrayLike<number>,
  out: T,
): T {
  const G = influencesOf(skin);
  const blend = new Float64Array(12),
    inv = new Float64Array(9);
  for (let i = 0; i < skin.count; i++) {
    particleBlend(skin, G, i, m, blend);
    invertLinear(blend, 0, inv);
    const x = delta[i * 3],
      y = delta[i * 3 + 1],
      z = delta[i * 3 + 2];
    out[i * 3] = inv[0] * x + inv[1] * y + inv[2] * z;
    out[i * 3 + 1] = inv[3] * x + inv[4] * y + inv[5] * z;
    out[i * 3 + 2] = inv[6] * x + inv[7] * y + inv[8] * z;
  }
  return out;
}

/** Particle-local offsets → world offsets: out_i = B_i(m) · local_i (linear part). */
export function toWorld<T extends Float32Array | Float64Array>(
  skin: SkinArrays,
  m: ArrayLike<number>,
  local: ArrayLike<number>,
  out: T,
): T {
  const G = influencesOf(skin);
  const blend = new Float64Array(12);
  for (let i = 0; i < skin.count; i++) {
    particleBlend(skin, G, i, m, blend);
    const x = local[i * 3],
      y = local[i * 3 + 1],
      z = local[i * 3 + 2];
    out[i * 3] = blend[0] * x + blend[1] * y + blend[2] * z;
    out[i * 3 + 1] = blend[4] * x + blend[5] * y + blend[6] * z;
    out[i * 3 + 2] = blend[8] * x + blend[9] * y + blend[10] * z;
  }
  return out;
}

/**
 * The LBS position of every particle at drivers `m`, from its bound (neutral) position and the
 * neutral drivers `m0`: p = B(m) · B(m0)⁻¹ · bound. Identical to skinGarment's B(m)·rest, since
 * garmentSkin's rest IS B(m0)⁻¹·bound (bindGarment), up to float rounding.
 */
export function skinFromBound<T extends Float32Array | Float64Array>(
  skin: SkinArrays,
  bound: ArrayLike<number>,
  m0: ArrayLike<number>,
  m: ArrayLike<number>,
  out: T,
): T {
  const G = influencesOf(skin);
  const b0 = new Float64Array(12),
    b = new Float64Array(12),
    inv = new Float64Array(9);
  for (let i = 0; i < skin.count; i++) {
    particleBlend(skin, G, i, m0, b0);
    invertLinear(b0, 0, inv);
    // rest = inv · (bound − t0)
    const x = bound[i * 3] - b0[3],
      y = bound[i * 3 + 1] - b0[7],
      z = bound[i * 3 + 2] - b0[11];
    const rx = inv[0] * x + inv[1] * y + inv[2] * z,
      ry = inv[3] * x + inv[4] * y + inv[5] * z,
      rz = inv[6] * x + inv[7] * y + inv[8] * z;
    particleBlend(skin, G, i, m, b);
    out[i * 3] = b[0] * rx + b[1] * ry + b[2] * rz + b[3];
    out[i * 3 + 1] = b[4] * rx + b[5] * ry + b[6] * rz + b[7];
    out[i * 3 + 2] = b[8] * rx + b[9] * ry + b[10] * rz + b[11];
  }
  return out;
}

/**
 * Local correction field of one true solve: B(m)⁻¹ · (solved − skinned), where skinned is the
 * live LBS of the same particles at the same drivers. N·3, Float32.
 */
export function localOffsets(
  skin: SkinArrays,
  bound: ArrayLike<number>,
  m0: ArrayLike<number>,
  m: ArrayLike<number>,
  solved: ArrayLike<number>,
) {
  const n = skin.count;
  const skinned = skinFromBound(skin, bound, m0, m, new Float64Array(n * 3));
  for (let i = 0; i < n * 3; i++) skinned[i] = solved[i] - skinned[i];
  return toLocal(skin, m, skinned, new Float32Array(n * 3));
}
