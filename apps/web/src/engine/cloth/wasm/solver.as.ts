/* eslint-disable @typescript-eslint/ban-ts-comment, prefer-const */
// @ts-nocheck -- AssemblyScript source (f64/i32/usize, load/store builtins), not TypeScript:
// compiled by build.mjs with the pinned `assemblyscript` devDependency into solverWasm.ts.
//
// Bit-identical WebAssembly ports of ClothSolver's full-mesh small-steps loops (motion bakes
// only; the hand pull never uses them). Every function mirrors the JS method named in its
// comment expression by expression, in the same evaluation order:
//  - f64 + - * / and sqrt are IEEE-754 correctly rounded in both JS and WebAssembly, so the
//    same operations in the same order give the same bits (no FMA: SIMD is off, and the
//    compiler never reassociates floats);
//  - Math.max/min/abs/floor/sqrt compile to f64.max/min/abs/floor/sqrt, which have the JS
//    semantics (NaN propagates, max(-0, +0) = +0);
//  - JS `!x` on a number is true for 0, -0 and NaN: written out as `x == 0 || x != x`;
//  - iteration order and tie-breaking are the JS ones.
// Typed arrays live in this module's linear memory; kernels.ts gives the solver views on them
// and sets the pointers below (exported mutable globals), so nothing is copied per substep.

// ---- Particles (n) -------------------------------------------------------------------------
export let P: usize = 0; // positions f64[3n]
export let PREV: usize = 0; // previous f64[3n]
export let V: usize = 0; // velocity f64[3n]
export let W: usize = 0; // inverse mass f64[n]
export let NORMAL: usize = 0; // contactNormals f64[3n]
export let DEPTH: usize = 0; // contactDepth f64[n]
export let BEFORE: usize = 0; // limitAfterContact scratch f64[3n]
export let PSTAMP: usize = 0; // planeStamp i32[n]
export let PVEL: usize = 0; // planeVelocity f64[3n]
export let PANEL: usize = 0; // panels i32[n]
export let SV: usize = 0; // surfaceVelocity f64[3] (written by the `surface` import)
// ---- Edges (E) -----------------------------------------------------------------------------
export let EDGE: usize = 0; // edges u32[2E]
export let REST: usize = 0; // restLengths f64[E]
export let ELAMBDA: usize = 0; // edgeLambda f64[E]
export let ECOMP: usize = 0; // edgeCompliance f64[E]
export let ELIMIT: usize = 0; // edgeLimit f64[E]
export let EQUEUE: usize = 0; // limitAllEdges scratch i32[E]
export let HOT: usize = 0; // hotEdges i32[E], first hotCount used
export let hotCount: i32 = 0;
// ---- Hinges (H), tethers (T), supports (S), roots (R) ----------------------------------------
export let HINGE: usize = 0; // u32[2H]
export let HREST: usize = 0; // f64[H]
export let HLAMBDA: usize = 0; // f64[H]
export let SUPPORT: usize = 0; // u32[2S]
export let SLEN: usize = 0; // f64[S]
export let TETHER: usize = 0; // u32[2T]
export let TLEN: usize = 0; // f64[T]
export let TINIT: usize = 0; // f64[T]
export let ROOT: usize = 0; // u32[R]
export let RANCHOR: usize = 0; // f64[3R]
// ---- Particle self-contact (selfCollide) -----------------------------------------------------
export let MASK: usize = 0; // collisionMasks i32[8]
export let CCOUNT: usize = 0; // i32[65536]
export let CSTART: usize = 0; // i32[65537]
export let CCURSOR: usize = 0; // i32[65536]
export let CENTRY: usize = 0; // i32[n]
export let CKEY: usize = 0; // i32[n]
export let CX: usize = 0; // i32[n]
export let CY: usize = 0; // i32[n]
export let CZ: usize = 0; // i32[n]
export let EXOFF: usize = 0; // excludedOffsets i32[n + 1]
export let EXID: usize = 0; // excludedIds i32[*]
// ---- Body contact (contact) ------------------------------------------------------------------
export let SLACK: usize = 0; // contactSlack f64[n]
export let ANCHOR: usize = 0; // contactAnchor f64[3n]
export let LAYER: usize = 0; // layerOffset f64[n]
export let LOFT: usize = 0; // loft f64[n]
export let ELASTIC: usize = 0; // elastic f64[n]
export let PLANE: usize = 0; // planeData f64[8n]
export let GRAD: usize = 0; // gradient f64[3] (written by the `distance` import)
// ---- Cloth-on-cloth layer pairs (layerContact, rebuildLayerPairs) ----------------------------
export let LPA: usize = 0; // layerPairA i32[cap]
export let LPB: usize = 0; // layerPairB i32[cap]
export let LPT: usize = 0; // layerPairTriangle i32[3 cap]
export let LPS: usize = 0; // layerPairSide f64[cap]
export let LPG: usize = 0; // layerPairGap f64[cap]
export let pairCount: i32 = 0;
export let TRI: usize = 0; // asset triangles i32[3T]
export let TGROUP: usize = 0; // per-triangle layer group i32[T]
export let TKEYS: usize = 0; // open-addressed cell table i32[size]
export let TUSED: usize = 0; // i32[size]
export let TBUCKET: usize = 0; // i32[size]
export let BSTART: usize = 0; // i32[3T + 1]
export let BCURSOR: usize = 0; // i32[3T + 1]
export let BENTRY: usize = 0; // i32[3T]
export let EKEY: usize = 0; // i32[3T]
export let ETRI: usize = 0; // i32[3T]
export let TSTAMP: usize = 0; // i32[T]
export let BESTD: usize = 0; // f64[perSource]
export let BESTT: usize = 0; // i32[perSource]
export let BESTS: usize = 0; // f64[perSource]
let pairEpoch: i32 = 0;
let pairQuery: i32 = 0;

// Body surface velocity at (x, y, z) into SV[0..2] (collider.surfaceVelocity, kernels.ts).
declare function surface(x: f64, y: f64, z: f64): void;
// Body signed distance at (x, y, z); writes GRAD when below threshold (collider.distance).
declare function distance(x: f64, y: f64, z: f64, threshold: f64): f64;

function lf(base: usize, i: i32): f64 {
  return load<f64>(base + ((<usize>i) << 3));
}
function sf(base: usize, i: i32, v: f64): void {
  store<f64>(base + ((<usize>i) << 3), v);
}
function li(base: usize, i: i32): i32 {
  return load<i32>(base + ((<usize>i) << 2));
}
function si(base: usize, i: i32, v: i32): void {
  store<i32>(base + ((<usize>i) << 2), v);
}
/** JS `!x` for a number. */
function falsy(x: f64): bool {
  return x == 0 || x != x;
}

/** stepSmall, start of a full-mesh substep: prev.set(p), then gravity and prediction. */
export function integrate(n: i32, gh: f64, h: f64): void {
  memory.copy(PREV, P, <usize>n * 24);
  for (let i = 0; i < n; i++) {
    if (falsy(lf(W, i))) continue;
    const k = i * 3;
    sf(V, k + 1, lf(V, k + 1) + gh);
    sf(P, k, lf(P, k) + lf(V, k) * h);
    sf(P, k + 1, lf(P, k + 1) + lf(V, k + 1) * h);
    sf(P, k + 2, lf(P, k + 2) + lf(V, k + 2) * h);
  }
}

/** stepSmall: edgeLambda.fill(0), hingeLambda.fill(0). */
export function resetLambdas(edges: i32, hinges: i32): void {
  memory.fill(ELAMBDA, 0, (<usize>edges) << 3);
  memory.fill(HLAMBDA, 0, (<usize>hinges) << 3);
}

