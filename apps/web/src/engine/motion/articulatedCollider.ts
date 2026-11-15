// Articulated body collider for the cloth solver (BodyCollider, cloth/collider.ts), sampled from
// P1's `sdf.bin` (services/body/body_service/motion/FORMAT.md, collision.body_distance):
//   distance(p) = min( min_s SDF_s(local_from_rest_s · T_s⁻¹ · p),  exact signed distance to the
//                      skinned joint-zone triangles, ignored where the closest point lies on the
//                      zone's open border ). The motion path grows the two elbow zones over
//                      arm skin (MOTION_FIT.elbowZoneRings; prompt 07 D2, accepted by the lead).
// Scene frame metres, Y up, +Z front. No Three.js / DOM: runs in the motion worker and in Node.
import { blob, decodeSatb } from './satb.ts';
import {
  armDrivers,
  driverWeight,
  DRIVER_STRIDE,
  invertAffine,
  skinVertices,
  type MotionRig,
} from './rig.ts';
import type { BodyCollider } from '../cloth/collider.ts';
import { MOTION_FIT } from './config.ts';
import type {
  ColliderKernelFactory,
  ColliderKernels,
  ColliderPose,
  ColliderQueryState,
} from './wasm/colliderKernels.ts';

export type SdfSegment = {
  name: string;
  bone: number;
  driver: number;
  localFromRest: Float64Array; // 3×4 (rows of the 4×4)
  origin: [number, number, number];
  dims: [number, number, number];
  spacing: number;
  centre: [number, number, number];
  radius: number;
  values: Float32Array;
};

export type ArticulatedSdf = {
  segments: SdfSegment[];
  /** Zone vertex ids (global), local triangles and border flags. */
  zoneVertices: Uint32Array;
  zoneFaces: Uint32Array; // local indices into zoneVertices, (Z, 3)
  borderVertex: Uint8Array; // per local vertex
  borderEdge: Uint8Array; // per face edge (Z, 3): edge c = (c, c+1)
  /** Per face edge: the adjacent face sharing that edge, −1 on an open edge. */
  edgeNeighbour: Int32Array;
};

/**
 * `elbowRings` rings of arm skin are added around the two elbow zones (0 = P1's zone exactly,
 * the Python reference topology). The extended zone's border is its own open edges, so the old
 * elbow borders, where the distance field jumped by ~12 mm under deep flexion, are interior.
 */
export function parseArticulatedSdf(
  buffer: ArrayBuffer,
  rig: MotionRig,
  elbowRings: number = MOTION_FIT.elbowZoneRings,
): ArticulatedSdf {
  const file = decodeSatb(buffer, 'articulated-sdf');
  const h = file.header as unknown as {
    segments: {
      name: string;
      bone: number;
      local_from_rest: number[][];
      origin: number[];
      dims: number[];
      spacing: number;
      centre: number[];
      radius: number;
      blob: string;
    }[];
  };
  const segments = h.segments.map((s): SdfSegment => {
    const dims = s.dims as [number, number, number];
    const values = blob(file, s.blob, Float32Array, dims);
    if (s.bone < 0 || s.bone >= rig.driverOfBone.length)
      throw new Error('Segment bone out of range');
    return {
      name: s.name,
      bone: s.bone,
      driver: rig.driverOfBone[s.bone],
      localFromRest: Float64Array.from(s.local_from_rest.slice(0, 3).flat()),
      origin: s.origin as [number, number, number],
      dims,
      spacing: s.spacing,
      centre: s.centre as [number, number, number],
      radius: s.radius,
      values,
    };
  });
  const original = blob(file, 'zone_faces', Uint32Array, [null, 3]);
  const border = blob(file, 'zone_border_edges', Uint32Array, [null, 2]);
  const faces =
    elbowRings > 0
      ? extendArmZone(original, rig, elbowRings, new Set(elbowZones(original, rig).flat()))
      : original;
  const local = new Map<number, number>();
  const zoneVertices: number[] = [];
  const zoneFaces = new Uint32Array(faces.length);
  for (let i = 0; i < faces.length; i++) {
    const v = faces[i];
    if (v >= rig.vertexCount) throw new Error('Zone vertex out of range');
    let id = local.get(v);
    if (id === undefined) {
      id = zoneVertices.length;
      local.set(v, id);
      zoneVertices.push(v);
    }
    zoneFaces[i] = id;
  }
  const borderVertex = new Uint8Array(zoneVertices.length);
  const borderKeys = new Set<number>();
  const key = (a: number, b: number) => Math.min(a, b) * 1048576 + Math.max(a, b);
  for (let e = 0; e < border.length; e += 2) {
    const a = local.get(border[e]),
      b = local.get(border[e + 1]);
    if (a === undefined || b === undefined) throw new Error('Border edge outside the zone');
    if (elbowRings > 0) continue;
    borderVertex[a] = borderVertex[b] = 1;
    borderKeys.add(key(a, b));
  }
  const faceCount = zoneFaces.length / 3;
  const borderEdge = new Uint8Array(faceCount * 3);
  const edgeNeighbour = new Int32Array(faceCount * 3).fill(-1);
  const owners = new Map<number, number>();
  for (let f = 0; f < faceCount; f++)
    for (let c = 0; c < 3; c++) {
      const a = zoneFaces[f * 3 + c],
        b = zoneFaces[f * 3 + ((c + 1) % 3)],
        k = key(a, b);
      if (borderKeys.has(k)) borderEdge[f * 3 + c] = 1;
      const other = owners.get(k);
      if (other === undefined) owners.set(k, f * 3 + c);
      else {
        edgeNeighbour[f * 3 + c] = Math.floor(other / 3);
        edgeNeighbour[other] = f;
      }
    }
  // Extended zone: the border is its open edges (P1's border edges are exactly the open edges of
  // its zone, checked on the fixture: 452 of 452).
  for (let e = 0; e < edgeNeighbour.length && elbowRings > 0; e++) {
    if (edgeNeighbour[e] !== -1) continue;
    borderEdge[e] = 1;
    const face = Math.floor(e / 3) * 3,
      corner = e % 3;
    borderVertex[zoneFaces[e]] = 1;
    borderVertex[zoneFaces[face + ((corner + 1) % 3)]] = 1;
  }
  return {
    segments,
    zoneVertices: Uint32Array.from(zoneVertices),
    zoneFaces,
    borderVertex,
    borderEdge,
    edgeNeighbour,
  };
}

