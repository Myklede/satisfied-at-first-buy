import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PINCH_TUNING,
  PinchTracker,
  dampedDisplacement,
  estimateHandDistanceM,
  fastness,
  focalLengthImageHeights,
  normalizedToNdc,
  pinchRatio,
  toIsotropic,
} from './pinch';
import type { HandObservation, Landmark, PinchUpdate } from './pinch';
import { synthHandNormalized } from './syntheticHand';
import type { Handedness, PinchEvent } from './types';

const ASPECT = 16 / 9;
const FRAME_MS = 1000 / 30;

interface HandSpec {
  /** Middle-finger MCP position in image-height units (u = x·aspect, v = y). */
  u: number;
  v: number;
  /** Wrist→middle-MCP length in image heights (0.15 ≈ a hand at ~0.75 m). */
  scale: number;
  /** Thumb tip to index tip gap / hand size (= the tip ratio). */
  ratio: number;
  /** Middle/ring/pinky curl (0..1). Default: a relaxed, semi-extended hand. */
  curl?: number;
  /** Index curl (default: same as curl). */
  indexCurl?: number;
}

/** Relaxed curl: finger extension stays above the open level, so only the thumb decides. */
const RELAXED_CURL = 0.45;

/** Articulated synthetic hand (syntheticHand.ts) in normalised image coords of a 16:9 frame. */
function makeHand({ u, v, scale, ratio, curl = RELAXED_CURL, indexCurl }: HandSpec): Landmark[] {
  return synthHandNormalized(
    { u, v, scale, curl, indexCurl, thumb: { kind: 'tip', gap: ratio } },
    ASPECT,
  );
}

function obs(hand: Handedness, spec: HandSpec, score = 0.95): HandObservation {
  return { hand, score, landmarks: makeHand(spec) };
}

const OPEN = 0.8;
const CLOSED = 0.1;
const base: HandSpec = { u: ASPECT / 2, v: 0.5, scale: 0.15, ratio: OPEN };
const closed: HandSpec = { ...base, ratio: CLOSED };

/** Runs frames at FRAME_MS spacing from t0; returns per-frame updates. */
function run(tracker: PinchTracker, frames: HandObservation[][], t0 = 0): PinchUpdate[] {
  return frames.map((f, i) => tracker.update(t0 + i * FRAME_MS, ASPECT, f));
}
const eventsOf = (updates: PinchUpdate[]): PinchEvent[] => updates.flatMap((u) => u.events);
/** Frames needed to confirm a pinch with the default tuning. */
const N = DEFAULT_PINCH_TUNING.enterFrames;
const times = <T>(n: number, make: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => make(i));
const kinds = (events: PinchEvent[]) => events.map((e) => `${e.type}:${e.hand}`);

/** A drag: pinched right hand moving +u at `speed` image heights/s for n frames. */
function drag(
  n: number,
  speed: number,
  opts: {
    startU?: number;
    ratio?: (i: number) => number;
    label?: (i: number) => Handedness;
  } = {},
): HandObservation[][] {
  const startU = opts.startU ?? 0.4;
  return Array.from({ length: n }, (_, i) => [
    obs(opts.label?.(i) ?? 'right', {
      ...closed,
      u: startU + (speed * i * FRAME_MS) / 1000,
      ratio: opts.ratio?.(i) ?? CLOSED,
    }),
  ]);
}

