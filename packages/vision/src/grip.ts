// Grip features: pure geometry on MediaPipe hand landmarks (no DOM). Used by the grab classifier.
//
// All distances are divided by the hand's own size s = |wrist − middle MCP| (landmarks 0→9), so
// they do not depend on distance to the camera. World landmarks (metres, hand-centred) are used
// for 3D shape; normalised image landmarks only for the 2D occlusion cue.

import type { Landmark } from './pinch';

// MediaPipe hand topology.
export const THUMB = [1, 2, 3, 4] as const;
export const FINGERS = {
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
} as const;
export type FingerName = keyof typeof FINGERS;
export const FINGER_NAMES: readonly FingerName[] = ['index', 'middle', 'ring', 'pinky'];

export interface GripFeatures {
  /** |thumb tip − index tip| / s. */
  tipRatio: number;
  /** Min distance of the thumb tip to the index polyline 5–6–7–8, / s (tip pinch AND key grip). */
  thumbToIndex: number;
  /** Which index segment the thumb tip is closest to: 0 = 5–6, 1 = 6–7, 2 = 7–8. */
  thumbToIndexSegment: number;
  /** Min distance of the thumb tip to the middle-finger polyline 9–10–11–12, / s (wrapped fist). */
  thumbToMiddle: number;
  /** PIP + DIP flexion per finger, radians (0 = straight, ~π = fully curled). */
  curl: Record<FingerName, number>;
  /** |fingertip − palm centre| / s per finger. */
  tipToPalm: Record<FingerName, number>;
  /** |thumb tip − palm centre| / s. */
  thumbTipToPalm: number;
  /**
   * 2D image distance of the thumb tip to the index polyline / 2D hand size, with the thumb tip
   * deeper (farther from the camera) than the nearest index point: the "index covers the thumb"
   * cue. Infinity when the thumb tip is not behind the index.
   */
  occludedThumb2d: number;
  /** |z| of the palm normal in image space: 1 = palm (or back) faces the camera, 0 = edge-on. */
  palmFacing: number;
  /**
   * Thumb tip to index polyline in IMAGE space with MediaPipe's image depth (x, y, z), / 2D hand
   * size: is the contact visible to the camera? When the index hides the thumb, the world (3D)
   * landmarks still claim contact but the image puts the thumb tip far behind or beside the index:
   * 05-09-00 false grabs 0.43–0.71; real occluded/tip pinches and fists 0.13–0.22.
   */
  thumbIndexImageGap: number;
}

const sub = (a: Landmark, b: Landmark): Landmark => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Landmark, b: Landmark) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a: Landmark) => Math.sqrt(dot(a, a));
const dist = (a: Landmark, b: Landmark) => norm(sub(a, b));
const cross = (a: Landmark, b: Landmark): Landmark => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/** Angle (radians) between consecutive bones a→b and b→c: 0 when straight. */
export function flexion(a: Landmark, b: Landmark, c: Landmark): number {
  const u = sub(b, a);
  const v = sub(c, b);
  const nu = norm(u);
  const nv = norm(v);
  if (!(nu > 0 && nv > 0)) return 0;
  return Math.acos(Math.min(1, Math.max(-1, dot(u, v) / (nu * nv))));
}

/** Distance from p to segment ab, and the segment parameter t ∈ [0,1] of the closest point. */
export function pointSegment(p: Landmark, a: Landmark, b: Landmark): { d: number; t: number } {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / len2)) : 0;
  const q = { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t };
  return { d: dist(p, q), t };
}

export function palmCentre3(p: readonly Landmark[]): Landmark {
  const ids = [0, 5, 9, 13, 17];
  const c = { x: 0, y: 0, z: 0 };
  for (const i of ids) {
    c.x += p[i].x / ids.length;
    c.y += p[i].y / ids.length;
    c.z += p[i].z / ids.length;
  }
  return c;
}

/**
 * @param world 21 world landmarks (metres). Falls back to isotropic image landmarks if absent.
 * @param iso 21 image landmarks in isotropic units (x·aspect, y, z·aspect).
 */
