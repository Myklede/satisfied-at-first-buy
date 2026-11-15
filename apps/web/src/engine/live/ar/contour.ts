// Contour fit for the AR glue (agent V2): the jacket's torso sides follow the person's real
// silhouette, keeping the jacket's own 3D ease over the body. Pure; image pixels throughout.
//
// Per row between the shoulder and hip lines, on each side:
//   jacket edge  = the outermost projected jacket TORSO particle in the row band;
//   body edge    = the outermost projected posed-body TORSO vertex in the band;
//   person edge  = the person mask's edge, walked out from the row's centre (clamped to
//                  [minX, maxX] so a raised or hanging arm is never taken for the torso);
//   target       = person edge + (jacket edge − body edge), i.e. the 3D body's silhouette is
//                  registered to the real one and the garment keeps the ease computed in 3D (a
//                  T-shirt wearer gets the puffer's loft outside their T-shirt, never inside it).
// A side is skipped when an arm segment (shoulder→elbow→wrist landmarks) runs within
// `armRadius` of the person edge there: the mask cannot tell the arm from the torso.

export interface ContourMask {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface ContourInput {
  /** Image rows (px) to fit. */
  rows: readonly number[];
  /** Half height of a row band, px. */
  band: number;
  /** Projected jacket torso particles, [u0, v0, u1, v1, …] px. */
  jacket: ArrayLike<number>;
  /** Projected posed-body torso vertices, [u0, v0, …] px. */
  body: ArrayLike<number>;
  mask: ContourMask;
  /** Frame size in px (the mask is resampled to it). */
  width: number;
  height: number;
  /** The person-edge walk stays within [minX, maxX] px. */
  minX: number;
  maxX: number;
  /** Arm polylines (shoulder, elbow, wrist landmarks, px), any number; skipped when empty. */
  arms: readonly (readonly [number, number])[][];
  /** An arm closer than this to the person edge makes that side unusable, px. */
  armRadius: number;
}

export interface ContourSide {
  /** Index into `rows`, and the row (px). */
  index: number;
  row: number;
  side: 'L' | 'R';
  /** The jacket's edge point (the control's source), px. */
  jacket: [number, number];
  bodyX: number;
  personX: number;
  /** Where the jacket edge should be on this row, px. */
  targetX: number;
}

/** Distance from point p to segment ab, px. */
function segmentDistance(p: readonly number[], a: readonly number[], b: readonly number[]) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Leftmost and rightmost points of `points` within `band` of row y, or null. */
function extremes(points: ArrayLike<number>, y: number, band: number) {
  let min = Infinity,
    max = -Infinity,
    minY = y,
    maxY = y;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const v = points[i + 1];
    if (Math.abs(v - y) > band) continue;
    const u = points[i];
    if (u < min) {
      min = u;
      minY = v;
    }
    if (u > max) {
      max = u;
      maxY = v;
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max, minY, maxY } : null;
}

/** The contour targets for every usable row and side. */
export function contourTargets(input: ContourInput): ContourSide[] {
  const { mask, width: W, height: H } = input;
  const person = (x: number, y: number) => {
    const mx = Math.min(mask.width - 1, Math.max(0, Math.floor((x / W) * mask.width)));
    const my = Math.min(mask.height - 1, Math.max(0, Math.floor((y / H) * mask.height)));
    return mask.data[my * mask.width + mx] >= 0.5;
  };
  const step = Math.max(1, W / mask.width / 2);
  const nearArm = (x: number, y: number) =>
    input.arms.some((arm) => {
      for (let i = 0; i + 1 < arm.length; i++)
        if (segmentDistance([x, y], arm[i], arm[i + 1]) < input.armRadius) return true;
      return false;
    });
  const out: ContourSide[] = [];
  for (const [index, y] of input.rows.entries()) {
    if (y < 0 || y >= H) continue;
    const j = extremes(input.jacket, y, input.band);
    const b = extremes(input.body, y, input.band);
    if (!j || !b) continue;
    const centre = (b.min + b.max) / 2;
    if (!person(centre, y)) continue;
    let left = centre,
      right = centre;
    const lo = Math.max(0, input.minX),
      hi = Math.min(W - 1, input.maxX);
    while (left - step >= lo && person(left - step, y)) left -= step;
    while (right + step <= hi && person(right + step, y)) right += step;
    if (!nearArm(left, y))
      out.push({
        index,
        row: y,
        side: 'L',
        jacket: [j.min, j.minY],
        bodyX: b.min,
        personX: left,
        targetX: left - Math.max(0, b.min - j.min),
      });
    if (!nearArm(right, y))
      out.push({
        index,
        row: y,
        side: 'R',
        jacket: [j.max, j.maxY],
        bodyX: b.max,
        personX: right,
        targetX: right + Math.max(0, j.max - b.max),
      });
  }
  return out;
}

/**
 * Per row/side hold against pumping: the applied shift moves only when the wanted one leaves a
 * ±deadband window around it (backlash), and is limited to ±cap.
 */
export class ContourHold {
  private held = new Map<string, number>();
  constructor(
    private deadband: number,
    private cap: number,
  ) {}
  apply(key: string, wanted: number, cap = this.cap): number {
    const w = Math.max(-cap, Math.min(cap, wanted));
    let h = this.held.get(key) ?? w;
    if (w > h + this.deadband) h = w - this.deadband;
    else if (w < h - this.deadband) h = w + this.deadband;
    this.held.set(key, h);
    return h;
  }
  reset() {
    this.held.clear();
  }
}
