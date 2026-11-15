// Arm occlusion for the AR jacket, the new approach to defect D3 (agent F3X, prompt 23a; URL flag
// ?f3x=1, default OFF). Pure: no Three.js, no DOM.
//
// Crossed arms and hands in front of the chest broke the sleeve layers three ways:
//   1. every layer was cut by the WHOLE posed body, so the torso layer had an arm-shaped hole where
//      the posed arm crossed it, and a sleeve was cut wherever the noisy posed arm sank into the
//      posed chest. After the layers were warped separately the holes no longer lined up;
//   2. the sleeves were always composited over the torso, whatever the arm's real depth;
//   3. nothing kept the order from flipping frame to frame.
// Here:
//   - passOccluderIndex: the part of the posed body that may hide each layer. The torso layer is
//     hidden by the trunk and head only (never by an arm: it is whole under the sleeves); a sleeve
//     layer by its own arm (the sleeve's inside) and the head only.
//   - ArmDepthOrder: per arm segment (upper arm, forearm), in front of the torso or behind it, from
//     MediaPipe's world depth, the landmark visibility and the 2D overlap with the torso, with a
//     time filter, two thresholds and a dwell, so the order never flickers. The same for which
//     forearm lies on top when both are in front.
//   - drawPlan: the order the sleeve pieces are composited around the torso layer.
import type { MotionRig } from '../../motion/rig';
import { NON_OCCLUDING_BONE, NON_OCCLUDING_WEIGHT } from './occluder';

/** The flag of the new sleeve path: `?f3x=1`. */
export const f3xEnabled = (search: string) => new URLSearchParams(search).get('f3x') === '1';

export type Side = 'L' | 'R';
export type Pt = [number, number];

// ---------------------------------------------------------------------------------------------
// Per-layer body occluders.

export type OccluderPass = 'torso' | 'sleeveL' | 'sleeveR';
export type BoneGroup = 'armL' | 'armR' | 'trunk' | 'head' | 'none';

/** MakeHuman arm bones (upperarm01/02, lowerarm01/02) and their side. */
const ARM_BONE = /^(upperarm|lowerarm)\d*\.([LR])$/;
/** Trunk and shoulder girdle. Every other occluding bone (neck, head, face) counts as head. */
const TRUNK_BONE = /^(root|pelvis|hips|spine|breast|clavicle|shoulder)/;

/** What a rig bone is for the per-layer occluders (`none`: hands and legs, occluder.ts). */
export function boneGroup(name: string): BoneGroup {
  if (NON_OCCLUDING_BONE.test(name)) return 'none';
  const arm = ARM_BONE.exec(name);
  if (arm) return arm[2] === 'L' ? 'armL' : 'armR';
  return TRUNK_BONE.test(name) ? 'trunk' : 'head';
}

const PASS_GROUPS: Record<OccluderPass, readonly BoneGroup[]> = {
  torso: ['trunk', 'head'],
  sleeveL: ['armL', 'head'],
  sleeveR: ['armR', 'head'],
};

/**
 * Triangle index (into the rig's vertices) of the body part that may hide one jacket layer. A
 * vertex belongs to the part when at least NON_OCCLUDING_WEIGHT of its skin weight is on the
 * part's bones; a triangle when all three vertices do.
 */
export function passOccluderIndex(
  rig: Pick<
    MotionRig,
    'bones' | 'skinIndices' | 'skinWeights' | 'influences' | 'vertexCount' | 'faces'
  >,
  pass: OccluderPass,
) {
  const groups = PASS_GROUPS[pass];
  const inPart = Uint8Array.from(rig.bones, (name) => (groups.includes(boneGroup(name)) ? 1 : 0));
  const keep = new Uint8Array(rig.vertexCount);
  const K = rig.influences;
  for (let v = 0; v < rig.vertexCount; v++) {
    let w = 0;
    for (let k = 0; k < K; k++)
      if (inPart[rig.skinIndices[v * K + k]]) w += rig.skinWeights[v * K + k];
    keep[v] = w >= NON_OCCLUDING_WEIGHT ? 1 : 0;
  }
  const out: number[] = [];
  const f = rig.faces;
  for (let t = 0; t < f.length; t += 3)
    if (keep[f[t]] && keep[f[t + 1]] && keep[f[t + 2]]) out.push(f[t], f[t + 1], f[t + 2]);
  return Uint32Array.from(out);
}

// ---------------------------------------------------------------------------------------------
// Depth order of the arm segments relative to the torso.

