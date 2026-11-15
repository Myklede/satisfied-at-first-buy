// The coarse proxy the live dynamics simulates (budget: ≤ 2 ms per frame on the main thread).
// Secondary motion is a smooth, low-frequency displacement field, so ~3.5 cm Poisson-disk nodes
// carry it; every cloth particle then takes a Wendland-weighted mix of nearby nodes.
//   1. Seeds: Poisson disk on the bind pose, per panel group (torso+collar+yoke, each sleeve,
//      hood), so a sleeve never suppresses the torso seeds beside it.
//   2. Cells: multi-source Dijkstra over the cloth mesh: every particle joins its geodesically
//      nearest seed (a cell never jumps a gap the mesh does not bridge).
//   3. Edges: two cells sharing a mesh edge. Nodes = free seeds (max distance > 0) and the held
//      seeds next to them (kinematic, pinned to the target, they anchor the free net).
//   4. Weights: each moving particle mixes the nodes of its cell's 2-ring within the support
//      radius (Wendland C2, normalised), so the field has no seams at cell borders.
// Pure; bind time only.
import { uniqueEdges } from '../garmentSkin.ts';
import { DYNAMICS } from './config.ts';
import { adjacency, geodesic, PointGrid } from './graph.ts';

export type Proxy = {
  /** Proxy node count P. */
  count: number;
  /** Seed cloth particle of each node. */
  particle: Uint32Array;
  /** 1 = simulated, 0 = kinematic (a held seed bordering the free region). */
  free: Uint8Array;
  /** Cloth particles per node's cell (its mass = cell × particle mass). */
  cellSize: Uint32Array;
  /** Node pairs (E·2), each with at least one free node. */
  edges: Uint32Array;
  /** Cloth particles that move (max distance > 0) and their CSR weights over nodes. */
  moving: Uint32Array;
  weightStart: Uint32Array;
  weightNode: Uint32Array;
  weight: Float32Array;
};

const GROUP_OF_PANEL = [0, 0, 0, 0, 1, 2, 0, 3]; // torso 0-3 and collar 6; sleeves; hood

export function buildProxy(
  bound: ArrayLike<number>,
  triangles: ArrayLike<number>,
  panels: ArrayLike<number>,
  maxDist: ArrayLike<number>,
  spacing: number = DYNAMICS.proxySpacingM,
): Proxy {
  const n = bound.length / 3;
  const graph = adjacency(n, uniqueEdges(triangles));
  // 1. Poisson-disk seeds per group, in particle order (deterministic).
  const grids = new Map<number, PointGrid>();
  const seeds: number[] = [];
  for (let i = 0; i < n; i++) {
    const group = GROUP_OF_PANEL[panels[i]] ?? 4 + panels[i];
    let grid = grids.get(group);
    if (!grid) grids.set(group, (grid = new PointGrid(bound, [], spacing)));
    if (grid.within(bound[i * 3], bound[i * 3 + 1], bound[i * 3 + 2], spacing).length) continue;
    grid.insert(i);
    seeds.push(i);
  }
  // 2. Cells.
  const { owner } = geodesic(bound, graph, seeds);
  // 3. Cell adjacency.
  const S = seeds.length;
  const neighbours: Set<number>[] = Array.from({ length: S }, () => new Set<number>());
  for (let v = 0; v < n; v++) {
    const a = owner[v];
    if (a < 0) continue;
    for (let j = graph.start[v]; j < graph.start[v + 1]; j++) {
      const b = owner[graph.next[j]];
      if (b >= 0 && b !== a) {
        neighbours[a].add(b);
        neighbours[b].add(a);
      }
    }
  }
  const isFree = (s: number) => maxDist[seeds[s]] > 0;
  const keep = new Int32Array(S).fill(-1);
  let count = 0;
  for (let s = 0; s < S; s++) {
    let needed = isFree(s);
    if (!needed) for (const t of neighbours[s]) if (isFree(t)) needed = true;
    if (needed) keep[s] = count++;
  }
  const particle = new Uint32Array(count),
    free = new Uint8Array(count),
    cellSize = new Uint32Array(count);
  for (let s = 0; s < S; s++) {
    if (keep[s] < 0) continue;
    particle[keep[s]] = seeds[s];
    free[keep[s]] = isFree(s) ? 1 : 0;
  }
  for (let v = 0; v < n; v++) if (owner[v] >= 0 && keep[owner[v]] >= 0) cellSize[keep[owner[v]]]++;
  const edgeList: number[] = [];
  for (let s = 0; s < S; s++) {
    if (keep[s] < 0) continue;
    for (const t of neighbours[s])
      if (t > s && keep[t] >= 0 && (isFree(s) || isFree(t))) edgeList.push(keep[s], keep[t]);
  }
  // 4. Interpolation weights for the moving particles.
  const radius = DYNAMICS.interpRadiusFactor * spacing;
  const moving: number[] = [];
  const start: number[] = [0];
  const nodes: number[] = [];
  const weights: number[] = [];
  for (let v = 0; v < n; v++) {
    if (!(maxDist[v] > 0)) continue;
    const s = owner[v];
    if (s < 0 || keep[s] < 0) continue;
    const ring = new Set<number>([s]);
    for (const t of neighbours[s]) {
      ring.add(t);
      for (const u of neighbours[t]) ring.add(u);
    }
    const found: [number, number][] = [];
    for (const t of ring) {
      if (keep[t] < 0) continue;
      const q = seeds[t];
      const r = Math.hypot(
        bound[q * 3] - bound[v * 3],
        bound[q * 3 + 1] - bound[v * 3 + 1],
        bound[q * 3 + 2] - bound[v * 3 + 2],
      );
      if (r >= radius) continue;
      const x = r / radius;
      found.push([keep[t], (1 - x) ** 4 * (4 * x + 1)]);
    }
    if (!found.length) continue;
    found.sort((a, b) => b[1] - a[1]);
    const kept = found.slice(0, DYNAMICS.interpMaxWeights);
    let total = 0;
    for (const [, w] of kept) total += w;
    if (!(total > 0)) continue;
    moving.push(v);
    for (const [node, w] of kept) {
      nodes.push(node);
      weights.push(w / total);
    }
    start.push(nodes.length);
  }
  return {
    count,
    particle,
    free,
    cellSize,
    edges: Uint32Array.from(edgeList),
    moving: Uint32Array.from(moving),
    weightStart: Uint32Array.from(start),
    weightNode: Uint32Array.from(nodes),
    weight: Float32Array.from(weights),
  };
}
