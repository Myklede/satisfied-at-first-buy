// Pinch gestures on the person's own body -> garment state (pure, no DOM; agent ZB).
//
// Per hands frame: a pinch that STARTS on the zip pull, on the hood (round the head) or on the
// hem grabs it; while held, the hand's travel in body units (bodyFrame.ts) drives the value;
// letting go applies the same stop/snap rules as the cloth solver (engine/interact: snapSlider,
// INTERACT.hoodSnap 0.15, hoodAttachSnap 0.5). One grab at a time, first hand wins.
import type { GarmentState, JacketId, Landmark2D } from '../contract';
import { toBody, type BodyFrame } from './bodyFrame';
import { HEM_GRAB, HOOD_GRAB, ZIP_GRAB, ZIP_LINE } from './config';

export type GrabKind = 'zip' | 'hood-off' | 'hood-on' | 'hem';
export type Hand = 'Left' | 'Right';

export interface HandInput {
  handedness: Hand;
  pinching: boolean;
  pinchPoint: Landmark2D;
}

export type GestureValues = Pick<GarmentState, 'jacket' | 'zip' | 'hoodOn' | 'hemPull'>;

export interface GestureGrab {
  kind: GrabKind;
  hand: Hand;
  startedAt: number;
  /** Body coordinates (T) at the grab and now. */
  u0: number;
  v0: number;
  u: number;
  v: number;
  /** Zip value when the zip was grabbed. */
  zip0: number;
  /** 0..1: zip value (zip), or how far the hood/hem gesture has gone. */
  progress: number;
  /** The hood gesture passed its threshold (hoodOn already flipped on the bus). */
  committed: boolean;
}

export type PhysicsEvent =
  | { phase: 'start'; kind: GrabKind; timeMs: number }
  | { phase: 'move'; kind: GrabKind; timeMs: number; progress: number; du: number; dv: number }
  | { phase: 'end'; kind: GrabKind; timeMs: number; progress: number; committed: boolean };

export interface GestureOutput {
  /** Bus patch (source 'pinch'), or null when nothing changed. */
  patch: Partial<Pick<GarmentState, 'zip' | 'hoodOn' | 'hemPull'>> | null;
  events: PhysicsEvent[];
  grab: GestureGrab | null;
  /** Per visible hand: body coordinates and what a pinch there would grab (cursor feedback). */
  hands: { handedness: Hand; point: Landmark2D; pinching: boolean; target: GrabKind | null }[];
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Where the zip pull is (v, T) for a zip value on this jacket. */
export function pullV(jacket: JacketId, zip: number) {
  const line = ZIP_LINE[jacket];
  return line.vTop + clamp01(zip) * (line.vHem - line.vTop);
}

/** What a pinch starting at body (u, v) grabs, given the current garment state. */
export function hitTest(u: number, v: number, state: GestureValues): GrabKind | null {
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  const line = ZIP_LINE[state.jacket];
  if (
    Math.abs(u) <= ZIP_GRAB.halfWidth &&
    Math.abs(v - pullV(state.jacket, state.zip)) <= ZIP_GRAB.halfHeight
  )
    return 'zip';
  if (state.hoodOn) {
    if (v <= HOOD_GRAB.maxV && Math.abs(u) <= HOOD_GRAB.halfWidth) return 'hood-off';
  } else if (
    v >= HOOD_GRAB.onStartMinV &&
    v <= HOOD_GRAB.onStartMaxV &&
    Math.abs(u) <= HOOD_GRAB.onHalfWidth
  )
    return 'hood-on';
  if (
    v >= line.vHem - HEM_GRAB.above &&
    v <= line.vHem + HEM_GRAB.below &&
    Math.abs(u) <= HEM_GRAB.halfWidth
  )
    return 'hem';
  return null;
}

/** Zip value while the pull is held: relative to where it was grabbed, so no jump at the grab. */
export function zipFromPull(jacket: JacketId, zip0: number, v0: number, v: number) {
  const line = ZIP_LINE[jacket];
  return clamp01(zip0 + (v - v0) / (line.vHem - line.vTop));
}

/** Let go within ZIP_GRAB.snap of a stop: the zip runs to the stop. */
export function snapZip(zip: number) {
  return zip <= ZIP_GRAB.snap ? 0 : zip >= 1 - ZIP_GRAB.snap ? 1 : zip;
}

/** Progress 0..1 of a hood/hem gesture from the hand's travel since the grab (T). */
export function gestureProgress(kind: Exclude<GrabKind, 'zip'>, du: number, dv: number) {
  if (kind === 'hood-off') return clamp01(Math.hypot(du, dv) / HOOD_GRAB.offTravel);
  if (kind === 'hood-on') return clamp01(-dv / HOOD_GRAB.onTravel);
  return clamp01(dv / HEM_GRAB.travel);
}

/** A grabbed hand missing from the frames this long (ms) lets go (the tracker has its own grace). */
export const GRAB_LOST_MS = 600;

export class GestureMachine {
  private grab: GestureGrab | null = null;
  private wasPinching = new Map<Hand, boolean>();
  private lastSeen = 0;
  private lastZip = NaN;
  private lastHem = 0;