export function gripFeatures(world: readonly Landmark[], iso: readonly Landmark[]): GripFeatures {
  const s = dist(world[0], world[9]) || 1e-9;
  const idx = FINGERS.index.map((i) => world[i]);
  let thumbToIndex = Infinity;
  let thumbToIndexSegment = 0;
  for (let k = 0; k < 3; k++) {
    const { d } = pointSegment(world[4], idx[k], idx[k + 1]);
    if (d < thumbToIndex) {
      thumbToIndex = d;
      thumbToIndexSegment = k;
    }
  }
  const mid = FINGERS.middle.map((i) => world[i]);
  let thumbToMiddle = Infinity;
  for (let k = 0; k < 3; k++)
    thumbToMiddle = Math.min(thumbToMiddle, pointSegment(world[4], mid[k], mid[k + 1]).d);
  const palm = palmCentre3(world);
  const curl = {} as Record<FingerName, number>;
  const tipToPalm = {} as Record<FingerName, number>;
  for (const name of FINGER_NAMES) {
    const [m, p, d, t] = FINGERS[name].map((i) => world[i]);
    curl[name] = flexion(m, p, d) + flexion(p, d, t);
    tipToPalm[name] = dist(t, palm) / s;
  }

  // 2D occlusion cue in the image (z: smaller = closer to the camera).
  const flat = (l: Landmark): Landmark => ({ x: l.x, y: l.y, z: 0 });
  const s2 = dist(flat(iso[0]), flat(iso[9])) || 1e-9;
  let occ = Infinity;
  for (let k = 0; k < 3; k++) {
    const a = iso[FINGERS.index[k]];
    const b = iso[FINGERS.index[k + 1]];
    const { d, t } = pointSegment(flat(iso[4]), flat(a), flat(b));
    const zIndex = a.z + (b.z - a.z) * t;
    if (iso[4].z > zIndex) occ = Math.min(occ, d / s2);
  }
  let imageGap = Infinity;
  for (let k = 0; k < 3; k++)
    imageGap = Math.min(
      imageGap,
      pointSegment(iso[4], iso[FINGERS.index[k]], iso[FINGERS.index[k + 1]]).d / s2,
    );

  const n = cross(sub(iso[5], iso[0]), sub(iso[17], iso[0]));
  const palmFacing = Math.abs(n.z) / (norm(n) || 1);

  return {
    tipRatio: dist(world[4], world[8]) / s,
    thumbToIndex: thumbToIndex / s,
    thumbToIndexSegment,
    thumbToMiddle: thumbToMiddle / s,
    curl,
    tipToPalm,
    thumbTipToPalm: dist(world[4], palm) / s,
    occludedThumb2d: occ,
    thumbIndexImageGap: imageGap,
    palmFacing,
  };
}

// ---------- Grab signal (option B: any closed grip grabs, a clearly open hand releases) ----------
//
// Evidence (2026-11-12 recordings, one user, laptop camera, 0.5–1 m; 13 unlabelled files):
// - tip pinch: tipRatio 0.14 (other fingers semi-extended).
// - key / lateral / occluded grip: the index covers the thumb; MediaPipe places the thumb tip ALONG
//   the side of the index (thumbToIndex 0.19–0.22, 2D "behind the index" cue ~0.2) while tipRatio
//   reads half-open (0.32–0.50) -> the tip-ratio-only tracker flickered (04-11-39: 12 starts vs 3).
// - relaxed hand: the thumb ALSO rests along the index (thumbToIndex 0.24–0.30, overlapping the
//   key grip), but middle/ring/pinky are semi-extended: mean tip->palm 0.61–0.68 vs 0.30–0.44 in the
//   key grip. That curl difference is what separates "relaxed" from "grabbing".
// - this user releases a key grip by moving the thumb off the index (thumbToIndex 0.54–0.62) while
//   the other fingers stay curled.
// So: openness = min(tip, lateral, fist), each expressed on the TIP-RATIO scale, so the tracker's
// hysteresis levels (enter 0.25 / exit 0.40 / open 0.65) apply unchanged to every grip type.
//   tip     = tipRatio
//   lateral = max(thumbToIndex, CURL_REF + CURL_GAIN·(mean tip->palm of middle/ring/pinky − LATERAL_CURL_CENTRE))
//   fist    = CURL_REF + CURL_GAIN·(max(index tip->palm, mean middle/ring/pinky) − FIST_CURL_CENTRE)
// All PROVISIONAL: fitted on unlabelled recordings with the user's intended counts; to be refit on
// labelled recordings (lab "Space = grabbing" mode) with scripts/tune-grip.mjs.