/**
 * Adds `rings` rings of arm-dominated skin (upper-arm + forearm weight >=
 * MOTION_FIT.armZoneWeightMin) around the `seeds` zone vertices. Original faces keep their order
 * (nearest-face ties are significant to the solver); new faces follow.
 */
export function extendArmZone(
  original: Uint32Array,
  rig: MotionRig,
  rings: number,
  seeds: ReadonlySet<number>,
): Uint32Array {
  const arms = armDrivers(rig);
  const member = new Uint8Array(rig.vertexCount);
  for (let v = 0; v < member.length; v++)
    member[v] = Number(driverWeight(rig, v, arms) >= MOTION_FIT.armZoneWeightMin);
  const faceKey = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y).join(',');
  const seen = new Set<string>();
  const faces = Array.from(original);
  for (let f = 0; f < original.length; f += 3)
    seen.add(faceKey(original[f], original[f + 1], original[f + 2]));
  let reached = new Uint8Array(rig.vertexCount);
  for (const v of original) if (member[v] && seeds.has(v)) reached[v] = 1;
  for (let ring = 0; ring < rings; ring++) {
    const next = reached.slice();
    for (let f = 0; f < rig.faces.length; f += 3) {
      const a = rig.faces[f],
        b = rig.faces[f + 1],
        c = rig.faces[f + 2];
      if (!(reached[a] || reached[b] || reached[c])) continue;
      const key = faceKey(a, b, c);
      if (!seen.has(key)) {
        faces.push(a, b, c);
        seen.add(key);
      }
      if (member[a]) next[a] = 1;
      if (member[b]) next[b] = 1;
      if (member[c]) next[c] = 1;
    }
    reached = next;
  }
  return Uint32Array.from(faces);
}

/**
 * The elbow zones of P1's zone: connected components whose vertices carry both upper-arm and
 * forearm weight (one per arm). Returns their global vertex ids.
 */
export function elbowZones(original: Uint32Array, rig: MotionRig): number[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    while (parent.get(x) !== x) {
      const up = parent.get(parent.get(x)!)!;
      parent.set(x, up);
      x = up;
    }
    return x;
  };
  for (const v of original) if (!parent.has(v)) parent.set(v, v);
  for (let f = 0; f < original.length; f += 3) {
    const a = find(original[f]);
    parent.set(find(original[f + 1]), a);
    parent.set(find(original[f + 2]), find(original[f]));
  }
  const groups = new Map<number, number[]>();
  for (const v of new Set(original)) {
    const r = find(v);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(v);
  }
  const upper = new Set<number>(),
    lower = new Set<number>();
  rig.drivers.forEach((bone, d) => {
    if (/^upperarm01\.[LR]$/.test(rig.bones[bone])) upper.add(d);
    if (/^lowerarm01\.[LR]$/.test(rig.bones[bone])) lower.add(d);
  });
  return [...groups.values()].filter((vs) => {
    const u = vs.reduce((s, v) => s + driverWeight(rig, v, upper), 0) / vs.length,
      l = vs.reduce((s, v) => s + driverWeight(rig, v, lower), 0) / vs.length;
    return u > 0.2 && l > 0.2 && u + l > 0.9;
  });
}

/** Which part of the body decided the last query (for surface velocity and diagnostics). */
const RIGID = 1,
  ZONE = 2;

export class ArticulatedCollider implements BodyCollider {
  readonly sdf: ArticulatedSdf;
  private rig: MotionRig;
  /** Per segment, current local-from-world 3×4 (local_from_rest · T⁻¹). */
  private toLocal: Float64Array;
  /** Per segment, previous-frame world from current world: T_prev · T⁻¹ (3×4). */
  private toPrevious: Float64Array;
  private inverse = new Float64Array(12);
  private zoneCurrent: Float64Array;
  private zonePrevious: Float64Array;
  private faceNormal: Float64Array;
  private vertexNormal: Float64Array;
  private dt = 1;
  // Uniform grid of zone triangles (rebuilt per frame, counting sort).
  private cell = MOTION_FIT.zoneCellM;
  private gridOrigin = new Float64Array(3);
  private gridDims = new Int32Array(3);
  private cellStart = new Int32Array(1);
  private cellEntries = new Int32Array(0);
  private cellCursor = new Int32Array(0);
  private stamp: Int32Array<ArrayBuffer>;
  private query = 0;
  private triBounds: Float64Array;
  // Last query result.
  private winner = 0;
  /** Point of the last distance() query (NaN after setFrame / exactDistance). */
  private lastX = NaN;
  private lastY = NaN;
  private lastZ = NaN;
  private winnerSegment = -1;
  private winnerFace = -1;
  private hintSegment = -1;
  private hintFace = -1;
  private bary = new Float64Array(3);
  private closest = new Float64Array(3);
  private local = new Float64Array(3);
  private bestLocal = new Float64Array(3);
  private localGradient = new Float64Array(3);
  /** Query counters (diagnostics): total, exact zone searches and linearised cache hits. */
  queries = 0;
  zoneQueries = 0;
  cacheHits = 0;
  private fullGradient = new Float64Array(3);
  private cache = new Float64Array(CACHE_SIZE * CACHE_STRIDE);
  private cacheFrame = new Int32Array(CACHE_SIZE).fill(-1);
  private generation = 0;
  /** Upper bound (m) on any body surface point's motion since the previous pose (BodyCollider). */
  motionBound = Infinity;
  /** Motion bakes (attachKernels): the queries run in WebAssembly, bit-identical. */
  private kernels?: ColliderKernels;
  private centreWorld = new Float64Array(3);
  private bindInverse = new Float64Array(12);

