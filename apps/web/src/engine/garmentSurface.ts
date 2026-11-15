import type { ClothAsset } from '../api';
import { sleeveAxis } from './garmentShader';

/** Shell panel ids (services/body/body_service/garment/shell.py). */
export const PANEL = {
  frontL: 0,
  frontR: 1,
  back: 2,
  yoke: 3,
  sleeveL: 4,
  sleeveR: 5,
  collar: 6,
  hood: 7,
};

const isTorso = (p: number) => p >= 0 && p <= 3;

/**
 * Seam-free material coordinates for the shader, computed once per asset from its material
 * uv (metres) and the shown wrap. The server's torso u is an arc from centre front with a wrap
 * seam at the left side; interpolating across that seam (and across the torso/sleeve and
 * torso/hood seams, whose coordinates are unrelated) drew garbage stitch lines in thin strips.
 *
 * arc  (per vertex, metres):
 *   torso/yoke: x = arc from centre front (unsigned), y = arc from centre back (unsigned),
 *               z = arc from CF to this row's side seam, w = arc from CB to the side seam
 *               (z = w = -1 where the row has no side seam, e.g. the yoke);
 *   collar:     x = arc from CF, y = 0, z = height above the neckline, w = height of this
 *               column's top edge (the collar's height varies round the neck);
 *   sleeve:     x = arc from the sleeve's outer line (unsigned), y = material (rest) arc
 *               along the sleeve from the armhole (server render_material_v; 0 if absent;
 *               larger than the shown v where the sleeve stacks), z = material arc per metre
 *               along the sleeve axis (sleeveMaterialScale; 1 where y is absent), w = -1;
 *   hood:       x = |lateral| from the hood centre line, rest 0.
 * quiltUv: the server's uv (the server also writes the collar chart: u = signed arc from CF,
 *   v = depth below HPS); older assets without it get the same chart computed here.
 * weaveUv: continuous coordinates for the weave micro-normal and the anisotropy tangent.
 * seam: geodesic distance (metres, capped) to a construction seam between unrelated coordinate
 *   charts (set-in sleeve armhole or a dropped shoulder's seam ring, hood root); relief blends
 *   to a pinched seam there.
 * Dropped-shoulder caps (sleeve vertices in paths dropped_cap_L/R) get arc = (1, 0, -1, 1): the
 *   shader draws them in the body's chart (garmentShader, effective panel = yoke).
 */
