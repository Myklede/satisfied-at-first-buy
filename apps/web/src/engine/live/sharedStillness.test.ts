import { expect, it } from 'vitest';
import type { LiveFrame } from './contract';
import { SharedStillDetector, sharedStillState } from './sharedStillness';

const frame = (t: number, shift = 0): LiveFrame => ({
  t,
  width: 1280,
  height: 720,
  landmarks2d: Array.from({ length: 33 }, (_, i) => ({
    x: (i === 12 ? 500 : 700) + shift,
    y: 300,
    visibility: 1,
  })),
  pose: {},
  world: null,
  mask: null,
  confidence: {},
});
function settled() {
  const detector = new SharedStillDetector();
  for (let t = 0; t <= 600; t += 30) detector.update(frame(t));
  return detector;
}

it('publishes one immutable decision for all consumers with engagement hysteresis', () => {
  const detector = new SharedStillDetector();
  expect(detector.update(frame(0)).still).toBe(false);
  expect(detector.update(frame(240)).still).toBe(false);
  const input = frame(300),
    state = detector.update(input);
  expect(state.still).toBe(true);
  expect(state.sinceMs).toBe(300);
  expect(sharedStillState(input)).toBe(state);
  expect(Object.isFrozen(state)).toBe(true);
  expect(Number.isFinite(state.noisePx)).toBe(true);
  expect(detector.update(input)).toBe(state);
});

it('releases every consumer on the same moving frame, with no residual hold weight', () => {
  const detector = settled(),
    moving = frame(630, 100);
  const state = detector.update(moving);
  expect(state).toMatchObject({ still: false, engaged: false, hold: 0, releasedAtMs: 630 });
  expect(sharedStillState(moving)).toBe(state);
});

it('releases immediately on tracking loss or explicit disable', () => {
  for (const disable of [false, true]) {
    const detector = settled(),
      input = frame(630);
    if (!disable) input.pose = null;
    expect(detector.update(input, !disable)).toMatchObject({ still: false, hold: 0 });
  }
});

it('does not keep a future lock after a seek or reset', () => {
  const detector = settled();
  expect(detector.update(frame(10)).still).toBe(false);
  detector.reset();
  expect(detector.update(frame(900)).still).toBe(false);
  expect(sharedStillState(frame(901))).toBeNull();
});

it('loss at a repeated timestamp releases and requires engagement again on recovery', () => {
  const detector = settled();
  const lost = frame(600);
  lost.pose = null;
  expect(detector.update(lost).still).toBe(false);
  expect(detector.update(frame(630)).still).toBe(false);
  expect(detector.update(frame(900)).still).toBe(true);
});
