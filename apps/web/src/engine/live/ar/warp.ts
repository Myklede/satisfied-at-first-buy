// Image-space "glue" for the AR overlay (agent V2; lead/user decision 2026-11-13: HYBRID = the 3D
// solve for geometry and every fit number, then a smooth 2D warp of the RENDERED jacket so it
// sticks to the real person). Pure, no DOM.
//
// Rigid moving least squares (Schaefer, McPhail, Warren, "Image deformation using moving least
// squares", SIGGRAPH 2006): every grid vertex v moves by the rigid transform that best maps the
// control points p_i → q_i under weights w_i = importance_i / |p_i − v|^(2α). Rigid MLS keeps
// logos and quilting from shearing; far from all controls the motion decays to the anchors'.
//
// Local scale cap: the deformation may stretch or shrink any grid cell by at most ±scaleCap
// (lead: ±15 %). When it would, the whole displacement field is attenuated until it does not, and
// the report says by how much (an honest "the glue could not follow").

export type Pt = [number, number];
export type Control = { p: Pt; q: Pt; importance?: number; name?: string };

export type WarpGrid = {
  cols: number;
  rows: number;
  /** Source positions (px), (rows+1)·(cols+1) vertices, row-major. */
  source: Float32Array;
  /** Warped positions (px), same layout. */
  target: Float32Array;
};

export type WarpReport = {
  /** Fraction of the displacement kept (1 = full; < 1 = the scale cap bound). */
  kept: number;
  capBound: boolean;
  /** Largest cell scale change after the cap (fraction, e.g. 0.12 = 12 %). */
  maxScaleChange: number;
  /** Largest residual |f(p_i) − q_i| over the controls after the warp (px). */
  maxResidualPx: number;
};

export function createGrid(width: number, height: number, cols: number, rows: number): WarpGrid {
  const n = (cols + 1) * (rows + 1);
  const source = new Float32Array(n * 2);
  for (let r = 0; r <= rows; r++)
    for (let c = 0; c <= cols; c++) {
      const i = r * (cols + 1) + c;
      source[i * 2] = (c / cols) * width;
      source[i * 2 + 1] = (r / rows) * height;
    }
  return { cols, rows, source, target: Float32Array.from(source) };
}

/** Rigid MLS image of point v (Schaefer et al. §2.3), α = 1. */
export function mlsRigid(
  v: Pt,
  controls: readonly Control[],
  alpha = 1,
  scratch?: Float64Array,
): Pt {
  let sw = 0,
    px = 0,
    py = 0,
    qx = 0,
    qy = 0;
  const w =
    scratch && scratch.length >= controls.length ? scratch : new Float64Array(controls.length);
  for (let i = 0; i < controls.length; i++) {
    const c = controls[i];
    const dx = c.p[0] - v[0],
      dy = c.p[1] - v[1];
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-9) return [c.q[0], c.q[1]];
    w[i] = (c.importance ?? 1) / Math.pow(d2, alpha);
    sw += w[i];
    px += w[i] * c.p[0];
    py += w[i] * c.p[1];
    qx += w[i] * c.q[0];
    qy += w[i] * c.q[1];
  }
  if (sw <= 0) return [v[0], v[1]];
  px /= sw;
  py /= sw;
  qx /= sw;
  qy /= sw;
  const dx = v[0] - px,
    dy = v[1] - py;
  // f⃗(v) = Σ q̂_i A_i with A_i = w_i [p̂; −p̂⊥][d; −d⊥]ᵀ, ⊥(x, y) = (−y, x).
  let fx = 0,
    fy = 0;
  for (let i = 0; i < controls.length; i++) {
    const c = controls[i];
    const ax = c.p[0] - px,
      ay = c.p[1] - py; // p̂
    const bx = c.q[0] - qx,
      by = c.q[1] - qy; // q̂
    // Rows: P = [[ax, ay], [ay, −ax]] (−p̂⊥ = (ay, −ax)); D = [[dx, dy], [dy, −dx]].
    const a00 = ax * dx + ay * dy,
      a01 = ax * dy - ay * dx,
      a10 = ay * dx - ax * dy,
      a11 = ay * dy + ax * dx;
    fx += w[i] * (bx * a00 + by * a10);
    fy += w[i] * (bx * a01 + by * a11);
  }
  const len = Math.hypot(fx, fy);
  const dist = Math.hypot(dx, dy);
  if (len < 1e-12) return [qx + dx, qy + dy];
  return [qx + (fx / len) * dist, qy + (fy / len) * dist];
}

