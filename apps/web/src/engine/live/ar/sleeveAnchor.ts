// Sleeves anchored to the real arm, the new approach to defect D3 (agent F3X, prompt 23a; URL flag
// ?f3x=1, default OFF). The pure geometry first (unit tested), then the Three.js compositor.
//
// The current path warps each sleeve layer through one coarse grid (moving least squares on three
// controls). When the real arm crosses the chest the grid folds and tears: shards, holes, a
// sleeve that misses the wrist. Here a sleeve layer is never warped through a grid. It is drawn
// as three RIGID pieces ("stickers") of the posed 3D sleeve's own render:
//   cap    the sleeve head round the shoulder: it stays with the torso (the torso warp's local
//          map at the armhole), so the sleeve is always attached;
//   upper  the upper arm: its rendered bone shoulder→elbow is laid on the real one (the armhole
//          the torso warp gave → the elbow landmark);
//   fore   the forearm: rendered elbow→wrist on the real elbow→wrist landmarks, so the cuff sits
//          at the real wrist with the jacket's own overhang, never past the hand.
// Each piece is an inverse map evaluated per output pixel (one source pixel per pixel: nothing
// can fold or tear), limited to a capsule round its real bone (nothing strays), with round ends
// that overlap into a ball joint at the shoulder and the elbow. Along a bone the render is
// scaled to the real bone's length; across it the width is kept.
//
// The pieces are composited round the torso layer in the order armOccluder.ts decides (a segment
// behind the torso goes under it), each front piece with a soft contact shadow on what it covers.
// Visual overlay only: every fit number still comes from the 3D solve.
import {
  BackSide,
  BufferAttribute,
  CustomBlending,
  DynamicDrawUsage,
  Matrix4,
  FrontSide,
  HalfFloatType,
  Mesh,
  NoBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  ZeroFactor,
  type BufferGeometry,
  type Camera,
  type Texture,
  type WebGLRenderer,
} from 'three';
import type { LiveFrame } from '../contract';
import type { MotionRig } from '../../motion/rig';
import type { ArSolution } from './ArTracker';
import type { ArGlue } from './glue';
import { project, type Vec3 } from './cameraModel';
import { HAND_RADIUS, HAND_RADIUS_MIN, HAND_REACH, MIN_VISIBILITY } from './config';
import { OneEuroVecFilter } from '@satisfy/vision';
import {
  ARM_LANDMARKS,
  ArmDepthOrder,
  drawPlan,
  f3xEnabled,
  passOccluderIndex,
  SleeveTakeover,
  type ArmOrder,
  type DrawItem,
  type OccluderPass,
  type Pt,
  type Side,
} from './armOccluder';

/**
 * Sleeve constants. Geometric choices of this compositing (no accuracy number depends on them:
 * the fit comes from the 3D solve); the margins were set on the venue clips.
 */
export const SLEEVE = {
  /** Margin on the measured half-widths: a band must never cut the sleeve's real outline. */
  bandMargin: 1.12,
  bandPadPx: 2,
  /** The cap keeps the arm's start up to this share of the upper band's half-width (soft). */
  capStub: 1.4,
  /** Sleeve points within this share of the upper arm from the shoulder size the cap. */
  capReach: 0.25,
  /** Sleeve points within this share of either bone from the elbow size the elbow's ball. */
  elbowReach: 0.25,
  /** Percentile of the vertex distances taken as a half-width (cloth outliers left out). */
  percentile: 0.98,
  /** Percentile of the sleeve's reach past the wrist taken as the cuff's end. */
  cuffPercentile: 0.99,
  /** The cuff may pass the wrist by at most this share of the wrist→knuckle length… */
  cuffOfHand: 0.45,
  /** …or, when the hand is not seen, of the forearm. */
  cuffOfForearm: 0.2,
  /** Limits of the across scale taken from the torso warp at the armhole. */
  acrossMin: 0.8,
  acrossMax: 1.25,
  /** Half-widths as a share of the bone when the sleeve's vertices cannot be measured. */
  fallbackUpper: 0.36,
  fallbackFore: 0.3,
  fallbackCap: 0.6,
  /** A joint follows its landmark from this visibility, and lets go below `pinOff`. */
  pinOn: MIN_VISIBILITY,
  pinOff: 0.2,
  /** Time (ms) to blend between the landmark and the fallback (no pop when one drops out). */
  pinBlendMs: 150,
  /** Time constant (ms) of the measured half-widths. */
  extentTauMs: 250,
  /** Vertices sampled per sleeve for the half-widths. */
  maxSamples: 500,
  /**
   * LAB ONLY (?f3xdebug=dropwebs; never on by default: it also removes the stretched but real
   * cloth of a raised upper arm). A sleeve triangle with an edge longer than this multiple of its
   * rest length is taken for a web, not cloth: the preview skinning stretches the sleeve head between the armhole seam (which follows
   * the trunk) and the arm when the arm swings far (venue clip, puffer, crossed arms: flat grey
   * flaps over the chest). Cloth in the preview stays within about 1.3; webs measure 2–6.
   */
  webStretch: 1.8,
  /** The thumb's capsule: reach past the thumb point and radius, as shares of the hand's. */
  thumbReach: 1.2,
  thumbRadius: 0.45,
  /** A hand stays drawn this long (ms) after its landmarks drop out, fading (no blink). */
  handHoldMs: 250,
  /**
   * ?f3xrigid=1: One Euro on the pieces' anchors (armhole, elbow, wrist; px). Light: the glue's
   * landmarks are already filtered; this only takes the remaining shake out at rest (about half
   * of it at 15 fps) and opens up with speed, so a moving arm is not held back.
   */
  steady: { minCutoff: 2, beta: 0.02, dCutoff: 1 },
  /** Heading (degrees) from which the far arm's pieces behind the torso are not drawn at all. */
  farHiddenDeg: 45,
  /** Contact shadow of a front piece: strength, radius and downward drop as shares of its band. */
  shadow: { strength: 0.14, radiusOfBand: 0.3, dropOfBand: 0.15 },
} as const;

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const perp = (d: Pt): Pt => [-d[1], d[0]];
const norm = (a: Pt) => Math.hypot(a[0], a[1]);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Direction and length of a→b; a bone shorter than a pixel takes `fallback` and length 1. */
function boneOf(a: Pt, b: Pt, fallback: Pt = [0, 1]): { dir: Pt; len: number } {
  const d = sub(b, a),
    len = norm(d);
  return len < 1 ? { dir: fallback, len: 1 } : { dir: [d[0] / len, d[1] / len], len };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

/** Shoulder, elbow and wrist of one arm in the image (px). */
export type ChainJoints = { s: Pt; e: Pt; w: Pt };

/** What the rendered sleeve occupies round its bones (source px). */
export type SleeveExtents = {
  /** Sleeve head: its reach from the shoulder joint. */
  capR: number;
  /** Half-width of the sleeve along the upper arm, and along the forearm. */
  upperR: number;
  foreR: number;
  /** Half-width of the sleeve round the elbow (the ball where the two bands meet). */
  elbowR: number;
  /** How far the sleeve runs past the wrist joint along the forearm (negative: it ends short). */
  cuffPast: number;
};

/**
 * The extents of a rendered sleeve from its projected vertices (x, y pairs, px; non-finite pairs
 * are skipped). Every vertex counts for the bone it is nearer to, so a sharply bent arm does not
 * inflate either band. Null with too few vertices.
 */
export function sleeveExtents(points: ArrayLike<number>, j: ChainJoints): SleeveExtents | null {
  const up = boneOf(j.s, j.e),
    fo = boneOf(j.e, j.w, up.dir);
  const cap: number[] = [],
    upper: number[] = [],
    fore: number[] = [],
    elbow: number[] = [],
    cuff: number[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const v: Pt = [points[i], points[i + 1]];
    if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) continue;
    const qs = sub(v, j.s),
      qe = sub(v, j.e);
    const t1 = dot(qs, up.dir),
      t2 = dot(qe, fo.dir);
    // Distance to the upper bone (a segment) and to the forearm (a ray: the cuff passes the wrist).
    const dU = norm(sub(qs, [up.dir[0] * clamp(t1, 0, up.len), up.dir[1] * clamp(t1, 0, up.len)]));
    const dF = norm(sub(qe, [fo.dir[0] * Math.max(t2, 0), fo.dir[1] * Math.max(t2, 0)]));
    if (t1 < SLEEVE.capReach * up.len && dU <= dF) cap.push(norm(qs));
    if (t1 > up.len && t2 < 0) {
      // Outside both bones' ends: the elbow's outer corner, part of both bands.
      upper.push(norm(qe));
      fore.push(norm(qe));
      elbow.push(norm(qe));
    } else if (dF < dU) {
      fore.push(dF);
      cuff.push(t2 - fo.len);
      if (t2 < SLEEVE.elbowReach * fo.len) elbow.push(dF);
    } else if (t1 >= 0) {
      upper.push(dU);
      if (t1 > (1 - SLEEVE.elbowReach) * up.len) elbow.push(dU);
    }
  }
  if (upper.length < 4 || fore.length < 4) return null;
  const upperR = percentile(upper, SLEEVE.percentile),
    foreR = percentile(fore, SLEEVE.percentile);
  return {
    capR:
      cap.length >= 4
        ? percentile(cap, SLEEVE.percentile)
        : (upperR / SLEEVE.fallbackUpper) * SLEEVE.fallbackCap,
    upperR,
    foreR,
    elbowR: elbow.length >= 4 ? percentile(elbow, SLEEVE.percentile) : Math.min(upperR, foreR),
    cuffPast: cuff.length ? percentile(cuff, SLEEVE.cuffPercentile) : 0,
  };
}

/**
 * Where the sleeve ends past the real wrist (target px along the forearm). The jacket's own
 * overhang, but never over the knuckles: at most `cuffOfHand` of the wrist→knuckle length (or
 * `cuffOfForearm` of the forearm when the hand is not seen). A sleeve that ends short stays short.
 */
export function cuffClip(overhangPx: number, handLenPx: number | null, forearmPx: number): number {
  const most =
    handLenPx !== null ? SLEEVE.cuffOfHand * handLenPx : SLEEVE.cuffOfForearm * forearmPx;
  return Math.min(overhangPx, most);
}

export type ChainInput = {
  /** The rendered arm (the posed 3D joints projected), px. */
  source: ChainJoints;
  /** Where the torso warp put the armhole (the rendered shoulder), px. */
  shoulder: Pt;
  /** The torso warp's local Jacobian at the shoulder, row-major [a b; c d]: Δtarget = J·Δsource. */
  jacobian: readonly [number, number, number, number];
  /** The real elbow and wrist (landmarks, px), or null when unusable. */
  elbow: Pt | null;
  wrist: Pt | null;
  /** How much each landmark is followed, 0..1 (PinBlend); default 1 when the landmark is given. */
  elbowWeight?: number;
  wristWeight?: number;
  /** The rendered sleeve's extents, or null (fallbacks from the bone lengths). */
  extents: SleeveExtents | null;
  /** Wrist→knuckle length of the real hand (px), or null when not seen. */
  handLen: number | null;
};

/** One sleeve's stickers: the rendered bones, the real bones, and the limits. Lengths in px. */
export type SleeveChain = {
  source: ChainJoints;
  target: ChainJoints;
  /** Unit directions and lengths of the upper arm [0] and the forearm [1], rendered and real. */
  dirS: [Pt, Pt];
  dirT: [Pt, Pt];
  lenS: [number, number];
  lenT: [number, number];
  /** Inverse of the torso warp's Jacobian at the shoulder, row-major: Δsource = rootInv·Δtarget. */
  rootInv: [number, number, number, number];
  /** Target px per source px across the bones (and beyond their ends). */
  across: number;
  /** Capsule radii in TARGET px: the cap's disc, the upper band, the forearm band. */
  capR: number;
  upperR: number;
  foreR: number;
  /** Radius (target px) of the ball both bands end in at the elbow. */
  elbowR: number;
  /** The cap keeps source points up to this far down the rendered upper arm (source px, soft). */
  capStub: number;
  /** The sleeve ends this far past the real wrist (target px; negative: before it). */
  cuff: number;
  /** How much the elbow and the wrist follow their landmarks (diagnostics). */
  pinned: { elbow: number; wrist: number };
};

const lerp = (a: Pt, b: Pt, k: number): Pt => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];

/**
 * The stickers of one sleeve. A joint without a usable landmark keeps its rendered place relative
 * to its parent: the elbow follows the torso (the Jacobian), the wrist follows the upper arm.
 */