export function garmentCoordinates(asset: ClothAsset, positions: ArrayLike<number>) {
  const n = asset.panels.length;
  const uv = asset.render_uv?.length ? asset.render_uv : new Array<number>(n * 2).fill(0);
  const panels = asset.panels;
  const arc = new Float32Array(n * 4);
  const quiltUv = Float32Array.from(uv);
  const weaveUv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) arc.set([0, 0, -1, -1], i * 4);

  // Torso rows: contiguous in index order with u increasing along the row (shell.py).
  let start = 0;
  const torsoRow = (from: number, to: number) => {
    // Centre back: crossing of x = 0 behind the body.
    let uCB = NaN,
      bestZ = Infinity;
    for (let i = from; i < to - 1; i++) {
      const xa = positions[i * 3],
        xb = positions[(i + 1) * 3];
      if (xa * xb <= 0 && xa !== xb) {
        const t = xa / (xa - xb);
        const z = positions[i * 3 + 2] * (1 - t) + positions[(i + 1) * 3 + 2] * t;
        if (z < bestZ) {
          bestZ = z;
          uCB = uv[i * 2] * (1 - t) + uv[(i + 1) * 2] * t;
        }
      }
    }
    if (!Number.isFinite(uCB)) uCB = uv[(to - 1) * 2] * 0.5 + 0.5 * Math.abs(uv[from * 2]);
    // Right side seam: front-right (1) -> back (2) panel change along the row.
    let sideCF = -1;
    for (let i = from; i < to - 1; i++)
      if (panels[i] === PANEL.frontR && panels[i + 1] === PANEL.back)
        sideCF = 0.5 * (uv[i * 2] + uv[(i + 1) * 2]);
    for (let i = from; i < to; i++) {
      const u = uv[i * 2];
      // Past centre back the shortest way to CF is round the left side: 2 uCB - u.
      const dCF = u <= uCB ? Math.abs(u) : Math.max(0, 2 * uCB - u);
      const dCB = Math.max(0, uCB - dCF);
      arc.set([dCF, dCB, sideCF, sideCF >= 0 ? Math.max(0, uCB - sideCF) : -1], i * 4);
      weaveUv[i * 2] = dCF;
      weaveUv[i * 2 + 1] = uv[i * 2 + 1];
    }
  };
  let torsoRowLength = 0;
  for (let i = 0; i <= n; i++) {
    const rowBreak =
      i === n ||
      !isTorso(panels[i]) ||
      (i > start && isTorso(panels[i - 1]) && uv[i * 2] < uv[(i - 1) * 2]);
    if (rowBreak) {
      if (i > start && isTorso(panels[start])) {
        if (!torsoRowLength) torsoRowLength = i - start; // first row (neckline) is complete
        torsoRow(start, i);
      }
      start = i === n || isTorso(panels[i]) ? i : i + 1;
    }
  }

  // HPS height from the torso uv (v = HPS_y - y), to give the collar the same v chart.
  let hpsY = NaN;
  for (let i = 0; i < n && !Number.isFinite(hpsY); i++)
    if (isTorso(panels[i])) hpsY = positions[i * 3 + 1] + uv[i * 2 + 1];

  // Collar: rings of `torsoRowLength` vertices in column order; column n/4 is centre front.
  const collar: number[] = [];
  for (let i = 0; i < n; i++) if (panels[i] === PANEL.collar) collar.push(i);
  let collarHeight = 0;
  const m = torsoRowLength;
  const collarRings: number[][] = [];
  // Server-side collar uv (shell.py) when present; else the same chart computed here.
  const serverCollar = collar.some((i) => uv[i * 2] !== 0);
  if (m > 0 && collar.length % m === 0 && Number.isFinite(hpsY)) {
    // The collar's first ring is the torso neckline row (shell.py); heights are per column.
    const row0: number[] = [];
    for (let i = 0; i < n && row0.length < m; i++) if (isTorso(panels[i])) row0.push(i);
    for (let r = 0; r < collar.length / m; r++) {
      const ring = collar.slice(r * m, (r + 1) * m);
      collarRings.push(ring);
      const cum = [0];
      for (let j = 1; j <= m; j++) {
        const a = ring[j - 1],
          b = ring[j % m];
        cum.push(
          cum[j - 1] +
            Math.hypot(
              positions[b * 3] - positions[a * 3],
              positions[b * 3 + 1] - positions[a * 3 + 1],
              positions[b * 3 + 2] - positions[a * 3 + 2],
            ),
        );
      }
      const total = cum[m],
        cf = cum[Math.floor(m / 4)];
      ring.forEach((id, j) => {
        let s = cum[j] - cf;
        if (s > total / 2) s -= total;
        if (s < -total / 2) s += total;
        const height = positions[id * 3 + 1] - positions[row0[j] * 3 + 1];
        collarHeight = Math.max(collarHeight, height);
        if (serverCollar) s = uv[id * 2];
        else {
          quiltUv[id * 2] = s;
          quiltUv[id * 2 + 1] = hpsY - positions[id * 3 + 1];
        }
        arc.set([Math.abs(s), 0, height, -1], id * 4);
        weaveUv[id * 2] = Math.abs(s);
        weaveUv[id * 2 + 1] = quiltUv[id * 2 + 1];
      });
    }
    // Each column's own top height (the collar's height varies round the neck: the parka's
    // hood edges rise in a V from the zip), so the padded profile and edge stitch follow it.
    // Highest ring, not the last: a funnel's last rows turn back down inside its top edge.
    for (let j = 0; j < m; j++) {
      let h = 0;
      for (const ring of collarRings) h = Math.max(h, arc[ring[j] * 4 + 2]);
      for (const ring of collarRings) arc[ring[j] * 4 + 3] = h;
    }
  }

  // Sleeves: unsigned arc from the outer line of the cuff (continuous round the sleeve).
  for (const panel of [PANEL.sleeveL, PANEL.sleeveR]) {
    const sign = panel === PANEL.sleeveL ? 1 : -1;
    let maxV = -Infinity;
    for (let i = 0; i < n; i++) if (panels[i] === panel) maxV = Math.max(maxV, uv[i * 2 + 1]);
    let outer = NaN,
      reach = -Infinity,
      circumference = 0;
    for (let i = 0; i < n; i++) {
      if (panels[i] !== panel || uv[i * 2 + 1] < maxV - 0.002) continue;
      circumference = Math.max(circumference, uv[i * 2]);
      if (positions[i * 3] * sign > reach) {
        reach = positions[i * 3] * sign;
        outer = uv[i * 2];
      }
    }
    for (let i = 0; i < n; i++) {
      if (panels[i] !== panel) continue;
      let d = Number.isFinite(outer) ? uv[i * 2] - outer : 0;
      if (circumference > 0) {
        if (d > circumference / 2) d -= circumference;
        if (d < -circumference / 2) d += circumference;
      }
      arc.set([Math.abs(d), asset.render_material_v?.[i] ?? 0, 1, -1], i * 4);
      // Signed: |d| mirrored the weave at the outer line, a visible crease down every sleeve
      // (L1b); the signed chart's wrap lies under the arm.
      weaveUv[i * 2] = d;
      weaveUv[i * 2 + 1] = uv[i * 2 + 1];
    }
  }
  sleeveMaterialScale(asset, positions, arc);
  // Dropped shoulder (L3, shell.py dropped_cap): the cap above the seam ring is body panel, in
  // the body's chart (server uv = depth below HPS, torso quilt). arc = (far from CF, 0, no side
  // seam, flag 1): the shader draws these sleeve vertices as yoke/body rows.
  const capChart = droppedCap(asset);
  for (let i = 0; i < n; i++) if (capChart[i]) arc.set([1, 0, -1, 1], i * 4);
  for (let i = 0; i < n; i++)
    if (panels[i] === PANEL.hood) {
      arc.set([Math.abs(uv[i * 2]), 0, -1, -1], i * 4);
      weaveUv[i * 2] = uv[i * 2];
      weaveUv[i * 2 + 1] = uv[i * 2 + 1];
    }

  // Yoke rows (no side seam: arc.z = arc.w = -1) carry the fold-safe fraction s of their relief
  // as arc.w = -2 + s (L3, see foldSafeRelief); 1 (arc.w = -1) almost everywhere. Front-panel
  // vertices that would fold (the front armhole corners) carry it the same way; the rest keep
  // their arc.w (the row's CB-to-side-seam arc, interpolated across the side seam).
  const safe = foldSafeRelief(asset, positions, asset.maximum_loft_m ?? 0);
  for (let i = 0; i < n; i++) {
    const p = panels[i];
    if (p === PANEL.yoke && arc[i * 4 + 2] < 0) arc[i * 4 + 3] = -2 + safe[i];
    else if ((p === PANEL.frontL || p === PANEL.frontR) && safe[i] < 1)
      arc[i * 4 + 3] = -2 + safe[i];
  }
  const seam = seamDistance(asset, positions, 0.06, capChart);
  return { arc, quiltUv, weaveUv, seam, collarHeight, hpsY, collarRings };
}

