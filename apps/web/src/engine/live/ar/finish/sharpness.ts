// F4 (?f4sharp=1): the camera's own edge sharpness, measured live, and the jacket blur that
// matches it with a floor that keeps the jacket crisp. Pure, no DOM, no GL.
//
// Estimator: on each row of a small crop straddling the person's outline (the upper arm against
// the background), the strongest luminance step; its width = contrast / steepest slope (a linear
// ramp of that width has that slope; for a Gaussian-blurred step it is 2.51 σ, close to the 10–90 %
// width 2.56 σ; an ideal pixel-sharp step reads ≈ 1). The median over rows is the camera's edge
// transition in source pixels.

/** Rec. 601 luma (0..255) of an RGBA byte buffer, row-major. */
function lumaRows(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Float32Array {
  const y = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++)
    y[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  return y;
}

/**
 * Width (px) of the strongest step in a 1-D profile: contrast between the plateaus 3–5 px each side
 * of the steepest point, over that slope. Null when the step is too weak (< minContrast levels).
 */
export function stepWidth(p: ArrayLike<number>, minContrast = 24): number | null {
  const n = p.length;
  if (n < 12) return null;
  let best = -1,
    bestSlope = 0;
  for (let i = 5; i < n - 6; i++) {
    const s = Math.abs(p[i + 1] - p[i]);
    if (s > bestSlope) {
      bestSlope = s;
      best = i;
    }
  }
  if (best < 0 || bestSlope <= 0) return null;
  const mean = (a: number, b: number) => {
    let t = 0;
    for (let k = a; k <= b; k++) t += p[k];
    return t / (b - a + 1);
  };
  const lo = mean(Math.max(0, best - 5), Math.max(0, best - 3)),
    hi = mean(Math.min(n - 1, best + 4), Math.min(n - 1, best + 6));
  const contrast = Math.abs(hi - lo);
  if (contrast < minContrast) return null;
  // The steepest single-pixel difference spans one pixel: width = contrast / slope (≥ 1).
  return Math.max(1, contrast / bestSlope);
}

/** Median step width over the rows of an RGBA crop (rows top-down or bottom-up alike), or null. */
export function cameraEdgeWidth(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
): number | null {
  const y = lumaRows(rgba, w, h);
  const widths: number[] = [];
  for (let r = 0; r < h; r++) {
    const width = stepWidth(y.subarray(r * w, (r + 1) * w));
    if (width !== null) widths.push(width);
  }
  if (widths.length < Math.max(3, h / 4)) return null;
  widths.sort((a, b) => a - b);
  return widths[widths.length >> 1];
}

/**
 * The jacket blur σ (source px) that brings the jacket's own edge transition `jacketPx` to the
 * camera's `cameraPx`, but never past `floorPx` (the crispest acceptable transition, source px):
 * transitions add in quadrature, a Gaussian's 10–90 % width is 2.563 σ. 0 when the jacket is
 * already as soft as the target.
 */
export function matchedSigma(cameraPx: number, jacketPx: number, floorPx: number): number {
  const target = Math.min(cameraPx, floorPx);
  return Math.sqrt(Math.max(0, target * target - jacketPx * jacketPx)) / 2.563;
}

/**
 * F4 (?f4grain=1): the camera's TEMPORAL noise σ (8-bit luma levels) from the same patch read on
 * two different frames: per-pixel difference, robust σ = 1.4826 · MAD / √2 (motion or a cut
 * changes few pixels of a background patch; the MAD ignores them). Null when the frames are the
 * same frame (≥ 90 % of the differences are exactly 0) or sizes differ.
 */
export function temporalSigma(
  a: Uint8Array | Uint8ClampedArray,
  b: Uint8Array | Uint8ClampedArray,
): number | null {
  if (a.length !== b.length || a.length < 16) return null;
  const n = a.length / 4;
  const d = new Float32Array(n);
  let zeros = 0;
  for (let i = 0; i < n; i++) {
    const ya = 0.299 * a[i * 4] + 0.587 * a[i * 4 + 1] + 0.114 * a[i * 4 + 2];
    const yb = 0.299 * b[i * 4] + 0.587 * b[i * 4 + 1] + 0.114 * b[i * 4 + 2];
    d[i] = ya - yb;
    if (d[i] === 0) zeros++;
  }
  if (zeros >= 0.9 * n) return null;
  const sorted = Float32Array.from(d).sort();
  const med = sorted[n >> 1];
  const dev = Float32Array.from(d, (x) => Math.abs(x - med)).sort();
  return (1.4826 * dev[n >> 1]) / Math.SQRT2;
}