export function buildChain(input: ChainInput): SleeveChain {
  const { source, shoulder } = input;
  const [a, b, c, d] = input.jacobian;
  const det = a * d - b * c;
  const sane = Number.isFinite(det) && det > 0.25 && det < 4;
  const J: [number, number, number, number] = sane ? [a, b, c, d] : [1, 0, 0, 1];
  const detJ = sane ? det : 1;
  const rootInv: [number, number, number, number] = [
    J[3] / detJ,
    -J[1] / detJ,
    -J[2] / detJ,
    J[0] / detJ,
  ];
  const across = clamp(Math.sqrt(detJ), SLEEVE.acrossMin, SLEEVE.acrossMax);

  const upS = boneOf(source.s, source.e),
    foS = boneOf(source.e, source.w, upS.dir);
  const se = sub(source.e, source.s);
  const elbowKept: Pt = [
    shoulder[0] + J[0] * se[0] + J[1] * se[1],
    shoulder[1] + J[2] * se[0] + J[3] * se[1],
  ];
  const elbowW = input.elbow ? (input.elbowWeight ?? 1) : 0;
  const elbow = input.elbow ? lerp(elbowKept, input.elbow, elbowW) : elbowKept;
  const upT = boneOf(shoulder, elbow, upS.dir);
  // The wrist that follows the upper arm rigidly: the rendered forearm turned by the upper arm's turn.
  const cos = dot(upS.dir, upT.dir),
    sin = upS.dir[0] * upT.dir[1] - upS.dir[1] * upT.dir[0];
  const ew = sub(source.w, source.e);
  const wristKept: Pt = [
    elbow[0] + (cos * ew[0] - sin * ew[1]) * across,
    elbow[1] + (sin * ew[0] + cos * ew[1]) * across,
  ];
  const wristW = input.wrist ? (input.wristWeight ?? 1) : 0;
  const wrist = input.wrist ? lerp(wristKept, input.wrist, wristW) : wristKept;
  const foT = boneOf(elbow, wrist, upT.dir);

  const e = input.extents ?? {
    capR: SLEEVE.fallbackCap * upS.len,
    upperR: SLEEVE.fallbackUpper * upS.len,
    foreR: SLEEVE.fallbackFore * Math.max(foS.len, 0.5 * upS.len),
    elbowR: SLEEVE.fallbackFore * Math.max(foS.len, 0.5 * upS.len),
    cuffPast: 0,
  };
  const band = (r: number) => (r * SLEEVE.bandMargin + SLEEVE.bandPadPx) * across;
  // Past the wrist the render keeps its scale; a sleeve that ends short scales with the forearm.
  const overhang = e.cuffPast >= 0 ? e.cuffPast * across : (e.cuffPast * foT.len) / foS.len;
  return {
    source,
    target: { s: shoulder, e: elbow, w: wrist },
    dirS: [upS.dir, foS.dir],
    dirT: [upT.dir, foT.dir],
    lenS: [upS.len, foS.len],
    lenT: [upT.len, foT.len],
    rootInv,
    across,
    capR: band(Math.max(e.capR, e.upperR)),
    upperR: band(e.upperR),
    foreR: band(e.foreR),
    elbowR: band(e.elbowR),
    capStub: SLEEVE.capStub * e.upperR,
    cuff: cuffClip(overhang + SLEEVE.bandPadPx, input.handLen, foT.len),
    pinned: { elbow: elbowW, wrist: wristW },
  };
}

export type Sticker = 'cap' | 'upper' | 'fore';

/**
 * Along a bone: target → source. Beyond the far joint the render keeps its scale (`across`).
 * A real bone LONGER than the rendered one stretches the render between its two joints. A real
 * bone SHORTER than the rendered one points at the lens: the render keeps its scale and its far
 * joint (elbow of the upper arm, wrist of the forearm), and its near part is hidden at the near
 * joint, as a foreshortened arm hides behind its own shoulder or elbow. Squeezing it instead
 * sheared the quilting into a fan (puffer, folded arms).
 */
function alongMap(t: number, lenT: number, lenS: number, across: number) {
  if (t > lenT) return lenS + (t - lenT) / across;
  if (lenT < lenS * across) return lenS - (lenT - t) / across;
  if (t < 0) return t / across;
  return (t * lenS) / lenT;
}

/** The rendered (source) pixel a sticker shows at the output pixel p. Mirrors the shader. */
export function stickerSource(c: SleeveChain, part: Sticker, p: Pt): Pt {
  if (part === 'cap') {
    const q = sub(p, c.target.s);
    return [
      c.source.s[0] + c.rootInv[0] * q[0] + c.rootInv[1] * q[1],
      c.source.s[1] + c.rootInv[2] * q[0] + c.rootInv[3] * q[1],
    ];
  }
  const k = part === 'upper' ? 0 : 1;
  const originT = k === 0 ? c.target.s : c.target.e,
    originS = k === 0 ? c.source.s : c.source.e;
  const q = sub(p, originT);
  const along = dot(q, c.dirT[k]);
  const t = alongMap(along, c.lenT[k], c.lenS[k], c.across),
    s = dot(q, perp(c.dirT[k])) / c.across;
  const n = perp(c.dirS[k]);
  const bone: Pt = [
    originS[0] + c.dirS[k][0] * t + n[0] * s,
    originS[1] + c.dirS[k][1] * t + n[1] * s,
  ];
  if (k === 1) return bone;
  // The upper arm is cloth sewn to the armhole: at the shoulder it keeps the armhole's map (the
  // cap's), at the elbow it lies on the bone, and it bends between the two. Turned rigidly about
  // the shoulder it read as a flat flap when the real arm tucks in (puffer, folded arms).
  return lerp(stickerSource(c, 'cap', p), bone, smoothstep(BEND_FROM, 1, along / c.lenT[0]));
}

/**
 * The seam between the sleeve head and the torso must stay closed (fabric is continuous over the
 * shoulder seam): the cap keeps the sleeve whole down to past the armpit (CAP_KEEP of its stub,
 * SLEEVE.capStub of the upper band), and the upper arm starts to bend toward its bone only after
 * BEND_FROM of its length. With a shorter cap and a bend from the joint the armpit side of the
 * seam opened into a dark notch in profile (user's RC4 recording, CX-DAY: 91 frames).
 */
const CAP_KEEP = 0.7;
const BEND_FROM = 0.2;

/** Soft edge of the bands and the cuff cut (px). */
const EDGE_PX = 1.5;

/**
 * How much of a sticker is drawn at the output pixel p (0..1), before the render's own alpha:
 * the capsule round the real bone, the soft hidden ends at the joints, the cut at the cuff.
 * `under` is the alpha of the piece below at p (cap under upper, upper under fore): a hidden end
 * fades only over something, so the fade never opens a hole. Mirrors the shader.
 */
export function stickerMask(c: SleeveChain, part: Sticker, p: Pt, under = 1): number {
  const q0 = sub(p, c.target.s),
    d0 = norm(q0);
  if (part === 'cap') {
    if (d0 >= c.capR) return 0;
    const src = stickerSource(c, 'cap', p);
    const ts = dot(sub(src, c.source.s), c.dirS[0]);
    return (
      (1 - smoothstep(c.capR - EDGE_PX, c.capR, d0)) *
      (1 - smoothstep(CAP_KEEP * c.capStub, c.capStub, ts))
    );
  }
  if (part === 'upper') {
    const t = dot(q0, c.dirT[0]);
    const tc = clamp(t, 0, c.lenT[0]);
    const d1 = norm(sub(q0, [c.dirT[0][0] * tc, c.dirT[0][1] * tc]));
    // Past the elbow the band ends in the elbow's ball (no spur when the real arm bends more).
    const lim = t > c.lenT[0] ? c.elbowR : c.upperR;
    if (d1 >= lim) return 0;
    const m = 1 - smoothstep(lim - EDGE_PX, lim, d1);
    return m;
  }
  const q = sub(p, c.target.e);
  const t = dot(q, c.dirT[1]),
    s = dot(q, perp(c.dirT[1]));
  const tc = clamp(t, 0, c.lenT[1]);
  const band = t > c.lenT[1] ? Math.abs(s) : norm(sub(q, [c.dirT[1][0] * tc, c.dirT[1][1] * tc]));
  const past = t - c.lenT[1];
  const lim = t < 0 ? c.elbowR : c.foreR;
  if (band >= lim || past >= c.cuff) return 0;
  let m =
    (1 - smoothstep(lim - EDGE_PX, lim, band)) * (1 - smoothstep(c.cuff - EDGE_PX, c.cuff, past));
  // The elbow end fades into the upper arm under it.
  if (t < 0) m *= 1 - under * smoothstep(0.55 * lim, lim, norm(q)) * smoothstep(0, 0.35 * lim, -t);
  return m;
}

/** The real hand of one arm as it is drawn back over the sleeves (source px). */
export type HandShape = {
  /** Palm and fingers: a capsule from the wrist to the fingertips. */
  a: Pt;
  b: Pt;
  radius: number;
  /** The thumb: a capsule from the wrist to this point (null when not seen), and its radius. */
  thumb: Pt | null;
  thumbRadius: number;
  /** The cuff line: the hand shows where (p − cuffAt)·cuffDir > 0. */
  cuffAt: Pt;
  cuffDir: Pt;
};

/** BlazePose hand points of each side. */
export const HAND_LANDMARKS = {
  L: { wrist: 15, pinky: 17, index: 19, thumb: 21, elbow: 13 },
  R: { wrist: 16, pinky: 18, index: 20, thumb: 22, elbow: 14 },
} as const;

/**
 * The real hand's shape from the pose's hand points: the compositor's hand capsule (config
 * HAND_REACH / HAND_RADIUS) plus the thumb, cut at the sleeve's end: the cuff of the arm's
 * pieces when given, else the wrist across the forearm. Null when the hand is not seen.
 */
export function handShape(
  l: readonly { x: number; y: number; visibility: number }[],
  side: Side,
  chain: SleeveChain | null,
): HandShape | null {
  const i = HAND_LANDMARKS[side];
  const w = l[i.wrist],
    p = l[i.pinky],
    x = l[i.index],
    t = l[i.thumb],
    e = l[i.elbow];
  if (!w || !p || !x) return null;
  if (Math.min(w.visibility, p.visibility, x.visibility) < MIN_VISIBILITY) return null;
  const a: Pt = [w.x, w.y];
  const k: Pt = [(p.x + x.x) / 2 - w.x, (p.y + x.y) / 2 - w.y];
  const len = norm(k);
  if (len < 2) return null;
  const radius = Math.max(HAND_RADIUS * Math.hypot(p.x - x.x, p.y - x.y), HAND_RADIUS_MIN * len);
  const seen = !!t && t.visibility >= MIN_VISIBILITY;
  let cuffAt = a,
    cuffDir: Pt = [k[0] / len, k[1] / len];
  if (chain) {
    cuffDir = chain.dirT[1];
    cuffAt = [
      chain.target.w[0] + cuffDir[0] * chain.cuff,
      chain.target.w[1] + cuffDir[1] * chain.cuff,
    ];
  } else if (e && e.visibility >= MIN_VISIBILITY) cuffDir = boneOf([e.x, e.y], a, cuffDir).dir;
  return {
    a,
    b: [a[0] + k[0] * HAND_REACH, a[1] + k[1] * HAND_REACH],
    radius,
    thumb: seen
      ? [a[0] + (t.x - a[0]) * SLEEVE.thumbReach, a[1] + (t.y - a[1]) * SLEEVE.thumbReach]
      : null,
    thumbRadius: SLEEVE.thumbRadius * radius,
    cuffAt,
    cuffDir,
  };
}

/**
 * Skin tones in Y/Cb/Cr of the camera's sRGB values (0..1): the classic chroma box of skin,
 * with soft edges, and a floor on the luma. [from, full] and [full, to] per bound. A chroma
 * test on the frame being drawn has no latency (the class mask is a few frames old), and inside
 * the hand's shape it only has to tell skin from cloth.
 */
export const SKIN = {
  cr: [0.515, 0.545, 0.68, 0.72],
  cb: [0.27, 0.31, 0.49, 0.52],
  luma: [0.1, 0.2],
} as const;

/**
 * Skin like the person's own face: how well an sRGB colour matches the face's (`ref`, the mean
 * of the cheeks and the nose in the same frame), 0..1. Same hue, not more saturated; a colour
 * much paler than the face counts only when it is about as bright (over-exposed skin: the
 * venue's forearms and hands read almost white), any other only when it is not much darker.
 * The fixed chroma box missed that pale skin (venue clip: specks instead of hands). Limit: cloth
 * that is blown out to white passes too; the test only ever runs inside a hand's shape.
 * Mirrors the hand shader.
 */
