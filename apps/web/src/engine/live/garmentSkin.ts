// Live PREVIEW of the jacket on the moving body: the cloth asset's particles are skinned to the
// body's 18 rig drivers (linear blend skinning), no cloth solve. Each particle takes the blended
// driver weights of its nearest body vertices on the body the asset was built on
// (asset.body_positions, the display pose), restricted by panel the way the motion bake binds
// its anchors (bake.ts: shell/collar/hood ride on trunk skin, never on arm skin; sleeves ride on
// their own arm). Weights are then smoothed over the cloth mesh so the armhole does not tear.
// Pure: no DOM, no Three.js. Scene frame metres, X = subject's LEFT, Y up, +Z front.
import { DRIVER_STRIDE, invertAffine, type MotionRig } from '../motion/rig.ts';

/** Body vertices blended per particle (inverse-distance weights). */
export const BIND_NEIGHBOURS = 4;
/** Driver influences kept per particle after smoothing (renormalised). */
export const GARMENT_INFLUENCES = 4;
/** Laplacian smoothing passes of the per-particle driver weights over the cloth edges. */
export const WEIGHT_SMOOTHING_PASSES = 6;
/** A sleeve particle binds only to skin with at least this much weight on its own arm. */
export const SLEEVE_ARM_WEIGHT_MIN = 0.3;
/** A torso particle binds only to skin with less than this weight on the arms or the legs. */
export const TORSO_LIMB_WEIGHT_MAX = 0.5;
const PANEL_SLEEVE_L = 4,
  PANEL_SLEEVE_R = 5;
const CELL_M = 0.04;

/**
 * F3 (?f3armfree=1, the lead's RC5 jelly item): how much of their arm and clavicle skinning the
 * BODY panels (fronts, back, yoke, collar, hood) keep. On a real quilted coat the body panel
 * barely moves when the arm swings; only the sleeve and a narrow armhole band do. Per body
 * particle the share of its arm + clavicle weight moved onto the thorax driver (spine01) rises
 * with its geodesic distance over the cloth from the nearest sleeve particle: smoothstep from 0
 * at the seam (still attached to the sleeve: no tear) to `1 - keep` at `bandM`.
 * Visual choice (F3, judged on look jobs; the user's live verdict 22:05 "wobbles like jelly", F1's
 * finding that the arm DOFs bend the side panels every frame). No fit number is calibrated
 * against it; with it on, the preview-stretch readout omits the arm's pull on the body panels
 * (it is computed from these weights). bandM 0.16: on live5 look jobs (arm out to the side) an
 * 8 cm band left a round bump and a crack at the armhole; 16 cm is smooth and 24 cm looks like
 * the plain binding again (A/B sheet .cache/f3/armfree-band-zoom.jpg, local).
 */
export const ARM_FREE = { keep: 0, bandM: 0.16, referenceElevationDeg: 15 } as const;
/**
 * `reference`: driver matrices (18·12) of the pose whose shape the freed particles keep (the
 * arms hanging, ARM_FREE.referenceElevationDeg): at that pose the jacket is exactly the plain
 * binding's, so the shoulders slope like the hanging-arm jacket instead of the neutral pose's
 * 27 deg A-pose (which drew square shoulders). Without it the neutral pose's shape is kept.
 */
export type ArmFreeOptions = { keep: number; bandM: number; reference?: ArrayLike<number> };
const ARM_FREE_BONE = /^(clavicle|upperarm01|lowerarm01)\.[LR]$/;
const ARM_FREE_THORAX = 'spine01';

export type GarmentSkin = {
  count: number;
  /** (N, GARMENT_INFLUENCES) driver index and weight per particle. */
  drivers: Uint8Array;
  weights: Float32Array;
  /** (N, 3) particle positions in the blended rest space of their weights. */
  rest: Float64Array;
  /** (N, 3) bound positions at the neutral pose (the display body shifted onto the rig's neutral). */
  bound: Float32Array;
  /** Largest distance between the asset's body and the rig's neutral skin at the bound particles, m. */
  bodyMismatchM: number;
};

function driverGroups(rig: MotionRig) {
  const group = (re: RegExp) => {
    const out = new Set<number>();
    rig.drivers.forEach((bone, d) => {
      if (re.test(rig.bones[bone])) out.add(d);
    });
    return out;
  };
  return {
    armL: group(/^(upperarm01|lowerarm01)\.L$/),
    armR: group(/^(upperarm01|lowerarm01)\.R$/),
    leg: group(/^(upperleg01|lowerleg01|foot)\.[LR]$/),
  };
}

