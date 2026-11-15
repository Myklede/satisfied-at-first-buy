// Pure two-view silhouette geometry for the webcam body scan. No DOM, no MediaPipe:
// inputs are a person-segmentation mask (values 0..1) and pose landmarks in mask pixels.
//
// Pixel convention: pixel (i, j) covers [i, i+1) × [j, j+1); its centre is (i+0.5, j+0.5).
// Image y grows downward. Edges are located with sub-pixel precision by linear
// interpolation of the mask value across the MASK_THRESHOLD crossing.
//
// Output units are centimetres. The pixel scale comes from the person's own pixel
// stature and the stature typed in by the user (height_cm), separately per frame.
//
// IMPORTANT: everything here is geometry on a 2D silhouette. Nothing in this file has
// been validated against tape measurements of a real person; see CALIBRATION.md.

import type { ScanMeasurementName } from './types';

// ---------------------------------------------------------------------------
// Constants (each one affects accuracy; source or "heuristic" stated)
// ---------------------------------------------------------------------------

/** Mask value treated as the person boundary. Midpoint of MediaPipe's 0..1 confidence; heuristic. */
export const MASK_THRESHOLD = 0.5;

/**
 * Stature bands and selection rule per girth. Source: docs/MEASUREMENTS.md (body service
 * definitions): chest = max torso girth in 70–78 % of stature, waist = min in 57–65 %,
 * hip = max in 46–56 %.
 */
export const STATURE_BANDS = {
  chest_cm: { lo: 0.7, hi: 0.78, pick: 'max' },
  waist_cm: { lo: 0.57, hi: 0.65, pick: 'min' },
  hip_cm: { lo: 0.46, hi: 0.56, pick: 'max' },
} as const satisfies Record<
  'chest_cm' | 'waist_cm' | 'hip_cm',
  { lo: number; hi: number; pick: 'max' | 'min' }
>;

export type GirthName = keyof typeof STATURE_BANDS;
export const GIRTH_NAMES: readonly GirthName[] = ['chest_cm', 'waist_cm', 'hip_cm'];

/** Profile sampling: stature fractions 0.44..0.80 in 0.5 % steps (≈ 0.9 cm for 175 cm). */
export const PROFILE_MIN = 0.44;
export const PROFILE_MAX = 0.8;
export const PROFILE_STEP = 0.005;
export const PROFILE_FRACTIONS: readonly number[] = Array.from(
  { length: Math.round((PROFILE_MAX - PROFILE_MIN) / PROFILE_STEP) + 1 },
  (_, k) => Math.round((PROFILE_MIN + k * PROFILE_STEP) * 1e6) / 1e6,
);

/**
 * The hand extends past the wrist landmark. Hand-tip estimate = wrist + K·(mean(index,
 * pinky knuckle landmarks) − wrist). K = 2 roughly reaches the fingertips; heuristic,
 * used only to exclude hand pixels from torso rows.
 */
export const HAND_TIP_EXTENSION = 2;

/** Acromion search window around the MediaPipe shoulder joint centre, in cm. Heuristic. */
export const ACROMION_SEARCH_INNER_CM = 8;
export const ACROMION_SEARCH_OUTER_CM = 10;
/** Top-contour scan starts this far above the shoulder joint centre (skips the head). Heuristic. */
export const ACROMION_SEARCH_ABOVE_CM = 15;
/** Length of each straight segment fitted on either side of a corner candidate. Heuristic. */
export const CORNER_SEGMENT_CM = 4;
/** Minimum turn (outer slope − inner slope) for a shoulder→arm corner. Heuristic. */
export const MIN_CORNER_TURN_DEG = 20;

/** Side view: a body run may be this far from the centre line and still count. Heuristic. */
export const SIDE_CENTRE_TOLERANCE_CM = 3;

/** A profile bin is kept in the median only if valid in at least this share of frames. Heuristic. */
export const MIN_BIN_FRAME_SHARE = 0.5;

/** 1.4826·MAD estimates σ for normally distributed data (standard robust-statistics constant). */
export const MAD_TO_SIGMA = 1.4826;

/** MediaPipe Pose landmark indices (BlazePose 33-point topology). */
export const POSE = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

/** Landmark already converted to mask pixels. */
export interface PixelLandmark extends Point {
  visibility: number;
}

export interface MaskImage {
  width: number;
  height: number;
  /** Row-major, values 0..1 (float confidence or binary). */
  data: ArrayLike<number>;
}