  constructor(sdf: ArticulatedSdf, rig: MotionRig) {
    this.sdf = sdf;
    this.rig = rig;
    const s = sdf.segments.length;
    this.toLocal = new Float64Array(s * 12);
    this.toPrevious = new Float64Array(s * 12);
    const zv = sdf.zoneVertices.length,
      zf = sdf.zoneFaces.length / 3;
    this.zoneCurrent = new Float64Array(zv * 3);
    this.zonePrevious = new Float64Array(zv * 3);
    this.vertexNormal = new Float64Array(zv * 3);
    this.faceNormal = new Float64Array(zf * 3);
    this.triBounds = new Float64Array(zf * 6);
    this.stamp = new Int32Array(zf);
  }

  /**
   * Pose the collider. `current` / `previous` are 18 driver 3×4 matrices; `dt` (s) is the time
   * between them, used for the skin surface velocity (friction relative to moving skin).
   */
  setFrame(current: ArrayLike<number>, previous: ArrayLike<number> = current, dt = 1) {
    this.dt = dt > 0 ? dt : 1;
    this.generation++;
    this.lastX = NaN;
    const inv = this.inverse;
    this.sdf.segments.forEach((segment, s) => {
      const o = segment.driver * DRIVER_STRIDE;
      invertAffine(current, o, inv, 0);
      compose(segment.localFromRest, 0, inv, 0, this.toLocal, s * 12);
      composeFrom(previous, o, inv, this.toPrevious, s * 12);
    });
    skinVertices(this.rig, current, this.zoneCurrent, this.sdf.zoneVertices);
    if (previous === current) this.zonePrevious.set(this.zoneCurrent);
    else skinVertices(this.rig, previous, this.zonePrevious, this.sdf.zoneVertices);
    this.buildZone();
    this.motionBound = this.boundMotion();
    // A pose whose zone grid outgrows the kernels' memory continues in JS (same numbers).
    if (this.kernels && !this.kernels.pose(this.pose())) this.detachKernels();
    return this;
  }

  /**
   * Largest surface displacement between the previous and current pose: zone vertices exactly;
   * each rigid core by its bounding sphere, |c − P·c| + ‖I − P_rot‖_F · radius, with P the
   * current-to-previous world map and c the sphere centre in world space.
   */
  private boundMotion() {
    let bound = 0;
    const zc = this.zoneCurrent,
      zp = this.zonePrevious;
    for (let i = 0; i < zc.length; i += 3) {
      const d = Math.hypot(zc[i] - zp[i], zc[i + 1] - zp[i + 1], zc[i + 2] - zp[i + 2]);
      if (d > bound) bound = d;
    }
    const P = this.toPrevious,
      c = this.centreWorld,
      inv = this.bindInverse;
    this.sdf.segments.forEach((segment, s) => {
      const o = s * 12;
      invertAffine(this.toLocal, o, inv, 0);
      const [lx, ly, lz] = segment.centre;
      for (let r = 0; r < 3; r++)
        c[r] = inv[r * 4] * lx + inv[r * 4 + 1] * ly + inv[r * 4 + 2] * lz + inv[r * 4 + 3];
      let shift = 0,
        rotation = 0;
      for (let r = 0; r < 3; r++) {
        const moved =
          P[o + r * 4] * c[0] +
          P[o + r * 4 + 1] * c[1] +
          P[o + r * 4 + 2] * c[2] +
          P[o + r * 4 + 3];
        shift += (moved - c[r]) ** 2;
        for (let k = 0; k < 3; k++) rotation += (P[o + r * 4 + k] - (r === k ? 1 : 0)) ** 2;
      }
      const d = Math.sqrt(shift) + Math.sqrt(rotation) * segment.radius;
      if (d > bound) bound = d;
    });
    return bound;
  }

