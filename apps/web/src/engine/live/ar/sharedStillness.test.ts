import { expect, it } from 'vitest';
import { ArCompositor } from './ArCompositor';
import type { ArSolution } from './ArTracker';
import type { Control } from './warp';
import { createLiveTryOn } from '../LiveTryOnEngine';
import type { LiveFrame } from '../contract';
import { SharedStillDetector, sharedStillState, type SharedStillState } from '../sharedStillness';

const frame = (t: number, x = 0): LiveFrame => ({
  t,
  width: 1280,
  height: 720,
  landmarks2d: Array.from({ length: 33 }, (_, i) => ({
    x: (i === 12 ? 500 : 700) + x,
    y: 300,
    visibility: 1,
  })),
  pose: {},
  world: null,
  mask: null,
  confidence: {},
});

it('AR consumes the exact engine decision and reports the same release, not a second detector', () => {
  const detector = new SharedStillDetector(),
    ar = new ArCompositor();
  const reader = ar as unknown as { stillFrame(input: LiveFrame): SharedStillState };
  for (let t = 0; t <= 600; t += 30) {
    const input = frame(t),
      state = detector.update(input);
    expect(reader.stillFrame(input)).toBe(state);
  }
  expect(ar.stillness.state.engaged).toBe(true);
  const moving = frame(630, 100),
    released = detector.update(moving);
  expect(reader.stillFrame(moving)).toBe(released);
  expect(ar.stillness.state).toMatchObject({ engaged: false, hold: 0 });
  expect(ar.stillness.noiseRmsPx()).toEqual(released.noiseRmsPx);
  ar.dispose();
});

it('engine publishes before its pose or AR consumer and disables holding for recorded physics', () => {
  const engine = createLiveTryOn({ stillnessLock: true });
  const source = engine as unknown as {
    onFrame(input: LiveFrame): void;
    state: { phase: string };
  };
  for (let t = 0; t <= 600; t += 30) source.onFrame(frame(t));
  const stationary = frame(630);
  source.onFrame(stationary);
  expect(sharedStillState(stationary)?.still).toBe(true);
  source.state.phase = 'playback';
  const playback = frame(660);
  source.onFrame(playback);
  expect(sharedStillState(playback)?.still).toBe(false);
});

it('holds focal, spread, rotation and BOTH glue endpoints exactly, then releases immediately', () => {
  const detector = new SharedStillDetector(),
    ar = new ArCompositor();
  const output = ar as unknown as {
    holdDrawn(frame: LiveFrame, solution: ArSolution): ArSolution;
    holdControls(frame: LiveFrame, layer: string, controls: Control[]): Control[];
  };
  for (let t = 0; t <= 600; t += 30) detector.update(frame(t));
  const first = frame(630);
  detector.update(first);
  const base = {
    pose: { yaw: 0.1, pitch: 0.2, roll: 0.3, t: [0, 0, 2], sx: 1 },
    intrinsics: { f: 1000, cx: 640, cy: 360 },
    pivot: [0, 1, 0],
  } as unknown as ArSolution;
  const controls: Control[] = [{ name: 'shoulder', p: [10, 20], q: [12, 25] }];
  const held = output.holdDrawn(first, base),
    warped = output.holdControls(first, 'torso', controls);
  base.pose.t[0] = 99;
  controls[0].q[0] = 99;
  const next = frame(660);
  detector.update(next);
  const changed = {
    ...base,
    pose: { ...base.pose, sx: 1.3, yaw: 0.8 },
    intrinsics: { ...base.intrinsics, f: 1200 },
  };
  expect(output.holdDrawn(next, changed).pose).toEqual(held.pose);
  expect(output.holdDrawn(next, changed).intrinsics.f).toBe(1000);
  expect(held.pose.t[0]).toBe(0);
  expect(output.holdControls(next, 'torso', [{ p: [30, 40], q: [50, 60] }])).toBe(warped);
  expect(warped[0]).toMatchObject({ p: [10, 20], q: [12, 25] });
  const moving = frame(690, 100);
  detector.update(moving);
  expect(output.holdDrawn(moving, changed)).toBe(changed);
  expect(output.holdControls(moving, 'torso', controls)).toBe(controls);
  ar.dispose();
});
