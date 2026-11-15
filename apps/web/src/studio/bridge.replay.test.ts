// Replay tests for the Studio pinch bridge, no camera needed (agent ZB).
//  1. Scripted frames through ReplayPerception -> bridge -> DC's real bus.
//  2. REAL recorded hand landmarks (packages/vision/test-data/hands, gitignored body data, so
//     skipped when absent) through vision's PinchTracker (the live tracker's own logic) ->
//     handsFrameFromTracked -> bridge; the person's body is synthetic, placed so the first pinch
//     lands on the zip pull. Checks the bus zip against the recorded hand's own travel.
import { parseHandRecording, replayRecording } from '@satisfy/vision';
import { describe, expect, it } from 'vitest';
import { createBridge } from './bridge';
import { createStudioBus } from './bus';
import type { GarmentState } from './contract';
import { bodyFrameFromPose, fromBody, toBody } from './interact/bodyFrame';
import { ZIP_GRAB, ZIP_LINE } from './interact/config';
import { pullV } from './interact/gesture';
import { standingPose } from './interact/testPose';
import { handsFrameFromTracked, ReplayPerception, type HandsFrameOut } from './perception';

const ASPECT = 1280 / 720;
const camera = { width: 1280, height: 720 };

function rig(initial: Partial<GarmentState> = {}) {
  const bus = createStudioBus({
    jacket: 'FB7675-100',
    size: 'M',
    zip: 0,
    hoodOn: true,
    hemPull: 0,
    ...initial,
  });
  const perception = new ReplayPerception();
  const bridge = createBridge({ bus, perception, camera });
  const log: { zip: number; hoodOn: boolean; hemPull: number; source: string }[] = [];
  bus.subscribe((s, _p, source) =>
    log.push({ zip: s.zip, hoodOn: s.hoodOn, hemPull: s.hemPull, source }),
  );
  return { bus, perception, bridge, log };
}