describe('geometry', () => {
  it('pinchRatio is gap/scale, aspect-corrected and scale-invariant', () => {
    for (const scale of [0.08, 0.15, 0.3]) {
      const iso = makeHand({ ...base, scale, ratio: 0.3 }).map((l) => toIsotropic(l, ASPECT));
      expect(pinchRatio(iso)).toBeCloseTo(0.3, 10);
    }
    const raw = makeHand({ ...base, ratio: 0.3 });
    expect(pinchRatio(raw)).toBeCloseTo(0.3 / ASPECT, 10);
  });

  it('pinchRatio of a degenerate hand is Infinity', () => {
    const pts = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    expect(pinchRatio(pts)).toBe(Infinity);
  });

  it('maps normalised coords to NDC with +y up and optional mirroring', () => {
    expect(normalizedToNdc(0.5, 0.5, true)).toEqual({ x: 0, y: 0 });
    expect(normalizedToNdc(0, 0, false)).toEqual({ x: -1, y: 1 });
    expect(normalizedToNdc(0, 0, true)).toEqual({ x: 1, y: 1 });
    expect(normalizedToNdc(1, 1, false)).toEqual({ x: 1, y: -1 });
  });

  it('estimates distance with a pinhole model; half the size = twice the distance', () => {
    const f = focalLengthImageHeights(ASPECT, 70);
    expect(f).toBeCloseTo(ASPECT / 2 / Math.tan((35 * Math.PI) / 180), 12);
    const iso = (scale: number) => makeHand({ ...base, scale }).map((l) => toIsotropic(l, ASPECT));
    const d1 = estimateHandDistanceM(iso(0.2), ASPECT, 70, 0.09);
    const d2 = estimateHandDistanceM(iso(0.1), ASPECT, 70, 0.09);
    expect(d1).toBeCloseTo((f * 0.09) / 0.2, 10);
    expect(d2 / d1).toBeCloseTo(2, 10);
  });

  it('uses the long side for a portrait frame', () => {
    expect(focalLengthImageHeights(9 / 16, 70)).toBeCloseTo(0.5 / Math.tan((35 * Math.PI) / 180));
  });

  it('damped extrapolation is v·τ·(1−e^(−t/τ)) and saturates at v·τ', () => {
    const [dx] = dampedDisplacement([2, 0], 100, 100);
    expect(dx).toBeCloseTo(2 * 0.1 * (1 - Math.exp(-1)), 12);
    expect(dampedDisplacement([2, 0], 1e6, 100)[0]).toBeCloseTo(0.2, 9);
    expect(dampedDisplacement([2, 0], 0, 100)).toEqual([0, 0]);
  });

  it('fastness ramps linearly between slow and fast speeds', () => {
    expect(fastness(0.1, 0.4, 1.5)).toBe(0);
    expect(fastness(0.95, 0.4, 1.5)).toBeCloseTo(0.5);
    expect(fastness(9, 0.4, 1.5)).toBe(1);
  });
});

