// P (Fit Lab redesign): trousers for the 3D body, so it is not a bare mannequin below the jacket.
//
// The trousers are the body's OWN surface from just above the hip line down to just above the
// ankles, pushed out along the vertex normals (looser at the thigh, tapering to the ankle), with a
// short "wall" at both hems so the cut edge reads as a clean hem and not a see-through hole.
//
// How the pose is followed. The Fit Lab body is NOT a GPU-skinned THREE.SkinnedMesh: LiveAvatar
// skins it on the CPU (liveRig/skinVertices) into a plain Mesh whose position/normal buffers are
// rewritten every pose frame. So the main path is `Trousers`, a Mesh whose vertices each remember
// their body vertex and offset: `sync()` reads the body mesh's current buffers
// (position[src] + normal[src] * offset), which is exactly the same skinning as the body, no second
// skeleton. For a real THREE.SkinnedMesh body (e.g. a glTF body) `createTrousers` returns a
// SkinnedMesh bound to the same skeleton and bind matrix instead (`TrousersFactory` contract).
//
// Every constant below is a styling choice (fabric ease), not a body measurement; nothing here
// feeds a fit number.
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RedFormat,
  SkinnedMesh,
  Uint16BufferAttribute,
  type Object3D,
} from 'three';
import { smoothNormals } from '../../../engine/cloth/normals';
import type { TrousersFactory } from './types';

// ---------------------------------------------------------------- configuration (metres)

/**
 * Ordinary straight-leg chinos. Thigh: 2.8 cm of ease over the skin, easing to 2.0 cm at the
 * knee. Below the knee the leg is NOT shrink-wrapped: it hangs as an even, near-circular tube of
 * constant radius around the leg axis (see TUBE_* below). Waistband 1.5 cm over the skin.
 */
export const THIGH_OFFSET_M = 0.028;
export const KNEE_OFFSET_M = 0.02;
export const ANKLE_OFFSET_M = 0.018;
/** Ease at the very top of the waistband (m), growing to THIGH_OFFSET_M over WAIST_BLEND_M. */
export const WAIST_OFFSET_M = 0.015;
export const WAIST_BLEND_M = 0.05;
/** Lower leg tube radius = max(knee radius + TUBE_OVER_KNEE_M, widest calf + TUBE_OVER_CALF_M). */
export const TUBE_OVER_KNEE_M = 0.015;
export const TUBE_OVER_CALF_M = 0.006;
/** The tube is fully on TUBE_FULL_BELOW_KNEE_M below the knee, off TUBE_OFF_ABOVE_KNEE_M above. */
const TUBE_FULL_BELOW_KNEE_M = 0.02;
const TUBE_OFF_ABOVE_KNEE_M = 0.08;
/** Hem thickness (m): the open hem edge sits this far inside the tube radius. */
const HEM_WALL_M = 0.012;
/** Height of the slices used to find each leg axis. */
const RING_M = 0.02;
/** The waistband top sits this far above the hip line, under the jacket hem. */
export const WAIST_RISE_M = 0.07;
/** The ankle hem ends this far above the ankle height. */
export const HEM_ABOVE_ANKLE_M = 0.035;
/** A pelvis/leg component comes within this distance (m) of the body midline; arms do not. */
const MIDLINE_REACH_M = 0.1;
/** Default fabric: dark charcoal-navy cotton twill. */
export const DEFAULT_TROUSERS_COLOUR = 0x2b303b;

export interface TrousersOptions {
  /** Hip line (m, scene Y-up, rest pose): the waistband rises WAIST_RISE_M above it. */
  hipY: number;
  /** Ankle height (m): the hems end HEM_ABOVE_ANKLE_M above it. */
  ankleY: number;
  /** Knee height (m); default halfway between the hip and the ankle. */
  kneeY?: number;
  /** Fabric colour (default dark charcoal-navy). */
  colour?: number;
}

/** The heights from a posed-joint map (LiveAvatar.joints): midHip, the lower ankle, the knees. */
export function trousersHeights(joints: Record<string, readonly number[]>): {
  hipY: number;
  ankleY: number;
  kneeY?: number;
} {
  const hip = joints.midHip,
    l = joints.lAnkle,
    r = joints.rAnkle;
  if (!hip || !l || !r)
    throw new Error('trousersHeights needs the midHip, lAnkle and rAnkle joints');
  const out: { hipY: number; ankleY: number; kneeY?: number } = {
    hipY: hip[1],
    ankleY: Math.min(l[1], r[1]),
  };
  if (joints.lKnee && joints.rKnee) out.kneeY = (joints.lKnee[1] + joints.rKnee[1]) / 2;
  return out;
}

