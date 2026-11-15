// Mesh-graph helpers for the dynamics' bind step (pure, no Three.js).

/** CSR adjacency of an undirected edge list (E·2) over n vertices. */
export function adjacency(n: number, edges: ArrayLike<number>) {
  const start = new Uint32Array(n + 1);
  for (let e = 0; e < edges.length; e += 2) {
    start[edges[e] + 1]++;
    start[edges[e + 1] + 1]++;
  }
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const fill = start.slice(0, n);
  const next = new Uint32Array(start[n]);
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e],
      b = edges[e + 1];
    next[fill[a]++] = b;
    next[fill[b]++] = a;
  }
  return { start, next };
}

/** Binary min-heap of (key, value) pairs; keys are float distances. */
class Heap {
  private keys: number[] = [];
  private values: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, value: number) {
    const k = this.keys,
      v = this.values;
    let i = k.length;
    k.push(key);
    v.push(value);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = value;
  }
  pop(): [number, number] {
    const k = this.keys,
      v = this.values;
    const top: [number, number] = [k[0], v[0]];
    const lastK = k.pop()!,
      lastV = v.pop()!;
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i,
          mk = lastK;
        if (l < n && k[l] < mk) {
          m = l;
          mk = k[l];
        }
        if (r < n && k[r] < mk) m = r;
        if (m === i) break;
        k[i] = k[m];
        v[i] = v[m];
        i = m;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return top;
  }
}

/**
 * Multi-source Dijkstra over the mesh edges with Euclidean edge lengths. Returns the distance to
 * the nearest source and which source (index into `sources`) it is; unreachable = Infinity / -1.
 * `allowed` restricts the walk to a subset of vertices (sources must be allowed).
 */
export function geodesic(
  positions: ArrayLike<number>,
  graph: { start: Uint32Array; next: Uint32Array },
  sources: ArrayLike<number>,
  allowed?: (v: number) => boolean,
) {
  const n = graph.start.length - 1;
  const dist = new Float64Array(n).fill(Infinity);
  const owner = new Int32Array(n).fill(-1);
  const heap = new Heap();
  for (let s = 0; s < sources.length; s++) {
    const v = sources[s];
    dist[v] = 0;
    owner[v] = s;
    heap.push(0, v);
  }
  while (heap.size) {
    const [d, v] = heap.pop();
    if (d > dist[v]) continue;
    for (let j = graph.start[v]; j < graph.start[v + 1]; j++) {
      const u = graph.next[j];
      if (allowed && !allowed(u)) continue;
      const step = Math.hypot(
        positions[u * 3] - positions[v * 3],
        positions[u * 3 + 1] - positions[v * 3 + 1],
        positions[u * 3 + 2] - positions[v * 3 + 2],
      );
      const nd = d + step;
      if (nd < dist[u]) {
        dist[u] = nd;
        owner[u] = owner[v];
        heap.push(nd, u);
      }
    }
  }
  return { dist, owner };
}

/** Uniform hash grid over points (bind-time queries only). */
export class PointGrid {
  private cells = new Map<number, number[]>();
  constructor(
    private readonly points: ArrayLike<number>,
    indices: Iterable<number>,
    private readonly cell: number,
  ) {
    for (const v of indices) this.insert(v);
  }
  private keyOf(ix: number, iy: number, iz: number) {
    return ((ix + 512) * 1024 + (iy + 512)) * 1024 + (iz + 512);
  }
  insert(v: number) {
    const p = this.points,
      c = this.cell;
    const key = this.keyOf(
      Math.floor(p[v * 3] / c),
      Math.floor(p[v * 3 + 1] / c),
      Math.floor(p[v * 3 + 2] / c),
    );
    const list = this.cells.get(key);
    if (list) list.push(v);
    else this.cells.set(key, [v]);
  }
  /** Every indexed point within `radius` of (x, y, z), with its distance. */
  within(x: number, y: number, z: number, radius: number): [number, number][] {
    const c = this.cell,
      p = this.points;
    const r = Math.ceil(radius / c);
    const cx = Math.floor(x / c),
      cy = Math.floor(y / c),
      cz = Math.floor(z / c);
    const out: [number, number][] = [];
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++)
        for (let k = -r; k <= r; k++) {
          const list = this.cells.get(this.keyOf(cx + i, cy + j, cz + k));
          if (!list) continue;
          for (const v of list) {
            const d = Math.hypot(p[v * 3] - x, p[v * 3 + 1] - y, p[v * 3 + 2] - z);
            if (d <= radius) out.push([v, d]);
          }
        }
    return out;
  }
  /** The k nearest indexed points, searching shells out to `maxRadius`. */
  nearest(x: number, y: number, z: number, k: number, maxRadius: number): [number, number][] {
    for (let radius = this.cell; ; radius *= 2) {
      const found = this.within(x, y, z, Math.min(radius, maxRadius));
      if (found.length >= k || radius >= maxRadius) {
        found.sort((a, b) => a[1] - b[1]);
        return found.slice(0, k);
      }
    }
  }
}

