// Armhole stop (agent V3, the hem-lift study): the jacket's underarm seam cannot slide toward the
// shoulder past the armpit, because the arm-torso junction (axilla) blocks it. When the arm rises,
// the axilla rises with the upper arm and carries the armhole, and with it the coat. Measured on
// the user's video (docs/STATUS-tryon-physics.md): arms overhead lift the parka's collar about
// 9 cm and its hem about 23 cm. Without this, the simulated arm slides through the armhole and
// the coat barely rises (yoke +1 cm).
//
// Model (like the hand stop, ClothSolver.cuffStops): each underarm seam particle i has an anchor
// A_i that rides on the upper-arm skin (bound where the particle sat on the relaxed frame-0
// body) and the humerus axis u (shoulder -> elbow, unit). One-sided constraint:
//   (p_i - A_i) . u >= offset_i
// offset_i = the value on the relaxed neutral body, so the stop is a no-op at rest and while the
// arm hangs; it only pushes the seam distally along the arm (never pulls it). Pure, no DOM.

export type ArmholeStop = {
  /** Seam particle ids. */
  ids: Uint32Array;
  /** Anchor per particle (ids.length × 3), metres, current frame. */
  anchors: Float64Array;
  /** Unit humerus axis (shoulder -> elbow), current frame. */
  axis: Float64Array;
  /** Rest offsets along the axis (set by rebase). */
  offsets: Float64Array;
  /** Share of the violation corrected per call (1 = hard stop; < 1 = compliant). */
  stiffness?: number;
  /**
   * 'anchor': move a violating particle toward its anchor (its own rest position carried by the
   * arm skin, outside the body), by the share of that segment that removes the violation;
   * 'axis': move it along the humerus axis. Default 'axis'.
   */
  direction?: 'axis' | 'anchor';
};

/** Sets each particle's offset to its current (p - A) . u (the no-op state). */
export function rebaseArmholeStop(stop: ArmholeStop, positions: ArrayLike<number>) {
  const { ids, anchors, axis, offsets } = stop;
  for (let j = 0; j < ids.length; j++) {
    const k = ids[j] * 3,
      a = j * 3;
    offsets[j] =
      (positions[k] - anchors[a]) * axis[0] +
      (positions[k + 1] - anchors[a + 1]) * axis[1] +
      (positions[k + 2] - anchors[a + 2]) * axis[2];
  }
}

/**
 * Pushes every seam particle that lies proximal of its offset back along the humerus axis.
 * Pinned particles (inverse mass 0) are left alone. Returns the largest push (m), diagnostics.
 */
export function applyArmholeStop(
  stop: ArmholeStop,
  positions: Float64Array | Float32Array,
  inverseMass: ArrayLike<number>,
) {
  const { ids, anchors, axis, offsets } = stop;
  let largest = 0;
  for (let j = 0; j < ids.length; j++) {
    const id = ids[j];
    if (!inverseMass[id]) continue;
    const k = id * 3,
      a = j * 3;
    const d =
      (positions[k] - anchors[a]) * axis[0] +
      (positions[k + 1] - anchors[a + 1]) * axis[1] +
      (positions[k + 2] - anchors[a + 2]) * axis[2];
    const push = (offsets[j] - d) * (stop.stiffness ?? 1);
    if (push <= 0) continue;
    if (stop.direction === 'anchor') {
      // Toward the anchor: the segment p -> A gains (A - p).u along the axis per unit length.
      const ax = anchors[a] - positions[k],
        ay = anchors[a + 1] - positions[k + 1],
        az = anchors[a + 2] - positions[k + 2],
        gain = ax * axis[0] + ay * axis[1] + az * axis[2];
      if (gain > 1e-9) {
        const f = Math.min(1, push / gain);
        positions[k] += ax * f;
        positions[k + 1] += ay * f;
        positions[k + 2] += az * f;
        if (push > largest) largest = push;
        continue;
      }
    }
    positions[k] += axis[0] * push;
    positions[k + 1] += axis[1] * push;
    positions[k + 2] += axis[2] * push;
    if (push > largest) largest = push;
  }
  return largest;
}

