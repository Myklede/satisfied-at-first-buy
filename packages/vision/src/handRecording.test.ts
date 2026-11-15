/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import {
  HAND_RECORDING_FORMAT,
  evaluateLabelled,
  eventProtocolViolations,
  frameToObservations,
  primaryHand,
  parseHandRecording,
  replayRecording,
  serializeHandRecording,
  unexplainedSplits,
} from './handRecording';
import type { HandRecording, RecordedHandFrame, Triple } from './handRecording';
import { PinchTracker } from './pinch';
import type { GrabEvent } from './pinch';
import { synthHandNormalized } from './syntheticHand';
import type { ThumbSpec } from './syntheticHand';
import type { PinchEvent } from './types';

const W = 1280;
const H = 720;
const ASPECT = W / H;
const FRAME_MS = 1000 / 30;

/** Articulated synthetic hand as raw recorded triples (normalised image coords). */
function hand(u: number, ratio: number, scale = 0.15, v = 0.5, curl = 0.45): Triple[] {
  const thumb: ThumbSpec = { kind: 'tip', gap: ratio };
  return synthHandNormalized({ u, v, scale, curl, thumb }, ASPECT).map(
    (l): Triple => [l.x, l.y, l.z],
  );
}

function recording(frames: RecordedHandFrame[], meta: HandRecording['meta'] = {}): HandRecording {
  return {
    format: HAND_RECORDING_FORMAT,
    version: 1,
    createdAt: '2026-11-12T00:00:00Z',
    swapHandedness: false,
    source: { camera: 'synthetic', width: W, height: H, fps: 30, delegate: 'none' },
    meta,
    frames,
  };
}

/** Close still, then a fast drag with a mid-drag label flip and a 150 ms dropout. */
function syntheticDrag(): RecordedHandFrame[] {
  return Array.from({ length: 45 }, (_, i) => {
    // Still for the first 9 frames (people aim, then close: the start gate needs a slow palm).
    const u = 0.3 + (1.5 * Math.max(0, i - 9) * FRAME_MS) / 1000;
    const ratio = i < 3 || i > 38 ? 0.9 : 0.1;
    const dropped = i >= 20 && i <= 23;
    const label = i > 12 && i < 30 ? 'Left' : 'Right';
    return {
      t: 1000 + i * FRAME_MS,
      width: W,
      height: H,
      hands: dropped ? [] : [{ label, score: 0.93, landmarks: hand(u, ratio) }],
    };
  });
}

