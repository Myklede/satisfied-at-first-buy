import { describe, expect, it } from 'vitest';
import { StillnessLock, type StillnessParams } from './stillness';
import { STILLNESS } from './config';

const P: StillnessParams = STILLNESS;

function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussian = (rand: () => number) =>
  Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

// A person facing the camera: 33 landmarks around fixed positions (shoulder span 200 px).
const BASE: [number, number][] = Array.from({ length: 33 }, (_, i) => [
  300 + (i % 7) * 20,
  200 + i * 8,
]);
BASE[11] = [400, 300];
BASE[12] = [200, 300];
const frame = (
  rand: () => number,
  noise: number,
  shift: (i: number) => [number, number] = () => [0, 0],
) =>
  BASE.map(([x, y], i) => {
    const [dx, dy] = shift(i);
    return {
      x: x + dx + gaussian(rand) * noise,
      y: y + dy + gaussian(rand) * noise,
      visibility: 0.99,
    };
  });

describe('StillnessLock', () => {
  it('a still person with 2 px landmark noise: engages within ~300 ms and stays engaged', () => {
    const lock = new StillnessLock(P);
    const rand = random(3);
    let engagedAt: number | null = null;
    let releases = 0;
    let was = false;
    for (let i = 0; i < 150; i++) {
      const s = lock.update(i * 33.3, frame(rand, 2), 200);
      if (s.engaged && engagedAt === null) engagedAt = i * 33.3;
      if (was && !s.engaged) releases++;
      was = s.engaged;
    }
    expect(engagedAt).not.toBeNull();
    expect(engagedAt!).toBeLessThan(800);
    expect(releases).toBe(0);
  });

  it('releases on the first or second frame of a real move (raising a wrist 12 px/frame)', () => {
    const lock = new StillnessLock(P);
    const rand = random(8);
    for (let i = 0; i < 60; i++) lock.update(i * 33.3, frame(rand, 2), 200);
    expect(lock.state.engaged).toBe(true);
    let releasedAfter = -1;
    for (let k = 1; k <= 6; k++) {
      const s = lock.update(
        (60 + k) * 33.3,
        frame(rand, 2, (i) => (i === 15 ? [0, -12 * k] : [0, 0])),
        200,
      );
      if (!s.engaged && releasedAfter < 0) releasedAfter = k;
    }
    expect(releasedAfter).toBeGreaterThan(0);
    expect(releasedAfter).toBeLessThanOrEqual(2);
    // The ease to live completes within easeMs.
    const t = (60 + 6) * 33.3 + P.easeMs + 1;
    expect(
      lock.update(
        t,
        frame(rand, 2, (i) => (i === 15 ? [0, -80] : [0, 0])),
        200,
      ).hold,
    ).toBe(0);
  });

  it('natural sway (6 px/s) stays engaged; a slow deliberate move (120 px/s) releases', () => {
    const lock = new StillnessLock(P);
    const rand = random(12);
    for (let i = 0; i < 60; i++)
      lock.update(
        i * 33.3,
        frame(rand, 1, () => [0.2 * i, 0]),
        200,
      );
    expect(lock.state.engaged).toBe(true);
    let releasedAfter = -1;
    for (let k = 1; k <= 12; k++) {
      const s = lock.update(
        (60 + k) * 33.3,
        frame(rand, 1, (i) => (i === 15 ? [0, -4 * k] : [12, 0])),
        200,
      );
      if (!s.engaged && releasedAfter < 0) releasedAfter = k;
    }
    expect(releasedAfter).toBeGreaterThan(0);
    expect(releasedAfter).toBeLessThanOrEqual(6);
  });

  it('loses the person: releases and does not hold a stale state', () => {
    const lock = new StillnessLock(P);
    const rand = random(4);
    for (let i = 0; i < 40; i++) lock.update(i * 33.3, frame(rand, 2), 200);
    expect(lock.state.engaged).toBe(true);
    expect(lock.update(41 * 33.3, null, 200).engaged).toBe(false);
  });
});