export type Layering = 'front' | 'behind';

/**
 * Order constants. Heuristic, set from MediaPipe's behaviour on the venue clips (world z noise of
 * a wrist held in front of the chest is ±5 cm; an occluded wrist reports visibility 0.1–0.4):
 */
export const ORDER = {
  /** World-depth difference (m) at which the depth evidence saturates. */
  dzFull: 0.12,
  /** Weights of the depth and the visibility evidence in the score (sum 1). */
  weightZ: 0.6,
  weightVisibility: 0.4,
  /** Filtered score below which a front segment goes behind, and above which it comes back. */
  toBehind: -0.3,
  toFront: -0.05,
  /** Time constant (ms) of the score filter with evidence, and without (no overlap). */
  tauMs: 150,
  tauIdleMs: 500,
  /** Score a segment relaxes to while it does not overlap the torso (in front). */
  idleScore: 0.2,
  /** Shortest time (ms) between two flips of one segment. */
  dwellMs: 250,
  /** Forearm pair: filtered depth difference (m) needed to swap which is on top, and its dwell. */
  pairDz: 0.05,
  pairTauMs: 250,
  pairDwellMs: 400,
  /**
   * Turned body (the drawn heading, degrees; + = turned to the person's left). From `yawFar` the
   * arm on the side turned away is behind the torso and the near arm in front, whatever the 2D
   * overlap says: at three-quarter and in profile the shoulder line collapses in the image and
   * the overlap test goes blind (user's RC4 recording: the far sleeve floated over the torso in
   * 131 frames). Back to the facing logic below `yawNear`; past `yawBack` the person shows the
   * back and both arms hang beside it again (leaves that state under `yawBackExit`).
   */
  yawFar: 32,
  yawNear: 22,
  yawBack: 150,
  yawBackExit: 140,
  /** Score taken off a far forearm: it is in front only on strong evidence (a far hand reaching across). */
  farForearm: 0.6,
} as const;

/**
 * Which arm is the far one for a turned body, with hysteresis on the heading: no flip-flop while
 * the heading hovers round a threshold. Null when the person faces the camera or shows the back.
 */
export class FarArm {
  far: Side | null = null;
  private back = false;

  update(yawDeg: number | null | undefined): Side | null {
    if (yawDeg === null || yawDeg === undefined || !Number.isFinite(yawDeg)) return this.far;
    const a = Math.abs(yawDeg);
    this.back = this.back ? a > ORDER.yawBackExit : a >= ORDER.yawBack;
    if (this.back) return (this.far = null);
    const side: Side = yawDeg > 0 ? 'L' : 'R';
    if (this.far === null) {
      if (a >= ORDER.yawFar) this.far = side;
    } else if (a < ORDER.yawNear) this.far = null;
    else if (this.far !== side && a >= ORDER.yawFar) this.far = side;
    return this.far;
  }
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Where along a→b the overlap is sampled: toward the far end, never at the joint shared with the torso. */
const OVERLAP_SAMPLES = [0.2, 0.4, 0.6, 0.8, 1] as const;

/** True when p is inside the convex quad (either winding). */
export function inQuad(p: Pt, quad: readonly Pt[]): boolean {
  let pos = false,
    neg = false;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i],
      b = quad[(i + 1) % quad.length];
    const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (c > 0) pos = true;
    else if (c < 0) neg = true;
  }
  return !(pos && neg);
}

/** Share (0..1) of the segment a→b that lies over the torso quad. */
export function torsoOverlap(a: Pt, b: Pt, quad: readonly Pt[]): number {
  let n = 0;
  for (const t of OVERLAP_SAMPLES)
    if (inQuad([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], quad)) n++;
  return n / OVERLAP_SAMPLES.length;
}

export type Evidence = {
  /** Share of the segment over the torso (0 = beside it: the order does not matter). */
  overlap: number;
  /** Torso depth − segment depth (m): positive = the segment is nearer the camera. Null: unknown. */
  dz: number | null;
  /** Landmark visibility of the segment's far joint(s), 0..1. */
  visibility: number;
};

/**
 * Evidence that a segment is in front of the torso, −1 (behind) .. +1 (in front); null when the
 * segment does not overlap the torso. A clearly visible arm stays in front even when the depth
 * is wrong by more than `dzFull`: the visibility term alone keeps the score above `toBehind`.
 */