/** Largest relative side-length change of the grid cells: max |sqrt(area'/area) − 1|. */
function maxCellScaleChange(grid: WarpGrid, k: number) {
  const { cols, rows, source: s, target: t } = grid;
  const at = (i: number, o: number) => s[i * 2 + o] + (t[i * 2 + o] - s[i * 2 + o]) * k;
  let worst = 0;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i00 = r * (cols + 1) + c,
        i10 = i00 + 1,
        i01 = i00 + cols + 1,
        i11 = i01 + 1;
      const area = (a: (i: number, o: number) => number) => {
        // Shoelace over the quad (i00, i10, i11, i01).
        const ids = [i00, i10, i11, i01];
        let sum = 0;
        for (let j = 0; j < 4; j++) {
          const p = ids[j],
            q = ids[(j + 1) % 4];
          sum += a(p, 0) * a(q, 1) - a(q, 0) * a(p, 1);
        }
        return Math.abs(sum) / 2;
      };
      const a0 = area((i, o) => s[i * 2 + o]);
      if (a0 <= 0) continue;
      const a1 = area(at);
      worst = Math.max(worst, Math.abs(Math.sqrt(a1 / a0) - 1));
    }
  return worst;
}

/**
 * Warps the grid with rigid MLS, then enforces the local scale cap by attenuating the whole
 * displacement field (binary search on the kept fraction).
 */
export function warpGrid(
  grid: WarpGrid,
  controls: readonly Control[],
  scaleCap = 0.15,
): WarpReport {
  const { source: s, target: t } = grid;
  const n = s.length / 2;
  for (let i = 0; i < n; i++) {
    const [x, y] = mlsRigid([s[i * 2], s[i * 2 + 1]], controls);
    t[i * 2] = x;
    t[i * 2 + 1] = y;
  }
  let kept = 1;
  let worst = maxCellScaleChange(grid, 1);
  if (worst > scaleCap) {
    let lo = 0,
      hi = 1;
    for (let it = 0; it < 12; it++) {
      const mid = (lo + hi) / 2;
      if (maxCellScaleChange(grid, mid) > scaleCap) hi = mid;
      else lo = mid;
    }
    kept = lo;
    for (let i = 0; i < n * 2; i++) t[i] = s[i] + (t[i] - s[i]) * kept;
    worst = maxCellScaleChange(grid, 1);
  }
  let maxResidualPx = 0;
  for (const c of controls) {
    const [x, y] = mlsRigid(c.p, controls);
    const fx = c.p[0] + (x - c.p[0]) * kept,
      fy = c.p[1] + (y - c.p[1]) * kept;
    maxResidualPx = Math.max(maxResidualPx, Math.hypot(fx - c.q[0], fy - c.q[1]));
  }
  return { kept, capBound: kept < 1, maxScaleChange: worst, maxResidualPx };
}

// ---- Bounded local warp (agent F3, prompt 23, defect D3; behind ?f3warp=1) -------------------
//
// The global cap above attenuates the WHOLE field when one cell would stretch too far (crossed
// arms: kept 0.10–0.17, so nothing followed), and a layer without a cap (the sleeves) folds: grid
// triangles invert and the rendered sleeve is drawn as shards. Here every grid triangle must stay
// a proper, bounded map of its source triangle (orientation kept, principal stretches within
// 1/(1 + cap) … 1 + cap). Where one is not, the displacement of its vertices is attenuated toward 0
// (0 = the rigid posed 3D jacket as rendered), and the attenuation spreads to the neighbours with
// a bounded slope, so the warp blends smoothly into the 3D render instead of tearing.

