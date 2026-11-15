// Collisions of the live dynamics against the posed body. Nothing may sink into the body, and a
// collision never moves a particle deeper than its own skinned target (the target is the shape
// the preview already shows; LBS may put a few targets inside the body, which is not the
// deformer's to fix or to worsen).
//   Body: per moving particle, a few body vertices chosen at bind (its nearest ones plus ones
//   spread over the region it can reach); each frame the closest one gives the local tangent
//   plane (posed position + normal). Floor: the cloth mid-surface stays at least the asset's
//   layer + collision margin outside it, or as deep as its target, whichever is less; never more
//   than its inward allowance below its target.
//   Arms (torso and hood particles only): capsules upper arm, forearm and hand from the posed
//   joints, radius = the sleeve's own radius around each segment (measured on the jacket) plus
//   the cloth layer, so the hem never swings through a hanging sleeve.
// Pure numeric code (no allocation per frame).
import { DYNAMICS } from './config.ts';
import { DenseGrid } from './graph.ts';
import { BODY_ARM_L, BODY_ARM_R, BODY_TRUNK, type DeformBody } from './types.ts';
import { KIND_SLEEVE_L, KIND_SLEEVE_R } from './maxDistance.ts';

export const ANCHORS = DYNAMICS.anchorsNear + DYNAMICS.anchorsSpread;

/** (moving · ANCHORS) body vertex candidates per moving particle. */
export function bodyAnchors(
  bound: ArrayLike<number>,
  moving: ArrayLike<number>,
  kind: ArrayLike<number>,
  maxDist: ArrayLike<number>,
  body: DeformBody,
): Uint32Array {
  const V = body.neutral.length / 3;
  const grid = (flag: number) => {
    const ids: number[] = [];
    for (let v = 0; v < V; v++) if (body.regions[v] & flag) ids.push(v);
    return new DenseGrid(body.neutral, ids, 0.02);
  };
  const ids = new Int32Array(8);
  const grids = { trunk: grid(BODY_TRUNK), L: grid(BODY_ARM_L), R: grid(BODY_ARM_R) };
  const out = new Uint32Array(moving.length * ANCHORS);
  const P = body.neutral;
  for (let m = 0; m < moving.length; m++) {
    const i = moving[m];
    const g =
      kind[i] === KIND_SLEEVE_L ? grids.L : kind[i] === KIND_SLEEVE_R ? grids.R : grids.trunk;
    const x = bound[i * 3],
      y = bound[i * 3 + 1],
      z = bound[i * 3 + 2];
    const found = g.nearest(x, y, z, DYNAMICS.anchorsNear, ids);
    if (!found) throw new Error('Dynamics: no body skin near a moving cloth particle');
    const chosen = Array.from(ids.subarray(0, found));
    if (g !== grids.trunk) {
      // A sleeve also keeps out of the trunk beside it (LBS sinks a hanging sleeve into the hip;
      // measured: sleeve particles taken deeper into the trunk without these).
      const t = grids.trunk.nearest(x, y, z, DYNAMICS.anchorsSpread, ids);
      for (let k = 0; k < t; k++) chosen.push(ids[k]);
      for (let k = 0; k < ANCHORS; k++) out[m * ANCHORS + k] = chosen[k % chosen.length];
      continue;
    }
    // Spread: the skin nearest to points around the closest one, in its tangent plane, out to
    // where the particle can reach (its max distance + anchorReachM).
    const c = chosen[0] * 3;
    let nx = x - P[c],
      ny = y - P[c + 1],
      nz = z - P[c + 2];
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    // t1 = n × up (or n × x when n is vertical), t2 = n × t1.
    let ax = 0,
      ay = 1,
      az = 0;
    if (Math.abs(ny) > 0.9) {
      ax = 1;
      ay = 0;
    }
    let t1x = ny * az - nz * ay,
      t1y = nz * ax - nx * az,
      t1z = nx * ay - ny * ax;
    const tl = Math.hypot(t1x, t1y, t1z) || 1;
    t1x /= tl;
    t1y /= tl;
    t1z /= tl;
    const t2x = ny * t1z - nz * t1y,
      t2y = nz * t1x - nx * t1z,
      t2z = nx * t1y - ny * t1x;
    const reach = 0.6 * (maxDist[i] + DYNAMICS.anchorReachM);
    for (const [a, b] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].slice(0, DYNAMICS.anchorsSpread)) {
      const q = g.nearest(
        P[c] + reach * (a * t1x + b * t2x),
        P[c + 1] + reach * (a * t1y + b * t2y),
        P[c + 2] + reach * (a * t1z + b * t2z),
        1,
        ids,
      );
      if (q) chosen.push(ids[0]);
    }
    for (let k = 0; k < ANCHORS; k++) out[m * ANCHORS + k] = chosen[k % chosen.length];
  }
  return out;
}