// ---------------------------------------------------------------- pure geometry

/** Normal ease (m) at height y: the waistband blends in at the top, then thigh, knee, ankle. */
export function trouserOffset(y: number, hipY: number, ankleY: number, kneeY?: number): number {
  const top = hipY + WAIST_RISE_M;
  if (y >= hipY) {
    const s = smooth(Math.min(1, Math.max(0, (top - y) / WAIST_BLEND_M)));
    return WAIST_OFFSET_M + (THIGH_OFFSET_M - WAIST_OFFSET_M) * s;
  }
  const hemY = ankleY + HEM_ABOVE_ANKLE_M;
  const knee = kneeY ?? (hipY + ankleY) / 2;
  if (y >= knee) {
    const t = smooth(Math.min(1, Math.max(0, (hipY - y) / Math.max(1e-6, hipY - knee))));
    return THIGH_OFFSET_M + (KNEE_OFFSET_M - THIGH_OFFSET_M) * t;
  }
  const t = smooth(Math.min(1, Math.max(0, (knee - y) / Math.max(1e-6, knee - hemY))));
  return KNEE_OFFSET_M + (ANKLE_OFFSET_M - KNEE_OFFSET_M) * t;
}
/** 0 above the knee zone, 1 on the hanging lower leg (the near-circular tube). */
export function tubeWeight(y: number, kneeY: number): number {
  const t =
    (y - (kneeY - TUBE_FULL_BELOW_KNEE_M)) / (TUBE_OFF_ABOVE_KNEE_M + TUBE_FULL_BELOW_KNEE_M);
  return 1 - smooth(Math.min(1, Math.max(0, t)));
}
const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Faces (indices into `faces / 3`) that touch the band [yMin, yMax] and belong to the pelvis and
 * legs. A component is pelvis/legs when it reaches the body midline (the crotch joins the legs);
 * arms and hands hanging beside the hips stay farther than MIDLINE_REACH_M from it.
 */
export function selectTrouserFaces(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
  yMin: number,
  yMax: number,
): number[] {
  const y = (v: number) => positions[v * 3 + 1];
  const candidate: number[] = [];
  for (let f = 0; f < faces.length / 3; f++) {
    const ys = [y(faces[f * 3]), y(faces[f * 3 + 1]), y(faces[f * 3 + 2])];
    if (Math.min(...ys) <= yMax && Math.max(...ys) >= yMin) candidate.push(f);
  }
  // Union-find over vertices joined by candidate faces.
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    let r = a;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) as number;
    while (a !== r) {
      const next = parent.get(a) ?? a;
      parent.set(a, r);
      a = next;
    }
    return r;
  };
  for (const f of candidate)
    for (let k = 1; k < 3; k++) {
      const ra = find(faces[f * 3]),
        rb = find(faces[f * 3 + k]);
      if (ra !== rb) parent.set(rb, ra);
    }
  let mid = 0;
  for (let v = 0; v < positions.length; v += 3) mid += positions[v];
  mid /= positions.length / 3;
  const reach = new Map<number, number>();
  for (const f of candidate)
    for (let k = 0; k < 3; k++) {
      const v = faces[f * 3 + k],
        r = find(v);
      reach.set(r, Math.min(reach.get(r) ?? Infinity, Math.abs(positions[v * 3] - mid)));
    }
  return candidate.filter((f) => (reach.get(find(faces[f * 3])) ?? Infinity) < MIDLINE_REACH_M);
}

