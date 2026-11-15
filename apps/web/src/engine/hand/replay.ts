// Dev/test only: replays a recorded hand session (packages/vision/test-data/hands/*.json, numbers
// only, no pixels) through a fresh PinchTracker in real time and feeds the events into the SAME
// handlers the live tracker feeds (HandPullController.handlePinch / handleFrame).
//
// Frame times are re-stamped with performance.now() at injection, the analogue of the live
// camera callback time, so latency is measured exactly like live minus MediaPipe inference
// (which the bench reports separately from a concurrently running real tracker).
import {
  PinchTracker,
  frameToObservations,
  parseHandRecording,
  type HandFrame,
  type PinchEvent,
} from '@satisfy/vision';
import { HAND_PULL } from './config';
import type { Ndc } from './mapping';

export interface ReplaySink {
  onPinch(event: PinchEvent): void;
  onFrame(frame: HandFrame): void;
}

export interface ReplayOptions {
  /** Playback speed (1 = real time). */
  speed?: number;
  /**
   * Shift (viewport NDC) applied to every point so the FIRST grab of the recording starts at
   * this viewport point (test harness placement: on the shoulder, off the garment, ...).
   */
  firstGrabAt?: Ndc;
  /** Fixed shift (viewport NDC) instead of firstGrabAt. */
  offset?: Ndc;
  signal?: AbortSignal;
}

export interface ReplaySummary {
  frames: number;
  starts: number;
  durationMs: number;
  offset: Ndc;
}

/** Validated recording (throws on malformed input). */
export function parseRecording(json: unknown) {
  return parseHandRecording(json);
}

type Recording = ReturnType<typeof parseHandRecording>;

/** First pinch start of a recording (tracker NDC), from a dry run with the default tuning. */
export function firstStart(rec: Recording): Ndc | undefined {
  const tracker = new PinchTracker();
  for (const f of rec.frames) {
    const { events } = tracker.update(
      f.t,
      f.width / f.height,
      frameToObservations(f, rec.swapHandedness),
    );
    const start = events.find((e) => e.type === 'start');
    if (start) return start.ndc;
  }
  return undefined;
}

export async function playRecording(
  json: unknown,
  sink: ReplaySink,
  options: ReplayOptions = {},
): Promise<ReplaySummary> {
  const rec = parseHandRecording(json),
    speed = options.speed ?? 1;
  if (!(speed > 0)) throw new RangeError('speed must be positive');
  let offset = options.offset ?? { x: 0, y: 0 };
  // Viewport shift → tracker NDC shift (toViewport divides by activeBox).
  let sx = offset.x * HAND_PULL.activeBox,
    sy = offset.y * HAND_PULL.activeBox;
  if (options.firstGrabAt) {
    const start = firstStart(rec);
    if (start) {
      // Computed in tracker NDC so a start outside the active box (clamped by toViewport)
      // still lands exactly on the requested viewport point.
      sx = options.firstGrabAt.x * HAND_PULL.activeBox - start.x;
      sy = options.firstGrabAt.y * HAND_PULL.activeBox - start.y;
      offset = { x: sx / HAND_PULL.activeBox, y: sy / HAND_PULL.activeBox };
    }
  }
  const shift = <T extends { x: number; y: number }>(p: T): T => ({
    ...p,
    x: p.x + sx,
    y: p.y + sy,
  });
  const tracker = new PinchTracker();
  const t0 = rec.frames[0]?.t ?? 0,
    started = performance.now();
  let starts = 0,
    last = started;
  for (const f of rec.frames) {
    if (options.signal?.aborted) break;
    const due = started + (f.t - t0) / speed,
      wait = due - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const frameTime = performance.now();
    last = frameTime;
    const { events, frame } = tracker.update(
      frameTime,
      f.width / f.height,
      frameToObservations(f, rec.swapHandedness),
    );
    for (const e of events) {
      if (e.type === 'start') starts++;
      sink.onPinch({ ...e, ndc: shift(e.ndc) });
    }
    sink.onFrame({
      ...frame,
      hands: frame.hands.map((h) => ({
        ...h,
        landmarks: h.landmarks.map(shift),
        pinchNdc: shift(h.pinchNdc),
      })),
    } as HandFrame);
  }
  for (const e of tracker.endAll(performance.now())) sink.onPinch({ ...e, ndc: shift(e.ndc) });
  return { frames: rec.frames.length, starts, durationMs: last - started, offset };
}
