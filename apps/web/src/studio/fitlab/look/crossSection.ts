// CT slice (agent CT, 2026-11-15): the horizontal cross-section of the meshes on screen at one
// height. Pure math (triangle–plane intersection, chaining into loops, gap interpolation) plus a
// thin reader for three.js meshes (positions already CPU-posed by the engine: the S/M/L shells
// are skinned by SizeShells, the physics shell is written by the solver, the body by the engine).
// Nothing here invents a fit number: per-point gaps are the mesh's own `_inner_gap_cm` (the
// solver gap) interpolated along the cut edge, or, for the LBS preview whose attribute is not
// solved, the plain 2D distance from the shell's cut to the body's cut, labelled "preview".
import type { BufferAttribute, BufferGeometry, Mesh } from 'three';
import { FIT_ZONE_ATTRIBUTE } from './types';

/** One cut point: world x, z (m), the mesh edge it lies on and its parameter along that edge. */
export interface CutPoint {
  x: number;
  z: number;
  a: number;
  b: number;
  t: number;
  /** Chaining key (default `a_b`); weld-aware cuts key by the welded vertices' representatives. */
  k?: string;
}

/** One segment of the cut (one triangle crossing the plane) and the triangle's fit zone. */
export interface CutSegment {
  p: CutPoint;
  q: CutPoint;
  /** fitZone attribute of the triangle's vertex nearest the plane (-1 = none). */
  zone: number;
}

export interface Loop {
  points: CutPoint[];
  /** Fit zone per segment i (points[i] -> points[i+1]); length = points.length - 1 (+1 if closed). */
  zones: number[];
  closed: boolean;
}

/** Joining tolerance for loop ends (m): ZB's seam weld treats copies within 2 mm as one. */
export const JOIN_TOLERANCE_M = 0.002;

/**
 * Intersects triangle (ia, ib, ic) with the plane y = h. Positions are local (x, y, z) triples;
 * `toWorld` maps a local point to world x, z. Returns null when the triangle does not cross.
 * A vertex exactly on the plane is treated as just above it (no duplicate points).
 */
export function cutTriangle(
  pos: ArrayLike<number>,
  ia: number,
  ib: number,
  ic: number,
  h: number,
): [CutPoint, CutPoint] | null {
  const ya = pos[ia * 3 + 1],
    yb = pos[ib * 3 + 1],
    yc = pos[ic * 3 + 1];
  const sa = ya >= h,
    sb = yb >= h,
    sc = yc >= h;
  if (sa === sb && sb === sc) return null;
  const out: CutPoint[] = [];
  const edge = (i: number, j: number, yi: number, yj: number) => {
    const t = (h - yi) / (yj - yi);
    // Canonical edge (low index first) so both triangles sharing it produce the same point key.
    const [a, b, tt] = i < j ? [i, j, t] : [j, i, 1 - t];
    out.push({
      x: pos[a * 3] + (pos[b * 3] - pos[a * 3]) * tt,
      z: pos[a * 3 + 2] + (pos[b * 3 + 2] - pos[a * 3 + 2]) * tt,
      a,
      b,
      t: tt,
    });
  };
  if (sa !== sb) edge(ia, ib, ya, yb);
  if (sb !== sc) edge(ib, ic, yb, yc);
  if (sc !== sa) edge(ic, ia, yc, ya);
  return out.length === 2 ? [out[0], out[1]] : null;
}

const key = (p: CutPoint) => p.k ?? `${p.a}_${p.b}`;

/**
 * Chains segments into polylines by shared mesh edges, then joins loose ends closer than
 * `tolerance` (split seams). A loop is closed when it returns to its start; an opened zip
 * leaves an open "C".
 */