export interface TrousersData {
  /** Each trouser vertex lies between two body vertices: A, B and the blend t (0 = A, 1 = B). */
  sourceIndex: Uint32Array;
  sourceIndexB: Uint32Array;
  blend: Float32Array;
  /** Distance along the body's vertex normal (m); 0 on the rim vertices that sit on the skin. */
  offset: Float32Array;
  /** Triangles (outward winding as the body's). */
  indices: Uint32Array;
  /** Rest-pose positions (V·3), body rest + rest normal * offset. */
  restPositions: Float32Array;
  /** 1 on the hem rim vertices lying on the body surface (the only open edges left). */
  rim: Uint8Array;
  /** Planar texture coordinates for the fabric bump (V·2). */
  uv: Float32Array;
  /** 0..1: how much of the lower-leg tube replaces the normal ease (per vertex). */
  tubeWeight: Float32Array;
  /** Tube radius (m) around the leg axis, per vertex (the hem rim sits HEM_WALL_M inside it). */
  tubeRadius: Float32Array;
  /** Leg-axis slice each vertex uses (-1 = none); slice k averages ringMembers[ringStart[k]..]. */
  ring: Int32Array;
  /** The next slice up and the blend toward it (the axis point is lerped between the two). */
  ringB: Int32Array;
  ringT: Float32Array;
  /** Slice k's neighbours 4 cm above / below (-1 = none): their centres give the leg axis. */
  axisUp: Int32Array;
  axisDown: Int32Array;
  ringStart: Uint32Array;
  ringMembers: Uint32Array;
  /** Number of triangles that come from the body's own surface (the rest are hem walls). */
  surfaceTriangles: number;
}

/** A trouser vertex: a body vertex (a === b) or the point t along the body edge a-b. */
type Ref = { a: number; b: number; t: number };
/** A polygon corner while a triangle is clipped: body vertex v, or v = -1 for a hem crossing. */
type Corner = { v: number; ref: number };

/**
 * Clips the kept body triangles to the hem planes (flat, clean cut edges at the waist and ankle)
 * and returns the surface vertices (as body-edge blends) and triangles.
 */
function clipToBand(
  yOf: (v: number) => number,
  faces: ArrayLike<number>,
  kept: readonly number[],
  bottom: number,
  top: number,
) {
  const refs: Ref[] = [];
  const byKey = new Map<string, number>();
  const intern = (id: string, make: () => Ref) => {
    let i = byKey.get(id);
    if (i === undefined) {
      i = refs.length;
      byKey.set(id, i);
      refs.push(make());
    }
    return i;
  };
  const vertexRef = (v: number) => intern(`${v}`, () => ({ a: v, b: v, t: 0 }));
  const crossRef = (p: number, q: number, plane: number) => {
    const a = Math.min(p, q),
      b = Math.max(p, q);
    return intern(`${a}:${b}:${plane}`, () => ({ a, b, t: (plane - yOf(a)) / (yOf(b) - yOf(a)) }));
  };
  const cornerY = (c: Corner) => {
    const r = refs[c.ref];
    return yOf(r.a) + (yOf(r.b) - yOf(r.a)) * r.t;
  };
  // The new point on polygon edge c-n. Both body vertices: that body edge. Otherwise one corner is
  // a crossing created on the original triangle edge (body, far): cut that edge again.
  const cross = (c: Corner, n: Corner, plane: number) => {
    if (c.v >= 0 && n.v >= 0) return crossRef(c.v, n.v, plane);
    const body = c.v >= 0 ? c : n,
      other = refs[(c.v >= 0 ? n : c).ref];
    return crossRef(body.v, other.a === body.v ? other.b : other.a, plane);
  };
  const clip = (poly: Corner[], plane: number, keepAbove: boolean): Corner[] => {
    const inside = (c: Corner) => (keepAbove ? cornerY(c) >= plane : cornerY(c) <= plane);
    const out: Corner[] = [];
    for (let i = 0; i < poly.length; i++) {
      const c = poly[i],
        n = poly[(i + 1) % poly.length];
      if (inside(c)) out.push(c);
      if (inside(c) !== inside(n)) out.push({ v: -1, ref: cross(c, n, plane) });
    }
    return out;
  };
  const tris: number[] = [];
  for (const f of kept) {
    let poly: Corner[] = [0, 1, 2].map((k) => {
      const v = faces[f * 3 + k];
      return { v, ref: vertexRef(v) };
    });
    poly = clip(poly, bottom, true);
    if (poly.length >= 3) poly = clip(poly, top, false);
    for (let k = 1; k + 1 < poly.length; k++) tris.push(poly[0].ref, poly[k].ref, poly[k + 1].ref);
  }
  // Compact: keep the referenced vertices only.
  const used = new Map<number, number>();
  const surface: Ref[] = [];
  const triangles = tris.map((r) => {
    let i = used.get(r);
    if (i === undefined) {
      i = surface.length;
      used.set(r, i);
      surface.push(refs[r]);
    }
    return i;
  });
  return { surface, triangles };
}