  private buildZone() {
    const p = this.zoneCurrent,
      F = this.sdf.zoneFaces,
      faces = F.length / 3,
      fn = this.faceNormal,
      vn = this.vertexNormal,
      tb = this.triBounds;
    vn.fill(0);
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (let f = 0; f < faces; f++) {
      const a = F[f * 3] * 3,
        b = F[f * 3 + 1] * 3,
        c = F[f * 3 + 2] * 3;
      const abx = p[b] - p[a],
        aby = p[b + 1] - p[a + 1],
        abz = p[b + 2] - p[a + 2],
        acx = p[c] - p[a],
        acy = p[c + 1] - p[a + 1],
        acz = p[c + 2] - p[a + 2];
      let nx = aby * acz - abz * acy,
        ny = abz * acx - abx * acz,
        nz = abx * acy - aby * acx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      fn[f * 3] = nx;
      fn[f * 3 + 1] = ny;
      fn[f * 3 + 2] = nz;
      // Angle-weighted vertex pseudo-normals (Bærentzen & Aanæs 2005).
      // Corners (i, j, m) = (a, b, c), (b, c, a), (c, a, b); no per-face array (runs every step).
      for (let k = 0; k < 3; k++) {
        const i = k === 0 ? a : k === 1 ? b : c,
          j = k === 0 ? b : k === 1 ? c : a,
          m = k === 0 ? c : k === 1 ? a : b;
        const ux = p[j] - p[i],
          uy = p[j + 1] - p[i + 1],
          uz = p[j + 2] - p[i + 2],
          wx = p[m] - p[i],
          wy = p[m + 1] - p[i + 1],
          wz = p[m + 2] - p[i + 2];
        const cos =
          (ux * wx + uy * wy + uz * wz) / (Math.hypot(ux, uy, uz) * Math.hypot(wx, wy, wz) || 1);
        const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
        vn[i] += nx * angle;
        vn[i + 1] += ny * angle;
        vn[i + 2] += nz * angle;
      }
      const x0 = Math.min(p[a], p[b], p[c]),
        y0 = Math.min(p[a + 1], p[b + 1], p[c + 1]),
        z0 = Math.min(p[a + 2], p[b + 2], p[c + 2]),
        x1 = Math.max(p[a], p[b], p[c]),
        y1 = Math.max(p[a + 1], p[b + 1], p[c + 1]),
        z1 = Math.max(p[a + 2], p[b + 2], p[c + 2]);
      tb[f * 6] = x0;
      tb[f * 6 + 1] = y0;
      tb[f * 6 + 2] = z0;
      tb[f * 6 + 3] = x1;
      tb[f * 6 + 4] = y1;
      tb[f * 6 + 5] = z1;
      minX = Math.min(minX, x0);
      minY = Math.min(minY, y0);
      minZ = Math.min(minZ, z0);
      maxX = Math.max(maxX, x1);
      maxY = Math.max(maxY, y1);
      maxZ = Math.max(maxZ, z1);
    }
    const h = this.cell;
    this.gridOrigin.set([minX, minY, minZ]);
    const nx = Math.max(1, Math.ceil((maxX - minX) / h) + 1),
      ny = Math.max(1, Math.ceil((maxY - minY) / h) + 1),
      nz = Math.max(1, Math.ceil((maxZ - minZ) / h) + 1);
    this.gridDims.set([nx, ny, nz]);
    const cells = nx * ny * nz;
    if (this.cellStart.length < cells + 1) this.cellStart = new Int32Array(cells + 1);
    const start = this.cellStart;
    start.fill(0, 0, cells + 1);
    // Each face goes into every cell its bounding box overlaps: count, prefix sum, then fill
    // (pass 0 counts, pass 1 fills; same cell order in both).
    let cursor = this.cellCursor;
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) {
        for (let c = 0; c < cells; c++) start[c + 1] += start[c];
        if (this.cellEntries.length < start[cells])
          this.cellEntries = new Int32Array(start[cells] * 2);
        if (cursor.length < cells) cursor = this.cellCursor = new Int32Array(cells);
        cursor.set(start.subarray(0, cells));
      }
      const entries = this.cellEntries;
      for (let f = 0; f < faces; f++) {
        const i0 = Math.floor((tb[f * 6] - minX) / h),
          j0 = Math.floor((tb[f * 6 + 1] - minY) / h),
          k0 = Math.floor((tb[f * 6 + 2] - minZ) / h),
          i1 = Math.floor((tb[f * 6 + 3] - minX) / h),
          j1 = Math.floor((tb[f * 6 + 4] - minY) / h),
          k1 = Math.floor((tb[f * 6 + 5] - minZ) / h);
        for (let i = i0; i <= i1; i++)
          for (let j = j0; j <= j1; j++)
            for (let k = k0; k <= k1; k++) {
              const cell = (i * ny + j) * nz + k;
              if (pass === 0) start[cell + 1]++;
              else entries[cursor[cell]++] = f;
            }
      }
    }
  }

  /** Rigid core part: minimum over segments of the trilinear core SDF (P1 trilinear()). */
  private rigid(x: number, y: number, z: number) {
    let best = Infinity;
    const segments = this.sdf.segments,
      count = segments.length,
      first = this.hintSegment;
    this.winnerSegment = -1;
    // Neighbouring particles are queried one after another: start with the last winner so the
    // bounding-sphere culling below rejects most other segments.
    for (let n = -1; n < count; n++) {
      const s = n < 0 ? first : n;
      if (s < 0 || (n >= 0 && s === first)) continue;
      const d = this.sampleSegment(s, x, y, z, best);
      if (d < best) {
        best = d;
        this.winnerSegment = s;
        this.bestLocal.set(this.local);
      }
    }
    if (this.winnerSegment >= 0) this.hintSegment = this.winnerSegment;
    return best;
  }

  /** Segment s at world (x, y, z); +∞ when its bounding sphere proves it cannot beat `best`. */
  private sampleSegment(s: number, x: number, y: number, z: number, best: number) {
    const seg = this.sdf.segments[s],
      L = this.toLocal,
      o = s * 12,
      local = this.local;
    const lx = L[o] * x + L[o + 1] * y + L[o + 2] * z + L[o + 3],
      ly = L[o + 4] * x + L[o + 5] * y + L[o + 6] * z + L[o + 7],
      lz = L[o + 8] * x + L[o + 9] * y + L[o + 10] * z + L[o + 11];
    const cx = lx - seg.centre[0],
      cy = ly - seg.centre[1],
      cz = lz - seg.centre[2],
      lower = Math.sqrt(cx * cx + cy * cy + cz * cz) - seg.radius;
    if (lower > 0 && lower >= best) return Infinity;
    local[0] = lx;
    local[1] = ly;
    local[2] = lz;
    return trilinear(seg, local, null);
  }

  /**
   * Exact signed distance to the skinned zone triangles within `radius` (P1 zone_distance).
   * Returns +∞ when the closest point is on the zone's open border, and NaN when no zone
   * triangle lies within `radius` (the zone distance is then ≥ radius or +∞).
   */
  private zone(x: number, y: number, z: number, radius: number) {
    const h = this.cell,
      o = this.gridOrigin,
      d = this.gridDims,
      tb = this.triBounds,
      F = this.sdf.zoneFaces,
      p = this.zoneCurrent;
    let i0 = Math.max(0, Math.floor((x - radius - o[0]) / h)),
      j0 = Math.max(0, Math.floor((y - radius - o[1]) / h)),
      k0 = Math.max(0, Math.floor((z - radius - o[2]) / h)),
      i1 = Math.min(d[0] - 1, Math.floor((x + radius - o[0]) / h)),
      j1 = Math.min(d[1] - 1, Math.floor((y + radius - o[1]) / h)),
      k1 = Math.min(d[2] - 1, Math.floor((z + radius - o[2]) / h));
    if (i0 > i1 || j0 > j1 || k0 > k1) return NaN;
    const stamp = this.stamp,
      q = ++this.query,
      start = this.cellStart,
      entries = this.cellEntries,
      ny = d[1],
      nz = d[2];
    let best2 = radius * radius,
      bestFace = -1,
      bestRegion = 0,
      cx = 0,
      cy = 0,
      cz = 0,
      bu = 0,
      bv = 0,
      bw = 0;
    // Coherence: the last winning triangle bounds the unsigned distance, which shrinks the
    // cell range searched below (the search stays exact).
    const hint = this.hintFace;
    if (hint >= 0) {
      const a3 = F[hint * 3] * 3,
        b3 = F[hint * 3 + 1] * 3,
        c3 = F[hint * 3 + 2] * 3;
      const r = closestOnTriangle(
        x,
        y,
        z,
        p[a3],
        p[a3 + 1],
        p[a3 + 2],
        p[b3],
        p[b3 + 1],
        p[b3 + 2],
        p[c3],
        p[c3 + 1],
        p[c3 + 2],
        SCRATCH,
      );
      const ex = SCRATCH[0] - x,
        ey = SCRATCH[1] - y,
        ez = SCRATCH[2] - z,
        d2 = ex * ex + ey * ey + ez * ez;
      if (d2 < best2) {
        best2 = d2;
        bestFace = hint;
        bestRegion = r;
        cx = SCRATCH[0];
        cy = SCRATCH[1];
        cz = SCRATCH[2];
        bu = SCRATCH[3];
        bv = SCRATCH[4];
        bw = SCRATCH[5];
        stamp[hint] = q;
        const reach = Math.sqrt(d2);
        i0 = Math.max(i0, Math.floor((x - reach - o[0]) / h));
        j0 = Math.max(j0, Math.floor((y - reach - o[1]) / h));
        k0 = Math.max(k0, Math.floor((z - reach - o[2]) / h));
        i1 = Math.min(i1, Math.floor((x + reach - o[0]) / h));
        j1 = Math.min(j1, Math.floor((y + reach - o[1]) / h));
        k1 = Math.min(k1, Math.floor((z + reach - o[2]) / h));
      }
    }
    // Cells are visited in this fixed order on purpose: equally close faces (a shared vertex)
    // are won by the first one met, and that face is the next query's hint. Skipping far cells
    // changed that order and the bakes (measured, prompts/06 item E).
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++)
        for (let k = k0; k <= k1; k++) {
          const cell = (i * ny + j) * nz + k;
          for (let e = start[cell], end = start[cell + 1]; e < end; e++) {
            const f = entries[e];
            if (stamp[f] === q) continue;
            stamp[f] = q;
            const b = f * 6;
            const dx = Math.max(tb[b] - x, 0, x - tb[b + 3]),
              dy = Math.max(tb[b + 1] - y, 0, y - tb[b + 4]),
              dz = Math.max(tb[b + 2] - z, 0, z - tb[b + 5]);
            if (dx * dx + dy * dy + dz * dz > best2) continue;
            const a3 = F[f * 3] * 3,
              b3 = F[f * 3 + 1] * 3,
              c3 = F[f * 3 + 2] * 3;
            const r = closestOnTriangle(
              x,
              y,
              z,
              p[a3],
              p[a3 + 1],
              p[a3 + 2],
              p[b3],
              p[b3 + 1],
              p[b3 + 2],
              p[c3],
              p[c3 + 1],
              p[c3 + 2],
              SCRATCH,
            );
            const ex = SCRATCH[0] - x,
              ey = SCRATCH[1] - y,
              ez = SCRATCH[2] - z,
              d2 = ex * ex + ey * ey + ez * ez;
            if (d2 < best2) {
              best2 = d2;
              bestFace = f;
              bestRegion = r;
              cx = SCRATCH[0];
              cy = SCRATCH[1];
              cz = SCRATCH[2];
              bu = SCRATCH[3];
              bv = SCRATCH[4];
              bw = SCRATCH[5];
            }
          }
        }
    if (bestFace < 0) return NaN;
    this.winnerFace = this.hintFace = bestFace;
    this.closest[0] = cx;
    this.closest[1] = cy;
    this.closest[2] = cz;
    this.bary[0] = bu;
    this.bary[1] = bv;
    this.bary[2] = bw;
    // Border rejection: the adjacent rigid core is decisive there (FORMAT.md step 2).
    let nx: number, ny2: number, nz2: number;
    if (bestRegion >= 1 && bestRegion <= 3) {
      const v = F[bestFace * 3 + bestRegion - 1];
      if (this.sdf.borderVertex[v]) return Infinity;
      nx = this.vertexNormal[v * 3];
      ny2 = this.vertexNormal[v * 3 + 1];
      nz2 = this.vertexNormal[v * 3 + 2];
    } else if (bestRegion >= 4) {
      const edge = bestRegion - 4; // 0 = ab, 1 = bc, 2 = ca
      if (this.sdf.borderEdge[bestFace * 3 + edge]) return Infinity;
      const other = this.sdf.edgeNeighbour[bestFace * 3 + edge];
      nx = this.faceNormal[bestFace * 3];
      ny2 = this.faceNormal[bestFace * 3 + 1];
      nz2 = this.faceNormal[bestFace * 3 + 2];
      if (other >= 0) {
        nx += this.faceNormal[other * 3];
        ny2 += this.faceNormal[other * 3 + 1];
        nz2 += this.faceNormal[other * 3 + 2];
      }
    } else {
      nx = this.faceNormal[bestFace * 3];
      ny2 = this.faceNormal[bestFace * 3 + 1];
      nz2 = this.faceNormal[bestFace * 3 + 2];
    }
    const distance = Math.sqrt(best2);
    const sign = (x - cx) * nx + (y - cy) * ny2 + (z - cz) * nz2 >= 0 ? 1 : -1;
    SIGNNORMAL[0] = nx;
    SIGNNORMAL[1] = ny2;
    SIGNNORMAL[2] = nz2;
    return sign * distance;
  }

  /**
   * Motion bakes (bake.ts): the queries move to WebAssembly (motion/wasm/colliderKernels.ts),
   * bit-identical; setFrame stays in JS and copies its pose in. detachKernels() copies the query
   * state (cache, hints, last winner) back, e.g. before cloneState.
   */
  attachKernels(create: ColliderKernelFactory) {
    if (this.kernels) return;
    const kernels = create(this.sdf, this.pose());
    kernels.setQueryState(this.queryState());
    this.kernels = kernels;
  }
  detachKernels() {
    const kernels = this.kernels;
    if (!kernels) return;
    this.kernels = undefined;
    const s = kernels.queryState();
    this.cache = s.cache;
    this.cacheFrame = s.cacheFrame;
    this.stamp = s.stamp;
    this.query = s.query;
    this.hintSegment = s.hintSegment;
    this.hintFace = s.hintFace;
    this.winner = s.winner;
    this.winnerSegment = s.winnerSegment;
    this.winnerFace = s.winnerFace;
    this.lastX = s.lastX;
    this.lastY = s.lastY;
    this.lastZ = s.lastZ;
    this.queries = s.queries;
    this.zoneQueries = s.zoneQueries;
    this.cacheHits = s.cacheHits;
    this.bary.set(s.bary);
    this.closest.set(s.closest);
    this.local.set(s.local);
    this.bestLocal.set(s.bestLocal);
    kernels.release();
  }
  /** End of a bake: gives the kernels' instance back without copying the state out; unusable after. */
  releaseKernels() {
    this.kernels?.release();
    this.kernels = undefined;
  }
  get kernelsAttached() {
    return this.kernels !== undefined;
  }
  private pose(): ColliderPose {
    return {
      toLocal: this.toLocal,
      toPrevious: this.toPrevious,
      zoneCurrent: this.zoneCurrent,
      zonePrevious: this.zonePrevious,
      faceNormal: this.faceNormal,
      vertexNormal: this.vertexNormal,
      triBounds: this.triBounds,
      gridOrigin: this.gridOrigin,
      gridDims: this.gridDims,
      cellStart: this.cellStart,
      cellEntries: this.cellEntries,
      dt: this.dt,
      generation: this.generation,
    };
  }
  private queryState(): ColliderQueryState {
    return {
      cache: this.cache,
      cacheFrame: this.cacheFrame,
      stamp: this.stamp,
      query: this.query,
      hintSegment: this.hintSegment,
      hintFace: this.hintFace,
      winner: this.winner,
      winnerSegment: this.winnerSegment,
      winnerFace: this.winnerFace,
      lastX: this.lastX,
      lastY: this.lastY,
      lastZ: this.lastZ,
      bary: this.bary,
      closest: this.closest,
      local: this.local,
      bestLocal: this.bestLocal,
      queries: this.queries,
      zoneQueries: this.zoneQueries,
      cacheHits: this.cacheHits,
    };
  }

  distance(x: number, y: number, z: number, gradient?: Float64Array, threshold = Infinity): number {
    if (this.kernels) return this.kernels.distance(x, y, z, gradient, threshold);
    this.queries++;
    // Per-frame linearised cache (see MOTION_FIT.cacheRadiusM): the solver re-queries every
    // contact particle in each of its substeps while the body is fixed for the whole step.
    const e = MOTION_FIT.cacheRadiusM,
      ix = Math.floor(x / e),
      iy = Math.floor(y / e),
      iz = Math.floor(z / e),
      key = ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) & CACHE_MASK,
      c = this.cache,
      b = key * CACHE_STRIDE;
    if (this.cacheFrame[key] === this.generation) {
      const dx = x - c[b],
        dy = y - c[b + 1],
        dz = z - c[b + 2];
      if (dx * dx + dy * dy + dz * dz < e * e) {
        const value = c[b + 3] + c[b + 4] * dx + c[b + 5] * dy + c[b + 6] * dz;
        // Valid where the full query was exact: below its zone search cap.
        if (value < c[b + 7] - e) {
          this.cacheHits++;
          this.winner = c[b + 8];
          this.winnerSegment = c[b + 9];
          this.winnerFace = c[b + 10];
          this.bary[0] = c[b + 11];
          this.bary[1] = c[b + 12];
          this.bary[2] = c[b + 13];
          if (gradient && value < threshold) {
            gradient[0] = c[b + 4];
            gradient[1] = c[b + 5];
            gradient[2] = c[b + 6];
          }
          this.lastX = x;
          this.lastY = y;
          this.lastZ = z;
          return value;
        }
      }
    }
    const g = this.fullGradient;
    const { value, cap } = this.full(x, y, z, g, threshold);
    if (gradient && value < threshold) {
      gradient[0] = g[0];
      gradient[1] = g[1];
      gradient[2] = g[2];
    }
    if (value < cap && this.winner) {
      this.cacheFrame[key] = this.generation;
      c[b] = x;
      c[b + 1] = y;
      c[b + 2] = z;
      c[b + 3] = value;
      c[b + 4] = g[0];
      c[b + 5] = g[1];
      c[b + 6] = g[2];
      c[b + 7] = cap;
      c[b + 8] = this.winner;
      c[b + 9] = this.winnerSegment;
      c[b + 10] = this.winnerFace;
      c[b + 11] = this.bary[0];
      c[b + 12] = this.bary[1];
      c[b + 13] = this.bary[2];
    }
    this.lastX = x;
    this.lastY = y;
    this.lastZ = z;
    return value;
  }

  /** Uncached query; always writes the gradient. The value is exact when below `cap`. */
  private full(x: number, y: number, z: number, gradient: Float64Array, threshold: number) {
    const rigid = this.rigid(x, y, z);
    // The zone only matters where it can beat the rigid value; search no further than needed.
    const cap = Number.isFinite(threshold)
      ? Math.min(MOTION_FIT.zoneSearchMaxM, Math.max(threshold, 0) + MOTION_FIT.zoneSearchMarginM)
      : MOTION_FIT.zoneSearchMaxM;
    const radius = rigid > 0 ? Math.min(cap, rigid) : cap;
    let zone = NaN;
    if (radius > 0) {
      this.zoneQueries++;
      zone = this.zone(x, y, z, radius);
    }
    let value: number;
    if (!Number.isNaN(zone) && zone < rigid) {
      value = zone;
      this.winner = ZONE;
    } else if (Number.isNaN(zone) && rigid > radius) {
      // No zone triangle within `radius` and the rigid cores are farther: the true distance is
      // at least `radius` (a lower bound keeps the solver's contact slack conservative).
      value = radius;
      this.winner = 0;
    } else {
      value = rigid;
      this.winner = this.winnerSegment >= 0 ? RIGID : 0;
    }
    gradient[0] = gradient[1] = gradient[2] = 0;
    if (this.winner === ZONE) {
      const dx = x - this.closest[0],
        dy = y - this.closest[1],
        dz = z - this.closest[2],
        l = Math.hypot(dx, dy, dz);
      if (l > 1e-7) {
        const s = value >= 0 ? 1 / l : -1 / l;
        gradient[0] = dx * s;
        gradient[1] = dy * s;
        gradient[2] = dz * s;
      } else {
        gradient[0] = SIGNNORMAL[0];
        gradient[1] = SIGNNORMAL[1];
        gradient[2] = SIGNNORMAL[2];
      }
    } else if (this.winner === RIGID) {
      const s = this.winnerSegment,
        L = this.toLocal,
        o = s * 12,
        g = this.localGradient;
      trilinear(this.sdf.segments[s], this.bestLocal, g);
      // ∇_world = Aᵀ ∇_local for local = A·p + b.
      gradient[0] = L[o] * g[0] + L[o + 4] * g[1] + L[o + 8] * g[2];
      gradient[1] = L[o + 1] * g[0] + L[o + 5] * g[1] + L[o + 9] * g[2];
      gradient[2] = L[o + 2] * g[0] + L[o + 6] * g[1] + L[o + 10] * g[2];
    }
    // Exact (up to the rigid/zone switch noted in config) wherever value < cap.
    return { value, cap: this.winner ? cap : -Infinity };
  }

  /** Exact (uncached) distance, for validation against the Python reference. */
  exactDistance(x: number, y: number, z: number, threshold = Infinity) {
    if (this.kernels) return this.kernels.exact(x, y, z, threshold);
    this.lastX = NaN;
    return this.full(x, y, z, this.fullGradient, threshold).value;
  }

  /** Skin velocity (m/s) of the body part that decides the distance at (x, y, z). */
  surfaceVelocity(x: number, y: number, z: number, out: Float64Array) {
    if (this.kernels) return this.kernels.surface(x, y, z, out);
    out[0] = out[1] = out[2] = 0;
    // The winner state of the last distance() query is reused when it was at this very point
    // (the solver asks right after its contact query): a repeat query at the same point and
    // pose returns the same winner, segment, face and barycentrics (cache entry or same search).
    if (x !== this.lastX || y !== this.lastY || z !== this.lastZ) this.distance(x, y, z);
    const inv = 1 / this.dt;
    if (this.winner === RIGID) {
      const P = this.toPrevious,
        o = this.winnerSegment * 12;
      out[0] = (x - (P[o] * x + P[o + 1] * y + P[o + 2] * z + P[o + 3])) * inv;
      out[1] = (y - (P[o + 4] * x + P[o + 5] * y + P[o + 6] * z + P[o + 7])) * inv;
      out[2] = (z - (P[o + 8] * x + P[o + 9] * y + P[o + 10] * z + P[o + 11])) * inv;
    } else if (this.winner === ZONE) {
      const F = this.sdf.zoneFaces,
        f = this.winnerFace,
        c = this.zoneCurrent,
        p = this.zonePrevious;
      for (let k = 0; k < 3; k++) {
        const v = F[f * 3 + k] * 3,
          w = this.bary[k] * inv;
        out[0] += (c[v] - p[v]) * w;
        out[1] += (c[v + 1] - p[v + 1]) * w;
        out[2] += (c[v + 2] - p[v + 2]) * w;
      }
    }
  }
}

