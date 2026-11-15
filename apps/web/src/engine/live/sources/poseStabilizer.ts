// Landmark plausibility gate (agent F1, prompt 23a; defect atlas D9, "tracker instability"). Pure.
//
// MediaPipe in VIDEO mode starts each frame from the last region of interest; on a hard frame it
// can switch pose hypotheses for a frame, or alternate between them on IDENTICAL pixels:
//   - venue-khong-ao 18.05 s (F1 probe): the right arm raised overhead drops for ONE frame (elbow
//     44 → 245 → 83 px, wrist 0 → 212 → 21 px; upper arm 135 → 59 px) and the drawn sleeve followed;
//   - cam-tshirt retained frame (lead run 12:58, mean 60 px, max 210 px): the right elbow alternates
//     250 ↔ 403 px and the wrist 462 ↔ 703 px (upper arm 140 ↔ 280 px) while the rest stays put.
// Real motion on the same clip moves an elbow ≤ 60 px and a wrist ≤ 90 px per tracked frame, but
// foreshortens a forearm by up to 50 % per frame (118 → 63 → 30 px during an arm raise), so a bone
// length change alone is no evidence.
//
// No look-ahead: an accepted landmark passes through unchanged and adds no latency. A landmark is
// HELD (its previous accepted value repeated) only when its one-frame step is implausible:
//   - limbs (elbows, wrists, hand points): the step exceeds `limbJump` × the body scale, or it
//     exceeds `boneStep` × the scale while the bone to its parent changes length by more than
//     `boneJump`;
//   - torso: the torso's size changes by more than `sizeJump`, or its centre moves more than
//     `torsoJump` × the scale, or the shoulders swap left/right while both frames show a wide span
//     (a turn passes through a narrow side view; a glitch does not): the whole frame is held.
// A held value is released as soon as the next raw value stays with the new hypothesis (closer to
// it than to the held value: a real fast move or re-detection, at most one frame late), or after
// `maxHoldMs`. Thresholds are per frame at `refFrameMs` and scale with the frame gap. World
// landmarks of a held image landmark are held with it (the yaw and back cues stay coherent).
import type { ImageLandmark, WorldLandmark } from '../contract';

export interface StabilizerParams {
  /** A limb step beyond this × the body scale in one frame is implausible on its own. */
  limbJump: number;
  /** A limb step beyond this × the scale is implausible when the bone also jumps by boneJump. */
  boneStep: number;
  /** Relative bone-length change (vs the previous accepted frame) that counts as a jump. */
  boneJump: number;
  /** Torso size change (relative) in one frame that holds the whole frame. */
  sizeJump: number;
  /** Torso centre step (÷ scale) in one frame that holds the whole frame. */
  torsoJump: number;
  /** A left/right swap counts only when both frames' shoulder span ≥ this × the scale. */
  swapSpan: number;
  /** A landmark is never held longer than this (ms). */
  maxHoldMs: number;
  /** The frame gap the step thresholds are defined at (ms); longer gaps allow larger steps. */
  refFrameMs: number;
  /** Below this visibility a landmark is not judged (it is passed through as is). */
  minVisibility: number;
}

/**
 * Heuristics (F1, 2026-11-14), set against the cases above with margin: real motion on the venue
 * clip peaks at 0.2 × scale (elbow) and 0.3 × scale (wrist) per 66 ms; the glitches step 0.7 ×
 * scale (venue) and 0.36 × scale with a +100 % bone change (cam-tshirt close-up, scale 420 px).
 */
export const STABILIZER: StabilizerParams = {
  limbJump: 0.6,
  boneStep: 0.33,
  boneJump: 0.5,
  sizeJump: 0.2,
  torsoJump: 0.35,
  swapSpan: 0.4,
  maxHoldMs: 250,
  refFrameMs: 66,
  minVisibility: 0.3,
};