describe('PinchTracker: basic pinch', () => {
  it('emits nothing for an open hand', () => {
    const tr = new PinchTracker();
    expect(
      eventsOf(
        run(
          tr,
          Array.from({ length: 10 }, () => [obs('right', base)]),
        ),
      ),
    ).toEqual([]);
  });

  it('needs enterFrames consecutive closed frames to start (rejects shorter dips)', () => {
    const tr = new PinchTracker();
    // A dip one frame shorter than enterFrames (seen in recordings while a hand opens/closes).
    const glitch = run(tr, [
      [obs('right', base)],
      ...times(N - 1, () => [obs('right', closed)]),
      [obs('right', base)],
    ]);
    expect(eventsOf(glitch)).toEqual([]);
    const ev = eventsOf(
      run(
        tr,
        times(N, () => [obs('right', closed)]),
        1000,
      ),
    );
    expect(kinds(ev)).toEqual(['start:right']);
    expect(ev[0].depthDelta).toBe(0);
    expect(ev[0].confidence).toBe(0.95);
    expect(ev[0].frameTime).toBeCloseTo(1000 + (N - 1) * FRAME_MS);
  });

  /** Pinched, slow tracker plus a stepper that returns each frame's update. */
  function pinchedSlow() {
    const tr = new PinchTracker();
    run(
      tr,
      times(N + 1, () => [obs('right', closed)]),
    );
    let t = (N + 1) * FRAME_MS;
    const step = (spec: HandSpec) => {
      const r = tr.update(t, ASPECT, [obs('right', spec)]);
      t += FRAME_MS;
      return r;
    };
    return { tr, step };
  }

  it('relaxed release (~0.5) ends after releaseMs; opening fingers never drag the point', () => {
    const { tr, step } = pinchedSlow();
    expect(kinds(step({ ...closed, ratio: 0.3 }).events)).toEqual(['move:right']); // band: hold
    const before = step(closed).frame.hands[0].rawPinchNdc;
    // The thumb opens to 0.5 (the natural grip point moves); the palm does not move, so the
    // grab point, anchored to the hand at grab start, must not move either.
    const needed = Math.round(DEFAULT_PINCH_TUNING.releaseMs / FRAME_MS);
    const ups = times(needed + 2, () => step({ ...closed, ratio: 0.5 }));
    const endAt = ups.findIndex((u) => u.events[0]?.type === 'end');
    // Released after releaseMs of evidence (± one frame of float rounding), not before.
    expect(endAt).toBeGreaterThanOrEqual(needed - 1);
    expect(endAt).toBeLessThanOrEqual(needed);
    for (const u of ups.slice(0, endAt + 1))
      expect(u.frame.hands[0].rawPinchNdc.x).toBeCloseTo(before.x, 10);
    expect(tr.pinchingHands()).toEqual([]);
  });

  it('a decisively open hand (thumb away, fingers extended) releases within ~130 ms', () => {
    const { step } = pinchedSlow();
    const types = times(5, () => kinds(step({ ...closed, ratio: 0.9 }).events)[0]);
    expect(types.indexOf('end:right')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('end:right')).toBeLessThanOrEqual(3); // ≤ 4 frames at 30 fps
  });

  it('thumb leaving a curled hand is a slow release (not decisive)', () => {
    const { step } = pinchedSlow();
    const types = times(
      14,
      () => kinds(step({ ...closed, ratio: 0.9, curl: 1.0, indexCurl: 0.5 }).events)[0],
    );
    const endAt = types.indexOf('end:right');
    expect(endAt).toBeGreaterThan(3);
    expect(endAt).toBeLessThanOrEqual(Math.round(DEFAULT_PINCH_TUNING.releaseMs / FRAME_MS));
  });

  it('isolated pinch-looking frames inside a relaxed release do not cancel it', () => {
    const { step } = pinchedSlow();
    const seq = [0.5, 0.5, 0.5, 0.2, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    const ends = seq
      .flatMap((r) => step({ ...closed, ratio: r }).events)
      .filter((e) => e.type === 'end');
    expect(ends).toHaveLength(1);
  });

  it('a re-confirmed pinch (enterFrames clear frames) cancels a pending release', () => {
    const { step } = pinchedSlow();
    const seq = [0.5, 0.5, 0.5, 0.5, ...times(N, () => CLOSED), 0.5, 0.5, 0.5, 0.5];
    const ends = seq
      .flatMap((r) => step({ ...closed, ratio: r }).events)
      .filter((e) => e.type === 'end');
    expect(ends).toHaveLength(0);
  });

  it('mirrors: moving the hand right in the camera image moves the cursor left on screen', () => {
    const tr = new PinchTracker({ mirrored: true });
    const moves = eventsOf(run(tr, drag(12, 0.6))).filter((e) => e.type === 'move');
    expect(moves[moves.length - 1].ndc.x).toBeLessThan(moves[0].ndc.x);
  });

  it('reports + depthDelta when the hand moves toward the camera', () => {
    const tr = new PinchTracker();
    const near = { ...closed, scale: 0.15 };
    const ev = eventsOf(
      run(tr, [
        ...times(N, () => [obs('right', near)]),
        ...times(150, () => [obs('right', { ...near, scale: 0.2 })]),
      ]),
    );
    const last = ev[ev.length - 1];
    const f = focalLengthImageHeights(ASPECT, DEFAULT_PINCH_TUNING.cameraFovDeg);
    const expected = f * DEFAULT_PINCH_TUNING.handScaleM * (1 / 0.15 - 1 / 0.2);
    expect(last.type).toBe('move');
    expect(last.depthDelta).toBeCloseTo(expected, 3);
  });

  it('smooths a jittery stationary pinch point', () => {
    const tr = new PinchTracker();
    let s = 12345;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return (s / 0xffffffff) * 2 - 1;
    };
    const ups = run(
      tr,
      Array.from({ length: 240 }, () => [
        obs('right', { ...closed, u: base.u + 0.004 * rnd(), v: base.v + 0.004 * rnd() }),
      ]),
    ).slice(60);
    const sd = (a: number[]) => {
      const m = a.reduce((p, c) => p + c, 0) / a.length;
      return Math.sqrt(a.reduce((p, c) => p + (c - m) ** 2, 0) / a.length);
    };
    const xs = ups.map((u) => u.frame.hands[0].pinchNdc.x);
    const raws = ups.map((u) => u.frame.hands[0].rawPinchNdc.x);
    expect(sd(xs)).toBeLessThan(0.4 * sd(raws));
  });
});

