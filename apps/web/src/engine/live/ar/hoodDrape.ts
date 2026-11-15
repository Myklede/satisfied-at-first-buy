// The parka's hood lying DOWN in the AR (agent F3, lead's U3, 2026-11-14 19:00; behind
// ?f3hood=1). Pure.
//
// The padded hood (HoodLayer, agent H's baked "down" shape fitted onto the shell's hood seam)
// stands up behind and beside the head: in the user's live AR it showed "as if floating" at every
// angle and, from behind, covered the head. The real FB7675 hood, unzipped and down, lies as a
// soft pillow round the back of the neck on the upper back: its top at the nape, the head above
// it (venue-mac-ao ≈ 4 s front, 75 s side, 113 s back). Here the hood collapses onto its seam
// like a hood whose crown has fallen: every vertex above its seam column keeps HOOD_KEEP of its
// height over the seam and HOOD_KEEP_BACK of its depth behind the seam (a pushed-back version
// stuck out behind the head like a brim, look job 18:5x), blended in over HOOD_SOFT_M above the
// seam so the seam stays sewn on. Re-applied after every fit of the hood onto the shell, so it
// follows the collar through turns and raised arms. Heuristic proportions from the reference
// video (the hood's top ≈ 6–8 cm above the back neck seam; the standing hood rose ≈ 20–25 cm).

export const HOOD_KEEP = 0.32;
export const HOOD_KEEP_BACK = 0.6;
export const HOOD_SOFT_M = 0.03;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Drapes the fitted hood in place. `sigma` is the hood's seam arc parameter per vertex and
 * `attach` marks its seam row (the baked GLB's `_sigma` / `_attach` attributes). Returns the
 * largest height removed (m), 0 when nothing could be done.
 */
export function drapeHood(
  positions: Float32Array,
  sigma: ArrayLike<number>,
  attach: ArrayLike<number>,
  keep = HOOD_KEEP,
  keepBack = HOOD_KEEP_BACK,
  soft = HOOD_SOFT_M,
): number {
  const n = Math.min(Math.floor(positions.length / 3), sigma.length, attach.length);
  // Seam point per column (columns keyed like HoodLayer: sigma rounded to 1e-5).
  const sum = new Map<number, [number, number, number, number]>();
  for (let v = 0; v < n; v++) {
    if (attach[v] < 0.5) continue;
    const key = Math.round(sigma[v] * 1e5);
    const s = sum.get(key) ?? [0, 0, 0, 0];
    s[0] += positions[v * 3];
    s[1] += positions[v * 3 + 1];
    s[2] += positions[v * 3 + 2];
    s[3]++;
    sum.set(key, s);
  }
  if (sum.size < 2) return 0;
  const columns = [...sum.entries()]
    .map(([key, s]) => ({ sigma: key / 1e5, y: s[1] / s[3], z: s[2] / s[3] }))
    .sort((a, b) => a.sigma - b.sigma);
  const seamAt = (sg: number): [number, number] => {
    // Linear in sigma between the two nearest columns (clamped at the ends).
    if (sg <= columns[0].sigma) return [columns[0].y, columns[0].z];
    const last = columns[columns.length - 1];
    if (sg >= last.sigma) return [last.y, last.z];
    let lo = 0,
      hi = columns.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (columns[mid].sigma <= sg) lo = mid;
      else hi = mid;
    }
    const a = columns[lo],
      b = columns[hi];
    const t = (sg - a.sigma) / Math.max(1e-9, b.sigma - a.sigma);
    return [a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t];
  };
  let removed = 0;
  for (let v = 0; v < n; v++) {
    const [baseY, baseZ] = seamAt(sigma[v]);
    const h = positions[v * 3 + 1] - baseY;
    if (h <= 0) continue;
    const w = smooth(0, soft, h);
    const lost = h * (1 - keep) * w;
    positions[v * 3 + 1] -= lost;
    // Behind the seam (−Z = the body's back): the depth shrinks too, toward the seam.
    const back = baseZ - positions[v * 3 + 2];
    if (back > 0) positions[v * 3 + 2] += back * (1 - keepBack) * w;
    removed = Math.max(removed, lost);
  }
  return removed;
}
