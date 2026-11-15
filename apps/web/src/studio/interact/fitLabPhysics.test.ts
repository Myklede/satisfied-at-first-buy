// FitLabPhysics against a stand-in controller (the real one needs WebGL + the cloth worker; its
// physics is covered by engine/interact/InteractDriver.test.ts). Checks the wiring: the bus is the
// truth, the solver follows it, the pinch frame time reaches the latency stats, the hood is held.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InteractController, InteractUiState } from '../../engine/interact/InteractController';
import { createStudioBus } from '../bus';
import { FitLabPhysics } from './fitLabPhysics';

function fakeController() {
  const calls: { op: string; args: unknown[] }[] = [];
  let hood: InteractUiState['hood'] = 'attached';
  const c = {
    hasHood: true,
    isDragging: false,
    onUi: undefined as ((s: InteractUiState) => void) | undefined,
    prepare: () => Promise.resolve({}),
    state: (): InteractUiState => ({
      ready: true,
      hasHood: true,
      zipOpen: 0,
      hood,
      hooked: false,
      open: calls.some((x) => x.op === 'setZipOpen'),
      hover: null,
      dragging: null,
      error: null,
      hoodView: false,
      hoodProgress: hood === 'detached' ? 1 : 0,
    }),
    setZipOpen: (...args: unknown[]) => calls.push({ op: 'setZipOpen', args }),
    holdHood: (...args: unknown[]) => (calls.push({ op: 'holdHood', args }), true),
    moveHood: (...args: unknown[]) => calls.push({ op: 'moveHood', args }),
    end: (...args: unknown[]) => calls.push({ op: 'end', args }),
    hoodHandOffset: () => [0, 0, 0],
    stats: () => undefined,
    dispose: () => calls.push({ op: 'dispose', args: [] }),
    setHood: (h: InteractUiState['hood']) => (hood = h),
  };
  return { c, calls };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('FitLabPhysics', () => {
  beforeEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.requestAnimationFrame = (cb: (t: number) => void) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number;
    g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  });
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
  });

  it('follows the bus zip continuously and passes the pinch frame time', async () => {
    const bus = createStudioBus({ jacket: 'DQ4920-206', size: 'M', zip: 0, hoodOn: true });
    const { c, calls } = fakeController();
    const physics = new FitLabPhysics({ interact: () => c as unknown as InteractController }, bus);
    expect(physics.status).toBe('idle');
    bus.set({ zip: 0.3 }, 'slider');
    await tick();
    expect(physics.status).toBe('ready');
    // On ready it starts from the bus.
    expect(calls.find((x) => x.op === 'setZipOpen')?.args[0]).toBe(0.3);
    physics.setInputTime(1234.5);
    bus.set({ zip: 0.42 }, 'pinch');
    const last = calls.filter((x) => x.op === 'setZipOpen').at(-1)!;
    expect(last.args).toEqual([0.42, 1234.5]);
    physics.dispose();
  });

  it('holds the hood live during a pinch and moves it past the detach distance', async () => {
    const bus = createStudioBus({ jacket: 'DQ4920-206', size: 'M', zip: 0, hoodOn: true });
    const { c, calls } = fakeController();
    const physics = new FitLabPhysics({ interact: () => c as unknown as InteractController }, bus);
    physics.onGesture({ phase: 'start', kind: 'hood-off', timeMs: 10 });
    await tick();
    physics.onGesture({ phase: 'start', kind: 'hood-off', timeMs: 20 });
    expect(calls.some((x) => x.op === 'holdHood')).toBe(true);
    physics.onGesture({
      phase: 'move',
      kind: 'hood-off',
      timeMs: 50,
      progress: 1,
      du: 0,
      dv: 0.45,
    });
    const d = calls.filter((x) => x.op === 'moveHood').at(-1)!.args[0] as number[];
    expect(Math.hypot(...d)).toBeGreaterThan(0.18);
    physics.onGesture({ phase: 'end', kind: 'hood-off', timeMs: 80, progress: 1, committed: true });
    expect(calls.at(-1)?.op).toBe('end');
    physics.dispose();
  });

  it('a hood button (bus) change animates the solver hood off', async () => {
    const bus = createStudioBus({ jacket: 'DQ4920-206', size: 'M', zip: 0, hoodOn: true });
    const { c, calls } = fakeController();
    const physics = new FitLabPhysics({ interact: () => c as unknown as InteractController }, bus);
    bus.set({ hoodOn: false }, 'ui');
    await tick(700);
    expect(physics.status).toBe('ready');
    const ops = calls.map((x) => x.op);
    expect(ops).toContain('holdHood');
    expect(ops.filter((o) => o === 'moveHood').length).toBeGreaterThan(5);
    expect(ops.at(-1)).toBe('end');
    physics.dispose();
  });

  it('reports unavailable (no crash) when the panel has no 3D view', async () => {
    const bus = createStudioBus({ jacket: 'DQ4920-206', size: 'M', zip: 0, hoodOn: true });
    const physics = new FitLabPhysics(
      { enterPhysics: () => Promise.reject(new Error('The Fit Lab 3D view is not ready')) },
      bus,
    );
    bus.set({ zip: 0.5 }, 'slider');
    await tick(10);
    expect(physics.status).toBe('unavailable');
    expect(physics.error).toMatch(/not ready/);
    physics.dispose();
  });
});
