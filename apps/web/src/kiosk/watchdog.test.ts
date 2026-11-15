import { afterEach, describe, expect, it, vi } from 'vitest';
import { advanceWatchdog, failureCause, INITIAL_WATCHDOG, type WatchdogState } from './watchdog';
import { serviceHealthy, serviceRestarts } from './kioskApi';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('kiosk service generation', () => {
  it('detects a restart entirely between two healthy polls, then confirms recovery', () => {
    const before = advanceWatchdog(INITIAL_WATCHDOG, { healthy: true, restarts: 0 }, true);
    const lost = advanceWatchdog(before.state, { healthy: true, restarts: 1 }, false);
    expect(lost.action).toBe('reconnecting');
    expect(advanceWatchdog(lost.state, { healthy: true, restarts: 1 }, false).action).toBe('reset');
    expect(before.state.lost).toBe(false);
  });

  it('keeps the two-failure debounce for a transient slow health request', () => {
    const first = advanceWatchdog(INITIAL_WATCHDOG, { healthy: false, restarts: null }, false);
    expect(first.action).toBe('ok');
    expect(advanceWatchdog(first.state, { healthy: true, restarts: null }, false).action).toBe(
      'ok',
    );
    const second = advanceWatchdog(first.state, { healthy: false, restarts: null }, false);
    expect(second.action).toBe('reconnecting');
    expect(advanceWatchdog(second.state, { healthy: true, restarts: null }, false).action).toBe(
      'reset',
    );
  });

  it('recovers when a failed body request already showed Reconnecting', () => {
    const failedRequest = { restarts: 0, failures: 0, lost: true };
    expect(advanceWatchdog(failedRequest, { healthy: true, restarts: 0 }, false).action).toBe(
      'reset',
    );
  });

  it('never forgets a body solely because health requests hit their deadline', () => {
    let state: WatchdogState = { restarts: 1, failures: 0, lost: false };
    for (let i = 0; i < 40; i++) {
      const next = advanceWatchdog(state, { healthy: null, restarts: 1 }, false);
      expect(next.action).toBe('ok');
      state = next.state;
    }
    const changed = advanceWatchdog(state, { healthy: null, restarts: 2 }, false);
    expect(changed.action).toBe('reconnecting');
    expect(advanceWatchdog(changed.state, { healthy: null, restarts: 2 }, false).action).toBe(
      'reconnecting',
    );
    expect(advanceWatchdog(changed.state, { healthy: true, restarts: 2 }, false).action).toBe(
      'reset',
    );
  });

  it('primes the generation during warmup without causing a reload loop', () => {
    const primed = advanceWatchdog(INITIAL_WATCHDOG, { healthy: false, restarts: 3 }, true);
    expect(primed.action).toBe('ok');
    expect(advanceWatchdog(primed.state, { healthy: true, restarts: 3 }, false).action).toBe('ok');
  });

  it('also notices a replaced launcher whose counter goes back to zero', () => {
    const previous = { restarts: 4, failures: 0, lost: false };
    expect(advanceWatchdog(previous, { healthy: true, restarts: 0 }, false).action).toBe(
      'reconnecting',
    );
    expect(advanceWatchdog(previous, { healthy: true, restarts: null }, false).action).toBe('ok');
  });
});

describe('failed request while dressing: service loss or real error', () => {
  const known = { restarts: 2, failures: 0, lost: false };

  it('sends a dead or restarted service to the reconnect path, never to a jacket error', () => {
    // Killed service: the kiosk proxy answers 503, so health is false.
    expect(failureCause(known, { healthy: false, restarts: 2 }, false)).toBe('service');
    // Restarted between polls: healthy again, but the new process forgot the judge's body.
    expect(failureCause(known, { healthy: true, restarts: 3 }, false)).toBe('service');
    // The request itself already said so (fetch failed / 502 / 503).
    expect(failureCause(known, { healthy: true, restarts: 2 }, true)).toBe('service');
    // The watchdog had already declared the generation lost.
    expect(failureCause({ ...known, lost: true }, { healthy: true, restarts: 2 }, false)).toBe(
      'service',
    );
  });

  it('keeps a real geometry error when the same service generation is healthy', () => {
    expect(failureCause(known, { healthy: true, restarts: 2 }, false)).toBe('request');
    // Outside the launcher (no counter) a healthy service still means a real error.
    expect(
      failureCause({ ...known, restarts: null }, { healthy: true, restarts: null }, false),
    ).toBe('request');
  });

  it('treats a health deadline as inconclusive', () => {
    expect(failureCause(known, { healthy: null, restarts: 2 }, false)).toBe('unknown');
    expect(failureCause(known, { healthy: null, restarts: null }, false)).toBe('unknown');
  });
});

describe('optional launcher generation endpoint', () => {
  it('distinguishes a health deadline from a confirmed service failure', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('deadline', 'TimeoutError')));
    expect(await serviceHealthy()).toBeNull();
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    expect(await serviceHealthy()).toBe(false);
  });

  it('accepts the validated restart counter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ service: 'restarting', restarts: 3 }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    expect(await serviceRestarts()).toBe(3);
  });

  it('treats dev HTML and invalid counters as unavailable, not as a restart', async () => {
    for (const data of [
      '<html>Vite</html>',
      { service: 'up', restarts: -1 },
      { service: 'up', restarts: 1.5 },
      { service: 'up', restarts: 1, unexpected: true },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(typeof data === 'string' ? data : JSON.stringify(data), {
            headers: {
              'Content-Type': typeof data === 'string' ? 'text/html' : 'application/json',
            },
          }),
        ),
      );
      expect(await serviceRestarts()).toBeNull();
    }
  });
});
