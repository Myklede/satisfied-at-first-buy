import { describe, expect, it, vi } from 'vitest';
import { isGarmentFinish, markShadersWarm } from './shaderWarm';

describe('shader readiness cue', () => {
  it('writes the dataset flags scripts wait on, and one operator line', () => {
    const root = { dataset: {} as Record<string, string | undefined> };
    const log = vi.fn();
    expect(markShadersWarm(root, 70290.4, log)).toBe(70290);
    expect(root.dataset).toEqual({ kioskWarm: '1', kioskWarmMs: '70290' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('70290 ms');
  });

  it('knows only the finishes the engine has shader variants for', () => {
    expect(isGarmentFinish('glossy_ripstop')).toBe(true);
    expect(isGarmentFinish('satin_matte')).toBe(true);
    expect(isGarmentFinish(undefined)).toBe(false);
    expect(isGarmentFinish('matte')).toBe(false);
  });
});
