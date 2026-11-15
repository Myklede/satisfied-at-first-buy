import { describe, expect, it } from 'vitest';
import { appendTiming, measuredJson, timingEnabled, type LocalTiming } from './requestTiming';

describe('opt-in local request timing', () => {
  it('bounds samples without storing body identifiers or measurements', () => {
    const list: LocalTiming[] = [];
    for (let i = 0; i < 200; i++)
      appendTiming(list, { phase: 'request', category: 'cloth', atMs: i, values: { bytes: 100 } });
    expect(list).toHaveLength(128);
    expect(list[0].atMs).toBe(72);
    expect(timingEnabled()).toBe(false); // No browser/location in the test runner.
  });
  it('separately measures actual read, decode, parse and decoded bytes', async () => {
    const text = '{"value":"áo","array":[1,2,3]}';
    const result = await measuredJson(new Response(text));
    expect(result.data).toEqual({ value: 'áo', array: [1, 2, 3] });
    expect(result.bytes).toBe(new TextEncoder().encode(text).byteLength);
    expect(result.readMs).toBeGreaterThanOrEqual(0);
    expect(result.decodeMs).toBeGreaterThanOrEqual(0);
    expect(result.parseMs).toBeGreaterThanOrEqual(0);
  });
  it('keeps malformed JSON a visible error', async () => {
    await expect(measuredJson(new Response('{bad'))).rejects.toThrow();
  });
});
