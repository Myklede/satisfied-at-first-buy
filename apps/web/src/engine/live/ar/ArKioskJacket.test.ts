import { expect, it, vi } from 'vitest';
import type { ClothAsset } from '../../../api';
import { ArKioskJacket, type KioskJacketSource } from './ArKioskJacket';

function fixture() {
  // Exercise the real update method without constructing a renderer or allocating GPU assets.
  const jacket = Object.create(ArKioskJacket.prototype) as ArKioskJacket;
  const asset = {} as ClothAsset;
  const positions = new Float32Array([1, 2, 3, 4, 5, 6]);
  const snapshot = { positions: new Float32Array(6) };
  const layer = { cloth: { onFrame: vi.fn() }, update: vi.fn() };
  Object.assign(jacket, { ready: true, asset, snapshot, layer, f4x: { warm: false, look: false } });
  const source = { version: 1, jacketAsset: asset, jacketPositions: () => positions };
  return { jacket, source, snapshot, layer, positions };
}

it('reuses unchanged certified geometry while continuing hood and zip animation', () => {
  const f = fixture();
  expect(f.jacket.update(f.source, 0.03)).toBe(true);
  expect(f.jacket.update(f.source, 0.04)).toBe(true);
  expect(f.layer.cloth.onFrame).toHaveBeenCalledTimes(1);
  expect(f.layer.update.mock.calls).toEqual([[0.03], [0.04]]);
  expect(f.snapshot.positions).toEqual(f.positions);
  f.positions[0] = 7;
  f.source.version++;
  f.jacket.update(f.source, 0.03);
  expect(f.layer.cloth.onFrame).toHaveBeenCalledTimes(2);
  expect(f.snapshot.positions[0]).toBe(7);
});

it('does not mistake another source or an unversioned source for unchanged geometry', () => {
  const f = fixture();
  f.jacket.update(f.source, 0.03);
  f.jacket.update({ ...f.source }, 0.03);
  const unversioned: KioskJacketSource = {
    jacketAsset: f.source.jacketAsset,
    jacketPositions: f.source.jacketPositions,
  };
  f.jacket.update(unversioned, 0.03);
  f.positions[0] = 8;
  f.jacket.update(unversioned, 0.03);
  expect(f.layer.cloth.onFrame).toHaveBeenCalledTimes(4);
  expect(f.snapshot.positions[0]).toBe(8);
});

// F4X (?f4xwarm=1): cold start of the kiosk look.
function coldFixture(warm: boolean) {
  const jacket = Object.create(ArKioskJacket.prototype) as ArKioskJacket;
  const order: string[] = [];
  const done = new Map<string, () => void>();
  const linked = new Set<string>();
  const programs = {
    compile: (key: string) => {
      order.push(key);
      return new Promise<void>((resolve) =>
        done.set(key, () => {
          linked.add(key);
          resolve();
        }),
      );
    },
    ready: (key: string) => linked.has(key),
  };
  const layer = { programStandIns: () => ({ look: [], xray: [] }) };
  Object.assign(jacket, { programs, layer, f4x: { warm, look: false }, timing: {} });
  const prewarm = (finish: string) =>
    (jacket as unknown as { prewarm(f: string, m: string): Promise<void> }).prewarm(
      finish,
      'normal',
    );
  return { jacket, order, done, prewarm };
}

it('submits every program at once by default (unchanged behaviour)', () => {
  const f = coldFixture(false);
  void f.prewarm('satin_matte');
  expect(f.order).toEqual(['look:satin_matte', 'casters:satin_matte', 'glue:satin_matte']);
});