export function frontScore(e: Evidence): number | null {
  if (e.overlap <= 0) return null;
  const z = e.dz === null ? 0 : clamp(e.dz / ORDER.dzFull, -1, 1);
  return ORDER.weightZ * z + ORDER.weightVisibility * (2 * clamp(e.visibility, 0, 1) - 1);
}

/** One segment's order with hysteresis: a filtered score, two thresholds and a dwell. */
export class SegmentOrder {
  state: Layering = 'front';
  /** The filtered score (diagnostics). */
  filtered = 0;
  private lastT?: number;
  private flippedAt = -Infinity;

  update(score: number | null, tMs: number): Layering {
    // A clip that restarts (time runs backward) starts over.
    if (this.lastT !== undefined && tMs < this.lastT) this.reset();
    const first = this.lastT === undefined;
    const dt = first ? 0 : tMs - this.lastT!;
    this.lastT = tMs;
    const target = score ?? ORDER.idleScore;
    const tau = score === null ? ORDER.tauIdleMs : ORDER.tauMs;
    this.filtered += (target - this.filtered) * (first ? 1 : 1 - Math.exp(-dt / tau));
    const want: Layering =
      this.state === 'front'
        ? this.filtered < ORDER.toBehind
          ? 'behind'
          : 'front'
        : this.filtered > ORDER.toFront
          ? 'front'
          : 'behind';
    if (want !== this.state && (first || tMs - this.flippedAt >= ORDER.dwellMs)) {
      this.state = want;
      this.flippedAt = tMs;
    }
    return this.state;
  }

  reset() {
    this.state = 'front';
    this.filtered = 0;
    this.lastT = undefined;
    this.flippedAt = -Infinity;
  }
}

/** Which forearm is drawn on top when both are in front, with hysteresis. */
export class PairOrder {
  top: Side = 'R';
  filtered = 0;
  private lastT?: number;
  private flippedAt = -Infinity;

  /** `dz` = left depth − right depth (m; positive: the right forearm is nearer); null = no evidence. */
  update(dz: number | null, tMs: number): Side {
    if (this.lastT !== undefined && tMs < this.lastT) {
      this.lastT = undefined;
      this.filtered = 0;
      this.flippedAt = -Infinity;
    }
    const first = this.lastT === undefined;
    const dt = first ? 0 : tMs - this.lastT!;
    this.lastT = tMs;
    if (dz === null) return this.top;
    this.filtered += (dz - this.filtered) * (first ? 1 : 1 - Math.exp(-dt / ORDER.pairTauMs));
    const want: Side =
      this.filtered > ORDER.pairDz ? 'R' : this.filtered < -ORDER.pairDz ? 'L' : this.top;
    if (want !== this.top && tMs - this.flippedAt >= ORDER.pairDwellMs) {
      this.top = want;
      this.flippedAt = tMs;
    }
    return this.top;
  }
}

/** BlazePose landmark indices of one side. */
export const ARM_LANDMARKS = {
  L: { shoulder: 11, elbow: 13, wrist: 15, hip: 23 },
  R: { shoulder: 12, elbow: 14, wrist: 16, hip: 24 },
} as const;

type Landmark2d = { x: number; y: number; visibility: number };
type LandmarkZ = { z: number };

/** Weight of the wrist (vs the elbow) in the forearm's depth and visibility. */
const FOREARM_WRIST_WEIGHT = 0.65;

/**
 * The order evidence of one arm from the image landmarks (px) and MediaPipe's world landmarks
 * (m, smaller z = nearer the camera; null when missing: the visibility alone decides).
 */
