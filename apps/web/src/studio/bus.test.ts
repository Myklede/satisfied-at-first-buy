import { describe, expect, it } from 'vitest';
import { createStudioBus, DEFAULT_GARMENT_STATE } from './bus';
import { SetThrottle, buildPrompt, chooseReference } from './decartViewMap';
import type { GarmentState, StateSource } from './contract';

describe('StudioBus', () => {
  it('notifies with next, prev and source; clamps; skips no-ops', () => {
    const bus = createStudioBus();
    const seen: [GarmentState, GarmentState, StateSource][] = [];
    const off = bus.subscribe((n, p, s) => seen.push([n, p, s]));
    bus.set({ zip: 1.7 }, 'slider');
    expect(bus.get().zip).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0][1].zip).toBe(0);
    expect(seen[0][2]).toBe('slider');
    bus.set({ zip: 1 }, 'pinch'); // no change
    expect(seen).toHaveLength(1);
    off();
    bus.set({ size: 'L' }, 'ui');
    expect(seen).toHaveLength(1);
    expect(bus.get().size).toBe('L');
  });

  it('rejects invalid values and keeps the state', () => {
    const bus = createStudioBus();
    expect(() => bus.set({ jacket: 'X' as never }, 'ui')).toThrow();
    expect(() => bus.set({ zip: Number.NaN }, 'ui')).toThrow();
    expect(bus.get()).toEqual(DEFAULT_GARMENT_STATE);
  });

  it('a throwing listener does not block the others', () => {
    const bus = createStudioBus();
    let called = false;
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(() => (called = true));
    const err = console.error;
    console.error = () => {};
    bus.set({ hoodOn: false }, 'ui');
    console.error = err;
    expect(called).toBe(true);
  });
});

describe('Decart state mapping', () => {
  const files = [
    'parka-closed.jpg',
    'parka-open.jpg',
    'parka-open-nohood.png',
    'puffer-closed.jpg',
  ];

  it('picks the exact reference when it exists', () => {
    expect(chooseReference(files, 'FB7675-100', 'open', false)).toEqual({
      file: 'parka-open-nohood.png',
      stage: 'open',
      hoodOn: false,
      exact: true,
    });
  });

  it('falls back to the other hood state, then the nearest zip stage', () => {
    expect(chooseReference(files, 'FB7675-100', 'closed', false)?.file).toBe('parka-closed.jpg');
    const half = chooseReference(files, 'FB7675-100', 'half', true);
    expect(half).toMatchObject({ file: 'parka-closed.jpg', stage: 'closed', exact: false });
    expect(chooseReference(files, 'DQ4920-206', 'open', true)?.file).toBe('puffer-closed.jpg');
    expect(chooseReference([], 'DQ4920-206', 'open', true)).toBeNull();
  });

  it('builds a prompt for the shown state; fit text only from a verdict', () => {
    const p = buildPrompt('FB7675-100', 'open', true, 'L', null);
    expect(p).toMatch(/fully unzipped/);
    expect(p).not.toMatch(/size L/);
    expect(buildPrompt('DQ4920-206', 'closed', false, 'S', 'tight')).toMatch(
      /size S, fitting snugly/,
    );
    expect(buildPrompt('DQ4920-206', 'closed', false, 'S', 'tight')).toMatch(
      /hood detached and removed; only the tall funnel collar/,
    );
    expect(buildPrompt('DQ4920-206', 'closed', true, 'S', null)).toMatch(/funnel collar.*chin/);
    expect(buildPrompt('FB7675-100', 'closed', true, 'S', null)).not.toMatch(/chin/);
  });
});

describe('SetThrottle', () => {
  it('fires at most once per gap and always ends on the latest key', () => {
    const t = new SetThrottle(400);
    expect(t.request('a', 0)).toBe(0);
    expect(t.take(0)).toBe('a');
    expect(t.request('a', 10)).toBeNull(); // already applied
    expect(t.request('b', 100)).toBe(300);
    expect(t.request('c', 200)).toBe(200); // replaces b
    expect(t.take(400)).toBe('c');
    expect(t.take(401)).toBeNull();
    expect(t.request('c', 900)).toBeNull();
    expect(t.request('d', 1000)).toBe(0);
  });

  it('a request back to the applied key withdraws the pending one', () => {
    const t = new SetThrottle(400);
    t.request('a', 0);
    t.take(0);
    t.request('b', 50);
    expect(t.request('a', 60)).toBeNull();
    expect(t.take(400)).toBeNull();
    t.reset();
    expect(t.request('a', 500)).toBe(0);
  });
});