export type GripType = 'pinch' | 'lateral' | 'fist';

export interface GrabModel {
  /** Mean tip->palm (middle/ring/pinky, / s) that maps to the enter level. [provisional] */
  lateralCurlCentre: number;
  /** Max(index, mean MRP) tip->palm that maps to the enter level for a fist. */
  fistCurlCentre: number;
  /**
   * Index tip->palm that maps to the enter level for the lateral grip: the index must be curled.
   * Labelled data (2026-11-12, 05-xx): index tip->palm median 0.42 fist, 0.56 key grip, 0.63
   * occluded pinch, vs 0.98 pointing (wave-point) and 1.09 relaxed-open. Without this, a pointing
   * hand (index out, other fingers curled, thumb resting along the index) read as a key grip:
   * 15.5 s of false grab in 05-12-03.
   */
  indexCurlCentre: number;
  /**
   * Thumb tucked into the palm also counts as engaged: thumb-tip->palm minus this offset is compared
   * like thumb->index. Labelled fists: thumb->palm median 0.58; key grip released by lifting the
   * thumb: 0.87 (05-09-55). In 05-09-55 at 29–31 s a fist with the thumb tucked (0.49–0.53) was
   * missed for 2.6 s without this term.
   */
  thumbPalmOffset: number;
  /**
   * Max thumbIndexImageGap for an OBSERVED thumb contact ('clear' grip). Real pinches/fists
   * 0.13–0.22 (median), hallucinated contact 0.43–0.71. 0.25 by leave-one-recording-out (the
   * strictest value tied for best; looser values let a wave-point closure through).
   */
  clearContactGap: number;
  /** A tight fist is 'clear' without a visible thumb: index tip->palm at most this... */
  clearFistIndex: number;
  /** ...and mean middle/ring/pinky tip->palm at most this. Labelled fists: 0.40–0.43 / 0.24–0.25. */
  clearFistMrp: number;
  /** Openness units per unit of tip->palm above the centre. [provisional] */
  curlGain: number;
}

/** Level the curl centres map to: the tracker's enter level (tip-ratio units). */
export const CURL_REF = 0.25;
/**
 * PROVISIONAL values. Leave-one-recording-out on the 13 unlabelled recordings (cost = 10·splits +
 * |starts − user's count| + false-grab penalty on known relaxed windows) chose lateral centre 0.45,
 * gain 1.1 in 9 of 13 folds (0 splits in all files). scripts/tune-grip.mjs without that penalty
 * finds a plateau (lateral 0.40 / gain 0.8 / fist 0.35 scores identically on every file), so the
 * unlabelled data cannot separate them: the labelled recordings must decide. Fist centre 0.5 is
 * NOT fitted (no fist recording); natural fists close via the lateral rule (thumb over the index).
 */
export const DEFAULT_GRAB_MODEL: Readonly<GrabModel> = Object.freeze({
  lateralCurlCentre: 0.4,
  fistCurlCentre: 0.5,
  indexCurlCentre: 0.75,
  thumbPalmOffset: 0.3,
  clearContactGap: 0.25,
  clearFistIndex: 0.5,
  clearFistMrp: 0.35,
  curlGain: 1.1,
});

export type GripConfidence = 'clear' | 'ambiguous';

export interface GrabSignal {
  /** Tip-ratio-scale openness: < 0.25 closed grip, > 0.40 opening, > 0.65 clearly open (defaults). */
  openness: number;
  /**
   * 'clear': the grip is observable (thumb contact visible in the image, or a tight fist) and may
   * grab on the fast path. 'ambiguous': contact is only inferred (thumb hidden behind / beside the
   * index): the tracker requires a still dwell before grabbing.
   */
  confidence: GripConfidence;
  /** Which grip hypothesis is closest to closed. */
  grip: GripType;
  parts: Record<GripType, number>;
  /**
   * Finger extension on the same scale (the curl term alone): high only when middle/ring/pinky
   * extend. A DECISIVE open (fast release) needs this high too, not just the thumb leaving the
   * index: in 04-22-24 the thumb flicked off for 190 ms during a grip change with fingers curled.
   */
  extension: number;
}

export function validateGrabModel(m: GrabModel): void {
  for (const [k, v] of Object.entries(m))
    if (!(Number.isFinite(v) && v > 0)) throw new RangeError(`GrabModel.${k} must be > 0.`);
}