export function armEvidence(
  l: readonly Landmark2d[],
  world: readonly LandmarkZ[] | null,
  side: Side,
): { upper: Evidence; fore: Evidence; foreZ: number | null } | null {
  const i = ARM_LANDMARKS[side];
  const sL = l[11],
    sR = l[12],
    hL = l[23],
    hR = l[24];
  const S = l[i.shoulder],
    E = l[i.elbow],
    W = l[i.wrist];
  if (!sL || !sR || !hL || !hR || !S || !E || !W) return null;
  const quad: Pt[] = [
    [sL.x, sL.y],
    [sR.x, sR.y],
    [hR.x, hR.y],
    [hL.x, hL.y],
  ];
  const yS = (sL.y + sR.y) / 2,
    yH = (hL.y + hR.y) / 2;
  const have = !!world && [11, 12, 23, 24, i.elbow, i.wrist].every((k) => !!world[k]);
  // The torso's depth at an image height: between the shoulder line and the hip line.
  const torsoZ = (y: number) => {
    const zS = (world![11].z + world![12].z) / 2,
      zH = (world![23].z + world![24].z) / 2;
    const u = Math.abs(yH - yS) < 1e-6 ? 0 : clamp((y - yS) / (yH - yS), 0, 1);
    return zS + (zH - zS) * u;
  };
  const k = FOREARM_WRIST_WEIGHT;
  const foreZ = have ? world![i.elbow].z * (1 - k) + world![i.wrist].z * k : null;
  const foreY = E.y * (1 - k) + W.y * k;
  return {
    upper: {
      overlap: torsoOverlap([S.x, S.y], [E.x, E.y], quad),
      dz: have ? torsoZ(E.y) - world![i.elbow].z : null,
      visibility: E.visibility,
    },
    fore: {
      overlap: torsoOverlap([E.x, E.y], [W.x, W.y], quad),
      dz: foreZ === null ? null : torsoZ(foreY) - foreZ,
      visibility: E.visibility * (1 - k) + W.visibility * k,
    },
    foreZ,
  };
}

/** Distance (px) between two segments, 0 when they cross. */
export function segmentDistance(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const cross = (o: Pt, p: Pt, q: Pt) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a),
    d2 = cross(c, d, b),
    d3 = cross(a, b, c),
    d4 = cross(a, b, d);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  const toSegment = (p: Pt, u: Pt, v: Pt) => {
    const x = v[0] - u[0],
      y = v[1] - u[1];
    const h = clamp(((p[0] - u[0]) * x + (p[1] - u[1]) * y) / Math.max(x * x + y * y, 1e-9), 0, 1);
    return Math.hypot(p[0] - u[0] - x * h, p[1] - u[1] - y * h);
  };
  return Math.min(toSegment(a, c, d), toSegment(b, c, d), toSegment(c, a, b), toSegment(d, a, b));
}

export type ArmOrder = {
  L: { upper: Layering; fore: Layering };
  R: { upper: Layering; fore: Layering };
  /** The forearm drawn last (on top) among the front pieces. */
  foreTop: Side;
};

export type OrderInput = {
  /** Image landmarks (source px), 33 BlazePose points. */
  landmarks: readonly Landmark2d[] | null;
  /** World landmarks (m), or null. */
  world: readonly LandmarkZ[] | null;
  tMs: number;
  /** Forearm half-width (px): the two forearms count as overlapping within twice this. */
  bandPx?: number;
  /** Hold the states (the stillness lock): nothing may change while the person is still. */
  hold?: boolean;
  /** The drawn body heading (degrees, + = turned to the person's left), or null. */
  yawDeg?: number | null;
};

/** The order of both arms with its memory. */
export class ArmDepthOrder {
  private readonly segments = {
    L: { upper: new SegmentOrder(), fore: new SegmentOrder() },
    R: { upper: new SegmentOrder(), fore: new SegmentOrder() },
  };
  private readonly pair = new PairOrder();
  private readonly turned = new FarArm();
  /** The far arm of a turned body this frame (null: facing or back view). */
  far: Side | null = null;
  last: ArmOrder = {
    L: { upper: 'front', fore: 'front' },
    R: { upper: 'front', fore: 'front' },
    foreTop: 'R',
  };
  /** This frame's raw scores (diagnostics). */
  scores: Record<string, number | null> = {};
  /** Share of each forearm over the torso this frame (0 when not measured). */
  overlap: Record<Side, number> = { L: 0, R: 0 };