const SCRATCH = new Float64Array(6);
const CACHE_SIZE = 1 << 16,
  CACHE_MASK = CACHE_SIZE - 1,
  CACHE_STRIDE = 14;
const SIGNNORMAL = new Float64Array(3);

/** out = A (3×4 at a) · B (3×4 at b), both affine. */
function compose(
  A: ArrayLike<number>,
  a: number,
  B: ArrayLike<number>,
  b: number,
  out: Float64Array,
  o: number,
) {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let v = c === 3 ? A[a + r * 4 + 3] : 0;
      for (let k = 0; k < 3; k++) v += A[a + r * 4 + k] * B[b + k * 4 + c];
      out[o + r * 4 + c] = v;
    }
  }
}
function composeFrom(
  A: ArrayLike<number>,
  a: number,
  B: Float64Array,
  out: Float64Array,
  o: number,
) {
  compose(A, a, B, 0, out, o);
}

/**
 * Trilinear sample with clamping; outside the box add the distance to the box (P1 trilinear,
 * an upper bound). With `gradient`, writes ∂d/∂local.
 */
export function trilinear(seg: SdfSegment, local: Float64Array, gradient: Float64Array | null) {
  const dims = seg.dims,
    nx = dims[0],
    ny = dims[1],
    nz = dims[2],
    inv = 1 / seg.spacing;
  const gx = (local[0] - seg.origin[0]) * inv,
    gy = (local[1] - seg.origin[1]) * inv,
    gz = (local[2] - seg.origin[2]) * inv;
  const cx = Math.max(0, Math.min(nx - 1, gx)),
    cy = Math.max(0, Math.min(ny - 1, gy)),
    cz = Math.max(0, Math.min(nz - 1, gz));
  const ox = gx - cx,
    oy = gy - cy,
    oz = gz - cz;
  const outside = Math.sqrt(ox * ox + oy * oy + oz * oz) * seg.spacing;
  const i = Math.min(Math.floor(cx), nx - 2),
    j = Math.min(Math.floor(cy), ny - 2),
    k = Math.min(Math.floor(cz), nz - 2);
  const u = cx - i,
    v = cy - j,
    w = cz - k;
  const sx = ny * nz,
    sy = nz,
    base = i * sx + j * sy + k,
    f = seg.values;
  const c000 = f[base],
    c100 = f[base + sx],
    c010 = f[base + sy],
    c110 = f[base + sx + sy],
    c001 = f[base + 1],
    c101 = f[base + sx + 1],
    c011 = f[base + sy + 1],
    c111 = f[base + sx + sy + 1];
  const a = c000 * (1 - u) + c100 * u,
    b = c010 * (1 - u) + c110 * u,
    c = c001 * (1 - u) + c101 * u,
    d = c011 * (1 - u) + c111 * u;
  const lower = a * (1 - v) + b * v,
    upper = c * (1 - v) + d * v;
  if (gradient) {
    gradient[0] =
      ox === 0
        ? ((c100 - c000) * (1 - v) * (1 - w) +
            (c110 - c010) * v * (1 - w) +
            (c101 - c001) * (1 - v) * w +
            (c111 - c011) * v * w) *
          inv
        : 0;
    gradient[1] = oy === 0 ? ((b - a) * (1 - w) + (d - c) * w) * inv : 0;
    gradient[2] = oz === 0 ? (upper - lower) * inv : 0;
    if (outside > 1e-12) {
      const s = seg.spacing / outside;
      gradient[0] += ox * s;
      gradient[1] += oy * s;
      gradient[2] += oz * s;
    }
  }
  return lower * (1 - w) + upper * w + outside;
}