/**
 * Per vertex, the largest fraction (0..1, steps of 1/8) of a `RELIEF_PROBE` x loft outward
 * displacement along the area-weighted vertex normal (what the vertex shader does) that turns
 * none of its torso triangles over. Agent L3: where the shoulder meridians stop running over
 * the shoulder, neighbouring yoke columns differ by up to ~12 cm in their ridge station and the
 * yoke rows between them shear into long slivers; the full relief folded them over (a dark
 * slash on the front yoke by the collar). Changing the shell rows there moved the armhole and
 * so the bicep/sleeve tapes (0.2-0.4 cm), so the renderer limits the relief instead.
 */
export const RELIEF_PROBE = 0.7;
export function foldSafeRelief(asset: ClothAsset, positions: ArrayLike<number>, loft: number) {
  const n = asset.panels.length,
    tri = asset.triangles;
  const safe = new Float32Array(n).fill(1);
  if (!(loft > 0)) return safe;
  const vn = new Float64Array(n * 3);
  const p = (i: number) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const [a, b, c] = [p(tri[t]), p(tri[t + 1]), p(tri[t + 2])];
    const f = cross(
      [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
    );
    for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) vn[tri[t + k] * 3 + d] += f[d];
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(vn[i * 3], vn[i * 3 + 1], vn[i * 3 + 2]) || 1;
    for (let d = 0; d < 3; d++) vn[i * 3 + d] /= l;
  }
  const reach = RELIEF_PROBE * loft;
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const ids = [tri[t], tri[t + 1], tri[t + 2]];
    if (!ids.every((i) => isTorso(asset.panels[i]))) continue;
    const base = ids.map(p);
    const f0 = cross(
      base[1].map((x, d) => x - base[0][d]),
      base[2].map((x, d) => x - base[0][d]),
    );
    let ok = 1;
    for (let step = 8; step >= 1; step--) {
      const q = ids.map((i, k) => base[k].map((x, d) => x + vn[i * 3 + d] * reach * (step / 8)));
      const f = cross(
        q[1].map((x, d) => x - q[0][d]),
        q[2].map((x, d) => x - q[0][d]),
      );
      if (dot(f, f0) > 0.05 * Math.sqrt(dot(f, f) * dot(f0, f0))) {
        ok = step / 8;
        break;
      }
      ok = 0;
    }
    for (const i of ids) safe[i] = Math.min(safe[i], ok);
  }
  return safe;
}

/**
 * Sleeve vertices, arc.z: slope of the material arc (arc.y) along the sleeve axis (metres of
 * material per metre of axis), per vertex. Each sleeve triangle's exact gradient of arc.y is
 * projected on the tangential axis (least squares, s = g.axT / axT.axT), area-weighted to its
 * corners. The shader multiplies the smooth projected axis by this interpolated scale; the
 * per-triangle ratio of screen derivatives it replaces jumped at every edge where the sleeve
 * stacks (faceted chamber shading). Clamped to [0.5, 4] like the shader; 1 where unknown.
 */