export function chainLoops(segments: readonly CutSegment[], tolerance = JOIN_TOLERANCE_M): Loop[] {
  const byKey = new Map<string, number[]>();
  segments.forEach((s, i) => {
    for (const p of [s.p, s.q]) {
      const k = key(p);
      const list = byKey.get(k);
      if (list) list.push(i);
      else byKey.set(k, [i]);
    }
  });
  const used = new Uint8Array(segments.length);
  const loops: Loop[] = [];
  const next = (from: CutPoint, except: number) => {
    for (const j of byKey.get(key(from)) ?? []) if (j !== except && !used[j]) return j;
    return -1;
  };
  for (let s0 = 0; s0 < segments.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const seg = segments[s0];
    // Walk forward from q, then backward from p.
    const fwd: CutPoint[] = [seg.q];
    const fwdZ: number[] = [];
    let cur = seg.q,
      at = s0;
    for (;;) {
      const j = next(cur, at);
      if (j < 0) break;
      used[j] = 1;
      const s = segments[j];
      cur = key(s.p) === key(cur) ? s.q : s.p;
      fwd.push(cur);
      fwdZ.push(s.zone);
      at = j;
    }
    const closedByEdge = key(cur) === key(seg.p);
    const back: CutPoint[] = [];
    const backZ: number[] = [];
    if (!closedByEdge) {
      let c = seg.p,
        a = s0;
      for (;;) {
        const j = next(c, a);
        if (j < 0) break;
        used[j] = 1;
        const s = segments[j];
        c = key(s.p) === key(c) ? s.q : s.p;
        back.push(c);
        backZ.push(s.zone);
        a = j;
      }
    }
    const points = [...back.reverse(), seg.p, ...fwd];
    const zones = [...backZ.reverse(), seg.zone, ...fwdZ];
    if (closedByEdge) {
      points.pop(); // last point == first
      loops.push({ points, zones, closed: true });
    } else loops.push({ points, zones, closed: false });
  }
  return joinOpenEnds(loops, tolerance);
}

const dist = (p: CutPoint, q: CutPoint) => Math.hypot(p.x - q.x, p.z - q.z);

/** Joins open loops whose ends meet within the tolerance; closes a loop whose ends meet. */
export function joinOpenEnds(loops: Loop[], tolerance: number): Loop[] {
  const open = loops.filter((l) => !l.closed);
  const done = loops.filter((l) => l.closed);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < open.length; i++)
      for (let j = i + 1; j < open.length; j++) {
        const A = open[i],
          B = open[j];
        const a0 = A.points[0],
          a1 = A.points[A.points.length - 1];
        const b0 = B.points[0],
          b1 = B.points[B.points.length - 1];
        const rev = (l: Loop): Loop => ({
          points: [...l.points].reverse(),
          zones: [...l.zones].reverse(),
          closed: false,
        });
        let joined: Loop | null = null;
        const cat = (x: Loop, y: Loop): Loop => ({
          points: [...x.points, ...y.points],
          zones: [...x.zones, y.zones[0] ?? x.zones[x.zones.length - 1] ?? -1, ...y.zones],
          closed: false,
        });
        if (dist(a1, b0) <= tolerance) joined = cat(A, B);
        else if (dist(a1, b1) <= tolerance) joined = cat(A, rev(B));
        else if (dist(a0, b1) <= tolerance) joined = cat(B, A);
        else if (dist(a0, b0) <= tolerance) joined = cat(rev(A), B);
        if (joined) {
          open.splice(j, 1);
          open[i] = joined;
          merged = true;
          break outer;
        }
      }
  }
  for (const l of open) {
    if (l.points.length > 2 && dist(l.points[0], l.points[l.points.length - 1]) <= tolerance) {
      l.closed = true;
      l.points.pop();
    }
  }
  return [...done, ...open];
}

/** Length (m) of a loop in the slice plane (closing edge included when closed). */
export function loopPerimeter(loop: Loop): number {
  const p = loop.points;
  let len = 0;
  for (let i = 1; i < p.length; i++) len += dist(p[i - 1], p[i]);
  if (loop.closed && p.length > 2) len += dist(p[p.length - 1], p[0]);
  return len;
}

/** A per-vertex attribute value at a cut point (linear along the cut edge). */
export function interpolate(values: ArrayLike<number>, p: CutPoint): number {
  return values[p.a] + (values[p.b] - values[p.a]) * p.t;
}