/** ClothSolver.stretch(h, reverse) over every edge (no region list). */
export function stretch(count: i32, inverseH2: f64, reverse: bool, neutral: bool): void {
  const p = P,
    w = W,
    edges = EDGE,
    rests = REST,
    lambdas = ELAMBDA,
    compliances = ECOMP,
    limits = ELIMIT;
  for (let slot = 0; slot < count; slot++) {
    const e = reverse ? count - 1 - slot : slot,
      eo = (<usize>e) << 3,
      ai = load<u32>(edges + eo),
      bi = load<u32>(edges + eo, 4),
      pa = p + <usize>ai * 24,
      pb = p + <usize>bi * 24;
    const ax = load<f64>(pa),
      ay = load<f64>(pa, 8),
      az = load<f64>(pa, 16),
      bx = load<f64>(pb),
      by = load<f64>(pb, 8),
      bz = load<f64>(pb, 16);
    const dx = ax - bx,
      dy = ay - by,
      dz = az - bz;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 1e-12) continue;
    const rest = load<f64>(rests + eo);
    if (neutral && length <= rest) {
      store<f64>(lambdas + eo, 0);
      continue;
    }
    const alpha: f64 =
      length > load<f64>(limits + eo) ? 0 : load<f64>(compliances + eo) * inverseH2;
    const wa = load<f64>(w + ((<usize>ai) << 3)),
      wb = load<f64>(w + ((<usize>bi) << 3)),
      den = wa + wb + alpha;
    if (falsy(den)) continue;
    const previous = load<f64>(lambdas + eo),
      lambda = (rest - length - alpha * previous) / den;
    store<f64>(lambdas + eo, previous + lambda);
    const scale = lambda / length;
    store<f64>(pa, ax + wa * scale * dx);
    store<f64>(pa, ay + wa * scale * dy, 8);
    store<f64>(pa, az + wa * scale * dz, 16);
    store<f64>(pb, bx - wb * scale * dx);
    store<f64>(pb, by - wb * scale * dy, 8);
    store<f64>(pb, bz - wb * scale * dz, 16);
  }
}

/** ClothSolver.hingeBend(h) over every hinge; alpha = hingeCompliance / h². */
export function hinge(count: i32, alpha: f64): void {
  const p = P,
    w = W,
    hinges = HINGE,
    rests = HREST,
    lambdas = HLAMBDA;
  for (let e = 0; e < count; e++) {
    const eo = (<usize>e) << 3,
      ai = load<u32>(hinges + eo),
      bi = load<u32>(hinges + eo, 4),
      pa = p + <usize>ai * 24,
      pb = p + <usize>bi * 24;
    const ax = load<f64>(pa),
      ay = load<f64>(pa, 8),
      az = load<f64>(pa, 16),
      bx = load<f64>(pb),
      by = load<f64>(pb, 8),
      bz = load<f64>(pb, 16);
    const dx = ax - bx,
      dy = ay - by,
      dz = az - bz;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 1e-12) continue;
    const wa = load<f64>(w + ((<usize>ai) << 3)),
      wb = load<f64>(w + ((<usize>bi) << 3)),
      den = wa + wb + alpha;
    if (falsy(den)) continue;
    const previous = load<f64>(lambdas + eo),
      lambda = (-(length - load<f64>(rests + eo)) - alpha * previous) / den;
    store<f64>(lambdas + eo, previous + lambda);
    const scale = lambda / length;
    store<f64>(pa, ax + wa * scale * dx);
    store<f64>(pa, ay + wa * scale * dy, 8);
    store<f64>(pa, az + wa * scale * dz, 16);
    store<f64>(pb, bx - wb * scale * dx);
    store<f64>(pb, by - wb * scale * dy, 8);
    store<f64>(pb, bz - wb * scale * dz, 16);
  }
}

/**
 * ClothSolver.limitTethers(h) without a region list: collar supports, root anchors (when
 * `anchored`, beta = rootCompliance / h²) and tethers (alpha = supportCompliance / h² or 0).
 */
export function tethers(
  supports: i32,
  roots: i32,
  count: i32,
  max: f64,
  neutral: bool,
  collarCompression: f64,
  anchored: bool,
  beta: f64,
  liftFree: bool,
  alpha: f64,
  oneWay: bool,
): void {
  for (let e = 0; e < supports; e++) {
    const ai = li(SUPPORT, e * 2),
      bi = li(SUPPORT, e * 2 + 1),
      a = ai * 3,
      b = bi * 3;
    const dx = lf(P, b) - lf(P, a),
      dy = lf(P, b + 1) - lf(P, a + 1),
      dz = lf(P, b + 2) - lf(P, a + 2),
      length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const high = lf(SLEN, e) * max;
    const low: f64 = neutral ? 0 : lf(SLEN, e) * collarCompression;
    if (length < 1e-12) continue;
    const bound = Math.max(low, Math.min(high, length));
    if (length == bound) continue;
    const wa = lf(W, ai),
      wb = lf(W, bi),
      den = wa + wb;
    if (falsy(den)) continue;
    const scale = (length - bound) / (length * den);
    sf(P, a, lf(P, a) + dx * scale * wa);
    sf(P, a + 1, lf(P, a + 1) + dy * scale * wa);
    sf(P, a + 2, lf(P, a + 2) + dz * scale * wa);
    sf(P, b, lf(P, b) - dx * scale * wb);
    sf(P, b + 1, lf(P, b + 1) - dy * scale * wb);
    sf(P, b + 2, lf(P, b + 2) - dz * scale * wb);
  }
  if (anchored)
    for (let r = 0; r < roots; r++) {
      const id = li(ROOT, r),
        w = lf(W, id);
      if (falsy(w)) continue;
      if (liftFree && lf(P, id * 3 + 1) > lf(RANCHOR, r * 3 + 1)) continue;
      const f = w / (w + beta),
        k = id * 3,
        q = r * 3;
      sf(P, k, lf(P, k) + (lf(RANCHOR, q) - lf(P, k)) * f);
      sf(P, k + 1, lf(P, k + 1) + (lf(RANCHOR, q + 1) - lf(P, k + 1)) * f);
      sf(P, k + 2, lf(P, k + 2) + (lf(RANCHOR, q + 2) - lf(P, k + 2)) * f);
    }
  for (let e = 0; e < count; e++) {
    const root = li(TETHER, e * 2),
      a = root * 3,
      id = li(TETHER, e * 2 + 1),
      b = id * 3,
      wb = lf(W, id);
    if (falsy(wb)) continue;
    const dx = lf(P, b) - lf(P, a),
      dy = lf(P, b + 1) - lf(P, a + 1),
      dz = lf(P, b + 2) - lf(P, a + 2),
      length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 1e-12) continue;
    let target = Math.min(length, lf(TLEN, e) * max);
    if (alpha > 0 && target > lf(TINIT, e)) target -= ((target - lf(TINIT, e)) * wb) / (wb + alpha);
    if (target >= length) continue;
    const wa: f64 = oneWay ? 0 : lf(W, root);
    const scale = (length - target) / (length * (wa + wb));
    sf(P, b, lf(P, b) - dx * scale * wb);
    sf(P, b + 1, lf(P, b + 1) - dy * scale * wb);
    sf(P, b + 2, lf(P, b + 2) - dz * scale * wb);
    sf(P, a, lf(P, a) + dx * scale * wa);
    sf(P, a + 1, lf(P, a + 1) + dy * scale * wa);
    sf(P, a + 2, lf(P, a + 2) + dz * scale * wa);
  }
}