/**
 * Arm and hand skin of the posed body, hashed per frame (Teschner et al. 2003 spatial hashing),
 * for the torso and hood particles that come near an arm: a hand is flat, not a capsule.
 */
export class SkinGrid {
  private head: Int32Array;
  private next: Int32Array;
  private mask: number;
  /** Cell size; a query searches the 27 cells around the point, so it sees every vertex
   * within one cell (3 cm) of it. */
  readonly cell = 0.03;
  constructor(readonly ids: Uint32Array) {
    let size = 1;
    while (size < ids.length * 2) size *= 2;
    this.mask = size - 1;
    this.head = new Int32Array(size);
    this.next = new Int32Array(ids.length);
  }
  private hash(ix: number, iy: number, iz: number) {
    return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & this.mask;
  }
  update(positions: ArrayLike<number>) {
    this.head.fill(-1);
    const c = this.cell;
    for (let k = 0; k < this.ids.length; k++) {
      const v = this.ids[k] * 3;
      const h = this.hash(
        Math.floor(positions[v] / c),
        Math.floor(positions[v + 1] / c),
        Math.floor(positions[v + 2] / c),
      );
      this.next[k] = this.head[h];
      this.head[h] = k;
    }
  }
  /** The nearest hashed vertex (x3 offset) within one cell of (x, y, z), or -1 (none that near). */
  nearest(x: number, y: number, z: number, positions: ArrayLike<number>): number {
    const c = this.cell;
    const cx = Math.floor(x / c),
      cy = Math.floor(y / c),
      cz = Math.floor(z / c);
    let best = -1,
      bestD = Infinity;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (let l = -1; l <= 1; l++)
          for (let k = this.head[this.hash(cx + i, cy + j, cz + l)]; k >= 0; k = this.next[k]) {
            const v = this.ids[k] * 3;
            const d = (positions[v] - x) ** 2 + (positions[v + 1] - y) ** 2 + (positions[v + 2] - z) ** 2;
            if (d < bestD) {
              bestD = d;
              best = v;
            }
          }
    return bestD <= c * c ? best : -1;
  }
}

/** Capsules (a, b, radius, then the box min/max expanded by the radius): 13 numbers each. */
export const CAPSULE_STRIDE = 13;

function boxCapsule(out: Float64Array, c: number) {
  const o = c * CAPSULE_STRIDE,
    rad = out[o + 6];
  for (let a = 0; a < 3; a++) {
    out[o + 7 + a] = Math.min(out[o + a], out[o + 3 + a]) - rad;
    out[o + 10 + a] = Math.max(out[o + a], out[o + 3 + a]) + rad;
  }
}
const ARM_JOINTS = [
  ['upperarm01.L', 'lowerarm01.L'],
  ['lowerarm01.L', 'wrist.L'],
  ['upperarm01.R', 'lowerarm01.R'],
  ['lowerarm01.R', 'wrist.R'],
] as const;

/**
 * The arm capsules of this frame: upper arm and forearm per side (joint to joint) and a hand
 * capsule beyond the wrist along the forearm. Radii: `radii` (4 sleeve segments, m); the hand's is
 * DYNAMICS.handRadiusM. Returns the capsule count written into `out` (0 without joints).
 */
