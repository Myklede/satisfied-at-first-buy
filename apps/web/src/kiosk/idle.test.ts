import { describe, expect, it } from 'vitest';
import { IDLE_TICK_MS, idleTick, PREPARING_GRACE_MS, type IdleClock } from './idle';

const RESET = 90_000;
/** Runs regular checks from `from` to `to` (one per IDLE_TICK_MS); returns the last result. */
function run(clock: IdleClock, from: number, to: number, preparing = false) {
  let state = { clock, reset: false };
  for (let t = from; t <= to; t += IDLE_TICK_MS) {
    state = idleTick(state.clock, t, preparing, RESET);
    if (state.reset) return { ...state, at: t };
  }
  return { ...state, at: null as number | null };
}

describe('kiosk inactivity reset', () => {
  it('resets after 90 s without input when the page runs normally', () => {
    const out = run({ lastInput: 0, lastTick: 0, preparingSince: null }, 1000, 120_000);
    expect(out.at).toBe(91_000);
  });

  it('does not count a blocked main thread as inactivity (the M dead click)', () => {
    // Last input at 0, checks every second until 30 s, then the thread is blocked for 76 s.
    const before = run({ lastInput: 0, lastTick: 0, preparingSince: null }, 1000, 30_000);
    expect(before.reset).toBe(false);
    const late = idleTick(before.clock, 106_000, false, RESET);
    expect(late.reset).toBe(false); // 106 s after the input, but 75 s of it was the stall
    expect(late.clock.lastInput).toBe(75_000);
    // The stall is forgiven, not the judge's real idle time: the reset still comes, 90 s of
    // running time after the input.
    expect(run(late.clock, 107_000, 200_000).at).toBe(166_000);
  });

  it('a hidden page (throttled timers) still counts as inactive', () => {
    const late = idleTick(
      { lastInput: 0, lastTick: 30_000, preparingSince: null },
      106_000,
      false,
      RESET,
      false,
    );
    expect(late.reset).toBe(true);
  });

  it('ignores ordinary timer jitter', () => {
    const out = idleTick(
      { lastInput: 0, lastTick: 10_000, preparingSince: null },
      11_900,
      false,
      RESET,
    );
    expect(out.clock.lastInput).toBe(0);
  });

  it('keeps the session while a requested motion bake runs, then counts from its end', () => {
    const baking = run({ lastInput: 0, lastTick: 0, preparingSince: null }, 1000, 200_000, true);
    expect(baking.reset).toBe(false);
    expect(baking.clock.lastInput).toBe(200_000);
    const after = run(baking.clock, 201_000, 400_000, false);
    expect(after.at).toBe(291_000);
  });

  it('a bake that never ends keeps the session for PREPARING_GRACE_MS at most', () => {
    const out = run({ lastInput: 0, lastTick: 0, preparingSince: null }, 1000, 600_000, true);
    expect(out.at).toBe(1000 + PREPARING_GRACE_MS + RESET + IDLE_TICK_MS);
  });
});