/** ClothSolver.hashKey: x, y, z are integer cell coordinates (exact products, see build.mjs). */
function hashKey(x: i32, y: i32, z: i32): i32 {
  return ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) & 65535;
}
/** ClothSolver.excluded (binary search in the sorted two-hop neighbour list of i). */
function excluded(i: i32, j: i32): bool {
  let lo = li(EXOFF, i),
    hi = li(EXOFF, i + 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1,
      value = li(EXID, mid);
    if (value == j) return true;
    if (value < j) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** ClothSolver.selfCollide (cell = selfRadius × 2, invCell = 1 / cell, cell2 = cell²). */
export function selfCollide(n: i32, cell: f64, invCell: f64, cell2: f64): void {
  memory.fill(CCOUNT, 0, 65536 << 2);
  for (let i = 0; i < n; i++) {
    if (li(MASK, li(PANEL, i)) == 0) continue;
    const k = i * 3,
      x = <i32>Math.floor(lf(P, k) * invCell),
      y = <i32>Math.floor(lf(P, k + 1) * invCell),
      z = <i32>Math.floor(lf(P, k + 2) * invCell);
    si(CX, i, x);
    si(CY, i, y);
    si(CZ, i, z);
    const hash = hashKey(x, y, z);
    si(CKEY, i, hash);
    si(CCOUNT, hash, li(CCOUNT, hash) + 1);
  }
  si(CSTART, 0, 0);
  for (let i = 0; i < 65536; i++) {
    si(CSTART, i + 1, li(CSTART, i) + li(CCOUNT, i));
    si(CCURSOR, i, li(CSTART, i));
  }
  for (let i = 0; i < n; i++)
    if (li(MASK, li(PANEL, i)) != 0) {
      const key = li(CKEY, i),
        slot = li(CCURSOR, key);
      si(CCURSOR, key, slot + 1);
      si(CENTRY, slot, i);
    }
  for (let i = 0; i < n; i++) {
    const mask = li(MASK, li(PANEL, i));
    if (mask == 0) continue;
    const k = i * 3,
      x = li(CX, i),
      y = li(CY, i),
      z = li(CZ, i);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const cx = x + dx,
            cy = y + dy,
            cz = z + dz,
            key = hashKey(cx, cy, cz),
            end = li(CSTART, key + 1);
          for (let slot = li(CSTART, key); slot < end; slot++) {
            const j = li(CENTRY, slot);
            if (
              j <= i ||
              (mask & (1 << li(PANEL, j))) == 0 ||
              li(CX, j) != cx ||
              li(CY, j) != cy ||
              li(CZ, j) != cz
            )
              continue;
            const b = j * 3,
              ux = lf(P, k) - lf(P, b),
              uy = lf(P, k + 1) - lf(P, b + 1),
              uz = lf(P, k + 2) - lf(P, b + 2);
            const d2 = ux * ux + uy * uy + uz * uz;
            if (d2 >= cell2 || d2 < 1e-18) continue;
            if (excluded(i, j)) continue;
            const wa = lf(W, i),
              wb = lf(W, j),
              den = wa + wb;
            if (falsy(den)) continue;
            const dist = Math.sqrt(d2),
              scale = (cell - dist) / (dist * den);
            sf(P, k, lf(P, k) + ux * scale * wa);
            sf(P, k + 1, lf(P, k + 1) + uy * scale * wa);
            sf(P, k + 2, lf(P, k + 2) + uz * scale * wa);
            sf(P, b, lf(P, b) - ux * scale * wb);
            sf(P, b + 1, lf(P, b + 1) - uy * scale * wb);
            sf(P, b + 2, lf(P, b + 2) - uz * scale * wb);
          }
        }
  }
}

/**
 * Hard-projects edge e to its length limit (limitAllEdges' `project`, and limitHotEdges, which
 * computes the same with the length instead of its square); true when it moved something.
 */
function project(e: i32, squaredTest: bool): bool {
  const eo = (<usize>e) << 3,
    ai = load<u32>(EDGE + eo),
    bi = load<u32>(EDGE + eo, 4),
    pa = P + <usize>ai * 24,
    pb = P + <usize>bi * 24;
  const ax = load<f64>(pa),
    ay = load<f64>(pa, 8),
    az = load<f64>(pa, 16),
    bx = load<f64>(pb),
    by = load<f64>(pb, 8),
    bz = load<f64>(pb, 16);
  const dx = ax - bx,
    dy = ay - by,
    dz = az - bz,
    squared = dx * dx + dy * dy + dz * dz,
    bound = load<f64>(ELIMIT + eo);
  let length: f64 = 0;
  if (squaredTest) {
    if (squared <= bound * bound) return false;
  } else {
    length = Math.sqrt(squared);
    if (length <= bound) return false;
  }
  const wa = load<f64>(W + ((<usize>ai) << 3)),
    wb = load<f64>(W + ((<usize>bi) << 3));
  if (falsy(wa + wb)) return false;
  if (squaredTest) length = Math.sqrt(squared);
  const scale = (length - bound) / (length * (wa + wb));
  store<f64>(pa, ax - wa * scale * dx);
  store<f64>(pa, ay - wa * scale * dy, 8);
  store<f64>(pa, az - wa * scale * dz, 16);
  store<f64>(pb, bx + wb * scale * dx);
  store<f64>(pb, by + wb * scale * dy, 8);
  store<f64>(pb, bz + wb * scale * dz, 16);
  return true;
}

/** ClothSolver.limitHotEdges: one pass over the hot list. */
export function limitHot(): void {
  for (let slot = 0; slot < hotCount; slot++) project(li(HOT, slot), false);
}

/** ClothSolver.limitAllEdges(passes) over every edge. */
function limitAllEdges(passes: i32, total: i32): i32 {
  let count = 0;
  for (let pass = 0; pass < passes; pass++) {
    if (pass % 8 == 0) {
      count = 0;
      for (let e = 0; e < total; e++) if (project(e, true)) si(EQUEUE, count++, e);
      if (count == 0) return pass;
    } else if (pass % 2 != 0)
      for (let slot = count - 1; slot >= 0; slot--) project(li(EQUEUE, slot), true);
    else for (let slot = 0; slot < count; slot++) project(li(EQUEUE, slot), true);
  }
  return passes;
}

/** ClothSolver.limitAfterContact(passes) without a region. */
export function limitAfterContact(n: i32, edges: i32, passes: i32): void {
  memory.copy(BEFORE, P, <usize>n * 24);
  limitAllEdges(passes, edges);
  for (let i = 0; i < n; i++) {
    const k = i * 3;
    if (!(lf(DEPTH, i) > 0)) continue;
    const inward = -(
      (lf(P, k) - lf(BEFORE, k)) * lf(NORMAL, k) +
      (lf(P, k + 1) - lf(BEFORE, k + 1)) * lf(NORMAL, k + 1) +
      (lf(P, k + 2) - lf(BEFORE, k + 2)) * lf(NORMAL, k + 2)
    );
    if (inward > 0) sf(DEPTH, i, lf(DEPTH, i) + inward);
  }
}

/**
 * stepSmall, end of a full-mesh substep: velocity from the positions, Coulomb friction relative
 * to the skin for contact particles, speed limit and damping. Returns the summed |v|² (energy
 * before the particle mass). Plane velocities are valid where planeStamp == poseStamp; other
 * contact particles ask the collider (`surface` import), in particle order like the JS.
 */
export function velocity(n: i32, h: f64, mu: f64, limit: f64, decay: f64, poseStamp: i32): f64 {
  let energy: f64 = 0;
  for (let i = 0; i < n; i++) {
    if (falsy(lf(W, i))) continue;
    const k = i * 3;
    let vx = (lf(P, k) - lf(PREV, k)) / h,
      vy = (lf(P, k + 1) - lf(PREV, k + 1)) / h,
      vz = (lf(P, k + 2) - lf(PREV, k + 2)) / h;
    const depth = lf(DEPTH, i);
    if (depth > 0) {
      const nx = lf(NORMAL, k),
        ny = lf(NORMAL, k + 1),
        nz = lf(NORMAL, k + 2);
      if (li(PSTAMP, i) == poseStamp) {
        sf(SV, 0, lf(PVEL, k));
        sf(SV, 1, lf(PVEL, k + 1));
        sf(SV, 2, lf(PVEL, k + 2));
      } else surface(lf(P, k), lf(P, k + 1), lf(P, k + 2));
      const s0 = lf(SV, 0),
        s1 = lf(SV, 1),
        s2 = lf(SV, 2);
      let rx = vx - s0,
        ry = vy - s1,
        rz = vz - s2;
      const vn = rx * nx + ry * ny + rz * nz,
        kept = Math.max(0, vn - depth / h);
      rx -= vn * nx;
      ry -= vn * ny;
      rz -= vn * nz;
      const tangential = Math.sqrt(rx * rx + ry * ry + rz * rz),
        scale: f64 = tangential > 1e-12 ? Math.max(0, 1 - (mu * depth) / h / tangential) : 0;
      vx = s0 + rx * scale + kept * nx;
      vy = s1 + ry * scale + kept * ny;
      vz = s2 + rz * scale + kept * nz;
    }
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz),
      clamp = speed > limit ? (limit / speed) * decay : decay;
    vx *= clamp;
    vy *= clamp;
    vz *= clamp;
    sf(V, k, vx);
    sf(V, k + 1, vy);
    sf(V, k + 2, vz);
    energy += vx * vx + vy * vy + vz * vz;
  }
  return energy;
}

/** ClothSolver.collectHotEdges() without a region: edges above their limit -> HOT. */
export function collectHot(edges: i32): void {
  let count = 0;
  for (let e = 0; e < edges; e++) {
    const a = li(EDGE, e * 2) * 3,
      b = li(EDGE, e * 2 + 1) * 3,
      dx = lf(P, a) - lf(P, b),
      dy = lf(P, a + 1) - lf(P, b + 1),
      dz = lf(P, a + 2) - lf(P, b + 2),
      bound = lf(ELIMIT, e);
    if (dx * dx + dy * dy + dz * dz > bound * bound) si(HOT, count++, e);
  }
  hotCount = count;
}

/**
 * ClothSolver.contact(accumulate) over every particle: hard/compliant body contact with the
 * per-pose tangent-plane reuse and the slack skip; exact queries go to the collider (`distance`
 * import), in particle order like the JS. (x - q) ** 2 in the JS is x*x exactly (V8's pow
 * squares for an exponent of 2).
 */
