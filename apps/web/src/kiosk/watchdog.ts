/** The launcher's restart count survives an outage shorter than a health-poll interval. */
export interface WatchdogState {
  restarts: number | null;
  failures: number;
  lost: boolean;
}

export const INITIAL_WATCHDOG: WatchdogState = { restarts: null, failures: 0, lost: false };

export function advanceWatchdog(
  previous: Readonly<WatchdogState>,
  sample: { healthy: boolean | null; restarts: number | null },
  warming: boolean,
): { state: WatchdogState; action: 'ok' | 'reconnecting' | 'reset' } {
  const restarts = sample.restarts ?? previous.restarts;
  if (warming) return { state: { restarts, failures: 0, lost: false }, action: 'ok' };
  const changed =
    sample.restarts !== null && previous.restarts !== null && sample.restarts !== previous.restarts;
  const failures =
    sample.healthy === true
      ? 0
      : sample.healthy === false
        ? previous.failures + 1
        : previous.failures;
  const lost = previous.lost || changed || failures >= 2;
  const state = { restarts, failures, lost };
  // Status and health are separate requests: confirm health once more after a generation
  // change, rather than treating an in-flight response from the old process as recovery.
  if (changed) return { state, action: 'reconnecting' };
  return { state, action: lost ? (sample.healthy === true ? 'reset' : 'reconnecting') : 'ok' };
}

/**
 * Why a request of the judge's session failed. A lost service (dead, restarting, or a new
 * generation that no longer holds the judge's body) goes to the reconnect path; only a failure
 * while the same service generation is confirmed healthy is a real error of that request
 * (e.g. a geometry error) and is shown to the judge. A health deadline is inconclusive.
 */
export function failureCause(
  known: Readonly<WatchdogState>,
  sample: { healthy: boolean | null; restarts: number | null },
  serviceError: boolean,
): 'service' | 'request' | 'unknown' {
  if (serviceError || known.lost) return 'service';
  if (sample.restarts !== null && known.restarts !== null && sample.restarts !== known.restarts)
    return 'service';
  if (sample.healthy === false) return 'service';
  return sample.healthy === true ? 'request' : 'unknown';
}
