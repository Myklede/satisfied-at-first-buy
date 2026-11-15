// Fit Lab parka hood shape (agent HK, 2026-11-15 06:40; user: "the hood is flat, it does not read
// as a hood; make it like the real jacket"). Edits the baked hood's rest positions ONCE per hood
// instance (HoodLayer base), before refresh(). Display only: fit numbers never read the hood.
//
// The AR's drape (ar/hoodDrape.ts, keep 0.32 of the height) squashes the hood into a flat collar.
// The real FB7675-100 hood down (Nike gallery 1–4, Parka6 back) is a big padded hood whose rounded
// crown rises behind the neck above the shoulders. So: a gentle drape (keep most of the height so
// it still rests behind the head, not standing up beside it) plus a padded loft that swells the
// crown away from the hood's own centre, fading to 0 at the seam row so the seam fit is unchanged.
import { drapeHood } from '../../../engine/live/ar/hoodDrape';

/** Height kept over the seam (AR uses 0.32). Visual heuristic vs Nike gallery 1–4. */
export const PARKA_HOOD_KEEP = 0.72;
/** Depth kept behind the seam (AR uses 0.6). */
export const PARKA_HOOD_KEEP_BACK = 0.85;
/** Padded loft at the crown (m), fading in over PARKA_LOFT_RAMP_M above the seam. */
export const PARKA_HOOD_LOFT_M = 0.025;
export const PARKA_LOFT_RAMP_M = 0.08;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Swells every vertex above the seam away from the hood's centroid, 0 at the seam row. Pure. */
export function loftHood(
  positions: Float32Array,
  attach: ArrayLike<number>,
  loft = PARKA_HOOD_LOFT_M,
  ramp = PARKA_LOFT_RAMP_M,
): void {
  const n = Math.min(Math.floor(positions.length / 3), attach.length);
  if (n === 0) return;
  let cx = 0,
    cy = 0,
    cz = 0,
    seamY = 0,
    seamN = 0;
  for (let v = 0; v < n; v++) {
    cx += positions[v * 3];
    cy += positions[v * 3 + 1];
    cz += positions[v * 3 + 2];
    if (attach[v] >= 0.5) {
      seamY += positions[v * 3 + 1];
      seamN++;
    }
  }
  if (seamN === 0) return;
  cx /= n;
  cy /= n;
  cz /= n;
  seamY /= seamN;
  for (let v = 0; v < n; v++) {
    if (attach[v] >= 0.5) continue;
    const h = positions[v * 3 + 1] - seamY;
    const w = smooth(0, ramp, h);
    if (w <= 0) continue;
    const dx = positions[v * 3] - cx,
      dy = positions[v * 3 + 1] - cy,
      dz = positions[v * 3 + 2] - cz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) continue;
    // Never toward the body front (+Z): a hood swelling forward would enter the head.
    const s = (loft * w) / len;
    positions[v * 3] += dx * s;
    positions[v * 3 + 1] += Math.max(0, dy) * s;
    positions[v * 3 + 2] += Math.min(0, dz) * s;
  }
}

export function shapeParkaHood(
  positions: Float32Array,
  sigma: ArrayLike<number>,
  attach: ArrayLike<number>,
): void {
  drapeHood(positions, sigma, attach, PARKA_HOOD_KEEP, PARKA_HOOD_KEEP_BACK);
  loftHood(positions, attach);
}