/** Signed 2D distance (m) from a point to a set of loops: negative inside a closed loop. */
export function signedDistance(x: number, z: number, loops: readonly Loop[]): number {
  let best = Infinity,
    inside = false;
  for (const l of loops) {
    const p = l.points,
      n = p.length;
    const m = l.closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const a = p[i],
        b = p[(i + 1) % n];
      const dx = b.x - a.x,
        dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1e-12;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
      best = Math.min(best, Math.hypot(a.x + dx * t - x, a.z + dz * t - z));
      if (l.closed && a.z > z !== b.z > z && x < a.x + ((z - a.z) / (b.z - a.z)) * dx)
        inside = !inside;
    }
  }
  return inside ? -best : best;
}

/** Where a point sits around a centre (front = +Z, the body's front). */
export function side(x: number, z: number, cx: number, cz: number): 'front' | 'back' | 'side' {
  const dx = x - cx,
    dz = z - cz;
  if (Math.abs(dz) >= Math.abs(dx)) return dz >= 0 ? 'front' : 'back';
  return 'side';
}

/** Area-weighted centroid of the largest closed loop (the torso), else the mean of all points. */
export function centre(loops: readonly Loop[]): { x: number; z: number } {
  let best: Loop | undefined,
    bestLen = -1;
  for (const l of loops)
    if (l.closed) {
      const len = loopPerimeter(l);
      if (len > bestLen) {
        bestLen = len;
        best = l;
      }
    }
  const pts = best?.points ?? loops.flatMap((l) => l.points);
  if (!pts.length) return { x: 0, z: 0 };
  let x = 0,
    z = 0;
  for (const p of pts) {
    x += p.x;
    z += p.z;
  }
  return { x: x / pts.length, z: z / pts.length };
}

// ------------------------------------------------------------------ three.js meshes

/** A mesh's cut at world height y: loops in world x, z, and its geometry (for attributes). */
export interface MeshCut {
  loops: Loop[];
  geometry: BufferGeometry;
  /** Points were computed in the mesh's local frame and mapped to world x, z. */
  ms: number;
}

/**
 * Weld representatives: the solver joins the two zip edges (and other seams) by weld pairs, not
 * shared vertices. Mapping both vertices of a pair to one id lets the cut chain across the weld,
 * so a zipped collar reads closed. Pairs are flat [u0, v0, u1, v1, ...] (ClothAsset.welds).
 */
export function weldRepresentatives(count: number, welds: ArrayLike<number>): Int32Array {
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let w = 0; w + 1 < welds.length; w += 2) {
    const a = find(welds[w]),
      b = find(welds[w + 1]);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  for (let i = 0; i < count; i++) parent[i] = find(i);
  return parent;
}

/** Applies weld representatives to cut points' chaining keys. */
export function keyByWelds(segments: readonly CutSegment[], rep: Int32Array) {
  for (const s of segments)
    for (const p of [s.p, s.q]) {
      const a = rep[p.a] ?? p.a,
        b = rep[p.b] ?? p.b;
      p.k = a < b ? `${a}_${b}` : `${b}_${a}`;
    }
}

/**
 * Cuts a mesh whose world matrix keeps horizontal planes horizontal (rotation about Y, uniform
 * scale, translation: every Fit Lab layer). Returns null otherwise or with no geometry.
 */
export function cutMesh(mesh: Mesh, worldY: number, welds?: Int32Array): MeshCut | null {
  return cutMeshAt(mesh, [worldY], welds)[0] ?? null;
}

/**
 * Cuts a mesh at several world heights in ONE pass over its triangles (the CT stack): each
 * triangle is tested only against the heights inside its y-range. Returns one cut per height
 * (null entries when the mesh cannot be cut, see cutMesh).
 */