  update(input: OrderInput): ArmOrder {
    const l = input.landmarks;
    if (input.hold || !l) return this.last;
    const order: ArmOrder = { ...this.last, L: { ...this.last.L }, R: { ...this.last.R } };
    const foreZ: Partial<Record<Side, number | null>> = {};
    const far = (this.far = this.turned.update(input.yawDeg));
    for (const side of ['L', 'R'] as const) {
      const e = armEvidence(l, input.world, side);
      if (!e) continue;
      const upper = frontScore(e.upper),
        fore = frontScore(e.fore);
      this.scores[`${side}upper`] = upper;
      this.scores[`${side}fore`] = fore;
      if (far === side) {
        // The far arm of a turned body: behind the torso. Its forearm may still come in front on
        // strong evidence (the far hand reaching across the chest).
        order[side].upper = this.segments[side].upper.update(-1, input.tMs);
        order[side].fore = this.segments[side].fore.update(
          fore === null ? -1 : fore - ORDER.farForearm,
          input.tMs,
        );
      } else if (far !== null) {
        // The near arm: in front.
        order[side].upper = this.segments[side].upper.update(1, input.tMs);
        order[side].fore = this.segments[side].fore.update(1, input.tMs);
      } else {
        order[side].upper = this.segments[side].upper.update(upper, input.tMs);
        order[side].fore = this.segments[side].fore.update(fore, input.tMs);
      }
      foreZ[side] = e.foreZ;
      this.overlap[side] = e.fore.overlap;
    }
    // The forearm pair: evidence only while the two forearms lie over each other.
    const a = ARM_LANDMARKS.L,
      b = ARM_LANDMARKS.R;
    const pt = (k: number): Pt => [l[k].x, l[k].y];
    let dz: number | null = null;
    if (
      foreZ.L != null &&
      foreZ.R != null &&
      l[a.elbow] &&
      l[a.wrist] &&
      l[b.elbow] &&
      l[b.wrist]
    ) {
      const gap = segmentDistance(pt(a.elbow), pt(a.wrist), pt(b.elbow), pt(b.wrist));
      if (gap <= 2 * (input.bandPx ?? 0)) dz = foreZ.L - foreZ.R;
    }
    this.scores.pair = dz;
    order.foreTop = this.pair.update(dz, input.tMs);
    this.last = order;
    return order;
  }
}

// ---------------------------------------------------------------------------------------------
// When the sleeve pieces take over.

/**
 * The current path's warped sleeve is smooth and right while an arm hangs, is raised or reaches
 * out beside the body: the pieces only made its shoulders boxier there (venue clip, still and
 * arms up). It breaks when the arm comes in front of the torso or goes behind it. So the pieces
 * take over only then, per arm, with hysteresis and a cross-fade:
 */
export const TAKEOVER = {
  /** Share of the forearm over the torso from which the pieces take over… */
  on: 0.4,
  /** …and below which they give the sleeve back, */
  off: 0.2,
  /** once the arm has stayed clear this long (ms). */
  offDwellMs: 400,
  /** Cross-fade between the warped sleeve and the pieces (ms). */
  blendMs: 200,
} as const;

/** One arm's share of the pieces: 0 = the current path's warped sleeve, 1 = the pieces. */
export class SleeveTakeover {
  weight = 0;
  on = false;
  private clearSince?: number;
  private lastT?: number;

  /** `overlap` = share of the forearm over the torso; `behind` = a segment is behind the torso. */
  update(overlap: number, behind: boolean, tMs: number): number {
    if (this.lastT !== undefined && tMs < this.lastT) {
      this.lastT = undefined;
      this.clearSince = undefined;
      this.on = false;
      this.weight = 0;
    }
    const first = this.lastT === undefined;
    if (behind || overlap >= TAKEOVER.on || (this.on && overlap >= TAKEOVER.off)) {
      this.on = true;
      this.clearSince = undefined;
    } else if (this.on) {
      this.clearSince ??= tMs;
      if (tMs - this.clearSince >= TAKEOVER.offDwellMs) this.on = false;
    }
    const step = first ? 1 : (tMs - this.lastT!) / TAKEOVER.blendMs;
    this.lastT = tMs;
    this.weight = this.on ? Math.min(1, this.weight + step) : Math.max(0, this.weight - step);
    return this.weight;
  }
}

// ---------------------------------------------------------------------------------------------
// Composite order.

export type SleevePart = 'all' | 'upper' | 'fore';
export type DrawItem = { side: Side; part: SleevePart; under: boolean };

/**
 * The order the sleeve pieces are composited: `under` pieces first (then the torso layer), then
 * the pieces in front, the `foreTop` side last. A sleeve whose two segments agree is one piece.
 */
export function drawPlan(order: ArmOrder): DrawItem[] {
  const sides: Side[] = order.foreTop === 'L' ? ['R', 'L'] : ['L', 'R'];
  const under: DrawItem[] = [],
    uppers: DrawItem[] = [],
    fores: DrawItem[] = [];
  for (const side of sides) {
    const { upper, fore } = order[side];
    if (upper === fore) {
      (upper === 'behind' ? under : fores).push({ side, part: 'all', under: upper === 'behind' });
      continue;
    }
    (upper === 'behind' ? under : uppers).push({ side, part: 'upper', under: upper === 'behind' });
    (fore === 'behind' ? under : fores).push({ side, part: 'fore', under: fore === 'behind' });
  }
  return [...under, ...uppers, ...fores];
}