export type BoundedOptions = {
  /** Largest principal stretch or shrink of a grid triangle (fraction, e.g. 0.35 = ±35 %). */
  stretchCap: number;
  /** A triangle whose area ratio falls below this counts as folding (orientation flip at ≤ 0). */
  minAreaRatio?: number;
  /** Attenuation rounds (each scales the offending vertices' keep to their triangles' bound). */
  iterations?: number;
  /** Largest change of the keep between neighbouring vertices (per grid step). */
  slope?: number;
  /** The previous frame's keep (same grid): the keep then rises by at most `riseLimit` a frame. */
  previous?: Float32Array | null;
  riseLimit?: number;
};

export type BoundedReport = WarpReport & {
  /** Per-vertex kept fraction of the MLS displacement (grid layout). */
  keep: Float32Array;
  /** Smallest per-vertex keep, and the share of vertices attenuated below 0.999. */
  minKept: number;
  attenuated: number;
  /** Triangles still out of bounds after the rounds (0 = every triangle bounded). */
  badTriangles: number;
};

/** Signed area ratio and principal stretches of the affine map source triangle → target. */
export function triangleStretch(
  a: Pt,
  b: Pt,
  c: Pt,
  a2: Pt,
  b2: Pt,
  c2: Pt,
): { det: number; s1: number; s2: number } {
  const e00 = b[0] - a[0],
    e10 = b[1] - a[1],
    e01 = c[0] - a[0],
    e11 = c[1] - a[1];
  const d = e00 * e11 - e01 * e10;
  if (Math.abs(d) < 1e-12) return { det: 1, s1: 1, s2: 1 };
  const f00 = b2[0] - a2[0],
    f10 = b2[1] - a2[1],
    f01 = c2[0] - a2[0],
    f11 = c2[1] - a2[1];
  // J = F E⁻¹, E⁻¹ = [[e11, −e01], [−e10, e00]] / d.
  const j00 = (f00 * e11 - f01 * e10) / d,
    j01 = (-f00 * e01 + f01 * e00) / d,
    j10 = (f10 * e11 - f11 * e10) / d,
    j11 = (-f10 * e01 + f11 * e00) / d;
  const det = j00 * j11 - j01 * j10;
  const fro = j00 * j00 + j01 * j01 + j10 * j10 + j11 * j11;
  const disc = Math.sqrt(Math.max(0, fro * fro - 4 * det * det));
  const s1 = Math.sqrt(Math.max(0, (fro + disc) / 2));
  const s2 = Math.sqrt(Math.max(0, (fro - disc) / 2));
  return { det, s1, s2 };
}

/** Bilinear lookup of a per-vertex grid field at point p (px). */
export function gridFieldAt(grid: WarpGrid, field: Float32Array, p: Pt): number {
  const { cols, rows, source } = grid;
  const w = source[cols * 2],
    h = source[rows * (cols + 1) * 2 + 1];
  const fx = Math.min(cols - 1e-6, Math.max(0, (p[0] / Math.max(1e-9, w)) * cols)),
    fy = Math.min(rows - 1e-6, Math.max(0, (p[1] / Math.max(1e-9, h)) * rows));
  const c = Math.floor(fx),
    r = Math.floor(fy);
  const u = fx - c,
    v = fy - r;
  const i00 = r * (cols + 1) + c;
  return (
    field[i00] * (1 - u) * (1 - v) +
    field[i00 + 1] * u * (1 - v) +
    field[i00 + cols + 1] * (1 - u) * v +
    field[i00 + cols + 2] * u * v
  );
}

/**
 * Rigid MLS warp of the grid, then bounded per triangle (see above). Never folds: in the worst
 * case every keep reaches 0 and the grid is the identity (the 3D render as it is).
 */