export function cutMeshAt(
  mesh: Mesh,
  worldYs: readonly number[],
  welds?: Int32Array,
): (MeshCut | null)[] {
  const t0 = performance.now();
  const g = mesh.geometry;
  const posAttr = g.getAttribute('position') as BufferAttribute | undefined;
  if (!posAttr) return worldYs.map(() => null);
  mesh.updateWorldMatrix(true, false);
  const e = mesh.matrixWorld.elements;
  // world y = e1·x + e5·y + e9·z + e13: the plane stays a local plane only if e1 = e9 = 0.
  if (Math.abs(e[1]) > 1e-6 || Math.abs(e[9]) > 1e-6 || Math.abs(e[5]) < 1e-9)
    return worldYs.map(() => null);
  const hs = worldYs.map((y) => (y - e[13]) / e[5]);
  const pos = posAttr.array as ArrayLike<number>;
  const zoneAttr = g.getAttribute(FIT_ZONE_ATTRIBUTE) as BufferAttribute | undefined;
  const zones = zoneAttr?.array as ArrayLike<number> | undefined;
  const index = g.index?.array as ArrayLike<number> | undefined;
  const triCount = index ? index.length / 3 : posAttr.count / 3;
  const range = g.drawRange;
  const first = Math.floor(range.start / 3),
    last = Math.min(triCount, Number.isFinite(range.count) ? first + range.count / 3 : triCount);
  const segs: CutSegment[][] = hs.map(() => []);
  let hMin = Infinity,
    hMax = -Infinity;
  for (const h of hs) {
    hMin = Math.min(hMin, h);
    hMax = Math.max(hMax, h);
  }
  for (let f = first; f < last; f++) {
    const ia = index ? index[f * 3] : f * 3,
      ib = index ? index[f * 3 + 1] : f * 3 + 1,
      ic = index ? index[f * 3 + 2] : f * 3 + 2;
    const ya = pos[ia * 3 + 1],
      yb = pos[ib * 3 + 1],
      yc = pos[ic * 3 + 1];
    const lo = Math.min(ya, yb, yc),
      hi = Math.max(ya, yb, yc);
    if (hi < hMin || lo > hMax) continue;
    for (let k = 0; k < hs.length; k++) {
      const h = hs[k];
      if (h < lo || h > hi) continue;
      const cut = cutTriangle(pos, ia, ib, ic, h);
      if (!cut) continue;
      let zone = -1;
      if (zones) {
        let bd = Infinity;
        for (const v of [ia, ib, ic]) {
          const d = Math.abs(pos[v * 3 + 1] - h);
          if (d < bd) {
            bd = d;
            zone = zones[v];
          }
        }
      }
      segs[k].push({ p: cut[0], q: cut[1], zone });
    }
  }
  const tol = JOIN_TOLERANCE_M * Math.abs(e[0] || 1);
  return hs.map((h, k) => {
    const segments = segs[k];
    if (welds && welds.length === posAttr.count) keyByWelds(segments, welds);
    // Local x, z to world (rotation about Y + scale + translation).
    for (const s of segments)
      for (const p of [s.p, s.q]) {
        const x = p.x,
          z = p.z;
        p.x = e[0] * x + e[4] * h + e[8] * z + e[12];
        p.z = e[2] * x + e[6] * h + e[10] * z + e[14];
      }
    return { loops: chainLoops(segments, tol), geometry: g, ms: performance.now() - t0 };
  });
}

/** World y range of a mesh's vertices whose fitZone is one of `zones` (or all vertices). */
export function yRange(mesh: Mesh, zones?: ReadonlySet<number>): [number, number] | null {
  const g = mesh.geometry;
  const pos = g.getAttribute('position')?.array as ArrayLike<number> | undefined;
  const za = g.getAttribute(FIT_ZONE_ATTRIBUTE)?.array as ArrayLike<number> | undefined;
  if (!pos) return null;
  mesh.updateWorldMatrix(true, false);
  const e = mesh.matrixWorld.elements;
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < pos.length / 3; i++) {
    if (zones && (!za || !zones.has(za[i]))) continue;
    const y = e[1] * pos[i * 3] + e[5] * pos[i * 3 + 1] + e[9] * pos[i * 3 + 2] + e[13];
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
}