/** Builds the trouser mesh data from the body's rest positions and faces (pure; no THREE). */
export function buildTrousersData(
  restPositions: ArrayLike<number>,
  faces: ArrayLike<number>,
  opts: Pick<TrousersOptions, 'hipY' | 'ankleY' | 'kneeY'>,
): TrousersData {
  const { hipY, ankleY } = opts;
  const top = hipY + WAIST_RISE_M,
    bottom = ankleY + HEM_ABOVE_ANKLE_M;
  if (!(top > bottom)) throw new Error('trousers: hipY must be above ankleY');
  const kept = selectTrouserFaces(restPositions, faces, bottom, top);
  if (!kept.length) throw new Error('trousers: no body surface between the hip and ankle heights');
  const normals = new Float32Array(restPositions.length);
  smoothNormals(restPositions, faces, normals);

  const { surface, triangles: tris } = clipToBand(
    (v) => restPositions[v * 3 + 1],
    faces,
    kept,
    bottom,
    top,
  );
  const surfaceVertices = surface.length;

  // Boundary edges: directed edges whose reverse is not used by another triangle.
  const directed = new Set<number>();
  const key = (a: number, b: number) => a * surfaceVertices + b;
  for (let t = 0; t < tris.length; t += 3)
    for (let k = 0; k < 3; k++) directed.add(key(tris[t + k], tris[t + ((k + 1) % 3)]));
  const boundary: [number, number][] = [];
  for (let t = 0; t < tris.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = tris[t + k],
        b = tris[t + ((k + 1) % 3)];
      if (!directed.has(key(b, a))) boundary.push([a, b]);
    }

  // Rim vertices: one on-skin copy (offset 0) per boundary vertex, joined by a wall.
  const rimOf = new Map<number, number>();
  const rimRefs: Ref[] = [];
  const rimIndex = (a: number) => {
    let r = rimOf.get(a);
    if (r === undefined) {
      r = surfaceVertices + rimRefs.length;
      rimOf.set(a, r);
      rimRefs.push(surface[a]);
    }
    return r;
  };
  const wall: number[] = [];
  for (const [a, b] of boundary) {
    const ra = rimIndex(a),
      rb = rimIndex(b);
    // Quad a, b (outer) / rb, ra (on skin): the wall faces away from the trouser surface.
    wall.push(a, ra, rb, a, rb, b);
  }

  const total = surfaceVertices + rimRefs.length;
  const kneeY = opts.kneeY ?? (hipY + ankleY) / 2;
  let mid = 0;
  for (let v = 0; v < restPositions.length; v += 3) mid += restPositions[v];
  mid /= restPositions.length / 3;
  const rx = (v: number) => restPositions[v * 3];
  const ry = (v: number) => restPositions[v * 3 + 1];
  const refAt = (i: number) => (i < surfaceVertices ? surface[i] : rimRefs[i - surfaceVertices]);
  const refY = (r: Ref) => ry(r.a) * (1 - r.t) + ry(r.b) * r.t;
  const refSide = (r: Ref) => (rx(r.a) * (1 - r.t) + rx(r.b) * r.t >= mid ? 1 : 0);

  // Leg-axis slices: per leg (side of the midline) and RING_M bin, the body vertices of the
  // surface in the bin and its four neighbours (smooths the jitter of uneven vertex rows).
  const tubeTop = kneeY + TUBE_OFF_ABOVE_KNEE_M;
  const binOf = (y: number) => Math.floor(y / RING_M);
  const binMembers = new Map<string, Set<number>>();
  const addMember = (v: number, side: number) => {
    const k = `${side}:${binOf(ry(v))}`;
    let set = binMembers.get(k);
    if (!set) binMembers.set(k, (set = new Set()));
    set.add(v);
  };
  for (let i = 0; i < surfaceVertices; i++) {
    const r = surface[i];
    if (refY(r) > tubeTop + RING_M) continue;
    const side = refSide(r);
    addMember(r.a, side);
    addMember(r.b, side);
  }
  const ringId = new Map<string, number>();
  const ringList: number[][] = [];
  const ringOf = (side: number, bin: number) => {
    const k = `${side}:${bin}`;
    let id = ringId.get(k);
    if (id === undefined) {
      const members = new Set<number>();
      for (let d = -2; d <= 2; d++)
        for (const v of binMembers.get(`${side}:${bin + d}`) ?? []) members.add(v);
      if (members.size < 3) return -1;
      id = ringList.length;
      ringId.set(k, id);
      ringList.push([...members]);
    }
    return id;
  };
  const centreOf = (members: readonly number[]) => {
    const c = [0, 0, 0];
    for (const v of members) for (let a = 0; a < 3; a++) c[a] += restPositions[v * 3 + a];
    return c.map((x) => x / members.length);
  };
  // Tube radius per leg: knee radius + 1.5 cm, never tighter than the calf + 0.6 cm.
  const radius = [0, 0];
  for (let side = 0; side < 2; side++) {
    let kneeSum = 0,
      kneeN = 0,
      calf = 0;
    for (let bin = binOf(ankleY); bin <= binOf(kneeY + 0.03); bin++) {
      const id = ringOf(side, bin);
      if (id < 0) continue;
      const members = ringList[id];
      const c = centreOf(members);
      let rad = 0;
      for (const v of members)
        rad +=
          Math.hypot(rx(v) - c[0], ry(v) - c[1], restPositions[v * 3 + 2] - c[2]) / members.length;
      const y = (bin + 0.5) * RING_M;
      if (Math.abs(y - kneeY) <= 0.03) {
        kneeSum += rad;
        kneeN++;
      }
      if (y < kneeY) calf = Math.max(calf, rad);
    }
    const knee = kneeN ? kneeSum / kneeN : calf;
    radius[side] = Math.max(knee + TUBE_OVER_KNEE_M, calf + TUBE_OVER_CALF_M);
  }

  const sourceIndex = new Uint32Array(total),
    sourceIndexB = new Uint32Array(total);
  const blend = new Float32Array(total);
  const offset = new Float32Array(total);
  const rim = new Uint8Array(total);
  const uv = new Float32Array(total * 2);
  const tubeW = new Float32Array(total),
    tubeR = new Float32Array(total);
  const ring = new Int32Array(total).fill(-1),
    ringB = new Int32Array(total).fill(-1),
    ringT = new Float32Array(total);
  const usedRings = new Map<number, number>();
  const finalRings: number[][] = [];
  const axisUp: number[] = [],
    axisDown: number[] = [];
  const add = (id: number) => {
    let k = usedRings.get(id);
    if (k === undefined) {
      k = finalRings.length;
      usedRings.set(id, k);
      finalRings.push(ringList[id]);
      axisUp.push(-1);
      axisDown.push(-1);
    }
    return k;
  };
  // A slice plus the slices 3 bins (6 cm) above and below, whose centres give the leg axis.
  const register = (side: number, bin: number) => {
    const id = ringOf(side, bin);
    if (id < 0) return -1;
    const fresh = !usedRings.has(id);
    const k = add(id);
    if (fresh) {
      const up = ringOf(side, bin + 3),
        down = ringOf(side, bin - 3);
      axisUp[k] = up >= 0 ? add(up) : -1;
      axisDown[k] = down >= 0 ? add(down) : -1;
    }
    return k;
  };
  for (let i = 0; i < total; i++) {
    const r = refAt(i);
    sourceIndex[i] = r.a;
    sourceIndexB[i] = r.b;
    blend[i] = r.t;
    rim[i] = i < surfaceVertices ? 0 : 1;
    const y = refY(r),
      side = refSide(r);
    const nx = normals[r.a * 3] * (1 - r.t) + normals[r.b * 3] * r.t,
      nz = normals[r.a * 3 + 2] * (1 - r.t) + normals[r.b * 3 + 2] * r.t;
    let d = i < surfaceVertices ? trouserOffset(y, hipY, ankleY, kneeY) : 0;
    // Inner thighs: where the surface faces the other leg, keep only a little ease so the two
    // legs never intersect at the crotch.
    if (y < hipY) {
      const inner = Math.max(0, -nx * (side ? 1 : -1));
      d *= 1 - 0.85 * smooth(Math.min(1, inner / 0.6));
    }
    offset[i] = d;
    const w = y < hipY ? tubeWeight(y, kneeY) : 0;
    if (w > 0) {
      // The axis point at this height: linear between the slices centred below and above it.
      const u = y / RING_M - 0.5,
        b0 = Math.floor(u);
      let k0 = register(side, b0),
        k1 = register(side, b0 + 1);
      if (k0 < 0) k0 = k1;
      if (k1 < 0) k1 = k0;
      if (k0 >= 0) {
        ring[i] = k0;
        ringB[i] = k1;
        ringT[i] = u - b0;
        tubeW[i] = w;
        tubeR[i] = radius[side] - (i < surfaceVertices ? 0 : HEM_WALL_M);
      }
    }
    // Planar fabric texture: project along the dominant horizontal axis of the normal (a fine
    // bump noise, so a stretched triangle at the switch is invisible).
    const across =
      Math.abs(nx) > Math.abs(nz) ? restPositions[r.a * 3 + 2] : restPositions[r.a * 3];
    uv[i * 2] = across * 6;
    uv[i * 2 + 1] = y * 6;
  }
  const ringStart = new Uint32Array(finalRings.length + 1);
  finalRings.forEach((m, k) => (ringStart[k + 1] = ringStart[k] + m.length));
  const data: TrousersData = {
    sourceIndex,
    sourceIndexB,
    blend,
    offset,
    indices: Uint32Array.from([...tris, ...wall]),
    restPositions: new Float32Array(total * 3),
    rim,
    uv,
    tubeWeight: tubeW,
    tubeRadius: tubeR,
    ring,
    ringB,
    ringT,
    axisUp: Int32Array.from(axisUp),
    axisDown: Int32Array.from(axisDown),
    ringStart,
    ringMembers: Uint32Array.from(finalRings.flat()),
    surfaceTriangles: tris.length / 3,
  };
  placeTrousers(data, restPositions, normals, data.restPositions);
  return data;
}