export function warpGridBounded(
  grid: WarpGrid,
  controls: readonly Control[],
  options: BoundedOptions,
): BoundedReport {
  const { cols, rows, source: s, target: t } = grid;
  const n = s.length / 2;
  const cap = options.stretchCap;
  const hi = 1 + cap,
    lo = 1 / (1 + cap);
  const minArea = options.minAreaRatio ?? lo * lo;
  const rounds = options.iterations ?? 30;
  const slope = options.slope ?? 0.34;
  const disp = new Float32Array(n * 2);
  const scratch = new Float64Array(controls.length);
  for (let i = 0; i < n; i++) {
    const [x, y] = mlsRigid([s[i * 2], s[i * 2 + 1]], controls, 1, scratch);
    disp[i * 2] = x - s[i * 2];
    disp[i * 2 + 1] = y - s[i * 2 + 1];
  }
  // The keep is found from 1 every frame (a function of this frame's controls, not of the last
  // keep: started from the last keep, the search landed on a different bound each frame and the
  // sleeve pumped between warped and rigid, 0.05 → 0.3 → 0.08). Only then is its rise limited.
  const keep = new Float32Array(n).fill(1);
  const prev = options.previous;
  // Allocation-free triangle bound (same maths as triangleStretch): area ratio and principal
  // stretches of the map source → target, from the current keeps.
  const m = { det: 1, s1: 1, s2: 1 };
  const tri = (i: number, j: number, k: number) => {
    const e00 = s[j * 2] - s[i * 2],
      e10 = s[j * 2 + 1] - s[i * 2 + 1],
      e01 = s[k * 2] - s[i * 2],
      e11 = s[k * 2 + 1] - s[i * 2 + 1];
    const d = e00 * e11 - e01 * e10;
    const ax = s[i * 2] + disp[i * 2] * keep[i],
      ay = s[i * 2 + 1] + disp[i * 2 + 1] * keep[i];
    const f00 = s[j * 2] + disp[j * 2] * keep[j] - ax,
      f10 = s[j * 2 + 1] + disp[j * 2 + 1] * keep[j] - ay,
      f01 = s[k * 2] + disp[k * 2] * keep[k] - ax,
      f11 = s[k * 2 + 1] + disp[k * 2 + 1] * keep[k] - ay;
    const j00 = (f00 * e11 - f01 * e10) / d,
      j01 = (-f00 * e01 + f01 * e00) / d,
      j10 = (f10 * e11 - f11 * e10) / d,
      j11 = (-f10 * e01 + f11 * e00) / d;
    const det = j00 * j11 - j01 * j10;
    const fro = j00 * j00 + j01 * j01 + j10 * j10 + j11 * j11;
    const disc = Math.sqrt(Math.max(0, fro * fro - 4 * det * det));
    m.det = det;
    m.s1 = Math.sqrt(Math.max(0, (fro + disc) / 2));
    m.s2 = Math.sqrt(Math.max(0, (fro - disc) / 2));
    return m;
  };
  const out = (q: { det: number; s1: number; s2: number }) =>
    q.det < minArea || q.s1 > hi + 1e-6 || q.s2 < lo - 1e-6;
  // Per vertex: the largest factor on its keep that its offending triangles allow this round.
  const limit = new Float32Array(n);
  let bad = 0;
  let worst = 0;
  const saved = [0, 0, 0];
  const check = () => {
    limit.fill(1);
    bad = 0;
    worst = 0;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const a = r * (cols + 1) + c,
          b = a + 1,
          d = a + cols + 1,
          e = d + 1;
        for (let half = 0; half < 2; half++) {
          const i = half ? b : a,
            j = d,
            k = half ? e : b;
          const q = tri(i, j, k);
          worst = Math.max(worst, Math.abs(q.s1 - 1), Math.abs(1 - q.s2));
          if (!out(q)) continue;
          bad++;
          // The largest common factor λ on these three keeps that bounds this triangle
          // (λ = 0 is the identity, always bounded; bisection).
          saved[0] = keep[i];
          saved[1] = keep[j];
          saved[2] = keep[k];
          let okL = 0,
            badL = 1;
          for (let it = 0; it < 8; it++) {
            const mid = (okL + badL) / 2;
            keep[i] = saved[0] * mid;
            keep[j] = saved[1] * mid;
            keep[k] = saved[2] * mid;
            if (out(tri(i, j, k))) badL = mid;
            else okL = mid;
          }
          keep[i] = saved[0];
          keep[j] = saved[1];
          keep[k] = saved[2];
          limit[i] = Math.min(limit[i], okL);
          limit[j] = Math.min(limit[j], okL);
          limit[k] = Math.min(limit[k], okL);
        }
      }
  };
  // Neighbour spread: keep[v] ≤ keep[u] + slope for grid neighbours (two chamfer sweeps).
  const spread = () => {
    for (let pass = 0; pass < 2; pass++) {
      const forward = pass === 0;
      for (let q = 0; q < n; q++) {
        const i = forward ? q : n - 1 - q;
        const r = Math.floor(i / (cols + 1)),
          c = i - r * (cols + 1);
        let k = keep[i];
        if (c > 0) k = Math.min(k, keep[i - 1] + slope);
        if (c < cols) k = Math.min(k, keep[i + 1] + slope);
        if (r > 0) k = Math.min(k, keep[i - cols - 1] + slope);
        if (r < rows) k = Math.min(k, keep[i + cols + 1] + slope);
        keep[i] = k;
      }
    }
  };
  const reduce = () => {
    spread();
    check();
    for (let round = 0; round < rounds && bad > 0; round++) {
      // A little below the bound, so the spread's new gradients rarely re-break it.
      for (let i = 0; i < n; i++) if (limit[i] < 1) keep[i] *= limit[i] * 0.9;
      spread();
      check();
    }
    // Still out of bounds: the offending vertices fall back to the 3D render outright.
    for (let round = 0; round < 20 && bad > 0; round++) {
      for (let i = 0; i < n; i++) if (limit[i] < 1) keep[i] = 0;
      spread();
      check();
    }
    // Pathological fields: attenuate everything until it is bounded (identity at 0).
    if (bad > 0) {
      const base = Float32Array.from(keep);
      let a = 0,
        b = 1;
      for (let it = 0; it < 12; it++) {
        const mid = (a + b) / 2;
        for (let i = 0; i < n; i++) keep[i] = base[i] * mid;
        check();
        if (bad > 0) b = mid;
        else a = mid;
      }
      for (let i = 0; i < n; i++) keep[i] = base[i] * a;
      check();
    }
  };
  reduce();
  if (prev && prev.length === n) {
    // A rise limited from the last frame's keep (a fall is immediate): min of two slope-limited
    // fields, then reduced again if that opened a new violation.
    const rise = options.riseLimit ?? 0.25;
    for (let i = 0; i < n; i++) keep[i] = Math.min(keep[i], prev[i] + rise);
    reduce();
  }
  let minKept = 1,
    attenuated = 0;
  for (let i = 0; i < n; i++) {
    t[i * 2] = s[i * 2] + disp[i * 2] * keep[i];
    t[i * 2 + 1] = s[i * 2 + 1] + disp[i * 2 + 1] * keep[i];
    minKept = Math.min(minKept, keep[i]);
    if (keep[i] < 0.999) attenuated++;
  }
  let maxResidualPx = 0,
    keptSum = 0;
  for (const c of controls) {
    const k = gridFieldAt(grid, keep, c.p);
    keptSum += k;
    const [x, y] = mlsRigid(c.p, controls);
    maxResidualPx = Math.max(
      maxResidualPx,
      Math.hypot(c.p[0] + (x - c.p[0]) * k - c.q[0], c.p[1] + (y - c.p[1]) * k - c.q[1]),
    );
  }
  const kept = controls.length ? keptSum / controls.length : 1;
  return {
    kept,
    capBound: attenuated > 0,
    maxScaleChange: worst,
    maxResidualPx,
    keep,
    minKept,
    attenuated: attenuated / n,
    badTriangles: bad,
  };
}
