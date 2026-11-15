// Grab-classifier tuning on recordings (pure; run by scripts/tune-grip.mjs, tested in vitest).
//
// Labelled recordings (lab "Space = grabbing") are the primary data; unlabelled recordings act as a
// regression set. Selection is leave-one-recording-out over a small, interpretable grid.
//
// Cost per recording (lower is better). Priorities from the product brief: no mid-drag split, no
// false grab (worse than a late grab), then latency.
//   labelled:   100·splits + w·falseGrabs + 50·otherHandGrabs + 20·missed, w = 50 on non-grab
//               poses (wave-point / relaxed-open) but 5 on grip poses: in grip-pose recordings the
//               user also gripped without Space (2026-11-12: 05-09-00 at 1.3–4.0 s and 24–26 s,
//               tip ratio 0.09–0.17 for 2 s+), so "false grabs" there are mostly label errors;
//               + false-grab TIME (fp frames outside the ±300 ms tolerance): 20/s on non-grab
//               poses, 1/s on grip poses. Counting only grabs rewarded merging two false grabs
//               into one longer one (seen when loosening the index rule on 05-12-03).
//               + mean excess grab latency over 100 ms / 100 ms + mean excess release over 150 ms / 100 ms
//   unlabelled: 100·unexplainedSplits + 50·otherHandGrabs(outside the final second)
//               + |starts − user's expected count|

import {
  LABEL_TOLERANCE_MS,
  NON_GRAB_POSES,
  evaluateLabelled,
  primaryHand,
  replayRecording,
  unexplainedSplits,
} from './handRecording';
import type { HandRecording, LabelledEvaluation, PoseTag } from './handRecording';
import { DEFAULT_PINCH_TUNING } from './pinch';
import type { PinchTuning } from './pinch';

/** Nominal camera rate used to convert false-positive frames to seconds in the cost. */
const FRAMES_PER_SECOND = 30;
/** Grab-latency target (ms after the label onset). */
export const TARGET_GRAB_LATENCY_MS = 100;
/** Release-latency target (ms after the label offset). */
export const TARGET_RELEASE_LATENCY_MS = 150;
/** Final part of an UNLABELLED recording ignored for other-hand grabs (reaching for the mouse). */
export const STOP_REACH_MS = 1000;

export interface NamedRecording {
  name: string;
  rec: HandRecording;
}