/** One connected person component, with the original mask values kept for sub-pixel edges. */
export interface PersonMask {
  width: number;
  height: number;
  inside: Uint8Array;
  values: ArrayLike<number>;
  threshold: number;
  area: number;
  bbox: { left: number; top: number; right: number; bottom: number };
}

export interface VerticalExtent {
  /** Sub-pixel y of the top of the head (mask top). */
  crownY: number;
  /** Sub-pixel y of the floor contact (mask bottom, or heel landmarks if lower). */
  floorY: number;
  staturePx: number;
}

export interface Run {
  /** Sub-pixel left edge (continuous x). */
  l: number;
  /** Sub-pixel right edge (continuous x). */
  r: number;
}

export type FrontSpan =
  | { status: 'ok'; left: number; right: number }
  | { status: 'merged' }
  | { status: 'none' };

export interface ProfileRow {
  fraction: number;
  /** Row centre y in pixels. */
  y: number;
  left: number;
  right: number;
}

export interface ShoulderCorner extends Point {
  turnDeg: number;
}

export interface FrontFrameMeasure {
  pxPerCm: number;
  extent: VerticalExtent;
  /** Torso width (cm) per PROFILE_FRACTIONS bin; NaN where invalid. */
  widthsCm: Float64Array;
  /** Bins where every row had the arm merged with the torso. */
  mergedBins: boolean[];
  /** Representative measured row per bin (for overlays); null where invalid. */
  rows: Array<ProfileRow | null>;
  acromion: { left: ShoulderCorner | null; right: ShoulderCorner | null };
  shoulderWidthCm: number | null;
  armLengthCm: { left: number | null; right: number | null };
}

export interface SideFrameMeasure {
  pxPerCm: number;
  extent: VerticalExtent;
  /** Body depth (cm) per PROFILE_FRACTIONS bin; NaN where invalid. */
  depthsCm: Float64Array;
  rows: Array<ProfileRow | null>;
}

// ---------------------------------------------------------------------------
// Basic math
// ---------------------------------------------------------------------------

/**
 * Ellipse perimeter, Ramanujan's first approximation:
 * π[3(a+b) − √((3a+b)(a+3b))], with semi-axes a, b. Exact for circles.
 */
export function ellipsePerimeter(a: number, b: number): number {
  if (!(a >= 0 && b >= 0)) return NaN;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

export function median(values: readonly number[]): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (v.length === 0) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Robust standard deviation 1.4826·MAD. 0 for fewer than two finite values. */
export function robustSigma(values: readonly number[]): number {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return 0;
  const m = median(v);
  return MAD_TO_SIGMA * median(v.map((x) => Math.abs(x - m)));
}

export function distance(p: Point, q: Point): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

export function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

// ---------------------------------------------------------------------------
// Person component and edges
// ---------------------------------------------------------------------------

/**
 * Selects the connected (4-neighbour) foreground component containing the first seed
 * that lies on the foreground; falls back to the largest component. Returns null if
 * the mask has no foreground pixel.
 */
export function selectPerson(
  mask: MaskImage,
  seeds: readonly Point[],
  threshold = MASK_THRESHOLD,
): PersonMask | null {
  const { width: w, height: h, data } = mask;
  const n = w * h;
  const fg = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (data[i] >= threshold) {
      fg[i] = 1;
      any = true;
    }
  }
  if (!any) return null;

  const stack = new Int32Array(n);
  const flood = (start: number, out: Uint8Array): number => {
    let top = 0;
    let area = 0;
    stack[top++] = start;
    out[start] = 1;
    while (top > 0) {
      const p = stack[--top];
      area++;
      const x = p % w;
      const push = (q: number) => {
        if (fg[q] && !out[q]) {
          out[q] = 1;
          stack[top++] = q;
        }
      };
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (p >= w) push(p - w);
      if (p < n - w) push(p + w);
    }
    return area;
  };

  let inside: Uint8Array | null = null;
  for (const s of seeds) {
    const x = Math.floor(s.x);
    const y = Math.floor(s.y);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const p = y * w + x;
    if (fg[p]) {
      inside = new Uint8Array(n);
      flood(p, inside);
      break;
    }
  }
  if (!inside) {
    // Largest component.
    const seen = new Uint8Array(n);
    let bestArea = 0;
    let bestStart = -1;
    for (let p = 0; p < n; p++) {
      if (!fg[p] || seen[p]) continue;
      const area = flood(p, seen);
      if (area > bestArea) {
        bestArea = area;
        bestStart = p;
      }
    }
    inside = new Uint8Array(n);
    flood(bestStart, inside);
  }

  let area = 0;
  let left = w;
  let right = -1;
  let top = h;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!inside[row + x]) continue;
      area++;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return {
    width: w,
    height: h,
    inside,
    values: data,
    threshold,
    area,
    bbox: { left, top, right, bottom },
  };
}

