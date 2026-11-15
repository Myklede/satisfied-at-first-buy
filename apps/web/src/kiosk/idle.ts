// Kiosk inactivity reset (agent M). The kiosk starts over after IDLE_RESET_MS without input, but
// two things are not a judge walking away:
//  1. A blocked main thread. A long synchronous task (measured: first use of the garment's
//     X-ray shader programs, 5-9 s each on a cold GPU shader cache, 21-76 s in a row right
//     after the result appears) delays the idle check AND the judge's input. When the thread
//     is free again, the overdue check ran before the queued click was delivered, so the
//     kiosk reset itself and the "Try moves" click landed on a page that was reloading.
//     Time the check itself was late is therefore not counted as inactivity.
//  2. Waiting for something the judge asked for: while a requested motion bake is running
//     in the open Try moves view (it shows its real progress), the session stays alive, up to
//     PREPARING_GRACE_MS in total so a hung bake cannot keep a session open forever.

/** Inactivity check period (ms). */
export const IDLE_TICK_MS = 1000;
/** A check later than this beyond its period means the main thread was blocked (ms). */
export const STALL_SLACK_MS = 1000;
/** Longest a requested motion bake keeps the session alive without input (ms). */
export const PREPARING_GRACE_MS = 300_000;

export type IdleClock = {
  /** performance.now() of the last input (moved forward by stalls and while preparing). */
  lastInput: number;
  /** When the previous check ran. */
  lastTick: number;
  /** Since when a requested bake has kept the session alive, or null. */
  preparingSince: number | null;
};

/**
 * One inactivity check. `visible`: the page is shown; a hidden page's timers are throttled by
 * the browser on purpose, so its late checks are not stalls and still count as inactivity.
 */
export function idleTick(
  clock: Readonly<IdleClock>,
  now: number,
  preparing: boolean,
  resetMs: number,
  visible = true,
): { clock: IdleClock; reset: boolean } {
  let lastInput = clock.lastInput;
  const stalled = now - clock.lastTick - IDLE_TICK_MS;
  if (visible && stalled > STALL_SLACK_MS) lastInput += stalled;
  const preparingSince = preparing ? (clock.preparingSince ?? now) : null;
  if (preparingSince !== null && now - preparingSince <= PREPARING_GRACE_MS) lastInput = now;
  lastInput = Math.min(lastInput, now);
  return {
    clock: { lastInput, lastTick: now, preparingSince },
    reset: now - lastInput > resetMs,
  };
}