// ---- Long-range attachments from the underarm stop points (Kim T-Y, Chentanez N, Müller-Fischer M,
// "Long Range Attachments - A Method to Simulate Inextensible Clothing in Computer Games",
// SCA 2012). The stop lifts the seam; without these the lift only stretches the fabric next to
// it, because a Gauss-Seidel stretch chain moves a pull one row per iteration. Each attached
// particle stays within its rest geodesic distance (along the cloth, at the relaxed state) of its
// nearest stop point, times the fabric's own stretch limit. Inextensible cloth always satisfies
// that, so it never over-constrains; it only makes the lift reach the whole panel in one pass.

export type ArmholeTethers = {
  /** Attached particles, their source stop particle, and the max distance (m). */
  children: Uint32Array;
  sources: Uint32Array;
  lengths: Float64Array;
  /**
   * 'euclidean' (Kim et al.): project the child toward its source. 'vertical': the child may
   * not hang lower than its source minus the length, and only its height changes. Measured on
   * the parka: the straight line from the underarm to the back panel crosses the torso, so the
   * Euclidean projection pulled the back panel into the body (4 cm deep, strain 4.4); the vertical
   * bound is weaker (|dy| <= distance), still never over-constrains, and only lifts.
   */
  mode?: 'euclidean' | 'vertical';
};

/**
 * Multi-source Dijkstra over the cloth's edge graph (`edges`: pairs of particle ids) from
 * `sources`, with Euclidean edge lengths at `positions`. Returns, for every particle in
 * `candidates`, its nearest source and geodesic distance × `stretch`. Particles not connected to
 * any source are skipped.
 */
export function buildGeodesicTethers(
  edges: ArrayLike<number>,
  positions: ArrayLike<number>,
  sources: ArrayLike<number>,
  candidates: ArrayLike<number>,
  stretch: number,
): ArmholeTethers {
  const n = positions.length / 3;
  const adjacency: number[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < edges.length; e += 2) {
    adjacency[edges[e]].push(edges[e + 1]);
    adjacency[edges[e + 1]].push(edges[e]);
  }
  const dist = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  // Binary heap of [distance, particle].
  const heap: [number, number][] = [];
  const push = (d: number, i: number) => {
    heap.push([d, i]);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = () => {
    const top = heap[0],
      last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1,
          r = l + 1;
        let m = c;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };
  for (let s = 0; s < sources.length; s++) {
    dist[sources[s]] = 0;
    from[sources[s]] = sources[s];
    push(0, sources[s]);
  }
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    for (const j of adjacency[i]) {
      const w = Math.hypot(
        positions[i * 3] - positions[j * 3],
        positions[i * 3 + 1] - positions[j * 3 + 1],
        positions[i * 3 + 2] - positions[j * 3 + 2],
      );
      if (d + w < dist[j]) {
        dist[j] = d + w;
        from[j] = from[i];
        push(d + w, j);
      }
    }
  }
  const kept = Array.from(candidates).filter((i) => from[i] >= 0 && Number.isFinite(dist[i]));
  return {
    children: Uint32Array.from(kept),
    sources: Uint32Array.from(kept, (i) => from[i]),
    lengths: Float64Array.from(kept, (i) => dist[i] * stretch),
  };
}

/** One-way max-distance projection: only the child moves (its source is the lifted seam). */
export function applyArmholeTethers(
  tethers: ArmholeTethers,
  positions: Float64Array | Float32Array,
  inverseMass: ArrayLike<number>,
) {
  const { children, sources, lengths } = tethers;
  const vertical = tethers.mode === 'vertical';
  for (let t = 0; t < children.length; t++) {
    const c = children[t];
    if (!inverseMass[c]) continue;
    const k = c * 3,
      s = sources[t] * 3;
    if (vertical) {
      const lowest = positions[s + 1] - lengths[t];
      if (positions[k + 1] < lowest) positions[k + 1] = lowest;
      continue;
    }
    const dx = positions[k] - positions[s],
      dy = positions[k + 1] - positions[s + 1],
      dz = positions[k + 2] - positions[s + 2];
    const d = Math.hypot(dx, dy, dz);
    if (d <= lengths[t] || d === 0) continue;
    const f = lengths[t] / d;
    positions[k] = positions[s] + dx * f;
    positions[k + 1] = positions[s + 1] + dy * f;
    positions[k + 2] = positions[s + 2] + dz * f;
  }
}
