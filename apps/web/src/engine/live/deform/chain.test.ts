import { describe, expect, it } from 'vitest';
import type { LiveDeformContext, LiveGarmentBinding, LiveJacketDeformer } from '../contract';
import { DeformerChain, createLiveDeformers } from './chain';
import { rootYawFromWorld, wrapDeg, YawFilter } from './heading';

const ctx: LiveDeformContext = { timeMs: 0, pose: null, drivers: [], bodyPositions: new Float32Array(0), joints: {} };
const binding: LiveGarmentBinding = {
  count: 2,
  bound: new Float32Array(6),
  triangles: [],
  skinDrivers: new Uint8Array(8),
  skinWeights: new Float32Array(8),
  asset: {},
  key: 'k',
};

class Stub implements LiveJacketDeformer {
  calls: string[] = [];
  constructor(
    readonly name: 'pose-correctives' | 'dynamics',
    private effect: (p: Float32Array) => void,
    private log: string[],
  ) {}
  bind() {
    this.log.push(`bind ${this.name}`);
  }
  apply(p: Float32Array) {
    this.log.push(`apply ${this.name}`);
    this.effect(p);
  }
  reset() {
    this.log.push(`reset ${this.name}`);
  }
  status() {
    return { active: true, note: 'stub', lastApplyMs: 0.1 };
  }
  dispose() {}
}

describe('DeformerChain', () => {
  it('runs pose-correctives before dynamics whatever the given order', () => {
    const log: string[] = [];
    const chain = new DeformerChain([
      new Stub('dynamics', (p) => (p[0] *= 2), log),
      new Stub('pose-correctives', (p) => (p[0] += 1), log),
    ]);
    chain.bind(binding);
    const p = new Float32Array([1, 0, 0, 0, 0, 0]);
    chain.apply(p, ctx);
    expect(log).toEqual(['bind pose-correctives', 'bind dynamics', 'apply pose-correctives', 'apply dynamics']);
    expect(p[0]).toBe(4); // (1 + 1) × 2
    expect(chain.names).toEqual(['pose-correctives', 'dynamics']);
  });

  it('rolls back a stage that throws or writes NaN, and turns it off with the reason', () => {
    const log: string[] = [];
    const chain = new DeformerChain([
      new Stub('pose-correctives', (p) => {
        p[1] = 5;
        throw new Error('boom');
      }, log),
      new Stub('dynamics', (p) => (p[2] = NaN), log),
    ]);
    chain.bind(binding);
    const p = new Float32Array([1, 2, 3, 4, 5, 6]);
    chain.apply(p, ctx);
    expect(Array.from(p)).toEqual([1, 2, 3, 4, 5, 6]);
    const status = chain.status();
    expect(status[0].active).toBe(false);
    expect(status[0].note).toMatch(/boom/);
    expect(status[1].note).toMatch(/non-finite/);
    // Off until the next binding.
    log.length = 0;
    chain.apply(p, ctx);
    expect(log).toEqual([]);
    chain.bind(binding);
    chain.apply(p, ctx);
    expect(log).toContain('apply dynamics');
  });

  it('does nothing without a jacket, and a stage switched off leaves positions alone', () => {
    const log: string[] = [];
    const chain = new DeformerChain([new Stub('dynamics', (p) => (p[0] = 9), log)]);
    const p = new Float32Array([1, 0, 0, 0, 0, 0]);
    chain.apply(p, ctx);
    expect(p[0]).toBe(1);
    chain.bind(binding);
    chain.setEnabled('dynamics', false);
    chain.apply(p, ctx);
    expect(p[0]).toBe(1);
    expect(chain.status()[0]).toMatchObject({ active: false, note: 'off' });
    chain.setEnabled('dynamics', true);
    chain.apply(p, ctx);
    expect(p[0]).toBe(9);
    chain.reset();
    expect(log).toContain('reset dynamics');
  });

  it('the live chain has the dynamics stage, honouring its switch', () => {
    const on = createLiveDeformers({ dynamics: true, poseCorrectives: false });
    expect(on.names).toContain('dynamics');
    on.bind(null);
    expect(on.status().find((s) => s.name === 'dynamics')?.note).toBe('no jacket');
    const off = createLiveDeformers({ dynamics: false, poseCorrectives: false });
    expect(off.status().find((s) => s.name === 'dynamics')?.active).toBe(false);
  });
});

describe('heading', () => {
  const world = (yawDeg: number, hipsSeen = true) => {
    const a = (yawDeg * Math.PI) / 180;
    const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.9 }));
    // Person's left (index 11/23) at +x when facing; a left turn moves it away (+z).
    for (const [l, r, w] of [
      [11, 12, 0.18],
      [23, 24, 0.12],
    ] as const) {
      lm[l] = { x: w * Math.cos(a), y: 0, z: w * Math.sin(a), visibility: hipsSeen || l === 11 ? 0.9 : 0.1 };
      lm[r] = { x: -w * Math.cos(a), y: 0, z: -w * Math.sin(a), visibility: hipsSeen || l === 11 ? 0.9 : 0.1 };
    }
    return lm;
  };

  it('reads the hip line (shoulders when the hips are not seen); side-on is unknown', () => {
    expect(rootYawFromWorld(world(30))).toBeCloseTo(30, 6);
    expect(rootYawFromWorld(world(-20, false))).toBeCloseTo(-20, 6);
    expect(rootYawFromWorld(world(85))).toBeNull();
    expect(rootYawFromWorld(null)).toBeNull();
  });

  it('wraps differences to (−180, 180]', () => {
    expect(wrapDeg(-179 - 179)).toBe(2);
    expect(wrapDeg(180)).toBe(180);
    expect(wrapDeg(-180)).toBe(180);
    expect(wrapDeg(370)).toBe(10);
  });

  it('the filter ignores noise inside its dead band and follows a real turn', () => {
    const f = new YawFilter();
    const out: number[] = [];
    for (let k = 0; k < 60; k++) out.push(f.update(k * 40, 10 + 2 * Math.sin(k * 1.7))!);
    const late = out.slice(20);
    expect(Math.max(...late) - Math.min(...late)).toBe(0);
    let y = 0;
    for (let k = 60; k < 100; k++) y = f.update(k * 40, 10 + (k - 60) * 2)!;
    expect(y).toBeGreaterThan(70);
  });

  it('the filter crosses ±180 without a spin', () => {
    const f = new YawFilter();
    let previous = f.update(0, 170)!;
    for (let k = 1; k < 30; k++) {
      const raw = wrapDeg(170 + k * 1.5);
      const y = f.update(k * 40, raw)!;
      expect(Math.abs(wrapDeg(y - previous))).toBeLessThan(10);
      previous = y;
    }
    expect(previous).toBeLessThan(0); // past 180, wrapped
  });
});

describe('heading plausibility', () => {
  it('a heading whose size the shoulder span contradicts is ambiguous (null)', async () => {
    const { plausibleHeading } = await import('./heading');
    // Facing the camera (span ratio 1): a 40 deg heading is implausible, 10 deg is fine.
    expect(plausibleHeading(40, 1)).toBeNull();
    expect(plausibleHeading(10, 1)).toBe(10);
    // A real 60 deg turn narrows the span to cos 60 = 0.5.
    expect(plausibleHeading(60, 0.5)).toBe(60);
    // A back view (180) has a full span again.
    expect(plausibleHeading(178, 0.99)).toBe(178);
    // Not measured: passed through.
    expect(plausibleHeading(30, null)).toBe(30);
  });
});