export function skinLike(c: readonly number[], ref: readonly number[]): number {
  const luma = (x: readonly number[]) => 0.299 * x[0] + 0.587 * x[1] + 0.114 * x[2];
  const y = luma(c),
    yr = luma(ref);
  const v: Pt = [(c[2] - y) * 0.564, (c[0] - y) * 0.713],
    r: Pt = [(ref[2] - yr) * 0.564, (ref[0] - yr) * 0.713];
  const lv = norm(v),
    lr = Math.max(norm(r), 1e-3);
  // A warm tint like the face's, however faint…
  const tinted =
    lv < 1e-4 ? 0 : smoothstep(0.7, 0.85, dot(v, r) / (lv * lr)) * smoothstep(0.006, 0.012, lv);
  const sat = 1 - smoothstep(1.5 * lr + 0.01, 1.9 * lr + 0.02, lv);
  const pale = 1 - smoothstep(0.4 * lr, 0.6 * lr, lv);
  const bright = smoothstep((0.4 + 0.4 * pale) * yr, (0.5 + 0.42 * pale) * yr, y);
  // …or no tint at all, only where the frame is blown out (well above the face's brightness).
  const neutral = 1 - smoothstep(0.012, 0.025, lv);
  const blown = smoothstep(Math.min(1.2 * yr, 0.84), Math.min(1.32 * yr, 0.92), y);
  return Math.max(tinted * sat * bright, neutral * blown);
}

/** BlazePose face points: nose, eyes, mouth corners. */
const FACE = { nose: 0, eyeL: 2, eyeR: 5, mouthL: 9, mouthR: 10 } as const;

/** Three skin points of a seen face (the cheeks and the nose), or null. */
export function facePoints(
  l: readonly { x: number; y: number; visibility: number }[],
): [Pt, Pt, Pt] | null {
  const p = [FACE.nose, FACE.eyeL, FACE.eyeR, FACE.mouthL, FACE.mouthR].map((i) => l[i]);
  if (p.some((q) => !q || q.visibility < MIN_VISIBILITY)) return null;
  const [nose, eyeL, eyeR, mouthL, mouthR] = p;
  return [
    [nose.x, nose.y],
    [(eyeL.x + mouthL.x) / 2, (eyeL.y + mouthL.y) / 2],
    [(eyeR.x + mouthR.x) / 2, (eyeR.y + mouthR.y) / 2],
  ];
}

/** Skin likelihood (0..1) of an sRGB colour, channels 0..1. Mirrors the hand shader. */
export function skinLikelihood(r: number, g: number, b: number): number {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 0.5 + (b - y) * 0.564,
    cr = 0.5 + (r - y) * 0.713;
  return (
    smoothstep(SKIN.cr[0], SKIN.cr[1], cr) *
    (1 - smoothstep(SKIN.cr[2], SKIN.cr[3], cr)) *
    smoothstep(SKIN.cb[0], SKIN.cb[1], cb) *
    (1 - smoothstep(SKIN.cb[2], SKIN.cb[3], cb)) *
    smoothstep(SKIN.luma[0], SKIN.luma[1], y)
  );
}

/** Keeps a hand drawn for `handHoldMs` after its landmarks drop out, fading. */
export class HandHold {
  private last: HandShape | null = null;
  private seenAt = -Infinity;

  update(shape: HandShape | null, tMs: number): { shape: HandShape; alpha: number } | null {
    if (shape) {
      this.last = shape;
      this.seenAt = tMs;
      return { shape, alpha: 1 };
    }
    if (!this.last) return null;
    const age = tMs - this.seenAt;
    if (age < 0 || age >= SLEEVE.handHoldMs) {
      this.last = null;
      return null;
    }
    return { shape: this.last, alpha: 1 - age / SLEEVE.handHoldMs };
  }
}

/**
 * How much a joint follows its landmark: on from `pinOn` visibility, off below `pinOff` or when
 * the landmark is unusable (outside the frame), and blended over `pinBlendMs` so the sleeve never
 * jumps when a landmark drops out for a frame.
 */
export class PinBlend {
  weight = 0;
  pinned = false;
  private lastT?: number;

  update(visibility: number, usable: boolean, tMs: number): number {
    if (!usable) this.pinned = false;
    else if (visibility >= SLEEVE.pinOn) this.pinned = true;
    else if (visibility < SLEEVE.pinOff) this.pinned = false;
    const first = this.lastT === undefined || tMs < this.lastT;
    const step = first ? 1 : (tMs - this.lastT!) / SLEEVE.pinBlendMs;
    this.lastT = tMs;
    this.weight = this.pinned ? Math.min(1, this.weight + step) : Math.max(0, this.weight - step);
    return this.weight;
  }
}

/**
 * Which winding of the sleeve's triangles faces out of the sleeve: +1 counter-clockwise (three's
 * front face), −1 clockwise, 0 unknown. A vote over up to `max` triangles: a triangle's normal
 * against the direction from the arm's bones (shoulder→elbow→wrist, same frame as the positions)
 * to its centre.
 */
export function outsideWinding(
  position: (vertex: number) => Vec3,
  index: ArrayLike<number>,
  bones: readonly [Vec3, Vec3, Vec3],
  max = 240,
): 1 | -1 | 0 {
  const triangles = Math.floor(index.length / 3);
  const step = Math.max(1, Math.floor(triangles / max));
  const nearest = (p: Vec3, a: Vec3, b: Vec3): Vec3 => {
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const h = clamp(
      ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) /
        Math.max(d[0] * d[0] + d[1] * d[1] + d[2] * d[2], 1e-12),
      0,
      1,
    );
    return [a[0] + d[0] * h, a[1] + d[1] * h, a[2] + d[2] * h];
  };
  let vote = 0,
    counted = 0;
  for (let t = 0; t < triangles; t += step) {
    const a = position(index[t * 3]),
      b = position(index[t * 3 + 1]),
      c = position(index[t * 3 + 2]);
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      w: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: Vec3 = [
      u[1] * w[2] - u[2] * w[1],
      u[2] * w[0] - u[0] * w[2],
      u[0] * w[1] - u[1] * w[0],
    ];
    const g: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const q1 = nearest(g, bones[0], bones[1]),
      q2 = nearest(g, bones[1], bones[2]);
    const r1: Vec3 = [g[0] - q1[0], g[1] - q1[1], g[2] - q1[2]],
      r2: Vec3 = [g[0] - q2[0], g[1] - q2[1], g[2] - q2[2]];
    const r = Math.hypot(...r1) <= Math.hypot(...r2) ? r1 : r2;
    const side = n[0] * r[0] + n[1] * r[1] + n[2] * r[2];
    if (!Number.isFinite(side) || side === 0) continue;
    vote += Math.sign(side);
    counted++;
  }
  if (counted < 8) return 0;
  return vote > 0.3 * counted ? 1 : vote < -0.3 * counted ? -1 : 0;
}

/**
 * The cuff as the real jackets have it (user feedback U4: "I see straight into the sleeve"): an
 * elastic (parka) or ribbed (puffer) band that closes round the wrist. Both demo jackets carry a
 * band of about 7 cm; it closes to an adult wrist (half its width, about 2.8 cm) plus the cloth.
 */
/**
 * Length (m) of the sleeve head that is drawn with the torso layer, closing its armhole: the sleeve cap of both
 * demo jackets reaches about 12 cm down from the shoulder seam to the armpit.
 */
export const HEAD_LENGTH_M = 0.12;

/**
 * The head's lower rim is tucked under the sleeve drawn over it: over its last `lengthM` the
 * head narrows to `radiusM` round the posed upper arm (well inside any sleeve), so its end is
 * never an edge of the outline. Left at its full width it stood out as a shelf at the bicep,
 * wider than the upper piece laid on the real arm (F3 / lead: puffer and parka, arms hanging).
 * Lab only: ?f3xdebug=tuck, default OFF (seen on one still frame per jacket, not on motion).
 */
export const HEAD_TUCK = { lengthM: 0.04, radiusM: 0.05, reachM: 0.18 } as const;

export const CUFF = {
  /** Radius (m) of the closed cuff round the forearm's axis. */
  radiusM: 0.036,
  /** Length (m) of the band over which the sleeve gathers to that radius. */
  lengthM: 0.07,
} as const;

/**
 * The vertices of a sleeve's cuff band, from the garment at rest: those within `length` of the
 * sleeve's end along its own rest axis (from the sleeve's centre toward the cuff landmark, then
 * toward the centre of its end). Weight 0 where the band starts, 1 at the sleeve's end. A set
 * found at rest does not depend on the pose (a folded arm never puts upper-arm cloth in it).
 */
export function cuffBand(
  index: ArrayLike<number>,
  rest: ArrayLike<number>,
  landmark: number,
  length: number,
): { ids: Uint32Array; weight: Float32Array } | null {
  const ids = Uint32Array.from(new Set(Array.from(index))).sort();
  if (ids.length < 8 || !(landmark * 3 + 2 < rest.length)) return null;
  const at = (i: number): Vec3 => [rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]];
  const mean = (list: ArrayLike<number>): Vec3 => {
    const c: Vec3 = [0, 0, 0];
    for (let k = 0; k < list.length; k++) {
      const p = at(list[k]);
      c[0] += p[0] / list.length;
      c[1] += p[1] / list.length;
      c[2] += p[2] / list.length;
    }
    return c;
  };
  const centre = mean(ids);
  type Axis = { u: Float32Array; end: number };
  const along = (toward: Vec3): Axis | null => {
    const d: Vec3 = [toward[0] - centre[0], toward[1] - centre[1], toward[2] - centre[2]];
    const n = Math.hypot(d[0], d[1], d[2]);
    if (n < 1e-6) return null;
    const u = Float32Array.from(ids, (i) => {
      const p = at(i);
      return (
        ((p[0] - centre[0]) * d[0] + (p[1] - centre[1]) * d[1] + (p[2] - centre[2]) * d[2]) / n
      );
    });
    let end = -Infinity;
    for (const x of u) end = Math.max(end, x);
    return { u, end };
  };
  // First toward the landmark (on the cuff's rim, off the axis), then three times toward the
  // centre of the sleeve's end as found so far.
  let second: Axis | null = along(at(landmark));
  if (!second) return null;
  for (let pass = 0; pass < 3; pass++) {
    const found: Axis = second;
    const tip = Array.from(ids).filter((_, k) => found.u[k] > found.end - length / 2);
    second = along(mean(tip)) ?? found;
  }
  const axis: Axis = second;
  const keep: number[] = [],
    weight: number[] = [];
  ids.forEach((id, k) => {
    const w = (axis.u[k] - (axis.end - length)) / length;
    if (w <= 0) return;
    keep.push(id);
    weight.push(Math.min(1, w));
  });
  return keep.length ? { ids: Uint32Array.from(keep), weight: Float32Array.from(weight) } : null;
}

/**
 * The triangles of a sleeve's HEAD: those whose three vertices lie within `length` of the
 * sleeve's armhole end along its rest axis (the end opposite the cuff landmark). Found at rest,
 * so the set stays at the shoulder in every pose. Null when the garment has no such band.
 */
export function headTriangles(
  index: ArrayLike<number>,
  rest: ArrayLike<number>,
  landmark: number,
  length: number,
): Uint32Array | null {
  // cuffBand over the whole sleeve gives every vertex its distance from the cuff end.
  const SPAN = 100;
  const all = cuffBand(index, rest, landmark, SPAN);
  if (!all) return null;
  const fromCuff = new Map<number, number>();
  let far = 0;
  all.ids.forEach((id, k) => {
    const d = (1 - all.weight[k]) * SPAN;
    fromCuff.set(id, d);
    far = Math.max(far, d);
  });
  const head = (v: number) => (fromCuff.get(v) ?? -Infinity) > far - length;
  const out: number[] = [];
  for (let t = 0; t + 2 < index.length; t += 3)
    if (head(index[t]) && head(index[t + 1]) && head(index[t + 2]))
      out.push(index[t], index[t + 1], index[t + 2]);
  return out.length ? Uint32Array.from(out) : null;
}

/**
 * The lower rim of a sleeve's head: the vertices of the last `tuck` metres of the head (the head
 * = the first `length` from the armhole end, as headTriangles), weight 0 where the rim starts
 * and 1 at the head's end. Null when the garment has none.
 */
export function headRim(
  index: ArrayLike<number>,
  rest: ArrayLike<number>,
  landmark: number,
  length: number,
  tuck: number,
): { ids: Uint32Array; weight: Float32Array } | null {
  const SPAN = 100;
  const all = cuffBand(index, rest, landmark, SPAN);
  if (!all) return null;
  let far = 0;
  const fromCuff = Float32Array.from(all.weight, (w) => (1 - w) * SPAN);
  for (const d of fromCuff) far = Math.max(far, d);
  const ids: number[] = [],
    weight: number[] = [];
  all.ids.forEach((id, k) => {
    // Distance from the sleeve's armhole end along its rest axis.
    const down = far - fromCuff[k];
    if (down <= length - tuck || down > length + tuck) return;
    ids.push(id);
    weight.push(Math.min(1, (down - (length - tuck)) / tuck));
  });
  return ids.length ? { ids: Uint32Array.from(ids), weight: Float32Array.from(weight) } : null;
}

/**
 * Copies into `out` the triangles whose OUTSIDE faces the eye (`winding` +1: the
 * counter-clockwise side is the outside; −1: the clockwise side), positions and eye in one
 * frame. Returns the indices written. A triangle seen from its inside is left out: no interior.
 */
