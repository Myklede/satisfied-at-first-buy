// Finishing-pass geometry (agent V4): from one frame's MediaPipe landmarks to the shapes the
// finisher's shader tests per pixel. Pure, no DOM, no GL; all in source-image pixels (origin top
// left, y down). `regionAt` is the CPU reference of the shader's region test (shaders.ts) and is
// what the unit tests pin.
import type { ImageLandmark } from '../../contract';
import { CUFF, FRONTAL_NOSE, HEAD, MIN_VISIBILITY, REGION } from './config';

export type Vec2 = [number, number];
/** A source-pixel box. */
export type Rect = { x: number; y: number; w: number; h: number };

/**
 * An arm capsule a → b of `radius`; `flatEnd` cuts it flat at b (the wrist: no hand),
 * `flatStart` flat at a (the shoulder: the torso quad covers the shoulder top, and a round cap
 * there filled a hoodie's hood bunched above the shoulder, cam-tshirt 12.5 s).
 */
export type ArmSegment = {
  a: Vec2;
  b: Vec2;
  radius: number;
  flatEnd: boolean;
  flatStart?: boolean;
};

/** A real-hand capsule (the compositor's HandCapsule, source px). */
export type HandShape = { a: Vec2; b: Vec2; radius: number };

/** One sleeve end: the wrist, the forearm direction (unit, elbow → wrist), opening size. */
export type CuffShape = {
  wrist: Vec2;
  dir: Vec2;
  /** Half-width of the sleeve opening (px). */
  halfWidth: number;
  /** Apparent depth of the opening ellipse as a fraction of the half-width (0..1). */
  depth: number;
};

export type FinishGeometry = {
  /** Shoulder-landmark span (px); every size is relative to it. */
  span: number;
  /** Convex torso quad, corners in order (left shoulder, right shoulder, right hip, left hip). */
  torso: [Vec2, Vec2, Vec2, Vec2] | null;
  /**
   * Shoulder band above the torso quad (REGION.bandUpOfChin): clothes class only. Corners in
   * order (left bottom, right bottom, right top, left top).
   */
  band: [Vec2, Vec2, Vec2, Vec2] | null;
  /** Up to four arm capsules: [left upper, left fore, right upper, right fore]; null = not seen. */
  arms: (ArmSegment | null)[];
  /**
   * Head exclusion: an ellipse round the nose, half-width `radius`, reaching `up` px above the nose
   * (hair) and down to the chin line `chinY`.
   */
  head: { centre: Vec2; radius: number; up: number; chinY: number } | null;
  /**
   * Neck exclusion (used without the class mask): a capsule from the mid-shoulder `a` to the chin
   * point `b`, radius `halfWidth`; `up` = unit mid-hip → mid-shoulder.
   */
  neck: { a: Vec2; b: Vec2; up: Vec2; halfWidth: number } | null;
  /** Real hands per side [left, right] (MediaPipe's left = the person's left). */
  hands: (HandShape | null)[];
  /** Sleeve ends per side [left, right]. */
  cuffs: (CuffShape | null)[];
};

const seen = (l: ImageLandmark | undefined): l is ImageLandmark =>
  !!l && l.visibility >= MIN_VISIBILITY && Number.isFinite(l.x) && Number.isFinite(l.y);
const v = (l: ImageLandmark): Vec2 => [l.x, l.y];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const scale = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const unit = (a: Vec2): Vec2 => {
  const n = len(a);
  return n > 1e-9 ? [a[0] / n, a[1] / n] : [0, 0];
};
const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];

/**
 * The finishing geometry of a frame, or null when the shoulders are not both seen (no scale).
 * `hands` are the compositor's real-hand capsules; each is assigned to the nearer wrist.
 */