/**
 * Places every trouser vertex on a (posed) body: the body surface point plus the normal ease, and
 * on the lower leg blended to the tube (axis = mean of the leg slice's body vertices, constant
 * radius). Pure; used for the rest geometry and every pose frame. `normalsOut` gets the shading
 * normals when given.
 */
export function placeTrousers(
  data: TrousersData,
  positions: ArrayLike<number>,
  normals: ArrayLike<number>,
  out: Float32Array,
  normalsOut?: Float32Array,
) {
  const { sourceIndex, sourceIndexB, blend, offset, tubeWeight: tw, tubeRadius, ring } = data;
  const rings = data.ringStart.length - 1;
  const centre = new Float64Array(rings * 3);
  for (let k = 0; k < rings; k++) {
    const from = data.ringStart[k],
      to = data.ringStart[k + 1];
    for (let m = from; m < to; m++) {
      const v = data.ringMembers[m] * 3;
      centre[k * 3] += positions[v];
      centre[k * 3 + 1] += positions[v + 1];
      centre[k * 3 + 2] += positions[v + 2];
    }
    const n = to - from || 1;
    centre[k * 3] /= n;
    centre[k * 3 + 1] /= n;
    centre[k * 3 + 2] /= n;
  }
  // Leg axis per slice: from the slice below to the slice above (vertical when neither exists).
  const axis = new Float64Array(rings * 3);
  for (let k = 0; k < rings; k++) {
    const up = data.axisUp[k] >= 0 ? data.axisUp[k] : k,
      down = data.axisDown[k] >= 0 ? data.axisDown[k] : k;
    let ax = centre[up * 3] - centre[down * 3],
      ay = centre[up * 3 + 1] - centre[down * 3 + 1],
      az = centre[up * 3 + 2] - centre[down * 3 + 2];
    const al = Math.hypot(ax, ay, az);
    if (al < 1e-6) [ax, ay, az] = [0, 1, 0];
    else [ax, ay, az] = [ax / al, ay / al, az / al];
    axis[k * 3] = ax;
    axis[k * 3 + 1] = ay;
    axis[k * 3 + 2] = az;
  }
  for (let i = 0; i < sourceIndex.length; i++) {
    const va = sourceIndex[i] * 3,
      vb = sourceIndexB[i] * 3,
      t = blend[i],
      d = offset[i];
    const px = positions[va] * (1 - t) + positions[vb] * t,
      py = positions[va + 1] * (1 - t) + positions[vb + 1] * t,
      pz = positions[va + 2] * (1 - t) + positions[vb + 2] * t;
    let nx = normals[va] * (1 - t) + normals[vb] * t,
      ny = normals[va + 1] * (1 - t) + normals[vb + 1] * t,
      nz = normals[va + 2] * (1 - t) + normals[vb + 2] * t;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    let x = px + nx * d,
      y = py + ny * d,
      z = pz + nz * d;
    const w = ring[i] >= 0 ? tw[i] : 0;
    if (w > 0) {
      const c0 = ring[i] * 3,
        c1 = data.ringB[i] * 3,
        f = data.ringT[i];
      const cx = centre[c0] * (1 - f) + centre[c1] * f,
        cy = centre[c0 + 1] * (1 - f) + centre[c1 + 1] * f,
        cz = centre[c0 + 2] * (1 - f) + centre[c1 + 2] * f;
      let ax = axis[c0] * (1 - f) + axis[c1] * f,
        ay = axis[c0 + 1] * (1 - f) + axis[c1 + 1] * f,
        az = axis[c0 + 2] * (1 - f) + axis[c1 + 2] * f;
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al;
      ay /= al;
      az /= al;
      let dx = px - cx,
        dy = py - cy,
        dz = pz - cz;
      // Radial = perpendicular to the leg axis; the axial offset is kept, so heights hold.
      const along = dx * ax + dy * ay + dz * az;
      dx -= ax * along;
      dy -= ay * along;
      dz -= az * along;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const R = tubeRadius[i];
      x = x * (1 - w) + (cx + ax * along + dx * R) * w;
      y = y * (1 - w) + (cy + ay * along + dy * R) * w;
      z = z * (1 - w) + (cz + az * along + dz * R) * w;
      nx = nx * (1 - w) + dx * w;
      ny = ny * (1 - w) + dy * w;
      nz = nz * (1 - w) + dz * w;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
    }
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
    if (normalsOut) {
      normalsOut[i * 3] = nx;
      normalsOut[i * 3 + 1] = ny;
      normalsOut[i * 3 + 2] = nz;
    }
  }
}

