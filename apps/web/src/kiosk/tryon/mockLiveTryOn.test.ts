import { expect, it, vi } from 'vitest';
import type { LiveSource } from '../../engine/live/contract';
import { createMockSession } from './mockLiveTryOn';
it('disposes mid-recording without creating new timers or retaining a camera', async () => {
  vi.useFakeTimers();
  try {
    const source: LiveSource = {
      kind: 'recording',
      video: null,
      start: async () => {},
      stop: vi.fn(),
      onFrame: () => () => {},
    };
    const { engine } = createMockSession();
    const start = engine.start(source, {
      bodyId: 'fixture',
      fitId: 'fixture',
      productId: 'fixture',
      size: 'M',
    });
    await vi.advanceTimersByTimeAsync(1400);
    await start;
    const recording = engine.recordMove(5);
    expect(vi.getTimerCount()).toBe(1);
    engine.dispose();
    await recording;
    expect(source.stop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
