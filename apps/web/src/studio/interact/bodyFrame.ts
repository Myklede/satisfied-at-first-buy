// Image -> body coordinates from the pose (pure, no DOM). See config.ts for the units:
// u across the body (+ toward the person's left shoulder), v down the body (0 shoulders,
// 1 hips), both in torso lengths T. Input landmarks are the contract's: normalised 0..1, origin
// top-left, NOT mirrored. Pixel aspect is applied first so distances are isotropic.
import type { Landmark2D } from '../contract';
import { BODY } from './config';

/** MediaPipe pose landmark indices used here. */
export const POSE = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftHip: 23,
  rightHip: 24,
} as const;

export interface BodyFrame {
  /** Shoulder-joint midpoint, isotropic image units (x * aspect, y; image heights). */
  ox: number;
  oy: number;
  /** Unit vector across the body (toward the left shoulder), isotropic image units. */
  ax: number;
  ay: number;
  /** Unit vector down the body (toward the hips). */
  bx: number;
  by: number;
  /** Torso length T, image heights. */
  torso: number;
  /** Width / height of the camera frame. */
  aspect: number;
  /** True when T came from the hips; false = shoulder span x BODY.torsoPerShoulder. */
  fromHips: boolean;
}

const seen = (l: Landmark2D | undefined, min: number) =>
  !!l && Number.isFinite(l.x) && Number.isFinite(l.y) && (l.visibility ?? 1) >= min;

/** Body frame of one pose, or null when the shoulders are not seen. */
export function bodyFrameFromPose(image: readonly Landmark2D[], aspect: number): BodyFrame | null {
  if (!(aspect > 0)) return null;
  const ls = image[POSE.leftShoulder],
    rs = image[POSE.rightShoulder];
  if (!seen(ls, BODY.minShoulderVisibility) || !seen(rs, BODY.minShoulderVisibility)) return null;
  const lx = ls.x * aspect,
    ly = ls.y,
    rx = rs.x * aspect,
    ry = rs.y,
    ox = (lx + rx) / 2,
    oy = (ly + ry) / 2,
    span = Math.hypot(lx - rx, ly - ry);
  if (!(span > 1e-4)) return null;
  // Across: right shoulder -> left shoulder. Down: perpendicular, turned toward +y (image down).
  let ax = (lx - rx) / span,
    ay = (ly - ry) / span;
  let bx = -ay,
    by = ax;
  if (by < 0) {
    bx = -bx;
    by = -by;
  }
  const lh = image[POSE.leftHip],
    rh = image[POSE.rightHip];
  let torso = span * BODY.torsoPerShoulder,
    fromHips = false;
  if (seen(lh, BODY.minHipVisibility) && seen(rh, BODY.minHipVisibility)) {
    const hx = ((lh.x + rh.x) / 2) * aspect,
      hy = (lh.y + rh.y) / 2,
      t = Math.hypot(hx - ox, hy - oy);
    // A hip line above the shoulders or a torso shorter than half the shoulder span is a
    // misdetection (hips out of frame guessed by the model): keep the fallback.
    if (t > span * 0.5 && hy > oy) {
      torso = t;
      fromHips = true;
      // Down along the torso (handles a lean); across stays perpendicular to it.
      bx = (hx - ox) / t;
      by = (hy - oy) / t;
      const nx = by,
        ny = -bx;
      // Keep "across" pointing toward the left shoulder.
      const s = nx * (lx - rx) + ny * (ly - ry) >= 0 ? 1 : -1;
      ax = nx * s;
      ay = ny * s;
    }
  }
  return { ox, oy, ax, ay, bx, by, torso, aspect, fromHips };
}

/** Image point (normalised, not mirrored) -> body (u, v) in torso lengths. */
export function toBody(frame: BodyFrame, p: Landmark2D): { u: number; v: number } {
  const dx = p.x * frame.aspect - frame.ox,
    dy = p.y - frame.oy;
  return {
    u: (dx * frame.ax + dy * frame.ay) / frame.torso,
    v: (dx * frame.bx + dy * frame.by) / frame.torso,
  };
}

/** Body (u, v) -> image point (normalised, not mirrored). Inverse of toBody. */
export function fromBody(frame: BodyFrame, u: number, v: number): Landmark2D {
  const x = frame.ox + (u * frame.ax + v * frame.bx) * frame.torso,
    y = frame.oy + (u * frame.ay + v * frame.by) * frame.torso;
  return { x: x / frame.aspect, y };
}

/** Exponential blend of two frames (a toward b by k), re-normalising the axes. */
export function blendFrames(a: BodyFrame | null, b: BodyFrame, k: number): BodyFrame {
  if (!a || a.aspect !== b.aspect) return b;
  const mix = (p: number, q: number) => p + (q - p) * k;
  let ax = mix(a.ax, b.ax),
    ay = mix(a.ay, b.ay);
  const an = Math.hypot(ax, ay) || 1;
  ax /= an;
  ay /= an;
  let bx = mix(a.bx, b.bx),
    by = mix(a.by, b.by);
  const bn = Math.hypot(bx, by) || 1;
  bx /= bn;
  by /= bn;
  return {
    ox: mix(a.ox, b.ox),
    oy: mix(a.oy, b.oy),
    ax,
    ay,
    bx,
    by,
    torso: mix(a.torso, b.torso),
    aspect: b.aspect,
    fromHips: b.fromHips,
  };
}