/** Undirected boundary edges of an indexed triangle list (edges used by exactly one triangle). */
export function openEdges(indices: ArrayLike<number>): [number, number][] {
  const seen = new Map<string, [number, number, number]>();
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k],
        b = indices[t + ((k + 1) % 3)];
      const id = a < b ? `${a}:${b}` : `${b}:${a}`;
      const e = seen.get(id);
      if (e) e[2]++;
      else seen.set(id, [a, b, 1]);
    }
  return [...seen.values()].filter((e) => e[2] === 1).map((e) => [e[0], e[1]]);
}

// ---------------------------------------------------------------- material

/** Soft woven twill bump (grey, tileable): cheap, no canvas (works headless). */
export function createFabricBump(size = 64): DataTexture {
  const data = new Uint8Array(size * size);
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const twill = ((x + y) % 4 < 2 ? 1 : 0) * 0.35; // diagonal twill rib
      const noise = rnd() * 0.35;
      data[y * size + x] = Math.round(255 * Math.min(1, 0.3 + twill + noise));
    }
  const texture = new DataTexture(data, size, size, RedFormat);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Matte cotton: rough, no metal, no clearcoat; the bump only breaks up flat shading. */
export function createTrousersMaterial(colour = DEFAULT_TROUSERS_COLOUR): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: colour,
    roughness: 0.94,
    metalness: 0,
    bumpMap: createFabricBump(),
    bumpScale: 0.35,
    envMapIntensity: 0.35,
  });
}

