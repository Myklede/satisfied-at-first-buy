// Pure hand-pull helpers (M4): tracker point → viewport, grab patch, cursor state.
// No DOM / Three.js. Units: NDC −1..1 (+y up), scene metres.
import { HAND_PULL } from './config.ts';

export type Ndc = { x: number; y: number };

/**
 * Tracker NDC (already mirrored by the tracker) → viewport NDC. The centred box covering
 * `activeBox` of the camera frame maps to the whole viewport; outside it the cursor stays on
 * the viewport edge.
 */
export function toViewport(point: Ndc, activeBox: number = HAND_PULL.activeBox): Ndc {
  if (!(activeBox > 0 && activeBox <= 1)) throw new RangeError('activeBox must be in (0, 1]');
  const clamp = (v: number) => Math.max(-1, Math.min(1, v / activeBox));
  return { x: clamp(point.x), y: clamp(point.y) };
}

/** Viewport NDC → CSS pixels inside an element of size width × height (y down). */
export function ndcToPixels(point: Ndc, width: number, height: number) {
  return { x: ((point.x + 1) / 2) * width, y: ((1 - point.y) / 2) * height };
}

/** Midpoint of thumb tip (4) and index tip (8): the pinch point of a 21-landmark hand. */
export function pinchPoint(landmarks: ReadonlyArray<{ x: number; y: number }>): Ndc {
  const a = landmarks[4],
    b = landmarks[8];
  if (!a || !b) throw new Error('Hand needs 21 landmarks');
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Compressed sparse row vertex adjacency from a triangle list. */
export function vertexAdjacency(triangles: ArrayLike<number>, vertexCount: number) {
  const sets = Array.from({ length: vertexCount }, () => new Set<number>());
  for (let t = 0; t + 2 < triangles.length; t += 3)
    for (let c = 0; c < 3; c++) {
      const a = triangles[t + c],
        b = triangles[t + ((c + 1) % 3)];
      sets[a].add(b);
      sets[b].add(a);
    }
  const offsets = new Int32Array(vertexCount + 1),
    ids: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    for (const j of sets[i]) ids.push(j);
    offsets[i + 1] = ids.length;
  }
  return { offsets, ids: Int32Array.from(ids) };
}

export type Adjacency = ReturnType<typeof vertexAdjacency>;

/**
 * Grab patch: the seed vertices (hit triangle) plus every vertex connected to them through
 * vertices within `radius` of `point` (Euclidean, metres). Walking the mesh keeps a pinch on the
 * chest from also grabbing a sleeve or the back panel that is close in space. Weights fall off
 * smoothly from 1 at the point to `edgeWeight` at the radius (no single-vertex spike).
 */
export function selectPatch(
  positions: ArrayLike<number>,
  adjacency: Adjacency,
  seeds: readonly number[],
  point: readonly number[],
  radius: number = HAND_PULL.patchRadiusM,
  edgeWeight: number = HAND_PULL.patchEdgeWeight,
) {
  if (!(radius > 0)) throw new RangeError('Patch radius must be positive');
  const distance = (i: number) =>
    Math.hypot(
      positions[i * 3] - point[0],
      positions[i * 3 + 1] - point[1],
      positions[i * 3 + 2] - point[2],
    );
  const seen = new Set<number>(seeds),
    queue = [...seeds],
    ids: number[] = [],
    weights: number[] = [];
  while (queue.length) {
    const i = queue.shift()!,
      d = distance(i);
    const inside = d <= radius;
    if (inside || seeds.includes(i)) {
      const t = Math.min(1, d / radius);
      ids.push(i);
      weights.push(Math.max(edgeWeight, 1 - (1 - edgeWeight) * t * t));
    }
    if (!inside) continue;
    for (let k = adjacency.offsets[i]; k < adjacency.offsets[i + 1]; k++) {
      const j = adjacency.ids[k];
      if (!seen.has(j)) {
        seen.add(j);
        queue.push(j);
      }
    }
  }
  return { ids, weights };
}

export type CursorState = 'open' | 'confirming' | 'grabbing' | 'resisting' | 'missed';

/**
 * Cursor look from the tracker's grab progress and the pull state:
 * - grabbing: a grab is engaged (green); resisting: engaged but the fabric limit holds the
 *   patch back (amber);
 * - missed: the hand closed but the cursor was not over the garment (brief, nothing grabbed);
 * - confirming: the tracker reports progress toward a grab (ring fills);
 * - open: otherwise.
 */
export function cursorState(input: {
  grabbing: boolean;
  resisting: boolean;
  missed: boolean;
  grabProgress: number;
}): CursorState {
  if (input.grabbing) return input.resisting ? 'resisting' : 'grabbing';
  if (input.missed) return 'missed';
  return input.grabProgress > 0.02 ? 'confirming' : 'open';
}

/** Linear percentile of an unsorted sample (p in 0..100); NaN when empty. */
export function percentile(values: readonly number[], p: number) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b),
    rank = (p / 100) * (sorted.length - 1),
    lo = Math.floor(rank),
    hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}
