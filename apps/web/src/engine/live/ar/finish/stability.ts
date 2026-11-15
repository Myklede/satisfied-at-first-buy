// Rest stability of the finishing pass (agent V4). User, 2026-11-13: "standing still, the jacket
// keeps moving slightly, it reads as fake". The finisher's own sources of change at rest: the
// person / class mask edges (model noise frame to frame), the segmenter crop box (landmark
// jitter), the colour grade (measurement noise) and the grain. When the person is still, masks
// are blended over time and the grade holds; when they move, everything follows at once (gated by
// the landmarks' own motion, so moving edges never lag). Pure, no DOM.
import { STILL } from './config';
import { MOTION_LANDMARKS, type LandmarkSnapshot } from './motion';
import type { Rect } from './geometry';

/**
 * Holds the last drawn value while the shared detector reports still. The detector owns the
 * decision; this stage has no timer, thresholds or release easing. Objects supplied by callers
 * must be snapshots (not subsequently mutated). A missing value clears the hold on tracking loss.
 */
export class RestHold<T> {
  private value: T | null = null;

  update(next: T | null, still: boolean): T | null {
    if (next === null || !still || this.value === null) this.value = next;
    return this.value;
  }

  reset() {
    this.value = null;
  }
}

/** The largest landmark displacement between two snapshots, as a fraction of the span. */
export function motionOfSpan(
  prev: LandmarkSnapshot | null,
  now: LandmarkSnapshot | null,
  span: number,
): number | null {
  if (!prev || !now || !(span > 0)) return null;
  let worst = -1;
  for (const i of MOTION_LANDMARKS) {
    const a = prev[i],
      b = now[i];
    if (!a || !b) continue;
    worst = Math.max(worst, Math.hypot(b[0] - a[0], b[1] - a[1]) / span);
  }
  return worst < 0 ? null : worst;
}

/** 1 = still, 0 = moving, from the per-frame motion (config STILL.motion). Unknown = moving. */
export function stillness(motion: number | null) {
  if (motion === null) return 0;
  const [lo, hi] = STILL.motion;
  return Math.min(1, Math.max(0, (hi - motion) / (hi - lo)));
}

/**
 * Temporal blend of a byte mask into a float accumulator (acc += a·(next − acc)) and its rounded
 * bytes into `out`. a = 1 copies.
 */
export function blendInto(acc: Float32Array, next: Uint8Array, a: number, out: Uint8Array) {
  const n = Math.min(acc.length, next.length, out.length);
  if (a >= 1) {
    // Native typed-array copies avoid the extra per-pixel JavaScript loop on every moving
    // frame. The float accumulator must still be seeded for the next stabilised frame.
    const bytes = n === next.length ? next : next.subarray(0, n);
    acc.set(bytes);
    out.set(bytes);
    return;
  }
  for (let i = 0; i < n; i++) {
    const v = acc[i] + a * (next[i] - acc[i]);
    acc[i] = v;
    out[i] = v + 0.5;
  }
}

/** The blend factor for a new mask at stillness s (1 when moving, `still` when still). */
export const blendFactor = (s: number, still: number) => 1 + (still - 1) * s;

/**
 * Box hysteresis: keeps `prev` unless an edge of `next` moved more than `tol` px (the segmenter
 * crop box jittered with the landmarks, so blended masks would not align).
 */
export function holdRect(prev: Rect | null, next: Rect, tol: number): Rect {
  if (!prev) return next;
  const moved =
    Math.abs(next.x - prev.x) > tol ||
    Math.abs(next.y - prev.y) > tol ||
    Math.abs(next.x + next.w - (prev.x + prev.w)) > tol ||
    Math.abs(next.y + next.h - (prev.y + prev.h)) > tol;
  return moved ? next : prev;
}

/** Deadband: the target changes only when the new one differs by more than `band`. */
export const deadband = (current: number, next: number, band: number) =>
  Number.isFinite(current) && Math.abs(next - current) <= band ? current : next;

/**
 * Legacy edge-normal displacement proxy between RGBA readbacks, in source px per observation:
 * summed absolute alpha change / summed gradient magnitude, times the readback's downscale.
 * Exact for an edge translating along its normal; closed silhouettes under-read the rigid
 * translation magnitude because only normal motion contributes. Do not compare this proxy to
 * the outline-motion gate; eval/measure-rest.mjs uses CX-DAY's calibrated contour ruler and
 * actual presented-camera frame deltas. Null without edges.
 */
export function edgeMotion(
  prev: Uint8Array,
  cur: Uint8Array,
  width: number,
  height: number,
  channel: number,
  scale = 1,
) {
  let change = 0,
    grad = 0;
  for (let y = 0; y < height - 1; y++)
    for (let x = 0; x < width - 1; x++) {
      const i = (y * width + x) * 4 + channel;
      const a = cur[i];
      change += Math.abs(a - prev[i]);
      grad += Math.hypot(cur[i + 4] - a, cur[i + width * 4] - a);
    }
  return grad > 0 ? (change / grad) * scale : null;
}

/**
 * Mean absolute RGB change (8-bit levels) between two premultiplied readbacks over the pixels
 * whose alpha (channel `alphaChannel` of `alphas`) is ≥ `min` in both frames. Null when none.
 */
export function colourChange(
  prev: Uint8Array,
  cur: Uint8Array,
  alphasPrev: Uint8Array,
  alphasCur: Uint8Array,
  alphaChannel: number,
  min = 250,
) {
  let sum = 0,
    n = 0;
  for (let i = 0; i < cur.length; i += 4) {
    if (alphasPrev[i + alphaChannel] < min || alphasCur[i + alphaChannel] < min) continue;
    sum +=
      (Math.abs(cur[i] - prev[i]) +
        Math.abs(cur[i + 1] - prev[i + 1]) +
        Math.abs(cur[i + 2] - prev[i + 2])) /
      3;
    n++;
  }
  return n ? sum / n : null;
}
