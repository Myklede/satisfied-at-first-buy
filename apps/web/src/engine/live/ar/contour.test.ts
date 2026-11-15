import { describe, expect, it } from 'vitest';
import { ContourHold, contourTargets, type ContourInput } from './contour';

// A 200×100 frame, mask 100×50: the person spans x 60..140 (px) on every row.
const W = 200,
  H = 100;
const mask = { width: 100, height: 50, data: new Float32Array(100 * 50) };
for (let y = 0; y < 50; y++) for (let x = 30; x < 70; x++) mask.data[y * 100 + x] = 1;

const grid = (x0: number, x1: number) => {
  const out: number[] = [];
  for (let y = 20; y <= 80; y += 2) for (let x = x0; x <= x1; x += 2) out.push(x, y);
  return out;
};

const base: ContourInput = {
  rows: [40, 60],
  band: 2,
  jacket: grid(66, 134), // the 3D jacket: 6 px of ease over the 3D body on each side
  body: grid(72, 128), // the 3D body is narrower than the person (60..140) by 12 px a side
  mask,
  width: W,
  height: H,
  minX: 0,
  maxX: W,
  arms: [],
  armRadius: 5,
};

describe('contourTargets', () => {
  it('registers the body silhouette to the person and keeps the 3D ease', () => {
    const t = contourTargets(base);
    expect(t).toHaveLength(4);
    const l = t.find((s) => s.side === 'L' && s.index === 0)!;
    const r = t.find((s) => s.side === 'R' && s.index === 0)!;
    expect(l.jacket[0]).toBe(66);
    expect(l.personX).toBeCloseTo(60, 0);
    expect(l.targetX).toBeCloseTo(54, 0); // person edge − 6 px of ease
    expect(r.personX).toBeCloseTo(139, 0);
    expect(r.targetX).toBeCloseTo(145, 0);
  });

  it('never walks past the clamp (an arm attached to the torso)', () => {
    const t = contourTargets({ ...base, minX: 64, maxX: 136 });
    const l = t.find((s) => s.side === 'L')!;
    expect(l.personX).toBeGreaterThanOrEqual(64);
  });

  it('skips a side whose person edge an arm runs along', () => {
    const arm: [number, number][] = [
      [58, 10],
      [58, 90],
    ];
    const t = contourTargets({ ...base, arms: [arm] });
    expect(t.every((s) => s.side === 'R')).toBe(true);
  });
});

describe('ContourHold', () => {
  it('holds within the deadband, follows beyond it, caps', () => {
    const h = new ContourHold(2, 10);
    expect(h.apply('L0', 5)).toBe(5);
    expect(h.apply('L0', 6.5)).toBe(5); // inside ±2
    expect(h.apply('L0', 9)).toBe(7); // follows, lagging by the deadband
    expect(h.apply('L0', 40)).toBe(8); // capped at 10, minus the deadband
    expect(h.apply('R0', -40)).toBe(-10);
  });
});