describe('bridge replay (scripted frames)', () => {
  const pose = standingPose();
  const frame = bodyFrameFromPose(pose, ASPECT)!;
  const hands = (t: number, pinching: boolean, u: number, v: number): HandsFrameOut => ({
    timeMs: t,
    hands: [{ handedness: 'Right', points: [], pinching, pinchPoint: fromBody(frame, u, v) }],
  });

  it('pinch at the collar + pull down opens the zip on the bus, continuously, then snaps open', () => {
    const { perception, bridge, log, bus } = rig();
    const top = pullV('FB7675-100', 0);
    perception.pushPose({ timeMs: 0, image: pose });
    perception.pushHands(hands(10, false, 0.03, top));
    for (let i = 0; i <= 40; i++) {
      perception.pushPose({ timeMs: 33 * i, image: pose });
      perception.pushHands(hands(33 * i + 10, true, 0.03, top + (i / 40) * 1.4));
    }
    perception.pushHands(hands(2000, false, 0.03, top + 1.4));
    const zips = log.filter((l) => l.source === 'pinch').map((l) => l.zip);
    expect(zips.length).toBeGreaterThan(25);
    for (let i = 1; i < zips.length; i++) expect(zips[i]).toBeGreaterThanOrEqual(zips[i - 1]);
    expect(bus.get().zip).toBe(1);
    expect(bridge.stats().grabs).toEqual({ zip: 1 });
    expect(bridge.snapshot().grab).toBeNull();
    bridge.dispose();
  });

  it('slider and pinch share the bus: a pinch continues from the slider value', () => {
    const { perception, bus, log } = rig();
    bus.set({ zip: 0.5 }, 'slider');
    const at = pullV('FB7675-100', 0.5);
    perception.pushPose({ timeMs: 0, image: pose });
    perception.pushHands(hands(10, false, 0, at));
    perception.pushHands(hands(43, true, 0, at));
    // No jump at the grab: the first pinch patch is near 0.5.
    perception.pushHands(hands(76, true, 0, at + 0.05));
    const first = log.find((l) => l.source === 'pinch')!;
    expect(Math.abs(first.zip - 0.5)).toBeLessThan(0.05);
    // Pull back up to the collar: closes (and snaps closed on release).
    perception.pushHands(hands(110, true, 0, at - 1));
    perception.pushHands(hands(143, false, 0, at - 1));
    expect(bus.get().zip).toBe(0);
  });

  it('hood off by a pull behind the head, back on by a lift from the shoulder', () => {
    const { perception, bus } = rig();
    perception.pushPose({ timeMs: 0, image: pose });
    perception.pushHands(hands(10, false, 0.2, -0.75));
    perception.pushHands(hands(43, true, 0.2, -0.75));
    for (let i = 1; i <= 12; i++)
      perception.pushHands(hands(43 + 33 * i, true, 0.2 + i * 0.01, -0.75 + i * 0.05));
    expect(bus.get().hoodOn).toBe(false);
    perception.pushHands(hands(600, false, 0.3, -0.15));
    expect(bus.get().hoodOn).toBe(false);
    perception.pushHands(hands(700, false, 0.6, 0.2));
    perception.pushHands(hands(733, true, 0.6, 0.2));
    for (let i = 1; i <= 12; i++)
      perception.pushHands(hands(733 + 33 * i, true, 0.6, 0.2 - i * 0.05));
    perception.pushHands(hands(1200, false, 0.6, -0.4));
    expect(bus.get().hoodOn).toBe(true);
  });

  it('no body in view: pinches never change the bus', () => {
    const { perception, log } = rig();
    perception.pushHands(hands(10, false, 0, -0.2));
    perception.pushHands(hands(43, true, 0, -0.2));
    perception.pushHands(hands(76, true, 0, 0.8));
    expect(log).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- real recorded hands
const recordings = import.meta.glob<unknown>('../../../../packages/vision/test-data/hands/*.json', {
  import: 'default',
});
const files = Object.keys(recordings).sort();

describe.skipIf(!files.length)('bridge replay (real recorded hand landmarks)', () => {
  it('a recorded pinch on the zip pull drives the bus zip by the hand’s own travel', async () => {
    let checked = 0,
      worst = 0;
    const summary: string[] = [];
    const line = ZIP_LINE['FB7675-100'],
      span = line.vHem - line.vTop;
    for (const file of files) {
      const rec = parseHandRecording(await recordings[file]());
      if (rec.meta.invalid || !rec.meta.expectedPinches) continue;
      const { updates } = replayRecording(rec, { mirrored: false });
      const frames = updates.map((u) => handsFrameFromTracked(u.frame));
      const firstPinch = frames.findIndex((f) => f.hands.some((h) => h.pinching));
      if (firstPinch < 0) continue;
      const startHand = frames[firstPinch].hands.find((h) => h.pinching)!;
      const p = startHand.pinchPoint;
      // A body whose zip pull (closed) sits exactly at the first pinch: torso 0.4 image heights.
      const torso = 0.4,
        shoulderY = p.y - line.vTop * torso;
      const pose = standingPose({ cx: p.x, shoulderY, hipY: shoulderY + torso, span: 0.18 });
      const body = bodyFrameFromPose(pose, ASPECT)!;
      const { perception, bridge, bus } = rig();
      let v0 = NaN,
        maxErr = 0,
        compared = 0,
        maxExpected = 0;
      for (let i = 0; i < frames.length; i++) {
        perception.pushPose({ timeMs: frames[i].timeMs - 1, image: pose });
        perception.pushHands(frames[i]);
        if (i < firstPinch) continue;
        // Independent expectation for the FIRST grab, from the recorded pinch point itself.
        const h = frames[i].hands.find((x) => x.handedness === startHand.handedness);
        if (!h?.pinching) break;
        const v = toBody(body, h.pinchPoint).v;
        if (Number.isNaN(v0)) v0 = v;
        const expected = Math.max(0, Math.min(1, (v - v0) / span));
        maxExpected = Math.max(maxExpected, expected);
        maxErr = Math.max(maxErr, Math.abs(bus.get().zip - expected));
        compared++;
      }
      expect(bridge.stats().grabs.zip ?? 0).toBeGreaterThanOrEqual(1);
      expect(maxErr).toBeLessThanOrEqual(ZIP_GRAB.minStep + 1e-9);
      worst = Math.max(worst, maxErr);
      summary.push(
        `${file.split('/').pop()}: ${frames.length} frames, first grab ${compared} frames, hand travel up to zip ${maxExpected.toFixed(3)}, max |bus - hand| ${maxErr.toFixed(4)}, grabs ${JSON.stringify(bridge.stats().grabs)}`,
      );
      bridge.dispose();
      if (++checked >= 8) break;
    }
    console.log(
      `[ZB replay] ${checked} real recordings, worst error ${worst.toFixed(4)}\n  ${summary.join('\n  ')}`,
    );
    expect(checked).toBeGreaterThan(0);
  });
});

describe('bridge replay: hem pull (ZB round 3)', () => {
  it('pinch at the hem + pull down: bus hemPull rises, physics events carry the travel, release springs back', () => {
    const pose = standingPose();
    const frame = bodyFrameFromPose(pose, ASPECT)!;
    const { perception, bridge, bus } = rig();
    const events: { phase: string; kind: string; dv?: number }[] = [];
    bridge.onGesture((e) =>
      events.push({ phase: e.phase, kind: e.kind, dv: 'dv' in e ? e.dv : undefined }),
    );
    const vHem = ZIP_LINE['FB7675-100'].vHem;
    const push = (t: number, pinching: boolean, v: number) =>
      perception.pushHands({
        timeMs: t,
        hands: [{ handedness: 'Left', points: [], pinching, pinchPoint: fromBody(frame, 0.35, v) }],
      });
    perception.pushPose({ timeMs: 0, image: pose });
    push(10, false, vHem);
    const pulls: number[] = [];
    for (let i = 0; i <= 15; i++) {
      push(43 + 33 * i, true, vHem + i * 0.02);
      pulls.push(bus.get().hemPull);
    }
    for (let i = 1; i < pulls.length; i++) expect(pulls[i]).toBeGreaterThanOrEqual(pulls[i - 1]);
    expect(bus.get().hemPull).toBeCloseTo(1, 2);
    const moves = events.filter((e) => e.phase === 'move' && e.kind === 'hem');
    expect(moves.length).toBe(15); // the first pinching frame is the grab itself
    expect(moves.at(-1)!.dv).toBeCloseTo(0.3, 6);
    push(700, false, vHem + 0.3);
    expect(bus.get().hemPull).toBe(0);
    expect(events.at(-1)).toMatchObject({ phase: 'end', kind: 'hem' });
    bridge.dispose();
  });
});