export function sleeveMaterialScale(
  asset: ClothAsset,
  positions: ArrayLike<number>,
  arc: Float32Array,
) {
  const tri = asset.triangles,
    panels = asset.panels;
  const sum = new Float64Array(panels.length),
    weight = new Float64Array(panels.length);
  for (const panel of [PANEL.sleeveL, PANEL.sleeveR]) {
    const ax = sleeveAxis(asset, panel);
    for (let t = 0; t + 2 < tri.length; t += 3) {
      const ids = [tri[t], tri[t + 1], tri[t + 2]];
      if (ids.some((i) => panels[i] !== panel || !(arc[i * 4 + 1] > 0))) continue;
      const p = ids.map((i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
      const e1 = [0, 1, 2].map((k) => p[1][k] - p[0][k]),
        e2 = [0, 1, 2].map((k) => p[2][k] - p[0][k]);
      const nrm = cross(e1, e2),
        area2 = dot(nrm, nrm);
      if (area2 < 1e-14) continue;
      const da1 = arc[ids[1] * 4 + 1] - arc[ids[0] * 4 + 1],
        da2 = arc[ids[2] * 4 + 1] - arc[ids[0] * 4 + 1];
      // Gradient of a linear field on a triangle: (da1 (e2 x n) + da2 (n x e1)) / |n|^2.
      const a = cross(e2, nrm),
        b = cross(nrm, e1);
      const g = [0, 1, 2].map((k) => (da1 * a[k] + da2 * b[k]) / area2);
      const nl = Math.sqrt(area2),
        an = dot(ax, nrm) / nl;
      const axT = [0, 1, 2].map((k) => ax[k] - an * (nrm[k] / nl));
      const tt = dot(axT, axT);
      if (tt < 0.05) continue; // triangle almost across the axis: no information on the slope
      const s = dot(g, axT) / tt,
        w = 0.5 * nl;
      for (const i of ids) {
        sum[i] += s * w;
        weight[i] += w;
      }
    }
  }
  for (let i = 0; i < panels.length; i++)
    if (panels[i] === PANEL.sleeveL || panels[i] === PANEL.sleeveR)
      arc[i * 4 + 2] = weight[i] > 0 ? Math.min(4, Math.max(0.5, sum[i] / weight[i])) : 1;
}
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Chart of a panel: torso+collar share one chart; each sleeve and the hood have their own. */
const chart = (p: number) => (p <= 3 || p === PANEL.collar ? 0 : p);

/** 1 for sleeve vertices of a dropped shoulder's cap (asset paths dropped_cap_L/R), else 0. */
export function droppedCap(asset: ClothAsset) {
  const cap = new Uint8Array(asset.panels.length);
  for (const side of ['L', 'R'])
    for (const i of asset.paths?.[`dropped_cap_${side}`] ?? []) if (i < cap.length) cap[i] = 1;
  return cap;
}

/**
 * Edge-graph (Dijkstra) distance from every vertex to the nearest seam between charts, capped
 * at `cap` metres. Seeds are all corners of triangles that mix charts.
 */
export function seamDistance(
  asset: ClothAsset,
  positions: ArrayLike<number>,
  cap: number,
  bodyChart?: ArrayLike<number>,
) {
  const n = asset.panels.length,
    tri = asset.triangles;
  const dist = new Float32Array(n).fill(cap);
  const adjacency: number[][] = Array.from({ length: n }, () => []);
  const queue: number[] = [];
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t],
      b = tri[t + 1],
      c = tri[t + 2];
    adjacency[a].push(b, c);
    adjacency[b].push(a, c);
    adjacency[c].push(a, b);
    // A dropped shoulder's cap is body panel: its seam is the seam ring, not the armhole (L3).
    const ch = (v: number) => (bodyChart?.[v] ? 0 : chart(asset.panels[v]));
    const ca = ch(a),
      cb = ch(b),
      cc = ch(c);
    if (ca !== cb || cb !== cc)
      for (const v of [a, b, c])
        if (dist[v] > 0) {
          dist[v] = 0;
          queue.push(v);
        }
  }
  // Small graphs (<= 15k vertices, short cap): a FIFO label-correcting sweep is enough.
  for (let k = 0; k < queue.length; k++) {
    const v = queue[k];
    for (const w of adjacency[v]) {
      const d =
        dist[v] +
        Math.hypot(
          positions[w * 3] - positions[v * 3],
          positions[w * 3 + 1] - positions[v * 3 + 1],
          positions[w * 3 + 2] - positions[v * 3 + 2],
        );
      if (d < dist[w] - 1e-6) {
        dist[w] = d;
        queue.push(w);
      }
    }
  }
  return dist;
}
