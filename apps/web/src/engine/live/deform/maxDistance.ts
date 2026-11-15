// The max-distance map of the live dynamics (Unity Cloth / NVIDIA APEX "skinned cloth with max
// distance"): how far each cloth particle may leave its skinned target. Derived from the cloth
// asset only (panels, paths, mesh), at the bind (neutral) pose:
//   - held, 0: collar (6), yoke (3), every torso particle at or above the chest tape row
//     (paths.chest: shoulders, upper chest, upper back), the sleeves above the forearm;
//   - torso (0, 1, 2) below the chest row: grows with the distance down from it (smoothstep) to
//     the hem's max distance, DYNAMICS.hemPerDrop × the chest→hem drop, clamped to 3–6 cm;
//   - sleeves (4 L, 5 R): 0 above cuffRangeM from the cuff ring, rising to cuffMaxM at the cuff;
//   - hood (7): 0 at its seam with the collar, rising with the geodesic distance from it;
//   - an open front edge (none on the two jackets: their fronts are closed) gets zipBonusM more.
// Also per particle: the pendulum length L (restoring stiffness g/L: a strip of cloth hanging L
// below where it is held swings back like a pendulum of that length), the inward allowance
// toward the body, and the particle kind (which body parts it collides with).
// Pure; scene metres, Y up.
import { uniqueEdges } from '../garmentSkin.ts';
import { DYNAMICS } from './config.ts';
import { adjacency, geodesic, smoothstep } from './graph.ts';

export const KIND_TORSO = 0;
export const KIND_SLEEVE_L = 1;
export const KIND_SLEEVE_R = 2;
export const KIND_HOOD = 3;

const PANEL_FRONT_L = 0,
  PANEL_FRONT_R = 1,
  PANEL_BACK = 2,
  PANEL_SLEEVE_L = 4,
  PANEL_SLEEVE_R = 5,
  PANEL_HOOD = 7;

export type DynamicsMap = {
  /** Max distance from the skinned target, m (0 = held: exactly the target). */
  maxDist: Float32Array;
  /** Pendulum length, m (≥ DYNAMICS.pendulumMinM). */
  pendulum: Float32Array;
  /** Largest move toward the body along its normal, relative to the target, m. */
  inward: Float32Array;
  /** KIND_* per particle. */
  kind: Uint8Array;
  /** What the map was built from (HUD / docs). */
  summary: {
    holdY: number | null;
    hemY: number | null;
    hemMaxM: number;
    cuffs: boolean;
    hoodSeam: number;
    openFrontEdge: number;
    free: number;
  };
};

export type MapAsset = {
  panels: ArrayLike<number>;
  paths?: Record<string, ArrayLike<number>>;
};

function meanY(ids: ArrayLike<number> | undefined, p: ArrayLike<number>) {
  if (!ids || !ids.length) return null;
  let s = 0;
  for (let k = 0; k < ids.length; k++) s += p[ids[k] * 3 + 1];
  return s / ids.length;
}

function centroid(ids: ArrayLike<number> | undefined, p: ArrayLike<number>) {
  if (!ids || !ids.length) return null;
  const c = [0, 0, 0];
  for (let k = 0; k < ids.length; k++) for (let a = 0; a < 3; a++) c[a] += p[ids[k] * 3 + a];
  return c.map((v) => v / ids.length) as [number, number, number];
}