export interface RecordingScore {
  cost: number;
  labelled: boolean;
  starts: number;
  splits: number;
  otherHandGrabs: number;
  evaluation?: LabelledEvaluation;
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export function scoreRecording(rec: HandRecording, tuning: Partial<PinchTuning>): RecordingScore {
  if (rec.frames.some((f) => f.grab !== undefined)) {
    const ev = evaluateLabelled(rec, tuning);
    const nonGrab = ev.pose !== undefined && NON_GRAB_POSES.includes(ev.pose);
    // Only lateness beyond target + key-press tolerance costs; a tracker grab EARLIER than the key
    // press is not penalised here (it is a false grab only if it overlaps no label at all).
    const grabExcess = mean(
      ev.grabLatencyMs.map((l) => Math.max(0, l - TARGET_GRAB_LATENCY_MS - LABEL_TOLERANCE_MS)),
    );
    const relExcess = mean(
      ev.releaseLatencyMs.map((l) =>
        Math.max(0, l - TARGET_RELEASE_LATENCY_MS - LABEL_TOLERANCE_MS, -l - LABEL_TOLERANCE_MS),
      ),
    );
    return {
      cost:
        100 * ev.splits +
        (nonGrab ? 50 : 5) * ev.falseGrabs +
        // Reviewed negative spans are trustworthy negatives: same weight as non-grab poses.
        50 * ev.negativeSpanGrabs +
        20 * (ev.negativeSpanMs / 1000) +
        (nonGrab ? 20 : 1) * (ev.frames.fp / FRAMES_PER_SECOND) +
        50 * ev.otherHandGrabs +
        20 * ev.missed +
        grabExcess / 100 +
        relExcess / 100,
      labelled: true,
      starts: ev.episodes - ev.missed + ev.splits + ev.falseGrabs,
      splits: ev.splits,
      otherHandGrabs: ev.otherHandGrabs,
      evaluation: ev,
    };
  }
  const { events } = replayRecording(rec, tuning);
  const primary = primaryHand(rec).hand;
  const tEnd = rec.frames[rec.frames.length - 1]?.t ?? 0;
  const mine = events.filter((e) => e.hand === primary);
  const starts = mine.filter((e) => e.type === 'start').length;
  const splits = unexplainedSplits(rec, mine, {
    ...DEFAULT_PINCH_TUNING.grabModel,
    ...tuning.grabModel,
  }).length;
  const otherHandGrabs = events.filter(
    (e) => e.type === 'start' && e.hand !== primary && tEnd - e.frameTime > STOP_REACH_MS,
  ).length;
  const expected = rec.meta.expectedPinches;
  return {
    cost:
      100 * splits +
      50 * otherHandGrabs +
      (expected === undefined ? 0 : Math.abs(starts - expected)),
    labelled: false,
    starts,
    splits,
    otherHandGrabs,
  };
}

/**
 * Interpretable grid (240 cells) over the dwell layer: clear-fist index / MRP limits × clear contact
 * gap × dwell time × clear run. The classifier and timing parameters chosen by the previous
 * leave-one-out (release, enter frames, start gate, lateral / index / thumb-palm centres) stay at
 * their defaults.
 */
export function defaultGrid(): Array<Partial<PinchTuning>> {
  const grid: Array<Partial<PinchTuning>> = [];
  for (const dwellMs of [400, 800, 1200, 1400, 1600])
    for (const clearFistIndex of [0.5, 0.55, 0.6, 0.65])
      for (const clearFistMrp of [0.35, 0.4])
        for (const clearContactGap of [0.25, 0.3, 0.35])
          for (const clearMinFrames of [1, 2])
            grid.push({
              dwellMs,
              clearMinFrames,
              grabModel: {
                ...DEFAULT_PINCH_TUNING.grabModel,
                clearFistIndex,
                clearFistMrp,
                clearContactGap,
              },
            });
  return grid;
}

/**
 * Tie-break between equal-cost candidates: the stricter 'clear' class first (false grabs are worse
 * than late grabs), then the longer clear run, then the shorter dwell.
 */
export function preferred(a: Partial<PinchTuning>, b: Partial<PinchTuning>): boolean {
  const ga = { ...DEFAULT_PINCH_TUNING.grabModel, ...a.grabModel };
  const gb = { ...DEFAULT_PINCH_TUNING.grabModel, ...b.grabModel };
  const da = a.dwellMs ?? DEFAULT_PINCH_TUNING.dwellMs;
  const db = b.dwellMs ?? DEFAULT_PINCH_TUNING.dwellMs;
  // Stricter first (false grabs are worse than late grabs): stricter 'clear' limits, then the
  // longer clear run; among equals the SHORTER dwell (latency).
  for (const k of ['clearFistIndex', 'clearFistMrp', 'clearContactGap'] as const)
    if (ga[k] !== gb[k]) return ga[k] < gb[k];
  const ca = a.clearMinFrames ?? DEFAULT_PINCH_TUNING.clearMinFrames;
  const cb = b.clearMinFrames ?? DEFAULT_PINCH_TUNING.clearMinFrames;
  if (ca !== cb) return ca > cb;
  return da < db;
}

export interface TuningReport {
  grid: Array<Partial<PinchTuning>>;
  /** cost[recording][candidate] */
  cost: number[][];
  best: { index: number; total: number };
  leaveOneOut: Array<{
    heldOut: string;
    chosen: number;
    trainCost: number;
    heldOutScore: RecordingScore;
  }>;
}

function argBest(grid: Array<Partial<PinchTuning>>, totals: number[]): number {
  let best = 0;
  for (let i = 1; i < grid.length; i++)
    if (totals[i] < totals[best] || (totals[i] === totals[best] && preferred(grid[i], grid[best])))
      best = i;
  return best;
}

export function tune(
  recordings: readonly NamedRecording[],
  grid: Array<Partial<PinchTuning>> = defaultGrid(),
): TuningReport {
  if (!recordings.length) throw new Error('tune: no recordings.');
  const scores = recordings.map((r) => grid.map((t) => scoreRecording(r.rec, t)));
  const cost = scores.map((row) => row.map((s) => s.cost));
  const totals = grid.map((_, j) => cost.reduce((s, row) => s + row[j], 0));
  const bestIndex = argBest(grid, totals);
  const leaveOneOut = recordings.map((held, h) => {
    const train = grid.map((_, j) => cost.reduce((s, row, i) => (i === h ? s : s + row[j]), 0));
    const chosen = argBest(grid, train);
    return {
      heldOut: held.name,
      chosen,
      trainCost: train[chosen],
      heldOutScore: scores[h][chosen],
    };
  });
  return { grid, cost, best: { index: bestIndex, total: totals[bestIndex] }, leaveOneOut };
}

export interface PoseRow {
  recordings: number;
  episodes: number;
  missed: number;
  splits: number;
  falseGrabs: number;
  otherHandGrabs: number;
  falseGrabsPerMin: number;
  frames: { tp: number; fp: number; fn: number; tn: number };
  medianGrabLatencyMs: number;
  medianReleaseLatencyMs: number;
  /** Median grab latency of grabs that started on the fast (clear) vs dwell (ambiguous) path. */
  medianGrabLatencyClearMs: number;
  medianGrabLatencyAmbiguousMs: number;
  clearGrabs: number;
  ambiguousGrabs: number;
  /** Grabs inside reviewed negative spans (meta.negativeSpans). */
  negativeSpanGrabs: number;
  labelCoversSeveralGrabs: number;
}

const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

/** Per-pose confusion and episode outcomes over labelled recordings. */
export function poseTable(
  recordings: readonly NamedRecording[],
  tuning: Partial<PinchTuning>,
): Partial<Record<PoseTag | 'untagged', PoseRow>> {
  const acc: Partial<Record<PoseTag | 'untagged', { evs: LabelledEvaluation[] }>> = {};
  for (const { rec } of recordings) {
    if (!rec.frames.some((f) => f.grab !== undefined)) continue;
    const ev = evaluateLabelled(rec, tuning);
    const key = ev.pose ?? 'untagged';
    (acc[key] ??= { evs: [] }).evs.push(ev);
  }
  const out: Partial<Record<PoseTag | 'untagged', PoseRow>> = {};
  for (const [pose, { evs }] of Object.entries(acc) as Array<
    [PoseTag | 'untagged', { evs: LabelledEvaluation[] }]
  >) {
    const sum = (f: (e: LabelledEvaluation) => number) => evs.reduce((s, e) => s + f(e), 0);
    const minutes = sum((e) => e.nonGrabMinutes);
    out[pose] = {
      recordings: evs.length,
      episodes: sum((e) => e.episodes),
      missed: sum((e) => e.missed),
      splits: sum((e) => e.splits),
      falseGrabs: sum((e) => e.falseGrabs),
      otherHandGrabs: sum((e) => e.otherHandGrabs),
      falseGrabsPerMin: minutes > 0 ? sum((e) => e.falseGrabs) / minutes : 0,
      frames: {
        tp: sum((e) => e.frames.tp),
        fp: sum((e) => e.frames.fp),
        fn: sum((e) => e.frames.fn),
        tn: sum((e) => e.frames.tn),
      },
      medianGrabLatencyMs: median(evs.flatMap((e) => e.grabLatencyMs)),
      medianReleaseLatencyMs: median(evs.flatMap((e) => e.releaseLatencyMs)),
      medianGrabLatencyClearMs: median(evs.flatMap((e) => e.grabLatencyByConfidence.clear)),
      medianGrabLatencyAmbiguousMs: median(evs.flatMap((e) => e.grabLatencyByConfidence.ambiguous)),
      clearGrabs: sum((e) => e.grabLatencyByConfidence.clear.length),
      ambiguousGrabs: sum((e) => e.grabLatencyByConfidence.ambiguous.length),
      negativeSpanGrabs: sum((e) => e.negativeSpanGrabs),
      labelCoversSeveralGrabs: sum((e) => e.labelCoversSeveralGrabs),
    };
  }
  return out;
}