/**
 * Hallucinated contact (05-09-00): the world landmarks say "thumb on the index tip", but in the image
 * the thumb tip lies far behind the index -> 'ambiguous'.
 */
function ambiguousObs(spec: HandSpec): HandObservation {
  const world = makeHand(spec).map((l) => toIsotropic(l, ASPECT));
  const image = makeHand(spec).map((l, i) => (i === 4 ? { ...l, z: l.z + spec.scale * 0.6 } : l));
  return { hand: 'right', score: 0.95, landmarks: image, worldLandmarks: world };
}

describe('PinchTracker: dwell-to-confirm for ambiguous grips', () => {
  const { dwellMs, enterFrames } = DEFAULT_PINCH_TUNING;
  const dwellFrames = Math.ceil((enterFrames * (1000 / 30) + dwellMs) / FRAME_MS);

  it('a clear grip grabs on the fast path and reports gripConfidence clear', () => {
    const ups = run(
      new PinchTracker(),
      times(N + 2, () => [obs('right', closed)]),
    );
    const start = ups.findIndex((u) => u.events.some((e) => e.type === 'start'));
    expect(start).toBe(N - 1);
    expect(ups[start].events[0].gripConfidence).toBe('clear');
    expect(ups[start].frame.hands[0].grabProgress).toBe(1);
  });

  it('an ambiguous grip grabs only after the still dwell, with a smoothly rising progress', () => {
    const ups = run(
      new PinchTracker(),
      times(dwellFrames + 5, () => [ambiguousObs(closed)]),
    );
    const start = ups.findIndex((u) => u.events.some((e) => e.type === 'start'));
    expect(start).toBeGreaterThanOrEqual(dwellFrames - 2);
    expect(start).toBeLessThanOrEqual(dwellFrames + 1);
    expect(ups[start].events[0].gripConfidence).toBe('ambiguous');
    const prog = ups.slice(0, start).map((u) => u.frame.hands[0].grabProgress);
    for (let i = 1; i < prog.length; i++) {
      expect(prog[i]).toBeGreaterThanOrEqual(prog[i - 1] - 1e-9); // never drops while closed
      expect(prog[i] - prog[i - 1]).toBeLessThan(0.2); // no jumps
    }
    expect(ups.slice(0, start).every((u) => u.frame.hands[0].gripConfidence === 'ambiguous')).toBe(
      true,
    );
  });

  it('opening before the dwell completes cancels it; progress decays without jumps', () => {
    const half = Math.floor(dwellFrames / 2);
    const ups = run(new PinchTracker(), [
      ...times(half, () => [ambiguousObs(closed)]),
      ...times(20, () => [obs('right', base)]),
    ]);
    expect(eventsOf(ups)).toEqual([]);
    const prog = ups.map((u) => u.frame.hands[0].grabProgress);
    expect(Math.max(...prog)).toBeGreaterThan(0.2);
    for (let i = 1; i < prog.length; i++) expect(Math.abs(prog[i] - prog[i - 1])).toBeLessThan(0.2);
    expect(prog[prog.length - 1]).toBeLessThan(0.05);
  });

  it('an ambiguous grip that keeps moving does not grab', () => {
    const ups = run(
      new PinchTracker(),
      times(dwellFrames + 10, (i) => [
        ambiguousObs({ ...closed, u: 0.3 + (0.8 * i * FRAME_MS) / 1000 }),
      ]),
    );
    expect(eventsOf(ups).filter((e) => e.type === 'start')).toHaveLength(0);
  });

  it('a grip that turns clear during the dwell grabs at once', () => {
    const ups = run(new PinchTracker(), [
      ...times(N + 3, () => [ambiguousObs(closed)]),
      ...times(4, () => [obs('right', closed)]),
    ]);
    const start = ups.findIndex((u) => u.events.some((e) => e.type === 'start'));
    expect(start).toBeGreaterThanOrEqual(N + 3);
    expect(start).toBeLessThanOrEqual(N + 3 + DEFAULT_PINCH_TUNING.clearMinFrames);
  });
});