export function dynamicsMap(
  bound: ArrayLike<number>,
  triangles: ArrayLike<number>,
  asset: MapAsset,
): DynamicsMap {
  const n = bound.length / 3;
  const panels = asset.panels;
  if (panels.length !== n) throw new Error('Cloth panels do not match the particles');
  const paths = asset.paths ?? {};
  const maxDist = new Float32Array(n),
    pendulum = new Float32Array(n).fill(DYNAMICS.pendulumMinM),
    inward = new Float32Array(n),
    kind = new Uint8Array(n);
  const edges = uniqueEdges(triangles);
  const graph = adjacency(n, edges);

  // --- Torso: distance down from the chest tape row ---------------------------------------
  const isTorso = (p: number) => p === PANEL_FRONT_L || p === PANEL_FRONT_R || p === PANEL_BACK;
  const holdY = meanY(paths.chest, bound);
  let hemY = meanY(paths.hem, bound);
  if (hemY === null) {
    let lo = Infinity;
    for (let i = 0; i < n; i++) if (isTorso(panels[i])) lo = Math.min(lo, bound[i * 3 + 1]);
    hemY = Number.isFinite(lo) ? lo : null;
  }
  const drop = holdY !== null && hemY !== null ? holdY - hemY : 0;
  const hemMax =
    drop > 0
      ? Math.min(DYNAMICS.hemMaxM, Math.max(DYNAMICS.hemMinM, DYNAMICS.hemPerDrop * drop))
      : 0;

  // Open front edge: boundary vertices on the front panels that are not on the hem.
  const edgeUse = new Map<number, number>();
  for (let t = 0; t < triangles.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = triangles[t + e],
        b = triangles[t + ((e + 1) % 3)];
      const key = Math.min(a, b) * 4194304 + Math.max(a, b);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  const hem = new Set<number>(Array.from(paths.hem ?? []));
  const frontEdge: number[] = [];
  for (const [key, uses] of edgeUse) {
    if (uses !== 1) continue;
    for (const v of [Math.floor(key / 4194304), key % 4194304]) {
      const p = panels[v];
      // The zip runs down the centre front (x ≈ 0, front side), below the hold line.
      if (
        (p === PANEL_FRONT_L || p === PANEL_FRONT_R) &&
        !hem.has(v) &&
        holdY !== null &&
        bound[v * 3 + 1] < holdY &&
        bound[v * 3 + 2] > 0 &&
        Math.abs(bound[v * 3]) < DYNAMICS.zipCentreM
      )
        frontEdge.push(v);
    }
  }

  for (let i = 0; i < n; i++) {
    if (!isTorso(panels[i]) || holdY === null || drop <= 0) continue;
    const h = holdY - bound[i * 3 + 1];
    if (h <= 0) continue;
    const ramp = smoothstep(h / drop);
    let md = hemMax * ramp;
    if (frontEdge.length && (panels[i] === PANEL_FRONT_L || panels[i] === PANEL_FRONT_R)) {
      let near = Infinity;
      for (const v of frontEdge)
        near = Math.min(
          near,
          Math.hypot(
            bound[v * 3] - bound[i * 3],
            bound[v * 3 + 1] - bound[i * 3 + 1],
            bound[v * 3 + 2] - bound[i * 3 + 2],
          ),
        );
      md += DYNAMICS.zipBonusM * Math.max(0, 1 - near / DYNAMICS.zipBandM) * ramp;
    }
    maxDist[i] = md;
    pendulum[i] = Math.max(DYNAMICS.pendulumMinM, h);
    inward[i] = md;
  }

  // --- Sleeves: distance up from the cuff ring ----------------------------------------------
  let cuffs = false;
  for (const [panel, side, k] of [
    [PANEL_SLEEVE_L, 'L', KIND_SLEEVE_L],
    [PANEL_SLEEVE_R, 'R', KIND_SLEEVE_R],
  ] as const) {
    for (let i = 0; i < n; i++) if (panels[i] === panel) kind[i] = k;
    const cuff = centroid(paths[`cuff_${side}`], bound),
      bicep = centroid(paths[`bicep_${side}`], bound);
    if (!cuff || !bicep) continue;
    const axis = [bicep[0] - cuff[0], bicep[1] - cuff[1], bicep[2] - cuff[2]];
    const len = Math.hypot(axis[0], axis[1], axis[2]);
    if (!(len > 0)) continue;
    cuffs = true;
    for (let i = 0; i < n; i++) {
      if (panels[i] !== panel) continue;
      const s =
        ((bound[i * 3] - cuff[0]) * axis[0] +
          (bound[i * 3 + 1] - cuff[1]) * axis[1] +
          (bound[i * 3 + 2] - cuff[2]) * axis[2]) /
        len;
      if (s >= DYNAMICS.cuffRangeM) continue;
      const md = DYNAMICS.cuffMaxM * (1 - smoothstep(Math.max(0, s) / DYNAMICS.cuffRangeM));
      maxDist[i] = md;
      inward[i] = md;
      pendulum[i] = Math.max(DYNAMICS.pendulumMinM, DYNAMICS.cuffRangeM - Math.max(0, s));
    }
  }

  // --- Hood: geodesic distance from its seam -----------------------------------------------
  const seam: number[] = [];
  for (let i = 0; i < n; i++) {
    if (panels[i] !== PANEL_HOOD) continue;
    kind[i] = KIND_HOOD;
    for (let j = graph.start[i]; j < graph.start[i + 1]; j++)
      if (panels[graph.next[j]] !== PANEL_HOOD) {
        seam.push(i);
        break;
      }
  }
  if (seam.length) {
    const { dist } = geodesic(bound, graph, seam, (v) => panels[v] === PANEL_HOOD);
    for (let i = 0; i < n; i++) {
      if (panels[i] !== PANEL_HOOD || !Number.isFinite(dist[i])) continue;
      maxDist[i] = DYNAMICS.hoodMaxM * smoothstep(dist[i] / DYNAMICS.hoodRampM);
      pendulum[i] = Math.max(DYNAMICS.pendulumMinM, dist[i]);
      inward[i] = Math.min(maxDist[i], DYNAMICS.hoodInwardM);
    }
  }

  // Held means exactly 0: the ramps' sub-0.01 mm tails are numerical, not motion.
  let free = 0;
  for (let i = 0; i < n; i++) {
    if (maxDist[i] < DYNAMICS.heldBelowM) {
      maxDist[i] = 0;
      inward[i] = 0;
    } else free++;
  }
  return {
    maxDist,
    pendulum,
    inward,
    kind,
    summary: {
      holdY,
      hemY,
      hemMaxM: hemMax,
      cuffs,
      hoodSeam: seam.length,
      openFrontEdge: frontEdge.length,
      free,
    },
  };
}