/**
 * Fraction (0..1) of the way from the outside pixel centre to the inside pixel centre
 * where the mask crosses the threshold. A neighbour that is itself above threshold (another
 * component) or a non-monotone pair falls back to the pixel boundary (0.5).
 */
function crossing(vOut: number, vIn: number, threshold: number): number {
  if (!(vOut < threshold) || !(vIn > vOut)) return 0.5;
  return Math.min(1, Math.max(0, (threshold - vOut) / (vIn - vOut)));
}

function valueAt(person: PersonMask, x: number, y: number): number {
  return person.values[y * person.width + x];
}

/** Foreground runs of the component in row y, with sub-pixel edges. */
export function rowRuns(person: PersonMask, y: number): Run[] {
  const { width: w, inside, threshold } = person;
  const runs: Run[] = [];
  if (y < 0 || y >= person.height) return runs;
  const row = y * w;
  let x = 0;
  while (x < w) {
    if (!inside[row + x]) {
      x++;
      continue;
    }
    const x0 = x;
    while (x < w && inside[row + x]) x++;
    const x1 = x - 1;
    const l =
      x0 === 0
        ? 0
        : x0 - 0.5 + crossing(valueAt(person, x0 - 1, y), valueAt(person, x0, y), threshold);
    const r =
      x1 === w - 1
        ? w
        : x1 + 1.5 - crossing(valueAt(person, x1 + 1, y), valueAt(person, x1, y), threshold);
    runs.push({ l, r });
  }
  return runs;
}

/** Top of the head (mask top) and floor (mask bottom, or the lowest heel landmark if lower). */
export function verticalExtent(person: PersonMask, heelYs: readonly number[] = []): VerticalExtent {
  const { width: w, inside, threshold, bbox } = person;
  let crownY = Infinity;
  const top = bbox.top;
  for (let x = bbox.left; x <= bbox.right; x++) {
    if (!inside[top * w + x]) continue;
    const y =
      top === 0
        ? 0
        : top - 0.5 + crossing(valueAt(person, x, top - 1), valueAt(person, x, top), threshold);
    if (y < crownY) crownY = y;
  }
  let floorY = -Infinity;
  const bottom = bbox.bottom;
  for (let x = bbox.left; x <= bbox.right; x++) {
    if (!inside[bottom * w + x]) continue;
    const y =
      bottom === person.height - 1
        ? person.height
        : bottom +
          1.5 -
          crossing(valueAt(person, x, bottom + 1), valueAt(person, x, bottom), threshold);
    if (y > floorY) floorY = y;
  }
  for (const hy of heelYs) if (Number.isFinite(hy) && hy > floorY) floorY = hy;
  return { crownY, floorY, staturePx: floorY - crownY };
}

/** Pixels per centimetre from the person's pixel stature and their stated height. */
export function pixelScale(extent: VerticalExtent, heightCm: number): number {
  if (!(heightCm > 0) || !(extent.staturePx > 0)) throw new RangeError('invalid stature');
  return extent.staturePx / heightCm;
}

/** Image row y (continuous) at a fraction of stature measured up from the floor. */
export function fractionToY(extent: VerticalExtent, fraction: number): number {
  return extent.floorY - fraction * extent.staturePx;
}

// ---------------------------------------------------------------------------
// Landmark helpers
// ---------------------------------------------------------------------------

function mid(p: Point, q: Point): Point {
  return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
}

/** Body centre line x at row y: shoulder midpoint → hip midpoint, clamped beyond them. */
export function centreXAt(lms: readonly PixelLandmark[], y: number): number {
  const s = mid(lms[POSE.LEFT_SHOULDER], lms[POSE.RIGHT_SHOULDER]);
  const h = mid(lms[POSE.LEFT_HIP], lms[POSE.RIGHT_HIP]);
  if (h.y === s.y) return (s.x + h.x) / 2;
  const t = Math.min(1, Math.max(0, (y - s.y) / (h.y - s.y)));
  return s.x + t * (h.x - s.x);
}