/**
 * Dense uniform grid over a subset of points (CSR, typed arrays): k-nearest queries without
 * allocation per visited point. Bind-time body queries (thousands per jacket).
 */
export class DenseGrid {
  private start: Uint32Array;
  private items: Uint32Array;
  private origin: [number, number, number];
  private dims: [number, number, number];
  private best: Float64Array;
  private bestId: Int32Array;

  constructor(
    private readonly points: ArrayLike<number>,
    indices: ArrayLike<number>,
    private readonly cell: number,
    maxK = 8,
  ) {
    let lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < indices.length; k++)
      for (let a = 0; a < 3; a++) {
        const v = points[indices[k] * 3 + a];
        lo[a] = Math.min(lo[a], v);
        hi[a] = Math.max(hi[a], v);
      }
    if (!indices.length) lo = hi = [0, 0, 0];
    this.origin = [lo[0], lo[1], lo[2]];
    this.dims = [0, 1, 2].map((a) => Math.max(1, Math.floor((hi[a] - lo[a]) / cell) + 1)) as [
      number,
      number,
      number,
    ];
    const cells = this.dims[0] * this.dims[1] * this.dims[2];
    const count = new Uint32Array(cells + 1);
    const cellOf = new Uint32Array(indices.length);
    for (let k = 0; k < indices.length; k++) {
      const c = this.cellIndex(indices[k]);
      cellOf[k] = c;
      count[c + 1]++;
    }
    for (let c = 0; c < cells; c++) count[c + 1] += count[c];
    this.start = count;
    const fill = count.slice(0, cells);
    this.items = new Uint32Array(indices.length);
    for (let k = 0; k < indices.length; k++) this.items[fill[cellOf[k]]++] = indices[k];
    this.best = new Float64Array(maxK);
    this.bestId = new Int32Array(maxK);
  }

  private axis(v: number, a: number) {
    return Math.min(this.dims[a] - 1, Math.max(0, Math.floor((v - this.origin[a]) / this.cell)));
  }
  private cellIndex(p: number) {
    const P = this.points;
    return (
      (this.axis(P[p * 3 + 2], 2) * this.dims[1] + this.axis(P[p * 3 + 1], 1)) * this.dims[0] +
      this.axis(P[p * 3], 0)
    );
  }

  /** The k nearest points (ids, nearest first) into `out`; returns how many were found. */
  nearest(x: number, y: number, z: number, k: number, out: Int32Array, maxRadius = 0.3): number {
    const best = this.best,
      ids = this.bestId;
    let found = 0;
    const cx = Math.floor((x - this.origin[0]) / this.cell),
      cy = Math.floor((y - this.origin[1]) / this.cell),
      cz = Math.floor((z - this.origin[2]) / this.cell);
    const P = this.points,
      [X, Y, Z] = this.dims;
    for (let r = 0; r * this.cell <= maxRadius + this.cell; r++) {
      for (let i = cz - r; i <= cz + r; i++) {
        if (i < 0 || i >= Z) continue;
        for (let j = cy - r; j <= cy + r; j++) {
          if (j < 0 || j >= Y) continue;
          for (let l = cx - r; l <= cx + r; l++) {
            if (l < 0 || l >= X) continue;
            if (Math.max(Math.abs(i - cz), Math.abs(j - cy), Math.abs(l - cx)) !== r) continue;
            const c = (i * Y + j) * X + l;
            for (let s = this.start[c]; s < this.start[c + 1]; s++) {
              const v = this.items[s];
              const d = (P[v * 3] - x) ** 2 + (P[v * 3 + 1] - y) ** 2 + (P[v * 3 + 2] - z) ** 2;
              if (found < k) {
                let q = found++;
                while (q > 0 && best[q - 1] > d) {
                  best[q] = best[q - 1];
                  ids[q] = ids[q - 1];
                  q--;
                }
                best[q] = d;
                ids[q] = v;
              } else if (d < best[k - 1]) {
                let q = k - 1;
                while (q > 0 && best[q - 1] > d) {
                  best[q] = best[q - 1];
                  ids[q] = ids[q - 1];
                  q--;
                }
                best[q] = d;
                ids[q] = v;
              }
            }
          }
        }
      }
      // Every point within r·cell of the query has been seen once shell r is done.
      if (found >= k && Math.sqrt(best[k - 1]) <= r * this.cell) break;
    }
    for (let q = 0; q < found; q++) out[q] = ids[q];
    return found;
  }
}

/** smoothstep on [0, 1] (C1): 0 at x ≤ 0, 1 at x ≥ 1. */
export function smoothstep(x: number) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}