describe('hand recordings', () => {
  it('round-trips through JSON and replays identically to a live tracker', () => {
    const rec = recording(syntheticDrag(), { expectedPinches: 1, expectedHand: 'right' });
    const parsed = parseHandRecording(JSON.parse(serializeHandRecording(rec)));
    const replay = replayRecording(parsed);
    const live = new PinchTracker();
    const direct: PinchEvent[] = [];
    for (const f of rec.frames)
      direct.push(...live.update(f.t, f.width / f.height, frameToObservations(f, false)).events);
    direct.push(...live.endAll(rec.frames[rec.frames.length - 1].t));
    expect(replay.events.map((e) => e.type)).toEqual(direct.map((e) => e.type));
    replay.events.forEach((e, i) => {
      expect(e.ndc.x).toBeCloseTo(direct[i].ndc.x, 4);
      expect(e.ndc.y).toBeCloseTo(direct[i].ndc.y, 4);
    });
  });

  it('the synthetic fast drag (label flip + 150 ms dropout) is one pinch by one hand', () => {
    const { events } = replayRecording(recording(syntheticDrag()));
    expect(eventProtocolViolations(events)).toEqual([]);
    expect(events.filter((e) => e.type === 'start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'end')).toHaveLength(1);
    expect(new Set(events.map((e) => e.hand))).toEqual(new Set(['right']));
  });

  it('applies the recorded handedness swap', () => {
    const f: RecordedHandFrame = {
      t: 0,
      width: W,
      height: H,
      hands: [{ label: 'Left', score: 0.9, landmarks: hand(0.5, 0.8) }],
    };
    expect(frameToObservations(f, false)[0].hand).toBe('left');
    expect(frameToObservations(f, true)[0].hand).toBe('right');
  });

  it('reviewed negative spans: parsed, validated, and grabs inside them counted', () => {
    const frames = Array.from({ length: 120 }, (_, i) => ({
      t: i * FRAME_MS,
      width: W,
      height: H,
      grab: false,
      hands: [{ label: 'Right', score: 0.95, landmarks: hand(0.9, i >= 30 && i < 70 ? 0.1 : 0.9) }],
    }));
    const rec = parseHandRecording(
      JSON.parse(
        serializeHandRecording(
          recording(frames, { expectedHand: 'right', negativeSpans: [{ from: 1.0, to: 2.4 }] }),
        ),
      ),
    );
    expect(rec.meta.negativeSpans).toEqual([{ from: 1.0, to: 2.4 }]);
    const ev = evaluateLabelled(rec);
    expect(ev.negativeSpanGrabs).toBe(1);
    expect(ev.negativeSpanMs).toBeGreaterThan(500);
    const bad = JSON.parse(serializeHandRecording(recording(frames)));
    bad.meta.negativeSpans = [{ from: 2, to: 1 }];
    expect(() => parseHandRecording(bad)).toThrow(/negativeSpans/);
  });

  it('rejects malformed recordings', () => {
    expect(() => parseHandRecording({})).toThrow(/format/);
    const good = JSON.parse(serializeHandRecording(recording(syntheticDrag())));
    expect(() => parseHandRecording({ ...good, version: 2 })).toThrow(/version/);
    const badFrames = structuredClone(good);
    badFrames.frames[3].hands = [{ label: 'Right', score: 0.9, landmarks: [[0, 0, 0]] }];
    expect(() => parseHandRecording(badFrames)).toThrow(/21/);
    const backwards = structuredClone(good);
    backwards.frames[5].t = 0;
    expect(() => parseHandRecording(backwards)).toThrow(/non-decreasing/);
  });

  it('split judge: end→start with no release between is flagged; an open hand is not', () => {
    const ev = (type: PinchEvent['type'], t: number): PinchEvent => ({
      type,
      hand: 'right',
      ndc: { x: 0, y: 0 },
      depthDelta: 0,
      frameTime: t,
      confidence: 1,
    });
    const framesWith = (between: number[]): RecordedHandFrame[] =>
      [0.1, 0.1, 0.1, 0.1, ...between, 0.1, 0.1, 0.1].map((r, i) => ({
        t: i * FRAME_MS,
        width: W,
        height: H,
        hands: [{ label: 'Right', score: 0.9, landmarks: hand(0.8, r) }],
      }));
    // End at frame 4, start at the last frame: only the ratios between differ.
    const judge = (between: number[]) => {
      const rec = recording(framesWith(between));
      const n = rec.frames.length;
      return unexplainedSplits(rec, [
        ev('start', 0),
        ev('end', 4 * FRAME_MS),
        ev('start', (n - 1) * FRAME_MS),
        ev('end', n * FRAME_MS),
      ]);
    };
    expect(judge([0.3, 0.35, 0.3, 0.3])).toHaveLength(1); // stayed in the band: tracker split
    expect(judge([0.3, 0.9, 0.9, 0.3])).toHaveLength(0); // clearly open hand: real release
    expect(judge(new Array(12).fill(0.5))).toHaveLength(0); // ≥ 300 ms relaxed: real release
  });

  it('primary hand: meta.expectedHand, unless >90% of MediaPipe labels contradict it', () => {
    const frames = (label: string) =>
      Array.from({ length: 20 }, (_, i) => ({
        t: i * FRAME_MS,
        width: W,
        height: H,
        hands: [{ label, score: 0.9, landmarks: hand(0.9, 0.8) }],
      }));
    expect(primaryHand(recording(frames('Right'), { expectedHand: 'right' }))).toEqual({
      hand: 'right',
      overridden: false,
    });
    expect(primaryHand(recording(frames('Left'), { expectedHand: 'right' }))).toEqual({
      hand: 'left',
      overridden: true,
    });
  });

  describe('labelled evaluation', () => {
    /** Frames from a ratio schedule; label = schedule closed, delayed by a 200 ms key press. */
    function labelled(ratios: number[], labelOverride?: (i: number) => boolean) {
      const lag = Math.round(200 / FRAME_MS);
      return recording(
        ratios.map((r, i) => ({
          t: i * FRAME_MS,
          width: W,
          height: H,
          grab: labelOverride ? labelOverride(i) : (ratios[i - lag] ?? 0.9) < 0.25,
          hands: [{ label: 'Right', score: 0.95, landmarks: hand(0.9, r, 0.15, 0.5, 0.05) }],
        })),
        { expectedHand: 'right', pose: 'tip-pinch' },
      );
    }
    const block = (n: number, r: number) => new Array<number>(n).fill(r);

    it('one clean grab: no miss, no split, no false grab, plausible latencies', () => {
      const ev = evaluateLabelled(
        labelled([...block(30, 0.9), ...block(45, 0.1), ...block(40, 0.9)]),
      );
      expect(ev).toMatchObject({
        episodes: 1,
        missed: 0,
        splits: 0,
        falseGrabs: 0,
        pose: 'tip-pinch',
      });
      // Tracker grabs ~67 ms after the real grip; the key press lags it by 200 ms.
      expect(ev.grabLatencyMs[0]).toBeLessThan(0);
      expect(ev.releaseLatencyMs[0]).toBeLessThan(400);
      // Frames within ±LABEL_TOLERANCE_MS of a Space edge are not scored.
      expect(ev.frames.tp).toBeGreaterThan(20);
    });

    it('a clear open inside one label episode is "label covers several grabs", not a split', () => {
      const ratios = [
        ...block(30, 0.9),
        ...block(30, 0.1),
        ...block(10, 0.95),
        ...block(30, 0.1),
        ...block(30, 0.9),
      ];
      const ev = evaluateLabelled(labelled(ratios, (i) => i >= 32 && i < 100));
      expect(ev.episodes).toBe(1);
      expect(ev.splits).toBe(0);
      expect(ev.labelCoversSeveralGrabs).toBe(1);
    });

    it('counts an unexplained split: the hand vanishes longer than the grace inside a label', () => {
      const rec = labelled(
        [
          ...block(30, 0.9),
          ...block(30, 0.1),
          ...block(25, 0.1),
          ...block(30, 0.1),
          ...block(30, 0.9),
        ],
        (i) => i >= 32 && i < 115,
      );
      // Frames 60–84 (~830 ms) without a hand: longer than graceMs, no open frame in between.
      rec.frames.forEach((f, i) => {
        if (i >= 60 && i < 85) f.hands = [];
      });
      const ev = evaluateLabelled(rec);
      expect(ev.splits).toBe(1);
      expect(ev.labelCoversSeveralGrabs).toBe(0);
    });

    it('a non-grab pose tag with Space labels is treated as an unknown pose', () => {
      const rec = labelled([...block(30, 0.9), ...block(30, 0.1), ...block(30, 0.9)]);
      rec.meta.pose = 'wave-point';
      const ev = evaluateLabelled(rec);
      expect(ev.poseConflict).toBe(true);
      expect(ev.pose).toBeUndefined();
    });

    it('counts a false grab when the tracker grabs with no label', () => {
      const ratios = [...block(30, 0.9), ...block(30, 0.1), ...block(40, 0.9)];
      const ev = evaluateLabelled(labelled(ratios, () => false));
      expect(ev.falseGrabs).toBe(1);
      expect(ev.frames.fp).toBeGreaterThan(20);
    });

    it('refuses unlabelled recordings', () => {
      expect(() => evaluateLabelled(recording(syntheticDrag()))).toThrow(/no grab labels/);
    });
  });

  it('flags protocol violations in an event stream', () => {
    const e = (type: PinchEvent['type'], t: number): PinchEvent => ({
      type,
      hand: 'right',
      ndc: { x: 0, y: 0 },
      depthDelta: 0,
      frameTime: t,
      confidence: 1,
    });
    expect(eventProtocolViolations([e('start', 0), e('move', 1), e('end', 2)])).toEqual([]);
    expect(eventProtocolViolations([e('move', 0)])).toHaveLength(1);
    expect(eventProtocolViolations([e('start', 0), e('start', 1)])).toHaveLength(1);
  });
});

/** Final part of an unlabelled recording where the user reaches for the mouse to stop it. */
const STOP_REACH_MS = 1000;

// ---------- Real recordings (packages/vision/test-data/hands/*.json, gitignored) ----------
const realFiles = import.meta.glob('../test-data/hands/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;
const realEntries = Object.entries(realFiles);

describe('real hand recordings (test-data/hands)', () => {
  if (realEntries.length === 0) {
    it.skip('no recordings found: use "Record landmarks" in lab/hands.html', () => {});
    return;
  }
  for (const [file, json] of realEntries) {
    const rec = parseHandRecording(json);
    const name = file.split('/').pop();
    if (rec.meta.invalid) {
      it.skip(`${name}: marked invalid (${rec.meta.invalidReason ?? 'no reason given'})`, () => {});
      continue;
    }
    it(`replays ${name}`, () => {
      const { events, updates } = replayRecording(rec);
      const { hand: primary, overridden } = primaryHand(rec);
      const t0 = rec.frames[0]?.t ?? 0;
      const tEnd = rec.frames[rec.frames.length - 1]?.t ?? 0;
      const mine = events.filter((e) => e.hand === primary);
      const starts = mine.filter((e) => e.type === 'start');
      // Other-hand grabs, except in the last STOP_REACH_MS: in unlabelled recordings the user
      // reaches for the mouse to stop recording there (03-39-48). Labelled files are scored by
      // evaluateLabelled instead.
      const otherStarts = events.filter(
        (e) => e.type === 'start' && e.hand !== primary && tEnd - e.frameTime > STOP_REACH_MS,
      );
      const extrapolatedFrames = updates.filter((u) => u.frame.extrapolated.length > 0).length;
      const splits = unexplainedSplits(rec, mine);
      const at = (t: number) => ((t - t0) / 1000).toFixed(2) + 's';
      console.info(
        `[replay] ${name}: ${rec.frames.length} frames, ${starts.length} grab start(s) ` +
          `(user expected ${rec.meta.expectedPinches ?? '-'}) grips ` +
          starts.map((e) => (e as GrabEvent).grip).join(',') +
          `, ${splits.length} unexplained split(s), ${otherStarts.length} other-hand grab(s), ` +
          `${extrapolatedFrames} extrapolated frames, starts at ${starts.map((e) => at(e.frameTime)).join(' ')}` +
          (overridden
            ? ` [meta.expectedHand=${rec.meta.expectedHand} contradicts >90% of MediaPipe labels; scored as ${primary}]`
            : ''),
      );
      // Hard guarantees: valid event stream, no tracker-induced mid-drag split, no grab by
      // another hand, and the primary hand's label never changes mid-grab (events carry it).
      expect(eventProtocolViolations(events)).toEqual([]);
      expect(splits.map(at)).toEqual([]);
      expect(otherStarts.map((e) => `${e.hand}@${at(e.frameTime)}`)).toEqual([]);
      if (rec.frames.some((f) => f.grab !== undefined)) {
        const ev = evaluateLabelled(rec);
        console.info(`[labelled] ${name}: ${JSON.stringify(ev)}`);
        expect(ev.splits).toBe(0);
        // Windows the user confirmed as NOT grabbing must never grab.
        expect(ev.negativeSpanGrabs).toBe(0);
      }
      // The start count vs the user's intended count is REPORTED above, not asserted: the user's
      // count is intent ("drags"), the tracker counts physical releases.
    });
  }
});