/**
 * Closest point on triangle abc to p (Ericson, Real-Time Collision Detection §5.1.5). Writes
 * the point to out[0..2] and its barycentric weights (a, b, c) to out[3..5]. Returns the
 * feature: 0 = face interior, 1/2/3 = vertex a/b/c, 4/5/6 = edge ab/bc/ca.
 */
export function closestOnTriangle(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  out: Float64Array,
): number {
  const abx = bx - ax,
    aby = by - ay,
    abz = bz - az,
    acx = cx - ax,
    acy = cy - ay,
    acz = cz - az,
    apx = px - ax,
    apy = py - ay,
    apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz,
    d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(out, ax, ay, az, 1, 0, 0, 1);
  const bpx = px - bx,
    bpy = py - by,
    bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz,
    d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(out, bx, by, bz, 0, 1, 0, 2);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return set(out, ax + t * abx, ay + t * aby, az + t * abz, 1 - t, t, 0, 4);
  }
  const cpx = px - cx,
    cpy = py - cy,
    cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz,
    d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(out, cx, cy, cz, 0, 0, 1, 3);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return set(out, ax + t * acx, ay + t * acy, az + t * acz, 1 - t, 0, t, 6);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(out, bx + t * (cx - bx), by + t * (cy - by), bz + t * (cz - bz), 0, 1 - t, t, 5);
  }
  const denom = 1 / (va + vb + vc),
    v = vb * denom,
    w = vc * denom;
  return set(
    out,
    ax + abx * v + acx * w,
    ay + aby * v + acy * w,
    az + abz * v + acz * w,
    1 - v - w,
    v,
    w,
    0,
  );
}

function set(
  out: Float64Array,
  x: number,
  y: number,
  z: number,
  a: number,
  b: number,
  c: number,
  region: number,
) {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = a;
  out[4] = b;
  out[5] = c;
  return region;
}