/** Arm centreline: shoulder joint → elbow → wrist → estimated hand tip. */
export function armPolyline(lms: readonly PixelLandmark[], side: 'left' | 'right'): Point[] {
  const L = side === 'left';
  const shoulder = lms[L ? POSE.LEFT_SHOULDER : POSE.RIGHT_SHOULDER];
  const elbow = lms[L ? POSE.LEFT_ELBOW : POSE.RIGHT_ELBOW];
  const wrist = lms[L ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST];
  const pinky = lms[L ? POSE.LEFT_PINKY : POSE.RIGHT_PINKY];
  const index = lms[L ? POSE.LEFT_INDEX : POSE.RIGHT_INDEX];
  const points: Point[] = [shoulder, elbow, wrist];
  if (pinky && index) {
    const k = mid(pinky, index);
    points.push({
      x: wrist.x + HAND_TIP_EXTENSION * (k.x - wrist.x),
      y: wrist.y + HAND_TIP_EXTENSION * (k.y - wrist.y),
    });
  }
  return points;
}

/** x positions where a polyline crosses row y (one per spanning segment). */
export function polylineXsAtRow(poly: readonly Point[], y: number): number[] {
  const xs: number[] = [];
  for (let i = 1; i < poly.length; i++) {
    const p = poly[i - 1];
    const q = poly[i];
    const lo = Math.min(p.y, q.y);
    const hi = Math.max(p.y, q.y);
    if (y < lo || y > hi || hi - lo < 1e-9) continue;
    xs.push(p.x + ((y - p.y) / (q.y - p.y)) * (q.x - p.x));
  }
  return xs;
}

/**
 * Arm x positions to exclude in row y. Rows the polyline does not span use the x of its
 * nearest end (above the shoulder joint: the joint; below the hand tip: the tip), so pixels
 * of a hand reaching past the estimated tip are still recognised as arm, not torso.
 */
export function armXsForRow(poly: readonly Point[], y: number): number[] {
  const xs = polylineXsAtRow(poly, y);
  if (xs.length > 0 || poly.length === 0) return xs;
  let top = poly[0];
  let bottom = poly[0];
  for (const p of poly) {
    if (p.y < top.y) top = p;
    if (p.y > bottom.y) bottom = p;
  }
  return [y < top.y ? top.x : bottom.x];
}