describe('PinchTracker: start speed gate', () => {
  it('a hand that closes while moving fast does not grab until it slows', () => {
    const tr = new PinchTracker();
    // Closed from frame 0 while moving at 2 image heights/s, then held still and closed.
    const moving = times(12, (i) => [
      obs('right', { ...closed, u: 0.4 + (2 * i * FRAME_MS) / 1000 }),
    ]);
    const still = times(15, () => [
      obs('right', { ...closed, u: 0.4 + (2 * 11 * FRAME_MS) / 1000 }),
    ]);
    const ups = run(tr, [...moving, ...still]);
    const startAt = ups.findIndex((u) => u.events.some((e) => e.type === 'start'));
    expect(startAt).toBeGreaterThanOrEqual(12); // not while moving fast
    expect(startAt).toBeLessThan(12 + 15); // but once slow and still closed
  });

  it('a still close grabs after enterFrames', () => {
    const ups = run(
      new PinchTracker(),
      times(N + 2, () => [obs('right', closed)]),
    );
    expect(ups.findIndex((u) => u.events.some((e) => e.type === 'start'))).toBe(N - 1);
  });
});

/** The speed gate is tested above; drag tests below start grabs on the move. */
const NO_GATE = { startMaxSpeed: 1e9 };

describe('PinchTracker: fast-motion robustness', () => {
  it('a 150 ms dropout during a fast drag keeps the grab and keeps the cursor moving', () => {
    const tr = new PinchTracker(NO_GATE);
    const frames = drag(30, 1.5);
    // Frames 15..18 missing: last seen at frame 14, back at frame 19 (≈167 ms later).
    for (let i = 15; i <= 18; i++) frames[i] = [];
    const ups = run(tr, frames);
    const ev = eventsOf(ups);
    expect(ev.filter((e) => e.type === 'start')).toHaveLength(1);
    expect(ev.filter((e) => e.type === 'end')).toHaveLength(0);
    for (let i = 15; i <= 18; i++) {
      expect(ups[i].frame.extrapolated).toEqual(['right']);
      expect(kinds(ups[i].events)).toEqual(['move:right']);
    }
    // Mirrored +u motion = decreasing NDC x: the cursor keeps going during the dropout...
    const xs = ups.slice(14, 19).map((u) => u.events[0].ndc.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeLessThan(xs[i - 1]);
    // ...and keeps going after the hand reappears (no snap back).
    expect(ups[19].events[0].ndc.x).toBeLessThan(xs[xs.length - 1]);
  });

  it('a dropout longer than graceMs ends the grab exactly once', () => {
    const tr = new PinchTracker(NO_GATE);
    const missing = Math.ceil(DEFAULT_PINCH_TUNING.graceMs / FRAME_MS) + 3;
    const ups = run(tr, [...drag(10, 1.0), ...times(missing, () => [])]);
    const ev = eventsOf(ups);
    expect(ev.filter((e) => e.type === 'end')).toHaveLength(1);
    const end = ev.find((e) => e.type === 'end');
    const lastSeen = 9 * FRAME_MS;
    expect(end!.frameTime - lastSeen).toBeGreaterThan(DEFAULT_PINCH_TUNING.graceMs);
    expect(end!.frameTime - lastSeen).toBeLessThan(DEFAULT_PINCH_TUNING.graceMs + FRAME_MS + 1);
  });

  it('fast motion with a blur-inflated ratio does not release; the same ratios when slow do', () => {
    // Every 3rd/4th frame pair reads 0.55 (above slow exit 0.40, below fast exit ~0.65).
    const blurry = (i: number) => (i > 6 && i % 4 >= 2 ? 0.55 : CLOSED);
    const fast = eventsOf(run(new PinchTracker(NO_GATE), drag(40, 2.0, { ratio: blurry })));
    expect(fast.filter((e) => e.type === 'end')).toHaveLength(0);
    const slow = eventsOf(run(new PinchTracker(NO_GATE), drag(40, 0.05, { ratio: blurry })));
    expect(slow.filter((e) => e.type === 'end').length).toBeGreaterThan(0);
  });

  it('fast motion: 4 frames of a high ratio do not release, a sustained opening does', () => {
    // 0.8 is below the fast open ratio (0.65 + 0.25): counts 1×, 4 frames ≈ 133 ms < 350 ms.
    const spike = (i: number) => (i >= 10 && i < 14 ? 0.8 : CLOSED);
    const ev = eventsOf(run(new PinchTracker(NO_GATE), drag(30, 2.0, { ratio: spike })));
    expect(ev.filter((e) => e.type === 'end')).toHaveLength(0);
    const release = (i: number) => (i >= 10 ? 0.9 : CLOSED);
    const ev2 = eventsOf(run(new PinchTracker(NO_GATE), drag(30, 2.0, { ratio: release })));
    expect(kinds(ev2).filter((k) => !k.startsWith('move'))).toEqual(['start:right', 'end:right']);
  });

  it('re-acquires a pinching hand after an unpredicted jump instead of end+start', () => {
    const tr = new PinchTracker(NO_GATE);
    const ev = eventsOf(
      run(tr, [
        ...times(N + 1, () => [obs('right', closed)]),
        [obs('right', { ...closed, u: closed.u + 0.35 })], // beyond the strict gate (0.225)
        [obs('right', { ...closed, u: closed.u + 0.36 })],
      ]),
    );
    expect(kinds(ev)).toEqual(['start:right', 'move:right', 'move:right', 'move:right']);
  });
});

describe('PinchTracker: identity and handedness', () => {
  it('a label flip mid-pinch never changes the hand or ends the grab', () => {
    const tr = new PinchTracker(NO_GATE);
    // Pinch as right, then MediaPipe says "left" (0.95) for 1 s while dragging fast.
    const ups = run(tr, drag(40, 1.2, { label: (i) => (i < 6 ? 'right' : 'left') }));
    const ev = eventsOf(ups);
    expect(new Set(ev.map((e) => e.hand))).toEqual(new Set(['right']));
    expect(ev.filter((e) => e.type !== 'move').map((e) => e.type)).toEqual(['start']);
    expect(new Set(ups.map((u) => u.frame.hands[0].trackId)).size).toBe(1);
  });

  it('after release, a sustained opposite label switches the track label (same track id)', () => {
    const tr = new PinchTracker(NO_GATE);
    const pinch = drag(10, 0.2, { label: () => 'right' });
    const relabelled = Array.from({ length: 40 }, () => [obs('left', { ...base, u: 0.45 })]);
    const ups = run(tr, [...pinch, ...relabelled]);
    const ids = new Set(ups.map((u) => u.frame.hands[0].trackId));
    expect(ids.size).toBe(1);
    const labels = ups.map((u) => u.frame.hands[0].hand);
    const firstLeft = labels.indexOf('left');
    expect(labels[ups.length - 1]).toBe('left');
    // Switch needs the opposite evidence to lead for labelSwitchHoldMs after the release.
    expect((firstLeft - 10) * FRAME_MS).toBeGreaterThanOrEqual(
      DEFAULT_PINCH_TUNING.labelSwitchHoldMs,
    );
  });

  it('short label flicker on an open, fast-moving hand never changes its label', () => {
    const tr = new PinchTracker(NO_GATE);
    // Right, then repeated bursts of 4 "left" frames (133 ms) out of every 10.
    const frames = Array.from({ length: 40 }, (_, i) => [
      obs(i % 10 >= 6 ? 'left' : 'right', { ...base, u: 0.3 + 0.04 * i }),
    ]);
    const ups = run(tr, frames);
    expect(new Set(ups.map((u) => u.frame.hands[0].hand))).toEqual(new Set(['right']));
    expect(new Set(ups.map((u) => u.frame.hands[0].trackId)).size).toBe(1);
  });

  const twoHands = (tr: PinchTracker) => {
    const l = { ...base, u: 0.4, ratio: CLOSED };
    const r = { ...base, u: 1.3, ratio: OPEN };
    return eventsOf(
      run(tr, [
        ...times(N, () => [obs('left', l), obs('right', r)]),
        ...times(N, () => [obs('left', l), obs('right', { ...r, ratio: CLOSED })]),
      ]),
    );
  };

  it('by default only one hand grabs at a time (a resting second hand cannot grab)', () => {
    const ev = twoHands(new PinchTracker(NO_GATE));
    expect(kinds(ev).filter((k) => !k.startsWith('move'))).toEqual(['start:left']);
  });

  it('with maxConcurrentGrabs 2, two hands grab independently', () => {
    const ev = twoHands(new PinchTracker({ maxConcurrentGrabs: 2 }));
    expect(kinds(ev)).toEqual([
      'start:left',
      ...times(N - 1, () => 'move:left'),
      'move:left',
      'start:right',
    ]);
  });

  it('two separate hands with the same label get distinct labels', () => {
    const tr = new PinchTracker(NO_GATE);
    const ups = run(tr, [
      [obs('left', { ...base, u: 0.4 }, 0.9), obs('left', { ...base, u: 1.3 }, 0.7)],
    ]);
    expect(new Set(ups[0].frame.hands.map((h) => h.hand))).toEqual(new Set(['left', 'right']));
  });

  it('merges a duplicate detection of the same hand', () => {
    const tr = new PinchTracker(NO_GATE);
    const ups = run(tr, [
      [obs('right', base, 0.9), obs('left', { ...base, u: base.u + 0.02 }, 0.6)],
    ]);
    expect(ups[0].frame.hands).toHaveLength(1);
    expect(ups[0].frame.hands[0].hand).toBe('right');
  });

  it('a same-label duplicate ~0.8 hand sizes away does not steal a pinch (recording 40-56)', () => {
    const tr = new PinchTracker(NO_GATE);
    const dup = { ...closed, v: closed.v + 0.8 * closed.scale };
    const ev = eventsOf(
      run(tr, [
        ...times(N + 2, () => [obs('left', closed)]),
        [obs('left', closed, 0.97), obs('left', dup, 0.99)],
        [obs('left', dup, 0.99)],
        ...times(5, () => [obs('left', dup)]),
      ]),
    );
    expect(ev.filter((e) => e.type !== 'move').map((e) => `${e.type}:${e.hand}`)).toEqual([
      'start:left',
    ]);
  });

  it('a hand that disappears and a new one far away is a new track', () => {
    const tr = new PinchTracker(NO_GATE);
    const ups = run(tr, [
      [obs('right', { ...base, u: 0.2 })],
      [obs('right', { ...base, u: 1.5 })], // 1.3 image heights away: beyond every gate
    ]);
    expect(ups[1].frame.hands[0].trackId).not.toBe(ups[0].frame.hands[0].trackId);
  });
});

describe('PinchTracker: lifecycle and validation', () => {
  it('endAll releases every active grab', () => {
    const tr = new PinchTracker();
    run(
      tr,
      times(N, () => [obs('right', closed)]),
    );
    expect(kinds(tr.endAll(500))).toEqual(['end:right']);
    expect(tr.endAll(600)).toEqual([]);
  });

  it('uses world landmarks for the ratio when provided', () => {
    const tr = new PinchTracker();
    const world = makeHand(closed).map((l) => toIsotropic(l, ASPECT));
    const o: HandObservation = { ...obs('right', base), worldLandmarks: world };
    expect(tr.update(0, ASPECT, [o]).frame.hands[0].pinchRatio).toBeCloseTo(CLOSED, 10);
  });

  it('rejects invalid tuning and malformed landmarks', () => {
    expect(() => new PinchTracker({ enterRatio: 0.5, exitRatio: 0.4 })).toThrow(RangeError);
    expect(() => new PinchTracker({ enterFrames: 0 })).toThrow(RangeError);
    expect(() => new PinchTracker({ releaseFastSpeed: 0.1 })).toThrow(RangeError);
    const tr = new PinchTracker();
    expect(() => tr.setTuning({ handScaleM: 1 })).toThrow(RangeError);
    expect(() =>
      tr.update(0, ASPECT, [{ hand: 'left', score: 1, landmarks: [{ x: 0, y: 0, z: 0 }] }]),
    ).toThrow(RangeError);
  });
});