/** Per body vertex: weight on the left arm, right arm and legs (driver groups). */
function limbWeights(rig: MotionRig) {
  const g = driverGroups(rig);
  const K = rig.influences;
  const out = new Float32Array(rig.vertexCount * 3);
  for (let v = 0; v < rig.vertexCount; v++)
    for (let k = 0; k < K; k++) {
      const w = rig.skinWeights[v * K + k];
      if (!w) continue;
      const d = rig.vertexDrivers[v * K + k];
      if (g.armL.has(d)) out[v * 3] += w;
      else if (g.armR.has(d)) out[v * 3 + 1] += w;
      else if (g.leg.has(d)) out[v * 3 + 2] += w;
    }
  return out;
}

class Grid {
  private cells = new Map<string, number[]>();
  constructor(
    private points: ArrayLike<number>,
    count: number,
    allowed: (v: number) => boolean,
  ) {
    for (let v = 0; v < count; v++) {
      if (!allowed(v)) continue;
      const key = this.key(points[v * 3], points[v * 3 + 1], points[v * 3 + 2]);
      const cell = this.cells.get(key);
      if (cell) cell.push(v);
      else this.cells.set(key, [v]);
    }
  }
  private key(x: number, y: number, z: number) {
    return `${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)},${Math.floor(z / CELL_M)}`;
  }
  /** k nearest (vertex, distance) pairs; searches growing shells of cells up to 12 cells out. */
  nearest(x: number, y: number, z: number, k: number): [number, number][] {
    const cx = Math.floor(x / CELL_M),
      cy = Math.floor(y / CELL_M),
      cz = Math.floor(z / CELL_M);
    const found: [number, number][] = [];
    for (let r = 0; r <= 12; r++) {
      for (let i = -r; i <= r; i++)
        for (let j = -r; j <= r; j++)
          for (let l = -r; l <= r; l++) {
            if (Math.max(Math.abs(i), Math.abs(j), Math.abs(l)) !== r) continue;
            const cell = this.cells.get(`${cx + i},${cy + j},${cz + l}`);
            if (!cell) continue;
            for (const v of cell) {
              const p = this.points;
              const d = Math.hypot(p[v * 3] - x, p[v * 3 + 1] - y, p[v * 3 + 2] - z);
              found.push([v, d]);
            }
          }
      // Every vertex within r·CELL of the query has been seen once shell r is done.
      if (found.length >= k) {
        found.sort((a, b) => a[1] - b[1]);
        if (found[k - 1][1] <= r * CELL_M) return found.slice(0, k);
      }
    }
    found.sort((a, b) => a[1] - b[1]);
    return found.slice(0, k);
  }
}

/** Unique undirected edges of a triangle list, (E, 2). */
export function uniqueEdges(triangles: ArrayLike<number>): Uint32Array {
  const seen = new Set<number>();
  const out: number[] = [];
  for (let t = 0; t < triangles.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = triangles[t + e],
        b = triangles[t + ((e + 1) % 3)];
      const lo = Math.min(a, b),
        hi = Math.max(a, b);
      const key = lo * 1_000_003 + hi;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(lo, hi);
    }
  return Uint32Array.from(out);
}

/**
 * Binds the cloth particles to the rig.
 * @param neutralDrivers (18·12) the rig drivers of the neutral (display) pose
 * @param neutralSkin (V·3) the rig's body skinned with them
 * @param assetBody (V·3) asset.body_positions, the body the cloth was built on (same topology)
 */
