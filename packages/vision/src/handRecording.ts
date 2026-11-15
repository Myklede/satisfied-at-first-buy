// Landmark recordings for real-data regression tests. Pure (no DOM).
//
// A recording holds ONLY numbers: per-frame timestamps, frame size, MediaPipe's raw handedness
// label/score and the 21 image + world landmarks per hand. No pixels. The lab saves one only when
// the user clicks "Record landmarks"; put files in packages/vision/test-data/hands/ (gitignored,
// since hand geometry is body data) and `npx vitest run` replays them.
//
// Live tracking and replay share frameToObservations(), so a replay sees exactly what the live
// tracker saw.

import { DEFAULT_GRAB_MODEL, grabSignal, gripFeatures } from './grip';
import type { GrabModel, GripConfidence, GripType } from './grip';
import { HAND_LANDMARK_COUNT, PinchTracker } from './pinch';
import type { GrabEvent, HandObservation, Landmark, PinchTuning, PinchUpdate } from './pinch';
import type { Handedness, PinchEvent } from './types';

export const HAND_RECORDING_FORMAT = 'satisfy-hand-recording';
export const HAND_RECORDING_VERSION = 1;
/** Decimal places kept when saving: 1e-6 of the frame ≈ 0.001 px at 720p, i.e. lossless here. */
export const RECORDING_DECIMALS = 6;

export type Triple = [number, number, number];

export interface RecordedHand {
  /** MediaPipe categoryName as returned ('Left' | 'Right'), before any swap. */
  label: string;
  score: number;
  landmarks: Triple[];
  world?: Triple[];
}

export interface RecordedHandFrame {
  /** Camera frame time, performance.now() ms. */
  t: number;
  width: number;
  height: number;
  hands: RecordedHand[];
  /**
   * Ground-truth label from the lab's labelled mode: true while the user holds Space ("I am
   * grabbing"). It refers to the PRIMARY hand (see primaryHand()); absent in unlabelled files.
   */
  grab?: boolean;
}

/** Pose tags for labelled recordings (one per recording; record each pose separately). */
export const POSE_TAGS = [
  'tip-pinch',
  'occluded-pinch',
  'key-grip',
  'fist',
  'relaxed-open',
  'wave-point',
  'mixed',
] as const;
export type PoseTag = (typeof POSE_TAGS)[number];
/** Poses during which the user should never be grabbing: any tracker grab there is false. */
export const NON_GRAB_POSES: readonly PoseTag[] = ['relaxed-open', 'wave-point'];

export interface NegativeSpan {
  /** Seconds from the recording's first frame. */
  from: number;
  to: number;
  note?: string;
}

export interface HandRecordingMeta {
  note?: string;
  /** If set, the replay test asserts exactly this many pinch starts. */
  expectedPinches?: number;
  /** If set, the replay test asserts every pinch event carries this hand. */
  expectedHand?: Handedness;
  /** Marks a recording unusable (e.g. aborted); the replay test skips it and prints the reason. */
  invalid?: boolean;
  invalidReason?: string;
  /** Free-text review note added after analysis (the recording itself is unchanged). */
  reviewNote?: string;
  /**
   * Reviewed NON-grab windows (seconds from the first frame) confirmed by the user, e.g. a pose
   * that looked like a grab but was not. Any tracker grab overlapping one is a false grab.
   */
  negativeSpans?: NegativeSpan[];
  /** Pose performed in a labelled recording. */
  pose?: PoseTag;
}

export interface HandRecording {
  format: typeof HAND_RECORDING_FORMAT;
  version: typeof HAND_RECORDING_VERSION;
  createdAt: string;
  /** SWAP_MEDIAPIPE_HANDEDNESS in effect when recorded; replay applies the same. */
  swapHandedness: boolean;
  source: { camera: string; width: number; height: number; fps: number; delegate: string };
  /** Tuning in effect when recorded (informational; replay uses the tuning it is given). */
  tuning?: PinchTuning;
  meta: HandRecordingMeta;
  frames: RecordedHandFrame[];
}

const toLandmark = (p: Triple): Landmark => ({ x: p[0], y: p[1], z: p[2] });