export function contact(
  n: i32,
  accumulate: bool,
  base: f64,
  neutral: bool,
  planeRadius: f64,
  planeRadius2: f64,
  stamp: i32,
  soft: bool,
  hardElastic: bool,
  hardMin: f64,
  contactAlpha: f64,
  hasSurface: bool,
): void {
  for (let i = 0; i < n; i++) {
    const k = i * 3;
    if (!accumulate) sf(DEPTH, i, 0);
    const w = lf(W, i);
    if (falsy(w)) continue;
    const x = lf(P, k),
      y = lf(P, k + 1),
      z = lf(P, k + 2);
    const slack = lf(SLACK, i);
    if (slack > 0) {
      const tx = x - lf(ANCHOR, k),
        ty = y - lf(ANCHOR, k + 1),
        tz = z - lf(ANCHOR, k + 2);
      if (3 * (tx * tx + ty * ty + tz * tz) < slack * slack) continue;
    }
    const thickness = (neutral ? 0 : lf(LOFT, i)) + base + lf(LAYER, i);
    let d: f64;
    const o = i * 8;
    let reuse = false;
    if (planeRadius > 0 && li(PSTAMP, i) == stamp) {
      const qx = x - lf(PLANE, o),
        qy = y - lf(PLANE, o + 1),
        qz = z - lf(PLANE, o + 2);
      reuse = qx * qx + qy * qy + qz * qz < planeRadius2;
    }
    if (reuse) {
      sf(GRAD, 0, lf(PLANE, o + 4));
      sf(GRAD, 1, lf(PLANE, o + 5));
      sf(GRAD, 2, lf(PLANE, o + 6));
      d =
        lf(PLANE, o + 3) +
        lf(GRAD, 0) * (x - lf(PLANE, o)) +
        lf(GRAD, 1) * (y - lf(PLANE, o + 1)) +
        lf(GRAD, 2) * (z - lf(PLANE, o + 2));
    } else {
      d = distance(x, y, z, thickness + planeRadius);
      if (planeRadius > 0 && d < thickness + planeRadius) {
        sf(PLANE, o, x);
        sf(PLANE, o + 1, y);
        sf(PLANE, o + 2, z);
        sf(PLANE, o + 3, d);
        sf(PLANE, o + 4, lf(GRAD, 0));
        sf(PLANE, o + 5, lf(GRAD, 1));
        sf(PLANE, o + 6, lf(GRAD, 2));
        si(PSTAMP, i, stamp);
        if (hasSurface) {
          surface(x, y, z);
          sf(PVEL, k, lf(SV, 0));
          sf(PVEL, k + 1, lf(SV, 1));
          sf(PVEL, k + 2, lf(SV, 2));
        }
      }
    }
    if (d >= thickness) {
      sf(SLACK, i, d - thickness);
      sf(ANCHOR, k, x);
      sf(ANCHOR, k + 1, y);
      sf(ANCHOR, k + 2, z);
      continue;
    }
    sf(SLACK, i, 0);
    const g0 = lf(GRAD, 0),
      g1 = lf(GRAD, 1),
      g2 = lf(GRAD, 2);
    const length = Math.sqrt(g0 * g0 + g1 * g1 + g2 * g2);
    if (length < 1e-9) continue;
    const push: f64 =
      soft && !(hardElastic && lf(ELASTIC, i) > 0.5)
        ? Math.max(((thickness - d) * w) / (w + contactAlpha), hardMin - d)
        : thickness - d;
    if (push <= 0) continue;
    const nx = g0 / length,
      ny = g1 / length,
      nz = g2 / length;
    sf(P, k, x + nx * push);
    sf(P, k + 1, y + ny * push);
    sf(P, k + 2, z + nz * push);
    sf(NORMAL, k, nx);
    sf(NORMAL, k + 1, ny);
    sf(NORMAL, k + 2, nz);
    sf(DEPTH, i, lf(DEPTH, i) + push);
  }
}

// ClothSolver.pointTriangle's outputs (out[0..3] and bary[0..2]).
let outDistance: f64 = 0,
  outNx: f64 = 0,
  outNy: f64 = 0,
  outNz: f64 = 0,
  bary0: f64 = 0,
  bary1: f64 = 0,
  bary2: f64 = 0;

/** ClothSolver.pointTriangle: signed plane distance of (x, y, z) to triangle (a, b, c). */
function pointTriangle(x: f64, y: f64, z: f64, a: i32, b: i32, c: i32, grow: f64): bool {
  const ax = lf(P, a * 3),
    ay = lf(P, a * 3 + 1),
    az = lf(P, a * 3 + 2);
  const e1x = lf(P, b * 3) - ax,
    e1y = lf(P, b * 3 + 1) - ay,
    e1z = lf(P, b * 3 + 2) - az,
    e2x = lf(P, c * 3) - ax,
    e2y = lf(P, c * 3 + 1) - ay,
    e2z = lf(P, c * 3 + 2) - az;
  let nx = e1y * e2z - e1z * e2y,
    ny = e1z * e2x - e1x * e2z,
    nz = e1x * e2y - e1y * e2x;
  const area = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (area < 1e-12) return false;
  nx /= area;
  ny /= area;
  nz /= area;
  const qx = x - ax,
    qy = y - ay,
    qz = z - az;
  const d = qx * nx + qy * ny + qz * nz;
  const d00 = e1x * e1x + e1y * e1y + e1z * e1z,
    d01 = e1x * e2x + e1y * e2y + e1z * e2z,
    d11 = e2x * e2x + e2y * e2y + e2z * e2z,
    d20 = qx * e1x + qy * e1y + qz * e1z,
    d21 = qx * e2x + qy * e2y + qz * e2z,
    den = d00 * d11 - d01 * d01;
  if (Math.abs(den) < 1e-18) return false;
  const u = (d11 * d20 - d01 * d21) / den,
    w = (d00 * d21 - d01 * d20) / den,
    t = 1 - u - w;
  if (u < -grow || w < -grow || t < -grow) return false;
  bary0 = t;
  bary1 = u;
  bary2 = w;
  outDistance = d;
  outNx = nx;
  outNy = ny;
  outNz = nz;
  return true;
}

/** ClothSolver.layerContact() over every pair. */
export function layerContact(trust: f64, grow: f64): void {
  for (let k = 0; k < pairCount; k++) {
    const a = li(LPA, k),
      b = li(LPB, k),
      half: f64 = b >= 0 ? 0.5 : 1,
      x: f64 = b >= 0 ? (lf(P, a * 3) + lf(P, b * 3)) * 0.5 : lf(P, a * 3),
      y: f64 = b >= 0 ? (lf(P, a * 3 + 1) + lf(P, b * 3 + 1)) * 0.5 : lf(P, a * 3 + 1),
      z: f64 = b >= 0 ? (lf(P, a * 3 + 2) + lf(P, b * 3 + 2)) * 0.5 : lf(P, a * 3 + 2),
      i = li(LPT, k * 3),
      j = li(LPT, k * 3 + 1),
      l = li(LPT, k * 3 + 2);
    if (!pointTriangle(x, y, z, i, j, l, grow)) continue;
    const side = lf(LPS, k),
      error = side * outDistance - lf(LPG, k);
    if (error >= 0 || error < -trust) continue;
    const wa = lf(W, a),
      wb: f64 = b >= 0 ? lf(W, b) : 0,
      source = half * half * (wa + wb),
      den = source + lf(W, i) * bary0 * bary0 + lf(W, j) * bary1 * bary1 + lf(W, l) * bary2 * bary2;
    if (falsy(den)) continue;
    const lambda = -error / den,
      nx = outNx * side * lambda,
      ny = outNy * side * lambda,
      nz = outNz * side * lambda;
    sf(P, a * 3, lf(P, a * 3) + wa * half * nx);
    sf(P, a * 3 + 1, lf(P, a * 3 + 1) + wa * half * ny);
    sf(P, a * 3 + 2, lf(P, a * 3 + 2) + wa * half * nz);
    if (b >= 0) {
      sf(P, b * 3, lf(P, b * 3) + wb * half * nx);
      sf(P, b * 3 + 1, lf(P, b * 3 + 1) + wb * half * ny);
      sf(P, b * 3 + 2, lf(P, b * 3 + 2) + wb * half * nz);
    }
    for (let m = 0; m < 3; m++) {
      const id = li(LPT, k * 3 + m),
        f = lf(W, id) * (m == 0 ? bary0 : m == 1 ? bary1 : bary2);
      sf(P, id * 3, lf(P, id * 3) - f * nx);
      sf(P, id * 3 + 1, lf(P, id * 3 + 1) - f * ny);
      sf(P, id * 3 + 2, lf(P, id * 3 + 2) - f * nz);
    }
  }
}

