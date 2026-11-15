// Mask packing for the finishing pass (agent V4). Pure, no DOM, no GL. Masks are row 0 = image
// top, like MediaPipe's; the textures keep that order (DataTexture flipY false) and the shader
// samples them at (x / W, y / H).
import { CLASS } from './config';

export type ByteMask = { data: Uint8Array; width: number; height: number };

/** Output size for a mask downsampled by an integer step so its width is ≤ maxWidth. */
export function downsampleSize(width: number, height: number, maxWidth: number) {
  const step = Math.max(1, Math.ceil(width / Math.max(1, maxWidth)));
  return {
    step,
    width: Math.max(1, Math.floor(width / step)),
    height: Math.max(1, Math.floor(height / step)),
  };
}

/**
 * Person mask (0..1 floats) → bytes at ≤ maxWidth (nearest sample per output pixel; the
 * texture's bilinear filter smooths it). Reuses `out` when its size matches.
 * `centre` (F4, ?f4edge=1): sample each block at its centre. The texture treats output texel i as
 * centred on source x = (i + ½)·step, so the corner sample (default) shifts the whole mask by half
 * a block (2 px right and down at step 4).
 */
export function packPerson(
  mask: { data: Float32Array; width: number; height: number },
  maxWidth: number,
  out?: ByteMask,
  centre = false,
): ByteMask {
  const { step, width, height } = downsampleSize(mask.width, mask.height, maxWidth);
  const o = centre ? step >> 1 : 0;
  const target =
    out && out.width === width && out.height === height
      ? out
      : { data: new Uint8Array(width * height), width, height };
  const d = target.data;
  for (let y = 0; y < height; y++) {
    const row = (y * step + o) * mask.width + o;
    for (let x = 0; x < width; x++) {
      const m = mask.data[row + x * step];
      d[y * width + x] = m <= 0 ? 0 : m >= 1 ? 255 : Math.round(m * 255);
    }
  }
  return target;
}

/**
 * F4 (?f4stable=1) hysteresis on a 0..255 mask round its 0.5 edge, in place: a pixel that was in
 * (≥ 128 in `prev`) stays in until it drops below band[0]; one that was out stays out until it
 * rises above band[1]; `prev` becomes the result. Values far from the edge pass unchanged.
 */
export function hysteresis(cur: Uint8Array, prev: Uint8Array, band: readonly [number, number]) {
  const [lo, hi] = band;
  for (let i = 0; i < cur.length; i++) {
    const v = cur[i];
    let o = v;
    if (prev[i] >= 128) {
      if (v < 128 && v >= lo) o = 128;
    } else if (v >= 128 && v <= hi) o = 127;
    cur[i] = o;
    prev[i] = o;
  }
}

/**
 * Selfie multiclass category mask → RGBA bytes at ≤ maxWidth, one channel per group so the
 * texture can be filtered (categories cannot):
 *   R = clothes or others (what must be covered), G = body skin (arms, hands),
 *   B = face skin or hair (never covered), A = any person class.
 * Each output pixel is the share of its step×step block in that group (a box filter).
 */
export function packClasses(
  mask: { data: Uint8Array; width: number; height: number },
  maxWidth: number,
  out?: ByteMask,
): ByteMask {
  const { step, width, height } = downsampleSize(mask.width, mask.height, maxWidth);
  const target =
    out && out.width === width && out.height === height && out.data.length === width * height * 4
      ? out
      : { data: new Uint8Array(width * height * 4), width, height };
  const d = target.data;
  // Sub-sample the block on a 2×2 lattice (cost: 4 reads per output pixel at any step).
  const offs = step >= 2 ? [0, step >> 1] : [0];
  const n = offs.length * offs.length;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let c = 0,
        s = 0,
        f = 0,
        p = 0;
      for (const oy of offs)
        for (const ox of offs) {
          const k = mask.data[(y * step + oy) * mask.width + x * step + ox];
          if (k === CLASS.clothes || k === CLASS.others) c++;
          else if (k === CLASS.bodySkin) s++;
          else if (k === CLASS.faceSkin || k === CLASS.hair) f++;
          if (k !== CLASS.background) p++;
        }
      const i = (y * width + x) * 4;
      d[i] = Math.round((255 * c) / n);
      d[i + 1] = Math.round((255 * s) / n);
      d[i + 2] = Math.round((255 * f) / n);
      d[i + 3] = Math.round((255 * p) / n);
    }
  return target;
}

/**
 * Coverage numbers from a metric readback (RGBA bytes; R = upper-body clothing, G = uncovered
 * before the finisher, B = uncovered after). Fractions of the clothing area; null when empty.
 */
export function coverageFromMetric(rgba: Uint8Array) {
  let region = 0,
    before = 0,
    after = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] < 128) continue;
    region++;
    if (rgba[i + 1] >= 128) before++;
    if (rgba[i + 2] >= 128) after++;
  }
  return region
    ? { regionPx: region, uncoveredBefore: before / region, uncoveredAfter: after / region }
    : null;
}

/**
 * A stale-mask render scored against a fresh one of the same frame (metric readbacks, RGBA):
 * `missed` = clothing by the fresh mask (ref R) left uncovered in the test render (test B);
 * `wrongFill` = the test render's fill (test A) on what the fresh mask says is not clothing.
 * Both as fractions of the fresh clothing area; null when it is empty.
 */
export function staleScores(ref: Uint8Array, test: Uint8Array) {
  let clothing = 0,
    missed = 0,
    wrong = 0;
  for (let i = 0; i < ref.length; i += 4) {
    const isClothing = ref[i] >= 128;
    if (isClothing) {
      clothing++;
      if (test[i + 2] >= 128) missed++;
    } else if (test[i + 3] >= 128) wrong++;
  }
  return clothing
    ? { clothingPx: clothing, missed: missed / clothing, wrongFill: wrong / clothing }
    : null;
}

/**
 * CPU reference of the F4 edge-aware mask refinement (shaders.ts personRefined, ?f4edge=1):
 * joint-bilateral upsampling (Kopf et al. 2007) of a low-res 0..1 mask at full-res pixel (x, y)
 * guided by a full-res image. `mask(u, v)` samples the low-res mask bilinearly at full-res
 * coordinates; `guide(x, y)` returns the image's colour there (0..1 per channel). Taps on a 7×7
 * lattice `tap` px apart, weighted by exp(−|Δcolour|²/2σr² − |Δtap|²/2σs²). Pixels where the
 * mask is already decided (< 0.03 or > 0.97) are returned unchanged.
 */
export function jbuRefine(
  mask: (x: number, y: number) => number,
  guide: (x: number, y: number) => readonly [number, number, number],
  x: number,
  y: number,
  tap: number,
  rangeSigma: number,
  spatialSigma: number,
): number {
  const m0 = mask(x, y);
  if (m0 < 0.03 || m0 > 0.97) return m0;
  const c0 = guide(x, y);
  const kr = 0.5 / (rangeSigma * rangeSigma),
    ks = 0.5 / (spatialSigma * spatialSigma);
  let acc = 0,
    sum = 0;
  for (let j = -3; j <= 3; j++)
    for (let i = -3; i <= 3; i++) {
      const qx = x + i * tap,
        qy = y + j * tap;
      const c = guide(qx, qy);
      const d2 = (c[0] - c0[0]) ** 2 + (c[1] - c0[1]) ** 2 + (c[2] - c0[2]) ** 2;
      const w = Math.exp(-d2 * kr - (i * i + j * j) * ks);
      acc += w * mask(qx, qy);
      sum += w;
    }
  return sum > 1e-5 ? acc / sum : m0;
}
