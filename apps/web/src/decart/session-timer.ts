// Pure timing/budget helpers for the Decart V-TON trial page (apps/web/decart.html).
// The server (scripts/decart-budget.mjs) holds the authoritative daily cap; these mirror its
// constants so the page can count down and show an estimate.

/** Hard per-session limit, seconds (same as SESSION_LIMIT_S in scripts/decart-budget.mjs). */
export const SESSION_LIMIT_S = 75;
/** USD per streamed second, lucy-vton 3.6/3.5 at 720p standard speed.
 *  Source: https://docs.platform.decart.ai/getting-started/pricing (read 2026-11-15). */
export const USD_PER_SECOND = 0.02;

export type Clock = () => number;

/** One session's wall clock. Starts before connect() so the count is never below Decart's. */
export class SessionClock {
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;

  constructor(
    readonly limitS: number = SESSION_LIMIT_S,
    private readonly now: Clock = () => performance.now(),
  ) {
    if (!(limitS > 0)) throw new Error('limitS must be > 0');
  }

  start(): void {
    if (this.startedAt !== null) throw new Error('SessionClock already started');
    this.startedAt = this.now();
  }

  get running(): boolean {
    return this.startedAt !== null && this.stoppedAt === null;
  }

  /** Seconds since start (frozen after stop); 0 before start. */
  elapsedS(): number {
    if (this.startedAt === null) return 0;
    const end = this.stoppedAt ?? this.now();
    return Math.max(0, (end - this.startedAt) / 1000);
  }

  remainingS(): number {
    return Math.max(0, this.limitS - this.elapsedS());
  }

  expired(): boolean {
    return this.startedAt !== null && this.elapsedS() >= this.limitS;
  }

  /** Stops once and returns the seconds to report; later calls return null (no double report). */
  stop(): number | null {
    if (this.startedAt === null || this.stoppedAt !== null) return null;
    this.stoppedAt = this.now();
    return this.elapsedS();
  }
}

/** 75 -> "1:15", 9.2 -> "0:10" (rounded up so the display never shows 0:00 while still live). */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function usdFor(seconds: number): number {
  return Math.round(Math.max(0, seconds) * USD_PER_SECOND * 100) / 100;
}