export function armCapsules(
  joints: Record<string, [number, number, number]>,
  radii: ArrayLike<number>,
  out: Float64Array,
): number {
  let c = 0;
  for (let s = 0; s < 4; s++) {
    const a = joints[ARM_JOINTS[s][0]],
      b = joints[ARM_JOINTS[s][1]];
    if (!a || !b) return 0;
    out.set([a[0], a[1], a[2], b[0], b[1], b[2], radii[s]], c * CAPSULE_STRIDE);
    boxCapsule(out, c++);
    if (s === 1 || s === 3) {
      // Hand: from the wrist along the forearm.
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
      const k = DYNAMICS.handLengthM / len;
      out.set(
        [
          b[0],
          b[1],
          b[2],
          b[0] + (b[0] - a[0]) * k,
          b[1] + (b[1] - a[1]) * k,
          b[2] + (b[2] - a[2]) * k,
          DYNAMICS.handRadiusM,
        ],
        c * CAPSULE_STRIDE,
      );
      boxCapsule(out, c++);
    }
  }
  return c;
}

/** Signed distance of (x, y, z) to capsule c (negative inside), and the outward unit vector. */
function capsuleDistance(cap: Float64Array, c: number, x: number, y: number, z: number, n: Float64Array) {
  const o = c * CAPSULE_STRIDE;
  const ax = cap[o],
    ay = cap[o + 1],
    az = cap[o + 2];
  const bx = cap[o + 3] - ax,
    by = cap[o + 4] - ay,
    bz = cap[o + 5] - az;
  const len2 = bx * bx + by * by + bz * bz;
  let t = len2 > 0 ? ((x - ax) * bx + (y - ay) * by + (z - az) * bz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = x - (ax + bx * t),
    dy = y - (ay + by * t),
    dz = z - (az + bz * t);
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d > 1e-9) {
    n[0] = dx / d;
    n[1] = dy / d;
    n[2] = dz / d;
  } else {
    n[0] = 0;
    n[1] = 0;
    n[2] = 1;
  }
  return d - cap[o + 6];
}

const nScratch = new Float64Array(3);

/**
 * Inside the box of any capsule grown by `margin` (near an arm or hand: a hand is wider than its
 * capsule; measured a target 4.6 mm from a thumb vertex outside the hand capsule's own box).
 */
function inAnyBox(cap: Float64Array, count: number, x: number, y: number, z: number, margin: number) {
  for (let c = 0; c < count; c++) {
    const o = c * CAPSULE_STRIDE;
    if (
      x >= cap[o + 7] - margin &&
      y >= cap[o + 8] - margin &&
      z >= cap[o + 9] - margin &&
      x <= cap[o + 10] + margin &&
      y <= cap[o + 11] + margin &&
      z <= cap[o + 12] + margin
    )
      return true;
  }
  return false;
}

/** armCapsules order: upper L, fore L, hand L, upper R, fore R, hand R. */
const HAND_L = 2,
  HAND_R = 5;

/** Which capsule rule a particle uses (collide `mode`). */
export const CAPSULES_NONE = 0;
/** Torso and hood: outside every arm capsule (sleeve radius), never deeper than the target. */
export const CAPSULES_ARMS = 1;
/** A sleeve: never closer to its own arm's bones than its target (left 2, right 3). */
export const CAPSULES_OWN_L = 2;
export const CAPSULES_OWN_R = 3;

/** Distance from (x, y, z) to capsule c's segment (radius ignored) and the unit direction. */
function axisDistance(cap: Float64Array, c: number, x: number, y: number, z: number, n: Float64Array) {
  const o = c * CAPSULE_STRIDE;
  const ax = cap[o],
    ay = cap[o + 1],
    az = cap[o + 2];
  const bx = cap[o + 3] - ax,
    by = cap[o + 4] - ay,
    bz = cap[o + 5] - az;
  const len2 = bx * bx + by * by + bz * bz;
  let t = len2 > 0 ? ((x - ax) * bx + (y - ay) * by + (z - az) * bz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = x - (ax + bx * t),
    dy = y - (ay + by * t),
    dz = z - (az + bz * t);
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d > 1e-9) {
    n[0] = dx / d;
    n[1] = dy / d;
    n[2] = dz / d;
  } else {
    n[0] = 0;
    n[1] = 0;
    n[2] = 1;
  }
  return d;
}