export function facingTriangles(
  index: ArrayLike<number>,
  positions: ArrayLike<number>,
  eye: Vec3,
  winding: 1 | -1,
  out: Uint32Array,
): number {
  let n = 0;
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = index[t] * 3,
      b = index[t + 1] * 3,
      c = index[t + 2] * 3;
    const ux = positions[b] - positions[a],
      uy = positions[b + 1] - positions[a + 1],
      uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a],
      vy = positions[c + 1] - positions[a + 1],
      vz = positions[c + 2] - positions[a + 2];
    const facing =
      (uy * vz - uz * vy) * (eye[0] - positions[a]) +
      (uz * vx - ux * vz) * (eye[1] - positions[a + 1]) +
      (ux * vy - uy * vx) * (eye[2] - positions[a + 2]);
    if (facing * winding <= 0) continue;
    out[n] = index[t];
    out[n + 1] = index[t + 1];
    out[n + 2] = index[t + 2];
    n += 3;
  }
  return n;
}

/**
 * Closes a cuff round the wrist: each vertex of the band (cuffBand) is pulled toward the forearm's
 * axis (elbow → wrist, same frame as the positions) so that the sleeve ends at `radius`, smoothly
 * from the band's start. Never pushes cloth outward. Positions change in place; the return value
 * is their original xyz (per band vertex) to put back, or null when nothing moved.
 */
export function closeCuff(
  positions: Float32Array,
  band: { ids: Uint32Array; weight: Float32Array },
  elbow: Vec3,
  wrist: Vec3,
  radius: number,
  /** Only cloth round the bone: at most this far from its axis, and not behind its start. */
  reach = Infinity,
): Float32Array | null {
  const d: Vec3 = [wrist[0] - elbow[0], wrist[1] - elbow[1], wrist[2] - elbow[2]];
  const n = Math.hypot(d[0], d[1], d[2]);
  if (!(n > 1e-6)) return null;
  d[0] /= n;
  d[1] /= n;
  d[2] /= n;
  const saved = new Float32Array(band.ids.length * 3);
  let moved = false;
  for (let k = 0; k < band.ids.length; k++) {
    const o = band.ids[k] * 3;
    const x = positions[o],
      y = positions[o + 1],
      z = positions[o + 2];
    saved[k * 3] = x;
    saved[k * 3 + 1] = y;
    saved[k * 3 + 2] = z;
    const qx = x - elbow[0],
      qy = y - elbow[1],
      qz = z - elbow[2];
    const t = qx * d[0] + qy * d[1] + qz * d[2];
    const rx = qx - d[0] * t,
      ry = qy - d[1] * t,
      rz = qz - d[2] * t;
    const r = Math.hypot(rx, ry, rz);
    if (!(r > radius) || r > reach || (reach !== Infinity && t < 0)) continue;
    const k2 = 1 + (radius / r - 1) * smoothstep(0, 1, band.weight[k]);
    positions[o] = elbow[0] + d[0] * t + rx * k2;
    positions[o + 1] = elbow[1] + d[1] * t + ry * k2;
    positions[o + 2] = elbow[2] + d[2] * t + rz * k2;
    moved = true;
  }
  return moved ? saved : null;
}

/** Squared rest length of every triangle edge of an index (3 per triangle: ab, bc, ca). */
export function restEdges(index: ArrayLike<number>, rest: ArrayLike<number>): Float32Array {
  const out = new Float32Array(index.length);
  for (let t = 0; t + 2 < index.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = index[t + e] * 3,
        b = index[t + ((e + 1) % 3)] * 3;
      const x = rest[a] - rest[b],
        y = rest[a + 1] - rest[b + 1],
        z = rest[a + 2] - rest[b + 2];
      out[t + e] = x * x + y * y + z * z;
    }
  return out;
}

/**
 * Copies into `out` the triangles of `index` whose three edges are all within `maxStretch` times
 * their rest length at the current positions (x, y, z per vertex); returns the indices written.
 * A triangle with a degenerate rest edge is kept.
 */
export function unstretched(
  index: ArrayLike<number>,
  restSq: Float32Array,
  positions: ArrayLike<number>,
  maxStretch: number,
  out: Uint32Array,
): number {
  const k = maxStretch * maxStretch;
  let n = 0;
  for (let t = 0; t + 2 < index.length; t += 3) {
    let web = false;
    for (let e = 0; e < 3 && !web; e++) {
      const a = index[t + e] * 3,
        b = index[t + ((e + 1) % 3)] * 3;
      const x = positions[a] - positions[b],
        y = positions[a + 1] - positions[b + 1],
        z = positions[a + 2] - positions[b + 2];
      const r = restSq[t + e];
      web = r > 1e-12 && x * x + y * y + z * z > k * r;
    }
    if (web) continue;
    out[n] = index[t];
    out[n + 1] = index[t + 1];
    out[n + 2] = index[t + 2];
    n += 3;
  }
  return n;
}

/**
 * A copy of a sleeve's index in which EVERY triangle is wound counter-clockwise seen from outside
 * the sleeve (its normal away from the arm's bones, positions and bones in one frame), and how
 * many triangles were turned. A sleeve layer is not one panel: the dropped shoulder's cap that
 * F3's ?f3shoulder=1 draws with the sleeve carries the BODY panel and is wound the other way. A
 * single side for the whole layer (the vote of outsideWinding) culled that cap and bared the
 * shadowed sleeve under it: a flat grey band across the puffer's upper arms.
 */
export function unifyWinding(
  position: (vertex: number) => Vec3,
  index: ArrayLike<number>,
  bones: readonly [Vec3, Vec3, Vec3],
): { index: Uint32Array; turned: number } {
  const out = Uint32Array.from(index);
  const nearest = (p: Vec3, a: Vec3, b: Vec3): Vec3 => {
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const h = clamp(
      ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) /
        Math.max(d[0] * d[0] + d[1] * d[1] + d[2] * d[2], 1e-12),
      0,
      1,
    );
    return [a[0] + d[0] * h, a[1] + d[1] * h, a[2] + d[2] * h];
  };
  let turned = 0;
  for (let t = 0; t + 2 < out.length; t += 3) {
    const a = position(out[t]),
      b = position(out[t + 1]),
      c = position(out[t + 2]);
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      w: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: Vec3 = [
      u[1] * w[2] - u[2] * w[1],
      u[2] * w[0] - u[0] * w[2],
      u[0] * w[1] - u[1] * w[0],
    ];
    const g: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const q1 = nearest(g, bones[0], bones[1]),
      q2 = nearest(g, bones[1], bones[2]);
    const r1: Vec3 = [g[0] - q1[0], g[1] - q1[1], g[2] - q1[2]],
      r2: Vec3 = [g[0] - q2[0], g[1] - q2[1], g[2] - q2[2]];
    const r = Math.hypot(...r1) <= Math.hypot(...r2) ? r1 : r2;
    if (n[0] * r[0] + n[1] * r[1] + n[2] * r[2] >= 0) continue;
    const swap = out[t + 1];
    out[t + 1] = out[t + 2];
    out[t + 2] = swap;
    turned++;
  }
  return { index: out, turned };
}

/** Up to `max` distinct vertex ids of an index, evenly spread. */
export function sampleIds(index: ArrayLike<number>, max: number): Uint32Array {
  const seen = new Set<number>();
  for (let i = 0; i < index.length; i++) seen.add(index[i]);
  const all = Uint32Array.from(seen).sort();
  if (all.length <= max) return all;
  const out = new Uint32Array(max);
  for (let i = 0; i < max; i++) out[i] = all[Math.floor((i * all.length) / max)];
  return out;
}

/** The output box (px) a draw item can touch: its capsules, padded. */
export function itemBox(c: SleeveChain, part: DrawItem['part'], pad: number): { min: Pt; max: Pt } {
  const min: Pt = [Infinity, Infinity],
    max: Pt = [-Infinity, -Infinity];
  const grow = (p: Pt, r: number) => {
    min[0] = Math.min(min[0], p[0] - r);
    min[1] = Math.min(min[1], p[1] - r);
    max[0] = Math.max(max[0], p[0] + r);
    max[1] = Math.max(max[1], p[1] + r);
  };
  if (part !== 'fore') {
    grow(c.target.s, Math.max(c.capR, c.upperR) + pad);
    grow(c.target.e, Math.max(c.upperR, c.elbowR) + pad);
  }
  if (part !== 'upper') {
    grow(c.target.e, Math.max(c.foreR, c.elbowR) + pad);
    grow(c.target.w, c.foreR + Math.max(c.cuff, 0) + pad);
  }
  return { min, max };
}

// ---------------------------------------------------------------------------------------------
// The compositor (Three.js).

const vertex = /* glsl */ `
  uniform vec4 uBox;
  uniform vec2 uSrc;
  varying vec2 vPx;
  void main() {
    vec2 ndc = mix(uBox.xy, uBox.zw, uv);
    vPx = vec2(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * uSrc;
    gl_Position = vec4(ndc, 0.0, 1.0);
  }
`;

// stickerSource / stickerMask above are the reference for this code; keep them in step.
const sleeveGlsl = /* glsl */ `
  uniform sampler2D tSleeve;
  uniform vec2 uSrc;
  uniform vec2 uSrcJ[3];
  uniform vec2 uTgtJ[3];
  uniform vec2 uDirS[2];
  uniform vec2 uDirT[2];
  uniform vec4 uLen;
  uniform vec4 uRoot;
  uniform float uAcross;
  uniform vec4 uRad;
  uniform float uCapStub;
  uniform float uCuff;
  uniform float uPart;
  uniform float uAlpha;
  varying vec2 vPx;
  const float EDGE = ${EDGE_PX.toFixed(1)};

  vec2 perp(vec2 d) { return vec2(-d.y, d.x); }
  vec4 sleeveTexel(vec2 src) {
    vec2 uv = vec2(src.x / uSrc.x, 1.0 - src.y / uSrc.y);
    if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return vec4(0.0);
    return texture2D(tSleeve, uv);
  }
  float alongMap(float t, float lenT, float lenS) {
    if (t > lenT) return lenS + (t - lenT) / uAcross;
    if (lenT < lenS * uAcross) return lenS - (lenT - t) / uAcross;
    if (t < 0.0) return t / uAcross;
    return t * lenS / lenT;
  }
  // The sleeve's pieces at output pixel p (premultiplied): cap, then upper, then forearm on top.
  vec4 sleeveAt(vec2 p) {
    vec4 col = vec4(0.0);
    if (uPart < 1.5) {
      vec2 q = p - uTgtJ[0];
      float d0 = length(q);
      if (d0 < uRad.x) {
        vec2 src = uSrcJ[0] + vec2(uRoot.x * q.x + uRoot.y * q.y, uRoot.z * q.x + uRoot.w * q.y);
        float ts = dot(src - uSrcJ[0], uDirS[0]);
        float m = (1.0 - smoothstep(uRad.x - EDGE, uRad.x, d0))
          * (1.0 - smoothstep(${CAP_KEEP.toFixed(2)} * uCapStub, uCapStub, ts));
        if (m > 0.0) col = sleeveTexel(src) * m;
      }
      float t = dot(q, uDirT[0]);
      float s = dot(q, perp(uDirT[0]));
      float d1 = length(q - uDirT[0] * clamp(t, 0.0, uLen.z));
      float lim = t > uLen.z ? uRad.w : uRad.y;
      if (d1 < lim) {
        float m = 1.0 - smoothstep(lim - EDGE, lim, d1);
        // Bends from the armhole's map (the cap's) at the shoulder to the bone at the elbow.
        vec2 bone = uSrcJ[0] + uDirS[0] * alongMap(t, uLen.z, uLen.x) + perp(uDirS[0]) * (s / uAcross);
        vec2 root = uSrcJ[0] + vec2(uRoot.x * q.x + uRoot.y * q.y, uRoot.z * q.x + uRoot.w * q.y);
        vec2 src = mix(root, bone, smoothstep(${BEND_FROM.toFixed(2)}, 1.0, t / uLen.z));
        vec4 c = sleeveTexel(src) * m;
        col = c + col * (1.0 - c.a);
      }
    }
    if (uPart < 0.5 || uPart > 1.5) {
      vec2 q = p - uTgtJ[1];
      float t = dot(q, uDirT[1]);
      float s = dot(q, perp(uDirT[1]));
      float band = t > uLen.w ? abs(s) : length(q - uDirT[1] * clamp(t, 0.0, uLen.w));
      float past = t - uLen.w;
      float lim = t < 0.0 ? uRad.w : uRad.z;
      if (band < lim && past < uCuff) {
        float m = (1.0 - smoothstep(lim - EDGE, lim, band))
          * (1.0 - smoothstep(uCuff - EDGE, uCuff, past));
        if (t < 0.0) m *= 1.0 - col.a * smoothstep(0.55 * lim, lim, length(q)) * smoothstep(0.0, 0.35 * lim, -t);
        vec2 src = uSrcJ[1] + uDirS[1] * alongMap(t, uLen.w, uLen.y) + perp(uDirS[1]) * (s / uAcross);
        vec4 c = sleeveTexel(src) * m;
        col = c + col * (1.0 - c.a);
      }
    }
    return col;
  }
`;