/** rebuildLayerPairs' groupOf: sleeves 1, back/yoke/collar 2, hood 3, fronts 4, else 0. */
function groupOf(panel: i32): i32 {
  return panel == 4 || panel == 5
    ? 1
    : panel == 7
      ? 3
      : panel == 2 || panel == 3 || panel == 6
        ? 2
        : panel <= 1
          ? 4
          : 0;
}
function facing(a: i32, b: i32): bool {
  return (
    (a == 1 && (b == 2 || b == 4)) ||
    (b == 1 && (a == 2 || a == 4)) ||
    (a == 3 && b == 2) ||
    (a == 2 && b == 3)
  );
}
/** rebuildLayerPairs' hashCell on integer cell coordinates (exact products, see hashKey). */
function hashCell(i: i32, j: i32, k: i32): i32 {
  return (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
}
let tableMask: i32 = 0;
function slotOf(key: i32): i32 {
  let h = (key * -1640531535) & tableMask; // Math.imul(key, 0x9e3779b1)
  while (li(TUSED, h) == pairEpoch && li(TKEYS, h) != key) h = (h + 1) & tableMask;
  return h;
}
function cellOf(v: f64, radius: f64): i32 {
  return <i32>Math.floor(v / radius);
}

/** Per-triangle layer groups (rebuildLayerPairs' triGroup), once per solver. */
export function pairSetup(triangles: i32, tableSize: i32): void {
  tableMask = tableSize - 1;
  for (let t = 0; t < triangles; t++) {
    const g0 = groupOf(li(PANEL, li(TRI, t * 3)));
    si(
      TGROUP,
      t,
      g0 != 0 &&
        g0 == groupOf(li(PANEL, li(TRI, t * 3 + 1))) &&
        g0 == groupOf(li(PANEL, li(TRI, t * 3 + 2)))
        ? g0
        : 0,
    );
  }
}

let keptPairs: i32 = 0;
/** rebuildLayerPairs' `consider`: the perSource closest facing triangles of a vertex/edge. */
function consider(a: i32, b: i32, radius: f64, gapLimit: f64, perSource: i32, grow: f64): void {
  const group = groupOf(li(PANEL, a));
  if (group == 0 || (b >= 0 && groupOf(li(PANEL, b)) != group)) return;
  if (falsy(lf(W, a)) && (b < 0 || falsy(lf(W, b)))) return;
  const x: f64 = b < 0 ? lf(P, a * 3) : (lf(P, a * 3) + lf(P, b * 3)) / 2,
    y: f64 = b < 0 ? lf(P, a * 3 + 1) : (lf(P, a * 3 + 1) + lf(P, b * 3 + 1)) / 2,
    z: f64 = b < 0 ? lf(P, a * 3 + 2) : (lf(P, a * 3 + 2) + lf(P, b * 3 + 2)) / 2;
  const cx = cellOf(x, radius),
    cy = cellOf(y, radius),
    cz = cellOf(z, radius),
    query = ++pairQuery;
  let kept = 0;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) {
        const h = slotOf(hashCell(cx + dx, cy + dy, cz + dz));
        if (li(TUSED, h) != pairEpoch) continue;
        const bucket = li(TBUCKET, h),
          end = li(BSTART, bucket + 1);
        for (let e = li(BSTART, bucket); e < end; e++) {
          const t = li(BENTRY, e);
          if (li(TSTAMP, t) == query) continue;
          si(TSTAMP, t, query);
          if (!facing(group, li(TGROUP, t))) continue;
          const i = li(TRI, t * 3),
            j = li(TRI, t * 3 + 1),
            k = li(TRI, t * 3 + 2);
          if (i == a || j == a || k == a || i == b || j == b || k == b) continue;
          if (!pointTriangle(x, y, z, i, j, k, grow)) continue;
          const d = Math.abs(outDistance);
          if (!(d < radius)) continue;
          let slot = kept;
          while (
            slot > 0 &&
            (lf(BESTD, slot - 1) > d || (lf(BESTD, slot - 1) == d && li(BESTT, slot - 1) > t))
          )
            slot--;
          if (slot >= perSource) continue;
          for (let m = min(kept, perSource - 1); m > slot; m--) {
            sf(BESTD, m, lf(BESTD, m - 1));
            si(BESTT, m, li(BESTT, m - 1));
            sf(BESTS, m, lf(BESTS, m - 1));
          }
          sf(BESTD, slot, d);
          si(BESTT, slot, t);
          sf(BESTS, slot, outDistance >= 0 ? 1 : -1);
          if (kept < perSource) kept++;
        }
      }
  for (let m = 0; m < kept; m++) {
    const t = li(BESTT, m),
      q = keptPairs++;
    si(LPA, q, a);
    si(LPB, q, b);
    si(LPT, q * 3, li(TRI, t * 3));
    si(LPT, q * 3 + 1, li(TRI, t * 3 + 1));
    si(LPT, q * 3 + 2, li(TRI, t * 3 + 2));
    sf(LPS, q, lf(BESTS, m));
    sf(LPG, q, Math.min(gapLimit, lf(BESTD, m)));
  }
}

/** ClothSolver.rebuildLayerPairs(): same pairs in the same order; returns the pair count. */
export function rebuildPairs(
  n: i32,
  edges: i32,
  triangles: i32,
  radius: f64,
  gapLimit: f64,
  perSource: i32,
  grow: f64,
): i32 {
  const epoch = ++pairEpoch;
  // Register large triangles in every cell their vertices touch (once per cell).
  let entries = 0;
  for (let t = 0; t < triangles; t++) {
    if (li(TGROUP, t) == 0) continue;
    const first = entries;
    for (let k = 0; k < 3; k++) {
      const id = li(TRI, t * 3 + k) * 3,
        key = hashCell(
          cellOf(lf(P, id), radius),
          cellOf(lf(P, id + 1), radius),
          cellOf(lf(P, id + 2), radius),
        );
      let seen = false;
      for (let q = first; q < entries; q++) if (li(EKEY, q) == key) seen = true;
      if (seen) continue;
      si(EKEY, entries, key);
      si(ETRI, entries++, t);
    }
  }
  let buckets = 0;
  for (let q = 0; q < entries; q++) {
    const h = slotOf(li(EKEY, q));
    if (li(TUSED, h) != epoch) {
      si(TUSED, h, epoch);
      si(TKEYS, h, li(EKEY, q));
      si(TBUCKET, h, buckets);
      si(BSTART, ++buckets, 0);
    }
    const slot = li(TBUCKET, h) + 1;
    si(BSTART, slot, li(BSTART, slot) + 1);
  }
  si(BSTART, 0, 0);
  for (let b = 0; b < buckets; b++) {
    si(BSTART, b + 1, li(BSTART, b + 1) + li(BSTART, b));
    si(BCURSOR, b, li(BSTART, b));
  }
  for (let q = 0; q < entries; q++) {
    const bucket = li(TBUCKET, slotOf(li(EKEY, q))),
      slot = li(BCURSOR, bucket);
    si(BCURSOR, bucket, slot + 1);
    si(BENTRY, slot, li(ETRI, q));
  }
  keptPairs = 0;
  for (let v = 0; v < n; v++) consider(v, -1, radius, gapLimit, perSource, grow);
  for (let e = 0; e < edges; e++)
    consider(li(EDGE, e * 2), li(EDGE, e * 2 + 1), radius, gapLimit, perSource, grow);
  pairCount = keptPairs;
  return keptPairs;
}

/** First free byte after the module's static data (kernels.ts lays the arrays out from here). */
export function heapBase(): usize {
  return __heap_base;
}