export function bindGarment(
  rig: MotionRig,
  neutralDrivers: ArrayLike<number>,
  neutralSkin: ArrayLike<number>,
  assetBody: ArrayLike<number>,
  positions: ArrayLike<number>,
  panels: ArrayLike<number>,
  triangles: ArrayLike<number>,
  armFree?: ArmFreeOptions,
): GarmentSkin {
  const D = rig.drivers.length;
  const n = positions.length / 3;
  if (assetBody.length !== rig.vertexCount * 3)
    throw new Error('The cloth asset body does not match the rig topology');
  const limbs = limbWeights(rig);
  const grids = {
    L: new Grid(assetBody, rig.vertexCount, (v) => limbs[v * 3] >= SLEEVE_ARM_WEIGHT_MIN),
    R: new Grid(assetBody, rig.vertexCount, (v) => limbs[v * 3 + 1] >= SLEEVE_ARM_WEIGHT_MIN),
    torso: new Grid(
      assetBody,
      rig.vertexCount,
      (v) =>
        limbs[v * 3] + limbs[v * 3 + 1] < TORSO_LIMB_WEIGHT_MAX &&
        limbs[v * 3 + 2] < TORSO_LIMB_WEIGHT_MAX,
    ),
  };
  const dense = new Float64Array(n * D);
  const bound = new Float32Array(n * 3);
  const K = rig.influences;
  let mismatch = 0;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3],
      y = positions[i * 3 + 1],
      z = positions[i * 3 + 2];
    const panel = panels[i];
    const grid =
      panel === PANEL_SLEEVE_L || panel === PANEL_SLEEVE_R
        ? x >= 0
          ? grids.L
          : grids.R
        : grids.torso;
    const near = grid.nearest(x, y, z, BIND_NEIGHBOURS);
    if (!near.length) throw new Error('Garment binding found no body skin');
    let total = 0;
    const alpha = near.map(([, d]) => 1 / (d + 0.005));
    for (const a of alpha) total += a;
    let ox = 0,
      oy = 0,
      oz = 0;
    near.forEach(([v], j) => {
      const a = alpha[j] / total;
      for (let k = 0; k < K; k++) {
        const w = rig.skinWeights[v * K + k];
        if (w) dense[i * D + rig.vertexDrivers[v * K + k]] += a * w;
      }
      ox += a * (neutralSkin[v * 3] - assetBody[v * 3]);
      oy += a * (neutralSkin[v * 3 + 1] - assetBody[v * 3 + 1]);
      oz += a * (neutralSkin[v * 3 + 2] - assetBody[v * 3 + 2]);
    });
    mismatch = Math.max(mismatch, Math.hypot(ox, oy, oz));
    bound[i * 3] = x + ox;
    bound[i * 3 + 1] = y + oy;
    bound[i * 3 + 2] = z + oz;
  }
  // Smooth the weights over the cloth graph (uniform Laplacian, half step per pass).
  const edges = uniqueEdges(triangles);
  const sum = new Float64Array(n * D),
    degree = new Uint32Array(n);
  for (let e = 0; e < edges.length; e += 2) {
    degree[edges[e]]++;
    degree[edges[e + 1]]++;
  }
  for (let pass = 0; pass < WEIGHT_SMOOTHING_PASSES; pass++) {
    sum.fill(0);
    for (let e = 0; e < edges.length; e += 2) {
      const a = edges[e] * D,
        b = edges[e + 1] * D;
      for (let d = 0; d < D; d++) {
        sum[a + d] += dense[b + d];
        sum[b + d] += dense[a + d];
      }
    }
    for (let i = 0; i < n; i++) {
      if (!degree[i]) continue;
      for (let d = 0; d < D; d++)
        dense[i * D + d] = 0.5 * dense[i * D + d] + (0.5 * sum[i * D + d]) / degree[i];
    }
  }
  let original: Float64Array | undefined, freed: Float32Array | undefined;
  if (armFree) {
    const thorax = rig.drivers.findIndex((bone) => rig.bones[bone] === ARM_FREE_THORAX);
    if (thorax < 0) throw new Error(`Rig has no ${ARM_FREE_THORAX} driver (f3armfree)`);
    const arm = rig.drivers.flatMap((bone, d) => (ARM_FREE_BONE.test(rig.bones[bone]) ? [d] : []));
    const share = armFreeShare(panels, edges, bound, armFree.bandM);
    original = dense.slice();
    freed = share;
    for (let i = 0; i < n; i++) {
      const s = share[i] * (1 - armFree.keep);
      if (!(s > 0)) continue;
      for (const d of arm) {
        const moved = dense[i * D + d] * s;
        dense[i * D + d] -= moved;
        dense[i * D + thorax] += moved;
      }
    }
  }
  const drivers = new Uint8Array(n * GARMENT_INFLUENCES),
    weights = new Float32Array(n * GARMENT_INFLUENCES),
    rest = new Float64Array(n * 3);
  const blend = new Float64Array(12),
    inverse = new Float64Array(12);
  for (let i = 0; i < n; i++) {
    const order = Array.from({ length: D }, (_, d) => d).sort(
      (a, b) => dense[i * D + b] - dense[i * D + a],
    );
    let total = 0;
    for (let k = 0; k < GARMENT_INFLUENCES; k++) total += dense[i * D + order[k]];
    blend.fill(0);
    for (let k = 0; k < GARMENT_INFLUENCES; k++) {
      const d = order[k],
        w = total > 0 ? dense[i * D + d] / total : k === 0 ? 1 : 0;
      drivers[i * GARMENT_INFLUENCES + k] = d;
      weights[i * GARMENT_INFLUENCES + k] = w;
      for (let j = 0; j < 12; j++) blend[j] += w * neutralDrivers[d * DRIVER_STRIDE + j];
    }
    invertAffine(blend, 0, inverse, 0);
    const x = bound[i * 3],
      y = bound[i * 3 + 1],
      z = bound[i * 3 + 2];
    rest[i * 3] = inverse[0] * x + inverse[1] * y + inverse[2] * z + inverse[3];
    rest[i * 3 + 1] = inverse[4] * x + inverse[5] * y + inverse[6] * z + inverse[7];
    rest[i * 3 + 2] = inverse[8] * x + inverse[9] * y + inverse[10] * z + inverse[11];
  }
  // f3armfree with a reference pose: a freed particle takes, at the reference, the position the
  // plain binding gives it there (rest = B_new(ref)⁻¹ · B_old(ref) · B_old(neutral)⁻¹ · bound).
  const ref = armFree?.reference;
  if (ref && original && freed) {
    const old = new Float64Array(12),
      oldRef = new Float64Array(12),
      newRef = new Float64Array(12),
      inv = new Float64Array(12);
    const p = [0, 0, 0],
      q = [0, 0, 0];
    const apply = (m: Float64Array, v: number[], out: number[]) => {
      for (let r = 0; r < 3; r++)
        out[r] = m[r * 4] * v[0] + m[r * 4 + 1] * v[1] + m[r * 4 + 2] * v[2] + m[r * 4 + 3];
    };
    for (let i = 0; i < n; i++) {
      if (!(freed[i] > 0)) continue;
      topBlend(original, i, D, neutralDrivers, old);
      topBlend(original, i, D, ref, oldRef);
      newRef.fill(0);
      for (let k = 0; k < GARMENT_INFLUENCES; k++) {
        const w = weights[i * GARMENT_INFLUENCES + k],
          d = drivers[i * GARMENT_INFLUENCES + k] * DRIVER_STRIDE;
        for (let j = 0; j < 12; j++) newRef[j] += w * ref[d + j];
      }
      invertAffine(old, 0, inv, 0);
      apply(inv, [bound[i * 3], bound[i * 3 + 1], bound[i * 3 + 2]], p);
      apply(oldRef, p, q);
      invertAffine(newRef, 0, inv, 0);
      apply(inv, q, p);
      rest[i * 3] = p[0];
      rest[i * 3 + 1] = p[1];
      rest[i * 3 + 2] = p[2];
    }
  }
  return { count: n, drivers, weights, rest, bound, bodyMismatchM: mismatch };
}

