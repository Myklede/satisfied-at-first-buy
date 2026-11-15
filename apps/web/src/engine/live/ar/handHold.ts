// Hand-capsule hold (agent F3, prompt 23 defect D3; behind ?f3arms=1). Pure apart from its own
// per-hand memory.
//
// The real-hand capsules (ArCompositor handCapsules) exist only on frames where the wrist, pinky
// and index landmarks are all visible. With crossed arms or hands in front of the chest those
// landmarks drop in and out frame to frame, so the real hand was cut out of the jacket on one
// frame and covered on the next (flicker), and the capsule's radius (from the knuckle spread)
// jumped as the hand turned. Here a capsule that disappears is kept for HAND_HOLD_MS while its
// wrist is still tracked, moved with the wrist; and a capsule's radius changes by at most
// HAND_RADIUS_STEP per frame. A hand TUCKED against the other arm (crossed arms: its wrist
// within HAND_TUCK_OF_SPAN shoulder spans of the other upper arm) is not cut out at all: the
// stale class mask then showed flickering skin specks across the crossed sleeves (judge A/B#2,
// parka 23.5–24.5 s); the sleeves cover it. Heuristics.
import type { ImageLandmark } from '../contract';

export type Capsule = { a: [number, number]; b: [number, number]; radius: number; depth: number };

/** How long a vanished hand capsule is kept while its wrist is tracked (ms). */
export const HAND_HOLD_MS = 250;
/** The wrist landmark still counts as tracked from this visibility (below the capsule's 0.5). */
export const HAND_HOLD_MIN_VISIBILITY = 0.2;
/** Largest relative change of a capsule's radius between frames. */
export const HAND_RADIUS_STEP = 0.2;
/** A wrist this close (× shoulder span) to the other arm's shoulder→elbow segment is tucked. */
export const HAND_TUCK_OF_SPAN = 0.22;

const WRISTS = [15, 16] as const;
/** The other arm's shoulder and elbow landmarks, per hand (left hand → right arm). */
const OTHER_ARM = [
  [12, 14],
  [11, 13],
] as const;

const segmentDistance = (p: ImageLandmark, a: ImageLandmark, b: ImageLandmark) => {
  const abx = b.x - a.x,
    aby = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / Math.max(1e-9, abx * abx + aby * aby)),
  );
  return Math.hypot(p.x - a.x - abx * t, p.y - a.y - aby * t);
};

/** True when side's wrist lies against the other upper arm (crossed arms). */
export function tucked(landmarks: readonly ImageLandmark[] | null, side: 0 | 1): boolean {
  const l = landmarks;
  const w = l?.[WRISTS[side]],
    s = l?.[OTHER_ARM[side][0]],
    e = l?.[OTHER_ARM[side][1]],
    sl = l?.[11],
    sr = l?.[12];
  if (!w || !s || !e || !sl || !sr) return false;
  if (Math.min(w.visibility, s.visibility, e.visibility, sl.visibility, sr.visibility) < 0.5)
    return false;
  const span = Math.hypot(sl.x - sr.x, sl.y - sr.y);
  return span > 1 && segmentDistance(w, s, e) < HAND_TUCK_OF_SPAN * span;
}

export class HandHold {
  private kept: ({ cap: Capsule; wrist: [number, number]; t: number } | null)[] = [null, null];

  reset() {
    this.kept = [null, null];
  }

  /** The capsules to draw this frame (t in ms). */
  update(t: number, capsules: readonly Capsule[], landmarks: readonly ImageLandmark[] | null) {
    const out: Capsule[] = [];
    for (let side = 0; side < 2; side++) {
      const w = landmarks?.[WRISTS[side]];
      if (tucked(landmarks, side as 0 | 1)) {
        this.kept[side] = null;
        continue;
      }
      // The compositor's capsule starts exactly at its wrist landmark.
      const cap = w ? capsules.find((c) => c.a[0] === w.x && c.a[1] === w.y) : undefined;
      const prev = this.kept[side];
      if (cap && w) {
        let radius = cap.radius;
        if (prev && t - prev.t <= HAND_HOLD_MS)
          radius = Math.min(
            prev.cap.radius * (1 + HAND_RADIUS_STEP),
            Math.max(prev.cap.radius * (1 - HAND_RADIUS_STEP), radius),
          );
        const held: Capsule = { ...cap, radius };
        this.kept[side] = { cap: held, wrist: [w.x, w.y], t };
        out.push(held);
        continue;
      }
      if (prev && w && w.visibility >= HAND_HOLD_MIN_VISIBILITY && t - prev.t <= HAND_HOLD_MS) {
        const dx = w.x - prev.wrist[0],
          dy = w.y - prev.wrist[1];
        out.push({
          a: [prev.cap.a[0] + dx, prev.cap.a[1] + dy],
          b: [prev.cap.b[0] + dx, prev.cap.b[1] + dy],
          radius: prev.cap.radius,
          depth: prev.cap.depth,
        });
        continue;
      }
      if (!prev || t - prev.t > HAND_HOLD_MS) this.kept[side] = null;
    }
    // Capsules not matched to a wrist (none today) pass through unchanged.
    for (const c of capsules)
      if (
        !WRISTS.some(
          (i) => landmarks?.[i] && c.a[0] === landmarks[i].x && c.a[1] === landmarks[i].y,
        )
      )
        out.push(c);
    return out;
  }
}