/**
 * Projects p (in `p` at offset o) out of the body and out of the arm capsules (`mode`, when this
 * frame has capsules: capsuleCount > 0); t is its skinned target (same frame). Returns how far it
 * moved (m).
 */
export function collide(
  p: Float64Array | Float32Array,
  o: number,
  tx: number,
  ty: number,
  tz: number,
  anchors: Uint32Array,
  anchorBase: number,
  bodyPositions: ArrayLike<number>,
  bodyNormals: ArrayLike<number>,
  clearance: number,
  inward: number,
  capsules: Float64Array,
  capsuleCount: number,
  mode: number = CAPSULES_ARMS,
  armSkin: SkinGrid | null = null,
  trunkSkin: SkinGrid | null = null,
): number {
  let x = p[o],
    y = p[o + 1],
    z = p[o + 2];
  const x0 = x,
    y0 = y,
    z0 = z;
  // Contact budget (exact, by the triangle inequality): near skin that moves on its own (an arm
  // or hand beside the torso; the trunk beside a sleeve) a particle may leave its target by at
  // most the target's distance to that skin minus the clearance and the vertex spacing, so it
  // can never reach it. A hand resting on the jacket holds the cloth there.
  let budget = Infinity;
  // (No vertex within a cell of the target: the skin is at least a cell away, a safe bound.)
  if (
    mode === CAPSULES_ARMS &&
    armSkin &&
    (inAnyBox(capsules, capsuleCount, tx, ty, tz, DYNAMICS.armBoxMarginM) ||
      inAnyBox(capsules, capsuleCount, x, y, z, DYNAMICS.armBoxMarginM))
  ) {
    const v = armSkin.nearest(tx, ty, tz, bodyPositions);
    budget =
      v >= 0
        ? Math.hypot(tx - bodyPositions[v], ty - bodyPositions[v + 1], tz - bodyPositions[v + 2])
        : armSkin.cell;
  } else if ((mode === CAPSULES_OWN_L || mode === CAPSULES_OWN_R) && trunkSkin) {
    const v = trunkSkin.nearest(tx, ty, tz, bodyPositions);
    budget =
      v >= 0
        ? Math.hypot(tx - bodyPositions[v], ty - bodyPositions[v + 1], tz - bodyPositions[v + 2])
        : trunkSkin.cell;
  }
  if (budget < Infinity) {
    budget = Math.max(0, budget - clearance - DYNAMICS.skinVertexSpacingM);
    const dx = x - tx,
      dy = y - ty,
      dz = z - tz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len > budget) {
      const k = len > 0 ? budget / len : 0;
      x = tx + dx * k;
      y = ty + dy * k;
      z = tz + dz * k;
    }
  }
  if (capsuleCount && (mode === CAPSULES_OWN_L || mode === CAPSULES_OWN_R)) {
    // A sleeve may slide round and along its arm, never toward its bones past its target (a
    // tangent plane cannot say "deeper" once LBS has sunk a cuff into a bent forearm: measured
    // 10 mm deeper than the target before this rule).
    const first = mode === CAPSULES_OWN_L ? 0 : 3;
    for (let c = first; c < first + 3; c++) {
      const dT = axisDistance(capsules, c, tx, ty, tz, nScratch);
      const dP = axisDistance(capsules, c, x, y, z, nScratch);
      if (dP < dT) {
        x += (dT - dP) * nScratch[0];
        y += (dT - dP) * nScratch[1];
        z += (dT - dP) * nScratch[2];
      }
    }
  }
  for (let c = 0; mode === CAPSULES_ARMS && c < capsuleCount; c++) {
    // Outside the capsule's box: outside the capsule, so never below its floor (exact skip).
    const o = c * CAPSULE_STRIDE;
    if (
      x < capsules[o + 7] ||
      y < capsules[o + 8] ||
      z < capsules[o + 9] ||
      x > capsules[o + 10] ||
      y > capsules[o + 11] ||
      z > capsules[o + 12]
    )
      continue;
    // The hand capsule only marks where the contact budget applies: no sleeve covers a hand.
    if (c === HAND_L || c === HAND_R) continue;
    const sT = capsuleDistance(capsules, c, tx, ty, tz, nScratch);
    const floor = Math.min(sT, 0);
    const s = capsuleDistance(capsules, c, x, y, z, nScratch);
    if (s < floor) {
      x += (floor - s) * nScratch[0];
      y += (floor - s) * nScratch[1];
      z += (floor - s) * nScratch[2];
    }
  }
  // The body plane last: penetration is measured against the body, the capsules are only the
  // sleeves' volume (a forearm resting on the back overlaps the trunk).
  // Body: the closest candidate's tangent plane, among the candidates that face the target (on a
  // thin limb the spread candidates wrap round to the far side, whose plane protects nothing:
  // measured 21 mm deep at a bent wrist before this rule).
  let best = -1,
    bestD = Infinity,
    any = -1,
    anyD = Infinity;
  for (let k = 0; k < ANCHORS; k++) {
    const v = anchors[anchorBase + k] * 3;
    const bx = bodyPositions[v],
      by = bodyPositions[v + 1],
      bz = bodyPositions[v + 2];
    const d = (x - bx) ** 2 + (y - by) ** 2 + (z - bz) ** 2;
    if (d < anyD) {
      anyD = d;
      any = v;
    }
    if (d >= bestD) continue;
    const facing =
      (tx - bx) * bodyNormals[v] + (ty - by) * bodyNormals[v + 1] + (tz - bz) * bodyNormals[v + 2];
    if (facing < -DYNAMICS.anchorFacingM) continue;
    bestD = d;
    best = v;
  }
  if (best < 0) best = any;
  if (best >= 0) {
    const bx = bodyPositions[best],
      by = bodyPositions[best + 1],
      bz = bodyPositions[best + 2];
    const nx = bodyNormals[best],
      ny = bodyNormals[best + 1],
      nz = bodyNormals[best + 2];
    const s = (x - bx) * nx + (y - by) * ny + (z - bz) * nz;
    const sT = (tx - bx) * nx + (ty - by) * ny + (tz - bz) * nz;
    const floor = Math.max(Math.min(sT, clearance), sT - inward);
    if (s < floor) {
      x += (floor - s) * nx;
      y += (floor - s) * ny;
      z += (floor - s) * nz;
    }
  }
  p[o] = x;
  p[o + 1] = y;
  p[o + 2] = z;
  return Math.hypot(x - x0, y - y0, z - z0);
}