// =============================================================================================
// W3: ArticulatedCollider queries (motion/articulatedCollider.ts), one instance per collider.
// distance / full / rigid / sampleSegment / trilinear / zone / closestOnTriangle /
// surfaceVelocity, with the same linearised cache, hints, cell order and tie-breaks. The pose
// (setFrame) is computed in JS and copied in; Math.hypot comes from JS (`hypot` import).
// =============================================================================================
export let ZSEG: usize = 0; // per segment f64[12]: centre xyz, radius, origin xyz, spacing, dims xyz
export let ZSEGV: usize = 0; // per segment i32: byte offset of its f32 grid
export let ZTOLOCAL: usize = 0; // f64[S * 12]
export let ZTOPREV: usize = 0; // f64[S * 12]
export let ZFACES: usize = 0; // i32[Z * 3] local zone vertex ids
export let ZBV: usize = 0; // i32[zv] border vertex
export let ZBE: usize = 0; // i32[Z * 3] border edge
export let ZNEI: usize = 0; // i32[Z * 3] edge neighbour
export let ZCUR: usize = 0; // f64[zv * 3] posed zone vertices
export let ZPREV: usize = 0; // f64[zv * 3] previous pose
export let ZFN: usize = 0; // f64[Z * 3] face normals
export let ZVN: usize = 0; // f64[zv * 3] vertex pseudo-normals
export let ZTB: usize = 0; // f64[Z * 6] triangle bounds
export let ZCSTART: usize = 0; // i32[cells + 1]
export let ZCENT: usize = 0; // i32[entries]
export let ZSTAMP: usize = 0; // i32[Z]
export let ZCACHE: usize = 0; // f64[65536 * 14]
export let ZCFRAME: usize = 0; // i32[65536]
export let ZOUT: usize = 0; // f64[3]: gradient / surface velocity out
export let zSegments: i32 = 0;
export let zOx: f64 = 0;
export let zOy: f64 = 0;
export let zOz: f64 = 0;
export let zNx: i32 = 0;
export let zNy: i32 = 0;
export let zNz: i32 = 0;
export let zGeneration: i32 = 0;
export let zDt: f64 = 1;
export let zCell: f64 = 0.02; // MOTION_FIT.zoneCellM
export let zCacheE: f64 = 0.001; // MOTION_FIT.cacheRadiusM
export let zSearchMax: f64 = 0.06; // MOTION_FIT.zoneSearchMaxM
export let zSearchMargin: f64 = 0.01; // MOTION_FIT.zoneSearchMarginM
// Query state (ArticulatedCollider fields of the same names).
export let zWinner: i32 = 0;
export let zWinnerSegment: i32 = -1;
export let zWinnerFace: i32 = -1;
export let zHintSegment: i32 = -1;
export let zHintFace: i32 = -1;
export let zQuery: i32 = 0;
export let zLastX: f64 = NaN;
export let zLastY: f64 = NaN;
export let zLastZ: f64 = NaN;
export let zBary0: f64 = 0;
export let zBary1: f64 = 0;
export let zBary2: f64 = 0;
export let zClosestX: f64 = 0;
export let zClosestY: f64 = 0;
export let zClosestZ: f64 = 0;
export let zLocalX: f64 = 0;
export let zLocalY: f64 = 0;
export let zLocalZ: f64 = 0;
export let zBestX: f64 = 0;
export let zBestY: f64 = 0;
export let zBestZ: f64 = 0;
export let zQueries: i32 = 0;
export let zZoneQueries: i32 = 0;
export let zCacheHits: i32 = 0;
let signX: f64 = 0,
  signY: f64 = 0,
  signZ: f64 = 0;
let fullG0: f64 = 0,
  fullG1: f64 = 0,
  fullG2: f64 = 0;
let fullCap: f64 = 0;
let triGrad0: f64 = 0,
  triGrad1: f64 = 0,
  triGrad2: f64 = 0;
// closestOnTriangle's out (SCRATCH in the JS).
let ctX: f64 = 0,
  ctY: f64 = 0,
  ctZ: f64 = 0,
  ctA: f64 = 0,
  ctB: f64 = 0,
  ctC: f64 = 0;

const RIGID = 1,
  ZONE = 2;

// JS Math.hypot (not sqrt of the sum: V8 scales and compensates).
declare function hypot(a: f64, b: f64, c: f64): f64;

function ctSet(x: f64, y: f64, z: f64, a: f64, b: f64, c: f64, region: i32): i32 {
  ctX = x;
  ctY = y;
  ctZ = z;
  ctA = a;
  ctB = b;
  ctC = c;
  return region;
}

/** closestOnTriangle (Ericson §5.1.5), feature code as in the JS. */
function closestOnTriangle(
  px: f64,
  py: f64,
  pz: f64,
  ax: f64,
  ay: f64,
  az: f64,
  bx: f64,
  by: f64,
  bz: f64,
  cx: f64,
  cy: f64,
  cz: f64,
): i32 {
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
  if (d1 <= 0 && d2 <= 0) return ctSet(ax, ay, az, 1, 0, 0, 1);
  const bpx = px - bx,
    bpy = py - by,
    bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz,
    d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return ctSet(bx, by, bz, 0, 1, 0, 2);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return ctSet(ax + t * abx, ay + t * aby, az + t * abz, 1 - t, t, 0, 4);
  }
  const cpx = px - cx,
    cpy = py - cy,
    cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz,
    d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return ctSet(cx, cy, cz, 0, 0, 1, 3);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return ctSet(ax + t * acx, ay + t * acy, az + t * acz, 1 - t, 0, t, 6);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return ctSet(bx + t * (cx - bx), by + t * (cy - by), bz + t * (cz - bz), 0, 1 - t, t, 5);
  }
  const denom = 1 / (va + vb + vc),
    v = vb * denom,
    w = vc * denom;
  return ctSet(
    ax + abx * v + acx * w,
    ay + aby * v + acy * w,
    az + abz * v + acz * w,
    1 - v - w,
    v,
    w,
    0,
  );
}

/** trilinear(seg, local, gradient?) on segment s; the gradient goes to triGrad0..2. */
function trilinear(s: i32, lx: f64, ly: f64, lz: f64, withGradient: bool): f64 {
  const m = ZSEG + <usize>s * 96,
    spacing = load<f64>(m, 56),
    nx = load<f64>(m, 64),
    ny = load<f64>(m, 72),
    nz = load<f64>(m, 80),
    inv = 1 / spacing;
  const gx = (lx - load<f64>(m, 32)) * inv,
    gy = (ly - load<f64>(m, 40)) * inv,
    gz = (lz - load<f64>(m, 48)) * inv;
  const cx = Math.max(0, Math.min(nx - 1, gx)),
    cy = Math.max(0, Math.min(ny - 1, gy)),
    cz = Math.max(0, Math.min(nz - 1, gz));
  const ox = gx - cx,
    oy = gy - cy,
    oz = gz - cz;
  const outside = Math.sqrt(ox * ox + oy * oy + oz * oz) * spacing;
  const i = Math.min(Math.floor(cx), nx - 2),
    j = Math.min(Math.floor(cy), ny - 2),
    k = Math.min(Math.floor(cz), nz - 2);
  const u = cx - i,
    v = cy - j,
    w = cz - k;
  const sx = <i32>(ny * nz),
    sy = <i32>nz,
    base = <i32>i * sx + <i32>j * sy + <i32>k,
    f = <usize>li(ZSEGV, s);
  const c000: f64 = load<f32>(f + ((<usize>base) << 2)),
    c100: f64 = load<f32>(f + ((<usize>(base + sx)) << 2)),
    c010: f64 = load<f32>(f + ((<usize>(base + sy)) << 2)),
    c110: f64 = load<f32>(f + ((<usize>(base + sx + sy)) << 2)),
    c001: f64 = load<f32>(f + ((<usize>(base + 1)) << 2)),
    c101: f64 = load<f32>(f + ((<usize>(base + sx + 1)) << 2)),
    c011: f64 = load<f32>(f + ((<usize>(base + sy + 1)) << 2)),
    c111: f64 = load<f32>(f + ((<usize>(base + sx + sy + 1)) << 2));
  const a = c000 * (1 - u) + c100 * u,
    b = c010 * (1 - u) + c110 * u,
    c = c001 * (1 - u) + c101 * u,
    d = c011 * (1 - u) + c111 * u;
  const lower = a * (1 - v) + b * v,
    upper = c * (1 - v) + d * v;
  if (withGradient) {
    triGrad0 =
      ox == 0
        ? ((c100 - c000) * (1 - v) * (1 - w) +
            (c110 - c010) * v * (1 - w) +
            (c101 - c001) * (1 - v) * w +
            (c111 - c011) * v * w) *
          inv
        : 0;
    triGrad1 = oy == 0 ? ((b - a) * (1 - w) + (d - c) * w) * inv : 0;
    triGrad2 = oz == 0 ? (upper - lower) * inv : 0;
    if (outside > 1e-12) {
      const sc = spacing / outside;
      triGrad0 += ox * sc;
      triGrad1 += oy * sc;
      triGrad2 += oz * sc;
    }
  }
  return lower * (1 - w) + upper * w + outside;
}