// ---------------------------------------------------------------- the meshes

function buildGeometry(data: TrousersData): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(data.restPositions.slice(), 3));
  g.setAttribute(
    'normal',
    new Float32BufferAttribute(new Float32Array(data.restPositions.length), 3),
  );
  g.setAttribute('uv', new Float32BufferAttribute(data.uv, 2));
  g.setIndex(new BufferAttribute(data.indices, 1));
  return g;
}

/**
 * Trousers on a CPU-skinned body (a plain Mesh whose buffers move with the pose). Call
 * `syncFromBody(bodyMesh)` after the body was posed (cheap; skips an unchanged body), or `sync()`
 * with the live arrays (LiveAvatar.bodyArrays()).
 */
export class Trousers extends Mesh<BufferGeometry, MeshStandardMaterial> {
  readonly data: TrousersData;
  private lastVersion = -1;
  private readonly ownsMaterial: boolean;

  constructor(data: TrousersData, material?: MeshStandardMaterial) {
    super(buildGeometry(data), material ?? createTrousersMaterial());
    this.ownsMaterial = !material;
    this.data = data;
    this.name = 'trousers';
    this.castShadow = this.receiveShadow = true;
    this.frustumCulled = false;
  }

  /** Re-places every vertex on the posed body (see placeTrousers). */
  sync(positions: ArrayLike<number>, normals: ArrayLike<number>) {
    const out = this.geometry.getAttribute('position') as BufferAttribute;
    const nrm = this.geometry.getAttribute('normal') as BufferAttribute;
    placeTrousers(
      this.data,
      positions,
      normals,
      out.array as Float32Array,
      nrm.array as Float32Array,
    );
    out.needsUpdate = true;
    nrm.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  /** Follows a body Mesh (the kiosk body layer's mesh) when its position buffer changed. */
  syncFromBody(body: Mesh): boolean {
    const position = body.geometry.getAttribute('position') as BufferAttribute;
    const normal = body.geometry.getAttribute('normal') as BufferAttribute | undefined;
    if (!normal || position.version === this.lastVersion) return false;
    this.lastVersion = position.version;
    this.sync(position.array, normal.array);
    return true;
  }

  dispose() {
    this.geometry.dispose();
    if (this.ownsMaterial) {
      this.material.bumpMap?.dispose();
      this.material.dispose();
    }
  }
}

/** Trousers for a plain (CPU-skinned) body Mesh whose REST geometry is `restPositions`/`faces`. */
export function createTrousersFromRest(
  restPositions: ArrayLike<number>,
  faces: ArrayLike<number>,
  opts: TrousersOptions,
): Trousers {
  const data = buildTrousersData(restPositions, faces, opts);
  return new Trousers(data, createTrousersMaterial(opts.colour));
}

function isSkinned(body: Object3D): body is SkinnedMesh {
  return (body as SkinnedMesh).isSkinnedMesh === true;
}

/**
 * Contract entry (TrousersFactory). A THREE.SkinnedMesh body gives a SkinnedMesh bound to
 * `body.skeleton` with the body's bind matrix and the same skin indices/weights, so it follows any
 * skeleton pose. The Fit Lab's own CPU-skinned body is a plain Mesh: use `createTrousersFromRest`
 * (rest positions from the rig) and `syncFromBody` instead.
 */
export function createTrousers(
  body: SkinnedMesh,
  opts: { hipY: number; ankleY: number; kneeY?: number; colour?: number },
): SkinnedMesh {
  if (!isSkinned(body)) throw new Error('createTrousers needs a SkinnedMesh body');
  const geometry = body.geometry;
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  if (!index || !skinIndex || !skinWeight)
    throw new Error('createTrousers: the body needs an index and skinIndex/skinWeight attributes');
  const data = buildTrousersData(position.array as ArrayLike<number>, index.array, opts);
  const g = buildGeometry(data);
  // Rest normals for lighting (the skinned shader rotates them with the bones).
  const normal = g.getAttribute('normal') as BufferAttribute;
  const bodyNormals = new Float32Array(position.count * 3);
  smoothNormals(position.array as ArrayLike<number>, index.array, bodyNormals);
  const nearest = (i: number) => (data.blend[i] < 0.5 ? data.sourceIndex[i] : data.sourceIndexB[i]);
  for (let i = 0; i < data.sourceIndex.length; i++)
    for (let a = 0; a < 3; a++) normal.array[i * 3 + a] = bodyNormals[nearest(i) * 3 + a];
  const size = skinIndex.itemSize;
  const idx = new Uint16Array(data.sourceIndex.length * size);
  const wgt = new Float32Array(data.sourceIndex.length * size);
  for (let i = 0; i < data.sourceIndex.length; i++)
    for (let k = 0; k < size; k++) {
      idx[i * size + k] = skinIndex.getComponent(nearest(i), k);
      wgt[i * size + k] = skinWeight.getComponent(nearest(i), k);
    }
  g.setAttribute('skinIndex', new Uint16BufferAttribute(idx, size));
  g.setAttribute('skinWeight', new Float32BufferAttribute(wgt, size));
  const mesh = new SkinnedMesh(g, createTrousersMaterial(opts.colour));
  mesh.name = 'trousers';
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.bind(body.skeleton, body.bindMatrix);
  return mesh;
}

/** The contract object (for FL's wiring). */
export const trousersFactory: TrousersFactory = { create: createTrousers };
