// Rigid torso glue (agent F3, user verdict 22:05 "the parka wobbles like jelly"; ?f3rigid=1).
// Pure apart from the filter's own state.
//
// The torso layer was glued with a free-form MLS warp of ~20 control points (shoulders, hips,
// contour rows, hem anchors) re-solved every frame: each landmark's frame-to-frame noise bent the
// rendered jacket a little differently, so a stiff quilted coat jiggled like jelly. A stiff coat
// moves as a near-rigid body with the torso. Here the torso layer is placed by ONE similarity
// (scale, rotation, translation) fitted to the four torso points (shoulders, hips), filtered in
// time (One Euro on position and angle; the scale held inside a backlash band so it never pumps;
// exactly held while the shared stillness says still), plus at most a small, slow horizontal
// width factor from the contour fit so the sides still meet the silhouette.
import { OneEuroFilter } from '@satisfy/vision';
import type { Control, Pt } from './warp';

/** x' = q + s·R(θ)·(x − c), with an optional width factor along the torso's own x axis. */
export type Similarity = {
  s: number;
  theta: number;
  c: Pt;
  q: Pt;
  /** Horizontal (torso-frame) width factor − 1 (0 = a pure similarity). */
  width: number;
};

export const IDENTITY: Similarity = { s: 1, theta: 0, c: [0, 0], q: [0, 0], width: 0 };

/** Least-squares 2D similarity p → q (Umeyama), weighted by importance; null below 2 points. */
export function fitSimilarity(controls: readonly Control[]): Similarity | null {
  if (controls.length < 2) return null;
  let sw = 0,
    cx = 0,
    cy = 0,
    qx = 0,
    qy = 0;
  for (const k of controls) {
    const w = k.importance ?? 1;
    sw += w;
    cx += w * k.p[0];
    cy += w * k.p[1];
    qx += w * k.q[0];
    qy += w * k.q[1];
  }
  cx /= sw;
  cy /= sw;
  qx /= sw;
  qy /= sw;
  let a = 0,
    b = 0,
    pp = 0;
  for (const k of controls) {
    const w = k.importance ?? 1;
    const px = k.p[0] - cx,
      py = k.p[1] - cy,
      ux = k.q[0] - qx,
      uy = k.q[1] - qy;
    a += w * (px * ux + py * uy);
    b += w * (px * uy - py * ux);
    pp += w * (px * px + py * py);
  }
  if (pp < 1e-9) return { s: 1, theta: 0, c: [cx, cy], q: [qx, qy], width: 0 };
  return {
    s: Math.hypot(a, b) / pp,
    theta: Math.atan2(b, a),
    c: [cx, cy],
    q: [qx, qy],
    width: 0,
  };
}

/** Where the transform sends point p. */
export function applySimilarity(t: Similarity, p: Pt): Pt {
  const cos = Math.cos(t.theta),
    sin = Math.sin(t.theta);
  // Torso frame: undo the rotation, stretch x, rotate back (width along the torso's own x).
  let x = p[0] - t.c[0],
    y = p[1] - t.c[1];
  if (t.width) {
    const lx = cos * x + sin * y,
      ly = -sin * x + cos * y;
    const sx = lx * (1 + t.width);
    x = cos * sx - sin * ly;
    y = sin * sx + cos * ly;
  }
  return [t.q[0] + t.s * (cos * x - sin * y), t.q[1] + t.s * (sin * x + cos * y)];
}

/**
 * Filters (and holds) the torso transform. Params: position and angle One Euro (px and rad),
 * the scale backlash band (fraction) and the width factor's time constant and cap.
 */
export const RIGID = {
  position: { minCutoff: 1.2, beta: 0.04, dCutoff: 1 },
  angle: { minCutoff: 1.0, beta: 0.6, dCutoff: 1 },
  scaleBand: 0.015,
  widthTauS: 0.4,
  widthCap: 0.06,
  /** Narrowing may go further than widening: a 3D body fuller than the person (lead 23:2x). */
  widthCapIn: 0.15,
  /**
   * Turned (the drawn heading > this many degrees from facing or from the back): the drawn scale
   * and width stay at their last frontal values. In profile MediaPipe's 2D shoulder-to-hip length
   * grows 7-12 % at an unchanged distance (F1, live5 RC4 rows) and the contour's sides move, so a
   * fitted scale would draw the jacket bigger exactly while turning (user complaint J3, lead 22:35).
   */
  turnHoldDeg: 25,
  /** ... unless the fitted scale stays this far off for turnAcceptMs (walking while turned). */
  turnAcceptRatio: 0.12,
  turnAcceptMs: 800,
  /**
   * While the drawn heading turns faster than this (deg/s; ~3 deg per frame at 24 fps) the
   * position and angle pass unfiltered (the filters re-seed on the raw values): no lag added in
   * a turn (lead, RC5c judge strip: the jacket still at three-quarter after the body faced front).
   */
  turnBypassDegS: 70,
};