/** sampleSegment: +∞ when the bounding sphere proves segment s cannot beat `best`. */
function sampleSegment(s: i32, x: f64, y: f64, z: f64, best: f64): f64 {
  const o = s * 12,
    m = ZSEG + <usize>s * 96;
  const lx =
      lf(ZTOLOCAL, o) * x + lf(ZTOLOCAL, o + 1) * y + lf(ZTOLOCAL, o + 2) * z + lf(ZTOLOCAL, o + 3),
    ly =
      lf(ZTOLOCAL, o + 4) * x +
      lf(ZTOLOCAL, o + 5) * y +
      lf(ZTOLOCAL, o + 6) * z +
      lf(ZTOLOCAL, o + 7),
    lz =
      lf(ZTOLOCAL, o + 8) * x +
      lf(ZTOLOCAL, o + 9) * y +
      lf(ZTOLOCAL, o + 10) * z +
      lf(ZTOLOCAL, o + 11);
  const cx = lx - load<f64>(m),
    cy = ly - load<f64>(m, 8),
    cz = lz - load<f64>(m, 16),
    lower = Math.sqrt(cx * cx + cy * cy + cz * cz) - load<f64>(m, 24);
  if (lower > 0 && lower >= best) return Infinity;
  zLocalX = lx;
  zLocalY = ly;
  zLocalZ = lz;
  return trilinear(s, lx, ly, lz, false);
}

/** rigid(): minimum over segments, the last winner first. */
function rigid(x: f64, y: f64, z: f64): f64 {
  let best: f64 = Infinity;
  const count = zSegments,
    first = zHintSegment;
  zWinnerSegment = -1;
  for (let n = -1; n < count; n++) {
    const s = n < 0 ? first : n;
    if (s < 0 || (n >= 0 && s == first)) continue;
    const d = sampleSegment(s, x, y, z, best);
    if (d < best) {
      best = d;
      zWinnerSegment = s;
      zBestX = zLocalX;
      zBestY = zLocalY;
      zBestZ = zLocalZ;
    }
  }
  if (zWinnerSegment >= 0) zHintSegment = zWinnerSegment;
  return best;
}

/** zone(): exact signed distance to the posed zone triangles within `radius` (see the JS). */
function zone(x: f64, y: f64, z: f64, radius: f64): f64 {
  const h = zCell;
  let i0 = Math.max(0, Math.floor((x - radius - zOx) / h)),
    j0 = Math.max(0, Math.floor((y - radius - zOy) / h)),
    k0 = Math.max(0, Math.floor((z - radius - zOz) / h)),
    i1 = Math.min(<f64>(zNx - 1), Math.floor((x + radius - zOx) / h)),
    j1 = Math.min(<f64>(zNy - 1), Math.floor((y + radius - zOy) / h)),
    k1 = Math.min(<f64>(zNz - 1), Math.floor((z + radius - zOz) / h));
  if (i0 > i1 || j0 > j1 || k0 > k1) return NaN;
  const q = ++zQuery,
    ny = zNy,
    nz = zNz;
  let best2 = radius * radius,
    bestFace = -1,
    bestRegion = 0,
    cx: f64 = 0,
    cy: f64 = 0,
    cz: f64 = 0,
    bu: f64 = 0,
    bv: f64 = 0,
    bw: f64 = 0;
  const hint = zHintFace;
  if (hint >= 0) {
    const a3 = li(ZFACES, hint * 3) * 3,
      b3 = li(ZFACES, hint * 3 + 1) * 3,
      c3 = li(ZFACES, hint * 3 + 2) * 3;
    const r = closestOnTriangle(
      x,
      y,
      z,
      lf(ZCUR, a3),
      lf(ZCUR, a3 + 1),
      lf(ZCUR, a3 + 2),
      lf(ZCUR, b3),
      lf(ZCUR, b3 + 1),
      lf(ZCUR, b3 + 2),
      lf(ZCUR, c3),
      lf(ZCUR, c3 + 1),
      lf(ZCUR, c3 + 2),
    );
    const ex = ctX - x,
      ey = ctY - y,
      ez = ctZ - z,
      d2 = ex * ex + ey * ey + ez * ez;
    if (d2 < best2) {
      best2 = d2;
      bestFace = hint;
      bestRegion = r;
      cx = ctX;
      cy = ctY;
      cz = ctZ;
      bu = ctA;
      bv = ctB;
      bw = ctC;
      si(ZSTAMP, hint, q);
      const reach = Math.sqrt(d2);
      i0 = Math.max(i0, Math.floor((x - reach - zOx) / h));
      j0 = Math.max(j0, Math.floor((y - reach - zOy) / h));
      k0 = Math.max(k0, Math.floor((z - reach - zOz) / h));
      i1 = Math.min(i1, Math.floor((x + reach - zOx) / h));
      j1 = Math.min(j1, Math.floor((y + reach - zOy) / h));
      k1 = Math.min(k1, Math.floor((z + reach - zOz) / h));
    }
  }
  const ii1 = <i32>i1,
    jj1 = <i32>j1,
    kk1 = <i32>k1;
  for (let i = <i32>i0; i <= ii1; i++)
    for (let j = <i32>j0; j <= jj1; j++)
      for (let k = <i32>k0; k <= kk1; k++) {
        const cell = (i * ny + j) * nz + k,
          end = li(ZCSTART, cell + 1);
        for (let e = li(ZCSTART, cell); e < end; e++) {
          const f = li(ZCENT, e);
          if (li(ZSTAMP, f) == q) continue;
          si(ZSTAMP, f, q);
          const b = f * 6;
          const dx = Math.max(Math.max(lf(ZTB, b) - x, 0), x - lf(ZTB, b + 3)),
            dy = Math.max(Math.max(lf(ZTB, b + 1) - y, 0), y - lf(ZTB, b + 4)),
            dz = Math.max(Math.max(lf(ZTB, b + 2) - z, 0), z - lf(ZTB, b + 5));
          if (dx * dx + dy * dy + dz * dz > best2) continue;
          const a3 = li(ZFACES, f * 3) * 3,
            b3 = li(ZFACES, f * 3 + 1) * 3,
            c3 = li(ZFACES, f * 3 + 2) * 3;
          const r = closestOnTriangle(
            x,
            y,
            z,
            lf(ZCUR, a3),
            lf(ZCUR, a3 + 1),
            lf(ZCUR, a3 + 2),
            lf(ZCUR, b3),
            lf(ZCUR, b3 + 1),
            lf(ZCUR, b3 + 2),
            lf(ZCUR, c3),
            lf(ZCUR, c3 + 1),
            lf(ZCUR, c3 + 2),
          );
          const ex = ctX - x,
            ey = ctY - y,
            ez = ctZ - z,
            d2 = ex * ex + ey * ey + ez * ez;
          if (d2 < best2) {
            best2 = d2;
            bestFace = f;
            bestRegion = r;
            cx = ctX;
            cy = ctY;
            cz = ctZ;
            bu = ctA;
            bv = ctB;
            bw = ctC;
          }
        }
      }
  if (bestFace < 0) return NaN;
  zWinnerFace = zHintFace = bestFace;
  zClosestX = cx;
  zClosestY = cy;
  zClosestZ = cz;
  zBary0 = bu;
  zBary1 = bv;
  zBary2 = bw;
  let nx: f64, ny2: f64, nz2: f64;
  if (bestRegion >= 1 && bestRegion <= 3) {
    const v = li(ZFACES, bestFace * 3 + bestRegion - 1);
    if (li(ZBV, v) != 0) return Infinity;
    nx = lf(ZVN, v * 3);
    ny2 = lf(ZVN, v * 3 + 1);
    nz2 = lf(ZVN, v * 3 + 2);
  } else if (bestRegion >= 4) {
    const edge = bestRegion - 4;
    if (li(ZBE, bestFace * 3 + edge) != 0) return Infinity;
    const other = li(ZNEI, bestFace * 3 + edge);
    nx = lf(ZFN, bestFace * 3);
    ny2 = lf(ZFN, bestFace * 3 + 1);
    nz2 = lf(ZFN, bestFace * 3 + 2);
    if (other >= 0) {
      nx += lf(ZFN, other * 3);
      ny2 += lf(ZFN, other * 3 + 1);
      nz2 += lf(ZFN, other * 3 + 2);
    }
  } else {
    nx = lf(ZFN, bestFace * 3);
    ny2 = lf(ZFN, bestFace * 3 + 1);
    nz2 = lf(ZFN, bestFace * 3 + 2);
  }
  const distance = Math.sqrt(best2);
  const sign: f64 = (x - cx) * nx + (y - cy) * ny2 + (z - cz) * nz2 >= 0 ? 1 : -1;
  signX = nx;
  signY = ny2;
  signZ = nz2;
  return sign * distance;
}