export function finishGeometry(
  l: readonly ImageLandmark[] | null,
  hands: readonly { a: Vec2 | number[]; b: Vec2 | number[]; radius: number }[] = [],
): FinishGeometry | null {
  if (!l || l.length < 25) return null;
  const ls = l[11],
    rs = l[12];
  if (!seen(ls) || !seen(rs)) return null;
  const L = v(ls),
    R = v(rs);
  const span = len(sub(L, R));
  if (span < 8) return null;
  const midS = mid(L, R);
  const across = unit(sub(L, R)); // right shoulder → left shoulder

  // Torso: needs both hips. Up = mid-hip → mid-shoulder.
  let torso: FinishGeometry['torso'] = null;
  let up: Vec2 = [-across[1], across[0]];
  // Image y is down: "up" must point to smaller y. Fix the perpendicular's sign that way.
  if (up[1] > 0) up = [-up[0], -up[1]];
  const lh = l[23],
    rh = l[24];
  if (seen(lh) && seen(rh)) {
    const LH = v(lh),
      RH = v(rh);
    const midH = mid(LH, RH);
    const torsoLen = len(sub(midS, midH));
    if (torsoLen > 4) {
      up = unit(sub(midS, midH));
      const lift = scale(up, REGION.topLiftOfTorso * torsoLen);
      const widen = REGION.shoulderWidenOfSpan * span,
        hipWiden = REGION.hipWidenOfSpan * span;
      const hipAcross = unit(sub(LH, RH));
      torso = [
        add(add(L, lift), scale(across, widen)),
        add(add(R, lift), scale(across, -widen)),
        add(RH, scale(hipAcross, -hipWiden)),
        add(LH, scale(hipAcross, hipWiden)),
      ];
    }
  }

  // Arms: shoulder → elbow → wrist, each segment only when both ends are seen.
  const r = REGION.armRadiusOfSpan * span;
  const seg = (a: number, b: number, flatStart: boolean, flatEnd: boolean): ArmSegment | null =>
    seen(l[a]) && seen(l[b]) ? { a: v(l[a]), b: v(l[b]), radius: r, flatStart, flatEnd } : null;
  const arms = [
    seg(11, 13, true, false),
    seg(13, 15, false, true),
    seg(12, 14, true, false),
    seg(14, 16, false, true),
  ];

  // Head: the nose, ears or eyes for its size, the mouth for the chin.
  let head: FinishGeometry['head'] = null;
  const nose = l[0];
  if (seen(nose)) {
    const ears = seen(l[7]) && seen(l[8]) ? len(sub(v(l[7]), v(l[8]))) : 0;
    const eyes = seen(l[3]) && seen(l[6]) ? len(sub(v(l[3]), v(l[6]))) : 0;
    const radius = Math.max(
      HEAD.radiusOfEars * ears,
      HEAD.radiusOfEyes * eyes,
      HEAD.radiusOfSpan * span,
    );
    let chinY = nose.y + radius * 0.6;
    if (seen(l[9]) && seen(l[10])) {
      const mouth = (l[9].y + l[10].y) / 2;
      chinY = mouth + HEAD.chinFromMouth * Math.max(0, mouth - nose.y);
    }
    head = { centre: v(nose), radius, up: HEAD.upOfRadius * radius, chinY };
  }

  const neckTop: Vec2 = head ? [head.centre[0], head.chinY] : add(midS, scale(up, 0.35 * span));
  const neck = { a: midS, b: neckTop, up, halfWidth: HEAD.neckHalfWidthOfSpan * span };

  // Cuffs: forearm direction and foreshortening (2D length vs the expected forearm).
  const cuff = (e: number, w: number): CuffShape | null => {
    if (!seen(l[e]) || !seen(l[w])) return null;
    const fore = sub(v(l[w]), v(l[e]));
    const n = len(fore);
    if (n < 2) return null;
    const ratio = Math.min(1, n / (CUFF.forearmOfSpan * span));
    return {
      wrist: v(l[w]),
      dir: scale(fore, 1 / n),
      halfWidth: CUFF.halfWidthOfSpan * span,
      depth: Math.max(CUFF.minDepth, Math.sqrt(1 - ratio * ratio)),
    };
  };
  const cuffs = [cuff(13, 15), cuff(14, 16)];

  // Hands: assign each capsule to the nearer seen wrist (the compositor skips unseen hands).
  const sides: (HandShape | null)[] = [null, null];
  for (const h of hands) {
    const a: Vec2 = [Number(h.a[0]), Number(h.a[1])],
      b: Vec2 = [Number(h.b[0]), Number(h.b[1])];
    if (![...a, ...b, h.radius].every(Number.isFinite) || h.radius <= 0) continue;
    const dl = seen(l[15]) ? len(sub(a, v(l[15]))) : Infinity;
    const dr = seen(l[16]) ? len(sub(a, v(l[16]))) : Infinity;
    const side = dl <= dr ? 0 : 1;
    if (!Number.isFinite(Math.min(dl, dr))) continue;
    sides[side] = { a, b, radius: h.radius };
  }

  // Shoulder band: above the torso top edge, widened by the arm radius, up toward the chin.
  let band: FinishGeometry['band'] = null;
  if (torso) {
    const topDir = unit(sub(torso[0], torso[1]));
    let bandUp: Vec2 = [topDir[1], -topDir[0]];
    if (bandUp[1] > 0) bandUp = [-bandUp[0], -bandUp[1]];
    const lb = add(torso[0], scale(topDir, r)),
      rb = add(torso[1], scale(topDir, -r));
    const toChin = head
      ? dot(sub(midS, [head.centre[0], head.chinY]), [-bandUp[0], -bandUp[1]])
      : 0;
    const torsoLen = len(sub(midS, mid(torso[2], torso[3])));
    const h =
      head && toChin > 0 ? REGION.bandUpOfChin * toChin : REGION.bandUpOfTorsoNoFace * torsoLen;
    band = [lb, rb, add(rb, scale(bandUp, h)), add(lb, scale(bandUp, h))];
  }

  return { span, torso, band, arms, head, neck, hands: sides, cuffs };
}