/** The GARMENT_INFLUENCES strongest drivers of dense row i, normalised, blended into out (3×4). */
function topBlend(
  dense: Float64Array,
  i: number,
  D: number,
  matrices: ArrayLike<number>,
  out: Float64Array,
) {
  const order = Array.from({ length: D }, (_, d) => d).sort(
    (a, b) => dense[i * D + b] - dense[i * D + a],
  );
  let total = 0;
  for (let k = 0; k < GARMENT_INFLUENCES; k++) total += dense[i * D + order[k]];
  out.fill(0);
  for (let k = 0; k < GARMENT_INFLUENCES; k++) {
    const w = total > 0 ? dense[i * D + order[k]] / total : k === 0 ? 1 : 0;
    for (let j = 0; j < 12; j++) out[j] += w * matrices[order[k] * DRIVER_STRIDE + j];
  }
}

/**
 * Per particle, the share (0..1) of its arm + clavicle skinning that ?f3armfree=1 moves onto the
 * thorax: 0 on the sleeves, smoothstep of the geodesic distance (m, over the cloth edges at the
 * bound positions) from the nearest sleeve particle, 1 from `bandM` on and on cloth that no path
 * links to a sleeve.
 */
export function armFreeShare(
  panels: ArrayLike<number>,
  edges: Uint32Array,
  positions: ArrayLike<number>,
  bandM: number,
): Float32Array {
  const dist = geodesicDistance(
    panels.length,
    (i) => panels[i] === PANEL_SLEEVE_L || panels[i] === PANEL_SLEEVE_R,
    edges,
    positions,
    bandM,
  );
  const share = new Float32Array(panels.length);
  for (let i = 0; i < share.length; i++) {
    const t = Math.min(1, dist[i] / bandM);
    share[i] = t * t * (3 - 2 * t);
  }
  return share;
}