const colourFragment = /* glsl */ `
  ${sleeveGlsl}
  void main() {
    vec4 c = sleeveAt(vPx);
    if (c.a < 0.003) discard;
    gl_FragColor = c * uAlpha;
  }
`;

/** Contact shadow: the piece's cover, blurred on a ring and dropped, darkens what lies under it. */
const shadowFragment = /* glsl */ `
  ${sleeveGlsl}
  uniform vec3 uShadow;
  void main() {
    vec2 c = vPx - vec2(0.0, uShadow.z);
    float sum = sleeveAt(c).a;
    for (int i = 0; i < 6; i++) {
      float a = float(i) * 1.047198;
      sum += sleeveAt(c + vec2(cos(a), sin(a)) * uShadow.y).a;
    }
    float s = uShadow.x * uAlpha * smoothstep(0.05, 0.75, sum / 7.0);
    if (s < 0.004) discard;
    gl_FragColor = vec4(0.0, 0.0, 0.0, s);
  }
`;

const copyFragment = /* glsl */ `
  uniform sampler2D tSleeve;
  uniform vec2 uSrc;
  varying vec2 vPx;
  void main() {
    gl_FragColor = vec4(texture2D(tSleeve, vec2(vPx.x / uSrc.x, 1.0 - vPx.y / uSrc.y)).a);
  }
`;

const plainFragment = /* glsl */ `
  uniform sampler2D tSleeve;
  uniform vec2 uSrc;
  uniform float uAlpha;
  varying vec2 vPx;
  void main() {
    gl_FragColor = texture2D(tSleeve, vec2(vPx.x / uSrc.x, 1.0 - vPx.y / uSrc.y)) * uAlpha;
  }
`;

/**
 * The real hand over the finished picture: the video inside the hand's shape (handShape), past
 * the cuff line, where the frame's own pixels are skin (skinLikelihood on a 5-tap mean) and the
 * person mask agrees. Not premultiplied: it is drawn on the canvas with normal blending.
 */
const handFragment = /* glsl */ `
  uniform sampler2D tVideo;
  uniform sampler2D tMask;
  uniform float uHasMask;
  uniform sampler2D tSkin;
  uniform float uHasSkin;
  uniform vec2 uFace[3];
  uniform float uHasFace;
  uniform vec2 uSrc;
  uniform vec2 uHandA;
  uniform vec2 uHandB;
  uniform vec2 uThumb;
  uniform vec2 uHandR;
  uniform vec2 uCuffAt;
  uniform vec2 uCuffDir;
  uniform float uHandAlpha;
  varying vec2 vPx;
  float toSegment(vec2 p, vec2 a, vec2 b) {
    vec2 ab = b - a;
    float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    return length(p - a - ab * h);
  }
  vec3 videoAt(vec2 p) { return texture2D(tVideo, vec2(p.x / uSrc.x, 1.0 - p.y / uSrc.y)).rgb; }
  float skin(vec3 c) {
    float y = dot(c, vec3(0.299, 0.587, 0.114));
    float cb = 0.5 + (c.b - y) * 0.564;
    float cr = 0.5 + (c.r - y) * 0.713;
    return smoothstep(${SKIN.cr[0]}, ${SKIN.cr[1]}, cr) * (1.0 - smoothstep(${SKIN.cr[2]}, ${SKIN.cr[3]}, cr))
      * smoothstep(${SKIN.cb[0]}, ${SKIN.cb[1]}, cb) * (1.0 - smoothstep(${SKIN.cb[2]}, ${SKIN.cb[3]}, cb))
      * smoothstep(${SKIN.luma[0]}, ${SKIN.luma[1]}, y);
  }
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  // skinLike: the colour against the person's own face in this frame.
  float like(vec3 c, vec3 ref) {
    float y = luma(c);
    float yr = luma(ref);
    vec2 v = vec2((c.b - y) * 0.564, (c.r - y) * 0.713);
    vec2 r = vec2((ref.b - yr) * 0.564, (ref.r - yr) * 0.713);
    float lv = length(v);
    float lr = max(length(r), 1e-3);
    float tinted = lv < 1e-4 ? 0.0 : smoothstep(0.7, 0.85, dot(v, r) / (lv * lr)) * smoothstep(0.006, 0.012, lv);
    float sat = 1.0 - smoothstep(1.5 * lr + 0.01, 1.9 * lr + 0.02, lv);
    float pale = 1.0 - smoothstep(0.4 * lr, 0.6 * lr, lv);
    float bright = smoothstep((0.4 + 0.4 * pale) * yr, (0.5 + 0.42 * pale) * yr, y);
    float neutral = 1.0 - smoothstep(0.012, 0.025, lv);
    float blown = smoothstep(min(1.2 * yr, 0.84), min(1.32 * yr, 0.92), y);
    return max(tinted * sat * bright, neutral * blown);
  }
  void main() {
    float d = toSegment(vPx, uHandA, uHandB) / uHandR.x;
    if (uHandR.y > 0.0) d = min(d, toSegment(vPx, uHandA, uThumb) / uHandR.y);
    float inside = 1.0 - smoothstep(0.8, 1.0, d);
    float beyond = smoothstep(-1.5, 1.5, dot(vPx - uCuffAt, uCuffDir));
    if (inside * beyond <= 0.0) discard;
    vec3 here = videoAt(vPx);
    vec3 mean = (here * 2.0 + videoAt(vPx + vec2(2.0, 0.0)) + videoAt(vPx - vec2(2.0, 0.0))
      + videoAt(vPx + vec2(0.0, 2.0)) + videoAt(vPx - vec2(0.0, 2.0))) / 6.0;
    float person = uHasMask > 0.5
      ? smoothstep(0.3, 0.7, texture2D(tMask, vec2(vPx.x / uSrc.x, vPx.y / uSrc.y)).r)
      : 1.0;
    // Skin, whichever says more: this frame's chroma (the fixed box, and the match with the
    // person's own face), and the finisher's segmented skin (canvas-aligned, a few frames old,
    // frozen while the person is still) where the live pixel is not far darker than the face.
    float seen = skin(mean);
    float dark = 0.2;
    if (uHasFace > 0.5) {
      vec3 ref = (videoAt(uFace[0]) + videoAt(uFace[1]) + videoAt(uFace[2])) / 3.0;
      seen = max(seen, like(mean, ref));
      dark = 0.45 * luma(ref);
    }
    if (uHasSkin > 0.5)
      seen = max(seen, smoothstep(0.35, 0.65, texture2D(tSkin, vec2(vPx.x / uSrc.x, 1.0 - vPx.y / uSrc.y)).r)
        * smoothstep(0.8 * dark, dark, luma(mean)));
    float a = inside * beyond * seen * person * uHandAlpha;
    if (a < 0.004) discard;
    // The video is written as stored (sRGB), as the compositor's own video quads.
    gl_FragColor = vec4(here, a);
  }
`;

/** What the compositor hands over each frame, after the torso warp. */
export type F3xFrame = {
  frame: LiveFrame;
  /** The drawn solve (held while still). */
  solution: ArSolution;
  /** The posed joints in scene metres (lShoulder, lElbow, lWrist, …). */
  joints: Record<string, Vec3>;
  /** The torso layer's glue, already warped this frame (its mapPoint places the armholes). */
  torso: Pick<ArGlue, 'mapPoint'>;
  /** This frame's smoothed landmarks (the glue's), source px. */
  landmarks: readonly { x: number; y: number; visibility: number }[] | null;
  /** The sleeve proxy meshes (sleeveLayers.ts), for the sleeves' extents. */
  proxies: ReadonlyMap<string, Mesh>;
  /** The camera the layers were rendered with. */
  camera: Camera;
  /** The stillness lock: hold every sticker and the order. */
  still: boolean;
};

type SideState = {
  chain: SleeveChain | null;
  held: SleeveChain | null;
  elbow: PinBlend;
  wrist: PinBlend;
  /** How much of this sleeve the pieces draw (armOccluder.ts SleeveTakeover). */
  take: SleeveTakeover;
  /** ?f3xrigid=1: the One Euro of this arm's anchors. */
  steady?: OneEuroVecFilter;
  /** The real hand, held over short dropouts, and what is drawn of it this frame. */
  hand: HandHold;
  shown: { shape: HandShape; alpha: number } | null;
  extents: SleeveExtents | null;
  extentsT?: number;
  /** The sleeve's outside winding as drawn (three's front = +1), per index buffer; 0 unknown. */
  outside?: {
    index: BufferAttribute;
    count: number;
    winding: 1 | -1 | 0;
    /** The proxy's index with every triangle wound outside-counter-clockwise (unifyWinding). */
    unified: BufferAttribute;
    turned: number;
  };
  /** Web filter: the rest edges of the proxy's index and the buffer of the kept triangles. */
  web?: { index: BufferAttribute; count: number; restSq: Float32Array; kept: BufferAttribute };
  /** Web triangles left out of the last draw (diagnostics). */
  webs: number;
  /** The cuff band of the proxy's index (cuffBand), or null when the garment has none. */
  cuff?: { index: BufferAttribute; count: number; band: ReturnType<typeof cuffBand> };
  /** The sleeve head's triangles (headTriangles) of the proxy's index, or null. */
  head?: {
    index: BufferAttribute;
    count: number;
    triangles: Uint32Array | null;
    kept: BufferAttribute | null;
    rim: ReturnType<typeof headRim>;
  };
  ids?: { index: BufferAttribute; count: number; ids: Uint32Array; points: Float32Array };
};

const newSide = (): SideState => ({
  chain: null,
  held: null,
  elbow: new PinBlend(),
  wrist: new PinBlend(),
  take: new SleeveTakeover(),
  hand: new HandHold(),
  shown: null,
  extents: null,
  webs: 0,
});

/** Frames at the start during which the finisher's skin pass is asked for (program warm-up). */
const WARM_FRAMES = 30;

/** Knuckle landmarks (pinky, index) of each hand. */
const KNUCKLES = { L: [17, 19], R: [18, 20] } as const;

export class F3xSleeves {
  private readonly order = new ArmDepthOrder();
  private readonly sides: Record<Side, SideState> = { L: newSide(), R: newSide() };
  private plan: DrawItem[] = [];
  private fresh = false;
  /** True while the pieces draw any part of a sleeve: only then are the layers rendered for them. */
  private active = false;
  private fade?: WebGLRenderTarget;
  /** Skin points of the face this frame (the hand pass's colour reference), or null. */
  private face: [Pt, Pt, Pt] | null = null;
  /** True from update() until this frame's hands are drawn: the hand pass owns the hands. */
  private liveHands = false;
  private readonly inverse = new Matrix4();
  /** The camera of the last update (the layers' own): where the eye is for facingTriangles. */
  private eye?: Camera;
  /** The drawn heading of the last update (degrees). */
  private yawDeg = 0;
  /** Frames drawn since the programs were warmed (0 = not yet). */
  private warmed = 0;
  /** True when the last frame's layers were composited here. */
  drawnLast = false;

  private readonly uniforms = {
    tSleeve: { value: null as Texture | null },
    uBox: { value: new Vector4(-1, -1, 1, 1) },
    uSrc: { value: new Vector2(1, 1) },
    uSrcJ: { value: [new Vector2(), new Vector2(), new Vector2()] },
    uTgtJ: { value: [new Vector2(), new Vector2(), new Vector2()] },
    uDirS: { value: [new Vector2(0, 1), new Vector2(0, 1)] },
    uDirT: { value: [new Vector2(0, 1), new Vector2(0, 1)] },
    uLen: { value: new Vector4(1, 1, 1, 1) },
    uRoot: { value: new Vector4(1, 0, 0, 1) },
    uAcross: { value: 1 },
    uRad: { value: new Vector4(1, 1, 1, 1) },
    uCapStub: { value: 1 },
    uCuff: { value: 0 },
    uPart: { value: 0 },
    uShadow: { value: new Vector3(0, 1, 0) },
    uAlpha: { value: 1 },
  };
  private readonly colour = new ShaderMaterial({
    uniforms: this.uniforms,
    vertexShader: vertex,
    fragmentShader: colourFragment,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    transparent: true,
    // Premultiplied "over", as the glue's own layer copy.
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  });
  private readonly shadow = new ShaderMaterial({
    uniforms: this.uniforms,
    vertexShader: vertex,
    fragmentShader: shadowFragment,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    transparent: true,
    // Darkens the colour under it and keeps its alpha: no shadow where there is no jacket.
    blending: CustomBlending,
    blendSrc: ZeroFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendSrcAlpha: ZeroFactor,
    blendDstAlpha: OneFactor,
  });
  private readonly copy = new ShaderMaterial({
    uniforms: this.uniforms,
    vertexShader: vertex,
    fragmentShader: copyFragment,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    blending: NoBlending,
  });
  private readonly handUniforms = {
    tVideo: { value: null as Texture | null },
    tMask: { value: null as Texture | null },
    uHasMask: { value: 0 },
    tSkin: { value: null as Texture | null },
    uHasSkin: { value: 0 },
    uFace: { value: [new Vector2(), new Vector2(), new Vector2()] },
    uHasFace: { value: 0 },
    uBox: this.uniforms.uBox,
    uSrc: this.uniforms.uSrc,
    uHandA: { value: new Vector2() },
    uHandB: { value: new Vector2() },
    uThumb: { value: new Vector2() },
    uHandR: { value: new Vector2(1, 0) },
    uCuffAt: { value: new Vector2() },
    uCuffDir: { value: new Vector2(0, 1) },
    uHandAlpha: { value: 1 },
  };
  private readonly handMaterial = new ShaderMaterial({
    uniforms: this.handUniforms,
    vertexShader: vertex,
    fragmentShader: handFragment,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    transparent: true,
  });
  private readonly plain = new ShaderMaterial({
    uniforms: this.uniforms,
    vertexShader: vertex,
    fragmentShader: plainFragment,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    transparent: true,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  });
  private readonly quad = new Mesh(new PlaneGeometry(2, 2), this.colour as ShaderMaterial);
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera();
  private readonly v = new Vector3();
  private readonly show: ReadonlySet<string>;
  private readonly indices = new WeakMap<object, Partial<Record<OccluderPass, BufferAttribute>>>();