/** True when p is inside the head ellipse (above the nose: `up`; below: down to the chin). */
export function inHead(p: Vec2, h: NonNullable<FinishGeometry['head']>) {
  const dx = (p[0] - h.centre[0]) / h.radius;
  const below = p[1] >= h.centre[1];
  const ry = below ? Math.max(h.chinY - h.centre[1], 0.5 * h.radius) : h.up;
  const dy = (p[1] - h.centre[1]) / ry;
  return dx * dx + dy * dy < 1;
}

/** True when p is inside the convex quad (either winding). */
export function inConvexQuad(p: Vec2, q: readonly Vec2[]) {
  let pos = true,
    neg = true;
  for (let i = 0; i < 4; i++) {
    const s = cross(sub(q[(i + 1) % 4], q[i]), sub(p, q[i]));
    if (s < 0) pos = false;
    if (s > 0) neg = false;
  }
  return pos || neg;
}

/** True when p is inside the capsule (flat-capped at a / b when flatStart / flatEnd). */
export function inArm(p: Vec2, s: ArmSegment) {
  const ab = sub(s.b, s.a);
  const L2 = Math.max(dot(ab, ab), 1e-9);
  const h = dot(sub(p, s.a), ab) / L2;
  if ((s.flatEnd && h > 1) || (s.flatStart && h < 0)) return false;
  const c = Math.min(1, Math.max(0, h));
  return len(sub(p, add(s.a, scale(ab, c)))) <= s.radius;
}

export type RegionHit = {
  /** Inside the upper-body region (torso or arms), after the exclusions. */
  inside: boolean;
  /** Only in the shoulder band: counts only where the class mask says clothes. */
  bandOnly: boolean;
  /** The arm segment's unit direction when p is in an arm capsule, else null. */
  armDir: Vec2 | null;
  /** Why p was excluded, if it was. */
  excluded: 'head' | 'neck' | null;
};

/**
 * CPU reference of the shader's region test. `useNeck` = no class mask (the neck exclusion then
 * stands in for "this is skin, not clothes").
 */
export function regionAt(g: FinishGeometry, p: Vec2, useNeck: boolean): RegionHit {
  let inside = !!g.torso && inConvexQuad(p, g.torso);
  let armDir: Vec2 | null = null;
  for (const s of g.arms) {
    if (s && inArm(p, s)) {
      inside = true;
      armDir = unit(sub(s.b, s.a));
    }
  }
  let bandOnly = false;
  if (!inside && g.band && inConvexQuad(p, g.band)) {
    inside = true;
    bandOnly = true;
  }
  if (g.head && inHead(p, g.head))
    return { inside: false, bandOnly: false, armDir: null, excluded: 'head' };
  if (
    useNeck &&
    g.neck &&
    inArm(p, { a: g.neck.a, b: g.neck.b, radius: g.neck.halfWidth, flatEnd: false })
  )
    return { inside: false, bandOnly: false, armDir: null, excluded: 'neck' };
  return { inside, bandOnly, armDir: inside ? armDir : null, excluded: null };
}