/**
 * Geodesic distance (m) over the cloth edges from the nearest `seed` particle (multi-source
 * Dijkstra, cut at `maxM`: farther particles keep Infinity).
 */
export function geodesicDistance(
  n: number,
  seed: (i: number) => boolean,
  edges: Uint32Array,
  positions: ArrayLike<number>,
  maxM: number,
): Float64Array {
  const start = new Uint32Array(n + 1);
  for (let e = 0; e < edges.length; e++) start[edges[e] + 1]++;
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const fill = start.slice(0, n),
    next = new Uint32Array(edges.length);
  for (let e = 0; e < edges.length; e += 2) {
    next[fill[edges[e]]++] = edges[e + 1];
    next[fill[edges[e + 1]]++] = edges[e];
  }
  const dist = new Float64Array(n).fill(Infinity);
  const heapD: number[] = [],
    heapV: number[] = [];
  const push = (d: number, v: number) => {
    let k = heapD.length;
    heapD.push(d);
    heapV.push(v);
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heapD[p] <= d) break;
      heapD[k] = heapD[p];
      heapV[k] = heapV[p];
      k = p;
    }
    heapD[k] = d;
    heapV[k] = v;
  };
  const pop = () => {
    const d = heapD[0],
      v = heapV[0];
    const lastD = heapD.pop()!,
      lastV = heapV.pop()!;
    const m = heapD.length;
    if (m) {
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= m) break;
        if (c + 1 < m && heapD[c + 1] < heapD[c]) c++;
        if (heapD[c] >= lastD) break;
        heapD[k] = heapD[c];
        heapV[k] = heapV[c];
        k = c;
      }
      heapD[k] = lastD;
      heapV[k] = lastV;
    }
    return [d, v] as const;
  };
  for (let i = 0; i < n; i++)
    if (seed(i)) {
      dist[i] = 0;
      push(0, i);
    }
  while (heapD.length) {
    const [d, v] = pop();
    if (d > dist[v] || d >= maxM) continue;
    for (let j = start[v]; j < start[v + 1]; j++) {
      const u = next[j];
      const w = Math.hypot(
        positions[u * 3] - positions[v * 3],
        positions[u * 3 + 1] - positions[v * 3 + 1],
        positions[u * 3 + 2] - positions[v * 3 + 2],
      );
      if (d + w < dist[u]) {
        dist[u] = d + w;
        push(d + w, u);
      }
    }
  }
  return dist;
}

/** Skins the bound cloth with the frame's driver matrices (18·12) into out (N·3). */
export function skinGarment(skin: GarmentSkin, m: ArrayLike<number>, out: Float32Array) {
  const G = GARMENT_INFLUENCES,
    r = skin.rest;
  for (let i = 0; i < skin.count; i++) {
    const x = r[i * 3],
      y = r[i * 3 + 1],
      z = r[i * 3 + 2];
    let px = 0,
      py = 0,
      pz = 0;
    for (let k = 0; k < G; k++) {
      const w = skin.weights[i * G + k];
      if (!w) continue;
      const d = skin.drivers[i * G + k] * DRIVER_STRIDE;
      px += w * (m[d] * x + m[d + 1] * y + m[d + 2] * z + m[d + 3]);
      py += w * (m[d + 4] * x + m[d + 5] * y + m[d + 6] * z + m[d + 7]);
      pz += w * (m[d + 8] * x + m[d + 9] * y + m[d + 10] * z + m[d + 11]);
    }
    out[i * 3] = px;
    out[i * 3 + 1] = py;
    out[i * 3 + 2] = pz;
  }
  return out;
}