/** Child → parent for the limb bones (BlazePose indices), parents first. */
const PARENT: ReadonlyArray<readonly [number, number]> = [
  [13, 11],
  [14, 12],
  [15, 13],
  [16, 14],
  [17, 15],
  [19, 15],
  [21, 15],
  [18, 16],
  [20, 16],
  [22, 16],
];
const TORSO = [11, 12, 23, 24] as const;

export interface StabilizerResult {
  landmarks2d: ImageLandmark[] | null;
  world: WorldLandmark[] | null;
  /** Landmark indices held this frame (empty when the frame passed unchanged). */
  held: number[];
  /** Why the whole frame was held, if it was. */
  frameHeld: 'size' | 'centre' | 'swap' | null;
}

type Held = { since: number; raw: ImageLandmark };

export class PoseStabilizer {
  private prevOut: ImageLandmark[] | null = null;
  private prevWorld: WorldLandmark[] | null = null;
  private prevT?: number;
  private held = new Map<number, Held>();
  private frameHold: { since: number; raw: ImageLandmark[] } | null = null;
  /** Lab readout: frames and landmarks held so far. */
  stats = { frames: 0, framesHeld: 0, landmarksHeld: 0 };

  constructor(readonly params: StabilizerParams = STABILIZER) {}

  reset() {
    this.prevOut = this.prevWorld = null;
    this.prevT = undefined;
    this.held.clear();
    this.frameHold = null;
  }

  update(
    t: number,
    landmarks2d: readonly ImageLandmark[] | null,
    world: readonly WorldLandmark[] | null,
  ): StabilizerResult {
    const P = this.params;
    this.stats.frames++;
    if (!landmarks2d || landmarks2d.length < 25) {
      this.reset();
      return {
        landmarks2d: landmarks2d ? landmarks2d.map((p) => ({ ...p })) : null,
        world: world ? world.map((p) => ({ ...p })) : null,
        held: [],
        frameHeld: null,
      };
    }
    const prev = this.prevOut;
    const gap = this.prevT === undefined ? 0 : t - this.prevT;
    if (!prev || gap <= 0 || gap > 4 * P.maxHoldMs) {
      // First frame, a duplicate, or a gap / seek: accept as is.
      this.held.clear();
      this.frameHold = null;
      return this.accept(t, landmarks2d.slice(), world ? world.slice() : null, [], null);
    }
    const allow = Math.max(1, gap / P.refFrameMs);
    const scale = bodyScale(prev);
    const seen = (l: readonly ImageLandmark[], i: number) =>
      (l[i]?.visibility ?? 0) >= P.minVisibility;

    // Whole-frame plausibility (torso).
    let frameWhy: StabilizerResult['frameHeld'] = null;
    if (TORSO.every((i) => seen(prev, i) && seen(landmarks2d, i))) {
      const a = torso(prev),
        b = torso(landmarks2d);
      if (a.size > 1 && Math.abs(b.size / a.size - 1) > P.sizeJump * allow) frameWhy = 'size';
      else if (Math.hypot(b.cx - a.cx, b.cy - a.cy) > P.torsoJump * scale * allow)
        frameWhy = 'centre';
    }
    if (
      !frameWhy &&
      [11, 12].every((i) => seen(prev, i) && seen(landmarks2d, i)) &&
      dist(prev[11], prev[12]) >= P.swapSpan * scale &&
      dist(landmarks2d[11], landmarks2d[12]) >= P.swapSpan * scale &&
      Math.sign(prev[11].x - prev[12].x) !== Math.sign(landmarks2d[11].x - landmarks2d[12].x)
    )
      frameWhy = 'swap';
    if (frameWhy) {
      const fh = this.frameHold;
      // Released when this frame stays with the new hypothesis rather than the held one.
      const stays =
        !!fh &&
        TORSO.reduce((a, i) => a + dist(landmarks2d[i], fh.raw[i]), 0) <
          TORSO.reduce((a, i) => a + dist(landmarks2d[i], prev[i]), 0);
      const since = fh?.since ?? t;
      if (!stays && t - since < P.maxHoldMs) {
        this.frameHold = { since, raw: landmarks2d.map((p) => ({ ...p })) };
        this.stats.framesHeld++;
        this.prevT = t;
        return {
          landmarks2d: prev.map((p) => ({ ...p })),
          world: this.prevWorld ? this.prevWorld.map((p) => ({ ...p })) : null,
          held: range(landmarks2d.length),
          frameHeld: frameWhy,
        };
      }
      this.frameHold = null;
      this.held.clear();
      return this.accept(t, landmarks2d.slice(), world ? world.slice() : null, [], null);
    }
    this.frameHold = null;

    // Limb gate, parents before children.
    const out = landmarks2d.map((p) => ({ ...p }));
    const outWorld = world ? world.map((p) => ({ ...p })) : null;
    const heldNow: number[] = [];
    for (const [i, parent] of PARENT) {
      const now = landmarks2d[i],
        before = prev[i];
      if (!now || !before || !seen(landmarks2d, i) || !seen(prev, i)) {
        this.held.delete(i);
        continue;
      }
      const step = dist(now, before);
      const lenBefore = dist(prev[i], prev[parent]);
      const lenNow = dist(now, out[parent]);
      const implausible =
        step > P.limbJump * scale * allow ||
        (step > P.boneStep * scale * allow &&
          lenBefore > 0.05 * scale &&
          Math.abs(lenNow / lenBefore - 1) > P.boneJump);
      const h = this.held.get(i);
      if (!implausible) {
        this.held.delete(i);
        continue;
      }
      const stays = !!h && dist(now, h.raw) < dist(now, before);
      const since = h?.since ?? t;
      if (stays || t - since >= P.maxHoldMs) {
        this.held.delete(i);
        continue;
      }
      this.held.set(i, { since, raw: { ...now } });
      out[i] = { ...before };
      if (outWorld && this.prevWorld?.[i]) outWorld[i] = { ...this.prevWorld[i] };
      heldNow.push(i);
    }
    this.stats.landmarksHeld += heldNow.length;
    return this.accept(t, out, outWorld, heldNow, null);
  }