/**
 * The sleeve end along a cuff's forearm axis, from a jacket-alpha lookup (CPU reference of the
 * shader's march): the far end of the first jacket run from `marchFrom` to `marchTo` half-widths.
 * Returns the distance from the wrist (px, + = toward the hand), or null when there is no sleeve
 * on the axis or the sleeve runs past the march (over other jacket: unresolved).
 */
export function sleeveEnd(c: CuffShape, alphaAt: (x: number, y: number) => number, steps = 14) {
  let end: number | null = null;
  for (let k = 0; k <= steps; k++) {
    const t = (CUFF.marchFrom + ((CUFF.marchTo - CUFF.marchFrom) * k) / steps) * c.halfWidth;
    const a = alphaAt(c.wrist[0] + c.dir[0] * t, c.wrist[1] + c.dir[1] * t);
    if (a > 0.5) end = t;
    else if (end !== null) return end;
  }
  return end !== null && end >= CUFF.marchTo * c.halfWidth - 1e-6 ? null : end;
}

/** The face-skin crop (cheeks, nose, upper lip) in source px, or null. */
export function faceBox(l: readonly ImageLandmark[], W: number, H: number): Rect | null {
  const nose = l[0],
    m9 = l[9],
    m10 = l[10],
    e2 = l[2],
    e5 = l[5];
  if (![nose, m9, m10, e2, e5].every((p) => p && p.visibility >= MIN_VISIBILITY)) return null;
  const mouthY = (m9.y + m10.y) / 2;
  const eyes = Math.hypot(e2.x - e5.x, e2.y - e5.y);
  if (eyes < 4) return null;
  const cx = nose.x,
    cy = (nose.y + mouthY) / 2 - 0.1 * eyes;
  const hw = 0.6 * eyes,
    hh = Math.max(2, 0.75 * Math.abs(mouthY - nose.y) + 0.15 * eyes);
  // The whole box must be in the frame (a face cut by the frame edge is not a reference).
  if (cx - hw < 0 || cy - hh < 0 || cx + hw > W || cy + hh > H) return null;
  return { x: cx - hw, y: cy - hh, w: 2 * hw, h: 2 * hh };
}

/** Frontal face: the nose within FRONTAL_NOSE eye spacings of the eyes' midpoint (2D). */
export function frontal(l: readonly ImageLandmark[]) {
  const nose = l[0],
    e2 = l[2],
    e5 = l[5];
  if (![nose, e2, e5].every((p) => p && p.visibility >= MIN_VISIBILITY)) return false;
  const eyes = Math.hypot(e2.x - e5.x, e2.y - e5.y);
  return eyes > 4 && Math.abs(nose.x - (e2.x + e5.x) / 2) <= FRONTAL_NOSE * eyes;
}

export function midShoulder(l: readonly ImageLandmark[] | null): [number, number] | null {
  const a = l?.[11],
    b = l?.[12];
  if (!a || !b || Math.min(a.visibility, b.visibility) < MIN_VISIBILITY) return null;
  return [(a.x + b.x) / 2, (a.y + b.y) / 2];
}

/** The upper body's box (head, shoulders, arms, hips) padded by 0.3 S, in source px. */
export function upperBodyRect(
  l: readonly ImageLandmark[] | null,
  span: number,
  frame: { width: number; height: number },
): Rect | null {
  if (!l) return null;
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (let i = 0; i <= 24; i++) {
    const p = l[i];
    if (!p || p.visibility < MIN_VISIBILITY) continue;
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  if (!Number.isFinite(x0)) return null;
  const pad = 0.3 * span;
  const x = Math.max(0, x0 - pad),
    y = Math.max(0, y0 - pad);
  const w = Math.min(frame.width, x1 + pad) - x,
    h = Math.min(frame.height, y1 + pad) - y;
  return w > 8 && h > 8 ? { x, y, w, h } : null;
}
