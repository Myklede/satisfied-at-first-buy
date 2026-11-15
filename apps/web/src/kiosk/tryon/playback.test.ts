import { expect, it } from 'vitest';
import { PlaybackClock } from './playback';
it('pauses geometry and readout frame selection together, then resumes without jumping', () => {
  const c = new PlaybackClock();
  expect(c.resolve(3, 20)).toBe(3);
  c.setPaused(true);
  expect(c.resolve(8, 20)).toBe(3);
  c.setPaused(false);
  expect(c.resolve(9, 20)).toBe(3);
  expect(c.resolve(10, 20)).toBe(4);
});
it('scrubs to a real baked frame, including while paused and over wraparound', () => {
  const c = new PlaybackClock();
  c.resolve(2, 10);
  c.setPaused(true);
  c.seek(1);
  expect(c.resolve(4, 10)).toBe(9);
  expect(c.resolve(5, 10)).toBe(9);
  c.setPaused(false);
  expect(c.resolve(6, 10)).toBe(9);
  expect(c.resolve(7, 10)).toBe(0);
  c.reset();
  expect(c.resolve(2, 10)).toBe(2);
});
import type { LivePosedScene, MoveBaker } from '../../engine/live/contract';
import { controlledBaker } from './playback';
it('forwards the same paused/scrubbed frame to baked geometry and physics readouts', async () => {
  let geometry = -1,
    numbers = -1;
  const underlying: MoveBaker = {
    async bake() {
      return {
        fps: 30,
        frameCount: 20,
        applyFrame(i) {
          geometry = i;
        },
        readouts(i) {
          numbers = i;
          return { zones: [], exposureCm: null, sleeveRideUpCm: null };
        },
        dispose() {},
      };
    },
  };
  const clock = new PlaybackClock();
  const baked = await controlledBaker(underlying, clock).bake(
    [],
    { bodyId: 'fixture', fitId: 'fixture', productId: 'fixture', size: 'M' },
    () => {},
    new AbortController().signal,
  );
  const scene = {} as LivePosedScene;
  baked.applyFrame(5, scene);
  baked.readouts(5);
  expect([geometry, numbers]).toEqual([5, 5]);
  clock.setPaused(true);
  baked.applyFrame(9, scene);
  baked.readouts(9);
  expect([geometry, numbers]).toEqual([5, 5]);
  clock.seek(1);
  baked.applyFrame(10, scene);
  baked.readouts(10);
  expect([geometry, numbers]).toEqual([19, 19]);
});

it('keeps V3 recorded-window metadata and scrubs inside that window, excluding neutral padding', async () => {
  let selected = -1;
  const source: MoveBaker = {
    async bake() {
      return {
        fps: 30,
        frameCount: 20,
        recorded: { start: 10, end: 14 },
        applyFrame(i) {
          selected = i;
        },
        readouts() {
          return { zones: [], exposureCm: null, sleeveRideUpCm: null };
        },
        dispose() {},
      };
    },
  };
  const c = new PlaybackClock();
  const b = await controlledBaker(source, c).bake(
    [],
    { bodyId: 'fixture', fitId: 'fixture', productId: 'fixture', size: 'S' },
    () => {},
    new AbortController().signal,
  );
  expect((b as typeof b & { recorded: { start: number; end: number } }).recorded).toEqual({
    start: 10,
    end: 14,
  });
  b.applyFrame(12, {} as LivePosedScene);
  expect(selected).toBe(12);
  c.seek(1);
  b.applyFrame(13, {} as LivePosedScene);
  expect(selected).toBe(14);
  b.applyFrame(14, {} as LivePosedScene);
  expect(selected).toBe(10);
});