/** Converts one raw frame to tracker observations (used live and in replay). */
export function frameToObservations(
  frame: RecordedHandFrame,
  swapHandedness: boolean,
): HandObservation[] {
  const out: HandObservation[] = [];
  for (const h of frame.hands) {
    const label = h.label.toLowerCase();
    if (label !== 'left' && label !== 'right') continue;
    let hand: Handedness = label;
    if (swapHandedness) hand = hand === 'left' ? 'right' : 'left';
    out.push({
      hand,
      score: h.score,
      landmarks: h.landmarks.map(toLandmark),
      worldLandmarks: h.world?.map(toLandmark),
    });
  }
  return out;
}

const round = (v: number) => Number(v.toFixed(RECORDING_DECIMALS));

export function serializeHandRecording(rec: HandRecording): string {
  const frames = rec.frames.map((f) => ({
    ...f,
    t: Number(f.t.toFixed(3)),
    hands: f.hands.map((h) => ({
      ...h,
      score: round(h.score),
      landmarks: h.landmarks.map((p) => p.map(round)),
      world: h.world?.map((p) => p.map(round)),
    })),
  }));
  return JSON.stringify({ ...rec, frames });
}

function fail(msg: string): never {
  throw new Error(`Invalid hand recording: ${msg}`);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseTriples(v: unknown, what: string): Triple[] {
  if (!Array.isArray(v) || v.length !== HAND_LANDMARK_COUNT)
    fail(`${what} must be ${HAND_LANDMARK_COUNT} [x,y,z] triples.`);
  return v.map((p) => {
    if (!Array.isArray(p) || p.length !== 3 || !p.every(isNum)) fail(`${what}: bad triple.`);
    return [p[0], p[1], p[2]] as Triple;
  });
}

/** Validates untrusted JSON (e.g. a file from test-data/) into a HandRecording. */
export function parseHandRecording(json: unknown): HandRecording {
  if (!isObj(json)) fail('not an object.');
  if (json.format !== HAND_RECORDING_FORMAT) fail(`format must be "${HAND_RECORDING_FORMAT}".`);
  if (json.version !== HAND_RECORDING_VERSION) fail(`unsupported version ${String(json.version)}.`);
  if (typeof json.swapHandedness !== 'boolean') fail('swapHandedness must be boolean.');
  if (!Array.isArray(json.frames)) fail('frames must be an array.');
  const metaIn = isObj(json.meta) ? json.meta : {};
  const meta: HandRecordingMeta = {};
  if (typeof metaIn.note === 'string') meta.note = metaIn.note;
  if (metaIn.expectedPinches !== undefined) {
    if (!Number.isInteger(metaIn.expectedPinches) || (metaIn.expectedPinches as number) < 0)
      fail('meta.expectedPinches must be an integer >= 0.');
    meta.expectedPinches = metaIn.expectedPinches as number;
  }
  if (metaIn.invalid !== undefined) {
    if (typeof metaIn.invalid !== 'boolean') fail('meta.invalid must be boolean.');
    meta.invalid = metaIn.invalid;
  }
  if (typeof metaIn.invalidReason === 'string') meta.invalidReason = metaIn.invalidReason;
  if (typeof metaIn.reviewNote === 'string') meta.reviewNote = metaIn.reviewNote;
  if (metaIn.negativeSpans !== undefined) {
    if (!Array.isArray(metaIn.negativeSpans)) fail('meta.negativeSpans must be an array.');
    meta.negativeSpans = metaIn.negativeSpans.map((sp, i): NegativeSpan => {
      if (!isObj(sp) || !isNum(sp.from) || !isNum(sp.to) || sp.to <= sp.from)
        fail(`meta.negativeSpans[${i}] needs numeric from < to (seconds).`);
      return {
        from: sp.from,
        to: sp.to,
        ...(typeof sp.note === 'string' ? { note: sp.note } : {}),
      };
    });
  }
  if (metaIn.pose !== undefined) {
    if (!(POSE_TAGS as readonly unknown[]).includes(metaIn.pose))
      fail(`meta.pose must be one of ${POSE_TAGS.join(', ')}.`);
    meta.pose = metaIn.pose as PoseTag;
  }
  if (metaIn.expectedHand !== undefined) {
    if (metaIn.expectedHand !== 'left' && metaIn.expectedHand !== 'right')
      fail('meta.expectedHand must be "left" or "right".');
    meta.expectedHand = metaIn.expectedHand;
  }
  const src = isObj(json.source) ? json.source : {};
  let lastT = -Infinity;
  const frames = json.frames.map((f, i): RecordedHandFrame => {
    if (!isObj(f)) fail(`frame ${i} is not an object.`);
    if (!isNum(f.t) || f.t < lastT) fail(`frame ${i}: t must be finite and non-decreasing.`);
    lastT = f.t;
    if (!isNum(f.width) || !isNum(f.height) || f.width <= 0 || f.height <= 0)
      fail(`frame ${i}: bad size.`);
    if (!Array.isArray(f.hands)) fail(`frame ${i}: hands must be an array.`);
    if (f.grab !== undefined && typeof f.grab !== 'boolean')
      fail(`frame ${i}: grab must be boolean.`);
    return {
      ...(typeof f.grab === 'boolean' ? { grab: f.grab } : {}),
      t: f.t,
      width: f.width,
      height: f.height,
      hands: f.hands.map((h, j) => {
        if (!isObj(h) || typeof h.label !== 'string' || !isNum(h.score))
          fail(`frame ${i} hand ${j}: needs label and score.`);
        return {
          label: h.label,
          score: h.score,
          landmarks: parseTriples(h.landmarks, `frame ${i} hand ${j} landmarks`),
          world: h.world === undefined ? undefined : parseTriples(h.world, `frame ${i} world`),
        };
      }),
    };
  });
  return {
    format: HAND_RECORDING_FORMAT,
    version: HAND_RECORDING_VERSION,
    createdAt: typeof json.createdAt === 'string' ? json.createdAt : '',
    swapHandedness: json.swapHandedness,
    source: {
      camera: typeof src.camera === 'string' ? src.camera : '',
      width: isNum(src.width) ? src.width : 0,
      height: isNum(src.height) ? src.height : 0,
      fps: isNum(src.fps) ? src.fps : 0,
      delegate: typeof src.delegate === 'string' ? src.delegate : '',
    },
    meta,
    frames,
  };
}

export interface ReplayResult {
  events: GrabEvent[];
  updates: PinchUpdate[];
}

/** Feeds a recording through a fresh PinchTracker, frame by frame. */
export function replayRecording(
  rec: HandRecording,
  tuning: Partial<PinchTuning> = {},
): ReplayResult {
  const tracker = new PinchTracker(tuning);
  const updates = rec.frames.map((f) =>
    tracker.update(f.t, f.width / f.height, frameToObservations(f, rec.swapHandedness)),
  );
  const last = rec.frames[rec.frames.length - 1];
  const events = updates.flatMap((u) => u.events);
  if (last) events.push(...tracker.endAll(last.t));
  return { events, updates };
}

/**
 * Checks the event stream obeys the PinchEvent protocol per hand: start, then moves, then end;
 * no move/end without a start, no double start, non-decreasing time. Returns violations.
 */
export function eventProtocolViolations(events: readonly PinchEvent[]): string[] {
  const problems: string[] = [];
  const active = new Map<Handedness, boolean>();
  let lastT = -Infinity;
  events.forEach((e, i) => {
    if (e.frameTime < lastT) problems.push(`#${i} ${e.type}: time went backwards`);
    lastT = e.frameTime;
    const on = active.get(e.hand) ?? false;
    if (e.type === 'start') {
      if (on) problems.push(`#${i} start:${e.hand} while already pinching`);
      active.set(e.hand, true);
    } else {
      if (!on) problems.push(`#${i} ${e.type}:${e.hand} without a start`);
      if (e.type === 'end') active.set(e.hand, false);
    }
    if (![e.ndc.x, e.ndc.y, e.depthDelta].every(Number.isFinite))
      problems.push(`#${i} non-finite payload`);
  });
  return problems;
}

// ---------- Split judge (independent of the tracker's STATE) ----------
// Decides from the per-frame grip openness (grip.ts grabSignal, tip-ratio scale) whether an
// end→start pair had a real release between them. It uses the same per-frame classifier as the
// tracker, so it catches splits made by the TEMPORAL logic (dropouts, blur, duplicates,
// debouncing), not per-frame classification errors: those need labelled recordings.
// Levels: clearly closed < 0.25, relaxed ≥ 0.40, clearly open ≥ 0.65 (2026-11-12 recordings).
/** Only end→start pairs closer than this are examined. */
export const SPLIT_WINDOW_MS = 1000;
/** A run of this many frames below SPLIT_CLEAR_RATIO counts as "clearly pinched". */
export const SPLIT_CLEAR_RATIO = 0.25;
export const SPLIT_CLEAR_FRAMES = 3;
/** A real release shows ≥ SPLIT_OPEN_FRAMES frames ≥ SPLIT_OPEN_RATIO... */
export const SPLIT_OPEN_RATIO = 0.65;
export const SPLIT_OPEN_FRAMES = 2;
/** ...or ≥ SPLIT_RELAXED_MS of observed time ≥ SPLIT_RELAXED_RATIO (per-frame step ≤ 50 ms). */
export const SPLIT_RELAXED_RATIO = 0.4;
export const SPLIT_RELAXED_MS = 300;

/**
 * Per-frame grip openness of the highest-scoring hand (undefined when no hand), plus its grip
 * type. Intended for ONE-HAND recordings.
 */
export function rawOpennessSeries(
  rec: HandRecording,
  model: GrabModel = DEFAULT_GRAB_MODEL,
): Array<{ t: number; r?: number; grip?: GripType }> {
  return rec.frames.map((f) => {
    const o = frameToObservations(f, rec.swapHandedness).sort((a, b) => b.score - a.score)[0];
    if (!o) return { t: f.t };
    const aspect = f.width / f.height;
    const iso = o.landmarks.map((l) => ({ x: l.x * aspect, y: l.y, z: l.z * aspect }));
    const s = grabSignal(gripFeatures(o.worldLandmarks ?? iso, iso), model);
    return { t: f.t, r: s.openness, grip: s.grip };
  });
}

/**
 * Frame times of 'end' events followed (same hand, within SPLIT_WINDOW_MS) by a 'start' with no
 * real release in the raw frames between the last clearly pinched run and that start.
 */
export function unexplainedSplits(
  rec: HandRecording,
  events: readonly PinchEvent[],
  model: GrabModel = DEFAULT_GRAB_MODEL,
): number[] {
  const series = rawOpennessSeries(rec, model);
  const out: number[] = [];
  for (const end of events) {
    if (end.type !== 'end') continue;
    const next = events.find(
      (e) => e.type === 'start' && e.hand === end.hand && e.frameTime > end.frameTime,
    );
    if (!next || next.frameTime - end.frameTime > SPLIT_WINDOW_MS) continue;
    let from = end.frameTime;
    let run = 0;
    for (const x of series) {
      if (x.t > end.frameTime || x.r === undefined) continue;
      run = x.r < SPLIT_CLEAR_RATIO ? run + 1 : 0;
      if (run >= SPLIT_CLEAR_FRAMES) from = x.t;
    }
    const between = series.filter(
      (x): x is { t: number; r: number } =>
        x.t > from && x.t <= next.frameTime && x.r !== undefined,
    );
    const open = between.filter((x) => x.r >= SPLIT_OPEN_RATIO).length;
    let relaxedMs = 0;
    for (let i = 1; i < between.length; i++)
      if (between[i].r >= SPLIT_RELAXED_RATIO)
        relaxedMs += Math.min(50, between[i].t - between[i - 1].t);
    if (open < SPLIT_OPEN_FRAMES && relaxedMs < SPLIT_RELAXED_MS) out.push(end.frameTime);
  }
  return out;
}

// ---------- Primary hand ----------
/**
 * The hand a recording is about. meta.expectedHand, unless MediaPipe labels the other hand on more
 * than PRIMARY_OVERRIDE_FRACTION of detections (then the meta is almost certainly wrong, e.g.
 * 04-11-39: "right" in meta, 858 of 861 detections "Left"). Labels (Space) refer to this hand;
 * a second hand (e.g. the one pressing Space) is scored separately as possible false grabs.
 */
export const PRIMARY_OVERRIDE_FRACTION = 0.9;

export function primaryHand(rec: HandRecording): { hand: Handedness; overridden: boolean } {
  let left = 0;
  let right = 0;
  for (const f of rec.frames)
    for (const o of frameToObservations(f, rec.swapHandedness))
      if (o.hand === 'left') left++;
      else right++;
  const majority: Handedness = left > right ? 'left' : 'right';
  const total = left + right;
  const expected = rec.meta.expectedHand;
  if (!expected) return { hand: majority, overridden: false };
  const opposite = expected === 'left' ? right : left;
  if (total > 0 && opposite / total > PRIMARY_OVERRIDE_FRACTION)
    return { hand: majority, overridden: true };
  return { hand: expected, overridden: false };
}

// ---------- Labelled evaluation ----------
/** Tracker grabs starting this long before a label onset still count for that label episode. */
export const LABEL_LEAD_MS = 300;
/**
 * Human key-press tolerance (ms) around every Space edge. Frames within it are not scored, and
 * latencies inside [−LABEL_TOLERANCE_MS, target + LABEL_TOLERANCE_MS] are treated as on time by
 * the tuner, so reaction lag (~150–300 ms) does not drive tuning. Label edges that are off by much
 * more (seen in 05-07-51 / 05-09-55: Space released or pressed with no hand change for > 1 s) are
 * NOT absorbed; they show up as latency outliers and are reviewed by hand.
 */
export const LABEL_TOLERANCE_MS = 300;

export interface LabelledEvaluation {
  /** Pose tag, or undefined when the tag conflicts with the labels (see poseConflict). */
  pose?: PoseTag;
  /** A non-grab pose (wave-point / relaxed-open) was tagged but Space was held: pose unknown. */
  poseConflict: boolean;
  /**
   * Tracker end+start pairs inside one label episode WITH a real release between them in the raw
   * frames (handRecording unexplainedSplits): the label covered several physical grabs. Not errors.
   */
  labelCoversSeveralGrabs: number;
  /** Label episodes (Space held) and how the tracker handled them. */
  episodes: number;
  missed: number;
  /** Tracker end+start pairs inside one label episode (mid-drag splits). */
  splits: number;
  /** Tracker grabs of the primary hand that overlap no label episode. */
  falseGrabs: number;
  /** Starts by any other hand (e.g. the hand on the keyboard). */
  otherHandGrabs: number;
  nonGrabMinutes: number;
  /** Label onset -> tracker grab (ms; negative = tracker before the key press). */
  grabLatencyMs: number[];
  /** The same latencies split by the confidence class the grab started with. */
  grabLatencyByConfidence: { clear: number[]; ambiguous: number[] };
  /** Primary-hand grabs overlapping a reviewed negative span (meta.negativeSpans). */
  negativeSpanGrabs: number;
  /** Grabbing time (ms) inside reviewed negative spans. */
  negativeSpanMs: number;
  /** Label offset -> tracker release (ms). */
  releaseLatencyMs: number[];
  /** Per-frame confusion of the primary hand (frames where it is detected or extrapolated). */
  frames: { tp: number; fp: number; fn: number; tn: number };
}

/**
 * Scores a labelled recording (frames carry `grab`). Note: label onsets lag the real grip by the
 * user's key-press reaction time (~150–250 ms), so grab latency can be negative.
 */
export function evaluateLabelled(
  rec: HandRecording,
  tuning: Partial<PinchTuning> = {},
): LabelledEvaluation {
  if (!rec.frames.some((f) => f.grab !== undefined))
    throw new Error('evaluateLabelled: recording has no grab labels.');
  const primary = primaryHand(rec).hand;
  const { events, updates } = replayRecording(rec, tuning);
  // Label episodes.
  const eps: Array<[number, number]> = [];
  let open: number | undefined;
  for (const f of rec.frames) {
    if (f.grab && open === undefined) open = f.t;
    if (!f.grab && open !== undefined) {
      eps.push([open, f.t]);
      open = undefined;
    }
  }
  const lastT = rec.frames[rec.frames.length - 1]?.t ?? 0;
  if (open !== undefined) eps.push([open, lastT]);
  // Tracker grab intervals of the primary hand.
  const grabs: Array<[number, number]> = [];
  const grabConfidence = new Map<number, GripConfidence>();
  let gs: number | undefined;
  let otherHandGrabs = 0;
  for (const e of events) {
    if (e.hand !== primary) {
      if (e.type === 'start') otherHandGrabs++;
      continue;
    }
    if (e.type === 'start') {
      gs = e.frameTime;
      grabConfidence.set(e.frameTime, e.gripConfidence);
    }
    if (e.type === 'end' && gs !== undefined) {
      grabs.push([gs, e.frameTime]);
      gs = undefined;
    }
  }
  if (gs !== undefined) grabs.push([gs, lastT]);

  const hasGrab = rec.frames.some((f) => f.grab);
  const poseConflict =
    rec.meta.pose !== undefined && NON_GRAB_POSES.includes(rec.meta.pose) && hasGrab;
  const unexplained = new Set(
    unexplainedSplits(
      rec,
      events.filter((e) => e.hand === primary),
      { ...DEFAULT_GRAB_MODEL, ...tuning.grabModel },
    ),
  );
  const out: LabelledEvaluation = {
    pose: poseConflict ? undefined : rec.meta.pose,
    poseConflict,
    labelCoversSeveralGrabs: 0,
    episodes: eps.length,
    missed: 0,
    splits: 0,
    falseGrabs: 0,
    otherHandGrabs,
    nonGrabMinutes: 0,
    grabLatencyMs: [],
    grabLatencyByConfidence: { clear: [], ambiguous: [] },
    negativeSpanGrabs: 0,
    negativeSpanMs: 0,
    releaseLatencyMs: [],
    frames: { tp: 0, fp: 0, fn: 0, tn: 0 },
  };
  for (const [a, b] of eps) {
    const inside = grabs.filter(([s, e]) => e > a - LABEL_LEAD_MS && s < b);
    if (!inside.length) {
      out.missed++;
      continue;
    }
    out.grabLatencyMs.push(inside[0][0] - a);
    out.grabLatencyByConfidence[grabConfidence.get(inside[0][0]) ?? 'clear'].push(inside[0][0] - a);
    for (const [, e] of inside.slice(0, -1))
      if (unexplained.has(e)) out.splits++;
      else out.labelCoversSeveralGrabs++;
    out.releaseLatencyMs.push(inside[inside.length - 1][1] - b);
  }
  for (const [s, e] of grabs)
    if (!eps.some(([a, b]) => e > a - LABEL_LEAD_MS && s < b + LABEL_LEAD_MS)) out.falseGrabs++;
  const edges: number[] = [];
  for (const [a, b] of eps) edges.push(a, b);
  let nonGrabMs = 0;
  rec.frames.forEach((f, i) => {
    if (i > 0 && !f.grab) nonGrabMs += f.t - rec.frames[i - 1].t;
    if (edges.some((e) => Math.abs(e - f.t) < LABEL_TOLERANCE_MS)) return;
    const u = updates[i];
    const seen =
      u.frame.hands.some((h) => h.hand === primary) || u.frame.extrapolated.includes(primary);
    if (!seen) return;
    const grabbing =
      u.frame.hands.some((h) => h.hand === primary && h.pinching) ||
      u.frame.extrapolated.includes(primary);
    if (f.grab && grabbing) out.frames.tp++;
    else if (!f.grab && grabbing) out.frames.fp++;
    else if (f.grab) out.frames.fn++;
    else out.frames.tn++;
  });
  out.nonGrabMinutes = nonGrabMs / 60000;
  const t0 = rec.frames[0]?.t ?? 0;
  for (const span of rec.meta.negativeSpans ?? []) {
    const a = t0 + span.from * 1000;
    const b = t0 + span.to * 1000;
    for (const [s, e] of grabs)
      if (e > a && s < b) {
        out.negativeSpanGrabs++;
        out.negativeSpanMs += Math.min(e, b) - Math.max(s, a);
      }
  }
  return out;
}