  get current() {
    return this.grab;
  }

  reset() {
    this.grab = null;
    this.wasPinching.clear();
  }

  update(
    timeMs: number,
    frame: BodyFrame | null,
    hands: readonly HandInput[],
    state: GestureValues,
  ): GestureOutput {
    const events: PhysicsEvent[] = [];
    let patch: GestureOutput['patch'] = null;
    const set = (p: NonNullable<GestureOutput['patch']>) => (patch = { ...(patch ?? {}), ...p });
    const out: GestureOutput['hands'] = [];
    for (const h of hands) {
      const body = frame ? toBody(frame, h.pinchPoint) : null;
      out.push({
        handedness: h.handedness,
        point: h.pinchPoint,
        pinching: h.pinching,
        target: body ? hitTest(body.u, body.v, state) : null,
      });
    }

    const g = this.grab;
    if (g) {
      const hand = hands.find((h) => h.handedness === g.hand);
      if (hand) this.lastSeen = timeMs;
      const released = hand ? !hand.pinching : timeMs - this.lastSeen > GRAB_LOST_MS;
      if (hand && hand.pinching && frame) {
        const b = toBody(frame, hand.pinchPoint);
        g.u = b.u;
        g.v = b.v;
        const du = g.u - g.u0,
          dv = g.v - g.v0;
        if (g.kind === 'zip') {
          g.progress = zipFromPull(state.jacket, g.zip0, g.v0, g.v);
          if (!(Math.abs(g.progress - this.lastZip) < ZIP_GRAB.minStep)) {
            this.lastZip = g.progress;
            set({ zip: g.progress });
          }
        } else {
          g.progress = gestureProgress(g.kind, du, dv);
          if (g.kind === 'hem') {
            if (Math.abs(g.progress - this.lastHem) >= ZIP_GRAB.minStep) {
              this.lastHem = g.progress;
              set({ hemPull: g.progress });
            }
          } else if (!g.committed && g.progress >= 1) {
            g.committed = true;
            set({ hoodOn: g.kind === 'hood-on' });
          }
        }
        events.push({ phase: 'move', kind: g.kind, timeMs, progress: g.progress, du, dv });
      }
      if (released) {
        this.grab = null;
        if (g.kind === 'zip') {
          const snapped = snapZip(g.progress);
          if (snapped !== this.lastZip) set({ zip: snapped });
          g.progress = snapped;
        } else if (g.kind === 'hem') {
          // Let go, the fabric springs back (the solver's hand pull releases the same way).
          set({ hemPull: 0 });
          this.lastHem = 0;
        } else {
          // Same snap rules as the cloth solver's hood zip (INTERACT.hoodSnap / hoodAttachSnap).
          if (g.kind === 'hood-off') {
            if (!g.committed && g.progress >= 1 - 0.15) set({ hoodOn: false });
            else if (g.committed && g.progress <= 0.5) set({ hoodOn: true });
          } else {
            if (!g.committed && g.progress >= 0.5) set({ hoodOn: true });
            else if (g.committed && g.progress < 0.5) set({ hoodOn: false });
          }
        }
        events.push({
          phase: 'end',
          kind: g.kind,
          timeMs,
          progress: g.progress,
          committed: g.committed,
        });
      }
    }

    // New grab: a pinch that just started (not one held since before), on a handle.
    if (!this.grab && frame) {
      for (const h of hands) {
        const before = this.wasPinching.get(h.handedness) ?? false;
        if (
          !h.pinching ||
          before ||
          (g && g.hand === h.handedness && events.some((e) => e.phase === 'end'))
        )
          continue;
        const b = toBody(frame, h.pinchPoint),
          kind = hitTest(b.u, b.v, state);
        if (!kind) continue;
        this.grab = {
          kind,
          hand: h.handedness,
          startedAt: timeMs,
          u0: b.u,
          v0: b.v,
          u: b.u,
          v: b.v,
          zip0: clamp01(state.zip),
          progress: kind === 'zip' ? clamp01(state.zip) : 0,
          committed: false,
        };
        this.lastSeen = timeMs;
        this.lastZip = clamp01(state.zip);
        this.lastHem = state.hemPull;
        events.push({ phase: 'start', kind, timeMs });
        break;
      }
    }
    for (const h of hands) this.wasPinching.set(h.handedness, h.pinching);
    // A hand that left the frame is not pinching any more.
    for (const key of [...this.wasPinching.keys()])
      if (!hands.some((h) => h.handedness === key)) this.wasPinching.set(key, false);
    return { patch, events, grab: this.grab, hands: out };
  }
}