export class RigidFilter {
  private qx = new OneEuroFilter(RIGID.position);
  private qy = new OneEuroFilter(RIGID.position);
  private theta = new OneEuroFilter(RIGID.angle);
  private scale?: number;
  private width = 0;
  private last?: Similarity;
  private lastT?: number;
  /** Since when (ms) a turned frame's fitted scale has been beyond turnAcceptRatio. */
  private offSince?: number;
  private lastHeading?: number;

  reset() {
    this.qx = new OneEuroFilter(RIGID.position);
    this.qy = new OneEuroFilter(RIGID.position);
    this.theta = new OneEuroFilter(RIGID.angle);
    this.scale = undefined;
    this.width = 0;
    this.last = undefined;
    this.lastT = undefined;
    this.offSince = undefined;
    this.lastHeading = undefined;
  }

  /**
   * The transform to draw this frame (t in ms). `width` is the wanted width factor − 1;
   * `headingDeg` the drawn turn (0 facing, ±180 the back; null/undefined = unknown, no hold).
   */
  apply(
    raw: Similarity,
    t: number,
    still: boolean,
    width = 0,
    headingDeg?: number | null,
  ): Similarity {
    if (still && this.last) return this.last;
    const dt = this.lastT === undefined ? 0 : Math.max(0, (t - this.lastT) / 1000);
    this.lastT = t;
    // Turning fast: no smoothing (re-seed the filters on the raw values).
    let fast = false;
    if (headingDeg != null) {
      if (this.lastHeading !== undefined && dt > 0) {
        const step = Math.abs(((headingDeg - this.lastHeading + 540) % 360) - 180);
        fast = step / dt > RIGID.turnBypassDegS;
      }
      this.lastHeading = headingDeg;
    }
    if (fast) {
      this.qx.reset();
      this.qy.reset();
      this.theta.reset();
    }
    const h = headingDeg == null ? 0 : Math.abs(headingDeg) % 360;
    const turned = Math.min(h, Math.abs(180 - h)) > RIGID.turnHoldDeg;
    let hold = false;
    if (turned && this.scale !== undefined) {
      const off = Math.abs(raw.s / this.scale - 1) > RIGID.turnAcceptRatio;
      if (!off) this.offSince = undefined;
      else this.offSince ??= t;
      hold = this.offSince === undefined || t - this.offSince < RIGID.turnAcceptMs;
    } else this.offSince = undefined;
    // Scale: a backlash band, so noise inside it never moves the drawn size.
    let s = this.scale ?? raw.s;
    if (hold) {
      // turned: keep the frontal size
    } else if (raw.s > s * (1 + RIGID.scaleBand)) s = raw.s / (1 + RIGID.scaleBand);
    else if (raw.s < s * (1 - RIGID.scaleBand)) s = raw.s / (1 - RIGID.scaleBand);
    this.scale = s;
    const k = dt > 0 && !turned ? 1 - Math.exp(-dt / RIGID.widthTauS) : dt > 0 ? 0 : 1;
    const w = Math.max(-RIGID.widthCapIn, Math.min(RIGID.widthCap, width));
    this.width += k * (w - this.width);
    // Unwrap the angle against the last one before filtering.
    let th = raw.theta;
    if (this.last)
      th = this.last.theta + (((th - this.last.theta + Math.PI * 3) % (2 * Math.PI)) - Math.PI);
    const out: Similarity = {
      s,
      theta: this.theta.filter(th, t),
      c: raw.c,
      q: [this.qx.filter(raw.q[0], t), this.qy.filter(raw.q[1], t)],
      width: this.width,
    };
    this.last = out;
    return out;
  }
}

type Landmark = { x: number; y: number; visibility?: number };

/**
 * Both arms hang by the sides (image landmarks, MediaPipe indices): elbows below the shoulders,
 * wrists below the elbows, both within a share of the shoulder span of their shoulder's x (not
 * crossed, not raised; a walking swing still counts). ?f3rigid=1 fits the drawn shoulder span to the real one only then:
 * crossed arms pull the shoulder landmarks in and the jacket's sides would uncover.
 */
export function armsHanging(l: readonly Landmark[] | null | undefined): boolean {
  if (!l || l.length < 17) return false;
  const span = Math.abs(l[11].x - l[12].x),
    mid = (l[11].x + l[12].x) / 2;
  if (!(span > 1)) return false;
  for (const [s, e, w] of [
    [11, 13, 15],
    [12, 14, 16],
  ] as const) {
    const S = l[s],
      E = l[e],
      W = l[w];
    if ([S, E, W].some((p) => (p.visibility ?? 1) < 0.5)) return false;
    if (!(E.y > S.y && W.y > E.y)) return false;
    // Outward (away from the body's middle) up to 0.4 / 0.6 of the span: a swinging arm still
    // hangs; inward past 0.3 of the span the forearm crosses the body.
    const out = Math.sign(S.x - mid) || 1;
    const de = (E.x - S.x) * out,
      dw = (W.x - S.x) * out;
    if (de > 0.4 * span || dw > 0.6 * span || de < -0.3 * span || dw < -0.3 * span) return false;
  }
  return true;
}
