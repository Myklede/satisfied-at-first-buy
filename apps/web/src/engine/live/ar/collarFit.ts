// Collar front fit for the AR (agent F3, prompt 23 defect D7; behind ?f3collar=1). Pure.
//
// The puffer's funnel collar (8 cm, services config SHELL_FUNNEL_COLLAR_M) is drawn zipped. In
// the glued AR the shoulders are pinned to the person's shoulder landmarks, so the collar's
// height above them is the 3D garment's, and on the venue clip its top stood at the nose (the
// real jacket, zipped, reaches the lower lip: user/CH 2026-11-13; worn open in venue-mac-ao, the
// chin). The collar-to-face control of the glue squashed the small collar–shoulder region past
// the warp's cap (lead 18:00), so the fit is done on the 3D collar instead: the collar is
// lowered by `drop` at its top edge (nothing at the neckline seam, linear between), round the
// front AND the sides, fading only behind the neck: a front-only fold left the funnel's sides
// standing as two horns round the face (user's live test 18:13, close range). The removable
// hood is refitted to the lowered crest by the GarmentLayer. Visual only: no fit number reads
// these positions.
import { PANEL } from '../../garmentSurface';

export type CollarPaths = { neckline?: readonly number[]; collar_top?: readonly number[] };

/** Ring statistics of the collar (scene m), or null when the asset has no funnel collar. */
export function collarFrame(
  positions: ArrayLike<number>,
  paths: CollarPaths,
): { cx: number; cz: number; base: number; top: number } | null {
  const neck = paths.neckline,
    top = paths.collar_top;
  if (!neck?.length || !top?.length) return null;
  const n = Math.floor(positions.length / 3);
  let cx = 0,
    cz = 0,
    k = 0;
  for (const v of neck) {
    if (!(v >= 0 && v < n)) continue;
    cx += positions[v * 3];
    cz += positions[v * 3 + 2];
    k++;
  }
  if (!k) return null;
  cx /= k;
  cz /= k;
  // Heights at the FRONT half (z ≥ the ring centre): the part in front of the face.
  const front = (ids: readonly number[]) => {
    let y = 0,
      m = 0;
    for (const v of ids) {
      if (!(v >= 0 && v < n) || positions[v * 3 + 2] < cz) continue;
      y += positions[v * 3 + 1];
      m++;
    }
    return m ? y / m : null;
  };
  const base = front(neck),
    high = front(top);
  if (base === null || high === null || high - base < 0.01) return null;
  return { cx, cz, base, top: high };
}

/**
 * Lowers the collar panel's front by `drop` metres in place (see above). The drop is limited to
 * `maxShare` of the collar's height (the front then keeps 1 − maxShare of it: on the judge's
 * venue run the funnel top stood at the nose tip, 6–7 cm above the chin, and 0.6 of 8 cm left
 * it over the mouth; with the arms up it rises further). Linear in height, so each column stays monotone for any share < 1.
 * Returns the drop applied (m).
 */
export function lowerCollarFront(
  positions: Float32Array,
  panels: ArrayLike<number>,
  paths: CollarPaths,
  drop: number,
  maxShare = 0.95,
): number {
  if (!(drop > 0)) return 0;
  const f = collarFrame(positions, paths);
  if (!f) return 0;
  const h = f.top - f.base;
  const d = Math.min(drop, maxShare * h);
  const n = Math.min(panels.length, Math.floor(positions.length / 3));
  for (let v = 0; v < n; v++) {
    if (panels[v] !== PANEL.collar) continue;
    const y = positions[v * 3 + 1];
    // The same fold all round (front, sides AND back): a fold that faded toward the back left
    // the sides standing as a U round the face, or (kept off the hood root) left the puffer's
    // hood sitting high on the back crest, a lump behind the head at the turn (look jobs 21:5x);
    // a fold that changed along the hood's root re-fitted the hood into a disc. A uniform drop
    // only translates the hood's seam, so the hood moves down with it, unchanged.
    const w = Math.min(1, Math.max(0, (y - f.base) / h));
    positions[v * 3 + 1] = y - d * w;
  }
  return d;
}