it('f4xwarm: offscreen programs first and alone decide readiness; the canvas set follows', async () => {
  const f = coldFixture(true);
  let ready = false;
  void f.prewarm('satin_matte').then(() => (ready = true));
  expect(f.order).toEqual(['glue:satin_matte', 'casters:satin_matte']);
  f.done.get('glue:satin_matte')!();
  f.done.get('casters:satin_matte')!();
  await new Promise((r) => setTimeout(r, 0));
  expect(ready).toBe(true);
  expect(f.order).toEqual(['glue:satin_matte', 'casters:satin_matte', 'look:satin_matte']);
  // Shown, but a draw straight to the canvas waits for its own programs.
  const asset = { finish: 'satin_matte' } as unknown as ClothAsset;
  Object.assign(f.jacket, { ready: true, asset });
  expect(f.jacket.canvasReady).toBe(false);
  expect(f.jacket.pending(asset, false)).toBe(false);
  expect(f.jacket.pending(asset, true)).toBe(true);
  f.done.get('look:satin_matte')!();
  expect(f.jacket.canvasReady).toBe(true);
  expect(f.jacket.pending(asset, true)).toBe(false);
});

it('f4xwarm: pending while loading, never for a failed look or with the flag off', async () => {
  const asset = { finish: 'satin_matte', key: 'k' } as unknown as ClothAsset;
  const on = coldFixture(true);
  Object.assign(on.jacket, {
    layer: { preview: () => Promise.reject(new Error('no geometry')), programs: undefined },
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const loading = on.jacket.setAsset(asset);
  expect(on.jacket.pending(asset)).toBe(true);
  await loading;
  expect(error).toHaveBeenCalledOnce();
  error.mockRestore();
  expect(on.jacket.ready).toBe(false);
  expect(on.jacket.pending(asset)).toBe(false); // the caller's fallback draws
  await on.jacket.setAsset(asset); // not retried every frame
  const off = coldFixture(false);
  Object.assign(off.jacket, { loading: asset });
  expect(off.jacket.pending(asset)).toBe(false);
});

it('f4xset overrides only existing numeric constants of the look tables', async () => {
  const { applyF4xOverrides } = await import('./f4x');
  const tables = { E: { atRef: 0.9, range: [0.65, 1.3], name: 'x' }, G: { roughness: 0.74 } };
  const applied = applyF4xOverrides(
    '?f4xset1=E.atRef:1.05&f4xset2=G.roughness:0.8&f4xset3=E.range.1:1.4' +
      '&f4xset4=E.name:2&f4xset5=E.missing:1&f4xset6=X.atRef:1&f4xset7=E.atRef:abc' +
      '&f4xset8=E.__proto__.polluted:1&other=E.atRef:5',
    tables,
  );
  expect(applied).toEqual(['E.atRef=1.05', 'G.roughness=0.8', 'E.range.1=1.4']);
  expect(tables).toEqual({
    E: { atRef: 1.05, range: [0.65, 1.4], name: 'x' },
    G: { roughness: 0.8 },
  });
  expect(({} as { polluted?: number }).polluted).toBeUndefined();
});

it('f4xwarm: the idle prewarm compiles the other finish once, only after the shown one is ready', async () => {
  const f = coldFixture(true);
  const asset = { finish: 'satin_matte' } as unknown as ClothAsset;
  f.jacket.prewarmIdle(); // nothing shown yet
  expect(f.order).toEqual([]);
  void f.prewarm('satin_matte');
  f.done.get('glue:satin_matte')!();
  f.done.get('casters:satin_matte')!();
  await new Promise((r) => setTimeout(r, 0));
  Object.assign(f.jacket, { ready: true, asset });
  f.jacket.prewarmIdle(); // the canvas set of the shown finish is still compiling
  expect(f.order).toHaveLength(3);
  f.done.get('look:satin_matte')!();
  f.jacket.prewarmIdle();
  f.jacket.prewarmIdle();
  expect(f.order.slice(3)).toEqual([
    'glue:glossy_ripstop',
    'casters:glossy_ripstop',
    'glue:satin_matte',
    'casters:satin_matte',
  ]);
  const off = coldFixture(false);
  Object.assign(off.jacket, { ready: true, asset });
  off.jacket.prewarmIdle();
  expect(off.order).toEqual([]);
});