export function grabSignal(g: GripFeatures, model: GrabModel = DEFAULT_GRAB_MODEL): GrabSignal {
  const mrp = (g.tipToPalm.middle + g.tipToPalm.ring + g.tipToPalm.pinky) / 3;
  const extension = CURL_REF + model.curlGain * (mrp - model.lateralCurlCentre);
  const indexCurl = CURL_REF + model.curlGain * (g.tipToPalm.index - model.indexCurlCentre);
  // Thumb engaged: resting on the index, wrapped over the middle finger, or tucked into the palm.
  const thumbEngaged = Math.min(
    g.thumbToIndex,
    g.thumbToMiddle,
    g.thumbTipToPalm - model.thumbPalmOffset,
  );
  const parts: Record<GripType, number> = {
    pinch: g.tipRatio,
    lateral: Math.max(g.thumbToIndex, extension, indexCurl),
    // A fist needs the thumb engaged too: in 05-09-55 the user released a key grip by lifting the
    // thumb (thumb->index 0.47–0.66) while keeping all fingers curled; that must read as open.
    fist: Math.max(
      CURL_REF + model.curlGain * (Math.max(g.tipToPalm.index, mrp) - model.fistCurlCentre),
      thumbEngaged,
    ),
  };
  let grip: GripType = 'pinch';
  for (const k of ['lateral', 'fist'] as const) if (parts[k] < parts[grip]) grip = k;
  const clearFist = g.tipToPalm.index <= model.clearFistIndex && mrp <= model.clearFistMrp;
  const confidence: GripConfidence =
    clearFist || g.thumbIndexImageGap <= model.clearContactGap ? 'clear' : 'ambiguous';
  return { openness: parts[grip], grip, parts, extension, confidence };
}

/**
 * Natural grab point (isotropic image units): midpoint of the thumb tip and its closest point on
 * the index polyline 5–6–7–8. Equals the tip midpoint for a tip pinch and slides continuously to
 * the side of the index for a lateral grip, so the hover cursor does not jump between grip types.
 */
export function naturalGripPoint(iso: readonly Landmark[]): [number, number] {
  const flat = (l: Landmark): Landmark => ({ x: l.x, y: l.y, z: 0 });
  const thumb = flat(iso[4]);
  let best = { d: Infinity, x: thumb.x, y: thumb.y };
  for (let k = 0; k < 3; k++) {
    const a = flat(iso[FINGERS.index[k]]);
    const b = flat(iso[FINGERS.index[k + 1]]);
    const { d, t } = pointSegment(thumb, a, b);
    if (d < best.d) best = { d, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  return [(thumb.x + best.x) / 2, (thumb.y + best.y) / 2];
}

/**
 * Hand-local 2D frame for anchoring a grab point: origin = palm centre, u = wrist->middle-MCP,
 * v = u rotated 90°. A point stored as (a, b) in this frame follows the hand's translation,
 * in-plane rotation and scale, so the grab point stays on the same spot of the hand.
 */
export function handFrame2d(iso: readonly Landmark[]): {
  origin: [number, number];
  u: [number, number];
  v: [number, number];
} {
  const ids = [0, 5, 9, 13, 17];
  const origin: [number, number] = [
    ids.reduce((s, i) => s + iso[i].x, 0) / ids.length,
    ids.reduce((s, i) => s + iso[i].y, 0) / ids.length,
  ];
  const u: [number, number] = [iso[9].x - iso[0].x, iso[9].y - iso[0].y];
  return { origin, u, v: [-u[1], u[0]] };
}

export function toHandLocal(
  p: readonly [number, number],
  f: ReturnType<typeof handFrame2d>,
): [number, number] {
  const dx = p[0] - f.origin[0];
  const dy = p[1] - f.origin[1];
  const l2 = f.u[0] * f.u[0] + f.u[1] * f.u[1] || 1e-12;
  return [(dx * f.u[0] + dy * f.u[1]) / l2, (dx * f.v[0] + dy * f.v[1]) / l2];
}

export function fromHandLocal(
  ab: readonly [number, number],
  f: ReturnType<typeof handFrame2d>,
): [number, number] {
  return [
    f.origin[0] + ab[0] * f.u[0] + ab[1] * f.v[0],
    f.origin[1] + ab[0] * f.u[1] + ab[1] * f.v[1],
  ];
}