  /**
   * Lab diagnosis (`?f3xdebug=`, comma separated): `torso` draws the torso layer alone, `sleeves`
   * the pieces alone, `raw` the sleeve layers as rendered (no pieces) over the torso, `dropwebs`
   * leaves out the over-stretched triangles (SLEEVE.webStretch), `opencuff` leaves the cuffs open.
   */
  /**
   * `rigid` (?f3xrigid=1): the pieces draw the sleeves in every pose, not only while an arm is
   * over or behind the torso: no sleeve is ever warped through a per-frame 2D grid.
   */
  constructor(
    debugLayers: string | null = null,
    private readonly rigid = false,
  ) {
    this.show = new Set((debugLayers ?? '').split(',').filter(Boolean));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /**
   * Limits the depth-only body to the part that may hide this layer (armOccluder.ts) for the next
   * draw; returns the function that puts the full occluder back. No-op without a rig. The index
   * buffers are built once per rig and live as long as it does.
   */
  occlude(pass: OccluderPass, occluder: Mesh | null, scene: object): (() => void) | undefined {
    const undo: (() => void)[] = [];
    // A sleeve layer shows its outside only, on both paths: no pixel of a sleeve's inside is ever
    // rasterised (the cuff seen end-on was a hollow tube with a dark lining: user feedback U4;
    // and with the pieces the trunk no longer hides the armhole's inside).
    const side = pass === 'sleeveL' ? 'L' : pass === 'sleeveR' ? 'R' : null;
    const proxy = side ? this.proxies?.get(pass) : undefined;
    const winding = side ? (this.sides[side].outside?.winding ?? 0) : 0;
    const outside = side ? this.sides[side].outside : undefined;
    if (proxy && outside && winding !== 0 && !this.show.has('twosided')) {
      for (const m of Array.isArray(proxy.material) ? proxy.material : [proxy.material]) {
        const saved = m.side;
        m.side = winding > 0 ? FrontSide : BackSide;
        undo.push(() => {
          m.side = saved;
        });
      }
      // …with every triangle wound the same way round (unifyWinding), so one side is the outside
      // of the whole layer, the dropped shoulder's cap included.
      const geometry = proxy.geometry as BufferGeometry;
      if (geometry.getIndex() === outside.index) {
        geometry.setIndex(outside.unified);
        undo.push(() => {
          geometry.setIndex(outside.index);
        });
      }
    }
    // The web filter is a lab tool only (?f3xdebug=dropwebs). On every frame it removed the
    // upper arm of a RAISED arm: the preview skinning stretches that cloth past webStretch, and
    // it is real cloth, not a web (lead / F3, venue clip 8.6-12 s: only the forearms were drawn).
    if (side && proxy && this.show.has('dropwebs')) {
      const restore = this.dropWebs(this.sides[side], proxy, scene);
      if (restore) undo.push(restore);
    }
    if (side && proxy && !this.show.has('opencuff')) {
      const restore = this.closeCuffOf(side, proxy, scene);
      if (restore) undo.push(restore);
    }
    const rig = (scene as { live?: { rig?: MotionRig } }).live?.rig;
    // The per-layer body occluders only while an arm needs the pieces: else the current path's.
    // Fabric is continuous over the shoulder seam: the torso layer is drawn WITH the sleeve
    // heads (their outside only), as they are sewn into its armholes. Without them, and without
    // the arm in its occluder, the torso layer showed the inside of its back panel through the
    // armhole: a flat grey disc on the shoulder whenever a sleeve was ordered behind the torso
    // (live5 7.1-7.7 s), and a dark notch wherever a piece left the seam (profile).
    if (this.active && pass === 'torso' && !this.show.has('openarmhole'))
      for (const s of ['L', 'R'] as const) {
        const restore = this.plugArmhole(s, scene);
        if (restore) undo.push(restore);
      }
    if (this.active && occluder && rig) {
      let cache = this.indices.get(rig);
      if (!cache) this.indices.set(rig, (cache = {}));
      const index = (cache[pass] ??= new BufferAttribute(passOccluderIndex(rig, pass), 1));
      const geometry = occluder.geometry as BufferGeometry;
      const saved = geometry.getIndex();
      geometry.setIndex(index);
      undo.push(() => {
        geometry.setIndex(saved);
      });
    }
    return undo.length
      ? () => {
          for (let i = undo.length - 1; i >= 0; i--) undo[i]();
        }
      : undefined;
  }

  /**
   * Shows one sleeve's head in the torso pass: the triangles of the head whose outside faces the
   * camera, with the jacket's own material. Returns the function that hides the proxy again and
   * gives it back its index.
   */
  private plugArmhole(side: Side, scene: object): (() => void) | undefined {
    const st = this.sides[side];
    const proxy = this.proxies?.get(`sleeve${side}`);
    const asset = (
      scene as {
        jacketAsset?: { rest?: ArrayLike<number>; landmarks?: Record<string, number> };
      }
    ).jacketAsset;
    const rest = asset?.rest,
      landmark = asset?.landmarks?.[`cuff_${side}`];
    const geometry = proxy?.geometry as BufferGeometry | undefined;
    const index = geometry?.getIndex(),
      position = geometry?.getAttribute('position');
    const winding = st.outside?.winding ?? 0;
    if (!proxy || !geometry || !index || !rest || landmark === undefined) return undefined;
    if (!this.eye || winding === 0 || !(position instanceof BufferAttribute)) return undefined;
    if (st.head?.index !== index || st.head.count !== index.count) {
      const unified = st.outside?.index === index ? st.outside.unified.array : index.array;
      const triangles = headTriangles(unified, rest, landmark, HEAD_LENGTH_M);
      const kept = triangles ? new BufferAttribute(new Uint32Array(triangles.length), 1) : null;
      kept?.setUsage(DynamicDrawUsage);
      const rim = headRim(unified, rest, landmark, HEAD_LENGTH_M, HEAD_TUCK.lengthM);
      st.head = { index, count: index.count, triangles, kept, rim };
    }
    const { triangles, kept, rim } = st.head;
    if (!triangles || !kept) return undefined;
    const inverse = this.inverse.copy(proxy.matrixWorld).invert();
    // The head's lower rim tucked round the posed upper arm (HEAD_TUCK), put back after the pass.
    const joints = (scene as { joints?: Record<string, Vec3> }).joints;
    const S = joints?.[`${side.toLowerCase()}Shoulder`],
      E = joints?.[`${side.toLowerCase()}Elbow`];
    let untuck: (() => void) | undefined;
    // Lab only (?f3xdebug=tuck, default OFF): seen on one still frame per jacket, not on motion.
    const tuck = this.show.has('tuck');
    if (
      tuck &&
      rim &&
      S &&
      E &&
      position.array instanceof Float32Array &&
      position.itemSize === 3
    ) {
      const local = (p: Vec3): Vec3 => {
        this.v.set(p[0], p[1], p[2]).applyMatrix4(inverse);
        return [this.v.x, this.v.y, this.v.z];
      };
      const array = position.array;
      const scale = proxy.matrixWorld.getMaxScaleOnAxis() || 1;
      // Only the cloth round the upper arm: the dropped shoulder's cap (drawn with the sleeve
      // under ?f3shoulder=1) reaches over the chest and must stay where it is.
      const saved = closeCuff(
        array,
        rim,
        local(S),
        local(E),
        HEAD_TUCK.radiusM / scale,
        HEAD_TUCK.reachM / scale,
      );
      if (saved) {
        position.needsUpdate = true;
        untuck = () => {
          for (let k = 0; k < rim.ids.length; k++) {
            const o = rim.ids[k] * 3;
            array[o] = saved[k * 3];
            array[o + 1] = saved[k * 3 + 1];
            array[o + 2] = saved[k * 3 + 2];
          }
          position.needsUpdate = true;
        };
      }
    }
    // The eye in the proxy's own frame.
    this.v.setFromMatrixPosition(this.eye.matrixWorld).applyMatrix4(inverse);
    const n = facingTriangles(
      triangles,
      position.array,
      [this.v.x, this.v.y, this.v.z],
      winding,
      kept.array as Uint32Array,
    );
    if (n === 0) {
      untuck?.();
      return undefined;
    }
    kept.needsUpdate = true;
    const visible = proxy.visible;
    geometry.setIndex(kept);
    geometry.setDrawRange(0, n);
    proxy.visible = true;
    return () => {
      geometry.setIndex(index);
      geometry.setDrawRange(0, Infinity);
      proxy.visible = visible;
      untuck?.();
    };
  }

  /**
   * Closes one sleeve's cuff round the posed wrist for the next draw (closeCuff on the proxy's
   * shared positions); returns the function that puts the cloth back, or undefined.
   */
  private closeCuffOf(side: Side, proxy: Mesh, scene: object): (() => void) | undefined {
    const st = this.sides[side];
    const s = scene as {
      jacketAsset?: { rest?: ArrayLike<number>; landmarks?: Record<string, number> };
      joints?: Record<string, Vec3>;
    };
    const lower = side.toLowerCase();
    const E = s.joints?.[`${lower}Elbow`],
      W = s.joints?.[`${lower}Wrist`];
    const rest = s.jacketAsset?.rest,
      landmark = s.jacketAsset?.landmarks?.[`cuff_${side}`];
    const geometry = proxy.geometry as BufferGeometry;
    const index = geometry.getIndex(),
      position = geometry.getAttribute('position');
    if (!E || !W || !rest || landmark === undefined || !index) return undefined;
    if (!(position instanceof BufferAttribute) || !(position.array instanceof Float32Array))
      return undefined;
    if (position.itemSize !== 3 || rest.length < position.count * 3) return undefined;
    if (st.cuff?.index !== index || st.cuff.count !== index.count)
      st.cuff = {
        index,
        count: index.count,
        band: cuffBand(index.array, rest, landmark, CUFF.lengthM),
      };
    const band = st.cuff.band;
    if (!band) return undefined;
    // The joints are in scene metres; the positions in the proxy's own frame.
    const inverse = this.inverse.copy(proxy.matrixWorld).invert();
    const local = (p: Vec3): Vec3 => {
      this.v.set(p[0], p[1], p[2]).applyMatrix4(inverse);
      return [this.v.x, this.v.y, this.v.z];
    };
    const scale = proxy.matrixWorld.getMaxScaleOnAxis() || 1;
    const array = position.array;
    const saved = closeCuff(array, band, local(E), local(W), CUFF.radiusM / scale);
    if (!saved) return undefined;
    position.needsUpdate = true;
    return () => {
      for (let k = 0; k < band.ids.length; k++) {
        const o = band.ids[k] * 3;
        array[o] = saved[k * 3];
        array[o + 1] = saved[k * 3 + 1];
        array[o + 2] = saved[k * 3 + 2];
      }
      position.needsUpdate = true;
    };
  }

  /**
   * Leaves the web triangles (SLEEVE.webStretch) out of a sleeve proxy for the next draw; returns
   * the function that puts its own index back, or undefined when nothing was left out.
   */
  private dropWebs(st: SideState, proxy: Mesh, scene: object): (() => void) | undefined {
    st.webs = 0;
    const rest = (scene as { jacketAsset?: { rest?: ArrayLike<number> } }).jacketAsset?.rest;
    const geometry = proxy.geometry as BufferGeometry;
    const index = geometry.getIndex(),
      position = geometry.getAttribute('position');
    if (!rest || !index || !position || !(position instanceof BufferAttribute)) return undefined;
    if (position.itemSize !== 3 || rest.length < position.count * 3) return undefined;
    if (st.web?.index !== index || st.web.count !== index.count) {
      const kept = new BufferAttribute(new Uint32Array(index.count), 1);
      kept.setUsage(DynamicDrawUsage);
      st.web = { index, count: index.count, restSq: restEdges(index.array, rest), kept };
    }
    const { kept, restSq } = st.web;
    const n = unstretched(
      index.array,
      restSq,
      position.array,
      SLEEVE.webStretch,
      kept.array as Uint32Array,
    );
    st.webs = (index.count - n) / 3;
    if (n === index.count) return undefined;
    kept.needsUpdate = true;
    geometry.setIndex(kept);
    geometry.setDrawRange(0, n);
    return () => {
      geometry.setIndex(index);
      geometry.setDrawRange(0, Infinity);
    };
  }

  /** The sleeve proxies of the last update (sleeveLayers.ts keeps one map for its life). */
  private proxies?: ReadonlyMap<string, Mesh>;

  /** Finds, once per index buffer, which winding of a sleeve proxy is the sleeve's outside. */
  private findOutside(st: SideState, proxy: Mesh | undefined, bones: readonly [Vec3, Vec3, Vec3]) {
    const geometry = proxy?.geometry as BufferGeometry | undefined;
    const index = geometry?.getIndex(),
      position = geometry?.getAttribute('position');
    if (!proxy || !index || !position) return;
    if (st.outside?.index === index && st.outside.count === index.count && st.outside.winding)
      return;
    // Lab only (?f3xdebug=front, default OFF, NOT yet checked in a render): the outside is three's
    // front face, with the proxy's own index. The jacket's shader shades the back face as the
    // lining and the normals are built from this winding, so no pose decides it. The bone test
    // below is made once, on the first solved frame; when that frame's cloth is not round its arm
    // the sleeve is drawn inside out for the rest of the run (its far wall from inside: fill
    // light only, flat, under a lit sleeve head), in one run and not in the next
    // (.cache/handoff/F3X.md, round 9).
    if (this.show.has('front')) {
      st.outside = { index, count: index.count, winding: 1, unified: index, turned: 0 };
      return;
    }
    const v = this.v;
    const unified = unifyWinding(
      (i) => {
        v.fromBufferAttribute(position, i).applyMatrix4(proxy.matrixWorld);
        return [v.x, v.y, v.z];
      },
      index.array,
      bones,
    );
    // Wound outside-counter-clockwise in the scene; three flips the front face of a mirrored
    // object itself, so for a mirrored proxy the outside is its back face.
    const mirrored = proxy.matrixWorld.determinant() < 0;
    st.outside = {
      index,
      count: index.count,
      winding: mirrored ? -1 : 1,
      unified: new BufferAttribute(unified.index, 1),
      turned: unified.turned,
    };
  }

  /** Solves this frame's stickers and order. Call after the torso warp, before compose(). */
  update(a: F3xFrame) {
    this.proxies = a.proxies;
    this.eye = a.camera;
    for (const side of ['L', 'R'] as const) {
      const st = this.sides[side];
      if (a.still && st.held) {
        st.chain = st.held;
        continue;
      }
      st.chain = this.solve(a, side);
      st.held = a.still ? st.chain : null;
    }
    const bands = [this.sides.L.chain?.foreR ?? 0, this.sides.R.chain?.foreR ?? 0];
    const order = this.order.update({
      landmarks: a.frame.landmarks2d,
      world: a.frame.world,
      tMs: a.frame.t,
      bandPx: Math.max(bands[0], bands[1]),
      hold: a.still,
      yawDeg: (this.yawDeg =
        // The drawn heading, wrapped to (−180, 180].
        (Math.atan2(Math.sin(a.solution.pose.yaw), Math.cos(a.solution.pose.yaw)) * 180) / Math.PI),
    });
    this.plan = drawPlan(order);
    if (!a.still)
      for (const side of ['L', 'R'] as const) {
        const behind = order[side].upper === 'behind' || order[side].fore === 'behind';
        this.sides[side].take.update(this.order.overlap[side], behind, a.frame.t);
      }
    this.active = this.share('L') > 0 || this.share('R') > 0;
    this.face = a.landmarks ? facePoints(a.landmarks) : null;
    this.liveHands = true;
    // The real hands, live even while the stillness lock holds the pieces.
    for (const side of ['L', 'R'] as const) {
      const st = this.sides[side];
      st.shown = st.hand.update(
        a.landmarks ? handShape(a.landmarks, side, st.chain) : null,
        a.frame.t,
      );
    }
    this.uniforms.uSrc.value.set(a.frame.width, a.frame.height);
    this.fresh = true;
  }

  /** How much of a sleeve the pieces draw now: 0 without pieces for it; 1 with `?f3xdebug=always`. */
  private share(side: Side): number {
    const st = this.sides[side];
    return !st.chain ? 0 : this.rigid || this.show.has('always') ? 1 : st.take.weight;
  }

  private solve(a: F3xFrame, side: Side): SleeveChain | null {
    const st = this.sides[side];
    const s = a.solution,
      K = s.intrinsics;
    const lower = side.toLowerCase();
    const S = a.joints[`${lower}Shoulder`],
      E = a.joints[`${lower}Elbow`],
      Wr = a.joints[`${lower}Wrist`];
    if (!S || !E || !Wr) return null;
    this.findOutside(st, a.proxies.get(`sleeve${side}`), [S, E, Wr]);
    const ps = project(K, s.pose, s.pivot, S),
      pe = project(K, s.pose, s.pivot, E),
      pw = project(K, s.pose, s.pivot, Wr);
    // As the sleeve controls of the current path: a joint at or behind the lens cannot be drawn.
    if (ps[2] <= 0.3 || pe[2] <= 0.3 || pw[2] <= 0.3) return null;
    const source: ChainJoints = { s: [ps[0], ps[1]], e: [pe[0], pe[1]], w: [pw[0], pw[1]] };
    const shoulder = a.torso.mapPoint(source.s);
    const h = 8;
    const jx = a.torso.mapPoint([source.s[0] + h, source.s[1]]),
      jy = a.torso.mapPoint([source.s[0], source.s[1] + h]);
    const W = a.frame.width,
      H = a.frame.height;
    const idx = ARM_LANDMARKS[side];
    const pin = (blend: PinBlend, i: number): [Pt | null, number] => {
      const p = a.landmarks?.[i];
      const usable = !!p && p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H;
      const weight = blend.update(p?.visibility ?? 0, usable, a.frame.t);
      return [p && weight > 0 ? [p.x, p.y] : null, weight];
    };
    const [elbowAt, elbowWeight] = pin(st.elbow, idx.elbow);
    const [wristAt, wristWeight] = pin(st.wrist, idx.wrist);
    const jacobian: [number, number, number, number] = [
      (jx[0] - shoulder[0]) / h,
      (jy[0] - shoulder[0]) / h,
      (jx[1] - shoulder[1]) / h,
      (jy[1] - shoulder[1]) / h,
    ];
    // Always-on pieces: steady anchors (the landmark noise must not shake a sleeve at rest).
    let anchor = shoulder,
      elbow = elbowAt,
      wrist = wristAt;
    if (this.rigid && elbowAt && wristAt) {
      st.steady ??= new OneEuroVecFilter(6, SLEEVE.steady);
      const f = st.steady.filter([...shoulder, ...elbowAt, ...wristAt], a.frame.t);
      anchor = [f[0], f[1]];
      elbow = [f[2], f[3]];
      wrist = [f[4], f[5]];
    } else st.steady = undefined;
    const raw = a.frame.landmarks2d;
    let handLen: number | null = null;
    if (raw) {
      const w = raw[idx.wrist],
        p = raw[KNUCKLES[side][0]],
        i = raw[KNUCKLES[side][1]];
      if (w && p && i && Math.min(w.visibility, p.visibility, i.visibility) >= MIN_VISIBILITY)
        handLen = Math.hypot((p.x + i.x) / 2 - w.x, (p.y + i.y) / 2 - w.y);
    }
    return buildChain({
      source,
      shoulder: anchor,
      jacobian,
      elbow,
      wrist,
      elbowWeight,
      wristWeight,
      extents: this.measure(st, a.proxies.get(`sleeve${side}`), a.camera, W, H, source, a.frame.t),
      handLen,
    });
  }

  /** The rendered sleeve's extents from its proxy's vertices, smoothed over `extentTauMs`. */
  private measure(
    st: SideState,
    proxy: Mesh | undefined,
    camera: Camera,
    W: number,
    H: number,
    source: ChainJoints,
    tMs: number,
  ): SleeveExtents | null {
    const geometry = proxy?.geometry as BufferGeometry | undefined;
    const index = geometry?.getIndex(),
      position = geometry?.getAttribute('position');
    if (!proxy || !index || !position) return st.extents;
    if (st.ids?.index !== index || st.ids.count !== index.count) {
      const ids = sampleIds(index.array, SLEEVE.maxSamples);
      st.ids = { index, count: index.count, ids, points: new Float32Array(ids.length * 2) };
    }
    const { ids, points } = st.ids;
    const v = this.v;
    for (let i = 0; i < ids.length; i++) {
      v.fromBufferAttribute(position, ids[i])
        .applyMatrix4(proxy.matrixWorld)
        .applyMatrix4(camera.matrixWorldInverse);
      // three's camera looks down −z: a vertex at or behind the lens has no image.
      if (v.z > -0.05) {
        points[i * 2] = points[i * 2 + 1] = NaN;
        continue;
      }
      v.applyMatrix4(camera.projectionMatrix);
      points[i * 2] = (v.x * 0.5 + 0.5) * W;
      points[i * 2 + 1] = (0.5 - v.y * 0.5) * H;
    }
    const now = sleeveExtents(points, source);
    if (!now) return st.extents;
    const last = st.extents;
    const dt = st.extentsT === undefined || tMs < st.extentsT ? Infinity : tMs - st.extentsT;
    st.extentsT = tMs;
    const k = !last || dt === Infinity ? 1 : 1 - Math.exp(-dt / SLEEVE.extentTauMs);
    const mix = (x: number, y: number) => x + (y - x) * k;
    st.extents = last
      ? {
          capR: mix(last.capR, now.capR),
          upperR: mix(last.upperR, now.upperR),
          foreR: mix(last.foreR, now.foreR),
          elbowR: mix(last.elbowR, now.elbowR),
          cuffPast: mix(last.cuffPast, now.cuffPast),
        }
      : now;
    return st.extents;
  }

  private setChain(c: SleeveChain, part: DrawItem['part'], pad: number, headOnly = false) {
    const u = this.uniforms;
    const W = u.uSrc.value.x,
      H = u.uSrc.value.y;
    const joints = [c.source.s, c.source.e, c.source.w],
      targets = [c.target.s, c.target.e, c.target.w];
    for (let i = 0; i < 3; i++) {
      u.uSrcJ.value[i].set(joints[i][0], joints[i][1]);
      u.uTgtJ.value[i].set(targets[i][0], targets[i][1]);
    }
    for (let i = 0; i < 2; i++) {
      u.uDirS.value[i].set(c.dirS[i][0], c.dirS[i][1]);
      u.uDirT.value[i].set(c.dirT[i][0], c.dirT[i][1]);
    }
    u.uLen.value.set(c.lenS[0], c.lenS[1], c.lenT[0], c.lenT[1]);
    u.uRoot.value.set(c.rootInv[0], c.rootInv[1], c.rootInv[2], c.rootInv[3]);
    u.uAcross.value = c.across;
    u.uRad.value.set(c.capR, c.upperR, c.foreR, c.elbowR);
    u.uCapStub.value = c.capStub;
    u.uCuff.value = c.cuff;
    u.uPart.value = part === 'all' ? 0 : part === 'upper' ? 1 : 2;
    // Lab diagnosis: without the cap, or the forearm alone.
    if (this.show.has('nocap')) u.uRad.value.x = 0;
    if (this.show.has('foreonly')) u.uPart.value = 2;
    // The sleeve head alone: no upper band.
    if (headOnly) u.uRad.value.y = 0;
    const box = itemBox(c, part, pad);
    const x0 = clamp(box.min[0], 0, W),
      x1 = clamp(box.max[0], 0, W),
      y0 = clamp(box.min[1], 0, H),
      y1 = clamp(box.max[1], 0, H);
    // Image y runs down, NDC y up.
    u.uBox.value.set((x0 / W) * 2 - 1, 1 - (y1 / H) * 2, (x1 / W) * 2 - 1, 1 - (y0 / H) * 2);
    return x1 > x0 && y1 > y0;
  }

  /**
   * Composites the layers into the torso glue's warped target (premultiplied linear, as
   * ArGlue.warpTo): the pieces behind the torso, the torso, then the pieces in front. Null when
   * there is nothing fresh to draw (the caller then uses the current path).
   */
  compose(
    renderer: WebGLRenderer,
    torso: ArGlue,
    sleeves: readonly ArGlue[],
  ): WebGLRenderTarget | null {
    const share = { L: this.share('L'), R: this.share('R') };
    // No arm needs the pieces: the current path composites this frame.
    if (!this.fresh || sleeves.length !== 2 || (share.L === 0 && share.R === 0)) {
      this.fresh = false;
      this.drawnLast = false;
      return null;
    }
    this.fresh = false;
    const target = torso.warpedTarget;
    if (target.width !== torso.target.width || target.height !== torso.target.height)
      target.setSize(torso.target.width, torso.target.height);
    const layer = { L: sleeves[0], R: sleeves[1] };
    const draw = (item: DrawItem) => {
      const chain = this.sides[item.side].chain;
      // The far arm of a turned body is hidden behind the torso on a real jacket: past
      // `farHiddenDeg` only its sleeve head is drawn (under the torso: it shows through the
      // armhole and nowhere else), not the arm.
      const headOnly =
        item.under && this.order.far === item.side && Math.abs(this.yawDeg) >= SLEEVE.farHiddenDeg;
      if (!chain || share[item.side] === 0 || (headOnly && item.part === 'fore')) return;
      // Lab diagnosis: the left sleeve as its plain layer, the right one as pieces, in one frame.
      if (this.show.has('rawl') && item.side === 'L') return;
      const part = headOnly ? 'upper' : item.part;
      const u = this.uniforms;
      u.uAlpha.value = share[item.side];
      u.tSleeve.value = layer[item.side].target.texture;
      const k = SLEEVE.shadow;
      const band = item.part === 'upper' ? chain.upperR : chain.foreR;
      if (!item.under && k.strength > 0) {
        u.uShadow.value.set(k.strength, k.radiusOfBand * band, k.dropOfBand * band);
        if (this.setChain(chain, part, (k.radiusOfBand + k.dropOfBand) * band + 2)) {
          this.quad.material = this.shadow;
          renderer.render(this.scene, this.camera);
        }
      }
      if (this.setChain(chain, part, 2, headOnly)) {
        this.quad.material = this.colour;
        renderer.render(this.scene, this.camera);
      }
    };
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    const show = this.show;
    if (show.has('raw')) {
      torso.drawCopy(renderer);
      for (const g of sleeves) this.drawPlain(renderer, g.target.texture);
    } else {
      if (!show.has('torso')) for (const item of this.plan) if (item.under) draw(item);
      if (!show.has('sleeves')) torso.drawCopy(renderer);
      // The current path's warped sleeve, for the share the pieces do not draw (cross-fade).
      for (const side of ['L', 'R'] as const) {
        if (share[side] >= 1) continue;
        if (share[side] === 0) layer[side].drawCopy(renderer);
        else this.drawFaded(renderer, target, layer[side], 1 - share[side]);
      }
      if (!show.has('torso')) for (const item of this.plan) if (!item.under) draw(item);
      if (show.has('rawl')) this.drawPlain(renderer, layer.L.target.texture);
    }
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 1);
    this.drawnLast = true;
    return target;
  }