/** Angle (deg) of shoulder→elbow from straight down; 0 = arm hanging, 90 = horizontal. */
export function armAbductionDeg(lms: readonly PixelLandmark[], side: 'left' | 'right'): number {
  const s = lms[side === 'left' ? POSE.LEFT_SHOULDER : POSE.RIGHT_SHOULDER];
  const e = lms[side === 'left' ? POSE.LEFT_ELBOW : POSE.RIGHT_ELBOW];
  return (Math.atan2(Math.abs(e.x - s.x), e.y - s.y) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// Row spans
// ---------------------------------------------------------------------------

/**
 * Front torso span in one row with arm exclusion.
 * - A run containing both the centre line and an arm centreline → 'merged' (arm touches
 *   the torso in this row; the row cannot give a torso width).
 * - A run containing an arm centreline only → that arm, excluded.
 * - Any other run whose midpoint is nearer to an arm centreline on its side than to the
 *   body centre line (e.g. fingertips past the estimated hand tip) → excluded.
 * - Remaining runs are spanned like a tensioned tape (bridges the gap between the legs).
 */
export function frontSpan(
  runs: readonly Run[],
  centreX: number,
  armXs: readonly number[],
): FrontSpan {
  let left = Infinity;
  let right = -Infinity;
  let hasCentre = false;
  for (const run of runs) {
    const containsCentre = run.l <= centreX && centreX <= run.r;
    const containsArm = armXs.some((a) => run.l <= a && a <= run.r);
    if (containsCentre && containsArm) return { status: 'merged' };
    if (containsArm) continue;
    const m = (run.l + run.r) / 2;
    const nearerArm = armXs.some(
      (a) =>
        Math.sign(a - centreX) === Math.sign(m - centreX) &&
        Math.abs(m - a) < Math.abs(m - centreX),
    );
    if (!containsCentre && nearerArm) continue;
    if (containsCentre) hasCentre = true;
    left = Math.min(left, run.l);
    right = Math.max(right, run.r);
  }
  if (!Number.isFinite(left)) return { status: 'none' };
  if (!hasCentre && !(left < centreX && right > centreX)) return { status: 'none' };
  return { status: 'ok', left, right };
}

/** Side-view body span: the run containing the centre line, or the nearest within tolerance. */
export function sideSpan(runs: readonly Run[], centreX: number, tolerancePx: number): Run | null {
  let best: Run | null = null;
  let bestGap = Infinity;
  for (const run of runs) {
    const gap = centreX < run.l ? run.l - centreX : centreX > run.r ? centreX - run.r : 0;
    if (gap < bestGap) {
      bestGap = gap;
      best = run;
    }
  }
  return best && bestGap <= tolerancePx ? best : null;
}

/** Integer rows whose centres fall in the stature-fraction bin [f − step/2, f + step/2). */
function binRows(extent: VerticalExtent, fraction: number, height: number): number[] {
  const yTop = fractionToY(extent, fraction + PROFILE_STEP / 2);
  const yBottom = fractionToY(extent, fraction - PROFILE_STEP / 2);
  const rows: number[] = [];
  for (let r = Math.ceil(yTop - 0.5); r + 0.5 < yBottom; r++)
    if (r >= 0 && r < height) rows.push(r);
  if (rows.length === 0) {
    // Low resolution: fewer than one row per bin. Use the nearest row.
    const r = Math.round(fractionToY(extent, fraction) - 0.5);
    if (r >= 0 && r < height) rows.push(r);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Acromion (shoulder corner) detection
// ---------------------------------------------------------------------------

/**
 * Top contour of the component for integer columns x0..x1: sub-pixel y of the first
 * foreground pixel at or below yStart. NaN if the column is empty, or if it is already
 * foreground at yStart (something above, e.g. hair or a raised hand, occludes it).
 */
export function topContour(
  person: PersonMask,
  x0: number,
  x1: number,
  yStart: number,
): Float64Array {
  const { width: w, height: h, inside, threshold } = person;
  const out = new Float64Array(Math.max(0, x1 - x0 + 1)).fill(NaN);
  const ys = Math.max(0, Math.floor(yStart));
  for (let x = x0; x <= x1; x++) {
    if (x < 0 || x >= w) continue;
    if (inside[ys * w + x]) continue;
    for (let y = ys + 1; y < h; y++) {
      if (!inside[y * w + x]) continue;
      out[x - x0] = y - 0.5 + crossing(valueAt(person, x, y - 1), valueAt(person, x, y), threshold);
      break;
    }
  }
  return out;
}

function fitSlope(us: readonly number[], vs: readonly number[]): number {
  const n = us.length;
  let su = 0;
  let sv = 0;
  for (let i = 0; i < n; i++) {
    su += us[i];
    sv += vs[i];
  }
  const mu = su / n;
  const mv = sv / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (us[i] - mu) * (vs[i] - mv);
    den += (us[i] - mu) ** 2;
  }
  return den > 0 ? num / den : NaN;
}

/**
 * Finds the convex "shoulder corner" on a top contour: the column where the contour turns
 * from the gentle neck→shoulder slope to the steep outer edge of the abducted arm.
 * For each candidate, straight lines are least-squares fitted to the contour over segPx
 * on the inner side and on the outer side; turn = atan(outer descent) − atan(inner descent).
 * The largest turn ≥ minTurnDeg wins. Concave turns (neck → shoulder) score negative.
 *
 * @param xs  column-centre x of each contour sample (ascending)
 * @param ys  contour y (NaN = missing); y grows downward, so "descent" is +dy per outward px
 * @param outward +1 if the arm is toward +x, −1 otherwise
 * @param candidateRange inclusive [xMin, xMax] of allowed corner x
 */
export function findShoulderCorner(
  xs: readonly number[],
  ys: ArrayLike<number>,
  outward: 1 | -1,
  segPx: number,
  candidateRange: readonly [number, number],
  minTurnDeg = MIN_CORNER_TURN_DEG,
): ShoulderCorner | null {
  const minPoints = Math.max(3, Math.floor(segPx * 0.6));
  let best: ShoulderCorner | null = null;
  for (let i = 0; i < xs.length; i++) {
    const xi = xs[i];
    if (xi < candidateRange[0] || xi > candidateRange[1] || !Number.isFinite(ys[i])) continue;
    const ui = outward * xi;
    const inU: number[] = [];
    const inV: number[] = [];
    const outU: number[] = [];
    const outV: number[] = [];
    for (let j = 0; j < xs.length; j++) {
      if (!Number.isFinite(ys[j])) continue;
      const du = outward * xs[j] - ui;
      if (du >= -segPx && du <= 0) {
        inU.push(du);
        inV.push(ys[j]);
      }
      if (du >= 0 && du <= segPx) {
        outU.push(du);
        outV.push(ys[j]);
      }
    }
    if (inU.length < minPoints || outU.length < minPoints) continue;
    const thIn = Math.atan(fitSlope(inU, inV));
    const thOut = Math.atan(fitSlope(outU, outV));
    const turnDeg = ((thOut - thIn) * 180) / Math.PI;
    if (!Number.isFinite(turnDeg) || turnDeg < minTurnDeg) continue;
    if (!best || turnDeg > best.turnDeg) best = { x: xi, y: ys[i], turnDeg };
  }
  return best;
}

/** Locates one acromion on the front silhouette, searching around the shoulder joint landmark. */
export function detectAcromion(
  person: PersonMask,
  lms: readonly PixelLandmark[],
  side: 'left' | 'right',
  pxPerCm: number,
): ShoulderCorner | null {
  const joint = lms[side === 'left' ? POSE.LEFT_SHOULDER : POSE.RIGHT_SHOULDER];
  const cx = centreXAt(lms, joint.y);
  const outward: 1 | -1 = joint.x >= cx ? 1 : -1;
  const segPx = CORNER_SEGMENT_CM * pxPerCm;
  const a = joint.x - outward * ACROMION_SEARCH_INNER_CM * pxPerCm;
  const b = joint.x + outward * ACROMION_SEARCH_OUTER_CM * pxPerCm;
  const candidate: [number, number] = [Math.min(a, b), Math.max(a, b)];
  const x0 = Math.max(0, Math.floor(candidate[0] - segPx));
  const x1 = Math.min(person.width - 1, Math.ceil(candidate[1] + segPx));
  if (x1 <= x0) return null;
  const ys = topContour(person, x0, x1, joint.y - ACROMION_SEARCH_ABOVE_CM * pxPerCm);
  const xs = Array.from({ length: x1 - x0 + 1 }, (_, i) => x0 + i + 0.5);
  return findShoulderCorner(xs, ys, outward, segPx, candidate);
}

// ---------------------------------------------------------------------------
// Per-frame measurement
// ---------------------------------------------------------------------------

function torsoSeeds(lms: readonly PixelLandmark[]): Point[] {
  const s = mid(lms[POSE.LEFT_SHOULDER], lms[POSE.RIGHT_SHOULDER]);
  const h = mid(lms[POSE.LEFT_HIP], lms[POSE.RIGHT_HIP]);
  return [mid(s, h), s, h];
}

/** Connected person component seeded at the torso landmarks. */
export function personFromMask(mask: MaskImage, lms: readonly PixelLandmark[]): PersonMask | null {
  return selectPerson(mask, torsoSeeds(lms));
}

function heelYs(lms: readonly PixelLandmark[]): number[] {
  return [lms[POSE.LEFT_HEEL], lms[POSE.RIGHT_HEEL]].filter((p) => p).map((p) => p.y);
}

/** Front view: torso width profile (arms excluded), both acromia, shoulder width, arm lengths. */
export function measureFrontFrame(
  person: PersonMask,
  lms: readonly PixelLandmark[],
  heightCm: number,
): FrontFrameMeasure {
  const extent = verticalExtent(person, heelYs(lms));
  const pxPerCm = pixelScale(extent, heightCm);
  const arms = [armPolyline(lms, 'left'), armPolyline(lms, 'right')];

  const widthsCm = new Float64Array(PROFILE_FRACTIONS.length).fill(NaN);
  const mergedBins: boolean[] = [];
  const rows: Array<ProfileRow | null> = [];
  PROFILE_FRACTIONS.forEach((f, k) => {
    let sum = 0;
    let count = 0;
    let merged = 0;
    let rep: ProfileRow | null = null;
    const binR = binRows(extent, f, person.height);
    for (const y of binR) {
      const yc = y + 0.5;
      const armXs = arms.flatMap((poly) => armXsForRow(poly, yc));
      const span = frontSpan(rowRuns(person, y), centreXAt(lms, yc), armXs);
      if (span.status === 'merged') merged++;
      if (span.status !== 'ok') continue;
      sum += span.right - span.left;
      count++;
      rep ??= { fraction: f, y: yc, left: span.left, right: span.right };
    }
    if (count > 0) widthsCm[k] = sum / count / pxPerCm;
    mergedBins.push(binR.length > 0 && merged === binR.length);
    rows.push(rep);
  });

  const left = detectAcromion(person, lms, 'left', pxPerCm);
  const right = detectAcromion(person, lms, 'right', pxPerCm);
  const shoulderWidthCm = left && right ? distance(left, right) / pxPerCm : null;

  const armLength = (side: 'left' | 'right', corner: ShoulderCorner | null): number | null => {
    if (!corner) return null;
    const L = side === 'left';
    const elbow = lms[L ? POSE.LEFT_ELBOW : POSE.RIGHT_ELBOW];
    const wrist = lms[L ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST];
    return polylineLength([corner, elbow, wrist]) / pxPerCm;
  };

  return {
    pxPerCm,
    extent,
    widthsCm,
    mergedBins,
    rows,
    acromion: { left, right },
    shoulderWidthCm,
    armLengthCm: { left: armLength('left', left), right: armLength('right', right) },
  };
}

/** Side view: body depth profile along the same stature fractions. */
export function measureSideFrame(
  person: PersonMask,
  lms: readonly PixelLandmark[],
  heightCm: number,
): SideFrameMeasure {
  const extent = verticalExtent(person, heelYs(lms));
  const pxPerCm = pixelScale(extent, heightCm);
  const tolerancePx = SIDE_CENTRE_TOLERANCE_CM * pxPerCm;
  const depthsCm = new Float64Array(PROFILE_FRACTIONS.length).fill(NaN);
  const rows: Array<ProfileRow | null> = [];
  PROFILE_FRACTIONS.forEach((f, k) => {
    let sum = 0;
    let count = 0;
    let rep: ProfileRow | null = null;
    for (const y of binRows(extent, f, person.height)) {
      const yc = y + 0.5;
      const span = sideSpan(rowRuns(person, y), centreXAt(lms, yc), tolerancePx);
      if (!span) continue;
      sum += span.r - span.l;
      count++;
      rep ??= { fraction: f, y: yc, left: span.l, right: span.r };
    }
    if (count > 0) depthsCm[k] = sum / count / pxPerCm;
    rows.push(rep);
  });
  return { pxPerCm, extent, depthsCm, rows };
}

// ---------------------------------------------------------------------------
// Aggregation over a scan
// ---------------------------------------------------------------------------

export interface RawMeasurement {
  /** Median raw silhouette value before calibration (cm). */
  value_cm: number;
  /** Robust per-frame spread (1.4826·MAD, cm). Frames are correlated, so not divided by √n. */
  spread_cm: number;
  /** Frames that contributed. */
  frames: number;
  /** Stature fraction where the band extreme was found (girths only). */
  fraction?: number;
  method: string;
}

export interface AggregatedScan {
  measurements: Partial<Record<ScanMeasurementName, RawMeasurement>>;
  /** Reason per measurement that could not be produced. */
  missing: Partial<Record<ScanMeasurementName, string>>;
  frontWidthCm: Float64Array;
  sideDepthCm: Float64Array;
  girthCm: Float64Array;
}

/** Median per bin across frames; NaN unless valid in ≥ MIN_BIN_FRAME_SHARE of frames. */
export function medianProfile(profiles: readonly Float64Array[]): Float64Array {
  const out = new Float64Array(PROFILE_FRACTIONS.length).fill(NaN);
  if (profiles.length === 0) return out;
  for (let k = 0; k < out.length; k++) {
    const v = profiles.map((p) => p[k]).filter((x) => Number.isFinite(x));
    if (v.length >= MIN_BIN_FRAME_SHARE * profiles.length) out[k] = median(v);
  }
  return out;
}

/** Ellipse girth per bin from a front width and side depth profile (full axes, cm). */
export function girthProfile(widths: Float64Array, depths: Float64Array): Float64Array {
  const out = new Float64Array(widths.length).fill(NaN);
  for (let k = 0; k < out.length; k++) {
    if (Number.isFinite(widths[k]) && Number.isFinite(depths[k]))
      out[k] = ellipsePerimeter(widths[k] / 2, depths[k] / 2);
  }
  return out;
}

/** Max or min of a profile over the bins whose fraction lies in [lo, hi]. */
export function bandExtreme(
  profile: Float64Array,
  band: { lo: number; hi: number; pick: 'max' | 'min' },
): { value: number; fraction: number } | null {
  let best: { value: number; fraction: number } | null = null;
  PROFILE_FRACTIONS.forEach((f, k) => {
    if (f < band.lo - 1e-9 || f > band.hi + 1e-9 || !Number.isFinite(profile[k])) return;
    const v = profile[k];
    if (!best || (band.pick === 'max' ? v > best.value : v < best.value))
      best = { value: v, fraction: f };
  });
  return best;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}`;
}

/**
 * Combines front and side frames into raw (uncalibrated) measurements.
 * Girths: median front width and median side depth per stature bin → Ramanujan ellipse
 * → band max/min. Spread: girth recomputed with each front frame against the median side
 * profile, and each side frame against the median front profile; the two robust spreads
 * are added in quadrature.
 */
export function aggregateScan(
  front: readonly FrontFrameMeasure[],
  side: readonly SideFrameMeasure[],
): AggregatedScan {
  const measurements: AggregatedScan['measurements'] = {};
  const missing: AggregatedScan['missing'] = {};
  const frontWidthCm = medianProfile(front.map((f) => f.widthsCm));
  const sideDepthCm = medianProfile(side.map((s) => s.depthsCm));
  const girthCm = girthProfile(frontWidthCm, sideDepthCm);

  for (const name of GIRTH_NAMES) {
    const band = STATURE_BANDS[name];
    const best = bandExtreme(girthCm, band);
    if (!best) {
      const bins = PROFILE_FRACTIONS.map((f, k) => ({ f, k })).filter(
        ({ f }) => f >= band.lo - 1e-9 && f <= band.hi + 1e-9,
      );
      const frontOk = bins.some(({ k }) => Number.isFinite(frontWidthCm[k]));
      const sideOk = bins.some(({ k }) => Number.isFinite(sideDepthCm[k]));
      const allMerged =
        front.length > 0 && bins.every(({ k }) => front.every((f) => f.mergedBins[k]));
      missing[name] = !frontOk
        ? allMerged
          ? `arms touched the torso in every front row of the ${pct(band.lo)}–${pct(band.hi)} % band`
          : `no valid front torso width in the ${pct(band.lo)}–${pct(band.hi)} % band`
        : !sideOk
          ? `no valid side depth in the ${pct(band.lo)}–${pct(band.hi)} % band`
          : `front and side profiles share no valid row in the ${pct(band.lo)}–${pct(band.hi)} % band`;
      continue;
    }
    const perFront = front.map(
      (f) => bandExtreme(girthProfile(f.widthsCm, sideDepthCm), band)?.value ?? NaN,
    );
    const perSide = side.map(
      (s) => bandExtreme(girthProfile(frontWidthCm, s.depthsCm), band)?.value ?? NaN,
    );
    const spread = Math.hypot(robustSigma(perFront), robustSigma(perSide));
    measurements[name] = {
      value_cm: best.value,
      spread_cm: spread,
      frames: Math.min(
        perFront.filter((v) => Number.isFinite(v)).length,
        perSide.filter((v) => Number.isFinite(v)).length,
      ),
      fraction: best.fraction,
      method:
        `ellipse (Ramanujan) of median front width × side depth, ${band.pick} over ` +
        `${pct(band.lo)}–${pct(band.hi)} % stature (found at ${(best.fraction * 100).toFixed(1)} %)`,
    };
  }

  const shoulders = front.map((f) => f.shoulderWidthCm ?? NaN).filter((v) => Number.isFinite(v));
  if (shoulders.length > 0) {
    measurements.shoulder_width_cm = {
      value_cm: median(shoulders),
      spread_cm: robustSigma(shoulders),
      frames: shoulders.length,
      method: 'straight distance between front-silhouette shoulder corners (acromion proxy)',
    };
  } else missing.shoulder_width_cm = 'no front frame had a shoulder→arm corner on both sides';

  const arms = front
    .map((f) => {
      const v = [f.armLengthCm.left, f.armLengthCm.right].filter((x): x is number => x !== null);
      return v.length ? v.reduce((p, q) => p + q, 0) / v.length : NaN;
    })
    .filter((v) => Number.isFinite(v));
  if (arms.length > 0) {
    measurements.arm_length_cm = {
      value_cm: median(arms),
      spread_cm: robustSigma(arms),
      frames: arms.length,
      method:
        'front-view 2D polyline shoulder corner → elbow landmark → wrist landmark, mean of both arms',
    };
  } else missing.arm_length_cm = 'no front frame had a shoulder corner for either arm';

  return { measurements, missing, frontWidthCm, sideDepthCm, girthCm };
}