  private accept(
    t: number,
    l: ImageLandmark[],
    w: WorldLandmark[] | null,
    held: number[],
    frameHeld: StabilizerResult['frameHeld'],
  ): StabilizerResult {
    this.prevOut = l;
    this.prevWorld = w;
    this.prevT = t;
    return {
      landmarks2d: l.map((p) => ({ ...p })),
      world: w ? w.map((p) => ({ ...p })) : null,
      held,
      frameHeld,
    };
  }
}

function dist(a: ImageLandmark, b: ImageLandmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function range(n: number) {
  return Array.from({ length: n }, (_, i) => i);
}
function torso(l: readonly ImageLandmark[]) {
  const cx = TORSO.reduce((a, i) => a + l[i].x, 0) / 4,
    cy = TORSO.reduce((a, i) => a + l[i].y, 0) / 4;
  const size = Math.sqrt(
    TORSO.reduce((a, i) => a + (l[i].x - cx) ** 2 + (l[i].y - cy) ** 2, 0) / 4,
  );
  return { cx, cy, size };
}
/**
 * Body scale (px): the larger of the shoulder span and the shoulder-to-hip distance, so a side
 * view (span → 0) or a close-up with the hips out of the frame still has a sane scale.
 */
export function bodyScale(l: readonly ImageLandmark[]): number {
  const span = dist(l[11], l[12]);
  const ms = { x: (l[11].x + l[12].x) / 2, y: (l[11].y + l[12].y) / 2, visibility: 1 };
  const mh = { x: (l[23].x + l[24].x) / 2, y: (l[23].y + l[24].y) / 2, visibility: 1 };
  const hipsSeen = Math.min(l[23].visibility, l[24].visibility) >= 0.3;
  return Math.max(span, hipsSeen ? dist(ms, mh) : 0, 40);
}
