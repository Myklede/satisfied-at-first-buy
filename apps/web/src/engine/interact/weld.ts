// Zip teeth as pair constraints (agent Z). Pure: typed arrays in, typed arrays out; no Three.js.
//
// A closed pair (k) is two coincident particles of the split asset (seam.ts): the interlocked
// teeth. Each substep the driver projects every closed pair onto its mass-weighted midpoint
// (a hard equality constraint, XPBD with zero compliance) and gives both the pair's mean
// velocity, so the two copies move as one particle. A pair that is still apart when it closes
// (the slider pulling two separated edges together) is drawn together by at most `maxStep`
// metres per substep: the slider forces the teeth into mesh at a finite speed instead of
// teleporting the cloth.

/** Pair state: open (free edges) or closed (welded). */
export interface WeldSet {
  a: Int32Array;
  b: Int32Array;
  /** 1 = closed (welded), 0 = open. */
  closed: Uint8Array;
}

/**
 * Projects the closed pairs. Returns the largest remaining gap (m) over closed pairs (0 when
 * every closed pair is coincident).
 */
export function weldPairs(
  set: WeldSet,
  positions: Float64Array,
  velocity: Float64Array,
  inverseMass: Float64Array,
  maxStep = Infinity,
) {
  const { a, b, closed } = set;
  let worst = 0;
  for (let k = 0; k < a.length; k++) {
    if (!closed[k]) continue;
    const i = a[k],
      j = b[k],
      wi = inverseMass[i],
      wj = inverseMass[j],
      w = wi + wj;
    if (!(w > 0)) continue;
    const pi = i * 3,
      pj = j * 3,
      dx = positions[pj] - positions[pi],
      dy = positions[pj + 1] - positions[pi + 1],
      dz = positions[pj + 2] - positions[pi + 2],
      d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Full projection, or a capped approach while the slider pulls far edges together.
    const f = d > maxStep ? maxStep / d : 1;
    const si = (wi / w) * f,
      sj = (wj / w) * f;
    positions[pi] += dx * si;
    positions[pi + 1] += dy * si;
    positions[pi + 2] += dz * si;
    positions[pj] -= dx * sj;
    positions[pj + 1] -= dy * sj;
    positions[pj + 2] -= dz * sj;
    worst = Math.max(worst, d * (1 - f));
    if (f < 1) {
      // Still closing: the separating part of the pair's relative velocity is removed (the
      // slider holds the teeth). Without this the velocity the solver derived before this
      // projection carried the pair back out by the same amount every substep.
      const ux = dx / d,
        uy = dy / d,
        uz = dz / d,
        rel =
          (velocity[pj] - velocity[pi]) * ux +
          (velocity[pj + 1] - velocity[pi + 1]) * uy +
          (velocity[pj + 2] - velocity[pi + 2]) * uz;
      if (rel > 0) {
        const ri = (wi / w) * rel,
          rj = (wj / w) * rel;
        velocity[pi] += ux * ri;
        velocity[pi + 1] += uy * ri;
        velocity[pi + 2] += uz * ri;
        velocity[pj] -= ux * rj;
        velocity[pj + 1] -= uy * rj;
        velocity[pj + 2] -= uz * rj;
      }
    } else {
      // Coincident now: one velocity for both (momentum-weighted by mass = 1 / w).
      const mi = wi > 0 ? 1 / wi : 0,
        mj = wj > 0 ? 1 / wj : 0;
      if (wi > 0 && wj > 0) {
        for (let c = 0; c < 3; c++) {
          const v = (velocity[pi + c] * mi + velocity[pj + c] * mj) / (mi + mj);
          velocity[pi + c] = v;
          velocity[pj + c] = v;
        }
      } else {
        // One side kinematic (outside the moving region): the other takes its velocity (0).
        for (let c = 0; c < 3; c++) {
          const v = wi > 0 ? velocity[pj + c] : velocity[pi + c];
          velocity[pi + c] = v;
          velocity[pj + c] = v;
        }
      }
    }
  }
  return worst;
}

/** Largest distance (m) between the two particles of any pair in `pairs` (closed or not). */
export function pairGaps(set: Pick<WeldSet, 'a' | 'b'>, positions: ArrayLike<number>) {
  const out = new Float64Array(set.a.length);
  for (let k = 0; k < set.a.length; k++) {
    const i = set.a[k] * 3,
      j = set.b[k] * 3;
    out[k] = Math.hypot(
      positions[i] - positions[j],
      positions[i + 1] - positions[j + 1],
      positions[i + 2] - positions[j + 2],
    );
  }
  return out;
}