/** full(): uncached query; writes fullG0..2 and fullCap, returns the value. */
function full(x: f64, y: f64, z: f64, threshold: f64): f64 {
  const rigidValue = rigid(x, y, z);
  const cap =
    threshold - threshold == 0 // Number.isFinite
      ? Math.min(zSearchMax, Math.max(threshold, 0) + zSearchMargin)
      : zSearchMax;
  const radius = rigidValue > 0 ? Math.min(cap, rigidValue) : cap;
  let zoneValue: f64 = NaN;
  if (radius > 0) {
    zZoneQueries++;
    zoneValue = zone(x, y, z, radius);
  }
  let value: f64;
  if (zoneValue == zoneValue && zoneValue < rigidValue) {
    value = zoneValue;
    zWinner = ZONE;
  } else if (zoneValue != zoneValue && rigidValue > radius) {
    value = radius;
    zWinner = 0;
  } else {
    value = rigidValue;
    zWinner = zWinnerSegment >= 0 ? RIGID : 0;
  }
  fullG0 = fullG1 = fullG2 = 0;
  if (zWinner == ZONE) {
    const dx = x - zClosestX,
      dy = y - zClosestY,
      dz = z - zClosestZ,
      l = hypot(dx, dy, dz);
    if (l > 1e-7) {
      const s = value >= 0 ? 1 / l : -1 / l;
      fullG0 = dx * s;
      fullG1 = dy * s;
      fullG2 = dz * s;
    } else {
      fullG0 = signX;
      fullG1 = signY;
      fullG2 = signZ;
    }
  } else if (zWinner == RIGID) {
    const s = zWinnerSegment,
      o = s * 12;
    trilinear(s, zBestX, zBestY, zBestZ, true);
    fullG0 =
      lf(ZTOLOCAL, o) * triGrad0 + lf(ZTOLOCAL, o + 4) * triGrad1 + lf(ZTOLOCAL, o + 8) * triGrad2;
    fullG1 =
      lf(ZTOLOCAL, o + 1) * triGrad0 +
      lf(ZTOLOCAL, o + 5) * triGrad1 +
      lf(ZTOLOCAL, o + 9) * triGrad2;
    fullG2 =
      lf(ZTOLOCAL, o + 2) * triGrad0 +
      lf(ZTOLOCAL, o + 6) * triGrad1 +
      lf(ZTOLOCAL, o + 10) * triGrad2;
  }
  fullCap = zWinner != 0 ? cap : -Infinity;
  return value;
}

/**
 * ArticulatedCollider.distance with the per-pose linearised cache. When `gradient` and the value
 * is below `threshold`, the gradient is written to ZOUT[0..2] (the caller copies it).
 */
export function colliderDistance(x: f64, y: f64, z: f64, gradient: bool, threshold: f64): f64 {
  zQueries++;
  const e = zCacheE,
    ix = <i32>Math.floor(x / e),
    iy = <i32>Math.floor(y / e),
    iz = <i32>Math.floor(z / e),
    key = ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) & 65535,
    b = key * 14;
  if (li(ZCFRAME, key) == zGeneration) {
    const dx = x - lf(ZCACHE, b),
      dy = y - lf(ZCACHE, b + 1),
      dz = z - lf(ZCACHE, b + 2);
    if (dx * dx + dy * dy + dz * dz < e * e) {
      const value =
        lf(ZCACHE, b + 3) +
        lf(ZCACHE, b + 4) * dx +
        lf(ZCACHE, b + 5) * dy +
        lf(ZCACHE, b + 6) * dz;
      if (value < lf(ZCACHE, b + 7) - e) {
        zCacheHits++;
        zWinner = <i32>lf(ZCACHE, b + 8);
        zWinnerSegment = <i32>lf(ZCACHE, b + 9);
        zWinnerFace = <i32>lf(ZCACHE, b + 10);
        zBary0 = lf(ZCACHE, b + 11);
        zBary1 = lf(ZCACHE, b + 12);
        zBary2 = lf(ZCACHE, b + 13);
        if (gradient && value < threshold) {
          sf(ZOUT, 0, lf(ZCACHE, b + 4));
          sf(ZOUT, 1, lf(ZCACHE, b + 5));
          sf(ZOUT, 2, lf(ZCACHE, b + 6));
        }
        zLastX = x;
        zLastY = y;
        zLastZ = z;
        return value;
      }
    }
  }
  const value = full(x, y, z, threshold);
  if (gradient && value < threshold) {
    sf(ZOUT, 0, fullG0);
    sf(ZOUT, 1, fullG1);
    sf(ZOUT, 2, fullG2);
  }
  if (value < fullCap && zWinner != 0) {
    si(ZCFRAME, key, zGeneration);
    sf(ZCACHE, b, x);
    sf(ZCACHE, b + 1, y);
    sf(ZCACHE, b + 2, z);
    sf(ZCACHE, b + 3, value);
    sf(ZCACHE, b + 4, fullG0);
    sf(ZCACHE, b + 5, fullG1);
    sf(ZCACHE, b + 6, fullG2);
    sf(ZCACHE, b + 7, fullCap);
    sf(ZCACHE, b + 8, <f64>zWinner);
    sf(ZCACHE, b + 9, <f64>zWinnerSegment);
    sf(ZCACHE, b + 10, <f64>zWinnerFace);
    sf(ZCACHE, b + 11, zBary0);
    sf(ZCACHE, b + 12, zBary1);
    sf(ZCACHE, b + 13, zBary2);
  }
  zLastX = x;
  zLastY = y;
  zLastZ = z;
  return value;
}

/** ArticulatedCollider.exactDistance (uncached). */
export function colliderExact(x: f64, y: f64, z: f64, threshold: f64): f64 {
  zLastX = NaN;
  return full(x, y, z, threshold);
}

/** ArticulatedCollider.surfaceVelocity into ZOUT[0..2]. */
export function colliderSurface(x: f64, y: f64, z: f64): void {
  sf(ZOUT, 0, 0);
  sf(ZOUT, 1, 0);
  sf(ZOUT, 2, 0);
  if (x != zLastX || y != zLastY || z != zLastZ) colliderDistance(x, y, z, false, Infinity);
  const inv = 1 / zDt;
  if (zWinner == RIGID) {
    const o = zWinnerSegment * 12;
    sf(
      ZOUT,
      0,
      (x -
        (lf(ZTOPREV, o) * x +
          lf(ZTOPREV, o + 1) * y +
          lf(ZTOPREV, o + 2) * z +
          lf(ZTOPREV, o + 3))) *
        inv,
    );
    sf(
      ZOUT,
      1,
      (y -
        (lf(ZTOPREV, o + 4) * x +
          lf(ZTOPREV, o + 5) * y +
          lf(ZTOPREV, o + 6) * z +
          lf(ZTOPREV, o + 7))) *
        inv,
    );
    sf(
      ZOUT,
      2,
      (z -
        (lf(ZTOPREV, o + 8) * x +
          lf(ZTOPREV, o + 9) * y +
          lf(ZTOPREV, o + 10) * z +
          lf(ZTOPREV, o + 11))) *
        inv,
    );
  } else if (zWinner == ZONE) {
    const f = zWinnerFace;
    for (let k = 0; k < 3; k++) {
      const v = li(ZFACES, f * 3 + k) * 3,
        w = (k == 0 ? zBary0 : k == 1 ? zBary1 : zBary2) * inv;
      sf(ZOUT, 0, lf(ZOUT, 0) + (lf(ZCUR, v) - lf(ZPREV, v)) * w);
      sf(ZOUT, 1, lf(ZOUT, 1) + (lf(ZCUR, v + 1) - lf(ZPREV, v + 1)) * w);
      sf(ZOUT, 2, lf(ZOUT, 2) + (lf(ZCUR, v + 2) - lf(ZPREV, v + 2)) * w);
    }
  }
}

/**
 * Back to the module's initial state for a reused instance (kernels.ts pool): the counters that
 * are not pointers or synced state. The caller zero-fills the memory above heapBase().
 */
export function resetState(): void {
  pairEpoch = 0;
  pairQuery = 0;
  keptPairs = 0;
  hotCount = 0;
  pairCount = 0;
}