  /** The current path's warped sleeve layer at a share of its opacity, over the target. */
  private drawFaded(
    renderer: WebGLRenderer,
    target: WebGLRenderTarget,
    layer: ArGlue,
    alpha: number,
    box?: { min: Pt; max: Pt },
  ) {
    const fade = (this.fade ??= new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      depthBuffer: false,
    }));
    if (fade.width !== target.width || fade.height !== target.height)
      fade.setSize(target.width, target.height);
    renderer.setRenderTarget(fade);
    renderer.clear();
    layer.drawCopy(renderer);
    renderer.setRenderTarget(target);
    this.drawPlain(renderer, fade.texture, alpha, box);
  }

  /** A whole layer over what the target holds (premultiplied), at a share of its opacity. */
  private drawPlain(
    renderer: WebGLRenderer,
    layer: Texture,
    alpha = 1,
    box?: { min: Pt; max: Pt },
  ) {
    const u = this.uniforms;
    u.uAlpha.value = alpha;
    u.tSleeve.value = layer;
    u.uBox.value.set(-1, -1, 1, 1);
    if (box) {
      const W = u.uSrc.value.x,
        H = u.uSrc.value.y;
      const x0 = clamp(box.min[0], 0, W),
        x1 = clamp(box.max[0], 0, W),
        y0 = clamp(box.min[1], 0, H),
        y1 = clamp(box.max[1], 0, H);
      if (x1 <= x0 || y1 <= y0) return;
      u.uBox.value.set((x0 / W) * 2 - 1, 1 - (y1 / H) * 2, (x1 / W) * 2 - 1, 1 - (y0 / H) * 2);
    }
    this.quad.material = this.plain;
    renderer.render(this.scene, this.camera);
  }

  /**
   * The real-hand capsules the finisher may draw this frame: none while the pieces composite
   * (drawHands then draws the hands over the finished picture, past the cuffs). Undefined when
   * this frame's layers were not composited here: the current path's hands, untouched.
   */
  filterHands<T>(hands: readonly T[]): T[] | undefined {
    if (!this.liveHands || this.show.has('nohands')) return undefined;
    return hands.slice(0, 0);
  }

  /**
   * The real hands over the finished picture (canvas), each past its own cuff: the video where
   * the pixels are skin inside the hand's shape. Call after the finisher. `mask` is the person
   * mask (red channel, row 0 = top) or null. `finisher`: when it offers F4's skin mask
   * (ArFinish.requestSkinMask / skinMask, read-only), it is asked for while the pieces composite
   * and used as the skin evidence beside the frame's own chroma.
   */
  drawHands(
    renderer: WebGLRenderer,
    video: Texture | null,
    mask: Texture | null,
    finisher?: object,
  ) {
    const f4 = finisher as
      | { requestSkinMask?: boolean; skinMask?: { texture: Texture | null; valid: boolean } }
      | undefined;
    // On both paths (pieces or the current path's warped sleeves): the hand always composites
    // over the cuff's opening, moving or still.
    const wanted = this.liveHands && !this.show.has('nohands');
    this.liveHands = false;
    // The finisher's dark "lining" ellipse at a foreshortened cuff painted a hole on a cuff that
    // is now closed round the wrist: off while this flag is on.
    const options = (finisher as { options?: { cuffs?: boolean } } | undefined)?.options;
    if (options?.cuffs) options.cuffs = false;
    // Programs compile at their first draw (0.3–1.5 s on this machine: the picture froze the
    // first time the arms crossed). So they are drawn once at the start, off screen, and the
    // finisher's skin pass is asked for during the first frames as well as while it is needed.
    if (!this.warmed) this.warm(renderer);
    this.warmed++;
    if (f4 && 'requestSkinMask' in f4) f4.requestSkinMask = wanted || this.warmed <= WARM_FRAMES;
    if (!wanted || !video) return;
    const u = this.handUniforms;
    u.uHasFace.value = this.face ? 1 : 0;
    if (this.face) this.face.forEach((p, i) => u.uFace.value[i].set(p[0], p[1]));
    const skin = f4?.skinMask?.valid ? f4.skinMask.texture : null;
    u.tSkin.value = skin;
    u.uHasSkin.value = skin && !this.show.has('chroma') ? 1 : 0;
    u.tVideo.value = video;
    u.tMask.value = mask;
    u.uHasMask.value = mask ? 1 : 0;
    const W = u.uSrc.value.x,
      H = u.uSrc.value.y;
    renderer.setRenderTarget(null);
    for (const side of ['L', 'R'] as const) {
      const shown = this.sides[side].shown;
      // A hand behind the torso (behind the back) is not in front of the jacket.
      if (!shown || this.order.last[side].fore === 'behind') continue;
      const h = shown.shape;
      u.uHandA.value.set(h.a[0], h.a[1]);
      u.uHandB.value.set(h.b[0], h.b[1]);
      u.uThumb.value.set(h.thumb?.[0] ?? h.a[0], h.thumb?.[1] ?? h.a[1]);
      u.uHandR.value.set(h.radius, h.thumb ? h.thumbRadius : 0);
      u.uCuffAt.value.set(h.cuffAt[0], h.cuffAt[1]);
      u.uCuffDir.value.set(h.cuffDir[0], h.cuffDir[1]);
      u.uHandAlpha.value = shown.alpha;
      const points = h.thumb ? [h.a, h.b, h.thumb] : [h.a, h.b];
      const x0 = clamp(Math.min(...points.map((p) => p[0])) - h.radius - 2, 0, W),
        x1 = clamp(Math.max(...points.map((p) => p[0])) + h.radius + 2, 0, W),
        y0 = clamp(Math.min(...points.map((p) => p[1])) - h.radius - 2, 0, H),
        y1 = clamp(Math.max(...points.map((p) => p[1])) + h.radius + 2, 0, H);
      if (x1 <= x0 || y1 <= y0) continue;
      u.uBox.value.set((x0 / W) * 2 - 1, 1 - (y1 / H) * 2, (x1 / W) * 2 - 1, 1 - (y0 / H) * 2);
      this.quad.material = this.handMaterial;
      renderer.render(this.scene, this.camera);
    }
  }

  /** Compiles every program of this compositor by one empty draw each, off screen. */
  private warm(renderer: WebGLRenderer) {
    const target = new WebGLRenderTarget(1, 1, { depthBuffer: false });
    const box = this.uniforms.uBox.value.clone();
    try {
      // A quad of no area: the program links, no pixel is written.
      this.uniforms.uBox.value.set(0, 0, 0, 0);
      renderer.setRenderTarget(target);
      for (const m of [this.colour, this.shadow, this.plain, this.copy, this.handMaterial]) {
        this.quad.material = m;
        renderer.render(this.scene, this.camera);
      }
    } finally {
      this.uniforms.uBox.value.copy(box);
      renderer.setRenderTarget(null);
      target.dispose();
    }
  }

  /** Evaluation: the composited jacket's alpha at the source resolution (row 0 = top). */
  readMask(renderer: WebGLRenderer, composite: WebGLRenderTarget, width: number, height: number) {
    const rt = new WebGLRenderTarget(width, height, { type: UnsignedByteType, depthBuffer: false });
    const px = new Uint8Array(width * height * 4);
    const u = this.uniforms;
    const saved = u.tSleeve.value;
    try {
      u.tSleeve.value = composite.texture;
      u.uSrc.value.set(width, height);
      u.uBox.value.set(-1, -1, 1, 1);
      this.quad.material = this.copy;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.scene, this.camera);
      // As ArGlue.readMask: an async colour read may have left a PIXEL_PACK buffer bound.
      const gl = renderer.getContext() as WebGL2RenderingContext;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      renderer.readRenderTargetPixels(rt, 0, 0, width, height, px);
    } finally {
      u.tSleeve.value = saved;
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x000000, 1);
      rt.dispose();
    }
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        out[y * width + x] = px[((height - 1 - y) * width + x) * 4 + 3];
    return { data: out, width, height };
  }

  /** Diagnostics for the compositor's debugState. */
  get debug() {
    const side = (s: Side) => {
      const c = this.sides[s].chain;
      return c
        ? {
            pinned: c.pinned,
            /** Real bone length over the rendered one, upper arm and forearm. */
            stretch: [c.lenT[0] / c.lenS[0], c.lenT[1] / c.lenS[1]],
            bandPx: [c.capR, c.upperR, c.foreR, c.elbowR],
            cuffPx: c.cuff,
            held: this.sides[s].held === c,
            outside: this.sides[s].outside?.winding ?? 0,
            webs: this.sides[s].webs,
            /** Triangles of the sleeve layer wound the other way and turned (unifyWinding). */
            turned: this.sides[s].outside?.turned ?? 0,
          }
        : null;
    };
    const order: ArmOrder = this.order.last;
    return {
      drawn: this.drawnLast,
      /** Share of each sleeve the pieces draw (0 = the current path's warped sleeve). */
      share: [this.share('L'), this.share('R')],
      /** The far arm of a turned body (armOccluder.ts FarArm), or null. */
      far: this.order.far,
      /** Opacity of each real hand drawn over the pieces (0 = not seen). */
      hands: [this.sides.L.shown?.alpha ?? 0, this.sides.R.shown?.alpha ?? 0],
      order,
      scores: { ...this.order.scores },
      plan: this.plan.map((i) => `${i.under ? 'under' : 'over'}:${i.side}:${i.part}`),
      L: side('L'),
      R: side('R'),
    };
  }

  dispose() {
    this.quad.geometry.dispose();
    this.colour.dispose();
    this.shadow.dispose();
    this.copy.dispose();
    this.plain.dispose();
    this.fade?.dispose();
    this.fade = undefined;
    this.handMaterial.dispose();
    this.warmed = 0;
  }
}

/** The new sleeve path when `?f3x=1` is in the page's URL, else undefined (the current path). */
export function createF3x(search = typeof location === 'undefined' ? '' : location.search) {
  const params = new URLSearchParams(search);
  const rigid = params.get('f3xrigid') === '1';
  return f3xEnabled(search) || rigid ? new F3xSleeves(params.get('f3xdebug'), rigid) : undefined;
}