/**
 * Sleeve radius around each arm segment (upper L, fore L, upper R, fore R), measured on the
 * skinned jacket of this frame: the median distance of the sleeve's particles that project onto
 * the middle of the segment. NaN where it cannot be measured.
 */
export function sleeveRadii(
  positions: ArrayLike<number>,
  kind: ArrayLike<number>,
  joints: Record<string, [number, number, number]>,
): Float64Array {
  const out = new Float64Array(4).fill(NaN);
  for (let s = 0; s < 4; s++) {
    const a = joints[ARM_JOINTS[s][0]],
      b = joints[ARM_JOINTS[s][1]];
    if (!a || !b) continue;
    const want = s < 2 ? KIND_SLEEVE_L : KIND_SLEEVE_R;
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    if (!(len2 > 0)) continue;
    const d: number[] = [];
    for (let i = 0; i < kind.length; i++) {
      if (kind[i] !== want) continue;
      const px = positions[i * 3] - a[0],
        py = positions[i * 3 + 1] - a[1],
        pz = positions[i * 3 + 2] - a[2];
      const t = (px * ab[0] + py * ab[1] + pz * ab[2]) / len2;
      if (t < 0.25 || t > 0.75) continue;
      d.push(Math.hypot(px - ab[0] * t, py - ab[1] * t, pz - ab[2] * t));
    }
    if (d.length < 8) continue;
    d.sort((x, y) => x - y);
    out[s] = d[d.length >> 1];
  }
  return out;
}
